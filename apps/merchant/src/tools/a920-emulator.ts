/**
 * PAX A920 Pro Emulator — Finix API mock / 9333 + Web Control UI / 9334
 *
 * Intercepts Finix terminal API calls so you can approve or decline payments
 * from your browser instead of needing a physical PAX terminal in development.
 *
 * Usage:
 *   FINIX_EMULATOR_URL=http://127.0.0.1:9333 bun run src/server.ts
 *   bun run src/tools/a920-emulator.ts   (in a second terminal)
 *   open http://127.0.0.1:9334
 *
 * When a payment request arrives from the dashboard, the emulator UI shows
 * the transaction. Click "Approve" or "Decline" to simulate the customer.
 *
 * Emulated Finix endpoints (port 9333 — identical to real API):
 *   POST   /transfers             createTerminalSale
 *   GET    /transfers/:id         getTerminalTransferStatus (poll)
 *   PUT    /devices/:id           cancelTerminalSale
 *   GET    /devices/:id           checkDeviceConnection
 *   GET    /merchants/:id/devices listDevices
 *
 * Control endpoints (port 9334 — web UI + REST):
 *   GET    /                      Web control UI
 *   GET    /events                SSE stream for live updates
 *   GET    /state                 Current emulator state (JSON)
 *   POST   /approve               Simulate customer tap/insert/swipe
 *   POST   /decline               Simulate decline with reason
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TransferState = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'

interface DeviceConfig {
  tippingEnabled: boolean
  percentOptions:  number[]
}

interface EmulatedTransfer {
  id:             string
  state:          TransferState
  amount:         number
  deviceId:       string
  idempotencyId:  string
  tags:           Record<string, string>
  // Populated on approval
  cardBrand:      string
  cardLastFour:   string
  approvalCode:   string
  entryMode:      string
  tipAmountCents: number   // 0 unless tip-on-terminal was active
  // Populated on decline
  failureCode:    string | null
  failureMessage: string | null
  // Timestamps
  createdAt:      string
  settledAt:      string | null
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const MAX_HISTORY   = 50
const _transfers    = new Map<string, EmulatedTransfer>()
const _idempotency  = new Map<string, string>()   // idempotencyId → transferId
const _deviceTx     = new Map<string, string>()   // deviceId → active transferId
const _deviceConfig = new Map<string, DeviceConfig>()  // deviceId → tipping config
const _history:      EmulatedTransfer[] = []
let   _txSeq       = 0

function nextTransferId(): string {
  return `TRemu${String(++_txSeq).padStart(18, '0')}`
}

// ---------------------------------------------------------------------------
// SSE broadcast (shared between API server and control UI)
// ---------------------------------------------------------------------------

const _sseClients = new Set<(data: string) => void>()

function broadcast(msg: unknown): void {
  const s = JSON.stringify(msg)
  for (const fn of _sseClients) {
    try { fn(s) } catch { _sseClients.delete(fn) }
  }
}

function broadcastState(): void {
  const pending      = getPendingTransfer()
  const deviceConfig = pending ? (_deviceConfig.get(pending.deviceId) ?? null) : null
  broadcast({ type: 'state', pending, history: _history.slice(0, 20), deviceConfig })
}

function getPendingTransfer(): EmulatedTransfer | null {
  for (const t of _transfers.values()) {
    if (t.state === 'PENDING') return t
  }
  return null
}

// ---------------------------------------------------------------------------
// Transfer lifecycle helpers
// ---------------------------------------------------------------------------

function settleTransfer(t: EmulatedTransfer, updates: Partial<EmulatedTransfer>): void {
  Object.assign(t, updates, { settledAt: new Date().toISOString() })
  _history.unshift({ ...t })
  if (_history.length > MAX_HISTORY) _history.pop()
  // Clear device→transfer mapping so new payments can come in
  for (const [deviceId, txId] of _deviceTx) {
    if (txId === t.id) { _deviceTx.delete(deviceId); break }
  }
  broadcastState()
}

/** Finix Transfer JSON shape — matches the real Finix API response */
function toJson(t: EmulatedTransfer): Record<string, unknown> {
  const cpd = t.state === 'SUCCEEDED'
    ? { brand: t.cardBrand, masked_account_number: `****${t.cardLastFour}`, approval_code: t.approvalCode, entry_mode: t.entryMode }
    : { brand: null, masked_account_number: null, approval_code: null, entry_mode: null }
  return {
    id:                   t.id,
    state:                t.state,
    amount:               t.amount,
    currency:             'USD',
    device:               t.deviceId,
    operation_key:        'CARD_PRESENT_DEBIT',
    failure_code:         t.failureCode,
    failure_message:      t.failureMessage,
    tags:                 t.tags,
    card_present_details: cpd,
    amount_breakdown:     { tip_amount: t.tipAmountCents },
    created_at:           t.createdAt,
    updated_at:           t.settledAt ?? t.createdAt,
  }
}

