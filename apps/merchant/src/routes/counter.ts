/**
 * Counter WebSocket & REST routes
 *
 * WebSocket: GET /counter?token=<token>
 *   — The Kizo Counter Android app connects here.
 *   — WS lifecycle is handled in server.ts; this file owns the REST companion endpoints.
 *
 * REST (cashier-initiated, all under /api/merchants/:id/counter/):
 *   GET  status            — returns current connection + device status
 *   GET  token             — returns (and lazily generates) the WS token for setup
 *   POST request-payment   — sends payment_request to counter app
 *   POST cancel-payment    — sends cancel_payment to counter app
 *   GET  payment-status    — polled by payment modal while waiting for result
 *   GET  device-check      — diagnostic: validates Finix credentials and device state
 */

import { Hono } from 'hono'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import { serverError } from '../utils/server-error'
import {
  sendPaymentRequest,
  sendCancelPayment,
  startA920Payment,
  cancelA920Payment,
  startCloverLegPayment,
  startCloverFullPayment,
  getCounterStatus,
  getPaymentResult,
  clearPaymentResult,
  getOrCreateCounterToken,
} from '../services/counter-ws'
import { getDatabase } from '../db/connection'
import { getAPIKey } from '../crypto/api-keys'
import { listDevices, checkDeviceConnection } from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import type { AuthContext } from '../middleware/auth'

const counter = new Hono()

/**
 * GET /api/merchants/:id/counter/status
 *
 * Returns the live WebSocket connection state and device info for the
 * Kizo Counter Android app. Used by the dashboard to show the
 * connection indicator.
 *
 * @returns `{ connected: boolean, deviceName?: string, connectedAt?: string }`
 */
counter.get(
  '/api/merchants/:id/counter/status',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  (c: AuthContext) => {
    const status = getCounterStatus()
    return c.json(status)
  },
)

/**
 * GET /api/merchants/:id/counter/token
 *
 * Returns (lazily generating) the WebSocket bearer token used by the
 * Kizo Counter Android app during setup. The token is stable until
 * explicitly rotated. Also returns the full `wss://` URL for convenience.
 *
 * @returns `{ token: string, wsUrl: string }`
 */
counter.get(
  '/api/merchants/:id/counter/token',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  (c: AuthContext) => {
    const merchantId = c.req.param('id')
    try {
      const token = getOrCreateCounterToken(merchantId)
      // Build the WS URL relative to the current request host
      const host = c.req.header('host') ?? 'localhost:3000'
      const proto = c.req.header('x-forwarded-proto') === 'https' ? 'wss' : 'ws'
      const wsUrl = `${proto}://${host}/counter?token=${token}`
      return c.json({ token, wsUrl })
    } catch (err) {
      return serverError(c, '[counter] token', err, 'Failed to get counter token')
    }
  },
)

/**
 * POST /api/merchants/:id/counter/request-payment
 *
 * Sends a `payment_request` WebSocket message to the connected Counter
 * Android app. The app displays a payment screen to the customer.
 * Returns 503 if the Counter app is not currently connected.
 *
 * @param body.orderId - Order being paid
 * @param body.amountCents - Amount to charge in cents
 * @param body.tipOptions - Optional tip percentage suggestions (e.g. `[18, 20, 22]`)
 * @returns `{ success: true }`
 */
