# Merchant Appliance v2

ARM cluster appliance bridging customers and merchant POS systems.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0.0
- ARM device (Raspberry Pi 4/5, Orange Pi 5) or x64 for development

### Installation

```bash
# 1. Install dependencies
bun install

# 2. Copy environment file
cp .env.example .env

# 3. Edit .env and set required variables (see Environment Variables below)
nano .env

# 4. Initialize database
bun run db:migrate

# 5. Start server
bun run dev
```

Server will be available at `http://localhost:3000`

## Project Structure

```
v2/
├── src/
│   ├── adapters/        # POS adapters (Clover, Manual/no-POS)
│   ├── crypto/          # Cryptography (master key, DEK, API keys, code signing)
│   ├── db/              # SQLite connection, schema, migrations
│   ├── middleware/      # Hono middleware (auth, rate limiting, IP allowlist)
│   ├── routes/          # HTTP route handlers
│   ├── services/        # Background services and print drivers
│   │   ├── printer.ts        # Star Line / ESC/POS TCP print driver
│   │   ├── star-raster.ts    # Star Graphic raster renderer (receiptline)
│   │   ├── webprnt.ts        # Star WebPRNT HTTP print driver
│   │   ├── html-receipt.ts   # Puppeteer HTML → raster renderer
│   │   ├── sse.ts            # Server-Sent Events broadcast (dashboard live updates)
│   │   ├── push.ts           # Web Push notifications (VAPID)
│   │   ├── auto-fire.ts      # Delayed course-2 kitchen ticket auto-fire
│   │   ├── auto-reset-oos.ts # Midnight reset of "out today" stock flags
│   │   ├── auto-backup.ts    # Scheduled JSON snapshot backup
│   │   ├── daily-closeout.ts # Nightly EOD report + morning reservation briefing email
│   │   ├── reconcile.ts      # Background Finix transfer reconciliation (card payments)
│   │   ├── smtp.ts           # SMTP transport factory (Gmail, Outlook, Yahoo, SendGrid)
│   │   └── printer-discovery.ts  # LAN printer discovery
│   ├── utils/           # Utilities (ID generation, validation, etc.)
│   ├── workflows/       # SAM pattern workflows (order relay, POS sync, auto-update)
│   └── server.ts        # Main server entry point
├── test/                # Unit and integration tests
├── build/               # Build scripts (code signing, release packaging)
├── data/                # SQLite database and JSONL archives
├── systemd/             # Systemd service files
├── package.json
└── README.md
```

## Architecture

See [docs/architecture/README.md](../docs/architecture/README.md) for complete architecture documentation.

### Technology Stack

- **Runtime**: Bun 1.x
- **Framework**: Hono 4.x (14KB)
- **Database**: SQLite (bun:sqlite) in WAL mode — schema version tracked in `schema_version` table
- **State Management**: SAM Pattern (sam-pattern + sam-fsm)
- **Cryptography**: @noble/ed25519, AES-256-GCM envelope encryption

### Security Features

- **Envelope Encryption**: API keys encrypted with scrypt-derived master key + AES-256-GCM
- **Code Signing**: Ed25519 signatures for tamper detection
- **Hardware Binding**: Master key derived from CPU serial + passphrase
- **File Integrity**: SHA256 snapshots, periodic verification
- **Audit Logging**: All API key access logged

## API Endpoints

### Public — Customer Store (no auth)

```
GET  /                                        # Customer store PWA (HTML)
GET  /health                                  # Health check (JSON)
GET  /api/store/profile                       # Merchant branding + hours
GET  /api/store/menu                          # Full menu with modifiers
POST /api/store/orders                        # Place order (pre-payment)
POST /api/store/orders/:id/pay               # Get Converge or Finix payment URL
POST /api/store/orders/:id/payment-result    # Record payment result after redirect
GET  /api/store/orders/:id/status            # Order status (polling fallback)
POST /api/store/push/subscribe               # Customer push notification subscription

# Reservations (customer-facing, no auth)
GET  /api/store/reservations/config          # Reservation widget config (hours, party-size limits)
GET  /api/store/reservations/slots           # Available time slots for a given date
POST /api/store/reservations                 # Submit reservation request
DELETE /api/store/reservations/:id           # Cancel reservation (by confirmation token)
```