const DECLINE_MESSAGES: Record<string, string> = {
  CARD_DECLINED:       'The card was declined by the issuer',
  INSUFFICIENT_FUNDS:  'Insufficient funds in account',
  CARD_EXPIRED:        'The card has expired',
  INVALID_CARD_NUMBER: 'Invalid card number',
  LOST_OR_STOLEN_CARD: 'Card reported lost or stolen',
  DO_NOT_HONOR:        'Transaction not authorized by issuer',
  TECHNICAL_ERROR:     'Technical error processing transaction',
}

// ---------------------------------------------------------------------------
// Port 9333 — Finix API mock
// ---------------------------------------------------------------------------

const apiApp = new Hono()

/** POST /transfers — createTerminalSale */
apiApp.post('/transfers', async (c) => {
  const body          = await c.req.json() as Record<string, unknown>
  const amount        = (body.amount as number) ?? 0
  const deviceId      = (body.device as string) ?? 'unknown'
  const idempotencyId = (body.idempotency_id as string) ?? ''
  const tags          = (body.tags as Record<string, string>) ?? {}

  // Idempotency: same key = same outcome
  const existingId = _idempotency.get(idempotencyId)
  if (existingId) {
    const existing = _transfers.get(existingId)
    if (existing) {
      if (existing.state === 'PENDING' || existing.state === 'SUCCEEDED') {
        return c.json(toJson(existing), 200)
      }
      // Cancelled/failed idempotency key — return 422 so workflow retries with fresh key
      return c.json({
        _embedded: {
          errors: [{
            failure_code: existing.failureCode ?? 'CANCELLATION_VIA_API',
            transfer:     existing.id,
            message:      `Transfer ${existing.id} already settled as ${existing.state} (${existing.failureCode ?? 'n/a'})`,
          }],
        },
      }, 422)
    }
  }

  // Cancel any stale pending transfer on this device (one at a time)
  const prevId = _deviceTx.get(deviceId)
  if (prevId) {
    const prev = _transfers.get(prevId)
    if (prev?.state === 'PENDING') {
      settleTransfer(prev, {
        state:          'FAILED',
        failureCode:    'PREVIOUS_TRANSACTION_NOT_COMPLETED',
        failureMessage: 'A new transfer replaced this one',
      })
    }
  }

  const transfer: EmulatedTransfer = {
    id:             nextTransferId(),
    state:          'PENDING',
    amount,
    deviceId,
    idempotencyId,
    tags,
    cardBrand:      'VISA',
    cardLastFour:   '4242',
    approvalCode:   '',
    entryMode:      'TAP',
    tipAmountCents: 0,
    failureCode:    null,
    failureMessage: null,
    createdAt:      new Date().toISOString(),
    settledAt:      null,
  }

  _transfers.set(transfer.id, transfer)
  if (idempotencyId) _idempotency.set(idempotencyId, transfer.id)
  _deviceTx.set(deviceId, transfer.id)

  const orderRef = tags.order_id ?? tags.orderId ?? '?'
  console.log(`[a920-emulator] ⏳  New payment ${transfer.id}  $${(amount / 100).toFixed(2)}  order=${orderRef}  device=${deviceId}`)
  broadcastState()

  return c.json(toJson(transfer), 201)
})