counter.post(
  '/api/merchants/:id/counter/request-payment',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const { orderId, amountCents, tipOptions, cloverLeg, cloverFull } = await c.req.json() as {
        orderId: string
        amountCents: number
        tipOptions?: number[]
        cloverFull?: boolean
        cloverLeg?: {
          legSubtotalCents:   number
          legTaxCents:        number
          serviceChargeCents: number
          legNumber:          number
          totalLegs:          number
          splitMode:          string
        }
      }

      if (!orderId || typeof orderId !== 'string') {
        return c.json({ error: 'orderId is required' }, 400)
      }

      // Clover full-order payment — pushes actual items to Clover Flex, customer tips on device
      if (cloverFull) {
        const err = await startCloverFullPayment(merchantId, orderId)
        if (err) return c.json({ error: err }, 503)
        return c.json({ success: true })
      }

      // Clover split leg — synthetic mini order with subtotal + service charge + tax
      if (cloverLeg) {
        const err = await startCloverLegPayment(merchantId, orderId, cloverLeg)
        if (err) return c.json({ error: err }, 503)
        return c.json({ success: true })
      }

      if (typeof amountCents !== 'number' || amountCents <= 0) {
        return c.json({ error: 'amountCents must be a positive number' }, 400)
      }
      if (tipOptions !== undefined) {
        if (
          !Array.isArray(tipOptions) ||
          tipOptions.length > 6 ||
          !tipOptions.every(
            (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100,
          )
        ) {
          return c.json(
            { error: 'tipOptions must be an array of up to 6 integers between 0 and 100' },
            400,
          )
        }
      }

      // If the merchant has a PAX A920 Pro terminal configured, use the SAM
      // workflow (direct Finix API) instead of routing through the Counter app.
      const hasA920 = !!getDatabase()
        .query<{ id: string }, [string]>(
          `SELECT id FROM terminals WHERE merchant_id = ? AND model IN ('pax_a920_pro', 'pax_a920_emu')
           AND finix_device_id IS NOT NULL LIMIT 1`,
        )
        .get(merchantId)

      if (hasA920) {
        const err = await startA920Payment(merchantId, orderId, amountCents)
        if (err) return c.json({ error: err }, 503)
        return c.json({ success: true })
      }

      const err = sendPaymentRequest(orderId, amountCents, tipOptions)
      if (err) return c.json({ error: err }, 503)

      return c.json({ success: true })
    } catch (err) {
      return serverError(c, '[counter] request-payment', err, 'Failed to send payment request to counter')
    }
  },
)

/**
 * POST /api/merchants/:id/counter/cancel-payment
 *
 * Sends a `cancel_payment` WebSocket message to the Counter Android app,
 * returning the terminal to idle. Safe to call if no payment is in progress.
 *
 * @param body.orderId - Order whose payment should be cancelled
 * @returns `{ success: true }`
 */
counter.post(
  '/api/merchants/:id/counter/cancel-payment',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    try {
      const merchantId = c.req.param('id')
      const { orderId } = await c.req.json() as { orderId: string }
      if (!orderId) return c.json({ error: 'orderId is required' }, 400)

      const hasA920 = !!getDatabase()
        .query<{ id: string }, [string]>(
          `SELECT id FROM terminals WHERE merchant_id = ? AND model IN ('pax_a920_pro', 'pax_a920_emu')
           AND finix_device_id IS NOT NULL LIMIT 1`,
        )
        .get(merchantId)

      if (hasA920) {
        cancelA920Payment(merchantId, orderId)
      } else {
        sendCancelPayment(orderId)
      }
      return c.json({ success: true })
    } catch (err) {
      return serverError(c, '[counter] cancel-payment', err, 'Failed to cancel counter payment')
    }
  },
)

/**
 * GET /api/merchants/:id/counter/payment-status
 *
 * Polled by the cashier's payment modal every 2 s while waiting for the
 * customer to tap/swipe on the Counter Android terminal. The result is
 * consumed (cleared) on first non-waiting read.
 *
 * On `approved`, the payment has already been recorded server-side by
 * the Counter WebSocket message handler — the modal only needs to confirm.
 *
 * @param query.orderId - Order being polled
 * @returns `{ status: 'waiting' | 'approved' | 'declined' | 'error' | 'cancelled', message?: string }`
 */
counter.get(
  '/api/merchants/:id/counter/payment-status',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager', 'staff'),
  (c: AuthContext) => {
    const orderId = c.req.query('orderId')
    if (!orderId) return c.json({ error: 'orderId query param required' }, 400)

    const result = getPaymentResult(orderId)
    if (!result) {
      // No pending session — check if counter is connected at all
      const { connected } = getCounterStatus()
      if (!connected) return c.json({ status: 'error', message: 'Counter app is not connected' })
      return c.json({ status: 'waiting' })
    }

    // Clear terminal results once read (approved/declined/error/cancelled)
    if (result.status !== 'waiting') {
      clearPaymentResult(orderId)
    }

    return c.json(result)
  },
)

