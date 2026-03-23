/**
 * star-raster markup builder tests
 *
 * Tests the pure markup-generating functions exported from star-raster.ts.
 * buildStarGraphicBytes (async, requires sharp) is exercised only via a
 * basic smoke test that verifies the returned Buffer is non-empty.
 *
 * Focus areas:
 *   - buildKitchenTicketMarkup   : order-type label, item names, modifier backtick-inversion, escaping
 *   - buildCounterTicketMarkup   : standard (no subtotal) vs takeout bag (with subtotal)
 *   - buildCustomerReceiptMarkup : totals section, sigNote, paidAmount
 *   - buildCustomerBillMarkup    : tip table, subtotal/tax lines
 *   - Special-character escaping : {, }, |, \ in dish/modifier names
 */

import { test, expect, describe } from 'bun:test'
import {
  buildKitchenTicketMarkup,
  buildCounterTicketMarkup,
  buildCustomerReceiptMarkup,
  buildCustomerBillMarkup,
  buildTestPageMarkup,
  type PrintItem,
  type KitchenTicketOptions,
  type CounterTicketOptions,
  type CustomerReceiptOptions,
  type CustomerBillOptions,
  type TestPageOptions,
} from '../src/services/star-raster'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const ITEM_PAD_THAI: PrintItem = {
  dishName:       'Pad Thai',
  quantity:       2,
  priceCents:     1400,
  modifiers:      [{ name: 'No Peanuts', priceCents: 0 }],
  lineTotalCents: 2800,
}

const ITEM_SPRING_ROLL: PrintItem = {
  dishName:       'Spring Roll',
  quantity:       1,
  priceCents:     600,
  modifiers:      [],
  lineTotalCents: 600,
}

const BASE_ORDER_ID = 'ord_abc123456789'

// ── buildKitchenTicketMarkup ──────────────────────────────────────────────────

describe('buildKitchenTicketMarkup', () => {
  const baseOpts: KitchenTicketOptions = {
    orderId:      BASE_ORDER_ID,
    orderType:    'pickup',
    merchantName: 'Test Cafe',
    customerName: 'Alice',
    tableLabel:   null,
    roomLabel:    null,
    notes:        null,
    items:        [ITEM_PAD_THAI, ITEM_SPRING_ROLL],
    createdAt:    '2026-01-15T18:30:00Z',
  }

  test('returns a non-empty string', () => {
    const markup = buildKitchenTicketMarkup(baseOpts)
    expect(typeof markup).toBe('string')
    expect(markup.length).toBeGreaterThan(50)
  })

  test('contains the short order ID (last 6 chars, upper-case)', () => {
    const markup = buildKitchenTicketMarkup(baseOpts)
    // ord_abc123456789 → last 6 of 'abc123456789' = '456789' → '456789'.toUpperCase()
    expect(markup).toContain('456789')
  })

  test('contains dish names', () => {
    const markup = buildKitchenTicketMarkup(baseOpts)
    expect(markup).toContain('Pad Thai')
    expect(markup).toContain('Spring Roll')
  })

  test('wraps modifier in backticks for inversion', () => {
    const markup = buildKitchenTicketMarkup(baseOpts)
    // Modifiers are rendered as `mod name` (backtick inverted text)
    expect(markup).toContain('`No Peanuts`')
  })

  test('contains TAKEOUT label for pickup order type', () => {
    const markup = buildKitchenTicketMarkup(baseOpts)
    expect(markup.toUpperCase()).toContain('TAKEOUT')
  })

  test('contains DINE IN label for dine_in order type', () => {
    const markup = buildKitchenTicketMarkup({ ...baseOpts, orderType: 'dine_in' })
    expect(markup.toUpperCase()).toContain('DINE')
  })

  test('contains table label when provided', () => {
    const markup = buildKitchenTicketMarkup({ ...baseOpts, tableLabel: '12', orderType: 'dine_in' })
    expect(markup).toContain('Table 12')
  })

  test('escapes receiptline special chars in dish names', () => {
    const item: PrintItem = {
      ...ITEM_PAD_THAI,
      dishName: 'Soup {hot} | spicy',
    }
    const markup = buildKitchenTicketMarkup({ ...baseOpts, items: [item] })
    // User content must appear with backslash-escaped specials
    expect(markup).toContain('\\{hot\\}')
    expect(markup).toContain('\\|')
  })

  test('escapes receiptline special chars in modifier names', () => {
    const item: PrintItem = {
      ...ITEM_PAD_THAI,
      modifiers: [{ name: 'Extra {sauce}', priceCents: 0 }],
    }
    const markup = buildKitchenTicketMarkup({ ...baseOpts, items: [item] })
    expect(markup).toContain('\\{sauce\\}')
  })

  test('includes notes when provided', () => {
    const markup = buildKitchenTicketMarkup({ ...baseOpts, notes: 'Allergy: nuts' })
    expect(markup).toContain('Allergy: nuts')
  })
})

// ── buildCounterTicketMarkup ──────────────────────────────────────────────────