### Authenticated — Dashboard (JWT required)

```
# Merchant profile
GET    /api/merchants/check-slug             # Check slug availability (pre-auth, used during onboarding)
GET    /api/merchants/:id                    # Fetch merchant profile
PUT    /api/merchants/:id                    # Update merchant profile
POST   /api/merchants/:id/images             # Upload menu item image
DELETE /api/merchants/:id/images/:filename   # Delete image
GET    /api/merchants/:id/feedback           # List customer feedback/reviews (type, date filters)
GET    /api/merchants/:id/printers/status    # Probe TCP port 9100 on configured IPs — online/offline
GET    /api/merchants/:id/printers/discover  # LAN scan (mDNS + subnet) for Star printers
GET    /api/merchants/:id/local-ips          # Non-loopback IPv4 addresses on server's NICs (for SSH setup)

# API key management
POST   /api/merchants/:id/keys               # Store POS/payment API key (encrypted)
DELETE /api/merchants/:id/keys               # Delete API key

# Menu management
GET    /api/merchants/:id/menu               # Fetch menu
POST   /api/merchants/:id/menu/sync          # Import menu from POS provider
POST   /api/merchants/:id/menu/items         # Create locally-managed item
PUT    /api/merchants/:id/menu/items/:itemId # Update item metadata and price
PUT    /api/merchants/:id/menu/items/:itemId/image  # Set item image URL

# Order management (dashboard)
GET    /api/merchants/:id/orders                          # List orders with filters (date, status)
POST   /api/merchants/:id/orders                          # Create walk-in / phone / dine-in order
GET    /api/merchants/:id/orders/:orderId/detail          # Full order with payments breakdown (used by payment modal)
PATCH  /api/merchants/:id/orders/:orderId                 # Update order (items, quantities, notes)
DELETE /api/merchants/:id/orders/:orderId                 # Cancel / delete order
PATCH  /api/merchants/:id/orders/:orderId/status          # Advance order status
POST   /api/merchants/:id/orders/:orderId/lock            # Acquire edit lock
DELETE /api/merchants/:id/orders/:orderId/lock            # Release edit lock
POST   /api/merchants/:id/orders/:orderId/reprint         # Re-fire kitchen ticket
POST   /api/merchants/:id/orders/:orderId/print-bill      # Print pre-payment customer bill
POST   /api/merchants/:id/orders/:orderId/print-receipt   # Print post-payment customer receipt
PATCH  /api/merchants/:id/orders/:orderId/discount        # Apply named discount to order
PATCH  /api/merchants/:id/orders/:orderId/service-charge  # Apply service charge to order
POST   /api/merchants/:id/orders/:orderId/push-to-clover  # Manually push order to Clover terminal
GET    /api/merchants/:id/orders/active-tables            # Table occupancy grid
POST   /api/merchants/:id/orders/sync                     # Pull orders from Clover POS

# Real-time events
GET    /api/merchants/:id/events?token=<jwt> # SSE stream for live order updates

# Reporting
GET    /api/merchants/:id/reports/sales      # Sales summary by date range
GET    /api/merchants/:id/reports/shifts     # Employee shifts breakdown
GET    /api/merchants/:id/reports/tips       # Tips breakdown by employee and date range

# Payments (in-person)
GET    /api/merchants/:id/payments/config                  # Which providers are configured (boolean flags)
POST   /api/merchants/:id/orders/:orderId/record-payment   # Record cash/card payment leg
POST   /api/merchants/:id/orders/:orderId/phone-charge     # Card-not-present charge via Finix.js token (CNP)
POST   /api/merchants/:id/payments/:paymentId/receipt      # Send email receipt after payment
POST   /api/merchants/:id/orders/:orderId/link-transfer    # Manually link existing Finix transfer to order
GET    /api/merchants/:id/payments/reconciliation          # List payments with Finix reconciliation status
POST   /api/merchants/:id/payments/reconcile-pending       # Re-trigger reconciliation for unmatched card payments
GET    /api/payments/server-ip                             # Appliance public IP (for Converge allowlist config)

# Payment — Converge hosted-page flow
POST   /api/merchants/:id/payments/converge/session        # Generate Converge hosted-payment session URL
GET    /payment/converge/return                            # Browser redirect return after Converge payment (GET)
POST   /payment/converge/return                            # Browser redirect return after Converge payment (POST form)

# Payment — Finix redirect flow
POST   /api/merchants/:id/payments/finix/checkout          # Create Finix checkout form URL (non-terminal)
GET    /payment/finix/return                               # Browser redirect return after Finix payment

# Refunds
POST   /api/merchants/:id/orders/:orderId/refunds  # Initiate refund (Finix/Converge/cash)

# Employees and timesheets
GET    /api/merchants/:id/employees                         # List employees
POST   /api/merchants/:id/employees                         # Create employee
PUT    /api/merchants/:id/employees/:empId                  # Update employee
DELETE /api/merchants/:id/employees/:empId                  # Delete employee
POST   /api/merchants/:id/employees/authenticate            # Verify 4-digit PIN
POST   /api/merchants/:id/employees/:empId/clock-in         # Record clock-in
POST   /api/merchants/:id/employees/:empId/clock-out        # Record clock-out
GET    /api/merchants/:id/employees/:empId/sales            # Sales totals for today + 14-day rolling window
GET    /api/merchants/:id/timesheets                        # List timesheets for date range

# Business hours and scheduled closures
GET    /api/merchants/:id/hours                             # Fetch regular + catering hours
PUT    /api/merchants/:id/hours                             # Replace slots for a service type
DELETE /api/merchants/:id/hours/:day                        # Clear one day for a service type
GET    /api/merchants/:id/closures                          # List scheduled closures
POST   /api/merchants/:id/closures                          # Create a closure
PUT    /api/merchants/:id/closures/:closureId               # Update a closure
DELETE /api/merchants/:id/closures/:closureId               # Delete a closure

# Menu — categories and modifier groups
POST   /api/merchants/:id/menu/categories                          # Create category
PUT    /api/merchants/:id/menu/categories/:catId                   # Update category
DELETE /api/merchants/:id/menu/categories/:catId                   # Delete category
DELETE /api/merchants/:id/menu/items/:itemId                       # Delete item
POST   /api/merchants/:id/menu/items/:itemId/modifier-groups       # Create modifier group on item
PUT    /api/merchants/:id/menu/modifier-groups/:groupId            # Update modifier group
DELETE /api/merchants/:id/menu/modifier-groups/:groupId            # Delete modifier group
PUT    /api/merchants/:id/menu/modifier-groups/:groupId/items      # Reassign items to modifier group
POST   /api/merchants/:id/menu/modifier-groups/:groupId/modifiers  # Add modifier
PATCH  /api/merchants/:id/menu/modifier-groups/:groupId/modifiers/:modId  # Update modifier
DELETE /api/merchants/:id/menu/modifier-groups/:groupId/modifiers/:modId  # Delete modifier

# Backup, restore, and S3 archiving
GET    /api/merchants/:id/backup                 # Download backup (type: menu|orders|employees|profile|full)
POST   /api/merchants/:id/restore                # Restore from backup JSON
POST   /api/merchants/:id/wipe                   # Destructive reset (requires confirm: true)
GET    /api/merchants/:id/s3-config              # S3 config status (credentials never returned)
PUT    /api/merchants/:id/s3-config              # Save encrypted S3 credentials
DELETE /api/merchants/:id/s3-config              # Remove S3 credentials
POST   /api/merchants/:id/s3-backup/trigger      # Trigger manual S3 backup
POST   /api/merchants/:id/restore/s3             # Download backup from S3 and restore

# Terminals (payment terminals registered per merchant)
GET    /api/merchants/:id/terminals              # List terminals
POST   /api/merchants/:id/terminals              # Register a terminal
PUT    /api/merchants/:id/terminals/:terminalId  # Update terminal name / settings
DELETE /api/merchants/:id/terminals/:terminalId  # Remove terminal

# Counter WebSocket (Kizo Counter Android app)
GET    /counter?token=<token>                    # WebSocket — Counter app connects here (WS upgrade)
GET    /api/merchants/:id/counter/status         # Current connection + device status
GET    /api/merchants/:id/counter/token          # WS bearer token for Android app setup
POST   /api/merchants/:id/counter/request-payment   # Send payment_request to counter app
POST   /api/merchants/:id/counter/cancel-payment    # Send cancel_payment to counter app
GET    /api/merchants/:id/counter/payment-status    # Poll for payment result (payment modal)

# FOG compliance (City-required grease trap + exhaust hood cleaning log)
POST   /api/merchants/:id/fog                    # Add grease trap cleaning entry
GET    /api/merchants/:id/fog                    # List grease trap entries
DELETE /api/merchants/:id/fog/:entryId           # Soft-delete entry (owner only — audit trail preserved)
POST   /api/merchants/:id/fog/hood               # Add exhaust hood cleaning entry
GET    /api/merchants/:id/fog/hood               # List hood cleaning entries
DELETE /api/merchants/:id/fog/hood/:entryId      # Soft-delete hood entry (owner only)
GET    /fog-report                               # Public HTML compliance report

# Gift Cards — customer-facing (no auth)
POST /api/store/gift-cards/purchase                      # Create gift card purchase record
POST /api/store/gift-cards/purchases/:id/pay             # Get payment URL (Converge or Finix)
POST /api/store/gift-cards/purchases/:id/payment-result  # Confirm payment + issue cards + send email
GET  /api/store/gift-cards/purchases/:id                 # Get purchase status and issued card codes

# Gift Cards — dashboard (authenticated)
GET    /api/merchants/:id/gift-cards                         # List cards with status / search / pagination
GET    /api/merchants/:id/gift-cards/lookup                  # Look up active card by code suffix (for payment)
POST   /api/merchants/:id/gift-cards/:cardId/print-receipt   # Reprint gift card receipt
GET    /api/merchants/:id/gift-card-purchases                # List purchase records
GET    /api/merchants/:id/gift-card-purchases/:purchaseId    # Get purchase detail

# Webhook secret (generic HMAC signing)
GET    /api/merchants/:id/webhook/secret/status              # Check whether a shared secret is configured
POST   /api/merchants/:id/webhook/secret                     # Store HMAC shared secret (AES-256-GCM encrypted)
DELETE /api/merchants/:id/webhook/secret                     # Remove shared secret

# Payment failure notifications (dashboard banner)
GET    /api/merchants/:id/payment-notifications              # List unread Stax/Converge failure events
PATCH  /api/merchants/:id/payment-notifications/:eventId/dismiss  # Mark notification as read
```

