/**
 * print-items utility tests
 *
 * Covers enrichItemsWithCategory:
 *   - Field normalisation: store shape (name/itemId) and dashboard shape (dishName/itemId/dishId)
 *   - Category join: courseOrder, isLastCourse, printDestination populated from DB
 *   - Unknown itemId: fields default to null / 'both' / false
 *   - Empty input: returns empty array without DB query
 *   - Modifier field normalisation: priceCents vs price_cents
 */

import { test, expect, describe, beforeAll } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { app } from '../src/server'
import { enrichItemsWithCategory } from '../src/utils/print-items'
import type { OrderItemShape } from '../src/utils/print-items'

// ── Fixtures ──────────────────────────────────────────────────────────────────

let merchantId = ''
let categoryIdMain = ''
let categoryIdDessert = ''
let categoryIdCounter = ''
let itemIdMain = ''
let itemIdDessert = ''
let itemIdCounter = ''

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const res = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@printitems.test',
      password:     'SecurePass123!',
      fullName:     'PrintItems Owner',
      businessName: 'PrintItems Cafe',
      slug:         'printitems-cafe',
    }),
  }))
  const body = await res.json() as { merchant: { id: string } }
  merchantId = body.merchant.id

  const db = getDatabase()

  // Category: Mains (course_order=1, is_last_course=0, print_destination='both')
  categoryIdMain = `cat_main_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_categories (id, merchant_id, name, sort_order, course_order, is_last_course, print_destination, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [categoryIdMain, merchantId, 'Mains', 1, 1, 0, 'both']
  )

  // Category: Desserts (course_order=2, is_last_course=1, print_destination='kitchen')
  categoryIdDessert = `cat_des_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_categories (id, merchant_id, name, sort_order, course_order, is_last_course, print_destination, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [categoryIdDessert, merchantId, 'Desserts', 2, 2, 1, 'kitchen']
  )

  // Category: Drinks (course_order=null, is_last_course=0, print_destination='counter')
  categoryIdCounter = `cat_drk_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_categories (id, merchant_id, name, sort_order, course_order, is_last_course, print_destination, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [categoryIdCounter, merchantId, 'Drinks', 3, null, 0, 'counter']
  )

  // Items
  itemIdMain = `item_main_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_items (id, merchant_id, category_id, name, price_cents, is_available, created_at, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [itemIdMain, merchantId, categoryIdMain, 'Pad Thai', 1400, 1]
  )

  itemIdDessert = `item_des_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_items (id, merchant_id, category_id, name, price_cents, is_available, created_at, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [itemIdDessert, merchantId, categoryIdDessert, 'Mango Sticky Rice', 800, 1]
  )

  itemIdCounter = `item_drk_${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO menu_items (id, merchant_id, category_id, name, price_cents, is_available, created_at, updated_at)
     VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
    [itemIdCounter, merchantId, categoryIdCounter, 'Thai Iced Tea', 400, 1]
  )
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enrichItemsWithCategory', () => {

  test('returns empty array for empty input', () => {
    const result = enrichItemsWithCategory([])
    expect(result).toEqual([])
  })

  test('normalises store shape (name / itemId) to dishName', () => {
    const raw: OrderItemShape[] = [
      { name: 'Pad Thai', itemId: itemIdMain, quantity: 1, priceCents: 1400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.dishName).toBe('Pad Thai')
    expect(item.quantity).toBe(1)
    expect(item.priceCents).toBe(1400)
  })

  test('normalises dashboard shape (dishName / itemId)', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Pad Thai', itemId: itemIdMain, quantity: 2, priceCents: 1400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.dishName).toBe('Pad Thai')
    expect(item.quantity).toBe(2)
  })

  test('uses dishId as fallback when itemId is absent', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Pad Thai', dishId: itemIdMain, quantity: 1, priceCents: 1400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.dishName).toBe('Pad Thai')
    expect(item.courseOrder).toBe(1)
  })

  test('attaches courseOrder from menu_categories join', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Pad Thai', itemId: itemIdMain, quantity: 1, priceCents: 1400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.courseOrder).toBe(1)
  })

  test('attaches isLastCourse=true for dessert category', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Mango Sticky Rice', itemId: itemIdDessert, quantity: 1, priceCents: 800 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.isLastCourse).toBe(true)
    expect(item.courseOrder).toBe(2)
  })

  test('attaches printDestination=counter for drinks category', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Thai Iced Tea', itemId: itemIdCounter, quantity: 1, priceCents: 400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.printDestination).toBe('counter')
  })

  test('defaults to printDestination=both for unknown itemId', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Mystery Dish', itemId: 'item_unknown_999', quantity: 1, priceCents: 0 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.printDestination).toBe('both')
    expect(item.courseOrder).toBeNull()
    expect(item.isLastCourse).toBe(false)
  })

  test('normalises modifier price_cents field to priceCents', () => {
    const raw: OrderItemShape[] = [
      {
        dishName: 'Pad Thai',
        itemId:   itemIdMain,
        quantity: 1,
        priceCents: 1400,
        modifiers: [{ name: 'No Peanuts', price_cents: 0 } as any],
      },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.modifiers?.[0]?.priceCents).toBe(0)
    expect(item.modifiers?.[0]?.name).toBe('No Peanuts')
  })

  test('handles item with no modifiers', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Spring Roll', itemId: itemIdMain, quantity: 3, priceCents: 600 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.modifiers).toEqual([])
  })

  test('defaults quantity to 1 when missing', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Pad Thai', itemId: itemIdMain, priceCents: 1400 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.quantity).toBe(1)
  })

  test('returns all items when given a mixed list', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'Pad Thai',          itemId: itemIdMain,    quantity: 1, priceCents: 1400 },
      { dishName: 'Mango Sticky Rice', itemId: itemIdDessert, quantity: 1, priceCents: 800 },
      { dishName: 'Thai Iced Tea',     itemId: itemIdCounter, quantity: 2, priceCents: 400 },
    ]
    const result = enrichItemsWithCategory(raw)
    expect(result).toHaveLength(3)
    expect(result[0].courseOrder).toBe(1)
    expect(result[1].courseOrder).toBe(2)
    expect(result[2].printDestination).toBe('counter')
  })

  test('handles no valid itemIds gracefully (returns normalised without category info)', () => {
    const raw: OrderItemShape[] = [
      { dishName: 'No ID Item', quantity: 1, priceCents: 500 },
    ]
    const [item] = enrichItemsWithCategory(raw)
    expect(item.dishName).toBe('No ID Item')
    // No category fields attached when no IDs
    expect(item.courseOrder).toBeUndefined()
  })
})
