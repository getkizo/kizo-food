/**
 * Counter WebSocket service
 *
 * Manages the persistent WebSocket connection from the Kizo Counter
 * Android app (Lenovo tab at the counter, paired with a PAX D135 via Bluetooth).
 *
 * Protocol: COUNTER_WS_SPEC v1.0
 * Endpoint:  ws[s]://<appliance>/ws/counter?merchantId=<id>
 *
 * One active connection per merchant (single-merchant appliance).
 * The counter app reconnects automatically on disconnect using OkHttp's built-in
 * retry; the server accepts the new connection and immediately sends a `config` frame.
 *
 * ## Connection handshake
 * 1. Counter app opens WebSocket to `/ws/counter?merchantId=<id>`.
 * 2. Server calls `counterWsOpen` → sets `_ws`, clears `_deviceConnected`.
 * 3. Server immediately sends a `config` message with Finix credentials, device ID,
 *    restaurant name, and sandbox flag.  The app uses this to initialise the D135 SDK.
 * 4. App responds with a `counter_status` message once the D135 Bluetooth link is up.
 * 5. Server broadcasts `counter_status_changed` via SSE to all open dashboard tabs.
 * 6. Server sends a WebSocket ping every 30 s to keep the connection alive through
 *    OkHttp's 60 s idle timeout.
 *
 * ## Message types
 *
 * ### Server → Counter (outbound)
 * | type              | When sent                              | Key fields |
 * |-------------------|----------------------------------------|------------|
 * | `config`          | Immediately on connect                 | restaurantName, finixDeviceId, finixMerchantId, finixUserId, finixPassword, sandbox |
 * | `payment_request` | When cashier initiates card payment    | orderId, amountCents, currency, tipOptions |
 * | `cancel_payment`  | When cashier cancels before completion | orderId |
 *
 * ### Counter → Server (inbound)
 * | type             | When sent                               | Key fields |
 * |------------------|-----------------------------------------|------------|
 * | `counter_status` | On D135 BT connect/disconnect           | deviceConnected |
 * | `payment_result` | After D135 transaction completes        | orderId, transactionId, status ('approved'\|'declined'\|'error'\|'cancelled'), amountCents, tipCents, totalCents, signatureBase64 |
 * | `receipt_request`| When customer requests email receipt    | orderId, receiptEmail |
 *
 * ### Server → Counter (acknowledgements)
 * | type               | When sent                  | Key fields |
 * |--------------------|----------------------------|------------|
 * | `payment_received` | After handling payment_result | orderId  |
 *
 * **Android compat shim**: the Android app currently omits the `type` field.
 * The server infers the type from the payload shape (`deviceConnected`, `receiptEmail`,
 * or `status`+`orderId`).  Remove the inference block in `counterWsMessage` once
 * the Android app adds explicit `type` fields to its messages.
 *
 * ## State
 * `_ws`             — live WebSocket handle; null when counter is offline.
 * `_deviceConnected`— whether the D135 is connected to the tablet via Bluetooth.
 * `_results`        — Map<orderId, CounterPaymentResult>; polled by the cashier modal;
 *                     entries evicted after 10 hours.
 */

