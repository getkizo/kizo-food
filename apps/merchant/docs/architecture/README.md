# Merchant Appliance — Architecture

ARM cluster appliance (Bun + Hono + SQLite) that bridges customers and merchant POS systems.

## Table of Contents

- [Overview](#overview)
- [Three-Tier Design](#three-tier-design)
- [Technology Stack](#technology-stack)
- [Module Structure](#module-structure)
- [Security Architecture](#security-architecture)
- [Data Flow](#data-flow)
- [Deployment](#deployment)

## Overview

The Merchant Appliance is a self-contained HTTP server designed to run on cheap ARM hardware (Raspberry Pi 4/5, Orange Pi 5) inside the merchant's premises. It exposes:

- A customer-facing **Store PWA** (`/`) for ordering, reservations, and gift cards
- A staff **Dashboard** (`/merchant`) for order management, reporting, and configuration
- A **REST API** (`/api/*`) consumed by both frontends and external integrations
- An **event stream** (`/api/merchants/:id/events`) for real-time dashboard updates via SSE

The appliance talks outward to payment providers (Converge, Finix, Stax), POS systems (Clover), and optionally an S3 bucket for backups. Inbound internet traffic arrives through a **Cloudflare Tunnel** — no port forwarding required.

## Three-Tier Design

```
[Customer Browser / Mobile]
        │ HTTPS via Cloudflare Tunnel
        ▼
[Merchant Appliance — Bun/Hono]          ← this codebase
  ├── Store PWA (public/)
  ├── Dashboard PWA (public/merchant/)
  ├── REST API (src/routes/)
  ├── SSE broadcast (src/services/sse.ts)
  └── Background services (src/services/)
        │
        ▼
[SQLite — WAL mode]                      ← local on-device database
        │
        ▼
[External APIs]
  ├── Converge / Finix / Stax            ← payment processing
  ├── Clover POS                         ← menu sync, order push
  ├── S3 (optional)                      ← encrypted backups
  └── SMTP (optional)                    ← receipts, EOD reports
```

## Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Bun 1.x** | Native SQLite, fast startup, single binary deployment |
| Framework | **Hono 4.x** (14 KB) | Edge-ready, typed routing, minimal overhead |
| Database | **SQLite (WAL mode)** | Zero-dependency, embedded, survives power loss |
| State machine | **SAM Pattern** (`sam-pattern` + `sam-fsm`) | Predictable order workflow transitions |
| Cryptography | **@noble/ed25519**, **AES-256-GCM** | Auditable, zero native deps |
| Rendering | **Puppeteer-core + sharp** | HTML → raster receipts for thermal printers |

See [ADR-004: Bun + SQLite Appliance](./ADRs/ADR-004-bun-sqlite-appliance.md) for the full rationale.

## Module Structure

```
src/
├── adapters/          # POS adapters — Clover, Manual (no-POS)
├── crypto/            # Envelope encryption, Ed25519 signing, API key vault
├── db/                # SQLite connection, schema, forward-only migrations
├── middleware/        # Auth (JWT), rate limiting, IP allowlist
├── routes/            # Hono route handlers grouped by domain
├── services/          # Background services
│   ├── printer.ts          # Star Line / ESC/POS TCP driver
│   ├── star-raster.ts      # receiptline → Star Graphic raster
│   ├── webprnt.ts          # Star WebPRNT HTTP driver
│   ├── html-receipt.ts     # Puppeteer HTML → 1-bit raster
│   ├── sse.ts              # SSE broadcast hub
│   ├── push.ts             # Web Push (VAPID)
│   ├── auto-fire.ts        # Delayed course-2 kitchen ticket fire
│   ├── auto-reset-oos.ts   # Midnight out-of-stock flag reset
│   ├── auto-backup.ts      # Scheduled JSON snapshot backup
│   ├── daily-closeout.ts   # Nightly EOD report + morning reservation briefing
│   ├── reconcile.ts        # Finix transfer reconciliation
│   ├── smtp.ts             # SMTP transport factory
│   └── printer-discovery.ts # LAN mDNS + port-scan discovery
├── utils/             # ID generation, validation helpers
├── workflows/         # SAM pattern workflows (order relay, POS sync, auto-update)
└── server.ts          # Entry point — registers middleware, mounts routes, starts services
```

## Security Architecture

See [security-cryptography.md](./security-cryptography.md) for full details.

Summary:

| Mechanism | Purpose |
|---|---|
| **Envelope encryption** (scrypt + AES-256-GCM) | All POS/payment API keys at rest |
| **Ed25519 code signing** | Tamper detection for production builds |
| **Hardware binding** | Master key derived from CPU serial + operator passphrase |
| **File integrity** | SHA-256 snapshots verified on startup |
| **JWT (HS256)** | Dashboard session tokens — 15-min access, 7-day refresh |
| **IP allowlist middleware** | Optional; restricts dashboard to known IPs |
| **Rate limiting** | Login and sensitive endpoints throttled per-IP |

See also:
- [ADR-005: Envelope Encryption](./ADRs/ADR-005-envelope-encryption.md)
- [ADR-006: Ed25519 Code Signing](./ADRs/ADR-006-ed25519-code-signing.md)

## Data Flow

### Customer order (card payment)

```
1. Customer POSTs /api/store/orders            → order created (status: pending)
2. Customer POSTs /api/store/orders/:id/pay    → appliance creates provider checkout URL
3. Customer redirected to Converge / Finix hosted page
4. Provider redirects back to /payment/*/return
5. Appliance records payment, advances order to 'paid'
6. SAM workflow fires kitchen ticket to printer
7. Dashboard receives live update via SSE
8. (Optional) Clover adapter pushes order to POS terminal
```

### In-person payment (PAX terminal)

```
1. Staff opens order in dashboard → clicks "Review & Pay"
2. Dashboard POSTs /api/merchants/:id/counter/request-payment
3. Appliance sends payment_request over WebSocket to Counter Android app
4. Customer taps card on PAX A920 Pro
5. Counter app POSTs result back via WebSocket
6. Appliance records payment, dashboard polls /counter/payment-status
```

## Deployment

### Prerequisites

- Raspberry Pi 4/5, Orange Pi 5, or any x64 Linux host
- Bun >= 1.0.0
- Chromium (only needed for HTML receipt style): `sudo apt install -y chromium-browser`

### Install

```bash
# 1. Extract release archive
tar -xzf merchant-v2.x.x.tar.gz -C /opt/kizo

# 2. Install dependencies
cd /opt/kizo && bun install

# 3. Configure environment
cp .env.example .env
nano .env   # set MASTER_KEY_PASSPHRASE, JWT_SECRET, and payment credentials

# 4. Run database migrations
bun run db:migrate

# 5. Install and start systemd service
cp systemd/kizo-register.service /etc/systemd/system/
systemctl enable --now kizo-register
```

### Cloudflare Tunnel

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Create and route tunnel
cloudflared tunnel login
cloudflared tunnel create merchant-cluster-001
cloudflared tunnel route dns merchant-cluster-001 merchants.kizo.app

# Install as systemd service
cp systemd/cloudflared.service /etc/systemd/system/
systemctl enable --now cloudflared
```

### Updates

```bash
# Pull latest release, re-run migrations, restart service
tar -xzf merchant-v2.x.x.tar.gz -C /opt/kizo
cd /opt/kizo && bun install && bun run db:migrate
systemctl restart kizo-register
```

### Monitoring

```bash
# Live logs
journalctl -u kizo-register -f

# Service status
systemctl status kizo-register

# Health check
curl http://localhost:3000/health
```