### Inbound Webhooks (HMAC-authenticated, not JWT)

```
POST /webhooks/generic/:merchantId          # Generic HMAC-signed event (shared secret required)
POST /webhooks/stax/:merchantId             # Stax/Fattmerchant payment notification
POST /api/merchants/:id/webhooks/clover     # Clover payment webhook (Phase 2 stub — stores event, returns 200)
```

Inbound webhook payloads are stored in the `webhook_events` table. Payment failure events surface
in the dashboard via `GET /api/merchants/:id/payment-notifications`. The generic webhook uses an
HMAC-SHA256 `X-Signature` header verified against the secret stored via `POST .../webhook/secret`.

### Auth

```
POST /api/auth/register    # Register merchant account
POST /api/auth/login       # Login (returns access + refresh tokens)
POST /api/auth/refresh     # Refresh access token
POST /api/auth/logout      # Logout (invalidate refresh token)
GET  /api/auth/me          # Current user profile
GET  /api/auth/oauth/google           # Initiate Google OAuth
GET  /api/auth/oauth/google/callback  # Google OAuth callback

# Passkeys / WebAuthn (FIDO2 — Touch ID, Face ID, Windows Hello, security keys)
POST   /api/auth/webauthn/register/options        # Start passkey registration (authenticated)
POST   /api/auth/webauthn/register/verify         # Verify authenticator response + store credential
POST   /api/auth/webauthn/authenticate/options    # Start passkey login (returns challenge)
POST   /api/auth/webauthn/authenticate/verify     # Verify signature + issue JWT
GET    /api/auth/webauthn/credentials             # List registered passkeys (authenticated)
DELETE /api/auth/webauthn/credentials/:id         # Remove a passkey (authenticated)
```

