# Appliance Architecture

Detailed description of the Merchant Appliance runtime design, startup sequence, and request lifecycle.

## Startup Sequence

```
bun run dev / bun run start
        │
        ▼
server.ts
  1. Load and validate environment variables
  2. Open SQLite database (WAL mode, busy_timeout = 5000 ms)
  3. Run forward-only column migrations (columnMigrations in db/migrate.ts)
  4. Verify file integrity (production only — Ed25519 signature check)
  5. Derive master encryption key from MASTER_KEY_PASSPHRASE + hardware UUID
  6. Register Hono middleware (CORS, rate limiter, IP allowlist, auth)
  7. Mount route handlers
  8. Start background services:
        ├── SSE broadcast hub
        ├── auto-fire scheduler
        ├── auto-reset-oos scheduler
        ├── auto-backup scheduler
        ├── daily-closeout scheduler
        └── Finix reconciliation loop
  9. Start HTTP server (HOSTNAME:PORT)
 10. (Optional) spawn cloudflared subprocess if CLOUDFLARE_TUNNEL_TOKEN is set
```

## Request Lifecycle

```
HTTP Request
     │
     ▼
[CORS middleware]            — sets Access-Control-* headers
     │
     ▼
[Rate limiter]               — per-IP sliding window (configurable limits)
     │
     ▼
[IP allowlist] (optional)    — drops requests not in ALLOWED_IPS
     │
     ▼
[Auth middleware]            — validates JWT for /api/merchants/* routes
     │                         populates ctx.var.user
     ▼
[Route handler]              — business logic, DB queries
     │
     ▼
[Response]                   — JSON or HTML
```

## Database Design Principles

- **Single writer**: SQLite WAL mode serialises writes; all writes go through `src/db/index.ts`.
- **Forward-only migrations**: No rollback scripts — each migration function is idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). The current schema version is stored in the `schema_version` table.
- **Soft deletes**: Audit-sensitive tables (`fog`, `webhook_events`) use `deleted_at` timestamps; rows are never hard-deleted.
- **Encrypted columns**: `api_keys.encrypted_secret` and `api_keys.encrypted_dek` store AES-256-GCM ciphertext. See [security-cryptography.md](./security-cryptography.md).

## Background Services

| Service | Trigger | Purpose |
|---|---|---|
| `auto-fire.ts` | Per-order timer set at order creation | Fires course-2 kitchen ticket after configured delay |
| `auto-reset-oos.ts` | Cron — midnight in merchant timezone | Resets `out_of_stock_today` flags on all menu items |
| `auto-backup.ts` | Cron — configurable interval | Writes JSON snapshot of orders + menu to `data/backups/` |
| `daily-closeout.ts` | Cron — 30-min polling loop | Sends nightly EOD email + morning reservation briefing |
| `reconcile.ts` | Cron — every 10 minutes | Fetches Finix transfer status for unmatched card payments |

## State Management — SAM Pattern

Order workflow state is managed using the **SAM (State-Action-Model) pattern** via `sam-pattern` and `sam-fsm`.

```
Action (intent)
    │
    ▼
Model (propose → accept)     — validates transition, updates SQLite
    │
    ▼
State (compute next state)   — derives allowed actions from current state
    │
    ▼
NAP (next-action predicate)  — automatically fires follow-on actions
                               e.g. print kitchen ticket after 'paid'
```

Workflow definitions live in `src/workflows/`. Each workflow exports an `Action`, `Model`, and `State` triple. The SAM state for in-flight orders is persisted in the `sam_state` table so it survives server restarts.

## Printer Architecture

The appliance supports five printer protocols:

| Protocol | Transport | Driver |
|---|---|---|
| `star-line` | TCP port 9100 | `src/services/printer.ts` |
| `star-line-tsp100` | TCP port 9100 | `src/services/printer.ts` (variant) |
| `generic-escpos` | TCP port 9100 | `src/services/printer.ts` |
| `star-graphic` | TCP port 9100 | `src/services/star-raster.ts` (receiptline → bitmap) |
| `webprnt` | HTTP port 80 | `src/services/webprnt.ts` (falls back to star-graphic on 405) |

Receipt rendering is selected by the merchant's `receipt_style` column:

- `classic` — Text-mode markup rendered by `star-raster.ts`
- `html` — Puppeteer renders an HTML template → `sharp` converts to 1-bit raster → sent via `star-graphic` or `webprnt`

## Real-Time Updates (SSE)

The dashboard subscribes to `GET /api/merchants/:id/events?token=<jwt>`. The server keeps an in-memory map of active SSE connections per merchant (in `src/services/sse.ts`). When an order changes state, the route handler calls `sseHub.broadcast(merchantId, event)`.

SSE is used in preference to WebSockets for dashboard updates because it works through HTTP/2 multiplexing and Cloudflare Tunnel without any special configuration.

## WebSocket — Counter App

The Kizo Counter Android app connects via WebSocket to `GET /counter?token=<token>`. This is a separate connection from the SSE stream and uses a short-lived token issued by `GET /api/merchants/:id/counter/token`. The server maintains at most one active Counter connection per merchant.