import type { ServerWebSocket } from 'bun'
import { randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { CloverOrderClient } from './clover-order-client'
import { broadcastToMerchant } from './sse'
import { scheduleReconciliation } from './reconcile'
import { sendReceiptEmail } from './email'
import { getAPIKey } from '../crypto/api-keys'
import { listDevices, checkDeviceConnection } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { startTerminalPayment, cancelTerminalPayment } from '../workflows/terminal-payment'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CounterWsData {
  merchantId: string
}

interface PaymentResultMsg {
  type: 'payment_result'
  orderId: string
  transactionId: string | null
  status: 'approved' | 'declined' | 'error' | 'cancelled'
  amountCents: number
  tipCents: number
  totalCents: number
  signatureBase64: string | null
}

interface ReceiptRequestMsg {
  type: 'receipt_request'
  orderId: string
  receiptEmail: string
}

export interface CounterPaymentResult {
  status: 'waiting' | 'approved' | 'declined' | 'error' | 'cancelled'
  message?: string
  paymentId?: string
  /** Unix ms timestamp of when this result was recorded — used for TTL eviction. */
  timestamp?: number
}

// ---------------------------------------------------------------------------
// Type guards — validate incoming WS message shapes before handlers receive them.
// Prevents undefined orderId from corrupting _results (Map<string, ...>).
// ---------------------------------------------------------------------------

const VALID_PAYMENT_STATUSES = new Set(['approved', 'declined', 'error', 'cancelled'])

function isPaymentResultMsg(m: Record<string, unknown>): m is PaymentResultMsg {
  return (
    typeof m.orderId === 'string' && m.orderId.length > 0 &&
    typeof m.status === 'string' && VALID_PAYMENT_STATUSES.has(m.status) &&
    (m.transactionId === null || typeof m.transactionId === 'string') &&
    typeof m.amountCents === 'number' &&
    typeof m.tipCents === 'number' &&
    typeof m.totalCents === 'number' &&
    (m.signatureBase64 === null || typeof m.signatureBase64 === 'string')
  )
}

function isReceiptRequestMsg(m: Record<string, unknown>): m is ReceiptRequestMsg {
  return (
    typeof m.orderId === 'string' && m.orderId.length > 0 &&
    typeof m.receiptEmail === 'string' && m.receiptEmail.length > 0
  )
}

// ---------------------------------------------------------------------------
// State (module-level — single-merchant appliance)
// ---------------------------------------------------------------------------

/** The live WebSocket connection (null when counter is offline). */
let _ws: ServerWebSocket<CounterWsData> | null = null
/** Whether the D135 is connected to the tablet via Bluetooth. */
let _deviceConnected = false
/** Results keyed by orderId — polled by the cashier's payment modal. */
const _results = new Map<string, CounterPaymentResult>()
/** Sweep stale payment results every hour; evict entries older than 10 hours. */
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 60_000
  for (const [id, r] of _results) {
    // Evict if timestamp is missing (should not happen) or older than 10 hours
    if (r.timestamp === undefined || r.timestamp < cutoff) _results.delete(id)
  }
}, 60 * 60_000)
/** Server-side ping interval handle (keeps WS alive during long D135 payment flows). */
let _pingTimer: ReturnType<typeof setInterval> | null = null

const PING_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// WebSocket lifecycle hooks (called from server.ts websocket handlers)
// ---------------------------------------------------------------------------

export function counterWsOpen(ws: ServerWebSocket<CounterWsData>): void {
  _ws = ws
  _deviceConnected = false
  console.log(`[counter-ws] Counter app connected for merchant ${ws.data.merchantId}`)

  // Send config immediately per spec
  sendConfig(ws).catch((err) =>
    console.error('[counter-ws] Failed to send config:', err?.message ?? err),
  )

  // Keepalive ping every 30 s so the WS survives long D135 payment flows
  // (OkHttp and other Android WS clients close idle connections after ~60 s)
  if (_pingTimer) clearInterval(_pingTimer)
  _pingTimer = setInterval(() => {
    if (_ws) {
      try { _ws.ping() } catch { /* ignore if already closed */ }
    } else {
      if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null }
    }
  }, PING_INTERVAL_MS)

  // Notify cashier dashboard
  broadcastToMerchant(ws.data.merchantId, 'counter_status_changed', {
    connected: true,
    deviceConnected: false,
  })
}

export function counterWsMessage(
  ws: ServerWebSocket<CounterWsData>,
  raw: string | ArrayBuffer,
): void {
  let msg: Record<string, unknown>
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    msg = JSON.parse(text)
  } catch {
    return // ignore malformed frames
  }

  // Infer missing 'type' field from payload shape (Android app compat shim).
  // The Android app sends well-formed payloads but omits the 'type' discriminator.
  // Remove this block once the Android app adds "type" to its messages.
  if (!msg.type) {
    // Use the most-specific unique field per message type to avoid misrouting:
    //   counter_status  → 'deviceConnected' (boolean flag, absent from all others)
    //   receipt_request → 'receiptEmail'    (email string, absent from all others)
    //   payment_result  → 'totalCents'      (amount field, absent from all others)
    // Checking 'status'+'orderId' alone is too broad — receipt_request also carries orderId.
    if ('deviceConnected' in msg) {
      msg.type = 'counter_status'
    } else if ('receiptEmail' in msg) {
      msg.type = 'receipt_request'
    } else if ('totalCents' in msg && 'orderId' in msg) {
      msg.type = 'payment_result'
    }
    if (msg.type) {
      console.log(`[counter-ws] ← inferred msg type="${msg.type as string}" (no 'type' field sent)`)
    } else {
      console.warn(`[counter-ws] ← unrecognisable msg, keys: [${Object.keys(msg).join(', ')}]`)
      return
    }
  } else {
    console.log(`[counter-ws] ← msg type="${msg.type as string}"`)
  }

  switch (msg.type) {
    case 'counter_status': {
      _deviceConnected = !!msg.deviceConnected
      console.log(`[counter-ws] Device connected: ${_deviceConnected}`)
      broadcastToMerchant(ws.data.merchantId, 'counter_status_changed', {
        connected: true,
        deviceConnected: _deviceConnected,
      })
      break
    }

    case 'payment_result': {
      // Dump the full raw message — the Android app may include error fields
      // (errorCode, failureCode, errorMessage, etc.) that our typed interface doesn't capture.
      console.log(`[counter-ws] raw payment_result payload:`, JSON.stringify(msg))

      // Acknowledge receipt immediately so Android app knows the message landed
      try {
        ws.send(JSON.stringify({ type: 'payment_received', orderId: msg.orderId }))
      } catch { /* non-critical */ }

      if (!isPaymentResultMsg(msg)) {
        console.warn('[counter-ws] payment_result dropped — missing or invalid required fields', JSON.stringify(msg))
        break
      }
      handlePaymentResult(ws.data.merchantId, msg).catch((err) =>
        console.error('[counter-ws] payment_result error:', err?.message ?? err),
      )
      break
    }

    case 'receipt_request': {
      if (!isReceiptRequestMsg(msg)) {
        console.warn('[counter-ws] receipt_request dropped — missing or invalid required fields', JSON.stringify(msg))
        break
      }
      handleReceiptRequest(ws.data.merchantId, msg).catch((err) =>
        console.error('[counter-ws] receipt_request error:', err?.message ?? err),
      )
      break
    }

    default:
      console.warn(`[counter-ws] Unknown message type ignored: "${msg.type as string}"`)
      break
  }
}