## Development

### Run tests

```bash
# All tests
bun test

# Single file
bun test v2/test/auth.test.ts

# Watch mode
bun run test:watch
```

### Database migrations

```bash
# Apply migrations (idempotent — safe to run multiple times)
bun run db:migrate
```

Migrations are applied automatically on startup via `columnMigrations` in `src/db/migrate.ts`.
The current schema version is tracked in the `schema_version` table; there is no rollback — forward-only migrations only.

### Payment Terminal Emulator (PAX A920 Pro)

The emulator lets you test the full card-present payment flow — from tapping "Review & Pay" in the dashboard through polling and receipt — without a physical terminal.

It runs two servers in a single process:

| Server | Port | Purpose |
|---|---|---|
| Finix API mock | 9333 | Receives all Finix terminal API calls from the server |
| Control UI | 9334 | Browser interface to simulate customer tap (Approve / Decline) |

**Start the emulator:**

```bash
bun run emulator:a920
```

**Start the server pointing at the emulator:**

```bash
FINIX_EMULATOR_URL=http://127.0.0.1:9333 bun run dev
```

**Register the emulated terminal in the dashboard:**

1. Go to **Store Profile → Terminal Settings**.
2. Make sure **Finix Sandbox mode** is enabled (the emulator option only appears when sandbox is on).
3. Click **Add Terminal**, select **Pax A920 Pro (Emulator)**, give it a nickname — no serial number needed.
4. The device ID `DEemulatora920001` is set automatically.