/** GET /transfers/:id — poll transfer status */
apiApp.get('/transfers/:id', (c) => {
  const t = _transfers.get(c.req.param('id'))
  if (!t) return c.json({ error: 'Transfer not found' }, 404)
  return c.json(toJson(t))
})

/** PUT /devices/:id — tipping config update OR cancel */
apiApp.put('/devices/:id', async (c) => {
  const deviceId = c.req.param('id')
  const body     = await c.req.json() as Record<string, unknown>

  // ── Tipping config update: { configuration: { tipping_details: {...} | null } } ──
  if (body.configuration !== undefined) {
    const td = (body.configuration as Record<string, unknown>)?.tipping_details as Record<string, unknown> | null
    if (td === null) {
      _deviceConfig.delete(deviceId)
      console.log(`[a920-emulator] 🎯  Device ${deviceId}: tip-on-terminal DISABLED`)
    } else {
      const pcts = (td.percent_options as number[] | undefined) ?? [15, 20, 25]
      _deviceConfig.set(deviceId, { tippingEnabled: true, percentOptions: pcts })
      console.log(`[a920-emulator] 🎯  Device ${deviceId}: tip-on-terminal ENABLED  options=${JSON.stringify(pcts)}`)
    }
    broadcastState()
    return c.json({
      id:            deviceId,
      connection:    'Open',
      enabled:       true,
      name:          'PAX A920 Pro [Emulator]',
      model:         'A920Pro',
      serial_number: 'EMU-A920-001',
      configuration: { tipping_details: td ?? null },
    })
  }

  // ── Cancel active transfer ─────────────────────────────────────────────────
  if ((body.action as string) !== 'CANCEL') {
    return c.json({ error: 'Unknown action' }, 400)
  }

  const txId = _deviceTx.get(deviceId)
  if (!txId) {
    // No active transfer — return a synthetic FAILED response
    console.log(`[a920-emulator] ℹ️   Cancel on ${deviceId} — no active transfer, returning FAILED`)
    return c.json({
      id:              `TRemu_no_tx_${Date.now()}`,
      state:           'FAILED',
      amount:          0,
      device:          deviceId,
      failure_code:    'CANCELLATION_VIA_API',
      failure_message: 'No active transfer on device',
      card_present_details: { brand: null, masked_account_number: null, approval_code: null, entry_mode: null },
    })
  }

  const t = _transfers.get(txId)
  if (!t) return c.json({ error: 'Transfer not found' }, 404)

  if (t.state === 'SUCCEEDED') {
    // Tap beat the cancel → return SUCCEEDED so workflow honours the charge
    console.log(`[a920-emulator] ⚡  Cancel on ${deviceId} — transfer ${t.id} already SUCCEEDED (tap-beat-cancel)`)
    return c.json(toJson(t))
  }

  // Cancel the pending transfer
  if (t.state === 'PENDING') {
    settleTransfer(t, {
      state:          'FAILED',
      failureCode:    'CANCELLATION_VIA_API',
      failureMessage: 'The transaction was canceled via API',
    })
    console.log(`[a920-emulator] 🚫  Transfer ${t.id} cancelled via API`)
  }

  return c.json(toJson(t))
})

/** GET /devices/:id — device info + connection status */
apiApp.get('/devices/:id', (c) => {
  const deviceId = c.req.param('id')
  const config   = _deviceConfig.get(deviceId)
  return c.json({
    id:            deviceId,
    connection:    'Open',   // matches what checkDeviceConnection() expects from the real Finix API
    enabled:       true,
    name:          'PAX A920 Pro [Emulator]',
    model:         'A920Pro',
    serial_number: 'EMU-A920-001',
    configuration: config
      ? { tipping_details: { percent_options: config.percentOptions } }
      : { tipping_details: null },
  })
})

/** GET /merchants/:id/devices — device discovery */
apiApp.get('/merchants/:id/devices', (c) => {
  return c.json({
    _embedded: {
      devices: [{
        id:            'DEemulatora920001',
        serial_number: 'EMU-A920-001',
        model:         'A920Pro',
        enabled:       true,
        merchant:      c.req.param('id'),
        tags:          {},
      }],
    },
    page:        { limit: 1, next_cursor: null, previous_cursor: null },
    total_count: 1,
  })
})