export function counterWsClose(ws: ServerWebSocket<CounterWsData>): void {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null }
  if (_ws === ws) {
    _ws = null
    _deviceConnected = false
    console.log(`[counter-ws] Counter app disconnected`)
    broadcastToMerchant(ws.data.merchantId, 'counter_status_changed', {
      connected: false,
      deviceConnected: false,
    })
  }
}

// ---------------------------------------------------------------------------
// Commands: Kizo → Counter
// ---------------------------------------------------------------------------

/**
 * Sends a payment_request to the counter app.
 * Returns an error string if the counter is not connected, or null on success.
 */
export function sendPaymentRequest(
  orderId: string,
  amountCents: number,
  tipOptions: number[] = [15, 18, 20],
): string | null {
  if (!_ws) return 'Counter app is not connected'

  // Store 'waiting' result so the poll endpoint can respond immediately
  _results.set(orderId, { status: 'waiting', timestamp: Date.now() })

  _ws.send(
    JSON.stringify({
      type: 'payment_request',
      orderId,
      amountCents,
      currency: 'USD',
      tipOptions,
    }),
  )
  console.log(`[counter-ws] payment_request → orderId=${orderId} amount=${amountCents}`)
  return null
}

/**
 * Sends a cancel_payment to the counter app.
 * No-op if counter is not connected.
 */
export function sendCancelPayment(orderId: string): void {
  _results.delete(orderId)
  if (!_ws) return
  _ws.send(JSON.stringify({ type: 'cancel_payment', orderId }))
  console.log(`[counter-ws] cancel_payment → orderId=${orderId}`)
}

// ---------------------------------------------------------------------------
// Status queries (used by REST routes)
// ---------------------------------------------------------------------------

export function getCounterStatus(): { connected: boolean; deviceConnected: boolean } {
  return { connected: _ws !== null, deviceConnected: _deviceConnected }
}

export function getPaymentResult(orderId: string): CounterPaymentResult | null {
  return _results.get(orderId) ?? null
}

export function clearPaymentResult(orderId: string): void {
  _results.delete(orderId)
}

/**
 * Starts a PAX A920 Pro terminal payment via the SAM workflow.
 *
 * Delegates to `startTerminalPayment` and wires the `onResult` callback into
 * the shared `_results` map so the existing `payment-status` poll endpoint
 * works without modification.
 *
 * @returns error string if setup fails, or null on success
 */
export async function startA920Payment(
  merchantId: string,
  orderId: string,
  amountCents: number,
): Promise<string | null> {
  _results.set(orderId, { status: 'waiting', timestamp: Date.now() })

  const err = await startTerminalPayment(
    merchantId,
    orderId,
    amountCents,
    (oid, result) => { _results.set(oid, { ...result, timestamp: Date.now() }) },
  )

  if (err) {
    _results.delete(orderId)
    return err
  }
  return null
}

/**
 * Cancels an in-progress A920 Pro payment and clears the pending result.
 * No-op if no workflow is tracking this orderId.
 */
export function cancelA920Payment(merchantId: string, orderId: string): void {
  cancelTerminalPayment(merchantId, orderId)
  _results.delete(orderId)
}