**Process a test payment:**

1. Open the order in the dashboard and click **💳 Review & Pay**.
2. Select **Card**, then **Terminal**, then confirm.
3. Open `http://127.0.0.1:9334` in a browser — the pending charge appears.
4. Click **Approve** or **Decline** to simulate the customer's tap.

**Behaviors faithfully emulated:**

- `POST /transfers` — creates a PENDING transfer and pushes it to the Control UI
- `GET /transfers/:id` — returns PENDING until you click; resolves to SUCCEEDED or FAILED
- `PUT /devices/:id CANCEL` — cancels the transfer; if Approve was already clicked, returns SUCCEEDED (tap-beat-cancel race condition)
- `GET /devices/:id` — returns `connection: 'Open'` (matches real Finix API value)
- `GET /merchants/:id/devices` — returns the emulated device in the device list
- Idempotency — duplicate idempotency key with a cancelled transfer returns 422 (`FinixTransferCancelledError` format)

**Interaction logging:**

Every state transition is written to the `payment_events` table:

```sql
-- Post-mortem for a specific order
SELECT * FROM payment_events
WHERE event_type LIKE 'terminal_%' AND order_id = ?
ORDER BY created_at;
```

Raw Finix API calls are also logged to stdout as structured JSON (`[finix-api]` label), captured by systemd/pm2 alongside all other server logs.

### Code signing (production)

