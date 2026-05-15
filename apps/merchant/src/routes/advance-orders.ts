/**
 * Advance Orders — pre-paid orders placed days/weeks in advance.
 *
 * GET    /api/merchants/:id/advance-orders              list upcoming + recent
 * POST   /api/merchants/:id/advance-orders              create
 * PATCH  /api/merchants/:id/advance-orders/:aoId        edit items / time / status
 * DELETE /api/merchants/:id/advance-orders/:aoId        cancel (soft)
 * POST   /api/merchants/:id/advance-orders/:aoId/print  print kitchen + counter tickets
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant } from '../middleware/auth'
import type { AuthContext } from '../middleware/auth'
import { serverError } from '../utils/server-error'
import { printKitchenTicket, printCounterTicket } from '../services/printer'

const advanceOrders = new Hono()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AoRow = {
  id: string
  customer_name: string
  customer_phone: string | null
  scheduled_for: string
  items: string
  notes: string | null
  status: string
  reminder_24h_fired: number
  reminder_day_fired: number
  created_at: string
}

function mapRow(row: AoRow) {
  return {
    id: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    scheduledFor: row.scheduled_for,
    items: (() => { try { return JSON.parse(row.items) } catch { return [] } })(),
    notes: row.notes,
    status: row.status,
    reminder24hFired: row.reminder_24h_fired === 1,
    reminderDayFired: row.reminder_day_fired === 1,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/advance-orders
// Returns pending/ready orders from last 7 days onward, plus same-day cancels.
// ---------------------------------------------------------------------------
advanceOrders.get(
  '/api/merchants/:id/advance-orders',
  authenticate,
  requireOwnMerchant,
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    try {
      const db = getDatabase()
      const rows = db.query<AoRow, [string]>(
        `SELECT id, customer_name, customer_phone, scheduled_for, items, notes,
                status, reminder_24h_fired, reminder_day_fired, created_at
         FROM advance_orders
         WHERE merchant_id = ?
           AND (
             (status != 'cancelled' AND scheduled_for >= datetime('now', '-7 days'))
             OR (status = 'cancelled' AND scheduled_for >= datetime('now', '-1 days'))
           )
         ORDER BY scheduled_for ASC`
      ).all(merchantId)
      return c.json({ orders: rows.map(mapRow) })
    } catch (err) {
      return serverError(c, "[advance-orders]", err)
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/advance-orders
// ---------------------------------------------------------------------------
advanceOrders.post(
  '/api/merchants/:id/advance-orders',
  authenticate,
  requireOwnMerchant,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    let body: {
      customerName?: string
      customerPhone?: string
      scheduledFor?: string
      items?: Array<{ qty: number; description: string }>
      notes?: string
    }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    if (!body.customerName?.trim()) return c.json({ error: 'customerName required' }, 400)
    if (!body.scheduledFor)         return c.json({ error: 'scheduledFor required' }, 400)
    if (!Array.isArray(body.items) || body.items.length === 0)
      return c.json({ error: 'items required' }, 400)

    const items = body.items.filter((i) => i.description?.trim())
    if (items.length === 0) return c.json({ error: 'At least one item with a description is required' }, 400)

    try {
      const db = getDatabase()
      const id = generateId('ao')
      db.run(
        `INSERT INTO advance_orders (id, merchant_id, customer_name, customer_phone, scheduled_for, items, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          merchantId,
          body.customerName.trim(),
          body.customerPhone?.trim() || null,
          body.scheduledFor,
          JSON.stringify(items),
          body.notes?.trim() || null,
        ]
      )
      const row = db.query<AoRow, [string]>(
        `SELECT id, customer_name, customer_phone, scheduled_for, items, notes,
                status, reminder_24h_fired, reminder_day_fired, created_at
         FROM advance_orders WHERE id = ?`
      ).get(id)!
      return c.json(mapRow(row), 201)
    } catch (err) {
      return serverError(c, "[advance-orders]", err)
    }
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/advance-orders/:aoId
// ---------------------------------------------------------------------------
advanceOrders.patch(
  '/api/merchants/:id/advance-orders/:aoId',
  authenticate,
  requireOwnMerchant,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const aoId       = c.req.param('aoId')!
    let body: {
      customerName?:  string
      customerPhone?: string
      scheduledFor?:  string
      items?:  Array<{ qty: number; description: string }>
      notes?:  string
      status?: string
    }
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

    const db = getDatabase()
    const existing = db.query<{ id: string; status: string }, [string, string]>(
      `SELECT id, status FROM advance_orders WHERE id = ? AND merchant_id = ?`
    ).get(aoId, merchantId)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (existing.status === 'cancelled') return c.json({ error: 'Cannot edit a cancelled order' }, 409)

    const updates: string[]  = []
    const params: unknown[]  = []

    if (body.customerName  !== undefined) { updates.push('customer_name = ?');  params.push(body.customerName.trim()) }
    if (body.customerPhone !== undefined) { updates.push('customer_phone = ?'); params.push(body.customerPhone.trim() || null) }
    if (body.scheduledFor  !== undefined) {
      updates.push('scheduled_for = ?');    params.push(body.scheduledFor)
      // Reset reminder flags when the time changes
      updates.push('reminder_24h_fired = 0')
      updates.push('reminder_day_fired = 0')
    }
    if (body.items !== undefined) {
      const items = body.items.filter((i) => i.description?.trim())
      updates.push('items = ?'); params.push(JSON.stringify(items))
    }
    if (body.notes  !== undefined) { updates.push('notes = ?');  params.push(body.notes.trim() || null) }
    if (body.status !== undefined) {
      if (!['pending', 'ready', 'cancelled'].includes(body.status))
        return c.json({ error: 'Invalid status' }, 400)
      updates.push('status = ?'); params.push(body.status)
    }

    if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)

    try {
      params.push(aoId)
      db.run(`UPDATE advance_orders SET ${updates.join(', ')} WHERE id = ?`, params as string[])
      const row = db.query<AoRow, [string]>(
        `SELECT id, customer_name, customer_phone, scheduled_for, items, notes,
                status, reminder_24h_fired, reminder_day_fired, created_at
         FROM advance_orders WHERE id = ?`
      ).get(aoId)!
      return c.json(mapRow(row))
    } catch (err) {
      return serverError(c, "[advance-orders]", err)
    }
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/advance-orders/:aoId   (soft cancel)
// ---------------------------------------------------------------------------
advanceOrders.delete(
  '/api/merchants/:id/advance-orders/:aoId',
  authenticate,
  requireOwnMerchant,
  (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const aoId       = c.req.param('aoId')!
    const db = getDatabase()
    const existing = db.query<{ id: string }, [string, string]>(
      `SELECT id FROM advance_orders WHERE id = ? AND merchant_id = ?`
    ).get(aoId, merchantId)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    try {
      db.run(`UPDATE advance_orders SET status = 'cancelled' WHERE id = ?`, [aoId])
      return c.json({ success: true })
    } catch (err) {
      return serverError(c, "[advance-orders]", err)
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/advance-orders/:aoId/print
// ---------------------------------------------------------------------------
advanceOrders.post(
  '/api/merchants/:id/advance-orders/:aoId/print',
  authenticate,
  requireOwnMerchant,
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')!
    const aoId       = c.req.param('aoId')!
    const db = getDatabase()

    type AoWithMerchant = AoRow & {
      merchant_name:             string
      printer_ip:                string | null
      counter_printer_ip:        string | null
      kitchen_printer_protocol:  string | null
      counter_printer_protocol:  string | null
      receipt_style:             string | null
      timezone:                  string | null
    }

    const row = db.query<AoWithMerchant, [string, string]>(
      `SELECT ao.id, ao.customer_name, ao.customer_phone, ao.scheduled_for,
              ao.items, ao.notes, ao.status,
              ao.reminder_24h_fired, ao.reminder_day_fired, ao.created_at,
              m.business_name AS merchant_name,
              m.printer_ip, m.counter_printer_ip,
              m.kitchen_printer_protocol, m.counter_printer_protocol,
              m.receipt_style, m.timezone
       FROM advance_orders ao
       JOIN merchants m ON m.id = ao.merchant_id
       WHERE ao.id = ? AND ao.merchant_id = ?`
    ).get(aoId, merchantId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const items: Array<{ qty: number; description: string }> = (() => {
      try { return JSON.parse(row.items) } catch { return [] }
    })()

    const tz = row.timezone ?? 'America/Los_Angeles'
    const scheduledDate = new Date(
      row.scheduled_for.endsWith('Z') || row.scheduled_for.includes('+')
        ? row.scheduled_for : row.scheduled_for + 'Z'
    )
    const scheduledLabel = scheduledDate.toLocaleString('en-US', {
      timeZone: tz, month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })

    const printItems = items.map((item) => ({
      quantity: item.qty,
      dishName: item.description,
      priceCents: 0,
    }))

    const kitchenIp       = row.printer_ip || process.env.PRINTER_IP || ''
    const kitchenProtocol = (row.kitchen_printer_protocol ?? 'star-line') as
      'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
    const counterIp       = row.counter_printer_ip || kitchenIp
    const counterProtocol = (row.counter_printer_protocol ?? row.kitchen_printer_protocol ?? 'star-line') as
      'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
    const receiptStyle    = (row.receipt_style ?? 'classic') as 'classic' | 'html'

    const baseOpts = {
      orderId:      aoId,
      orderType:    'pickup' as const,
      receiptStyle,
      merchantName: row.merchant_name,
      customerName: row.customer_name,
      notes:        `ADVANCE ORDER — ${scheduledLabel}${row.customer_phone ? `\nPhone: ${row.customer_phone}` : ''}${row.notes ? `\n${row.notes}` : ''}`,
      items:        printItems,
      timezone:     tz,
      createdAt:    row.created_at,
    }

    try {
      await printKitchenTicket({ ...baseOpts, printerIp: kitchenIp, printerProtocol: kitchenProtocol })

      // Brief pause when both tickets go to the same physical printer so the
      // cutter fires before the next TCP connection arrives.
      if (counterIp === kitchenIp) await new Promise(r => setTimeout(r, 500))

      await printCounterTicket({ ...baseOpts, printerIp: counterIp, printerProtocol: counterProtocol })

      return c.json({ success: true })
    } catch (err) {
      return serverError(c, "[advance-orders]", err)
    }
  }
)

export { advanceOrders }