// ---------------------------------------------------------------------------
// Clover Flex split-leg payment
// ---------------------------------------------------------------------------

/**
 * Starts a Clover Flex payment for one leg of a split payment.
 *
 * Creates a mini Clover order (subtotal + service charge + tax line items),
 * polls until the customer pays on the Flex device, then records the payment
 * in the `payments` table. The result is written to the shared `_results` map
 * so the existing `counter/payment-status` poll endpoint works unchanged.
 *
 * @param merchantId   Kizo merchant ID
 * @param orderId      Kizo order ID
 * @param opts.legSubtotalCents     Pre-tax leg subtotal (from payment modal split logic)
 * @param opts.legTaxCents          Tax for this leg
 * @param opts.serviceChargeCents   20% of legSubtotalCents — pre-computed by frontend
 * @param opts.legNumber            1-based leg index
 * @param opts.totalLegs            Total number of legs in this split
 * @param opts.splitMode            'equal' | 'by_items' | 'custom' | 'gift_card'
 * @returns error string or null on success
 */
export async function startCloverLegPayment(
  merchantId: string,
  orderId:    string,
  opts: {
    legSubtotalCents:    number
    legTaxCents:         number
    serviceChargeCents:  number
    legNumber:           number
    totalLegs:           number
    splitMode:           string
  },
): Promise<string | null> {
  const client = new CloverOrderClient()
  if (!client.isEnabled()) return 'Clover integration is not configured'

  _results.set(orderId, { status: 'waiting', timestamp: Date.now() })

  // Kick off the Clover leg flow asynchronously — request-payment returns immediately
  ;(async () => {
    try {
      const db = getDatabase()

      // Fetch the order's table label for a human-readable Clover order title
      const orderRow = db
        .query<{ table_label: string | null }, [string]>(
          `SELECT table_label FROM orders WHERE id = ? LIMIT 1`
        )
        .get(orderId)
      const tableHint = orderRow?.table_label?.trim()
        ? (/^\d+$/.test(orderRow.table_label.trim()) ? `Table ${orderRow.table_label.trim()}` : orderRow.table_label.trim())
        : 'Order'
      const legLabel = `Split ${opts.legNumber}/${opts.totalLegs} · ${tableHint}`

      // Create a mini Clover order for this leg
      const { cloverLegOrderId } = await client.pushLegOrder({
        legLabel,
        subtotalCents:    opts.legSubtotalCents,
        taxCents:         opts.legTaxCents,
        serviceChargeCents: opts.serviceChargeCents,
      })
      if (!cloverLegOrderId) throw new Error('Clover order creation returned empty ID')

      // Poll until paid (5-minute window matching the current Clover flow timeout)
      const result = await client.waitForPayment(cloverLegOrderId, { timeoutMs: 5 * 60_000 })

      if (result.status === 'paid') {
        const paymentId = await _recordCloverLegPayment(db, merchantId, orderId, result, opts)
        _results.set(orderId, { status: 'approved', paymentId, timestamp: Date.now() })

        // Broadcast update so the dashboard order list refreshes
        broadcastToMerchant(merchantId, 'order_updated', { orderId })

      } else if (result.status === 'cancelled') {
        _results.set(orderId, { status: 'cancelled', timestamp: Date.now() })
      } else {
        // timeout
        _results.set(orderId, { status: 'error', message: 'Clover payment timed out', timestamp: Date.now() })
      }
    } catch (err) {
      console.error('[clover-leg] Payment failed:', err instanceof Error ? err.message : err)
      _results.set(orderId, {
        status: 'error',
        message: err instanceof Error ? err.message : 'Clover payment failed',
        timestamp: Date.now(),
      })
    }
  })()

  return null
}