/**
 * GET /api/merchants/:id/counter/device-check
 *
 * Read-only diagnostic that calls Finix to verify:
 *   1. Credentials are valid for the current environment (sandbox / production)
 *   2. The Counter terminal's Finix device ID exists and is activated
 *   3. The device's connection status (`CONNECTED` = Finix SDK bridge is active)
 *
 * No money is charged. Returns 401 if Finix rejects the credentials.
 *
 * @returns `{ credentialsOk, environment, devicesFound, counterDevice, allDevices }`
 */
counter.get(
  '/api/merchants/:id/counter/device-check',
  authenticate,
  requireOwnMerchant,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    try {
      const db = getDatabase()

      // Load Finix credentials (same source as A920 Pro flow)
      const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
      if (!apiPassword) return c.json({ error: 'Finix API key not configured' }, 400)

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
        )
        .get(merchantId)
      const parts = (keyRow?.pos_merchant_id ?? '').split(':')
      if (parts.length !== 3) return c.json({ error: 'Finix credentials incomplete (expected userId:appId:merchantId)' }, 400)

      const merchantRow = db
        .query<{ finix_sandbox: number }, [string]>(
          `SELECT finix_sandbox FROM merchants WHERE id = ?`,
        )
        .get(merchantId)
      const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

      const creds: FinixCredentials = {
        apiUsername:    parts[0],
        applicationId: parts[1],
        merchantId:    parts[2],
        apiPassword,
        sandbox,
      }

      // Find the counter terminal's Finix device ID
      const terminal = db
        .query<{ finix_device_id: string | null; nickname: string }, [string]>(
          `SELECT finix_device_id, nickname FROM terminals
           WHERE merchant_id = ? AND model != 'pax_a920_pro'
             AND finix_device_id IS NOT NULL LIMIT 1`,
        )
        .get(merchantId)

      // Step 1: Verify credentials by listing devices
      const devices = await listDevices(creds)

      // Step 2: Check if counter device is in the list
      const deviceId = terminal?.finix_device_id ?? null
      const deviceInList = deviceId ? devices.find(d => d.id === deviceId) : null

      // Step 3: Check device connection if we have a device ID
      let connection: { connection: string; enabled: boolean } | null = null
      if (deviceId) {
        try {
          connection = await checkDeviceConnection(creds, deviceId)
        } catch (connErr) {
          console.error('[counter] checkDeviceConnection failed:', (connErr as Error).message ?? connErr)
          connection = { connection: 'ERROR: device check failed', enabled: false }
        }
      }

      return c.json({
        environment:    sandbox ? 'SB' : 'PROD',
        credentialsOk:  true,
        devicesFound:   devices.length,
        counterDevice: deviceId ? {
          id:            deviceId,
          nickname:      terminal?.nickname ?? null,
          foundInFinix:  !!deviceInList,
          enabled:       deviceInList?.enabled ?? connection?.enabled ?? null,
          connection:    connection?.connection ?? null,
        } : null,
        allDevices: devices.map(d => ({
          id:           d.id,
          serialNumber: d.serialNumber,
          model:        d.model,
          enabled:      d.enabled,
        })),
      })
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      // If the Finix API returns 401/403, the credentials are wrong for this environment
      const isAuthError = message.includes('401') || message.includes('403') || message.includes('Unauthorized')
      return c.json({
        credentialsOk: false,
        error: message,
        hint: isAuthError
          ? 'Credentials are invalid for the current environment. If you recently switched from sandbox to production, update the Finix credentials in Payment Settings.'
          : 'Finix API call failed — check network connectivity and credentials.',
      }, isAuthError ? 401 : 502)
    }
  },
)

export { counter }