Bun.serve({ fetch: apiApp.fetch, port: 9333, hostname: '127.0.0.1' })

// ---------------------------------------------------------------------------
// Port 9334 — Web control UI server
// ---------------------------------------------------------------------------

const uiApp = new Hono()

uiApp.get('/', c => c.html(UI_HTML))

uiApp.get('/events', c =>
  streamSSE(c, async stream => {
    let done = false
    const push = (data: string) => { if (!done) stream.writeSSE({ event: 'update', data }) }
    _sseClients.add(push)
    stream.onAbort(() => { done = true; _sseClients.delete(push) })
    // Push current state immediately on connect
    const pending = getPendingTransfer()
    push(JSON.stringify({ type: 'state', pending, history: _history.slice(0, 20) }))
    while (!done && !stream.closed) {
      await stream.sleep(30_000)
      if (!done && !stream.closed) stream.write(': ping\n\n')
    }
    _sseClients.delete(push)
  }),
)

uiApp.get('/state', c => {
  const pending      = getPendingTransfer()
  const deviceConfig = pending ? (_deviceConfig.get(pending.deviceId) ?? null) : null
  return c.json({ pending, history: _history.slice(0, 20), deviceConfig })
})

/** POST /approve — simulate customer tapping/inserting their card */
uiApp.post('/approve', async (c) => {
  const body = await c.req.json() as {
    cardBrand?:     string
    cardLastFour?:  string
    entryMode?:     string
    approvalCode?:  string
    tipAmountCents?: number
  }
  const pending = getPendingTransfer()
  if (!pending) return c.json({ error: 'No pending transaction' }, 404)

  const cardBrand      = (body.cardBrand    ?? 'VISA').toUpperCase()
  const cardLastFour   = (body.cardLastFour ?? '4242').replace(/\D/g, '').slice(-4).padStart(4, '0')
  const entryMode      = (body.entryMode    ?? 'TAP').toUpperCase()
  const approvalCode   = body.approvalCode ?? String(Math.floor(Math.random() * 900_000) + 100_000)
  const tipAmountCents = typeof body.tipAmountCents === 'number' ? Math.max(0, Math.round(body.tipAmountCents)) : 0

  settleTransfer(pending, {
    state:          'SUCCEEDED',
    cardBrand,
    cardLastFour,
    approvalCode,
    entryMode,
    tipAmountCents,
    failureCode:    null,
    failureMessage: null,
  })

  const tipStr = tipAmountCents > 0 ? `  tip=$${(tipAmountCents / 100).toFixed(2)}` : ''
  console.log(`[a920-emulator] ✅  Transfer ${pending.id} APPROVED  ${cardBrand} ****${cardLastFour}  ${entryMode}${tipStr}`)
  return c.json({ ok: true, transferId: pending.id, tipAmountCents })
})

/** POST /decline — simulate decline or technical failure */
uiApp.post('/decline', async (c) => {
  const body   = await c.req.json() as { reason?: string }
  const reason = body.reason ?? 'CARD_DECLINED'

  const pending = getPendingTransfer()
  if (!pending) return c.json({ error: 'No pending transaction' }, 404)

  settleTransfer(pending, {
    state:          'FAILED',
    failureCode:    reason,
    failureMessage: DECLINE_MESSAGES[reason] ?? 'Transaction declined',
  })

  console.log(`[a920-emulator] ❌  Transfer ${pending.id} DECLINED  ${reason}`)
  return c.json({ ok: true, transferId: pending.id })
})

Bun.serve({ fetch: uiApp.fetch, port: 9334, hostname: '127.0.0.1' })

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

console.warn('\n⚠️  [a920-emulator] DEVELOPMENT TOOL ONLY — bound to 127.0.0.1. Do NOT run in production.\n')
console.log(`
╔══════════════════════════════════════════════════════╗
║          Kizo PAX A920 Pro Emulator              ║
╠══════════════════════════════════════════════════════╣
║  Finix API mock   http://127.0.0.1:9333              ║
║  Control UI       http://127.0.0.1:9334              ║
╠══════════════════════════════════════════════════════╣
║  In the server:                                      ║
║    FINIX_EMULATOR_URL=http://127.0.0.1:9333          ║
║  In Terminal Settings, register device:              ║
║    Device ID: DEemulatora920001                      ║
╚══════════════════════════════════════════════════════╝
`)

