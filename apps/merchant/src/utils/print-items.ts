/**
 * print-items.ts
 *
 * Shared helper for enriching raw order items with category-level routing
 * information (courseOrder, isLastCourse, printDestination) fetched from the
 * menu_items → menu_categories join at print time.
 *
 * Used by dashboard-orders.ts (fire / reprint paths) and auto-fire.ts so that
 * both share identical enrichment logic without circular imports.
 */

import { getDatabase } from '../db/connection'
import type { PrintItem } from '../services/printer'

/** Modifier sub-shape shared by both item formats. */
interface ModifierShape {
  name?: string
  priceCents?: number
  price_cents?: number
}

/**
 * Raw order item as stored in the `orders.items` JSON column.
 * Two known shapes exist — store orders and dashboard orders — unified here.
 *
 * Store shape:  `{ name, itemId?, priceCents, quantity?, modifiers?, dishLabel?, specialInstructions? }`
 * Dashboard:    `{ dishName, dishId?, itemId?, quantity, priceCents, modifiers?, lineTotalCents?, specialInstructions?, serverNotes? }`
 */
export interface OrderItemShape {
  // Store field names
  name?: string
  // Dashboard field names
  dishName?: string
  dishId?: string
  // Shared
  itemId?: string
  quantity?: number
  priceCents?: number
  price_cents?: number
  modifiers?: ModifierShape[]
  dishLabel?: string
  specialInstructions?: string
  serverNotes?: string
  lineTotalCents?: number
  line_total_cents?: number
}

/**
 * Normalise raw order items (which may come from either the store or the
 * dashboard) and join each one against menu_categories to attach course
 * routing fields.
 *
 * @param rawItems  Parsed JSON array from orders.items column.
 * @returns         PrintItem[] with courseOrder / isLastCourse / printDestination set.
 */
export function enrichItemsWithCategory(rawItems: OrderItemShape[]): PrintItem[] {
  const db = getDatabase()

  // Normalise field names — store uses {name, itemId, priceCents, lineTotalCents}
  // dashboard uses {dishName, itemId, quantity, priceCents, lineTotalCents}
  const normalized: (PrintItem & { itemId: string })[] = rawItems.map((item) => ({
    itemId:        item.itemId  ?? item.dishId  ?? '',
    quantity:      item.quantity ?? 1,
    dishName:      item.dishName ?? item.name   ?? '',
    priceCents:    item.priceCents ?? item.price_cents ?? 0,
    modifiers:     (item.modifiers ?? []).map((m) => ({
      name:       m.name ?? '',
      priceCents: m.priceCents ?? m.price_cents ?? 0,
    })),
    dishLabel:           item.dishLabel           ?? undefined,
    specialInstructions: item.specialInstructions ?? undefined,
    serverNotes:         item.serverNotes         ?? undefined,
    lineTotalCents: item.lineTotalCents ?? item.line_total_cents,
  }))

  const ids = [...new Set(normalized.map(i => i.itemId).filter(Boolean))]

  if (ids.length === 0) {
    // No valid item IDs — return normalized without category info
    return normalized.map(({ itemId: _id, ...rest }) => rest as PrintItem)
  }

  const placeholders = ids.map(() => '?').join(',')
  const rows = db.query<{
    item_id: string
    course_order: number | null
    is_last_course: number
    print_destination: string
  }, string[]>(
    `SELECT mi.id AS item_id, mc.course_order, mc.is_last_course, mc.print_destination
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.id IN (${placeholders})`
  ).all(...ids)

  const catMap = new Map(rows.map(r => [r.item_id, r]))

  return normalized.map(({ itemId, ...rest }) => {
    const c = catMap.get(itemId)
    return {
      ...rest,
      courseOrder:      c?.course_order ?? null,
      isLastCourse:     Boolean(c?.is_last_course),
      printDestination: (c?.print_destination ?? 'both') as 'both' | 'kitchen' | 'counter',
    }
  })
}
