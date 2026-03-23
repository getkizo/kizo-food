-- Migration 004: Push notification subscriptions
-- Stores Web Push subscriptions per device (one row per tablet/browser)

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,     -- Browser-assigned push endpoint URL
  p256dh TEXT NOT NULL,              -- Browser public key (for payload encryption)
  auth TEXT NOT NULL,                -- Auth secret (for payload encryption)
  device_label TEXT,                 -- Optional: "Kitchen Tablet", "Front Desk"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_merchant
  ON push_subscriptions(merchant_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);