/** Records one Clover split leg into the `payments` table. Marks order paid on last leg. */
async function _recordCloverLegPayment(
  db:          ReturnType<typeof getDatabase>,
  merchantId:  string,
  orderId:     string,
  result:      { paymentId: string; totalCents: number; paymentMethod: string },
  opts: {
    legSubtotalCents:    number
    legTaxCents:         number
    serviceChargeCents:  number
    legNumber:           number
    totalLegs:           number
    splitMode:           string
  },
): Promise<string> {
  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now       = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const isLastLeg = opts.legNumber >= opts.totalLegs

  db.run(
    `INSERT INTO payments (
       id, order_id, merchant_id, payment_type, amount_cents,
       subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
       card_type, card_last_four, transaction_id, processor,
       split_mode, split_leg_number, split_total_legs,
       created_at, completed_at
     ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, ?, null, null, ?, 'clover', ?, ?, ?, ?, ?)`,
    [
      paymentId, orderId, merchantId,
      opts.legSubtotalCents + opts.legTaxCents + opts.serviceChargeCents,
      opts.legSubtotalCents, opts.legTaxCents,
      opts.serviceChargeCents,                 // stored as tip_cents — conceptually the mandatory gratuity
      opts.legSubtotalCents > 0               // gratuity_percent derived from actual rate
        ? Math.round(opts.serviceChargeCents / opts.legSubtotalCents * 100)
        : 0,
      result.paymentId,                        // Clover payment ID as transaction_id
      opts.splitMode, opts.legNumber, opts.totalLegs,
      now, now,
    ]
  )

  if (isLastLeg) {
    db.run(
      `UPDATE orders SET status = 'paid', payment_method = 'clover', updated_at = datetime('now') WHERE id = ?`,
      [orderId]
    )
  }

  console.log(
    `[clover-leg] Recorded: order ${orderId} leg ${opts.legNumber}/${opts.totalLegs}` +
    ` — ${opts.legSubtotalCents + opts.legTaxCents + opts.serviceChargeCents}¢` +
    `${isLastLeg ? ' (last leg, order → paid)' : ''}`
  )
  return paymentId
}

// ---------------------------------------------------------------------------
// Clover Flex full-order payment (non-split)
// ---------------------------------------------------------------------------

/**
 * Starts a full-order Clover Flex payment (no split, no service charge).
 *
 * Pushes the actual Kizo order items to Clover via `pushOrder()` so the
 * customer sees real line items on the device. Customer tips on the device.
 * Payment is polled via `waitForPayment()` and recorded once complete.
 *
 * @param merchantId  Kizo merchant ID
 * @param orderId     Kizo order ID
 * @returns error string, or null on success (background work continues)
 */
export async function startCloverFullPayment(
  merchantId: string,
  orderId:    string,
): Promise<string | null> {
  const client = new CloverOrderClient()
  if (!client.isEnabled()) return 'Clover integration is not configured'

  _results.set(orderId, { status: 'waiting', timestamp: Date.now() })

  ;(async () => {
    try {
      const db = getDatabase()

      // Fetch order row
      const orderRow = db.query<{
        id: string
        customer_name: string
        order_type: string
        table_label: string | null
        notes: string | null
        clover_order_id: string | null
        items: string
        total_cents: number
        subtotal_cents: number
        service_charge_cents: number
      }, [string]>(
        `SELECT id, customer_name, order_type, table_label, notes, clover_order_id,
                items, total_cents, subtotal_cents, COALESCE(service_charge_cents, 0) AS service_charge_cents
         FROM orders WHERE id = ? LIMIT 1`
      ).get(orderId)

      if (!orderRow) throw new Error(`Order ${orderId} not found`)

      // Fetch merchant tax rate for Clover line items
      const merchantRow = db.query<{ tax_rate: number }, [string]>(
        `SELECT tax_rate FROM merchants WHERE id = ? LIMIT 1`
      ).get(merchantId)

      // Push full order to Clover (idempotent — reuses clover_order_id if already set)
      const { cloverOrderId } = await client.pushOrder(
        { ...orderRow, merchant_id: merchantId, tax_rate: merchantRow?.tax_rate ?? null },
        db
      )
      if (!cloverOrderId) throw new Error('Clover order creation failed')

      // Poll until customer pays (10-minute timeout — customer tips on device)
      const result = await client.waitForPayment(cloverOrderId, { timeoutMs: 10 * 60_000 })

      if (result.status === 'paid') {
        const paymentId = _recordCloverFullPayment(db, merchantId, orderId, orderRow, result)
        _results.set(orderId, { status: 'approved', paymentId, timestamp: Date.now() })
        broadcastToMerchant(merchantId, 'order_updated', { orderId })
      } else if (result.status === 'cancelled') {
        _results.set(orderId, { status: 'cancelled', timestamp: Date.now() })
      } else {
        _results.set(orderId, {
          status: 'error',
          message: 'Clover payment timed out after 10 minutes',
          timestamp: Date.now(),
        })
      }
    } catch (err) {
      console.error('[clover-full] Payment failed:', err instanceof Error ? err.message : err)
      _results.set(orderId, {
        status: 'error',
        message: err instanceof Error ? err.message : 'Clover payment failed',
        timestamp: Date.now(),
      })
    }
  })()

  return null
}