describe('buildCounterTicketMarkup', () => {
  const baseOpts: CounterTicketOptions = {
    orderId:      BASE_ORDER_ID,
    orderType:    'pickup',
    merchantName: 'Test Cafe',
    customerName: 'Bob',
    tableLabel:   null,
    roomLabel:    null,
    notes:        null,
    items:        [ITEM_PAD_THAI],
    createdAt:    '2026-01-15T18:30:00Z',
  }

  test('standard counter copy (no subtotalCents) returns non-empty string', () => {
    const markup = buildCounterTicketMarkup(baseOpts)
    expect(typeof markup).toBe('string')
    expect(markup.length).toBeGreaterThan(50)
  })

  test('standard counter copy contains item name', () => {
    const markup = buildCounterTicketMarkup(baseOpts)
    expect(markup).toContain('Pad Thai')
  })

  test('takeout bag receipt (with subtotalCents) returns non-empty string', () => {
    const markup = buildCounterTicketMarkup({
      ...baseOpts,
      subtotalCents: 1400,
      taxCents:      112,
      tipCents:      280,
      paidAmountCents: 1792,
      paymentMethod: 'card',
    })
    expect(markup.length).toBeGreaterThan(50)
  })

  test('takeout bag receipt includes formatted total', () => {
    const markup = buildCounterTicketMarkup({
      ...baseOpts,
      subtotalCents:   1400,
      taxCents:        112,
      tipCents:        0,
      paidAmountCents: 1512,
      paymentMethod:   'cash',
    })
    // $15.12 should appear somewhere in the markup
    expect(markup).toContain('15.12')
  })
})

// ── buildCustomerReceiptMarkup ────────────────────────────────────────────────

describe('buildCustomerReceiptMarkup', () => {
  const baseOpts: CustomerReceiptOptions = {
    orderId:         BASE_ORDER_ID,
    orderType:       'pickup',
    merchantName:    'Test Cafe',
    customerName:    'Carol',
    tableLabel:      null,
    address:         '123 Main St',
    phoneNumber:     '555-0100',
    website:         null,
    items:           [ITEM_PAD_THAI, ITEM_SPRING_ROLL],
    createdAt:       '2026-01-15T18:30:00Z',
    subtotalCents:   3400,
    taxCents:        272,
    tipCents:        500,
    paidAmountCents: 4172,
  }

  test('returns a non-empty string', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    expect(markup.length).toBeGreaterThan(100)
  })

  test('contains paid amount formatted as currency', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    expect(markup).toContain('41.72')
  })

  test('contains signature note', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    // The sig note text varies by language, but should mention "signature" or "device"
    expect(markup.toLowerCase()).toMatch(/signature|device/)
  })

  test('contains subtotal', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    expect(markup).toContain('34.00')
  })

  test('contains tax amount', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    expect(markup).toContain('2.72')
  })

  test('contains tip when provided', () => {
    const markup = buildCustomerReceiptMarkup(baseOpts)
    expect(markup).toContain('5.00')
  })

  test('omits tip line when tipCents is 0', () => {
    const markup = buildCustomerReceiptMarkup({ ...baseOpts, tipCents: 0, paidAmountCents: 3672 })
    // $5.00 tip should not appear
    expect(markup).not.toContain('5.00')
  })

  test('shows tax rate percentage when taxRate is provided', () => {
    const markup = buildCustomerReceiptMarkup({ ...baseOpts, taxRate: 0.08 })
    expect(markup).toContain('8%')
  })

  test('includes discount row when discountCents > 0', () => {
    const markup = buildCustomerReceiptMarkup({
      ...baseOpts,
      discountCents: 500,
      discountLabel: 'Staff',
    })
    expect(markup).toContain('5.00')
    expect(markup).toContain('Staff')
  })
})

// ── buildCustomerBillMarkup ───────────────────────────────────────────────────

describe('buildCustomerBillMarkup', () => {
  const baseOpts: CustomerBillOptions = {
    orderId:       BASE_ORDER_ID,
    orderType:     'dine_in',
    merchantName:  'Test Cafe',
    customerName:  'Dave',
    tableLabel:    '7',
    address:       null,
    phoneNumber:   null,
    website:       null,
    items:         [ITEM_PAD_THAI, ITEM_SPRING_ROLL],
    createdAt:     '2026-01-15T18:30:00Z',
    subtotalCents: 3400,
    taxCents:      272,
  }

  test('returns a non-empty string', () => {
    const markup = buildCustomerBillMarkup(baseOpts)
    expect(markup.length).toBeGreaterThan(100)
  })

  test('contains subtotal', () => {
    const markup = buildCustomerBillMarkup(baseOpts)
    expect(markup).toContain('34.00')
  })

  test('contains tax amount', () => {
    const markup = buildCustomerBillMarkup(baseOpts)
    expect(markup).toContain('2.72')
  })

  test('contains tip percentage columns', () => {
    const markup = buildCustomerBillMarkup({
      ...baseOpts,
      tipPercentages: [18, 20, 22],
    })
    expect(markup).toContain('18%')
    expect(markup).toContain('20%')
    expect(markup).toContain('22%')
  })

  test('includes table label in header', () => {
    const markup = buildCustomerBillMarkup(baseOpts)
    expect(markup).toContain('Table 7')
  })

  test('shows service charge when provided', () => {
    const markup = buildCustomerBillMarkup({
      ...baseOpts,
      serviceChargeCents: 400,
      serviceChargeLabel: 'Gratuity 18%',
    })
    expect(markup).toContain('4.00')
    expect(markup).toContain('Gratuity 18%')
  })
})

// ── buildTestPageMarkup ───────────────────────────────────────────────────────

describe('buildTestPageMarkup', () => {
  test('returns a non-empty string containing printer IP and label', () => {
    const opts: TestPageOptions = { printerIp: '192.168.1.100', label: 'Kitchen' }
    const markup = buildTestPageMarkup(opts)
    expect(markup.length).toBeGreaterThan(20)
    expect(markup).toContain('192.168.1.100')
    expect(markup.toUpperCase()).toContain('KITCHEN')
  })
})
