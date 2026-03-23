-- Merchant Appliance Database Schema
-- SQLite 3 with WAL mode
-- Version: 2.0.0
--
-- ── SINGLE-MERCHANT APPLIANCE ─────────────────────────────────────────────────
-- This schema intentionally supports only ONE merchant per appliance.
-- Each restaurant gets its own Raspberry Pi + Bun process + SQLite file.
-- There is no need for per-request merchant isolation or subdomain dispatch.
--
-- WHY merchant_id EXISTS ON EVERY TABLE:
--   1. Integrity — ensures a foreign-key chain back to the owning merchant row.
--   2. External integrations — third-party platforms (delivery apps, analytics
--      aggregators) reference this merchant by its stable ID even though the
--      appliance itself is single-tenant.
--   3. Future portability — if a merchant ever migrates appliances, the IDs
--      remain stable for cross-reference.
--
-- WHAT merchant_id IS NOT FOR:
--   • It is NOT a tenant discriminator for multi-tenant DB queries.
--   • Queries do NOT need a WHERE merchant_id = ? filter for isolation — there
--     is only one merchant per DB, so the filter would always match the same row.
--   • Code reviews should NOT flag missing tenant filters as a security gap.
--
-- The merchants table will always contain exactly one row in production.
-- ──────────────────────────────────────────────────────────────────────────────

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- Merchants
-- ============================================================================

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,                  -- Format: m_abc123xyz
  business_name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,            -- URL-safe: joes-pizza
  description TEXT,
  cuisine_types TEXT,                   -- JSON array: ["italian", "pizza"]
  logo_url TEXT,
  phone_number TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'inactive')) DEFAULT 'active',
  receipt_email_from TEXT,                -- Gmail address for sending customer email receipts (App Password stored in api_keys)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_merchants_slug ON merchants(slug);
CREATE INDEX idx_merchants_status ON merchants(status);

-- ============================================================================
-- Users (merchant owners, managers, staff)
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                  -- Format: u_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,                   -- bcrypt hash (NULL for OAuth users)
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'manager', 'staff')) DEFAULT 'staff',
  is_active INTEGER NOT NULL DEFAULT 1, -- Boolean (0 or 1)
  oauth_provider TEXT,                  -- 'google', 'apple', 'facebook', or NULL
  oauth_provider_id TEXT,               -- Unique ID from OAuth provider
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_merchant ON users(merchant_id);
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_provider_id);

-- ============================================================================
-- Refresh Tokens (for JWT refresh flow)
-- ============================================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,                  -- Format: rt_abc123xyz
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,             -- SHA256 hash of refresh token
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,   -- Boolean (0 or 1)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- ============================================================================
-- Encryption Keys (one DEK per merchant)
-- ============================================================================

CREATE TABLE IF NOT EXISTS encryption_keys (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  encrypted_dek TEXT NOT NULL,          -- Base64(IV + ciphertext + authTag)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT
);

-- ============================================================================
-- API Keys (encrypted with merchant's DEK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                  -- Format: key_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK(key_type IN ('pos', 'payment', 'cloud', 'email')),
  provider TEXT NOT NULL,               -- 'square', 'stripe', 'toast', 'clover', etc.
  encrypted_value TEXT NOT NULL,        -- AES-256-GCM envelope: JSON { iv, tag, ciphertext } all base64-encoded; DEK stored in api_key_deks
  pos_merchant_id TEXT,                 -- POS provider's merchant ID (e.g., Clover: WJ3EYD26EN771)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(merchant_id, key_type, provider)
);

CREATE INDEX idx_api_keys_merchant ON api_keys(merchant_id);

-- ============================================================================
-- Terminals (PAX payment terminals at this location)
-- ============================================================================

