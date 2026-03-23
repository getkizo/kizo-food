/**
 * Legacy order routes (v1-era file — partially superseded by store.ts and dashboard-orders.ts).
 *
 * Endpoints in this file:
 *   POST /:merchantSlug/orders          — v1-style customer order placement (slug-based, uses `dishes` table)
 *   GET  /api/orders/:orderId           — Fetch order details (auth required, merchant-isolated)
 *   GET  /api/orders                    — List orders for authenticated merchant (paginated)
 *
 * ⚠  Known issues in this file:
 *   - POST /:merchantSlug/orders queries the `dishes` table, which does not exist in v2
 *     (v2 uses `menu_items`). Customer-facing order placement should use POST /api/store/orders
 *     in store.ts instead.
 *   - GET /api/orders has no ownership enforcement beyond matching the session merchant —
 *     the route is authenticated but does not reject requests for arbitrary merchantId values
 *     that differ from the session (TD-2.5).
 *
 * State machine transitions (for reference):
 *   received → confirmed → preparing → ready → picked_up (online) | paid (in-person)
 *   received → cancelled
 *   confirmed → cancelled
 *   * Status updates are handled by PATCH /api/merchants/:id/orders/:id/status in dashboard-orders.ts
 *
 * Order items JSON shape (stored in orders.items column):
 *   [{ dishId, dishName, quantity, priceCents, modifiers: [{name, priceCents}],
 *      courseOrder?, printDestination?, specialInstructions? }]
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { createOrderWorkflow, type OrderStatus } from '../workflows/order-relay'
import { getAdapter } from '../adapters/registry'
import type { POSOrderData, POSOrderItem } from '../adapters/types'
import { notifyMerchant } from './push'
import { authenticate } from '../middleware/auth'
import { serverError } from '../utils/server-error'

type Variables = {
  merchantId?: string
  userId?: string
  ipAddress?: string
}

/** Columns fetched by GET /api/orders/:orderId */
type OrderDetailRow = {
  id: string; merchant_id: string; customer_name: string; customer_phone: string
  customer_email: string | null; items: string; subtotal_cents: number
  tax_cents: number; total_cents: number; status: OrderStatus
  pickup_code: string | null; pos_order_id: string | null; order_type: string
  created_at: string; updated_at: string; completed_at: string | null
}

/** Columns fetched by GET /api/orders (list) */
type OrderListRow = {
  id: string; customer_name: string; status: OrderStatus
  total_cents: number; pickup_code: string | null; created_at: string
}

const SQL_ORDER_DETAIL =
  `SELECT id, merchant_id, customer_name, customer_phone, customer_email,
          items, subtotal_cents, tax_cents, total_cents, status,
          pickup_code, pos_order_id, order_type, created_at, updated_at, completed_at
   FROM orders WHERE id = ?`

const SQL_ORDER_LIST_BASE =
  `SELECT id, customer_name, status, total_cents, pickup_code, created_at
   FROM orders WHERE merchant_id = ?`

const orders = new Hono<{ Variables: Variables }>()

/**
 * POST /:merchantSlug/orders
 * Place a new order
 */