```bash
# Build and sign release
bun run build
bun run sign
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `NODE_ENV` | Environment (`development`/`production`) | No | `development` |
| `PORT` | Server port | No | `3000` |
| `HOSTNAME` | Bind address | No | `127.0.0.1` |
| `MASTER_KEY_PASSPHRASE` | Master key passphrase for API key encryption | Yes (production) | — |
| `DATABASE_PATH` | SQLite database file path | No | `./data/merchant.db` |
| `CORS_ORIGIN` | CORS allowed origin | No | `*` |
| `JWT_SECRET` | Secret for signing JWT tokens | Yes | — |
| `CONVERGE_VENDOR_ID` | Converge payment vendor ID | If using Converge | — |
| `CONVERGE_VENDOR_TOKEN` | Converge payment vendor token | If using Converge | — |
| `CONVERGE_TERMINAL_ID` | Converge terminal ID | If using Converge | — |
| `FINIX_MERCHANT_ID` | Finix merchant ID | If using Finix | — |
| `FINIX_USER` | Finix API username | If using Finix | — |
| `FINIX_PASSWORD` | Finix API password | If using Finix | — |
| `FINIX_EMULATOR_URL` | Base URL of the PAX A920 emulator Finix mock (e.g. `http://127.0.0.1:9333`). When set, all Finix terminal API calls are routed to the emulator instead of the real Finix API. Development only. | No | — |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | If using OAuth login | — |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | If using OAuth login | — |
| `CLOUDFLARE_TUNNEL_TOKEN` | Token for the `cloudflared` process that exposes the appliance via Cloudflare Tunnel. Get this from the Cloudflare Zero Trust dashboard after creating a tunnel. Only needed when running `cloudflared` in the same process/container as the server; if `cloudflared` is managed as a separate systemd service (the typical ARM setup), set it there instead. | Production deployment | — |
| `VAPID_PUBLIC_KEY` | VAPID public key for Web Push | If using push notifications | — |
| `VAPID_PRIVATE_KEY` | VAPID private key for Web Push | If using push notifications | — |
| `VAPID_SUBJECT` | VAPID subject (mailto: or URL) | If using push notifications | — |
| `APPLE_ID_CLIENT_ID` | Apple Sign-In service ID | If using Apple OAuth | — |
| `APPLE_ID_TEAM_ID` | Apple Developer team ID | If using Apple OAuth | — |
| `APPLE_ID_KEY_ID` | Apple Sign-In key ID | If using Apple OAuth | — |
| `APPLE_ID_PRIVATE_KEY` | Apple Sign-In private key (PEM) | If using Apple OAuth | — |
| `FACEBOOK_APP_ID` | Facebook app ID | If using Facebook OAuth | — |
| `FACEBOOK_APP_SECRET` | Facebook app secret | If using Facebook OAuth | — |
| `AWS_ACCESS_KEY_ID` | AWS access key for S3 backup | If using S3 backup | — |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key for S3 backup | If using S3 backup | — |
| `AWS_S3_BUCKET` | S3 bucket name for backups | If using S3 backup | — |
| `AWS_S3_REGION` | S3 bucket region | If using S3 backup | `us-east-1` |
| `DEBUG_PRINT_MARKUP` | Set to any non-empty value to log the first 40 bytes (hex) of every TCP print job to the console. Useful for diagnosing command-sequence issues with Star Line / ESC/POS printers. No effect on the HTML receipt renderer. | No | — |
| `SMTP_HOST` | SMTP host for outgoing email (daily closeout, reservations, gift card receipts) | If using email features | — |
| `SMTP_PORT` | SMTP port | If using email features | `587` |
| `SMTP_USER` | SMTP username / sender address | If using email features | — |
| `SMTP_PASS` | SMTP password or app-specific password | If using email features | — |

A server started without payment/OAuth/push/email variables will run normally but those features will fail at runtime.

## Deployment

### Raspberry Pi / ARM Device

