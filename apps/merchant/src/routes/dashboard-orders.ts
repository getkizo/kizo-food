/**
 * Dashboard order routes — staff-facing order management.
 *
 *   GET    /api/merchants/:id/orders                      — list orders (date range)
 *   POST   /api/merchants/:id/orders                      — create walk-in / phone order
 *   GET    /api/merchants/:id/orders/:orderId             — single order detail
 *   PATCH  /api/merchants/:id/orders/:orderId/status      — update status
 *   POST   /api/merchants/:id/orders/:orderId/print-*     — kitchen / counter / receipt
 *   POST   /api/merchants/:id/orders/sync                 — pull orders from Clover
 *
 * ── SINGLE-MERCHANT APPLIANCE ──────────────────────────────────────────────
 * The `:id` in every path is the merchant's stable UUID carried in the JWT.
 * `requireOwnMerchant` validates that the JWT owner matches `:id` — this is
 * an authentication check, NOT a multi-tenant isolation filter.
 *
 * There is only one merchant per appliance. Queries do not need an additional
 * WHERE merchant_id = ? filter to prevent cross-tenant leakage; the entire
 * SQLite database belongs to this single merchant. Code reviews should NOT
 * flag missing tenant-isolation patterns as a security concern.
 *
 * The merchant_id foreign key on the orders table exists for integrity and
 * for stable cross-referencing by third-party delivery platforms.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Hono } from 'hono'
import { serverError } from '../utils/server-error'
import { getDatabase } from '../db/connection'
import { authenticate, requireRole } from '../middleware/auth'
import { getAPIKey, getPOSMerchantId } from '../crypto/api-keys'
import { CloverPOSAdapter } from '../adapters/clover'
import { generateId } from '../utils/id'
import { printKitchenTicket, printCounterTicket, printCustomerReceipt, printCustomerBill, kitchenItems, course1Items, course2Items } from '../services/printer'
import { enrichItemsWithCategory } from '../utils/print-items'
import type { OrderItemShape } from '../utils/print-items'
import { notifyCustomer } from './push'
import { CloverOrderClient } from '../services/clover-order-client'
import { notifyCloverPaymentInitiated } from '../services/clover-reconcile-signal'

const cloverClient = new CloverOrderClient()
import { broadcastToMerchant } from '../services/sse'
import { acquireLock, releaseLock, isPaymentLocked } from '../services/order-locks'
import { sendOrderReadyEmail } from '../services/email'
import type { AuthContext } from '../middleware/auth'

/** Modifier shape as stored inside the orders.items JSON column. */
interface ParsedModifier {
  name: string
  priceCents?: number
  price_cents?: number
}

/** Order item shape as stored inside the orders.items JSON column. */
interface ParsedOrderItem {
  dishId?: string
  itemId?: string
  dishName?: string
  name?: string
  quantity: number
  priceCents?: number
  price_cents?: number
  modifiers?: ParsedModifier[]
  courseOrder?: number
  printDestination?: string
  specialInstructions?: string
}

