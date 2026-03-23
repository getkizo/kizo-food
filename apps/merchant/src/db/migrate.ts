/**
 * Database migration script
 * 1. Runs schema.sql (CREATE TABLE IF NOT EXISTS — safe to re-run)
 * 2. Runs ALTER TABLE column migrations for existing databases
 *
 * Called automatically at server startup and available as a standalone script.
 */

import { getDatabase, isDatabaseInitialized, getSchemaVersion } from './connection'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Column migrations — ALTER TABLE statements for existing databases.
// Each entry is idempotent: it checks before altering.
// ---------------------------------------------------------------------------

const columnMigrations: Array<{
  description: string
  table: string
  column: string
  definition: string
}> = [
  {
    description: 'Add pos_merchant_id to api_keys (stores Clover/Square merchant ID)',
    table: 'api_keys',
    column: 'pos_merchant_id',
    definition: 'TEXT',
  },
  {
    description: 'Add website to merchants',
    table: 'merchants',
    column: 'website',
    definition: 'TEXT',
  },
  {
    description: 'Add address to merchants',
    table: 'merchants',
    column: 'address',
    definition: 'TEXT',
  },
  {
    description: 'Add source to orders (local | clover)',
    table: 'orders',
    column: 'source',
    definition: "TEXT NOT NULL DEFAULT 'local'",
  },
  {
    description: 'Add banner_url to merchants',
    table: 'merchants',
    column: 'banner_url',
    definition: 'TEXT',
  },
  {
    description: 'Add splash_url to merchants (custom phone splash screen image)',
    table: 'merchants',
    column: 'splash_url',
    definition: 'TEXT',
  },
  {
    description: 'Add welcome_message to merchants (one-time first-visit customer message)',
    table: 'merchants',
    column: 'welcome_message',
    definition: 'TEXT',
  },
  {
    description: 'Add finix_device_id to terminals (Finix-assigned device ID for POS sales)',
    table: 'terminals',
    column: 'finix_device_id',
    definition: 'TEXT',
  },
  {
    description: 'Add counter_ws_token to merchants (bearer token for Counter Android app WebSocket)',
    table: 'merchants',
    column: 'counter_ws_token',
    definition: 'TEXT',
  },
  {
    description: 'Add table_layout to merchants (JSON: rooms + tables)',
    table: 'merchants',
    column: 'table_layout',
    definition: 'TEXT',
  },
  {
    description: 'Add available_online to menu_items (visible to online customers)',
    table: 'menu_items',
    column: 'available_online',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: 'Add stock_status to menu_items (in_stock | out_today | out_indefinitely)',
    table: 'menu_items',
    column: 'stock_status',
    definition: "TEXT NOT NULL DEFAULT 'in_stock'",
  },
  {
    description: 'Add dietary_tags to menu_items (JSON array: vegan/vegetarian/gluten_free)',
    table: 'menu_items',
    column: 'dietary_tags',
    definition: "TEXT NOT NULL DEFAULT '[]'",
  },
  {
    description: 'Add stock_status to modifiers (in_stock | out_today | out_indefinitely)',
    table: 'modifiers',
    column: 'stock_status',
    definition: "TEXT NOT NULL DEFAULT 'in_stock'",
  },
  {
    description: 'Add available_online to menu_categories (hide whole category from online ordering)',
    table: 'menu_categories',
    column: 'available_online',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: 'Add available_in_store to menu_categories (hide whole category from in-store Order Entry)',
    table: 'menu_categories',
    column: 'available_in_store',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: 'Add hours_start to menu_categories (availability window start, HH:MM)',
    table: 'menu_categories',
    column: 'hours_start',
    definition: 'TEXT',
  },
  {
    description: 'Add hours_end to menu_categories (availability window end, HH:MM)',
    table: 'menu_categories',
    column: 'hours_end',
    definition: 'TEXT',
  },
  {
    description: 'Add available_days to menu_categories (JSON int array, e.g. [1,2,3,4,5])',
    table: 'menu_categories',
    column: 'available_days',
    definition: 'TEXT',
  },
  {
    description: 'Add blackout_dates to menu_categories (JSON MM-DD array, e.g. ["12-25","01-01"])',
    table: 'menu_categories',
    column: 'blackout_dates',
    definition: 'TEXT',
  },
  {
    description: 'Add available_for_takeout to modifier_groups (show modifier in takeout/delivery orders)',
    table: 'modifier_groups',
    column: 'available_for_takeout',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: 'Add notes to orders (per-order kitchen/staff note)',
    table: 'orders',
    column: 'notes',
    definition: 'TEXT',
  },
  {
    description: 'Add utensils_needed to orders (customer requests utensils)',
    table: 'orders',
    column: 'utensils_needed',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add tax_rate to merchants (percentage as decimal, e.g. 0.0875 = 8.75%)',
    table: 'merchants',
    column: 'tax_rate',
    definition: 'REAL NOT NULL DEFAULT 0',
  },
  {
    description: 'Add tip_options to merchants (JSON array of tip percentages, e.g. [15,20,25])',
    table: 'merchants',
    column: 'tip_options',
    definition: "TEXT NOT NULL DEFAULT '[15,20,25]'",
  },
  {
    description: 'Add stax_token to merchants (Stax/Fattmerchant web payments public token)',
    table: 'merchants',
    column: 'stax_token',
    definition: 'TEXT',
  },
  {
    description: 'Add table_label to orders (e.g. "Table 4" for dine-in orders)',
    table: 'orders',
    column: 'table_label',
    definition: 'TEXT',
  },
  {
    description: 'Add room_label to orders (e.g. "Patio" for dine-in orders)',
    table: 'orders',
    column: 'room_label',
    definition: 'TEXT',
  },
  {
    description: 'Add course_mode to orders (0=none, 1=coursed meal)',
    table: 'orders',
    column: 'course_mode',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add printer_ip to merchants (ESC/POS receipt printer IP address on LAN)',
    table: 'merchants',
    column: 'printer_ip',
    definition: 'TEXT',
  },
  {
    description: 'Add counter_printer_ip to merchants (counter/packing printer IP, defaults to kitchen IP)',
    table: 'merchants',
    column: 'counter_printer_ip',
    definition: 'TEXT',
  },
  {
    description: 'Add receipt_printer_ip to merchants (customer receipt printer IP, defaults to kitchen IP)',
    table: 'merchants',
    column: 'receipt_printer_ip',
    definition: 'TEXT',
  },
  {
    description: 'Add employee_id to orders (FK to employees, nullable — set when taken by a staff member)',
    table: 'orders',
    column: 'employee_id',
    definition: 'TEXT',
  },
  {
    description: 'Add employee_nickname to orders (denormalized for tip reporting after employee deletion)',
    table: 'orders',
    column: 'employee_nickname',
    definition: 'TEXT',
  },
  {
    description: 'Add show_employee_sales to merchants (1 = show sales/tips to employees on clock-out, 0 = hide)',
    table: 'merchants',
    column: 'show_employee_sales',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: 'Add is_popular to menu_items (1 = appears in Most Popular virtual category at top of menu)',
    table: 'menu_items',
    column: 'is_popular',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add converge_sandbox to merchants (1 = demo/test environment, 0 = production)',
    table: 'merchants',
    column: 'converge_sandbox',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: "Add payment_provider to merchants ('stax' | 'converge' | 'finix' | NULL — which provider powers the Pay button)",
    table: 'merchants',
    column: 'payment_provider',
    definition: 'TEXT',
  },
  {
    description: 'Add finix_sandbox to merchants (1 = sandbox/test environment, 0 = production)',
    table: 'merchants',
    column: 'finix_sandbox',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    description: "Add finix_refund_mode to merchants ('local' = accounting only, 'api' = call Finix reversal API)",
    table: 'merchants',
    column: 'finix_refund_mode',
    definition: "TEXT NOT NULL DEFAULT 'local'",
  },
  {
    description: "Add kitchen_printer_protocol to merchants ('star-line' | 'esc-pos')",
    table: 'merchants',
    column: 'kitchen_printer_protocol',
    definition: "TEXT NOT NULL DEFAULT 'star-line'",
  },
  {
    description: "Add counter_printer_protocol to merchants ('star-line' | 'esc-pos')",
    table: 'merchants',
    column: 'counter_printer_protocol',
    definition: "TEXT NOT NULL DEFAULT 'star-line'",
  },
  {
    description: "Add receipt_printer_protocol to merchants ('star-line' | 'esc-pos')",
    table: 'merchants',
    column: 'receipt_printer_protocol',
    definition: "TEXT NOT NULL DEFAULT 'star-line'",
  },
  // ── Reports: payment tracking on orders ──────────────────────────────────
  {
    description: 'Add tip_cents to orders (tip amount in cents)',
    table: 'orders',
    column: 'tip_cents',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add paid_amount_cents to orders (total charged including tip)',
    table: 'orders',
    column: 'paid_amount_cents',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: "Add payment_method to orders ('cash' | 'card' | NULL)",
    table: 'orders',
    column: 'payment_method',
    definition: 'TEXT',
  },
  // ── Reports: pay period config on merchants ──────────────────────────────
  {
    description: "Add pay_period_type to merchants ('biweekly' | 'semimonthly')",
    table: 'merchants',
    column: 'pay_period_type',
    definition: "TEXT NOT NULL DEFAULT 'biweekly'",
  },
  {
    description: 'Add pay_period_anchor to merchants (YYYY-MM-DD anchor for biweekly)',
    table: 'merchants',
    column: 'pay_period_anchor',
    definition: "TEXT NOT NULL DEFAULT '2026-01-02'",
  },
  {
    description: 'Add break_rule to merchants (JSON: {thresholdHours, deductMinutes})',
    table: 'merchants',
    column: 'break_rule',
    definition: 'TEXT',
  },
  // ── Auto clock-out: forgotten clock-out handling ─────────────────────────
  {
    description: 'Add auto_clocked_out to timesheets (1 = system applied scheduled end time because employee forgot to clock out)',
    table: 'timesheets',
    column: 'auto_clocked_out',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: "Add scheduled_end to timesheets (HH:MM end time from employee schedule that was applied on auto clock-out, NULL for manual)",
    table: 'timesheets',
    column: 'scheduled_end',
    definition: 'TEXT',
  },
  // ── Online order lifecycle: estimated ready time ────────────────────────
  {
    description: 'Add estimated_ready_at to orders (ISO timestamp for estimated pickup readiness)',
    table: 'orders',
    column: 'estimated_ready_at',
    definition: 'TEXT',
  },
  // ── Dashboard: new-order notification sound ──────────────────────────────
  {
    description: "Add notification_sound to merchants ('chime' | 'bell' | 'double-beep' | 'ding')",
    table: 'merchants',
    column: 'notification_sound',
    definition: "TEXT NOT NULL DEFAULT 'chime'",
  },
  // ── Scheduled orders: kitchen preparation time ───────────────────────────
  {
    description: 'Add prep_time_minutes to merchants (minutes kitchen needs before order is ready, default 20)',
    table: 'merchants',
    column: 'prep_time_minutes',
    definition: 'INTEGER NOT NULL DEFAULT 20',
  },
  // ── Refunds: permission control ──────────────────────────────────────────
  {
    description: "Add staff_can_refund to merchants (1 = staff can record refunds, 0 = manager/owner only)",
    table: 'merchants',
    column: 'staff_can_refund',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  // ── Mandatory modifier groups + input ordering ───────────────────────────
  {
    description: 'Add is_mandatory to modifier_groups (1 = must select before adding item to order)',
    table: 'modifier_groups',
    column: 'is_mandatory',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add input_order to modifier_groups (display order when filling out modifiers; lower = first)',
    table: 'modifier_groups',
    column: 'input_order',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  // ── Category course ordering and print destination ────────────────────────
  {
    description: 'Add course_order to menu_categories (1,2,3… numbered course; NULL = main/un-numbered)',
    table: 'menu_categories',
    column: 'course_order',
    definition: 'INTEGER DEFAULT NULL',
  },
  {
    description: 'Add is_last_course to menu_categories (1 = "Last" position, e.g. Desserts)',
    table: 'menu_categories',
    column: 'is_last_course',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: "Add print_destination to menu_categories ('both'|'kitchen'|'counter')",
    table: 'menu_categories',
    column: 'print_destination',
    definition: "TEXT NOT NULL DEFAULT 'both'",
  },
  // ── Finix: checkout form ID for refund lookup ─────────────────────────────
  {
    description: 'Add payment_checkout_form_id to orders (Finix checkout form ID saved at pay time, used to look up transfer for refund)',
    table: 'orders',
    column: 'payment_checkout_form_id',
    definition: 'TEXT',
  },
  // ── Payment verification: processor transfer/txn ID ───────────────────────
  {
    description: 'Add payment_transfer_id to orders (Finix transfer ID or Converge ssl_txn_id — verified server-to-server at payment time)',
    table: 'orders',
    column: 'payment_transfer_id',
    definition: 'TEXT',
  },
  // ── Refunds: processor refund ID for reconciliation ───────────────────────
  {
    description: 'Add processor_refund_id to refunds (Finix reversal transfer ID — populated when money was actually moved via API)',
    table: 'refunds',
    column: 'processor_refund_id',
    definition: 'TEXT',
  },
  // ── Receipt style: HTML vs. monospace ─────────────────────────────────────
  {
    description: "Add receipt_style to merchants ('classic' = receiptline monospace | 'html' = Puppeteer HTML render)",
    table: 'merchants',
    column: 'receipt_style',
    definition: "TEXT NOT NULL DEFAULT 'classic'",
  },
  // ── Merchant timezone ─────────────────────────────────────────────────────
  {
    description: "Add timezone to merchants (IANA timezone string, e.g. 'America/Los_Angeles')",
    table: 'merchants',
    column: 'timezone',
    definition: "TEXT NOT NULL DEFAULT 'America/Los_Angeles'",
  },
  // ── Order discounts ───────────────────────────────────────────────────────
  {
    description: 'Add discount_cents to orders (pre-tax discount amount applied to subtotal)',
    table: 'orders',
    column: 'discount_cents',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add discount_label to orders (display label for the discount, e.g. "Happy Hour")',
    table: 'orders',
    column: 'discount_label',
    definition: 'TEXT',
  },
  // ── Merchant discount presets ─────────────────────────────────────────────
  {
    description: 'Add discount_levels to merchants (JSON array of named discount presets)',
    table: 'merchants',
    column: 'discount_levels',
    definition: 'TEXT',
  },
  // ── Generic webhook shared secret ─────────────────────────────────────────
  {
    description: 'Add webhook_secret_enc to merchants (AES-256-GCM encrypted HMAC shared secret for generic webhooks)',
    table: 'merchants',
    column: 'webhook_secret_enc',
    definition: 'TEXT',
  },
  // ── Delivery order fields ─────────────────────────────────────────────────
  {
    description: 'Add delivery_address to orders (street address for delivery order type)',
    table: 'orders',
    column: 'delivery_address',
    definition: 'TEXT',
  },
  {
    description: 'Add delivery_instructions to orders (e.g. "Leave at door")',
    table: 'orders',
    column: 'delivery_instructions',
    definition: 'TEXT',
  },
  // ── Email receipts: Gmail address for sending customer receipts ───────────
  {
    description: "Add receipt_email_from to merchants (Gmail address used as the From address for customer email receipts)",
    table: 'merchants',
    column: 'receipt_email_from',
    definition: 'TEXT',
  },
  {
    description: "Add smtp_provider to merchants ('gmail' | 'outlook' | 'yahoo' | 'sendgrid' | 'smtp' — controls SMTP host/port for outbound email)",
    table: 'merchants',
    column: 'smtp_provider',
    definition: "TEXT NOT NULL DEFAULT 'gmail'",
  },
  // ── Payment reconciliation: link local payment to Finix transfer ──────────
  {
    description: 'Add finix_transfer_id to payments (Finix transfer ID matched during reconciliation)',
    table: 'payments',
    column: 'finix_transfer_id',
    definition: 'TEXT',
  },
  // ── Service charges (taxable surcharges for dine-in orders) ───────────────
  {
    description: 'Add service_charge_presets to merchants (JSON array of named service charge presets)',
    table: 'merchants',
    column: 'service_charge_presets',
    definition: 'TEXT',
  },
  {
    description: 'Add service_charge_cents to orders (taxable surcharge amount in cents)',
    table: 'orders',
    column: 'service_charge_cents',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add service_charge_label to orders (display label, e.g. "Party of 6+")',
    table: 'orders',
    column: 'service_charge_label',
    definition: 'TEXT',
  },
  {
    description: 'Add party_size to orders (number of guests at table, for reservation capacity tracking)',
    table: 'orders',
    column: 'party_size',
    definition: 'INTEGER',
  },
  {
    description: 'Add reservation_enabled to merchants (feature toggle)',
    table: 'merchants',
    column: 'reservation_enabled',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add reservation_slot_minutes to merchants (how long a booking holds tables, default 120)',
    table: 'merchants',
    column: 'reservation_slot_minutes',
    definition: 'INTEGER NOT NULL DEFAULT 120',
  },
  {
    description: 'Add reservation_cutoff_minutes to merchants (minutes before close: no more bookings, default 75)',
    table: 'merchants',
    column: 'reservation_cutoff_minutes',
    definition: 'INTEGER NOT NULL DEFAULT 75',
  },
  {
    description: 'Add reservation_advance_days to merchants (max days in advance bookings accepted, default 7)',
    table: 'merchants',
    column: 'reservation_advance_days',
    definition: 'INTEGER NOT NULL DEFAULT 7',
  },
  {
    description: 'Add reservation_max_party_size to merchants (party sizes above this prompt "please call")',
    table: 'merchants',
    column: 'reservation_max_party_size',
    definition: 'INTEGER NOT NULL DEFAULT 12',
  },
  {
    description: 'Add reservation_start_time to merchants (earliest bookable slot, HH:MM, null = no restriction)',
    table: 'merchants',
    column: 'reservation_start_time',
    definition: 'TEXT DEFAULT NULL',
  },
  {
    description: "Add print_status to pending_course_fires ('pending'|'sent'|'failed') for course-fire print observability",
    table: 'pending_course_fires',
    column: 'print_status',
    definition: "TEXT NOT NULL DEFAULT 'pending'",
  },
  {
    description: 'Add recipient_name to gift_card_purchases (name of the gift recipient, optional)',
    table: 'gift_card_purchases',
    column: 'recipient_name',
    definition: 'TEXT DEFAULT NULL',
  },
  {
    description: 'Add line_items_json to gift_card_purchases (JSON array of purchased card denominations)',
    table: 'gift_card_purchases',
    column: 'line_items_json',
    definition: "TEXT NOT NULL DEFAULT '[]'",
  },
  // ── Reservation morning briefing ──────────────────────────────────────────
  {
    description: 'Add reservation_briefing_time to merchants (HH:MM when daily reservation briefing email is sent, default 07:30)',
    table: 'merchants',
    column: 'reservation_briefing_time',
    definition: "TEXT NOT NULL DEFAULT '07:30'",
  },
  // ── FOG compliance — soft-delete + reminder tracking ──────────────────────
  {
    description: 'Add deleted_at to fog_entries (soft-delete for compliance audit trail — hard deletes prohibited)',
    table: 'fog_entries',
    column: 'deleted_at',
    definition: 'TEXT DEFAULT NULL',
  },
  {
    description: 'Add fog_trap_reminder_days to merchants (days between grease trap cleaning reminders, default 90)',
    table: 'merchants',
    column: 'fog_trap_reminder_days',
    definition: 'INTEGER NOT NULL DEFAULT 90',
  },
  {
    description: 'Add fog_hood_reminder_days to merchants (days between hood cleaning reminders, default 180)',
    table: 'merchants',
    column: 'fog_hood_reminder_days',
    definition: 'INTEGER NOT NULL DEFAULT 180',
  },
  {
    description: 'Add fog_trap_last_reminder to merchants (YYYY-MM-DD of last grease trap reminder email sent)',
    table: 'merchants',
    column: 'fog_trap_last_reminder',
    definition: 'TEXT DEFAULT NULL',
  },
  {
    description: 'Add fog_hood_last_reminder to merchants (YYYY-MM-DD of last hood cleaning reminder email sent)',
    table: 'merchants',
    column: 'fog_hood_last_reminder',
    definition: 'TEXT DEFAULT NULL',
  },
  {
    description: 'Add gift_card_id to payments (references gift card used for gift_card payment type)',
    table: 'payments',
    column: 'gift_card_id',
    definition: 'TEXT',
  },
  {
    description: 'Add gift_card_tax_offset_cents to payments (embedded tax offset applied from gift card)',
    table: 'payments',
    column: 'gift_card_tax_offset_cents',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  // ── Clover order integration ──────────────────────────────────────────────
  {
    description: 'Add clover_order_id to orders (Clover order ID created when order is pushed to Flex terminal)',
    table: 'orders',
    column: 'clover_order_id',
    definition: 'TEXT',  // UNIQUE enforced via separate index (SQLite cannot ADD COLUMN ... UNIQUE)
  },
  {
    description: 'Add clover_payment_id to orders (Clover payment ID set when Flex terminal completes payment)',
    table: 'orders',
    column: 'clover_payment_id',
    definition: 'TEXT',
  },
  {
    description: 'Add clover_payment_method to orders (payment method string from Clover e.g. CREDIT_CARD)',
    table: 'orders',
    column: 'clover_payment_method',
    definition: 'TEXT',
  },
  // ── Tip-on-terminal: let PAX A920 collect tip from customer ──────────────
  {
    description: 'Add tip_on_terminal to merchants (1 = PAX A920 terminal prompts customer for tip, 0 = staff enters tip manually)',
    table: 'merchants',
    column: 'tip_on_terminal',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
  {
    description: 'Add suggested_tip_percentages to merchants (JSON array of tip % options shown on PAX terminal, e.g. [15,20,25])',
    table: 'merchants',
    column: 'suggested_tip_percentages',
    definition: "TEXT NOT NULL DEFAULT '[15,20,25]'",
  },
]

/**
 * Migrations that require recreating a table (e.g. CHECK constraint changes)
 * or creating new tables not in schema.sql (to avoid re-running on clean installs).
 * Each entry is idempotent: guarded by a sentinel check before running.
 */
const tableMigrations: Array<{
  description: string
  /** Return true if the migration still needs to run */
  isNeeded: (db: ReturnType<typeof getDatabase>) => boolean
  run: (db: ReturnType<typeof getDatabase>) => void
}> = [
  {
    description: 'Make orders.customer_phone nullable (optional for walk-in/dine-in)',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && row.sql.includes('customer_phone TEXT NOT NULL')
    },
    run: (db) => {
      // PRAGMA legacy_alter_table = ON prevents SQLite from auto-updating FK references
      // in child tables (refunds, customer_push_subscriptions, etc.) when orders is renamed.
      // Without this, child FKs silently redirect to "_orders_old" which is then dropped,
      // breaking all future inserts into those child tables (FOREIGN KEY constraint failed).
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'completed', 'cancelled', 'pos_error', 'paid'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0,
          table_label TEXT,
          room_label TEXT,
          course_mode INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0),
          table_label, room_label, COALESCE(course_mode, 0)
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
    },
  },
  {
    description: "Add 'dine_in' to orders.order_type CHECK constraint",
    isNeeded: (db) => {
      // Check the current constraint by inspecting sqlite_master
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && !row.sql.includes("'dine_in'")
    },
    run: (db) => {
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'completed', 'cancelled', 'pos_error', 'paid'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0)
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
    },
  },
  {
    description: 'Create refunds table for recording order refunds',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='refunds'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS refunds (
          id                   TEXT PRIMARY KEY,
          order_id             TEXT NOT NULL REFERENCES orders(id),
          merchant_id          TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          type                 TEXT NOT NULL CHECK(type IN ('full', 'partial')),
          refund_amount_cents  INTEGER NOT NULL,
          tax_refunded_cents   INTEGER NOT NULL DEFAULT 0,
          items_json           TEXT,
          notes                TEXT,
          refunded_by_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
          refunded_by_name     TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_refunds_order_id    ON refunds(order_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_merchant_id ON refunds(merchant_id);
      `)
    },
  },
  {
    description: 'Create pending_course_fires table for delayed coursing prints',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pending_course_fires'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_course_fires (
          id               TEXT PRIMARY KEY DEFAULT ('pcf_' || lower(hex(randomblob(8)))),
          merchant_id      TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          course           INTEGER NOT NULL DEFAULT 2,
          fire_at          TEXT NOT NULL,
          fired_at         TEXT DEFAULT NULL,
          printer_ip       TEXT NOT NULL,
          printer_protocol TEXT NOT NULL DEFAULT 'star-line',
          print_language   TEXT DEFAULT 'en',
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pcf_pending ON pending_course_fires(fire_at) WHERE fired_at IS NULL;
      `)
    },
  },
  {
    description: "Rename printer protocol value 'esc-pos' → 'star-line-tsp100' in merchants table",
    isNeeded: (db) => {
      const row = db
        .query<{ cnt: number }, []>(
          `SELECT COUNT(*) AS cnt FROM merchants
           WHERE kitchen_printer_protocol = 'esc-pos'
              OR counter_printer_protocol = 'esc-pos'
              OR receipt_printer_protocol = 'esc-pos'`
        )
        .get()
      return (row?.cnt ?? 0) > 0
    },
    run: (db) => {
      db.exec(`
        UPDATE merchants SET kitchen_printer_protocol = 'star-line-tsp100'
          WHERE kitchen_printer_protocol = 'esc-pos';
        UPDATE merchants SET counter_printer_protocol = 'star-line-tsp100'
          WHERE counter_printer_protocol = 'esc-pos';
        UPDATE merchants SET receipt_printer_protocol = 'star-line-tsp100'
          WHERE receipt_printer_protocol = 'esc-pos';
      `)
    },
  },
  {
    description: "Add 'paid' to orders.status CHECK constraint",
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && !row.sql.includes("'paid'")
    },
    run: (db) => {
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'completed', 'cancelled', 'pos_error', 'paid'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0,
          table_label TEXT,
          room_label TEXT,
          course_mode INTEGER NOT NULL DEFAULT 0,
          employee_id TEXT,
          employee_nickname TEXT
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0),
          table_label, room_label, COALESCE(course_mode, 0),
          employee_id, employee_nickname
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
    },
  },

  // PERF: Normalize ISO-format created_at/updated_at (from store.ts online orders) to SQLite
  // space format 'YYYY-MM-DD HH:MM:SS' so direct string comparison works for index range scans.
  {
    description: 'Normalize ISO-format order timestamps to SQLite datetime format',
    isNeeded: (db) => {
      const row = db.query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM orders WHERE created_at LIKE '%T%'`
      ).get()
      return !!row && row.n > 0
    },
    run: (db) => {
      db.exec(`
        UPDATE orders
        SET created_at = replace(replace(substr(created_at, 1, 19), 'T', ' '), 'Z', ''),
            updated_at = replace(replace(substr(updated_at, 1, 19), 'T', ' '), 'Z', '')
        WHERE created_at LIKE '%T%'
      `)
    },
  },

  // PERF-IDX-1: Composite index on orders(merchant_id, created_at) for dashboard list queries.
  // Enables index range scan instead of filesort when filtering by merchant + date range.
  {
    description: 'Add composite index on orders(merchant_id, created_at) for dashboard queries',
    isNeeded: (db) => {
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_merchant_created'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_merchant_created ON orders(merchant_id, created_at DESC)`)
    },
  },

  // PERF-IDX-2: Composite index on orders(merchant_id, status, created_at) for reports queries.
  {
    description: 'Add composite index on orders(merchant_id, status, created_at) for reports',
    isNeeded: (db) => {
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_merchant_status_created'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_merchant_status_created ON orders(merchant_id, status, created_at)`)
    },
  },

  // PERF-IDX-3: Composite index on refunds(merchant_id, order_id) for refund list queries.
  {
    description: 'Add composite index on refunds(merchant_id, order_id) for refund queries',
    isNeeded: (db) => {
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_refunds_merchant_order'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_refunds_merchant_order ON refunds(merchant_id, order_id)`)
    },
  },

  {
    description: 'Add composite index on reservations(merchant_id, date, status) for slot availability queries',
    isNeeded: (db) => {
      const tbl = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='reservations'`
      ).get()
      if (!tbl) return false
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_reservations_merchant_date_status'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_merchant_date_status ON reservations(merchant_id, date, status)`)
    },
  },

  {
    description: 'Add composite index on payments(merchant_id, payment_type) for reconciliation scan',
    isNeeded: (db) => {
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payments_type_merchant'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_type_merchant ON payments(merchant_id, payment_type)`)
    },
  },

  // KEY-TYPE: Rebuild api_keys with updated CHECK constraint to include 'cloud' and 'email'.
  // Fresh installs get the correct constraint from schema.sql; existing DBs need this rebuild.
  {
    description: "Rebuild api_keys with key_type CHECK that includes 'cloud' and 'email'",
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='api_keys'`
      ).get()
      return !!row && !row.sql.includes("'email'")
    },
    run: (db) => {
      db.exec(`
        BEGIN;
        ALTER TABLE api_keys RENAME TO _api_keys_old;
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          key_type TEXT NOT NULL CHECK(key_type IN ('pos', 'payment', 'cloud', 'email')),
          provider TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          pos_merchant_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          UNIQUE(merchant_id, key_type, provider)
        );
        INSERT INTO api_keys SELECT
          id, merchant_id, key_type, provider, encrypted_value,
          pos_merchant_id, created_at, last_used_at
        FROM _api_keys_old;
        DROP TABLE _api_keys_old;
        CREATE INDEX IF NOT EXISTS idx_api_keys_merchant ON api_keys(merchant_id);
        COMMIT;
      `)
    },
  },

  // STATUS: Add 'refunded' to orders.status CHECK constraint so dashboard-refunds
  // route can mark fully-refunded orders without triggering a CHECK violation.
  {
    description: "Add 'refunded' to orders.status CHECK constraint",
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && !row.sql.includes("'refunded'")
    },
    run: (db) => {
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'completed', 'cancelled', 'pos_error', 'paid', 'refunded'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0,
          table_label TEXT,
          room_label TEXT,
          course_mode INTEGER NOT NULL DEFAULT 0,
          employee_id TEXT,
          employee_nickname TEXT,
          tip_cents INTEGER NOT NULL DEFAULT 0,
          paid_amount_cents INTEGER NOT NULL DEFAULT 0,
          payment_method TEXT,
          estimated_ready_at TEXT,
          payment_checkout_form_id TEXT,
          payment_transfer_id TEXT,
          discount_cents INTEGER NOT NULL DEFAULT 0,
          discount_label TEXT,
          delivery_address TEXT,
          delivery_instructions TEXT
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0),
          table_label, room_label, COALESCE(course_mode, 0),
          employee_id, employee_nickname,
          COALESCE(tip_cents, 0), COALESCE(paid_amount_cents, 0), payment_method,
          estimated_ready_at, payment_checkout_form_id, payment_transfer_id,
          COALESCE(discount_cents, 0), discount_label,
          delivery_address, delivery_instructions
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
    },
  },
  // PAYMENTS: Create payments table for in-person payment records (Review & Pay modal).
  {
    description: 'Create payments table for in-person payment records',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='payments'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          id                    TEXT PRIMARY KEY,
          order_id              TEXT NOT NULL REFERENCES orders(id),
          merchant_id           TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_type          TEXT NOT NULL CHECK(payment_type IN ('card', 'cash')),
          amount_cents          INTEGER NOT NULL,
          subtotal_cents        INTEGER NOT NULL,
          tax_cents             INTEGER NOT NULL,
          tip_cents             INTEGER NOT NULL DEFAULT 0,
          amex_surcharge_cents  INTEGER NOT NULL DEFAULT 0,
          gratuity_percent      INTEGER,
          card_type             TEXT,
          card_last_four        TEXT,
          cardholder_name       TEXT,
          transaction_id        TEXT,
          processor             TEXT,
          auth_code             TEXT,
          signature_base64      TEXT,
          signature_captured_at TEXT,
          split_mode            TEXT,
          split_leg_number      INTEGER,
          split_total_legs      INTEGER,
          split_items_json      TEXT,
          receipt_printed       INTEGER NOT NULL DEFAULT 0,
          receipt_emailed       INTEGER NOT NULL DEFAULT 0,
          receipt_email         TEXT,
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, created_at);
      `)
    },
  },

  // MOD-MAX-DEFAULT: Backfill max_allowed = 1 for all existing modifier groups that have NULL.
  // NULL previously had no semantic meaning (the column was unused). Now NULL = unlimited
  // multi-select and 1 = single-select. All groups created before this feature were implicitly
  // single-select, so we default them to 1 to preserve existing behaviour.
  {
    description: 'Set max_allowed = 1 (single-select) for existing modifier groups where NULL',
    isNeeded: (db) => {
      const row = db.query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM modifier_groups WHERE max_allowed IS NULL`
      ).get()
      return (row?.n ?? 0) > 0
    },
    run: (db) => {
      db.exec(`UPDATE modifier_groups SET max_allowed = 1 WHERE max_allowed IS NULL`)
    },
  },

  // FK-REPAIR: Recover from the side-effect of orders table rebuild migrations running with
  // legacy_alter_table = OFF (the modern SQLite default). When orders was renamed to _orders_old,
  // SQLite auto-updated FK references in child tables to point at "_orders_old".  The subsequent
  // DROP TABLE _orders_old then failed (FK enforcement blocked it), leaving _orders_old stranded
  // and child tables with broken FK references. Any INSERT into refunds/customer_push_subscriptions/
  // pending_course_fires for orders created AFTER the failed rebuild will hit
  // "FOREIGN KEY constraint failed" because those orders only exist in `orders`, not `_orders_old`.
  //
  // Fix: rebuild the three affected child tables with correct REFERENCES orders(id), then drop the
  // orphaned _orders_old table. PRAGMA foreign_keys = OFF is required for the duration so that:
  //   a) The table renames below do NOT trigger another round of FK-reference rewrites, and
  //   b) DROP TABLE _orders_old succeeds (child tables are being rebuilt in the same transaction).
  {
    description: 'Repair FK references broken by orders-rename migration: rebuild refunds, customer_push_subscriptions, pending_course_fires and drop orphaned _orders_old',
    isNeeded: (db) => {
      const row = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='_orders_old'`
      ).get()
      return !!row
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        -- ── Rebuild refunds ────────────────────────────────────────────────────
        ALTER TABLE refunds RENAME TO _refunds_old;
        CREATE TABLE refunds (
          id                   TEXT PRIMARY KEY,
          order_id             TEXT NOT NULL REFERENCES orders(id),
          merchant_id          TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          type                 TEXT NOT NULL CHECK(type IN ('full', 'partial')),
          refund_amount_cents  INTEGER NOT NULL,
          tax_refunded_cents   INTEGER NOT NULL DEFAULT 0,
          items_json           TEXT,
          notes                TEXT,
          refunded_by_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
          refunded_by_name     TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          processor_refund_id  TEXT
        );
        INSERT INTO refunds
          (id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents,
           items_json, notes, refunded_by_id, refunded_by_name, created_at, processor_refund_id)
          SELECT id, order_id, merchant_id, type, refund_amount_cents, tax_refunded_cents,
                 items_json, notes, refunded_by_id, refunded_by_name, created_at, processor_refund_id
          FROM _refunds_old;
        DROP TABLE _refunds_old;

        -- ── Rebuild customer_push_subscriptions ────────────────────────────────
        ALTER TABLE customer_push_subscriptions RENAME TO _cps_old;
        CREATE TABLE customer_push_subscriptions (
          id          TEXT PRIMARY KEY,
          order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          endpoint    TEXT NOT NULL UNIQUE,
          p256dh      TEXT NOT NULL,
          auth        TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO customer_push_subscriptions
          (id, order_id, merchant_id, endpoint, p256dh, auth, created_at)
          SELECT id, order_id, merchant_id, endpoint, p256dh, auth, created_at
          FROM _cps_old;
        DROP TABLE _cps_old;

        -- ── Rebuild pending_course_fires ───────────────────────────────────────
        ALTER TABLE pending_course_fires RENAME TO _pcf_old;
        CREATE TABLE pending_course_fires (
          id               TEXT PRIMARY KEY DEFAULT ('pcf_' || lower(hex(randomblob(8)))),
          merchant_id      TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          course           INTEGER NOT NULL DEFAULT 2,
          fire_at          TEXT NOT NULL,
          fired_at         TEXT DEFAULT NULL,
          printer_ip       TEXT NOT NULL,
          printer_protocol TEXT NOT NULL DEFAULT 'star-line',
          print_language   TEXT DEFAULT 'en',
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO pending_course_fires
          (id, merchant_id, order_id, course, fire_at, fired_at,
           printer_ip, printer_protocol, print_language, created_at)
          SELECT id, merchant_id, order_id, course, fire_at, fired_at,
                 printer_ip, printer_protocol, print_language, created_at
          FROM _pcf_old;
        DROP TABLE _pcf_old;

        -- ── Drop the orphaned _orders_old table ────────────────────────────────
        DROP TABLE _orders_old;

        -- ── Recreate indexes ───────────────────────────────────────────────────
        CREATE INDEX IF NOT EXISTS idx_customer_push_order    ON customer_push_subscriptions(order_id);
        CREATE INDEX IF NOT EXISTS idx_customer_push_merchant ON customer_push_subscriptions(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_order_id       ON refunds(order_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_merchant_id    ON refunds(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_merchant_order ON refunds(merchant_id, order_id);
        CREATE INDEX IF NOT EXISTS idx_pcf_pending            ON pending_course_fires(fire_at) WHERE fired_at IS NULL;

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  // SEC-LOG: Create security_events table for audit logging (C-04/C-05)
  {
    description: 'Create security_events table for security audit logging',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='security_events'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          ip_address TEXT,
          merchant_id TEXT,
          user_id TEXT,
          path TEXT,
          extra TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_security_events_type_created
          ON security_events(event_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_security_events_ip
          ON security_events(ip_address, created_at);
      `)
    },
  },
  {
    description: 'Create terminals table (PAX payment terminals)',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='terminals'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminals (
          id            TEXT PRIMARY KEY,
          merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          model         TEXT NOT NULL,
          nickname      TEXT NOT NULL,
          serial_number TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_terminals_merchant ON terminals(merchant_id);
      `)
    },
  },
  // ── Payment reconciliation results ────────────────────────────────────────
  {
    description: "Add 'pending_payment' to orders.status CHECK constraint for pre-payment order state",
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && !row.sql.includes("'pending_payment'")
    },
    run: (db) => {
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending_payment', 'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'completed', 'cancelled', 'pos_error', 'paid', 'refunded'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0,
          table_label TEXT,
          room_label TEXT,
          course_mode INTEGER NOT NULL DEFAULT 0,
          employee_id TEXT,
          employee_nickname TEXT,
          tip_cents INTEGER NOT NULL DEFAULT 0,
          paid_amount_cents INTEGER NOT NULL DEFAULT 0,
          payment_method TEXT,
          estimated_ready_at TEXT,
          payment_checkout_form_id TEXT,
          payment_transfer_id TEXT,
          discount_cents INTEGER NOT NULL DEFAULT 0,
          discount_label TEXT,
          delivery_address TEXT,
          delivery_instructions TEXT
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0),
          table_label, room_label, COALESCE(course_mode, 0),
          employee_id, employee_nickname,
          COALESCE(tip_cents, 0), COALESCE(paid_amount_cents, 0), payment_method,
          estimated_ready_at, payment_checkout_form_id, payment_transfer_id,
          COALESCE(discount_cents, 0), discount_label,
          delivery_address, delivery_instructions
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
    },
  },
  // FK-REPAIR-PAYMENTS: Rebuild payments table if its order_id FK was corrupted to
  // reference _orders_old instead of orders. This happens when an orders rebuild
  // migration ran with legacy_alter_table = OFF (SQLite default), causing SQLite to
  // auto-rewrite child FK references from `orders` to `_orders_old`. The earlier
  // FK-REPAIR migration only fixed refunds/customer_push_subscriptions/pending_course_fires.
  {
    description: 'Repair FK reference in payments table broken by orders-rename migration',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`
      ).get()
      return !!row?.sql?.includes('_orders_old')
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      // PRAGMA legacy_alter_table = ON prevents SQLite from auto-updating FK references
      // in child tables (payment_reconciliations) when payments is renamed.
      // Without this, child FKs silently redirect to "_payments_old" which is then
      // dropped, breaking all future inserts into those child tables.
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payments RENAME TO _payments_old;

        CREATE TABLE payments (
          id                    TEXT PRIMARY KEY,
          order_id              TEXT NOT NULL REFERENCES orders(id),
          merchant_id           TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_type          TEXT NOT NULL CHECK(payment_type IN ('card', 'cash')),
          amount_cents          INTEGER NOT NULL,
          subtotal_cents        INTEGER NOT NULL DEFAULT 0,
          tax_cents             INTEGER NOT NULL DEFAULT 0,
          tip_cents             INTEGER NOT NULL DEFAULT 0,
          amex_surcharge_cents  INTEGER NOT NULL DEFAULT 0,
          gratuity_percent      REAL,
          card_type             TEXT,
          card_last_four        TEXT,
          cardholder_name       TEXT,
          transaction_id        TEXT,
          processor             TEXT,
          auth_code             TEXT,
          finix_transfer_id     TEXT,
          signature_base64      TEXT,
          signature_captured_at TEXT,
          split_mode            TEXT,
          split_leg_number      INTEGER,
          split_total_legs      INTEGER,
          split_items_json      TEXT,
          receipt_printed       INTEGER NOT NULL DEFAULT 0,
          receipt_emailed       INTEGER NOT NULL DEFAULT 0,
          receipt_email         TEXT,
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at          TEXT
        );

        INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email, created_at, completed_at
        )
        SELECT
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email, created_at, completed_at
        FROM _payments_old;
        DROP TABLE _payments_old;

        CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  {
    description: 'Create payment_reconciliations table for Finix transfer matching',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='payment_reconciliations'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_reconciliations (
          id                  TEXT PRIMARY KEY,
          merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_id          TEXT REFERENCES payments(id) ON DELETE CASCADE,
          finix_transfer_id   TEXT,
          status              TEXT NOT NULL CHECK(status IN (
                                'matched', 'unmatched', 'cash_skipped', 'no_processor'
                              )),
          local_amount_cents  INTEGER,
          finix_amount_cents  INTEGER,
          checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
          alerted             INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_reconciliations_merchant
          ON payment_reconciliations(merchant_id, checked_at);
        CREATE INDEX IF NOT EXISTS idx_reconciliations_payment
          ON payment_reconciliations(payment_id);
      `)
    },
  },
  // FK-REPAIR-RECONCILIATIONS: The FK-REPAIR-PAYMENTS migration above ran without
  // `legacy_alter_table = ON`, causing SQLite to auto-rewrite the FK in
  // payment_reconciliations from `payments(id)` to `_payments_old(id)`.
  // After `_payments_old` was dropped, any INSERT into payment_reconciliations fails
  // with "no such table: main._payments_old".  Rebuild to restore correct FK.
  {
    description: 'Repair FK reference in payment_reconciliations broken by payments-rename migration',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_reconciliations'`
      ).get()
      return !!row?.sql?.includes('_payments_old')
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payment_reconciliations RENAME TO _payment_reconciliations_old;

        CREATE TABLE payment_reconciliations (
          id                  TEXT PRIMARY KEY,
          merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_id          TEXT REFERENCES payments(id) ON DELETE CASCADE,
          finix_transfer_id   TEXT,
          status              TEXT NOT NULL CHECK(status IN (
                                'matched', 'unmatched', 'cash_skipped', 'no_processor'
                              )),
          local_amount_cents  INTEGER,
          finix_amount_cents  INTEGER,
          checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
          alerted             INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO payment_reconciliations (
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, checked_at, alerted
        )
        SELECT
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, checked_at, alerted
        FROM _payment_reconciliations_old;

        DROP TABLE _payment_reconciliations_old;

        CREATE INDEX IF NOT EXISTS idx_reconciliations_merchant
          ON payment_reconciliations(merchant_id, checked_at);
        CREATE INDEX IF NOT EXISTS idx_reconciliations_payment
          ON payment_reconciliations(payment_id);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  // RESERVATIONS: Create reservations table for online and walk-in table bookings.
  {
    description: 'Create reservations table for table bookings',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='reservations'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reservations (
          id              TEXT PRIMARY KEY,
          merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name   TEXT NOT NULL,
          customer_phone  TEXT,
          customer_email  TEXT,
          party_size      INTEGER NOT NULL,
          date            TEXT NOT NULL,
          time            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'confirmed'
                          CHECK(status IN ('confirmed','seated','cancelled','no_show')),
          table_label     TEXT,
          group_id        TEXT,
          notes           TEXT,
          confirmation_code TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_reservations_merchant_date
          ON reservations(merchant_id, date);
        CREATE INDEX IF NOT EXISTS idx_reservations_merchant_status
          ON reservations(merchant_id, status, date);
      `)
    },
  },
  {
    description: 'Create pending_terminal_sales table for orphan payment recovery',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pending_terminal_sales'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_terminal_sales (
          id               TEXT PRIMARY KEY DEFAULT ('pts_' || lower(hex(randomblob(8)))),
          merchant_id      TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          order_id         TEXT NOT NULL,
          transfer_id      TEXT NOT NULL,
          device_id        TEXT NOT NULL,
          amount_cents     INTEGER NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pts_pending
          ON pending_terminal_sales(status) WHERE status = 'pending';
      `)
    },
  },

  {
    description: 'Add composite partial index on pending_terminal_sales(status, created_at) for orphan recovery scan',
    isNeeded: (db) => {
      const tbl = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='pending_terminal_sales'`
      ).get()
      if (!tbl) return false  // table not yet created — skip until next run
      const idx = db.query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_terminal_status'`
      ).get()
      return !idx
    },
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_terminal_status ON pending_terminal_sales(status, created_at) WHERE status = 'pending'`)
    },
  },

  // DEDUP-RECONCILIATIONS: Add UNIQUE constraint on payment_id and remove
  // duplicate rows created by the old INSERT OR REPLACE (which keyed on random id).
  {
    description: 'Add UNIQUE constraint on payment_reconciliations.payment_id and deduplicate',
    isNeeded: (db) => {
      // Check if idx_reconciliations_payment is already UNIQUE
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_reconciliations_payment_unique'`
      ).get()
      return !row
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payment_reconciliations RENAME TO _pr_dedup_old;

        CREATE TABLE payment_reconciliations (
          id                  TEXT PRIMARY KEY,
          merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_id          TEXT UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
          finix_transfer_id   TEXT,
          status              TEXT NOT NULL CHECK(status IN (
                                'matched', 'unmatched', 'cash_skipped', 'no_processor'
                              )),
          local_amount_cents  INTEGER,
          finix_amount_cents  INTEGER,
          checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
          alerted             INTEGER NOT NULL DEFAULT 0
        );

        -- Keep only the most recent row per payment_id
        INSERT INTO payment_reconciliations (
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, checked_at, alerted
        )
        SELECT
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, MAX(checked_at), alerted
        FROM _pr_dedup_old
        GROUP BY payment_id;

        DROP TABLE _pr_dedup_old;

        CREATE INDEX IF NOT EXISTS idx_reconciliations_merchant
          ON payment_reconciliations(merchant_id, checked_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliations_payment_unique
          ON payment_reconciliations(payment_id);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  // PAYMENT-EVENTS: Structured payment audit log with 7-day retention.
  // Captures terminal, CNP, online, and reconciliation lifecycle events.
  {
    description: 'Create payment_events table for structured payment audit logging (7-day retention)',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='payment_events'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_events (
          id           TEXT    PRIMARY KEY DEFAULT ('pe_' || lower(hex(randomblob(8)))),
          merchant_id  TEXT    NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          order_id     TEXT,
          payment_id   TEXT,
          transfer_id  TEXT,
          device_id    TEXT,
          amount_cents INTEGER,
          event_type   TEXT    NOT NULL,
          level        TEXT    NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
          message      TEXT,
          data_json    TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_payment_events_merchant_created
          ON payment_events(merchant_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_payment_events_order
          ON payment_events(order_id) WHERE order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_payment_events_transfer
          ON payment_events(transfer_id) WHERE transfer_id IS NOT NULL;
      `)
    },
  },

  // GIFT-CARD-PURCHASES: One row per customer purchase transaction.
  {
    description: 'Create gift_card_purchases table',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='gift_card_purchases'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gift_card_purchases (
          id                       TEXT    PRIMARY KEY,
          merchant_id              TEXT    NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name            TEXT    NOT NULL,
          customer_email           TEXT    NOT NULL,
          line_items_json          TEXT    NOT NULL DEFAULT '[]',
          total_cents              INTEGER NOT NULL,
          net_revenue_cents        INTEGER NOT NULL,
          tax_embedded_cents       INTEGER NOT NULL,
          payment_provider         TEXT,
          payment_checkout_form_id TEXT,
          payment_transfer_id      TEXT,
          status                   TEXT    NOT NULL DEFAULT 'pending_payment'
                                           CHECK (status IN ('pending_payment', 'paid', 'failed')),
          created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_gift_card_purchases_merchant
          ON gift_card_purchases(merchant_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_gift_card_purchases_email
          ON gift_card_purchases(customer_email);
      `)
    },
  },

  // GIFT-CARDS: One row per physical/digital card issued.
  {
    description: 'Create gift_cards table',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='gift_cards'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gift_cards (
          id               TEXT    PRIMARY KEY,
          merchant_id      TEXT    NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          purchase_id      TEXT    NOT NULL REFERENCES gift_card_purchases(id) ON DELETE CASCADE,
          code             TEXT    NOT NULL UNIQUE,
          face_value_cents INTEGER NOT NULL,
          balance_cents    INTEGER NOT NULL,
          status           TEXT    NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'depleted', 'expired')),
          expires_at       TEXT    NOT NULL,
          redeemed_at      TEXT,
          created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_gift_cards_merchant
          ON gift_cards(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_gift_cards_purchase
          ON gift_cards(purchase_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code
          ON gift_cards(code);
      `)
    },
  },
  {
    description: 'Create fog_entries table for grease trap cleaning log',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fog_entries'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fog_entries (
          id             TEXT    PRIMARY KEY,
          merchant_id    TEXT    NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          cleaned_date   TEXT    NOT NULL,
          cleaned_by     TEXT    NOT NULL,
          grease_gallons REAL    NOT NULL,
          solids_gallons REAL    NOT NULL,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          deleted_at     TEXT    DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fog_entries_merchant_date
          ON fog_entries(merchant_id, cleaned_date);
      `)
    },
  },
  // GC-PAYMENT: Widen payments CHECK constraint to include 'gift_card' payment type.
  {
    description: 'Widen payments CHECK constraint to include gift_card payment type',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`
      ).get()
      return !!row && !row.sql.includes("'gift_card'")
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payments RENAME TO _payments_old;

        CREATE TABLE payments (
          id                         TEXT PRIMARY KEY,
          order_id                   TEXT NOT NULL REFERENCES orders(id),
          merchant_id                TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_type               TEXT NOT NULL CHECK(payment_type IN ('card', 'cash', 'gift_card')),
          amount_cents               INTEGER NOT NULL,
          subtotal_cents             INTEGER NOT NULL DEFAULT 0,
          tax_cents                  INTEGER NOT NULL DEFAULT 0,
          tip_cents                  INTEGER NOT NULL DEFAULT 0,
          amex_surcharge_cents       INTEGER NOT NULL DEFAULT 0,
          gratuity_percent           REAL,
          card_type                  TEXT,
          card_last_four             TEXT,
          cardholder_name            TEXT,
          transaction_id             TEXT,
          processor                  TEXT,
          auth_code                  TEXT,
          finix_transfer_id          TEXT,
          signature_base64           TEXT,
          signature_captured_at      TEXT,
          split_mode                 TEXT,
          split_leg_number           INTEGER,
          split_total_legs           INTEGER,
          split_items_json           TEXT,
          receipt_printed            INTEGER NOT NULL DEFAULT 0,
          receipt_emailed            INTEGER NOT NULL DEFAULT 0,
          receipt_email              TEXT,
          gift_card_id               TEXT,
          gift_card_tax_offset_cents INTEGER NOT NULL DEFAULT 0,
          created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at               TEXT
        );

        INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email, created_at, completed_at
        )
        SELECT
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email, created_at, completed_at
        FROM _payments_old;
        DROP TABLE _payments_old;

        CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_payments_type_merchant ON payments(merchant_id, payment_type);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  // GC-RECONCILE: Widen payment_reconciliations CHECK to include gift_card_skipped.
  {
    description: 'Widen payment_reconciliations CHECK constraint to include gift_card_skipped',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_reconciliations'`
      ).get()
      return !!row && !row.sql.includes("'gift_card_skipped'")
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payment_reconciliations RENAME TO _pr_gc_old;

        CREATE TABLE payment_reconciliations (
          id                  TEXT PRIMARY KEY,
          merchant_id         TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_id          TEXT UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
          finix_transfer_id   TEXT,
          status              TEXT NOT NULL CHECK(status IN (
                                'matched', 'unmatched', 'cash_skipped', 'no_processor',
                                'gift_card_skipped'
                              )),
          local_amount_cents  INTEGER,
          finix_amount_cents  INTEGER,
          checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
          alerted             INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO payment_reconciliations (
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, checked_at, alerted
        )
        SELECT
          id, merchant_id, payment_id, finix_transfer_id, status,
          local_amount_cents, finix_amount_cents, checked_at, alerted
        FROM _pr_gc_old;

        DROP TABLE _pr_gc_old;

        CREATE INDEX IF NOT EXISTS idx_reconciliations_merchant
          ON payment_reconciliations(merchant_id, checked_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliations_payment_unique
          ON payment_reconciliations(payment_id);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  {
    description: 'Create fog_hood_entries table for exhaust hood cleaning log',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fog_hood_entries'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fog_hood_entries (
          id           TEXT NOT NULL PRIMARY KEY,
          merchant_id  TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          cleaned_date TEXT NOT NULL,
          cleaned_by   TEXT NOT NULL,
          notes        TEXT DEFAULT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at   TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fog_hood_merchant_date
          ON fog_hood_entries(merchant_id, cleaned_date);
      `)
    },
  },
  {
    // denomination_cents was removed from the gift_card_purchases schema but left behind
    // in some dev databases as a NOT NULL column — causing INSERT failures.
    // SQLite 3.35+ supports DROP COLUMN for columns that aren't indexed or part of a PK/FK.
    description: 'Drop stale denomination_cents column from gift_card_purchases',
    isNeeded: (db) => {
      const cols = db.query<{ name: string }, [string]>(
        `SELECT name FROM pragma_table_info(?) WHERE name = 'denomination_cents'`
      ).all('gift_card_purchases')
      return cols.length > 0
    },
    run: (db) => {
      db.exec(`ALTER TABLE gift_card_purchases DROP COLUMN denomination_cents`)
    },
  },

  // ORDER-LIFECYCLE: Add 'picked_up' to orders.status CHECK constraint.
  // 'completed' is kept for backward compat with historical data; 'picked_up' is the
  // new terminal status for online orders after the customer collects their order.
  {
    description: "Add 'picked_up' to orders.status CHECK constraint",
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'`
      ).get()
      return !!row && !row.sql.includes("'picked_up'")
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;
        ALTER TABLE orders RENAME TO _orders_old;
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          items TEXT NOT NULL,
          subtotal_cents INTEGER NOT NULL,
          tax_cents INTEGER NOT NULL DEFAULT 0,
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending_payment', 'received', 'submitted', 'confirmed', 'preparing',
            'ready', 'picked_up', 'completed', 'cancelled', 'pos_error', 'paid', 'refunded'
          )) DEFAULT 'received',
          sam_state TEXT,
          pos_order_id TEXT,
          pos_provider TEXT,
          order_type TEXT NOT NULL CHECK(order_type IN ('pickup', 'delivery', 'dine_in')) DEFAULT 'pickup',
          pickup_code TEXT,
          pickup_time TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source TEXT NOT NULL DEFAULT 'local',
          notes TEXT,
          utensils_needed INTEGER NOT NULL DEFAULT 0,
          table_label TEXT,
          room_label TEXT,
          course_mode INTEGER NOT NULL DEFAULT 0,
          employee_id TEXT,
          employee_nickname TEXT,
          tip_cents INTEGER NOT NULL DEFAULT 0,
          paid_amount_cents INTEGER NOT NULL DEFAULT 0,
          payment_method TEXT,
          estimated_ready_at TEXT,
          payment_checkout_form_id TEXT,
          payment_transfer_id TEXT,
          discount_cents INTEGER NOT NULL DEFAULT 0,
          discount_label TEXT,
          delivery_address TEXT,
          delivery_instructions TEXT,
          service_charge_cents INTEGER NOT NULL DEFAULT 0,
          service_charge_label TEXT,
          party_size INTEGER
        );
        INSERT INTO orders SELECT
          id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents,
          status, sam_state, pos_order_id, pos_provider,
          order_type, pickup_code, pickup_time,
          created_at, updated_at, completed_at,
          COALESCE(source, 'local'), notes, COALESCE(utensils_needed, 0),
          table_label, room_label, COALESCE(course_mode, 0),
          employee_id, employee_nickname,
          COALESCE(tip_cents, 0), COALESCE(paid_amount_cents, 0), payment_method,
          estimated_ready_at, payment_checkout_form_id, payment_transfer_id,
          COALESCE(discount_cents, 0), discount_label,
          delivery_address, delivery_instructions,
          COALESCE(service_charge_cents, 0), service_charge_label, party_size
        FROM _orders_old;
        DROP TABLE _orders_old;
        CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_pickup_code ON orders(pickup_code);
        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },

  // TERMINAL-PAYMENT: Audit log + SAM rehydration source for PAX A920 Pro transactions.
  // One row per transaction lifecycle (INITIATING → COMPLETED/DECLINED/CANCELLED).
  // sam_state JSON allows in-flight transactions (AWAITING_TAP) to resume polling on restart.
  {
    description: 'Create terminal_transactions table for A920 Pro payment audit log and rehydration',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_transactions'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS terminal_transactions (
          id                TEXT PRIMARY KEY DEFAULT ('ttx_' || lower(hex(randomblob(8)))),
          terminal_id       TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
          merchant_id       TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          order_id          TEXT REFERENCES orders(id) ON DELETE SET NULL,
          tx_state          TEXT NOT NULL DEFAULT 'IDLE',
          amount_cents      INTEGER,
          finix_transfer_id TEXT,
          idempotency_key   TEXT,
          card_brand        TEXT,
          card_last_four    TEXT,
          approval_code     TEXT,
          decline_code      TEXT,
          decline_message   TEXT,
          payment_id        TEXT REFERENCES payments(id) ON DELETE SET NULL,
          started_at        TEXT,
          completed_at      TEXT,
          sam_state         TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_terminal_tx_terminal
          ON terminal_transactions(terminal_id);
        CREATE INDEX IF NOT EXISTS idx_terminal_tx_order
          ON terminal_transactions(order_id) WHERE order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_terminal_tx_active
          ON terminal_transactions(tx_state)
          WHERE tx_state NOT IN ('IDLE', 'COMPLETED', 'DECLINED', 'CANCELLED');
      `)
    },
  },

  // FK-REPAIR-PAYMENTS-V2: Rebuild payments if order_id FK does not correctly reference orders(id).
  // The earlier FK-REPAIR-PAYMENTS only triggered on '_orders_old' in the schema text, but
  // the ORDER-LIFECYCLE ('picked_up') migration ran after it without PRAGMA foreign_keys = OFF,
  // causing SQLite to silently rewrite child FK references back to _orders_old on rename.
  // This migration is a catch-all: any payments.order_id FK that isn't REFERENCES orders(id)
  // (or the quoted variant) is repaired. Uses the full current payments schema (gift_card included).
  {
    description: 'Repair payments.order_id FK if it does not reference orders(id)',
    isNeeded: (db) => {
      const row = db.query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`
      ).get()
      if (!row) return false
      // Correct FK appears as either REFERENCES orders(id) or REFERENCES "orders"(id)
      return !row.sql.match(/REFERENCES\s+"?orders"?\(id\)/)
    },
    run: (db) => {
      db.exec(`PRAGMA foreign_keys = OFF`)
      db.exec(`PRAGMA legacy_alter_table = ON`)
      db.exec(`
        BEGIN;

        ALTER TABLE payments RENAME TO _payments_old;

        CREATE TABLE payments (
          id                         TEXT PRIMARY KEY,
          order_id                   TEXT NOT NULL REFERENCES orders(id),
          merchant_id                TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          payment_type               TEXT NOT NULL CHECK(payment_type IN ('card', 'cash', 'gift_card')),
          amount_cents               INTEGER NOT NULL,
          subtotal_cents             INTEGER NOT NULL DEFAULT 0,
          tax_cents                  INTEGER NOT NULL DEFAULT 0,
          tip_cents                  INTEGER NOT NULL DEFAULT 0,
          amex_surcharge_cents       INTEGER NOT NULL DEFAULT 0,
          gratuity_percent           REAL,
          card_type                  TEXT,
          card_last_four             TEXT,
          cardholder_name            TEXT,
          transaction_id             TEXT,
          processor                  TEXT,
          auth_code                  TEXT,
          finix_transfer_id          TEXT,
          signature_base64           TEXT,
          signature_captured_at      TEXT,
          split_mode                 TEXT,
          split_leg_number           INTEGER,
          split_total_legs           INTEGER,
          split_items_json           TEXT,
          receipt_printed            INTEGER NOT NULL DEFAULT 0,
          receipt_emailed            INTEGER NOT NULL DEFAULT 0,
          receipt_email              TEXT,
          gift_card_id               TEXT,
          gift_card_tax_offset_cents INTEGER NOT NULL DEFAULT 0,
          created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at               TEXT
        );

        INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email,
          gift_card_id, gift_card_tax_offset_cents,
          created_at, completed_at
        )
        SELECT
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name, transaction_id, processor,
          auth_code, finix_transfer_id, signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_printed, receipt_emailed, receipt_email,
          gift_card_id, gift_card_tax_offset_cents,
          created_at, completed_at
        FROM _payments_old;
        DROP TABLE _payments_old;

        CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_payments_type_merchant ON payments(merchant_id, payment_type);

        COMMIT;
      `)
      db.exec(`PRAGMA legacy_alter_table = OFF`)
      db.exec(`PRAGMA foreign_keys = ON`)
    },
  },
  {
    description: 'Add unique index on orders.clover_order_id (cannot use ADD COLUMN ... UNIQUE in SQLite)',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_clover_order_id'`
    ).get(),
    run: (db) => {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_clover_order_id ON orders(clover_order_id) WHERE clover_order_id IS NOT NULL`)
    },
  },
  // PERF-03: Standalone index on menu_item_modifier_groups.item_id for the
  // modifier batch join in the store menu endpoint. The composite PK
  // (item_id, group_id) exists but SQLite's planner may choose a full scan
  // over the multi-column PK index when filtering item_id IN (...).
  {
    description: 'Add idx_mimgs_item_id on menu_item_modifier_groups(item_id) for store modifier batch join',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mimgs_item_id'`
    ).get(),
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mimgs_item_id ON menu_item_modifier_groups (item_id)`)
    },
  },
  // PERF-04: Covering partial index for the online store menu item query.
  // Eliminates the post-index filter on is_available + available_online and
  // covers the ORDER BY sort_order, removing the filesort pass.
  // Partial index (WHERE is_available = 1 AND available_online = 1) keeps the
  // index small — only online-visible items are indexed.
  {
    description: 'Add idx_menu_items_store_filter covering partial index for online store menu hot path',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_menu_items_store_filter'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_menu_items_store_filter
          ON menu_items (merchant_id, is_available, available_online, sort_order)
          WHERE is_available = 1 AND available_online = 1
      `)
    },
  },
  // PERF-05: Composite index covering the "latest payment leg" query pattern:
  //   SELECT id FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
  // Called 2–3× per payment flow in dashboard-payments.ts. The existing
  // idx_payments_order covers the WHERE but not the sort; this index covers both,
  // eliminating the filesort on the (small) per-order result set.
  {
    description: 'Add idx_payments_order_created composite index on payments(order_id, created_at DESC)',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payments_order_created'`
    ).get(),
    run: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_order_created ON payments (order_id, created_at DESC)`)
    },
  },
  // PERF-06: Partial covering index for the auto-fire scheduled order background query.
  //   SELECT o.*, m.* FROM orders o JOIN merchants m ON m.id = o.merchant_id
  //   WHERE o.status IN ('submitted', 'received') AND o.pickup_time IS NOT NULL
  //     AND datetime(o.pickup_time, '-' || m.prep_time_minutes || ' minutes') <= datetime('now')
  // The datetime expression references a joined column so it cannot be indexed, but the
  // partial index eliminates the full status scan: only active orders with a pickup_time
  // are indexed. The planner uses (merchant_id, pickup_time) to narrow to due candidates
  // before evaluating the expression, replacing an O(all-non-terminal) scan.
  {
    description: 'Add idx_orders_active_pickup partial index for auto-fire scheduled order query',
    isNeeded: (db) => !db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orders_active_pickup'`
    ).get(),
    run: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_active_pickup
          ON orders (merchant_id, pickup_time)
          WHERE status IN ('submitted', 'received') AND pickup_time IS NOT NULL
      `)
    },
  },
]

async function migrate() {
  console.log('🔄 Running database migration...')

  const db = getDatabase()
  const isInitialized = isDatabaseInitialized()

  if (isInitialized) {
    const currentVersion = getSchemaVersion()
    console.log(`   Current schema version: ${currentVersion}`)
  } else {
    console.log('   Database not initialized, creating schema...')
  }

  // 1. Run schema.sql statement-by-statement so one "already exists" error
  //    doesn't abort the rest (SQLite exec() stops on first error).
  const schemaPath = join(import.meta.dir, 'schema.sql')
  const schemaSql = readFileSync(schemaPath, 'utf-8')

  // Strip comment-only lines, then split on semicolons
  const statements = schemaSql
    .replace(/--[^\n]*/g, '')   // remove all inline/line comments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  let created = 0
  let skipped = 0
  for (const stmt of statements) {
    try {
      db.exec(stmt)
      created++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('already exists')) {
        skipped++
      } else {
        console.error(`❌ Schema statement failed: ${stmt.slice(0, 80)}`)
        console.error(`   Error: ${msg}`)
        throw error
      }
    }
  }
  console.log(`   ✓ Schema applied (${created} executed, ${skipped} already existed)`)

  // 2. Run column migrations — ALTER TABLE for existing tables
  for (const m of columnMigrations) {
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`)
      console.log(`   ✓ ${m.description}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // "duplicate column name" = already exists, safe to skip
      // "no such table" = new table not yet created by schema.sql (also skip)
      if (msg.includes('duplicate column name') || msg.includes('no such table')) continue
      console.warn(`   ⚠ Column migration failed: ${m.description}`, error)
    }
  }

  // 3. Run table-rebuild migrations (CHECK constraint changes, etc.)
  for (const m of tableMigrations) {
    try {
      if (!m.isNeeded(db)) continue
      m.run(db)
      console.log(`   ✓ ${m.description}`)
    } catch (error) {
      console.error(`❌ Table migration failed: ${m.description}`, error)
      throw error
    }
  }

  const newVersion = getSchemaVersion()

  console.log(`✅ Migration complete — schema ${newVersion}`)
}

// Run if executed directly
if (import.meta.main) {
  try {
    await migrate()
    process.exit(0)
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  }
}

export { migrate }