CREATE TABLE IF NOT EXISTS terminals (
  id            TEXT PRIMARY KEY,    -- term_abc123xyz
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,       -- 'pax_a800' | 'pax_a920_pro' | 'pax_d135'
  nickname      TEXT NOT NULL,       -- e.g. "Counter 1"
  serial_number TEXT,                -- optional, from label on device
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_terminals_merchant ON terminals(merchant_id);

-- ============================================================================
-- Menu — mirrors Clover's category → item → modifierGroup → modifier hierarchy
-- ============================================================================

-- Categories (e.g., "Appetizers", "Entrees")
CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,                  -- Clover category ID (passthrough) or local cat_abc123
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  pos_category_id TEXT,                 -- POS provider's category ID
  available_online INTEGER NOT NULL DEFAULT 1,   -- 0 = hidden from online store
  available_in_store INTEGER NOT NULL DEFAULT 1, -- 0 = hidden from in-store Order Entry
  hours_start TEXT,                     -- 'HH:MM' availability window start (null = always)
  hours_end TEXT,                       -- 'HH:MM' availability window end (null = always)
  available_days TEXT,                  -- JSON int array: [0,1,2,3,4,5,6] (0=Sun); null = all days
  blackout_dates TEXT,                  -- JSON string array: ["12-25","01-01"] (MM-DD)
  course_order INTEGER DEFAULT NULL,    -- 1,2,3… numbered course (NULL = main/un-numbered)
  is_last_course INTEGER NOT NULL DEFAULT 0, -- 1 = "Last" position (e.g. Desserts)
  print_destination TEXT NOT NULL DEFAULT 'both', -- 'both'|'kitchen'|'counter'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_menu_categories_merchant ON menu_categories(merchant_id);

-- Menu items / dishes
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,                  -- Clover item ID or local item_abc123
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES menu_categories(id) ON DELETE SET NULL,
  pos_item_id TEXT,                     -- POS provider's item ID
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0, -- Always in cents; 0 = market price / variable
  price_type TEXT NOT NULL DEFAULT 'FIXED' CHECK(price_type IN ('FIXED', 'VARIABLE', 'PER_UNIT')),
  image_url TEXT,                       -- Local or CDN URL (added by merchant)
  is_available INTEGER NOT NULL DEFAULT 1,
  available_online INTEGER NOT NULL DEFAULT 1, -- 0 = hidden from online store
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_menu_items_merchant ON menu_items(merchant_id);
CREATE INDEX idx_menu_items_category ON menu_items(category_id);
CREATE INDEX idx_menu_items_available ON menu_items(is_available);
-- Covering index for the online store menu query: filters by merchant + availability
-- and covers the ORDER BY sort_order, eliminating a filesort for the hot path.
CREATE INDEX IF NOT EXISTS idx_menu_items_store_filter
  ON menu_items (merchant_id, is_available, available_online, sort_order)
  WHERE is_available = 1 AND available_online = 1;

-- Modifier groups (e.g., "Spice Level", "Add-ons")
CREATE TABLE IF NOT EXISTS modifier_groups (
  id TEXT PRIMARY KEY,                  -- Clover modifierGroup ID or local mg_abc123
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  pos_group_id TEXT,                    -- POS provider's modifier group ID
  name TEXT NOT NULL,
  min_required INTEGER NOT NULL DEFAULT 0, -- 0 = optional
  max_allowed INTEGER,                  -- NULL = unlimited
  is_mandatory INTEGER NOT NULL DEFAULT 0, -- 1 = must select before adding item to order
  input_order INTEGER NOT NULL DEFAULT 0,  -- display order when filling out modifiers (lower = first)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_modifier_groups_merchant ON modifier_groups(merchant_id);

-- Join table: which modifier groups apply to which items
CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

-- Individual modifiers within a group (e.g., "Mild", "Medium", "Hot")
CREATE TABLE IF NOT EXISTS modifiers (
  id TEXT PRIMARY KEY,                  -- Clover modifier ID or local mod_abc123
  group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  pos_modifier_id TEXT,                 -- POS provider's modifier ID
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_modifiers_group ON modifiers(group_id);

-- ============================================================================
-- Orders (7-day hot window)
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,                  -- Format: ord_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,

  -- Order items (JSON array)
  items TEXT NOT NULL,                  -- JSON: [{ dishId, dishName, quantity, priceCents, lineTotalCents?, modifiers: [{name, priceCents}], courseOrder?, printDestination?, specialInstructions? }]

  -- Pricing (in cents)
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,

  -- SAM FSM state
  status TEXT NOT NULL CHECK(status IN (
    'received', 'submitted', 'confirmed', 'preparing',
    'ready', 'picked_up', 'completed', 'cancelled', 'pos_error', 'paid', 'refunded',
    'pending_payment'
  )) DEFAULT 'received',
  sam_state TEXT,                       -- Full dehydrated SAM model (JSON)

  -- POS integration
  pos_order_id TEXT,                    -- POS system's order ID
  pos_provider TEXT,                    -- 'square', 'toast', etc.

  -- Pickup/delivery
  order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
  pickup_code TEXT,                     -- 4-char code: A7K2
  pickup_time TEXT,                     -- ISO timestamp
  estimated_ready_at TEXT,              -- ISO timestamp: when merchant expects order to be ready

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_orders_merchant ON orders(merchant_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_pickup_code ON orders(pickup_code);
CREATE INDEX IF NOT EXISTS idx_orders_active_pickup
  ON orders (merchant_id, pickup_time)
  WHERE status IN ('submitted', 'received') AND pickup_time IS NOT NULL;

-- ============================================================================
-- File Integrity Snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS file_snapshots (
  filepath TEXT PRIMARY KEY,
  hash TEXT NOT NULL,                   -- SHA256 hash
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- Audit Logs (API key / crypto operations only)
--
-- M-15: This table is scoped to API-key and encryption events (key_accessed,
-- key_created, key_rotated, etc.). General-purpose security auditing (failed
-- logins, auth failures, rate-limit hits, payment errors) is handled by the
-- `security_events` table (see tableMigrations in migrate.ts, created by C-04).
-- Together the two tables provide full audit coverage:
--   audit_logs      → crypto / API key lifecycle events
--   security_events → auth, access control, webhook, and payment events
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,                  -- Format: audit_timestamp_random
  merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
  event TEXT NOT NULL,                  -- 'key_accessed', 'key_created', etc.
  key_type TEXT,                        -- 'pos' or 'payment'
  provider TEXT,                        -- 'square', 'stripe', etc.
  ip_address TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_merchant_time ON audit_logs(merchant_id, timestamp);
CREATE INDEX idx_audit_event ON audit_logs(event);

-- ============================================================================
-- Webhook Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  webhook_type TEXT NOT NULL,           -- 'clover', 'square', 'generic', etc.
  payload TEXT NOT NULL,                -- JSON payload
  processed INTEGER NOT NULL DEFAULT 0, -- 0=pending, 1=processed
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX idx_webhook_merchant ON webhook_events(merchant_id);
CREATE INDEX idx_webhook_processed ON webhook_events(processed);

-- ============================================================================
-- OAuth Accounts (for social login)
-- ============================================================================

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,                      -- Format: oauth_abc123xyz
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                   -- 'google', 'apple', 'facebook'
  provider_user_id TEXT NOT NULL,           -- Provider's unique user ID
  email TEXT,                               -- Email from provider
  profile_data TEXT,                        -- JSON: name, picture, etc.
  access_token TEXT,                        -- OAuth access token (encrypted)
  refresh_token TEXT,                       -- OAuth refresh token (encrypted)
  expires_at TEXT,                          -- Token expiration
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON oauth_accounts(provider, provider_user_id);

-- ============================================================================
-- Slug Reservations (for onboarding flow)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slug_reservations (
  slug TEXT PRIMARY KEY,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                  -- Expires after 15 minutes if not claimed
);

CREATE INDEX IF NOT EXISTS idx_slug_reservations_expires ON slug_reservations(expires_at);

-- ============================================================================
-- Push Notification Subscriptions (Web Push per device)
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,                       -- Format: ps_abc123
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,             -- Browser-assigned push endpoint URL
  p256dh TEXT NOT NULL,                      -- Browser public key (for payload encryption)
  auth TEXT NOT NULL,                        -- Auth secret (for payload encryption)
  device_label TEXT,                         -- Optional: "Kitchen Tablet", "Front Desk"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_merchant ON push_subscriptions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ============================================================================
-- WebAuthn Credentials (passkey / fingerprint login per device)
-- ============================================================================

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,                       -- Format: wc_abc123
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,        -- Base64URL-encoded credential ID from authenticator
  public_key TEXT NOT NULL,                  -- Base64URL-encoded COSE public key
  sign_count INTEGER NOT NULL DEFAULT 0,     -- Monotonic counter (replay attack prevention)
  transports TEXT,                           -- JSON array: ["internal","hybrid"] etc.
  device_label TEXT,                         -- Optional: "Kitchen iPad", "Front Desk"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,                       -- Format: wch_abc123
  challenge TEXT NOT NULL UNIQUE,            -- Base64URL-encoded challenge
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL for authentication (pre-login)
  type TEXT NOT NULL CHECK(type IN ('registration', 'authentication')),
  expires_at TEXT NOT NULL,                  -- Challenges expire in 5 minutes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenge ON webauthn_challenges(challenge);

-- ============================================================================
-- Business Hours (per merchant, per service type, per day-of-week)
-- Supports split hours: multiple slots per day via slot_index
-- service_type: 'regular' = main dining, 'catering' = catering sub-store
-- Shared scheduled_closures apply to all service types
-- ============================================================================

CREATE TABLE IF NOT EXISTS business_hours (
  id TEXT PRIMARY KEY,                   -- Format: bh_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL CHECK(service_type IN ('regular', 'catering')),
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6), -- 0=Sun, 6=Sat
  open_time TEXT NOT NULL,               -- HH:MM (24-hour)
  close_time TEXT NOT NULL,              -- HH:MM (24-hour)
  slot_index INTEGER NOT NULL DEFAULT 0, -- 0 = first slot, 1 = second slot (split hours)
  is_closed INTEGER NOT NULL DEFAULT 0,  -- reserved: explicit "closed" marker for future use
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_id, service_type, day_of_week, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_business_hours_merchant ON business_hours(merchant_id);
CREATE INDEX IF NOT EXISTS idx_business_hours_service ON business_hours(merchant_id, service_type);

-- ============================================================================
-- Scheduled Closures (holidays, vacations — shared by all service types)
-- A closure for Dec 24-26 closes both regular and catering
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_closures (
  id TEXT PRIMARY KEY,                   -- Format: sc_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,              -- YYYY-MM-DD
  end_date TEXT NOT NULL,               -- YYYY-MM-DD (equals start_date for single-day closures)
  label TEXT NOT NULL,                   -- "Christmas", "Annual Vacation"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_closures_merchant ON scheduled_closures(merchant_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_closures_dates ON scheduled_closures(merchant_id, start_date, end_date);

-- ============================================================================
-- System Metadata
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- Employees (PIN-based staff profiles for employee mode + timesheets)
-- ============================================================================

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,                  -- Format: emp_abc123xyz
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  access_code_hash TEXT NOT NULL,       -- SHA256(merchantId + "::" + 4-digit code)
  role TEXT NOT NULL CHECK(role IN ('server', 'chef', 'manager')),  -- L-08: DB-level constraint prevents invalid role strings
  schedule TEXT,                        -- JSON: {mon:{start,end},tue:null,...}
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_merchant ON employees(merchant_id);
CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(merchant_id, access_code_hash, active);

-- ============================================================================
-- Timesheets (clock-in / clock-out per employee per day)
-- ============================================================================

CREATE TABLE IF NOT EXISTS timesheets (
  id TEXT PRIMARY KEY,                  -- Format: ts_abc123xyz
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,
  clock_in TEXT NOT NULL,              -- ISO datetime (UTC)
  clock_out TEXT,                      -- ISO datetime (UTC), NULL = still clocked in
  date TEXT NOT NULL,                  -- YYYY-MM-DD (local date at clock-in)
  auto_clocked_out INTEGER NOT NULL DEFAULT 0, -- 1 = system applied scheduled end time (employee forgot to clock out)
  scheduled_end TEXT,                  -- HH:MM scheduled end that was applied (e.g. '21:30'), NULL for manual clock-outs
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_timesheets_employee ON timesheets(employee_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_date ON timesheets(merchant_id, date);

-- ============================================================================
-- Customer Push Subscriptions (online store — per order, pruned on completion)
-- ============================================================================

CREATE TABLE IF NOT EXISTS customer_push_subscriptions (
  id TEXT PRIMARY KEY,                  -- Format: cps_abc123
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_push_order ON customer_push_subscriptions(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_push_merchant ON customer_push_subscriptions(merchant_id);

-- ============================================================================
-- Refunds (record-only — staff processes money return in payment terminal)
-- type: 'full' = entire paid amount, 'partial' = selected items only
-- items_json: NULL for full refund; JSON array for partial (see route for shape)
-- ============================================================================

CREATE TABLE IF NOT EXISTS refunds (
  id                   TEXT PRIMARY KEY,             -- Format: ref_abc123xyz
  order_id             TEXT NOT NULL REFERENCES orders(id),
  merchant_id          TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK(type IN ('full', 'partial')),
  refund_amount_cents  INTEGER NOT NULL,
  tax_refunded_cents   INTEGER NOT NULL DEFAULT 0,
  items_json           TEXT,                         -- NULL for full; JSON for partial
  notes                TEXT,
  refunded_by_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  refunded_by_name     TEXT,                         -- denormalized (survives user deletion)
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refunds_order_id    ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_merchant_id ON refunds(merchant_id);

-- ============================================================================
-- Pending Course Fires (delayed course-2 kitchen prints)
-- Persists across server restarts; auto-fire service polls and executes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pending_course_fires (
  id               TEXT PRIMARY KEY DEFAULT ('pcf_' || lower(hex(randomblob(8)))),
  merchant_id      TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  course           INTEGER NOT NULL DEFAULT 2,
  fire_at          TEXT NOT NULL,       -- datetime('now', '+N minutes')
  fired_at         TEXT DEFAULT NULL,   -- set when executed
  printer_ip       TEXT NOT NULL,
  printer_protocol TEXT NOT NULL DEFAULT 'star-line',
  print_language   TEXT DEFAULT 'en',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pcf_pending ON pending_course_fires(fire_at) WHERE fired_at IS NULL;

-- ============================================================================
-- Payments (in-person payment records: tip, card info, signature, receipt)
-- Created by the Review & Pay modal after staff confirms payment.
-- One payment per order for Phase 1/2; split_* columns reserved for Phase 3.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,               -- Format: pay_abc123
  order_id              TEXT NOT NULL REFERENCES orders(id),
  merchant_id           TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  payment_type          TEXT NOT NULL CHECK(payment_type IN ('card', 'cash')),
  amount_cents          INTEGER NOT NULL,               -- final charged (subtotal+tax+tip+surcharge)
  subtotal_cents        INTEGER NOT NULL,
  tax_cents             INTEGER NOT NULL,
  tip_cents             INTEGER NOT NULL DEFAULT 0,
  amex_surcharge_cents  INTEGER NOT NULL DEFAULT 0,
  gratuity_percent      INTEGER,                        -- 18/20/22/25 or NULL for custom/none

  -- Card details (entered by staff after terminal confirms)
  card_type             TEXT,                           -- 'visa'|'mastercard'|'amex'|'discover'
  card_last_four        TEXT,
  cardholder_name       TEXT,
  transaction_id        TEXT,
  processor             TEXT,                           -- 'clover'|'square'|'cash'|etc.
  auth_code             TEXT,

  -- Signature
  signature_base64      TEXT,                           -- data:image/png;base64,...
  signature_captured_at TEXT,

  -- Split payment (Phase 3)
  split_mode            TEXT,                           -- 'equal'|'by_items'|'custom'|NULL
  split_leg_number      INTEGER,
  split_total_legs      INTEGER,
  split_items_json      TEXT,

  -- Receipt delivery
  receipt_printed       INTEGER NOT NULL DEFAULT 0,
  receipt_emailed       INTEGER NOT NULL DEFAULT 0,
  receipt_email         TEXT,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, created_at);
-- Composite index covers both the WHERE order_id = ? and ORDER BY created_at DESC
-- used by "SELECT id FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1".
CREATE INDEX IF NOT EXISTS idx_payments_order_created ON payments (order_id, created_at DESC);

-- ============================================================================
-- Feedback (customer ratings + per-dish thumbs)
-- type: 'app' = "Rate this app" (from order status page)
--       'order' = per-order dish-level feedback (from order history)
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT PRIMARY KEY DEFAULT ('fb_' || lower(hex(randomblob(8)))),
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  type          TEXT NOT NULL CHECK(type IN ('app', 'order')),
  stars         INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment       TEXT,
  dish_ratings  TEXT,  -- JSON: [{ name, thumbs: 'up'|'down' }]  (order type only)
  contact       TEXT,  -- optional email or phone
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_merchant ON feedback(merchant_id, created_at);

-- Store current schema version
INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('schema_version', '2.10.0');
INSERT OR REPLACE INTO system_metadata (key, value) VALUES ('initialized_at', datetime('now'));