/** Records a full-order Clover payment into the `payments` table and marks the order paid. */
function _recordCloverFullPayment(
  db:          ReturnType<typeof getDatabase>,
  merchantId:  string,
  orderId:     string,
  orderRow:    { total_cents: number; subtotal_cents: number; service_charge_cents: number },
  result:      { paymentId: string; totalCents: number; paymentMethod: string },
): string {
  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now       = new Date().toISOString().replace('T', ' ').slice(0, 19)
  // Infer tip from difference between what Clover charged vs Kizo pre-tip total
  const tipCents  = Math.max(0, result.totalCents - orderRow.total_cents)
  const taxCents  = Math.max(0,
    orderRow.total_cents - orderRow.subtotal_cents - orderRow.service_charge_cents
  )

  db.run(
    `INSERT INTO payments (
       id, order_id, merchant_id, payment_type, amount_cents,
       subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
       card_type, card_last_four, transaction_id, processor,
       split_mode, split_leg_number, split_total_legs,
       created_at, completed_at
     ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, null, ?, null, ?, 'clover', null, null, null, ?, ?)`,
    [
      paymentId, orderId, merchantId,
      result.totalCents,
      orderRow.subtotal_cents, taxCents, tipCents,
      result.paymentMethod.toLowerCase(),
      result.paymentId,
      now, now,
    ]
  )

  db.run(
    `UPDATE orders SET status = 'paid', payment_method = 'clover', updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  )

  console.log(
    `[clover-full] Recorded: order ${orderId} — ${result.totalCents}¢` +
    ` (tip ~${tipCents}¢) → paid`
  )
  return paymentId
}

// ---------------------------------------------------------------------------
// Token validation (called during WS upgrade)
// ---------------------------------------------------------------------------

/**
 * Validates a counter token and returns the merchantId it belongs to.
 * Returns null if invalid.
 */
export function validateCounterToken(token: string | null): string | null {
  if (!token) return null
  const db = getDatabase()
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM merchants WHERE counter_ws_token = ? AND status = 'active' LIMIT 1`,
    )
    .get(token)
  return row?.id ?? null
}

/**
 * Returns (and lazily generates) the counter WS token for a merchant.
 */
export function getOrCreateCounterToken(merchantId: string): string {
  const db = getDatabase()
  const row = db
    .query<{ counter_ws_token: string | null }, [string]>(
      `SELECT counter_ws_token FROM merchants WHERE id = ?`,
    )
    .get(merchantId)

  if (row?.counter_ws_token) return row.counter_ws_token

  const token = randomBytes(32).toString('hex')
  db.run(`UPDATE merchants SET counter_ws_token = ? WHERE id = ?`, [token, merchantId])
  return token
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds and sends the `config` message to the counter app.
 * Loads Finix credentials and the counter terminal's device ID from the DB.
 */
async function sendConfig(ws: ServerWebSocket<CounterWsData>): Promise<void> {
  const merchantId = ws.data.merchantId
  const db = getDatabase()

  // Load merchant name + sandbox flag
  const merchant = db
    .query<{ business_name: string; finix_sandbox: number }, [string]>(
      `SELECT business_name, finix_sandbox FROM merchants WHERE id = ?`,
    )
    .get(merchantId)

  // Load Finix credentials from api_keys
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
    )
    .get(merchantId)

  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
  if (parts.length !== 3 || !apiPassword) {
    console.warn('[counter-ws] Finix credentials not configured — sending partial config')
  }
  const [finixUserId = '', finixMid = '', finixMerchantId = ''] = parts

  // Find the counter terminal's Finix device ID (non-A920-Pro, first with device ID)
  const counterTerminal = db
    .query<{ finix_device_id: string | null }, [string]>(
      `SELECT finix_device_id FROM terminals
       WHERE merchant_id = ? AND model != 'pax_a920_pro'
         AND finix_device_id IS NOT NULL LIMIT 1`,
    )
    .get(merchantId)

  const config = {
    type: 'config',
    restaurantName:   merchant?.business_name ?? 'Restaurant',
    finixDeviceId:    counterTerminal?.finix_device_id ?? '',
    finixMerchantId,
    finixMid,
    finixUserId,
    finixPassword:    apiPassword ?? '',
    environment:      (merchant?.finix_sandbox ?? 1) !== 0 ? 'SB' : 'PROD',
  }

  ws.send(JSON.stringify(config))
  console.log(
    `[counter-ws] config sent → environment=${config.environment}` +
    `, deviceId=${config.finixDeviceId || '(EMPTY)'}` +
    `, userId=${config.finixUserId || '(EMPTY)'}` +
    `, mid=${config.finixMid || '(EMPTY)'}` +
    `, merchantId=${config.finixMerchantId || '(EMPTY)'}`,
  )
  if (config.environment === 'SB') {
    console.warn(
      '[counter-ws] ⚠ Finix SANDBOX mode — D135 transactions will NOT appear in the production dashboard.' +
      ' Disable "Finix Sandbox" in Store Profile → Payment Settings to switch to production.',
    )
  }
  if (!config.finixDeviceId) {
    console.warn(
      '[counter-ws] ⚠ No Finix device ID found for counter terminal.' +
      ' Register the D135 in Terminals and set its Finix Device ID — payments will fail without it.',
    )
  }

  // Validate credentials by attempting a Finix API call (non-blocking).
  // This catches the common mistake of using sandbox credentials in PROD or vice versa.
  if (finixUserId && finixMid && finixMerchantId && apiPassword) {
    const creds: FinixCredentials = {
      apiUsername:    finixUserId,
      applicationId: finixMid,
      merchantId:    finixMerchantId,
      apiPassword,
      sandbox:       config.environment === 'SB',
    }
    listDevices(creds)
      .then(async (devices) => {
        console.log(`[counter-ws] ✓ Finix credential check passed (${config.environment}) — ${devices.length} device(s) registered`)
        if (config.finixDeviceId) {
          const match = devices.find(d => d.id === config.finixDeviceId)
          if (match) {
            console.log(`[counter-ws] ✓ Device ${config.finixDeviceId} found in device list — enabled=${match.enabled}`)
          } else {
            console.error(
              `[counter-ws] ✗ Device ${config.finixDeviceId} NOT found in Finix ${config.environment} environment.` +
              ` Registered devices: ${devices.map(d => d.id).join(', ') || '(none)'}`,
            )
          }
          // Also check device connection status — tells us if Finix can reach the D135 through the Android SDK
          try {
            const conn = await checkDeviceConnection(creds, config.finixDeviceId)
            console.log(`[counter-ws] Device connection check: enabled=${conn.enabled}, connection=${conn.connection}`)
            if (conn.connection !== 'CONNECTED') {
              console.warn(
                `[counter-ws] ⚠ Device is not CONNECTED (status: ${conn.connection}).` +
                ' The Finix SDK on the Android app may not be running in bridge mode,' +
                ' or the D135 is not paired via Bluetooth.',
              )
            }
          } catch (connErr) {
            console.warn(`[counter-ws] Device connection check failed: ${(connErr as Error).message ?? connErr}`)
          }
        }
      })
      .catch((err) => {
        console.error(`[counter-ws] ✗ Finix credential check FAILED (${config.environment}): ${(err as Error).message ?? err}`)
        console.error(
          '[counter-ws]   → The API credentials (userId / password / Application ID / Merchant ID)' +
          ` may be for the ${config.environment === 'PROD' ? 'SANDBOX' : 'PROD'} environment.` +
          ' Update them in Store Profile → Payment Settings → Finix.',
        )
      })
  }
}