/** Give the printer time to execute the cut before opening a second TCP connection. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const dashboardOrders = new Hono()

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders
// Create a new order from the dashboard (walk-in, phone, dine-in).
// Saves locally and submits to Clover if API key is configured.
// Body: {
//   orderType: 'dine_in' | 'pickup' | 'delivery'
//   customerName: string
//   customerPhone?: string
//   customerEmail?: string
//   notes?: string
//   utensilsNeeded?: boolean
//   tableLabel?: string    -- e.g. "Table 4" (dine-in)
//   roomLabel?: string     -- e.g. "Patio" (dine-in)
//   courseMode?: boolean   -- true = coursed meal (grouping only, no timers)
//   items: Array<{
//     itemId: string
//     name: string
//     priceCents: number
//     quantity: number
//     selectedModifiers?: Array<{ modifierId: string; name: string; priceCents: number }>
//   }>
// }
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    const body = await c.req.json<{
      orderType?: string
      customerName: string
      customerPhone?: string
      customerEmail?: string
      notes?: string
      utensilsNeeded?: boolean
      tableLabel?: string
      roomLabel?: string
      courseMode?: boolean
      /** Cents actually charged (subtotal + tax + tip) — triggers receipt printing when set */
      paidAmountCents?: number
      /** Tip amount in cents (0 if no tip) */
      tipCents?: number
      /** 'cash' | 'card' */
      paymentMethod?: 'cash' | 'card'
      /** Finix checkout form ID — stored so refunds can resolve the transfer */
      checkoutFormId?: string
      /** Converge ssl_txn_id or pre-resolved Finix transfer ID — stored for refund processing */
      transferId?: string
      /** 'en' | 'es' — ticket/receipt language (defaults to 'en') */
      printLanguage?: string
      /** Employee who took this order (from employee mode) */
      employeeId?: string
      employeeNickname?: string
      /** ISO timestamp: when the customer wants the order ready (scheduled orders) */
      scheduledFor?: string
      /** Minutes to delay course-2 kitchen print (coursed dine-in only) */
      courseDelayMinutes?: number
      items: Array<{
        itemId: string
        name: string
        priceCents: number
        quantity: number
        selectedModifiers?: Array<{ modifierId: string; name: string; priceCents: number }>
        serverNotes?: string
      }>
    }>()

    if (!body.customerName?.trim()) {
      return c.json({ error: 'customerName is required' }, 400)
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return c.json({ error: 'Order must contain at least one item' }, 400)
    }

    // H-07: Validate item quantities — must be positive integers, bounded
    for (const item of body.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) {
        return c.json({ error: 'Each item quantity must be an integer between 1 and 999' }, 400)
      }
      if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
        return c.json({ error: 'Each item priceCents must be a non-negative integer' }, 400)
      }
    }

    const db = getDatabase()

    // Calculate totals
    let subtotalCents = 0
    const enrichedItems = body.items.map((item) => {
      const modifierTotal = (item.selectedModifiers ?? []).reduce((s, m) => s + m.priceCents, 0)
      const lineCents = (item.priceCents + modifierTotal) * item.quantity
      subtotalCents += lineCents
      return {
        itemId: item.itemId,
        dishName: item.name,
        quantity: item.quantity,
        priceCents: item.priceCents,
        modifiers: item.selectedModifiers ?? [],
        lineTotalCents: lineCents,
        serverNotes: item.serverNotes ?? undefined,
      }
    })

    const totalCents = subtotalCents // tax handled by POS

    const orderId = generateId('ord')
    const orderType = body.orderType ?? 'pickup'
    // Orders created via the Pay flow (paidAmountCents present) start as 'paid'
    const initialStatus = body.paidAmountCents && body.paidAmountCents > 0 ? 'paid' : 'received'

    // Validate scheduledFor (must be a future ISO timestamp if provided)
    let scheduledFor: string | null = null
    if (body.scheduledFor) {
      const ts = new Date(body.scheduledFor).getTime()
      if (!isNaN(ts) && ts > Date.now()) {
        scheduledFor = new Date(body.scheduledFor).toISOString()
      }
    }

    db.run(
      `INSERT INTO orders (
         id, merchant_id, customer_name, customer_phone, customer_email,
         items, subtotal_cents, tax_cents, total_cents,
         status, order_type, source, notes, utensils_needed,
         table_label, room_label, course_mode,
         employee_id, employee_nickname,
         tip_cents, paid_amount_cents, payment_method, payment_checkout_form_id, payment_transfer_id,
         pickup_time, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'dashboard', ?, ?,
                 ?, ?, ?,
                 ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, datetime('now'), datetime('now'))`,
      [
        orderId,
        merchantId,
        body.customerName.trim(),
        body.customerPhone?.trim() ?? null,
        body.customerEmail?.trim() ?? null,
        JSON.stringify(enrichedItems),
        subtotalCents,
        totalCents,
        initialStatus,
        orderType,
        body.notes?.trim() ?? null,
        body.utensilsNeeded ? 1 : 0,
        body.tableLabel?.trim() ?? null,
        body.roomLabel?.trim() ?? null,
        body.courseMode ? 1 : 0,
        body.employeeId ?? null,
        body.employeeNickname ?? null,
        body.tipCents ?? 0,
        body.paidAmountCents ?? 0,
        body.paymentMethod ?? null,
        body.checkoutFormId ?? null,
        body.transferId ?? null,
        scheduledFor,
      ]
    )

    // Fire-and-forget receipt printing — never block order confirmation
    ;(async () => {
      try {
        const merchant = db
          .query<{
            printer_ip: string | null
            counter_printer_ip: string | null
            receipt_printer_ip: string | null
            kitchen_printer_protocol: string | null
            counter_printer_protocol: string | null
            receipt_printer_protocol: string | null
            receipt_style: string | null
            business_name: string
            tax_rate: number
          }, [string]>(
            `SELECT printer_ip, counter_printer_ip, receipt_printer_ip,
                    kitchen_printer_protocol, counter_printer_protocol, receipt_printer_protocol,
                    receipt_style, business_name, tax_rate FROM merchants WHERE id = ?`
          )
          .get(merchantId)

        // Fallback chain: specific IP → kitchen IP → env var
        const kitchenIp = merchant?.printer_ip || process.env.PRINTER_IP
        if (!kitchenIp) return

        const counterIp = merchant?.counter_printer_ip || kitchenIp
        const receiptIp = merchant?.receipt_printer_ip || kitchenIp

        const kitchenProtocol = (merchant?.kitchen_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
        const counterProtocol = (merchant?.counter_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
        const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

        // Enrich items with category course/destination info from the DB
        const printItems = enrichItemsWithCategory(enrichedItems)

        const baseOpts = {
          orderId,
          orderType,
          printLanguage: body.printLanguage ?? 'en',
          merchantName: merchant?.business_name ?? null,
          customerName: body.customerName.trim(),
          tableLabel: body.tableLabel ?? null,
          roomLabel: body.roomLabel ?? null,
          notes: body.notes ?? null,
          utensilsNeeded: body.utensilsNeeded ?? false,
          items: printItems,
          createdAt: new Date().toISOString(),
          receiptStyle,
        }

        // Kitchen ticket — skip for scheduled orders (auto-fire prints at the right time)
        if (scheduledFor) {
          console.log(`[dashboard-orders] ⏰  Scheduled order ${orderId} — kitchen ticket deferred to auto-fire at ${scheduledFor}`)
          return
        }

        const courseDelayMinutes = body.courseDelayMinutes ?? 0
        const hasCourse1 = course1Items(printItems).length > 0
        const hasCourse2 = course2Items(printItems).length > 0
        const isCoursingOrder = body.courseMode && courseDelayMinutes > 0 && hasCourse2

        let webprntFallbackUsed = false
        const fallbackIps = new Set<string>()

        if (isCoursingOrder && hasCourse1) {
          // Print course-1 (numbered categories) immediately
          const kitchenResult = await printKitchenTicket({ ...baseOpts, items: course1Items(printItems), printerIp: kitchenIp, printerProtocol: kitchenProtocol })
          if (kitchenResult.webprntFallbackUsed) { webprntFallbackUsed = true; fallbackIps.add(kitchenIp) }
          console.log(`[dashboard-orders] 🖨️  Kitchen ticket (course 1) printed for order ${orderId}`)

          // Schedule course-2 (mains) for later
          const fireAt = new Date(Date.now() + courseDelayMinutes * 60_000).toISOString()
          db.run(
            `INSERT INTO pending_course_fires (merchant_id, order_id, course, fire_at, printer_ip, printer_protocol, print_language)
             VALUES (?, ?, 2, ?, ?, ?, ?)`,
            [merchantId, orderId, fireAt, kitchenIp, kitchenProtocol, body.printLanguage ?? 'en']
          )
          console.log(`[dashboard-orders] ⏰  Course-2 kitchen print for ${orderId} scheduled at ${fireAt}`)
        } else if (kitchenItems(printItems).length > 0) {
          // No coursing — print all kitchen-destined items now
          const kitchenResult = await printKitchenTicket({ ...baseOpts, printerIp: kitchenIp, printerProtocol: kitchenProtocol })
          if (kitchenResult.webprntFallbackUsed) { webprntFallbackUsed = true; fallbackIps.add(kitchenIp) }
          console.log(`[dashboard-orders] 🖨️  Kitchen ticket printed for order ${orderId}`)
        }

        // Let the printer finish executing the cut before opening a second connection.
        // Without this delay, consecutive TCP jobs to the same printer can arrive before
        // the cutter fires, causing the next job's header bytes to print on the same paper.
        if (counterIp === kitchenIp) await sleep(500)

        // Counter ticket — always printed on Fire (server copy for packing/delivery)
        // Counter always receives ALL items regardless of print_destination setting
        const counterResult = await printCounterTicket({ ...baseOpts, printerIp: counterIp, printerProtocol: counterProtocol })
        if (counterResult.webprntFallbackUsed) { webprntFallbackUsed = true; fallbackIps.add(counterIp) }
        console.log(`[dashboard-orders] 🖨️  Counter ticket printed for order ${orderId}`)

        if (webprntFallbackUsed) {
          const ipList = Array.from(fallbackIps).map(ip => `http://${ip}/`).join(' or ')
          broadcastToMerchant(merchantId, 'printer_warning', {
            message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open ${ipList} in your browser to enable it (login: root / public).`,
          })
        }

        // Customer receipt is NOT printed automatically — server prompts customer
        // and prints on demand via POST /print-receipt
      } catch (err) {
        // Log but never fail the order — printer is always best-effort
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[dashboard-orders] ⚠️  Print failed for order ${orderId}:`, errMsg)
        broadcastToMerchant(merchantId, 'print_error', {
          orderId,
          context: 'new_order',
          message: errMsg,
        })
      }
    })()

    // Push order to Clover Flex terminal (fire-and-forget — never blocks response)
    if (cloverClient.isEnabled()) {
      notifyCloverPaymentInitiated()
      const cloverMerchant = db.query<{ tax_rate: number }, [string]>(
        `SELECT tax_rate FROM merchants WHERE id = ?`
      ).get(merchantId)
      cloverClient.pushOrder(
        {
          id: orderId,
          merchant_id: merchantId,
          customer_name: body.customerName.trim(),
          order_type: orderType,
          table_label: body.tableLabel?.trim() ?? null,
          notes: body.notes ?? null,
          clover_order_id: null,
          items: enrichedItems,
          tax_rate: cloverMerchant?.tax_rate ?? null,
        },
        db
      ).catch((err: unknown) => {
        console.error('[clover] pushOrder failed:', err instanceof Error ? err.message : err)
      })
    }

    return c.json({ orderId, totalCents, status: initialStatus }, 201)
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/orders/:orderId
// Update items (and optionally metadata) of an existing order.
// Recalculates subtotal/total. Optionally reprints kitchen ticket.
// Body: {
//   items: Array<{ itemId, name, priceCents, quantity, selectedModifiers? }>
//   customerName?: string
//   notes?: string
//   tableLabel?: string
//   roomLabel?: string
//   printLanguage?: string
//   reprintTicket?: boolean   -- send a new kitchen ticket after updating
// }
// ---------------------------------------------------------------------------
dashboardOrders.patch(
  '/api/merchants/:id/orders/:orderId',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    const body = await c.req.json<{
      items: Array<{
        itemId: string
        name: string
        priceCents: number
        quantity: number
        selectedModifiers?: Array<{ modifierId: string; name: string; priceCents: number }>
        serverNotes?: string
      }>
      customerName?: string
      notes?: string
      tableLabel?: string
      roomLabel?: string
      printLanguage?: string
      reprintTicket?: boolean
    }>()

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return c.json({ error: 'items array is required' }, 400)
    }

    const order = db
      .query<{ id: string; status: string; order_type: string; pickup_code: string | null; notes: string | null; utensils_needed: number; items: string }, [string, string]>(
        `SELECT id, status, order_type, pickup_code, notes, utensils_needed, items FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    if (isPaymentLocked(orderId)) {
      return c.json({ error: 'This order has a payment in progress and cannot be modified' }, 409)
    }

    // Build old-item quantity map for diff (new items only reprint)
    let oldItemQty: Map<string, number>
    try {
      const oldItems: OrderItemShape[] = JSON.parse(order.items || '[]')
      oldItemQty = new Map(oldItems.map((i) => [i.itemId ?? i.dishId ?? '', i.quantity ?? 1]))
    } catch {
      oldItemQty = new Map()
    }

    const enrichedItems = body.items.map((item) => {
      const mods = item.selectedModifiers ?? []
      const modCents = mods.reduce((s, m) => s + m.priceCents, 0)
      const lineCents = (item.priceCents + modCents) * item.quantity
      return {
        itemId: item.itemId,
        dishName: item.name,
        quantity: item.quantity,
        priceCents: item.priceCents,
        modifiers: mods,
        lineTotalCents: lineCents,
        serverNotes: item.serverNotes ?? undefined,
      }
    })

    const subtotalCents = enrichedItems.reduce((s, i) => s + i.lineTotalCents, 0)

    // Build update: only touch provided optional fields
    const updates: string[] = [
      'items = ?',
      'subtotal_cents = ?',
      'total_cents = ?',
      'status = CASE WHEN status IN (\'cancelled\', \'picked_up\', \'completed\', \'paid\') THEN \'received\' ELSE status END',
      'updated_at = datetime(\'now\')',
    ]
    const params: unknown[] = [JSON.stringify(enrichedItems), subtotalCents, subtotalCents]

    if (body.customerName !== undefined) { updates.push('customer_name = ?'); params.push(body.customerName.trim()) }
    if (body.notes !== undefined)        { updates.push('notes = ?');         params.push(body.notes.trim() || null) }
    if (body.tableLabel !== undefined)   { updates.push('table_label = ?');   params.push(body.tableLabel.trim() || null) }
    if (body.roomLabel !== undefined)    { updates.push('room_label = ?');    params.push(body.roomLabel.trim() || null) }

    params.push(orderId)
    // SECURITY (M-05): All SET field names above are hardcoded string literals —
    // never interpolate user-controlled strings into this template.
    db.run(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params)

    // Aggregate new total quantity per itemId across all cart entries.
    // A dish may appear as separate entries (e.g. re-added via modal) rather than
    // a single incremented entry — treat them as a combined quantity for the diff.
    const newQtyByItemId = new Map<string, number>()
    for (const item of enrichedItems) {
      newQtyByItemId.set(item.itemId, (newQtyByItemId.get(item.itemId) ?? 0) + item.quantity)
    }

    // Compute added/increased items for diff-based reprint (one entry per itemId)
    const seenItemIds = new Set<string>()
    const addedItems = enrichedItems
      .map(item => {
        if (seenItemIds.has(item.itemId)) return null
        seenItemIds.add(item.itemId)
        const newTotalQty = newQtyByItemId.get(item.itemId)!
        const oldQty = oldItemQty.get(item.itemId) ?? 0
        const deltaQty = newTotalQty - oldQty
        if (deltaQty <= 0) return null
        const modCents = item.modifiers.reduce((s: number, m: ParsedModifier) => s + (m.priceCents ?? m.price_cents ?? 0), 0)
        return {
          ...item,
          quantity: deltaQty,
          lineTotalCents: (item.priceCents + modCents) * deltaQty,
        }
      })
      .filter((i): i is NonNullable<typeof i> => i !== null)

    // Re-fetch for printing — only prints newly added items, not the full order
    if (body.reprintTicket && addedItems.length > 0) {
      ;(async () => {
        try {
          const merchant = db
            .query<{
              printer_ip: string | null
              counter_printer_ip: string | null
              kitchen_printer_protocol: string | null
              counter_printer_protocol: string | null
              receipt_style: string | null
              business_name: string
            }, [string]>(
              `SELECT printer_ip, counter_printer_ip,
                      kitchen_printer_protocol, counter_printer_protocol,
                      receipt_style, business_name FROM merchants WHERE id = ?`
            )
            .get(merchantId)

          const kitchenIp = merchant?.printer_ip || process.env.PRINTER_IP
          if (!kitchenIp) return

          const counterIp = merchant?.counter_printer_ip || kitchenIp
          const kitchenProtocol = (merchant?.kitchen_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
          const counterProtocol = (merchant?.counter_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
          const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

          const enrichedAddedItems = enrichItemsWithCategory(addedItems)

          const baseOpts = {
            orderId,
            orderType: order.order_type,
            printLanguage: body.printLanguage ?? 'en',
            merchantName: merchant?.business_name ?? null,
            customerName: body.customerName?.trim() ?? null,
            tableLabel: body.tableLabel ?? null,
            roomLabel: body.roomLabel ?? null,
            notes: order.notes ?? null,
            utensilsNeeded: order.utensils_needed === 1,
            pickupCode: order.pickup_code,
            items: enrichedAddedItems,
            createdAt: new Date().toISOString(),
            receiptStyle,
          }

          const kitchenResult = await printKitchenTicket({ ...baseOpts, printerIp: kitchenIp, printerProtocol: kitchenProtocol })
          console.log(`[dashboard-orders] 🖨️  Kitchen ticket printed for ${addedItems.length} new item(s) on order ${orderId}`)

          if (counterIp === kitchenIp) await sleep(500)

          const counterResult = await printCounterTicket({ ...baseOpts, printerIp: counterIp, printerProtocol: counterProtocol })
          console.log(`[dashboard-orders] 🖨️  Counter ticket printed for ${addedItems.length} new item(s) on order ${orderId}`)

          const fallbackIps = new Set<string>()
          if (kitchenResult.webprntFallbackUsed) fallbackIps.add(kitchenIp)
          if (counterResult.webprntFallbackUsed) fallbackIps.add(counterIp)
          if (fallbackIps.size > 0) {
            const ipList = Array.from(fallbackIps).map(ip => `http://${ip}/`).join(' or ')
            broadcastToMerchant(merchantId, 'printer_warning', {
              message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open ${ipList} in your browser to enable it (login: root / public).`,
            })
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[dashboard-orders] ⚠️  Reprint failed for updated order ${orderId}:`, errMsg)
          broadcastToMerchant(merchantId, 'print_error', {
            orderId,
            context: 'order_edit',
            message: errMsg,
          })
        }
      })()
    }

    // Auto-release edit lock on successful update
    releaseLock(orderId)

    return c.json({ orderId, subtotalCents, totalCents: subtotalCents })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/lock
// Acquire an in-memory edit lock so two tablets can't edit the same order.
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/:orderId/lock',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const orderId = c.req.param('orderId')
    const body = await c.req.json<{ employeeId?: string; employeeName?: string }>().catch(() => ({}))
    const employeeId   = body.employeeId   || c.get('userId') || 'unknown'
    const employeeName = body.employeeName || 'Someone'

    const result = acquireLock(orderId, employeeId, employeeName)
    if (!result.ok) {
      return c.json({ error: `This order is being edited by ${result.lockedBy}` }, 409)
    }
    return c.json({ locked: true })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/orders/:orderId/lock
// Release an edit lock (on cancel-edit or when the client cleans up).
// ---------------------------------------------------------------------------
dashboardOrders.delete(
  '/api/merchants/:id/orders/:orderId/lock',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const orderId = c.req.param('orderId')
    // Body is optional for DELETE — parse leniently
    const body = await c.req.json<{ employeeId?: string }>().catch(() => ({}))
    const employeeId = body.employeeId || c.get('userId') || 'unknown'

    releaseLock(orderId, employeeId)
    return c.json({ unlocked: true })
  }
)

// ---------------------------------------------------------------------------
// DELETE /api/merchants/:id/orders/:orderId
// Permanently remove an order. Restricted to owner/manager.
// ---------------------------------------------------------------------------
dashboardOrders.delete(
  '/api/merchants/:id/orders/:orderId',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    const order = db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    db.run(`DELETE FROM orders WHERE id = ?`, [orderId])

    return c.json({ ok: true })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/orders/:orderId/status
// Advance or set order status manually.
// Body: { status, estimatedMinutes?, paidAmountCents?, tipCents?, paymentMethod? }
// Also attempts to push status to Clover if a POS order ID exists.
// ---------------------------------------------------------------------------
dashboardOrders.patch(
  '/api/merchants/:id/orders/:orderId/status',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')

    const VALID_STATUSES = ['submitted', 'confirmed', 'preparing', 'ready', 'picked_up', 'cancelled', 'paid'] as const
    type ValidStatus = typeof VALID_STATUSES[number]

    // C-03: Explicit status transition map — only allowed transitions are permitted.
    // 'cancelled' is reachable from any pre-terminal status (staff can cancel at any point).
    // 'picked_up' is the terminal status for online orders (customer collected their order).
    // 'paid' is the terminal status for dine-in/takeout orders (payment recorded).
    const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
      pending_payment: ['cancelled'],  // online order abandoned before payment completed
      submitted: ['confirmed', 'preparing', 'paid', 'cancelled'],
      received:  ['confirmed', 'preparing', 'paid', 'cancelled'],
      confirmed: ['preparing', 'ready', 'paid', 'cancelled'],
      preparing: ['ready', 'paid', 'cancelled'],
      ready:     ['picked_up', 'paid', 'cancelled'],
      // 'picked_up', 'cancelled', and 'paid' are terminal — no outbound transitions
    }

    const body = await c.req.json<{
      status: string
      paidAmountCents?: number
      tipCents?: number
      paymentMethod?: 'cash' | 'card'
      estimatedMinutes?: number
      /** Finix checkout form ID — stored so refunds can resolve the transfer */
      checkoutFormId?: string
      /** Converge ssl_txn_id or pre-resolved Finix transfer ID — stored for refund processing */
      transferId?: string
    }>()
    const { status } = body

    if (!VALID_STATUSES.includes(status as ValidStatus)) {
      return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400)
    }

    const db = getDatabase()

    const order = db
      .query<{
        id: string; status: string; pos_order_id: string | null
        customer_name: string | null; order_type: string
        items: string; subtotal_cents: number; tax_cents: number
        table_label: string | null; room_label: string | null
        notes: string | null; created_at: string; pickup_time: string | null
      }, [string, string]>(
        `SELECT id, status, pos_order_id, customer_name, order_type,
                items, subtotal_cents, tax_cents, table_label, room_label,
                notes, created_at, pickup_time
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    if (isPaymentLocked(orderId)) {
      return c.json({ error: 'This order has a payment in progress and cannot be modified' }, 409)
    }

    // C-03: Validate status transition
    const allowedNext = ALLOWED_TRANSITIONS[order.status]
    if (!allowedNext || !allowedNext.includes(status)) {
      return c.json(
        { error: `Cannot transition from '${order.status}' to '${status}'` },
        422,
      )
    }

    // Optimistic concurrency control: the UPDATE predicate includes AND status = ?
    // (the status we read above). If another request already advanced the order
    // between our SELECT and this UPDATE, changes will be 0 and we return 409.
    // SQLite WAL serializes the actual write, so the predicate is evaluated
    // atomically — at most one concurrent request will see changes = 1.
    const currentStatus = order.status

    // When accepting an order, store the estimated ready time.
    // Scheduled orders already have a pickup_time — use that instead of
    // computing now + estimatedMinutes (which would show the current time).
    let result: { changes: number }
    if (status === 'preparing') {
      const readyAt = order.pickup_time
        ?? (body.estimatedMinutes
            ? new Date(Date.now() + body.estimatedMinutes * 60_000).toISOString()
            : null)
      result = db.run(
        `UPDATE orders SET status = ?, estimated_ready_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = ?`,
        [status, readyAt, orderId, currentStatus]
      )
    // When marking as 'paid', also store payment details if provided
    } else if (status === 'paid' && (body.tipCents || body.paidAmountCents || body.paymentMethod)) {
      result = db.run(
        `UPDATE orders SET status = ?, tip_cents = COALESCE(?, tip_cents),
         paid_amount_cents = COALESCE(?, paid_amount_cents),
         payment_method = COALESCE(?, payment_method),
         payment_checkout_form_id = COALESCE(?, payment_checkout_form_id),
         payment_transfer_id = COALESCE(?, payment_transfer_id),
         updated_at = datetime('now') WHERE id = ? AND status = ?`,
        [status, body.tipCents ?? null, body.paidAmountCents ?? null, body.paymentMethod ?? null, body.checkoutFormId ?? null, body.transferId ?? null, orderId, currentStatus]
      )
    } else {
      result = db.run(
        `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`,
        [status, orderId, currentStatus]
      )
    }

    if (result.changes === 0) {
      return c.json(
        { error: 'Order status changed concurrently — please refresh and try again' },
        409,
      )
    }

    // Fire kitchen + counter tickets when accepting an online order
    if (status === 'preparing' && (order.status === 'submitted' || order.status === 'confirmed')) {
      ;(async () => {
        try {
          const merchant = db
            .query<{
              printer_ip: string | null
              counter_printer_ip: string | null
              kitchen_printer_protocol: string | null
              counter_printer_protocol: string | null
              receipt_style: string | null
              business_name: string
            }, [string]>(
              `SELECT printer_ip, counter_printer_ip,
                      kitchen_printer_protocol, counter_printer_protocol,
                      receipt_style, business_name FROM merchants WHERE id = ?`
            )
            .get(merchantId)

          const kitchenIp = merchant?.printer_ip || process.env.PRINTER_IP
          if (!kitchenIp) return

          const counterIp = merchant?.counter_printer_ip || kitchenIp
          const kitchenProtocol = (merchant?.kitchen_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
          const counterProtocol = (merchant?.counter_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
          const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

          let rawItems: Array<{ name: string; qty: number; priceCents: number; modifiers?: unknown[]; totalCents?: number; categoryId?: string }>
          try { rawItems = JSON.parse(order.items) } catch {
            console.error('[dashboard-orders] Malformed items JSON for order', order.id)
            return c.json({ error: 'Order items data is corrupt' }, 500)
          }

          const printItems = enrichItemsWithCategory(rawItems)

          const baseOpts = {
            orderId,
            orderType: order.order_type,
            printLanguage: 'en',
            merchantName: merchant?.business_name ?? null,
            customerName: order.customer_name ?? null,
            tableLabel: order.table_label ?? null,
            roomLabel: order.room_label ?? null,
            notes: order.notes ?? null,
            utensilsNeeded: false,
            items: printItems,
            createdAt: order.created_at,
            receiptStyle,
          }

          const fallbackIps = new Set<string>()

          if (kitchenItems(printItems).length > 0) {
            const kitchenResult = await printKitchenTicket({ ...baseOpts, printerIp: kitchenIp, printerProtocol: kitchenProtocol })
            if (kitchenResult.webprntFallbackUsed) fallbackIps.add(kitchenIp)
            console.log(`[dashboard-orders] 🖨️  Kitchen ticket fired for accepted order ${orderId}`)
          }

          if (counterIp === kitchenIp) await sleep(500)

          const counterResult = await printCounterTicket({ ...baseOpts, printerIp: counterIp, printerProtocol: counterProtocol })
          if (counterResult.webprntFallbackUsed) fallbackIps.add(counterIp)
          console.log(`[dashboard-orders] 🖨️  Counter ticket fired for accepted order ${orderId}`)

          if (fallbackIps.size > 0) {
            const ipList = Array.from(fallbackIps).map(ip => `http://${ip}/`).join(' or ')
            broadcastToMerchant(merchantId, 'printer_warning', {
              message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open ${ipList} in your browser to enable it (login: root / public).`,
            })
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[dashboard-orders] ⚠️  Print failed on accept for order ${orderId}:`, errMsg)
          broadcastToMerchant(merchantId, 'print_error', {
            orderId,
            context: 'order_accept',
            message: errMsg,
          })
        }
      })()
    }

    // Notify customer when their order is accepted and sent to kitchen
    if (status === 'preparing') {
      let acceptBody = 'Your order has been accepted and is being prepared.'
      if (order.pickup_time) {
        const t = new Date(order.pickup_time)
        const hhmm = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        acceptBody = `Your order is scheduled for pickup at ${hhmm}.`
      } else if (body.estimatedMinutes) {
        acceptBody = `We're preparing your order. Estimated ready in ~${body.estimatedMinutes} minutes.`
      }
      // fire-and-forget: order already committed; push errors logged only
      notifyCustomer(orderId, {
        title: 'Order accepted!',
        body:  acceptBody,
        data:  { type: 'order_accepted', orderId },
      }).catch(err => console.warn('[push] customer notify failed for order', orderId, err?.message ?? err))
    }

    // fire-and-forget: order already committed; push errors logged only
    if (status === 'ready') {
      notifyCustomer(orderId, {
        title: 'Your order is ready! 🎉',
        body:  `Show your pickup code at the counter.`,
        data:  { type: 'order_ready', orderId },
      }).catch(err => console.warn('[push] customer notify failed for order', orderId, err?.message ?? err))
      sendOrderReadyEmail(merchantId, orderId)
        .catch(err => console.warn('[email] Ready notification failed for order', orderId, err?.message ?? err))
    }

    // fire-and-forget: order already committed; push errors logged only
    if (status === 'picked_up') {
      notifyCustomer(orderId, {
        title: 'Order picked up',
        body:  'Thanks for your order! Enjoy your meal.',
        data:  { type: 'order_picked_up', orderId },
      }).catch(err => console.warn('[push] customer notify failed for order', orderId, err?.message ?? err))
    }

    // Broadcast status change to all connected dashboard SSE clients
    broadcastToMerchant(merchantId, 'order_updated', { orderId, status })

    return c.json({ orderId, status })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/reprint