// ---------------------------------------------------------------------------
// Web control UI  (single-file SPA, embedded)
// ---------------------------------------------------------------------------

const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAX A920 Pro Emulator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:       #0c0c0c;
    --surface:  #111;
    --surface2: #181818;
    --border:   rgba(255,255,255,0.07);
    --gold:     #d4af37;
    --gold-dim: rgba(212,175,55,0.12);
    --text:     #e0ddd5;
    --text-dim: #6a6560;
    --text-mid: #9a9590;
    --green:    #10b981;
    --blue:     #3b82f6;
    --orange:   #f59e0b;
    --red:      #ef4444;
    --yellow:   #facc15;
  }

  body { background: var(--bg); color: var(--text);
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* ── header ── */
  header { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 700; color: var(--gold); letter-spacing: .06em; }
  header p  { font-size: 11px; color: var(--text-dim); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim);
    flex-shrink: 0; transition: background .3s, box-shadow .3s; }
  .dot.ready  { background: var(--green);  box-shadow: 0 0 6px var(--green); }
  .dot.active { background: var(--orange); box-shadow: 0 0 8px var(--orange); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
    background: var(--gold-dim); color: var(--gold); }
  .spacer { flex: 1; }
  .btn { padding: 5px 12px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer;
    font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.04); color: var(--text-mid);
    font-family: inherit; transition: all .15s; }
  .btn:hover { border-color: rgba(255,255,255,0.15); color: var(--text); }

  /* ── layout ── */
  .layout { display: flex; flex: 1; overflow: hidden; }

  /* ── left panel: history ── */
  .left { width: 280px; border-right: 1px solid var(--border); display: flex; flex-direction: column;
    flex-shrink: 0; overflow: hidden; }
  .panel-head { padding: 8px 12px; font-size: 10px; font-weight: 700; letter-spacing: .1em;
    text-transform: uppercase; color: var(--text-dim); border-bottom: 1px solid var(--border); }
  .history { flex: 1; overflow-y: auto; }
  .tx-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); cursor: default; }
  .tx-row:hover { background: var(--surface2); }
  .tx-row .top { display: flex; justify-content: space-between; align-items: center; }
  .tx-row .amt { font-size: 13px; font-weight: 700; color: var(--text); }
  .tx-row .time { font-size: 10px; color: var(--text-dim); }
  .tx-row .bot  { display: flex; gap: 6px; align-items: center; }
  .tx-row .order { font-size: 10px; color: var(--text-mid); font-family: monospace; }
  .status { padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 700; }
  .status.SUCCEEDED { background: rgba(16,185,129,.15); color: var(--green); }
  .status.FAILED    { background: rgba(239,68,68,.15);  color: var(--red); }
  .status.CANCELED  { background: rgba(107,114,128,.15); color: #9ca3af; }
  .status.PENDING   { background: rgba(245,158,11,.15); color: var(--orange); }
  .card-info { font-size: 10px; color: var(--text-dim); }
  .no-history { padding: 20px 12px; color: var(--text-dim); font-size: 11px; }

  /* ── right panel: terminal ── */
  .right { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px;
    overflow-y: auto; }

  /* ── terminal screen ── */
  .terminal { width: 360px; background: #0a0a0a; border-radius: 16px;
    border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 0 40px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05);
    overflow: hidden; }
  .term-header { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,.06);
    background: rgba(255,255,255,.02); }
  .term-logo { font-size: 11px; font-weight: 700; color: var(--gold); letter-spacing: .06em; }
  .term-model { font-size: 10px; color: var(--text-dim); }
  .term-body { padding: 20px; min-height: 300px; display: flex; flex-direction: column; gap: 16px; }

  /* idle state */
  .idle-screen { display: flex; flex-direction: column; align-items: center; justify-content: center;
    flex: 1; gap: 12px; padding: 20px 0; }
  .idle-icon { font-size: 40px; opacity: .25; }
  .idle-text { font-size: 12px; color: var(--text-dim); text-align: center; }

  /* pending state */
  .amount-display { text-align: center; }
  .amount-label  { font-size: 10px; color: var(--text-dim); letter-spacing: .1em; text-transform: uppercase; margin-bottom: 4px; }
  .amount-value  { font-size: 36px; font-weight: 800; color: var(--text); letter-spacing: -.02em; }
  .order-ref { text-align: center; font-size: 11px; color: var(--text-dim); font-family: monospace; }

  .tap-anim { display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 12px; background: var(--gold-dim); border-radius: 10px;
    border: 1px solid rgba(212,175,55,.2); }
  .tap-anim .icon { font-size: 22px; animation: tap-pulse 1.5s ease-in-out infinite; }
  @keyframes tap-pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.15);opacity:.7} }
  .tap-anim .msg { font-size: 11px; color: var(--gold); font-weight: 600; }

  .field-group { display: flex; flex-direction: column; gap: 8px; }
  .field-label { font-size: 10px; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; }
  .radio-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .radio-btn { padding: 4px 10px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer;
    font-size: 11px; font-weight: 600; color: var(--text-dim); background: transparent;
    font-family: inherit; transition: all .12s; }
  .radio-btn.selected { border-color: var(--gold); color: var(--gold); background: var(--gold-dim); }
  .radio-btn:hover:not(.selected) { border-color: rgba(255,255,255,.15); color: var(--text); }

  .last4-input { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); padding: 5px 10px; font-size: 14px; font-weight: 700; letter-spacing: .15em;
    font-family: monospace; width: 80px; text-align: center; }
  .last4-input:focus { outline: none; border-color: var(--gold); }

  .action-row { display: flex; gap: 10px; margin-top: 4px; }
  .action-btn { flex: 1; padding: 10px; border-radius: 8px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 700; font-family: inherit; transition: all .15s; }
  .approve-btn { background: var(--green); color: #000; }
  .approve-btn:hover { background: #0ea472; }
  .approve-btn:active { transform: scale(.97); }
  .decline-btn { background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3);
    color: var(--red); }
  .decline-btn:hover { background: rgba(239,68,68,.2); }
  .decline-btn:active { transform: scale(.97); }

  .decline-menu { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 0; display: none; flex-direction: column; }
  .decline-menu.open { display: flex; }
  .decline-opt { padding: 7px 14px; font-size: 11px; color: var(--text-mid); cursor: pointer;
    transition: all .1s; }
  .decline-opt:hover { background: var(--surface2); color: var(--text); }
  .decline-opt.destructive { color: var(--red); }

  /* toast */
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 16px; font-size: 12px; color: var(--text); opacity: 0;
    transition: opacity .25s; pointer-events: none; z-index: 99; }
  #toast.show { opacity: 1; }

  ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 2px; }