/**
 * Handles a payment_result from the counter app.
 * Records the payment in the DB and broadcasts SSE on approval.
 */
async function handlePaymentResult(
  merchantId: string,
  msg: PaymentResultMsg,
): Promise<void> {
  console.log(
    `[counter-ws] payment_result orderId=${msg.orderId} status=${msg.status}` +
    (msg.transactionId ? ` transactionId=${msg.transactionId}` : ' transactionId=(none — not processed by Finix)'),
  )

  if (msg.status !== 'approved') {
    const message =
      msg.status === 'declined' ? 'Payment was declined — please try again'
      : msg.status === 'cancelled' ? 'Payment cancelled'
      : 'Payment error — please try again'
    _results.set(msg.orderId, { status: msg.status, message, timestamp: Date.now() })
    broadcastToMerchant(merchantId, 'counter_payment_result', {
      orderId: msg.orderId,
      status: msg.status,
      message,
    })
    return
  }

  // Approved — record in DB
  const db = getDatabase()
  const order = db
    .query<{ subtotal_cents: number; tax_cents: number; status: string }, [string, string]>(
      `SELECT subtotal_cents, tax_cents, status FROM orders WHERE id = ? AND merchant_id = ?`,
    )
    .get(msg.orderId, merchantId)

  if (!order) {
    console.warn(`[counter-ws] payment_result for unknown order ${msg.orderId}`)
    _results.set(msg.orderId, { status: 'error', message: 'Order not found', timestamp: Date.now() })
    return
  }

  if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
    console.warn(`[counter-ws] order ${msg.orderId} already ${order.status} — ignoring`)
    _results.set(msg.orderId, { status: 'approved', timestamp: Date.now() })
    return
  }

  // CRIT-1: Validate payment amounts — integers, non-negative, within a $100,000 ceiling,
  // and within 5% of the order total (prevents rogue/compromised devices from recording
  // fraudulent amounts).
  const MAX_PAYMENT_CENTS = 100_000_00 // $100,000
  const orderTotalCents = order.subtotal_cents + order.tax_cents
  if (
    !Number.isInteger(msg.totalCents) || msg.totalCents < 0 || msg.totalCents > MAX_PAYMENT_CENTS ||
    !Number.isInteger(msg.tipCents)   || msg.tipCents   < 0 || msg.tipCents   > MAX_PAYMENT_CENTS
  ) {
    console.warn(`[counter-ws] payment_result rejected — invalid amounts totalCents=${msg.totalCents} tipCents=${msg.tipCents}`)
    _results.set(msg.orderId, { status: 'error', message: 'Invalid payment amounts', timestamp: Date.now() })
    return
  }
  if (orderTotalCents > 0 && Math.abs(msg.totalCents - orderTotalCents) > orderTotalCents * 0.05) {
    console.warn(
      `[counter-ws] payment_result rejected — totalCents ${msg.totalCents} deviates >5% from order total ${orderTotalCents}`,
    )
    _results.set(msg.orderId, { status: 'error', message: 'Payment amount does not match order total', timestamp: Date.now() })
    return
  }

  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const signatureCapturedAt = msg.signatureBase64 ? now : null

  try {
    db.exec('BEGIN')

    // For Finix counter payments, transactionId is the Finix transfer ID (TR_…).
    // Store it in finix_transfer_id so reconciliation can short-circuit immediately.
    const finixTransferId = msg.transactionId ?? null

    db.run(
      `INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name,
          transaction_id, processor, auth_code,
          finix_transfer_id,
          signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_email, created_at, completed_at
       ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, null, null, null, null,
                 ?, 'finix_counter', null, ?, ?, ?, null, null, null, null, null, ?, ?)`,
      [
        paymentId, msg.orderId, merchantId, msg.totalCents,
        order.subtotal_cents, order.tax_cents, msg.tipCents,
        msg.transactionId ?? null,
        finixTransferId,
        msg.signatureBase64 ?? null, signatureCapturedAt,
        now, now,
      ],
    )

    db.run(
      `UPDATE orders
       SET status = 'paid', tip_cents = ?, paid_amount_cents = ?,
           payment_method = 'card', updated_at = ?
       WHERE id = ?`,
      [msg.tipCents, msg.totalCents, now, msg.orderId],
    )

    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    console.error('[counter-ws] DB record failed:', err)
    _results.set(msg.orderId, { status: 'error', message: 'Failed to record payment', timestamp: Date.now() })
    return
  }

  // Store result for cashier modal polling
  _results.set(msg.orderId, { status: 'approved', paymentId })

  // Notify cashier dashboard (order list badge + payment modal poll)
  broadcastToMerchant(merchantId, 'order_updated', { orderId: msg.orderId, status: 'paid' })
  broadcastToMerchant(merchantId, 'counter_payment_result', {
    orderId: msg.orderId,
    status: 'approved',
  })

  // Schedule Finix reconciliation (60 s delay)
  scheduleReconciliation(merchantId, paymentId, 'card')

  console.log(`[counter-ws] ✓ payment recorded paymentId=${paymentId} for order ${msg.orderId}`)
}