// Re-sends the kitchen ticket for an existing order to the printer.
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/:orderId/reprint',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    const order = db
      .query<{
        id: string; customer_name: string | null; order_type: string
        items: string; table_label: string | null; room_label: string | null
        notes: string | null; utensils_needed: number; created_at: string; pickup_code: string | null
      }, [string, string]>(
        `SELECT id, customer_name, order_type, items, table_label, room_label, notes, utensils_needed, created_at, pickup_code
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    const merchant = db
      .query<{
        printer_ip: string | null
        counter_printer_ip: string | null
        kitchen_printer_protocol: string | null
        counter_printer_protocol: string | null
        receipt_style: string | null
        business_name: string
      }, [string]>(
        `SELECT printer_ip, counter_printer_ip, kitchen_printer_protocol, counter_printer_protocol, receipt_style, business_name FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    const kitchenIp = merchant?.printer_ip || process.env.PRINTER_IP
    if (!kitchenIp) return c.json({ error: 'No printer configured' }, 400)

    const counterIp = merchant?.counter_printer_ip || kitchenIp
    const kitchenProtocol = (merchant?.kitchen_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
    const counterProtocol = (merchant?.counter_printer_protocol ?? 'star-line') as 'star-line' | 'star-line-tsp100' | 'webprnt'
    const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'
    let rawItems: OrderItemShape[]
    try { rawItems = JSON.parse(order.items) } catch {
      console.error('[dashboard-orders] Malformed items JSON for order', orderId)
      return c.json({ error: 'Order items data is corrupt' }, 500)
    }
    const printItems = enrichItemsWithCategory(rawItems)

    const baseOpts = {
      orderId: order.id,
      orderType: order.order_type,
      merchantName: merchant?.business_name ?? null,
      customerName: order.customer_name,
      tableLabel: order.table_label,
      roomLabel: order.room_label,
      notes: order.notes,
      utensilsNeeded: order.utensils_needed === 1,
      pickupCode: order.pickup_code,
      items: printItems,
      createdAt: order.created_at,
      receiptStyle,
    }

    try {
      const kitchenResult = await printKitchenTicket({ ...baseOpts, printerIp: kitchenIp, printerProtocol: kitchenProtocol })
      console.log(`[dashboard-orders] 🖨️  Kitchen ticket reprinted for order ${orderId}`)
      if (counterIp === kitchenIp) await sleep(500)
      const counterResult = await printCounterTicket({ ...baseOpts, printerIp: counterIp, printerProtocol: counterProtocol })
      console.log(`[dashboard-orders] 🖨️  Counter ticket reprinted for order ${orderId}`)
      const fallbackIps = new Set<string>()
      if (kitchenResult.webprntFallbackUsed) fallbackIps.add(kitchenIp)
      if (counterResult.webprntFallbackUsed) fallbackIps.add(counterIp)
      const webprntFallbackUsed = fallbackIps.size > 0
      if (webprntFallbackUsed) {
        const ipList = Array.from(fallbackIps).map(ip => `http://${ip}/`).join(' or ')
        broadcastToMerchant(merchantId, 'printer_warning', {
          message: `WebPRNT is not enabled on your printer — printing via fallback mode. Open ${ipList} in your browser to enable it (login: root / public).`,
        })
      }
      return c.json({ ok: true, ...(webprntFallbackUsed ? { webprntFallbackUsed: true } : {}) })
    } catch (err) {
      return serverError(c, '[dashboard-orders] reprint', err, 'Print failed — check printer connection')
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/print-bill
// Prints a pre-payment customer bill (no "PAID" section).
// Called by the server when the customer asks for the bill.
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/:orderId/print-bill',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    const order = db
      .query<{
        id: string; customer_name: string | null; order_type: string
        items: string; subtotal_cents: number; tax_cents: number
        table_label: string | null; room_label: string | null
        notes: string | null; created_at: string
        discount_cents: number; discount_label: string | null
        service_charge_cents: number; service_charge_label: string | null
      }, [string, string]>(
        `SELECT id, customer_name, order_type, items, subtotal_cents, tax_cents,
                table_label, room_label, notes, created_at,
                COALESCE(discount_cents, 0) AS discount_cents, discount_label,
                COALESCE(service_charge_cents, 0) AS service_charge_cents, service_charge_label
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    const merchant = db
      .query<{
        printer_ip: string | null
        receipt_printer_ip: string | null
        counter_printer_ip: string | null
        receipt_printer_protocol: string | null
        counter_printer_protocol: string | null
        kitchen_printer_protocol: string | null
        receipt_style: string | null
        business_name: string
        address: string | null
        tax_rate: number | null
        phone_number: string | null
        website: string | null
        tip_options: string | null
      }, [string]>(
        `SELECT printer_ip, receipt_printer_ip, counter_printer_ip,
                receipt_printer_protocol, counter_printer_protocol, kitchen_printer_protocol,
                receipt_style, business_name, address, tax_rate, phone_number, website,
                tip_options
         FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    // Bill prints to receipt printer, fall back to kitchen (same chain as payment receipt)
    const receiptIp = merchant?.receipt_printer_ip || merchant?.printer_ip || process.env.PRINTER_IP
    if (!receiptIp) return c.json({ error: 'No printer configured' }, 400)

    // Protocol follows the same fallback chain as the IP
    const billProtocol = (
      merchant?.receipt_printer_protocol ||
      merchant?.kitchen_printer_protocol ||
      'star-line'
    ) as 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
    const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

    let rawItems: OrderItemShape[]
    try { rawItems = JSON.parse(order.items) } catch {
      console.error('[dashboard-orders] Malformed items JSON for order', orderId, '(print-bill)')
      return c.json({ error: 'Order items data is corrupt' }, 500)
    }
    const printItems = rawItems.map((item: ParsedOrderItem) => ({
      quantity:       item.quantity      ?? 1,
      dishName:       item.dishName      ?? item.name ?? '',
      priceCents:     item.priceCents    ?? item.price_cents ?? 0,
      modifiers:      (item.modifiers ?? []).map((m: ParsedModifier) => ({
        name:       m.name ?? '',
        priceCents: m.priceCents ?? m.price_cents ?? 0,
      })),
      lineTotalCents: item.lineTotalCents ?? item.line_total_cents,
    }))

    // Recalculate tax from profile rate — DB stores 0 for locally-created orders
    // Tax is on the discounted subtotal + service charge (service charges are taxable).
    const taxRate = merchant?.tax_rate ?? 0
    const discountCents = order.discount_cents ?? 0
    const serviceChargeCents = order.service_charge_cents ?? 0
    const taxCents = order.tax_cents > 0
      ? order.tax_cents
      : Math.round((order.subtotal_cents - discountCents + serviceChargeCents) * taxRate)

    // Tip percentages: use store profile setting; takeout orders get -5% on each tier.
    const baseTipPcts: number[] = (() => {
      try { return JSON.parse(merchant?.tip_options ?? '[15,20,25]') } catch { return [15, 20, 25] }
    })()
    const tipPercentages = order.order_type === 'pickup'
      ? [...new Set(baseTipPcts.map(p => Math.max(0, p - 5)))].filter(p => p > 0)
      : baseTipPcts

    try {
      const result = await printCustomerBill({
        printerIp: receiptIp,
        printerProtocol: billProtocol,
        receiptStyle,
        orderId: order.id,
        orderType: order.order_type,
        merchantName: merchant?.business_name ?? null,
        customerName: order.customer_name,
        tableLabel: order.table_label,
        roomLabel: order.room_label,
        notes: order.notes,
        items: printItems,
        createdAt: order.created_at,
        subtotalCents: order.subtotal_cents,
        taxCents,
        taxRate: taxRate || undefined,
        discountCents: discountCents || undefined,
        discountLabel: order.discount_label ?? null,
        serviceChargeCents: serviceChargeCents || undefined,
        serviceChargeLabel: order.service_charge_label ?? null,
        address: merchant?.address,
        phoneNumber: merchant?.phone_number,
        website: merchant?.website,
        tipPercentages,
      })
      console.log(`[dashboard-orders] 🧾  Customer bill printed for order ${orderId}`)
      return c.json({ ok: true, ...(result.webprntFallbackUsed ? { webprntFallbackUsed: true } : {}) })
    } catch (err) {
      return serverError(c, '[dashboard-orders] print-bill', err, 'Print failed — check printer connection')
    }
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/print-receipt
// Prints a post-payment customer receipt.
// Body: { paidAmountCents: number }
// Called explicitly by server after confirming customer wants a receipt.
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/:orderId/print-receipt',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const db = getDatabase()

    const body = await c.req.json<{ paidAmountCents?: number }>()
    const paidAmountCents = body.paidAmountCents

    if (typeof paidAmountCents !== 'number' || paidAmountCents <= 0) {
      return c.json({ error: 'paidAmountCents is required and must be a positive number' }, 400)
    }

    const order = db
      .query<{
        id: string; customer_name: string | null; order_type: string
        items: string; subtotal_cents: number; tax_cents: number
        total_cents: number; tip_cents: number; discount_cents: number
        discount_label: string | null; service_charge_cents: number
        service_charge_label: string | null
        table_label: string | null; room_label: string | null
        notes: string | null; created_at: string
      }, [string, string]>(
        `SELECT id, customer_name, order_type, items, subtotal_cents, tax_cents, total_cents,
                COALESCE(tip_cents, 0) AS tip_cents,
                COALESCE(discount_cents, 0) AS discount_cents, discount_label,
                COALESCE(service_charge_cents, 0) AS service_charge_cents, service_charge_label,
                table_label, room_label, notes, created_at
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    const merchant = db
      .query<{
        printer_ip: string | null
        receipt_printer_ip: string | null
        counter_printer_ip: string | null
        receipt_printer_protocol: string | null
        counter_printer_protocol: string | null
        kitchen_printer_protocol: string | null
        receipt_style: string | null
        business_name: string
        address: string | null
        tax_rate: number | null
        phone_number: string | null
        website: string | null
      }, [string]>(
        `SELECT printer_ip, receipt_printer_ip, counter_printer_ip,
                receipt_printer_protocol, counter_printer_protocol, kitchen_printer_protocol,
                receipt_style, business_name, address, tax_rate, phone_number, website
         FROM merchants WHERE id = ?`
      )
      .get(merchantId)

    // Receipt prints to receipt printer, fall back to kitchen (same chain as payment receipt)
    const receiptIp = merchant?.receipt_printer_ip || merchant?.printer_ip || process.env.PRINTER_IP
    if (!receiptIp) return c.json({ error: 'No printer configured' }, 400)

    const receiptProtocol = (
      merchant?.receipt_printer_protocol ||
      merchant?.kitchen_printer_protocol ||
      'star-line'
    ) as 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
    const receiptStyle = (merchant?.receipt_style ?? 'classic') as 'classic' | 'html'

    let rawItems: OrderItemShape[]
    try { rawItems = JSON.parse(order.items) } catch {
      console.error('[dashboard-orders] Malformed items JSON for order', orderId, '(print-receipt)')
      return c.json({ error: 'Order items data is corrupt' }, 500)
    }
    const printItems = rawItems.map((item: ParsedOrderItem) => ({
      quantity:       item.quantity      ?? 1,
      dishName:       item.dishName      ?? item.name ?? '',
      priceCents:     item.priceCents    ?? item.price_cents ?? 0,
      modifiers:      (item.modifiers ?? []).map((m: ParsedModifier) => ({
        name:       m.name ?? '',
        priceCents: m.priceCents ?? m.price_cents ?? 0,
      })),
      lineTotalCents: item.lineTotalCents ?? item.line_total_cents,
    }))

    // Recalculate tax from profile rate — DB stores 0 for locally-created orders
    const taxRate = merchant?.tax_rate ?? 0
    const taxCents = order.tax_cents > 0 ? order.tax_cents : Math.round(order.subtotal_cents * taxRate)

    try {
      const result = await printCustomerReceipt({
        printerIp: receiptIp,
        printerProtocol: receiptProtocol,
        receiptStyle,
        orderId: order.id,
        orderType: order.order_type,
        merchantName: merchant?.business_name ?? null,
        customerName: order.customer_name,
        tableLabel: order.table_label,
        roomLabel: order.room_label,
        notes: order.notes,
        items: printItems,
        createdAt: order.created_at,
        subtotalCents: order.subtotal_cents,
        taxCents,
        taxRate: taxRate || undefined,
        tipCents: order.tip_cents || undefined,
        discountCents: order.discount_cents || undefined,
        discountLabel: order.discount_label ?? undefined,
        serviceChargeCents: order.service_charge_cents || undefined,
        serviceChargeLabel: order.service_charge_label ?? undefined,
        paidAmountCents,
        address: merchant?.address,
        phoneNumber: merchant?.phone_number,
        website: merchant?.website,
      })
      console.log(`[dashboard-orders] 🧾  Customer receipt printed for order ${orderId}`)
      return c.json({ ok: true, ...(result.webprntFallbackUsed ? { webprntFallbackUsed: true } : {}) })
    } catch (err) {
      return serverError(c, '[dashboard-orders] print-receipt', err, 'Print failed — check printer connection')
    }
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/orders
// Returns orders from local DB within an optional date range.
// Default: today (midnight → now in merchant local time)
// Query params:
//   from  — ISO date string or epoch ms (defaults to today midnight UTC)
//   to    — ISO date string or epoch ms (defaults to now)
//   limit — max rows (default 200)
// ---------------------------------------------------------------------------
dashboardOrders.get(
  '/api/merchants/:id/orders',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    // Parse date range — default to today
    const nowMs = Date.now()
    const todayMidnightMs = new Date(new Date().toDateString()).getTime()

    const fromParam = c.req.query('from')
    const toParam = c.req.query('to')
    const limit = Math.min(parseInt(c.req.query('limit') || '200'), 500)

    const fromMs = fromParam
      ? (isNaN(Number(fromParam)) ? new Date(fromParam).getTime() : Number(fromParam))
      : todayMidnightMs

    const toMs = toParam
      ? (isNaN(Number(toParam)) ? new Date(toParam).getTime() : Number(toParam))
      : nowMs

    // Convert epoch milliseconds to SQLite 'YYYY-MM-DD HH:MM:SS' (space format, UTC).
    // All created_at values are stored in this format after the date-normalisation migration.
    // Direct string comparison is safe for ISO 8601 dates (lexicographic == chronological).
    const fromStr = new Date(fromMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    const toStr   = new Date(toMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

    const rows = db
      .query<{
        id: string
        pos_order_id: string | null
        customer_name: string | null
        customer_phone: string | null
        customer_email: string | null
        items: string
        subtotal_cents: number
        tax_cents: number
        total_cents: number
        status: string
        order_type: string
        pickup_code: string | null
        created_at: string
        updated_at: string | null
        source: string
        notes: string | null
        utensils_needed: number
        table_label: string | null
        room_label: string | null
        employee_nickname: string | null
        tip_cents: number
        paid_amount_cents: number
        payment_method: string | null
        estimated_ready_at: string | null
        pickup_time: string | null
        refunded_cents: number
        tax_refunded_cents: number
        discount_cents: number
        discount_label: string | null
        service_charge_cents: number
        service_charge_label: string | null
        delivery_address: string | null
        delivery_instructions: string | null
        clover_order_id: string | null
        clover_payment_id: string | null
      }, [string, string, string, string, number]>(
        `SELECT
           o.id, o.pos_order_id, o.customer_name, o.customer_phone, o.customer_email,
           o.items, o.subtotal_cents, o.tax_cents, o.total_cents, o.status, o.order_type,
           o.pickup_code, o.created_at, o.updated_at,
           COALESCE(o.source, 'local') AS source,
           o.notes, o.utensils_needed, o.table_label, o.room_label, o.employee_nickname,
           COALESCE(o.tip_cents, 0) AS tip_cents,
           COALESCE(o.paid_amount_cents, 0) AS paid_amount_cents,
           o.payment_method, o.estimated_ready_at, o.pickup_time,
           COALESCE(r.refunded_cents, 0)     AS refunded_cents,
           COALESCE(r.tax_refunded_cents, 0) AS tax_refunded_cents,
           COALESCE(o.discount_cents, 0)     AS discount_cents,
           o.discount_label,
           COALESCE(o.service_charge_cents, 0) AS service_charge_cents,
           o.service_charge_label,
           o.delivery_address, o.delivery_instructions,
           o.clover_order_id, o.clover_payment_id
         FROM orders o
         LEFT JOIN (
           SELECT order_id,
                  SUM(refund_amount_cents) AS refunded_cents,
                  SUM(tax_refunded_cents)  AS tax_refunded_cents
           FROM refunds WHERE merchant_id = ?
           GROUP BY order_id
         ) r ON r.order_id = o.id
         WHERE o.merchant_id = ?
           AND o.created_at >= ?
           AND o.created_at <= ?
           AND o.status != 'pending_payment'
         ORDER BY o.created_at DESC
         LIMIT ?`
      )
      .all(merchantId, merchantId, fromStr, toStr, limit)

    return c.json({
      orders: rows.map((o) => ({
        id: o.id,
        posOrderId: o.pos_order_id,
        customerName: o.customer_name,
        customerPhone: o.customer_phone,
        customerEmail: o.customer_email,
        items: (() => { try { return JSON.parse(o.items) } catch { return [] } })(),
        subtotalCents: o.subtotal_cents,
        taxCents: o.tax_cents,
        totalCents: o.total_cents,
        status: o.status,
        orderType: o.order_type,
        pickupCode: o.pickup_code,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        source: o.source,
        notes: o.notes,
        utensilsNeeded: o.utensils_needed === 1,
        tableLabel: o.table_label,
        roomLabel: o.room_label,
        employeeNickname: o.employee_nickname ?? null,
        tipCents: o.tip_cents,
        paidAmountCents: o.paid_amount_cents,
        paymentMethod: o.payment_method,
        estimatedReadyAt: o.estimated_ready_at,
        pickupTime: o.pickup_time,
        refundedCents: o.refunded_cents,
        taxRefundedCents: o.tax_refunded_cents,
        discountCents: o.discount_cents,
        discountLabel: o.discount_label ?? null,
        serviceChargeCents: o.service_charge_cents,
        serviceChargeLabel: o.service_charge_label ?? null,
        deliveryAddress: o.delivery_address ?? null,
        deliveryInstructions: o.delivery_instructions ?? null,
        cloverOrderId: o.clover_order_id ?? null,
        cloverPaymentId: o.clover_payment_id ?? null,
      })),
      range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/orders/active-tables
// Returns active dine-in orders that have a table_label set.
// Used by Order Entry to highlight occupied tables.
// ---------------------------------------------------------------------------
dashboardOrders.get(
  '/api/merchants/:id/orders/active-tables',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    const rows = db
      .query<{
        id: string
        customer_name: string | null
        table_label: string
        room_label: string | null
        items: string
        notes: string | null
        order_type: string
        status: string
      }, [string]>(
        `SELECT id, customer_name, table_label, room_label, items, notes, order_type, status
         FROM orders
         WHERE merchant_id = ?
           AND order_type = 'dine_in'
           AND table_label IS NOT NULL
           AND status IN ('received', 'confirmed', 'preparing', 'ready')
           AND payment_method IS NULL
           AND created_at >= datetime('now', '-24 hours')
         ORDER BY created_at DESC`
      )
      .all(merchantId)

    return c.json(rows.map((o) => ({
      id: o.id,
      customerName: o.customer_name,
      tableLabel: o.table_label,
      roomLabel: o.room_label,
      items: (() => { try { return JSON.parse(o.items) } catch { return [] } })(),
      notes: o.notes,
      orderType: o.order_type,
      status: o.status,
    })))
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/sync
// Pulls orders from Clover for the given date range and upserts into local DB.
// Body: { from: epochMs, to: epochMs }
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/sync',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    const apiKey = await getAPIKey(merchantId, 'pos', 'clover')
    if (!apiKey) {
      return c.json({ error: 'Clover API key not configured' }, 400)
    }

    const cloverMerchantId = getPOSMerchantId(merchantId, 'clover')
    if (!cloverMerchantId) {
      return c.json({ error: 'Clover Merchant ID not configured' }, 400)
    }

    const body = await c.req.json<{ from?: number; to?: number }>().catch(() => ({}))

    const nowMs = Date.now()
    const todayMidnightMs = new Date(new Date().toDateString()).getTime()
    const fromMs = body.from ?? todayMidnightMs
    const toMs = body.to ?? nowMs

    const adapter = new CloverPOSAdapter({
      merchantId: cloverMerchantId,
      posType: 'clover',
      apiKey,
      sandboxMode: process.env.CLOVER_SANDBOX === 'true',
    })

    let cloverOrders: Awaited<ReturnType<typeof adapter.fetchOrders>>
    try {
      cloverOrders = await adapter.fetchOrders(fromMs, toMs)
    } catch (error) {
      return serverError(c, '[dashboard-orders] Clover orders sync failed', error, 'Failed to fetch orders from Clover', 502)
    }

    const db = getDatabase()

    db.transaction(() => {
      for (const o of cloverOrders) {
        const localId = `clover_${o.posOrderId}`
        const createdISO = new Date(o.createdTime).toISOString().replace('T', ' ').slice(0, 19)
        const updatedISO = new Date(o.modifiedTime).toISOString().replace('T', ' ').slice(0, 19)
        const itemsJson = JSON.stringify(o.lineItems.map((li) => ({
          dishName: li.name,
          quantity: li.quantity,
          priceCents: li.priceCents,
          specialInstructions: li.note,
        })))

        // Insert if not seen before (id is deterministic: clover_<posOrderId>)
        db.run(
          `INSERT OR IGNORE INTO orders (
             id, merchant_id, pos_order_id,
             customer_name, customer_phone, customer_email,
             items, subtotal_cents, tax_cents, total_cents,
             status, order_type, source,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pickup', 'clover', ?, ?)`,
          [
            localId,
            merchantId,
            o.posOrderId,
            o.customerName ?? 'POS Customer',
            o.customerPhone ?? '',
            o.customerEmail,
            itemsJson,
            o.totalCents,
            o.totalCents,
            o.status,
            createdISO,
            updatedISO,
          ]
        )

        // Always update mutable fields (status may have changed in Clover)
        db.run(
          `UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`,
          [o.status, updatedISO, localId]
        )
      }
    })()

    return c.json({
      success: true,
      synced: cloverOrders.length,
      range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/orders/:orderId/discount
// Apply or remove a discount on an unpaid order.
// Body: { discountCents: number; discountLabel?: string | null }
// ---------------------------------------------------------------------------

dashboardOrders.patch(
  '/api/merchants/:id/orders/:orderId/discount',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')
    const db = getDatabase()

    const body = await c.req.json<{ discountCents: number; discountLabel?: string | null }>()

    const discountCents = body.discountCents ?? 0
    if (typeof discountCents !== 'number' || discountCents < 0 || !Number.isInteger(discountCents)) {
      return c.json({ error: 'discountCents must be a non-negative integer' }, 400)
    }

    const order = db
      .query<{ id: string; status: string; subtotal_cents: number; service_charge_cents: number }, [string, string]>(
        `SELECT id, status, subtotal_cents, COALESCE(service_charge_cents, 0) AS service_charge_cents
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    if (isPaymentLocked(orderId)) {
      return c.json({ error: 'This order has a payment in progress and cannot be modified' }, 409)
    }

    // Cannot apply a discount to an already-settled order
    const blockedStatuses = ['submitted', 'picked_up', 'completed', 'cancelled', 'paid']
    if (blockedStatuses.includes(order.status)) {
      return c.json({ error: `Cannot apply a discount to a ${order.status} order` }, 409)
    }

    if (discountCents > order.subtotal_cents) {
      return c.json({ error: 'Discount cannot exceed the order subtotal' }, 400)
    }

    const discountLabel = body.discountLabel ?? null

    // Recalculate tax — service charges are taxable, so they stay in the taxable base.
    const merchant = db
      .query<{ tax_rate: number }, [string]>(`SELECT tax_rate FROM merchants WHERE id = ?`)
      .get(merchantId)
    const taxRate = merchant?.tax_rate ?? 0
    const taxCents = Math.round((order.subtotal_cents - discountCents + order.service_charge_cents) * taxRate)
    const newTotal = order.subtotal_cents - discountCents + order.service_charge_cents + taxCents

    db.run(
      `UPDATE orders SET discount_cents = ?, discount_label = ?, tax_cents = ?, total_cents = ?, updated_at = datetime('now')
       WHERE id = ? AND merchant_id = ?`,
      [discountCents, discountLabel, taxCents, newTotal, orderId, merchantId]
    )

    return c.json({ ok: true, discountCents, discountLabel, taxCents, totalCents: newTotal })
  }
)

// ---------------------------------------------------------------------------
// PATCH /api/merchants/:id/orders/:orderId/service-charge
// Apply or remove a service charge on an unpaid dine-in order.
// Body: { serviceChargeCents: number; serviceChargeLabel?: string | null }
// Service charges are taxable — tax and total are recalculated here.
// ---------------------------------------------------------------------------

dashboardOrders.patch(
  '/api/merchants/:id/orders/:orderId/service-charge',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')
    const db = getDatabase()

    const body = await c.req.json<{ serviceChargeCents: number; serviceChargeLabel?: string | null }>()

    const serviceChargeCents = body.serviceChargeCents ?? 0
    if (typeof serviceChargeCents !== 'number' || serviceChargeCents < 0 || !Number.isInteger(serviceChargeCents)) {
      return c.json({ error: 'serviceChargeCents must be a non-negative integer' }, 400)
    }

    const order = db
      .query<{
        id: string; status: string; order_type: string
        subtotal_cents: number; discount_cents: number
      }, [string, string]>(
        `SELECT id, status, order_type,
                subtotal_cents,
                COALESCE(discount_cents, 0) AS discount_cents
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    if (isPaymentLocked(orderId)) {
      return c.json({ error: 'This order has a payment in progress and cannot be modified' }, 409)
    }

    if (order.order_type !== 'dine_in') {
      return c.json({ error: 'Service charges can only be applied to dine-in orders' }, 400)
    }

    const blockedStatuses = ['submitted', 'picked_up', 'completed', 'cancelled', 'paid']
    if (blockedStatuses.includes(order.status)) {
      return c.json({ error: `Cannot apply a service charge to a ${order.status} order` }, 409)
    }

    const serviceChargeLabel = body.serviceChargeLabel ?? null

    // Recalculate tax: service charge is taxable, so it is included in the taxable base.
    const merchant = db
      .query<{ tax_rate: number }, [string]>(`SELECT tax_rate FROM merchants WHERE id = ?`)
      .get(merchantId)
    const taxRate = merchant?.tax_rate ?? 0
    const taxCents = Math.round((order.subtotal_cents - order.discount_cents + serviceChargeCents) * taxRate)
    const newTotal = order.subtotal_cents - order.discount_cents + serviceChargeCents + taxCents

    db.run(
      `UPDATE orders
          SET service_charge_cents = ?, service_charge_label = ?,
              tax_cents = ?, total_cents = ?,
              updated_at = datetime('now')
        WHERE id = ? AND merchant_id = ?`,
      [serviceChargeCents, serviceChargeLabel, taxCents, newTotal, orderId, merchantId]
    )

    return c.json({ ok: true, serviceChargeCents, serviceChargeLabel, taxCents, totalCents: newTotal })
  }
)

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/orders/:orderId/push-to-clover
// Manually pushes an existing order to the Clover Flex terminal.
// Idempotent — safe to call multiple times; returns existing clover_order_id
// if already pushed.
// ---------------------------------------------------------------------------
dashboardOrders.post(
  '/api/merchants/:id/orders/:orderId/push-to-clover',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const orderId    = c.req.param('orderId')
    const db = getDatabase()

    if (!cloverClient.isEnabled()) {
      return c.json({ error: 'Clover integration is not configured on this server' }, 503)
    }

    const order = db
      .query<{
        id: string
        merchant_id: string
        customer_name: string | null
        order_type: string
        table_label: string | null
        notes: string | null
        items: string
        clover_order_id: string | null
      }, [string, string]>(
        `SELECT id, merchant_id, customer_name, order_type, table_label, notes, items, clover_order_id
         FROM orders WHERE id = ? AND merchant_id = ?`
      )
      .get(orderId, merchantId)

    if (!order) return c.json({ error: 'Order not found' }, 404)

    const merchantRow = db
      .query<{ tax_rate: number }, [string]>(`SELECT tax_rate FROM merchants WHERE id = ?`)
      .get(merchantId)

    try {
      notifyCloverPaymentInitiated()
      const { cloverOrderId } = await cloverClient.pushOrder(
        {
          id: order.id,
          merchant_id: order.merchant_id,
          customer_name: order.customer_name ?? 'Guest',
          order_type: order.order_type,
          table_label: order.table_label,
          notes: order.notes,
          clover_order_id: order.clover_order_id,
          items: order.items,
          tax_rate: merchantRow?.tax_rate ?? null,
        },
        db
      )
      return c.json({ ok: true, cloverOrderId })
    } catch (err) {
      console.error('[clover] manual pushOrder failed:', err instanceof Error ? err.message : err)
      return c.json({ error: err instanceof Error ? err.message : 'Push to Clover failed' }, 502)
    }
  }
)

export { dashboardOrders }