</style>
</head>
<body>
<header>
  <div class="dot" id="status-dot"></div>
  <h1>PAX A920 Pro Emulator</h1>
  <p id="status-text">Waiting for connection…</p>
  <div class="spacer"></div>
  <span class="badge">127.0.0.1:9334</span>
</header>

<div class="layout">
  <!-- Left: history -->
  <div class="left">
    <div class="panel-head">Transaction History</div>
    <div class="history" id="history-list">
      <div class="no-history">No transactions yet.</div>
    </div>
  </div>

  <!-- Right: terminal -->
  <div class="right">
    <div class="terminal">
      <div class="term-header">
        <span class="term-logo">BAANBAAN</span>
        <span class="term-model">PAX A920 Pro</span>
      </div>
      <div class="term-body" id="term-body">
        <!-- rendered by JS -->
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const $ = id => document.getElementById(id)
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')

// ── SSE ────────────────────────────────────────────────────────────────────
let state = { pending: null, history: [], deviceConfig: null }
const BRANDS = ['VISA','MC','AMEX','DISC','DEBIT']
const MODES  = ['TAP','CHIP','SWIPE']
let selBrand = 'VISA', selMode = 'TAP'
let selTipPercent = null   // null = no tip / custom; number = chosen %
let declining = false

const es = new EventSource('/events')
es.addEventListener('update', e => {
  try { state = JSON.parse(e.data); render() } catch {}
})
es.onopen  = () => { $('status-dot').className = 'dot ready'; $('status-text').textContent = 'Connected'; render() }
es.onerror = () => { $('status-dot').className = 'dot'; $('status-text').textContent = 'Reconnecting…' }

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const { pending, history } = state
  $('status-dot').className = pending ? 'dot active' : 'dot ready'
  $('status-text').textContent = pending
    ? 'Payment pending — tap a card button to simulate'
    : 'Idle — waiting for payment'

  renderHistory(history)
  renderTerminal(pending)
}