See [docs/architecture/README.md#deployment](../docs/architecture/README.md#deployment) for full deployment instructions.

Quick deploy:

```bash
# 1. Install system dependencies (Chromium required for HTML receipt rendering)
sudo apt update
sudo apt install -y chromium-browser

# 2. Install Bun
curl -fsSL https://bun.sh/install | bash

# 3. Clone/copy release
tar -xzf merchant-v2.0.0.tar.gz -C /opt/kizo

# 4. Install Node dependencies
cd /opt/kizo && bun install

# 5. Install systemd service
cp systemd/kizo-register.service /etc/systemd/system/
systemctl enable kizo
systemctl start kizo
```

### Cloudflare Tunnel

```bash
# 1. Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 2. Create tunnel
cloudflared tunnel login
cloudflared tunnel create merchant-cluster-001
cloudflared tunnel route dns merchant-cluster-001 merchants.kizo.app

# 3. Install service
cp systemd/cloudflared.service /etc/systemd/system/
systemctl enable cloudflared
systemctl start cloudflared
```

## Reservation System

The reservation widget is a separate customer-facing page (`/reserve/`) designed for embedding in external websites (restaurant homepage, Google My Business, etc.).

- **Embed URL**: `https://<appliance-hostname>/reserve/` — set as the `src` of an `<iframe>` on the merchant's website
- **X-Frame-Options**: The `/reserve/` path is exempt from the `X-Frame-Options: DENY` header so it can be embedded. All other paths retain the default `DENY`.
- **Settings columns on `merchants`**: `reservation_enabled`, `reservation_max_party_size`, `reservation_slot_duration_min`, `reservation_advance_days`, `reservation_briefing_time` (HH:MM, default `07:30`)
- **Morning briefing**: `daily-closeout.ts` sends a daily email at `reservation_briefing_time` listing all confirmed reservations for the day (to the merchant's own SMTP address)

## Daily Closeout Service

`services/daily-closeout.ts` runs two scheduled tasks in the same 30-minute polling loop:

1. **Nightly EOD report** — sent at the merchant's configured closeout time; includes sales summary, tips, and shift data
2. **Morning reservation briefing** — sent at `reservation_briefing_time` (default 07:30); lists all confirmed reservations for the day with party size, contact, and notes

Both emails use the merchant's SMTP credentials (`smtp_provider`, `smtp_user`, `smtp_pass` columns) via `services/smtp.ts`.

## PWA Capabilities

The customer-facing store is a Progressive Web App (PWA). For a comprehensive reference on what modern PWAs can do across browsers and platforms, see **[What PWA Can Do Today](https://whatpwacando.today/)** by Danny Moerkerke — an interactive showcase of PWA APIs including push notifications, offline support, hardware access, and installation prompts.

## Printer Setup

### Supported Protocols

| Protocol key | Description | Typical hardware |
|---|---|---|
| `star-line` | Star Line Mode (text commands via TCP) | Star TSP700II |
| `star-line-tsp100` | Star Line Mode variant (different alignment/cut commands) | Star TSP100 III (factory default mode) |
| `generic-escpos` | True ESC/POS emulation mode or third-party ESC/POS printers | Star TSP100 III in ESC/POS mode; generic thermal printers |
| `star-graphic` | Star Graphic raster mode (bitmap via `receiptline`) | Star TSP143 III (no device font ROM) |
| `webprnt` | Star WebPRNT HTTP/XML; auto-falls back to `star-graphic` on 405 | Star TSP100 III with WebPRNT enabled |

> **Note:** The `esc-pos` protocol key was renamed to `star-line-tsp100` in a DB migration. Any merchant records using the old `esc-pos` key are automatically updated on startup. Use `star-line-tsp100` for the Star TSP100 III in its factory default Star Line mode, or `generic-escpos` for third-party ESC/POS printers.

The `receipt_style` column on `merchants` selects the ticket renderer:
- `classic` — text-mode markup via `star-raster.ts` / `printer.ts`
- `html` — Puppeteer HTML → sharp greyscale → 1-bit raster (requires Chromium, `star-graphic` or `webprnt` protocol only)

### Finding the Printer IP Address

All Star printers can print a self-test page that includes the current IP address.

**Star TSP100 III / TSP143 III / TSP700II:**
1. Hold the **FEED** button while powering on the printer.
2. Release when the printer begins printing.
3. The test page shows the IP address under the "Interface" section (e.g. `IP Address: 192.168.1.105`).

**Alternatively — router DHCP table:**
- Log in to your router admin UI (usually `192.168.1.1` or `192.168.0.1`).
- Look for a device named `StarMicronics`, `TSP100`, or similar in the DHCP client list.
- Assign a static lease to the printer's MAC address so the IP does not change across reboots.

**Using the built-in sniffer** (`printer-sniffer.ts`):
```bash
cd v2
bun run src/tools/printer-sniffer.ts
```
Scans common LAN subnets for devices listening on TCP port 9100 (Star Line / ESC/POS) and port 80 (WebPRNT).

Once you have the IP, enter it in the dashboard under **Store Profile → Printer Settings**.

### Enabling WebPRNT on the TSP100 III

WebPRNT is **not enabled by default**. Without it the printer returns HTTP 405 and the server automatically falls back to `star-graphic` raster mode, but enabling WebPRNT gives slightly faster throughput for text tickets.

1. Connect the printer to the same LAN as the appliance.
2. Open a browser and navigate to `http://<printer-ip>/` (default credentials: `root` / `public`).
3. Go to **Settings → WebPRNT** (or **Network → WebPRNT** depending on firmware version).
4. Set **WebPRNT** to **Enabled** and click **Submit**.
5. The printer restarts. Set the protocol in the dashboard to `webprnt`.

### Printer Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing prints, no error | Wrong IP address | Reprint self-test page; check router DHCP table |
| Nothing prints, no error (TSP143 III) | Protocol set to `star-line` or `star-line-tsp100` — device has no font ROM | Change protocol to `star-graphic` |
| Partial ticket, then cuts incorrectly | Wrong protocol variant (`star-line` vs `star-line-tsp100`) | `ESC d n` is a CUT on TSP700II but a FEED on TSP100 III; switch protocol key |
| Garbled characters / boxes | `ESC W` byte eaten by cascade | Ensure printer protocol is correct; switch to `star-graphic` raster as fallback |
| WebPRNT returns 405 | WebPRNT not enabled in printer firmware | See "Enabling WebPRNT" above; or leave protocol as `webprnt` to auto-fallback |
| HTML receipt prints blank | Puppeteer/Chromium not installed | Run `bun run install:chromium` or set `receipt_style = 'classic'` |
| HTML receipt has wrong font | Google Fonts CDN unreachable (offline/firewall) | Font falls back to Helvetica/Arial automatically |
| `DEBUG_PRINT_MARKUP` shows correct bytes but nothing prints | ASB handshake rejected by printer | The relevant code path may have `skipAsb: false`; set `skipAsb: true` for non-ASB printers |

See [docs/payment_modal.md](../docs/payment_modal.md) for in-person payment flow and split-payment documentation.

## Known Security Limitations

| ID | Description | Location |
|----|-------------|----------|
| ARC-4.3 | Clover webhook HMAC signature verification is not implemented — all incoming webhooks are accepted without checking the `X-Clover-Signature` header | `src/routes/webhooks.ts` |
| TD-2.5 | `GET /api/orders` (legacy route in `orders.ts`) performs no merchant ownership check — any authenticated user can list any merchant's orders if they know the endpoint. **Scheduled for removal** — all callers should migrate to `GET /api/merchants/:id/orders`. | `src/routes/orders.ts` |

## License

Proprietary — © 2026 Kizo Inc.

## Support

- Documentation: [docs/architecture/](../docs/architecture/)
- Issues: GitHub Issues
- Email: support@kizo.app