/**
 * Handles a receipt_request from the counter app.
 * Sent separately after payment_result, only when the customer enters their email.
 * Updates receipt_email on the payment row and triggers the email send.
 */
async function handleReceiptRequest(
  merchantId: string,
  msg: ReceiptRequestMsg,
): Promise<void> {
  console.log(`[counter-ws] receipt_request orderId=${msg.orderId} email=${msg.receiptEmail}`)

  if (!msg.orderId || !msg.receiptEmail) {
    console.warn('[counter-ws] receipt_request missing orderId or receiptEmail — ignored')
    return
  }

  // CRIT-2: Validate email format to prevent SMTP header injection.
  // RFC 5321 max address length is 254 characters.
  const EMAIL_RE = /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/
  if (!EMAIL_RE.test(msg.receiptEmail) || msg.receiptEmail.length > 254) {
    console.warn(`[counter-ws] receipt_request rejected — invalid email format: "${msg.receiptEmail.substring(0, 60)}"`)
    return
  }

  const db = getDatabase()

  // Persist the email on the payment row so it shows in the payments tab
  db.run(
    `UPDATE payments SET receipt_email = ? WHERE order_id = ? AND merchant_id = ? AND processor = 'finix_counter'`,
    [msg.receiptEmail, msg.orderId, merchantId],
  )

  // Send the receipt email
  sendReceiptEmail(merchantId, msg.orderId)
    .catch((err) => console.warn('[counter-ws] receipt email failed:', err?.message ?? err))
}