function fmtAmt(cents) { return '$' + (cents / 100).toFixed(2) }
function fmtTime(iso)  { return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }

function renderHistory(history) {
  const el = $('history-list')
  if (!history.length) { el.innerHTML = '<div class="no-history">No transactions yet.</div>'; return }
  el.innerHTML = history.map(t => {
    const card     = t.state === 'SUCCEEDED' ? \`\${escHtml(t.cardBrand)} ****\${escHtml(t.cardLastFour)}\` : ''
    const orderRef = escHtml(t.tags?.order_id ?? t.tags?.orderId ?? '—')
    const tipStr   = (t.state === 'SUCCEEDED' && t.tipAmountCents > 0)
      ? \` <span style="color:var(--green);font-size:10px">+\${fmtAmt(t.tipAmountCents)} tip</span>\`
      : ''
    return \`<div class="tx-row">
      <div class="top">
        <span class="amt">\${fmtAmt(t.amount)}\${tipStr}</span>
        <span class="time">\${fmtTime(t.createdAt)}</span>
      </div>
      <div class="bot">
        <span class="status \${escHtml(t.state)}">\${escHtml(t.state)}</span>
        \${card ? '<span class="card-info">' + card + '</span>' : ''}
        <span class="order">\${orderRef}</span>
      </div>
    </div>\`
  }).join('')
}

function renderTerminal(pending) {
  const body = $('term-body')
  declining = false
  selTipPercent = null

  if (!pending) {
    body.innerHTML = \`
      <div class="idle-screen">
        <div class="idle-icon">💳</div>
        <div class="idle-text">No pending transaction<br>Waiting for payment request…</div>
      </div>\`
    return
  }

  const orderRef = escHtml(pending.tags?.order_id ?? pending.tags?.orderId ?? 'unknown')
  body.innerHTML = \`
    <div class="amount-display">
      <div class="amount-label">Amount Due</div>
      <div class="amount-value">\${fmtAmt(pending.amount)}</div>
    </div>
    <div class="order-ref">Order \${orderRef}</div>
    <div class="tap-anim">
      <span class="icon">📱</span>
      <span class="msg">Tap, insert, or swipe card</span>
    </div>

    <div class="field-group">
      <div class="field-label">Card Brand</div>
      <div class="radio-row" id="brand-row">\${
        BRANDS.map(b => \`<button class="radio-btn \${b===selBrand?'selected':''}" onclick="selBrand='\${b}';renderBrands()">\${b}</button>\`).join('')
      }</div>
    </div>

    <div style="display:flex;gap:12px;align-items:flex-end">
      <div class="field-group" style="flex:1">
        <div class="field-label">Last 4 Digits</div>
        <input class="last4-input" id="last4" type="text" maxlength="4" value="4242" inputmode="numeric" pattern="[0-9]*">
      </div>
      <div class="field-group">
        <div class="field-label">Entry Mode</div>
        <div class="radio-row" id="mode-row">\${
          MODES.map(m => \`<button class="radio-btn \${m===selMode?'selected':''}" onclick="selMode='\${m}';renderModes()">\${m}</button>\`).join('')
        }</div>
      </div>
    </div>

    \${state.deviceConfig?.tippingEnabled ? \`
    <div class="field-group" id="tip-group">
      <div class="field-label" style="color:var(--gold)">💳 Tip-on-Terminal — Customer selects:</div>
      <div class="radio-row" id="tip-row">
        \${state.deviceConfig.percentOptions.map(p =>
          \`<button class="radio-btn" onclick="selTipPercent=\${p};renderTips()">\${p}%</button>\`
        ).join('')}
        <button class="radio-btn" onclick="selTipPercent=0;renderTips()">No Tip</button>
      </div>
      <div id="tip-custom-row" style="display:none;margin-top:4px">
        <input id="tip-custom" class="last4-input" style="width:90px" type="number" min="0" placeholder="¢" title="Tip in cents">
        <span style="font-size:10px;color:var(--text-dim);margin-left:6px">cents</span>
      </div>
    </div>\` : ''}

    <div class="action-row">
      <button class="action-btn approve-btn" onclick="doApprove()">✓ Approve</button>
      <button class="action-btn decline-btn" onclick="toggleDecline()">✗ Decline ▾</button>
    </div>
    <div class="decline-menu" id="decline-menu">
      \${[
        ['CARD_DECLINED','Card Declined'],
        ['INSUFFICIENT_FUNDS','Insufficient Funds'],
        ['CARD_EXPIRED','Card Expired'],
        ['INVALID_CARD_NUMBER','Invalid Card'],
        ['LOST_OR_STOLEN_CARD','Lost / Stolen'],
        ['DO_NOT_HONOR','Do Not Honor'],
        ['TECHNICAL_ERROR','Technical Error'],
      ].map(([code,label]) => \`<div class="decline-opt" onclick="doDecline('\${code}')">\${label}</div>\`).join('')}
    </div>\`
}

function renderBrands() {
  const row = $('brand-row')
  if (!row) return
  row.querySelectorAll('.radio-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent === selBrand)
  })
}
function renderModes() {
  const row = $('mode-row')
  if (!row) return
  row.querySelectorAll('.radio-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent === selMode)
  })
}
function renderTips() {
  const row = $('tip-row')
  if (!row) return
  row.querySelectorAll('.radio-btn').forEach(btn => {
    const pct = btn.textContent === 'No Tip' ? 0 : parseInt(btn.textContent)
    btn.classList.toggle('selected', pct === selTipPercent)
  })
}

function toggleDecline() {
  const menu = $('decline-menu')
  if (!menu) return
  declining = !declining
  menu.classList.toggle('open', declining)
}

async function doApprove() {
  const last4 = ($('last4')?.value ?? '4242').replace(/\\D/g,'').slice(-4).padStart(4,'0')

  // Tip calculation when tip-on-terminal is active
  let tipAmountCents = 0
  if (state.deviceConfig?.tippingEnabled && selTipPercent !== null) {
    if (selTipPercent === 0) {
      tipAmountCents = 0  // No Tip selected
    } else {
      tipAmountCents = Math.round((state.pending?.amount ?? 0) * selTipPercent / 100)
    }
  }

  const res = await fetch('/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardBrand: selBrand, cardLastFour: last4, entryMode: selMode, tipAmountCents }),
  })
  const data = await res.json()
  if (res.ok) {
    const tipStr = tipAmountCents > 0 ? \`  tip \${fmtAmt(tipAmountCents)}\` : ''
    toast('✅ Approved — ' + selBrand + ' ****' + last4 + tipStr)
  } else {
    toast('Error: ' + (data.error ?? 'unknown'))
  }
}

async function doDecline(reason) {
  declining = false
  const menu = $('decline-menu')
  if (menu) menu.classList.remove('open')
  const res = await fetch('/decline', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  const data = await res.json()
  if (res.ok) toast('❌ Declined — ' + reason)
  else toast('Error: ' + (data.error ?? 'unknown'))
}

let _toastTimer = null
function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2500)
}

// Close decline menu when clicking outside
document.addEventListener('click', e => {
  if (declining && !e.target.closest('.decline-menu') && !e.target.matches('.decline-btn')) {
    declining = false
    const menu = $('decline-menu')
    if (menu) menu.classList.remove('open')
  }
})

render()
</script>
</body>
</html>`
