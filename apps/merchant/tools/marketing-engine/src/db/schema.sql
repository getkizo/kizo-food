-- Marketing Engine — Redirector Database Schema
-- SQLite (bun:sqlite, WAL mode)
-- Source of truth for campaign definitions, scan log, and rate limiting.
-- Kizo's campaigns table is a synced mirror for order attribution.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Campaigns — canonical registry
-- channel is free-form TEXT (no CHECK constraint) so new distribution channels
-- can be added as data without schema changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,               -- 'VP-2606-KIR'
  slug_normalized  TEXT NOT NULL UNIQUE,               -- 'VP2606KIR' (uppercase, alphanumeric only)
  name             TEXT NOT NULL,                      -- 'Valpak June 2026 Kirkland'
  channel          TEXT NOT NULL,                      -- 'valpak' | 'yelp' | 'receipt' | 'tabletent' | ...
  source_label     TEXT NOT NULL,                      -- passed as ?src= to PWA
  mode             TEXT NOT NULL DEFAULT 'single',     -- 'single' (v1 only)
  coupon_code_required INTEGER NOT NULL DEFAULT 0,     -- 0 = slug-only URL
  status           TEXT NOT NULL DEFAULT 'draft'       -- 'draft' | 'active' | 'paused' | 'ended'
                     CHECK(status IN ('draft','active','paused','ended')),
  start_at         INTEGER NOT NULL,                   -- unix ms
  end_at           INTEGER NOT NULL,                   -- unix ms
  schedule_json    TEXT,                               -- optional daypart: { days:[0-6], windows:[{start:"HH:MM",end:"HH:MM"}] }
  campaign_type    TEXT NOT NULL DEFAULT 'coupon'      -- 'coupon' | 'bogo'
                     CHECK(campaign_type IN ('coupon','bogo')),
  target_json      TEXT,                               -- item-specific: { type:'item', item_name:'Pad Thai' }
  trigger_json     TEXT,                               -- bogo trigger: { type:'item_quantity'|'category_quantity', item_name?, category?, quantity }
  reward_json      TEXT,                               -- bogo reward: { type:'free_item'|'item_discount', item_name, discount_type?, discount_value?, max_quantity }
  discount_type    TEXT NOT NULL DEFAULT 'fixed_cents' -- 'percent' | 'fixed_cents'
                     CHECK(discount_type IN ('percent','fixed_cents')),
  discount_value   INTEGER NOT NULL,                   -- 15 (percent) | 500 (cents)
  min_order_cents  INTEGER NOT NULL DEFAULT 0,
  fulfillment_restriction TEXT                         -- NULL | 'dine_in' | 'takeout' | 'delivery'
                     CHECK(fulfillment_restriction IS NULL OR fulfillment_restriction IN ('dine_in','takeout','delivery')),
  max_uses_global  INTEGER,                            -- NULL = unlimited
  max_uses_per_customer INTEGER NOT NULL DEFAULT 1,
  expected_impressions INTEGER,                        -- Valpak drop size for CAC math
  drop_cost_cents  INTEGER,                            -- for CAC math
  redirect_target  TEXT NOT NULL,
  fallback_url     TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_window ON campaigns(start_at, end_at);

-- ---------------------------------------------------------------------------
-- Coupon codes — per-coupon unique codes for addressed/anti-sharing campaigns
-- Empty for slug-only campaigns (coupon_code_required=0).
-- v1: table exists + routing respects it; bulk-generation admin UI is v2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupon_codes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,                      -- uppercase, alphanumeric
  code_normalized  TEXT NOT NULL,
  recipient_tag    TEXT,
  status           TEXT NOT NULL DEFAULT 'unused'
                     CHECK(status IN ('unused','scanned','redeemed','void')),
  first_scan_at    INTEGER,
  redeemed_at      INTEGER,
  redeemed_order_id TEXT,                              -- cross-DB ref to Kizo orders.id (TEXT)
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (campaign_id, code_normalized)
);

CREATE INDEX IF NOT EXISTS idx_coupon_codes_lookup ON coupon_codes(campaign_id, code_normalized);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_status ON coupon_codes(campaign_id, status);

-- ---------------------------------------------------------------------------
-- Scans — every HTTP hit to /c/:slug, write-heavy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scans (
  id               TEXT PRIMARY KEY,                   -- ULID
  campaign_id      INTEGER REFERENCES campaigns(id),   -- NULL if slug unknown
  coupon_code_id   INTEGER REFERENCES coupon_codes(id),
  slug_requested   TEXT NOT NULL,
  code_requested   TEXT,
  ts               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  ip_hash          TEXT NOT NULL,                      -- SHA256(ip + daily_salt)
  user_agent       TEXT,
  referer          TEXT,
  country          TEXT,
  outcome          TEXT NOT NULL
                     CHECK(outcome IN ('redirected','fallback','invalid_slug','invalid_code','code_already_redeemed','rate_limited'))
);

CREATE INDEX IF NOT EXISTS idx_scans_campaign_ts ON scans(campaign_id, ts);
CREATE INDEX IF NOT EXISTS idx_scans_ts ON scans(ts);

-- ---------------------------------------------------------------------------
-- Rate limits — rolling per-IP counters; rebuilt from scans if lost
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash          TEXT NOT NULL,
  window_start     INTEGER NOT NULL,   -- unix ms, bucketed to minute
  count            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, window_start)
);

-- ---------------------------------------------------------------------------
-- Admin users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,                      -- argon2id via Bun.password
  role             TEXT NOT NULL DEFAULT 'operator'
                     CHECK(role IN ('admin','operator')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id               TEXT PRIMARY KEY,                   -- ULID used as cookie value
  user_id          INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON admin_sessions(user_id);

-- ---------------------------------------------------------------------------
-- Daily salt for IP hashing — rotated at midnight, purged after 30 days
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_salt (
  date             TEXT PRIMARY KEY,   -- 'YYYY-MM-DD'
  salt             TEXT NOT NULL
);
