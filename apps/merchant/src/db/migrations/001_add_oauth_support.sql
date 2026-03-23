-- Migration: Add OAuth Support
-- Version: 2.0.1
-- Date: 2026-02-16

-- Add OAuth columns to users table
ALTER TABLE users ADD COLUMN oauth_provider TEXT; -- 'google', 'apple', 'facebook', or NULL
ALTER TABLE users ADD COLUMN oauth_provider_id TEXT; -- Unique ID from OAuth provider

-- Make password_hash nullable for OAuth users
-- Note: SQLite doesn't support modifying constraints, so we'll handle this in application logic
-- OAuth users will have NULL password_hash

-- Create index for OAuth lookups
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_provider_id);

-- Create OAuth accounts table for linking multiple providers to one user
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

-- Add slug check endpoint support table
CREATE TABLE IF NOT EXISTS slug_reservations (
  slug TEXT PRIMARY KEY,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                  -- Expires after 15 minutes if not claimed
);

CREATE INDEX IF NOT EXISTS idx_slug_reservations_expires ON slug_reservations(expires_at);

-- Update schema version
UPDATE system_metadata SET value = '2.0.1', updated_at = datetime('now') WHERE key = 'schema_version';