orders.post('/:merchantSlug/orders', async (c) => {
  const slug = c.req.param('merchantSlug')

  try {
    const body = await c.req.json()

    // Validate request body
    const { customerName, customerPhone, customerEmail, items, orderType } = body

    if (!customerName || !customerPhone || !items || !Array.isArray(items)) {
      return c.json(
        {
          error: 'Missing required fields: customerName, customerPhone, items',
        },
        400
      )
    }

    if (items.length === 0) {
      return c.json({ error: 'Order must contain at least one item' }, 400)
    }

    // Get merchant
    const db = getDatabase()
    const merchant = db
      .query<{ id: string; business_name: string; status: string; tax_rate: number }, [string]>(
        `SELECT id, business_name, status, tax_rate FROM merchants WHERE slug = ?`
      )
      .get(slug)

    if (!merchant) {
      return c.json({ error: 'Merchant not found' }, 404)
    }

    if (merchant.status !== 'active') {
      return c.json({ error: 'Merchant is not accepting orders' }, 400)
    }

    // Validate and enrich items with dish data
    const enrichedItems: POSOrderItem[] = []
    let subtotalCents = 0

    for (const item of items) {
      const dish = db
        .query<{
          id: string
          name: string
          base_price_cents: number
          is_available: number
        }, [string, string]>(
          `SELECT id, name, base_price_cents, is_available
           FROM dishes
           WHERE id = ? AND merchant_id = ?`
        )
        .get(item.dishId, merchant.id)

      if (!dish) {
        return c.json({ error: `Dish not found: ${item.dishId}` }, 400)
      }

      if (dish.is_available !== 1) {
        return c.json({ error: `Dish not available: ${dish.name}` }, 400)
      }

      const quantity = parseInt(item.quantity) || 1
      const itemTotal = dish.base_price_cents * quantity

      enrichedItems.push({
        dishId: dish.id,
        dishName: dish.name,
        quantity,
        priceCents: dish.base_price_cents,
        specialInstructions: item.specialInstructions,
      })

      subtotalCents += itemTotal
    }

    // Calculate tax from merchant settings
    const taxRate = merchant.tax_rate ?? 0.0
    const taxCents = Math.round(subtotalCents * taxRate)
    const totalCents = subtotalCents + taxCents

    // Generate order ID
    const orderId = generateId('ord')

    // Create order in database
    db.run(
      `INSERT INTO orders (
        id, merchant_id, customer_name, customer_phone, customer_email,
        items, subtotal_cents, tax_cents, total_cents, order_type,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        orderId,
        merchant.id,
        customerName,
        customerPhone,
        customerEmail || null,
        JSON.stringify(enrichedItems),
        subtotalCents,
        taxCents,
        totalCents,
        orderType || 'pickup',
        'received',
      ]
    )

    // Create order data for POS
    const orderData: POSOrderData = {
      orderId,
      customerName,
      customerPhone,
      customerEmail,
      items: enrichedItems,
      subtotalCents,
      taxCents,
      totalCents,
      orderType: orderType || 'pickup',
      specialInstructions: body.specialInstructions,
    }

    // Get POS adapter (default to manual)
    const adapter = await getAdapter({
      merchantId: merchant.id,
      posType: 'manual', // TODO: Read from merchant.pos_type once that column is added to the merchants table
    })

    // Create SAM workflow (this will auto-submit via NAP)
    const workflow = createOrderWorkflow(orderId, orderData, adapter, merchant.id)

    // fire-and-forget: order already committed; push errors logged only
    const itemSummary = enrichedItems
      .map((i) => `${i.quantity}× ${i.dishName}`)
      .join(', ')
    notifyMerchant(merchant.id, {
      title: `New ${orderType === 'dine_in' ? 'Dine-in' : 'Takeout'} Order`,
      body: `${customerName} — ${itemSummary}`,
      data: { orderId, merchantSlug: slug, type: 'new_order' },
    }).catch((err) => console.error('[push] notifyMerchant failed:', err))

    // Return order confirmation
    return c.json(
      {
        orderId,
        merchantName: merchant.business_name,
        status: 'received',
        totalCents,
        estimatedMinutes: 30, // Will be updated when POS confirms
        message: 'Order received and is being processed',
      },
      201
    )
  } catch (error) {
    return serverError(c, '[orders] POST', error, 'Failed to place order')
  }
})

/**
 * GET /api/orders/:orderId
 * Get order details
 */
orders.get('/api/orders/:orderId', authenticate, async (c) => {
  const orderId = c.req.param('orderId')
  const requestingMerchantId = c.get('merchantId')

  try {
    const db = getDatabase()
    const order = db
      .query<OrderDetailRow, [string]>(SQL_ORDER_DETAIL)
      .get(orderId)

    if (!order) {
      return c.json({ error: 'Order not found' }, 404)
    }

    // Merchant isolation: only the order's own merchant can access it
    if (order.merchant_id !== requestingMerchantId) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Get merchant info
    const merchant = db
      .query<{ business_name: string; slug: string }, [string]>(
        `SELECT business_name, slug FROM merchants WHERE id = ?`
      )
      .get(order.merchant_id)

    return c.json({
      id: order.id,
      merchant: {
        name: merchant?.business_name,
        slug: merchant?.slug,
      },
      customer: {
        name: order.customer_name,
        phone: order.customer_phone,
        email: order.customer_email,
      },
      items: (() => { try { const p = JSON.parse(order.items); return Array.isArray(p) ? p : [] } catch { return [] } })(),
      pricing: {
        subtotalCents: order.subtotal_cents,
        taxCents: order.tax_cents,
        totalCents: order.total_cents,
      },
      status: order.status,
      pickupCode: order.pickup_code,
      posOrderId: order.pos_order_id,
      orderType: order.order_type,
      timestamps: {
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        completedAt: order.completed_at,
      },
    })
  } catch (error) {
    return serverError(c, '[orders] GET', error, 'Failed to fetch order')
  }
})

/**
 * GET /api/orders
 * List orders for a merchant (requires authentication)
 */
orders.get('/api/orders', authenticate, async (c) => {
  const sessionMerchantId = c.get('merchantId')
  const merchantId = c.req.query('merchantId')
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  // If merchantId param is supplied it must match the authenticated merchant
  if (merchantId && merchantId !== sessionMerchantId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const effectiveMerchantId = merchantId || sessionMerchantId
  if (!effectiveMerchantId) {
    return c.json({ error: 'merchantId query parameter required' }, 400)
  }

  try {
    const db = getDatabase()

    const orders: OrderListRow[] = status
      ? db.query<OrderListRow, [string, string, number, number]>(
          `${SQL_ORDER_LIST_BASE} AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(effectiveMerchantId, status, limit, offset)
      : db.query<OrderListRow, [string, number, number]>(
          `${SQL_ORDER_LIST_BASE} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(effectiveMerchantId, limit, offset)

    return c.json({
      orders: orders.map((o) => ({
        id: o.id,
        customerName: o.customer_name,
        status: o.status,
        totalCents: o.total_cents,
        pickupCode: o.pickup_code,
        createdAt: o.created_at,
      })),
      pagination: {
        limit,
        offset,
        total: orders.length,
      },
    })
  } catch (error) {
    return serverError(c, '[orders] list', error, 'Failed to list orders')
  }
})

export { orders }
