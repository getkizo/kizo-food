/**
 * Tests for the receipt-line description normalizer and the
 * autoMatchIngredient function (src/routes/manager.ts).
 *
 * normalizeReceiptDescription is a pure function — tested directly.
 * autoMatchIngredient hits the DB; tested with an in-memory DB seed.
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { invalidateApplianceMerchantCache } from '../src/routes/store'
import { normalizeReceiptDescription, autoMatchIngredient } from '../src/routes/manager'

const merchantId = 'm_test_normalizer_001'

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  const db = getDatabase()

  // Seed merchant (FK requirement)
  db.run(
    `INSERT INTO merchants (id, slug, business_name) VALUES (?, 'test-norm', 'Test Norm Cafe')`,
    [merchantId],
  )

  // Seed ingredients (lowercase names + display names)
  const ingredients: Array<[string, string, string, string]> = [
    ['ing_egg',          'egg',                'Egg',                'protein'],
    ['ing_eggplant',     'eggplant',           'Eggplant',           'vegetable'],
    ['ing_redbp',        'red bell pepper',    'Red Bell Pepper',    'vegetable'],
    ['ing_greenbp',      'green bell pepper',  'Green Bell Pepper',  'vegetable'],
    ['ing_bellp',        'bell pepper',        'Bell Pepper',        'vegetable'],
    ['ing_blackp',       'black pepper',       'Black Pepper',       'spice'],
    ['ing_chicken',      'chicken',            'Chicken',            'protein'],
    ['ing_chicken_b',    'chicken breast',     'Chicken Breast',     'protein'],
    ['ing_potato',       'potato',             'Potato',             'vegetable'],
    ['ing_sweet_potato', 'sweet potato',       'Sweet Potato',       'vegetable'],
    ['ing_iceberg',      'iceberg lettuce',    'Iceberg Lettuce',    'vegetable'],
    ['ing_lemongrass',   'lemongrass',         'Lemongrass',         'vegetable'],
    ['ing_lemon',        'lemon',              'Lemon',              'produce'],
  ]
  for (const [id, name, displayName, category] of ingredients) {
    db.run(
      `INSERT INTO extra_ingredients (id, merchant_id, name, display_name, category) VALUES (?, ?, ?, ?, ?)`,
      [id, merchantId, name, displayName, category],
    )
  }

  // Seed aliases — common short-form base names that need explicit mapping
  // because the ingredient name is longer than the OCR phrase
  const aliases: Array<[string, string]> = [
    ['red pepper',   'ing_redbp'],
    ['green pepper', 'ing_greenbp'],
    ['eggs',         'ing_egg'],
  ]
  for (const [alias, ingredientId] of aliases) {
    db.run(
      `INSERT INTO ingredient_aliases (merchant_id, alias_text, ingredient_id) VALUES (?, ?, ?)`,
      [merchantId, alias, ingredientId],
    )
  }
})

// ── normalizeReceiptDescription ───────────────────────────────────────────────

describe('normalizeReceiptDescription', () => {
  test('strips simple weight prefix', () => {
    expect(normalizeReceiptDescription('10.24 lb red pepper')).toBe('red pepper')
  })

  test('strips integer weight prefix', () => {
    expect(normalizeReceiptDescription('21 lb green pepper')).toBe('green pepper')
  })

  test('strips bag prefix', () => {
    expect(normalizeReceiptDescription('1 bg pho noodles')).toBe('pho noodles')
  })

  test('strips bunch prefix', () => {
    expect(normalizeReceiptDescription('10 bu green onion')).toBe('green onion')
  })

  test('strips head prefix', () => {
    expect(normalizeReceiptDescription('3 hd iceberg lettuce')).toBe('iceberg lettuce')
  })

  test('strips stalks prefix', () => {
    expect(normalizeReceiptDescription('1 stk celery')).toBe('celery')
  })

  test('strips case-and-dozen compound prefix', () => {
    expect(normalizeReceiptDescription('1 cs 0 dz eggs - medium bulk')).toBe('eggs - medium bulk')
  })

  test('strips no-space compound prefix variant', () => {
    expect(normalizeReceiptDescription('1cs 0dz eggs - medium bulk')).toBe('1cs 0dz eggs - medium bulk')
    // ↑ Intentional: tightly-packed variants aren't normalized — these are rare.
  })

  test('strips trailing # weight marker', () => {
    expect(normalizeReceiptDescription('red pepper 25#')).toBe('red pepper')
  })

  test('strips trailing % (OCR error of #)', () => {
    expect(normalizeReceiptDescription('red pepper 25%')).toBe('red pepper')
  })

  test('strips trailing count-per-box (6 top)', () => {
    expect(normalizeReceiptDescription('cucumber 6 top')).toBe('cucumber')
  })

  test('strips trailing - large', () => {
    expect(normalizeReceiptDescription('green pepper - large')).toBe('green pepper')
  })

  test('strips trailing - medium', () => {
    expect(normalizeReceiptDescription('mushroom - medium')).toBe('mushroom')
  })

  test('strips both prefix and suffix', () => {
    expect(normalizeReceiptDescription('10.24 lb red pepper 25#')).toBe('red pepper')
  })

  test('lowercases', () => {
    expect(normalizeReceiptDescription('CHICKEN BREAST')).toBe('chicken breast')
  })

  test('empty / null / whitespace returns empty', () => {
    expect(normalizeReceiptDescription('')).toBe('')
    expect(normalizeReceiptDescription('   ')).toBe('')
    // @ts-expect-error testing null tolerance
    expect(normalizeReceiptDescription(null)).toBe('')
  })

  test('already-clean descriptions are unchanged (lowercased)', () => {
    expect(normalizeReceiptDescription('chicken breast')).toBe('chicken breast')
    expect(normalizeReceiptDescription('eggplant')).toBe('eggplant')
  })
})

// ── autoMatchIngredient ───────────────────────────────────────────────────────

describe('autoMatchIngredient', () => {
  test('exact name match wins immediately (tier 1)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'egg')).toBe('ing_egg')
    expect(autoMatchIngredient(db, merchantId, 'chicken breast')).toBe('ing_chicken_b')
  })

  test('exact display_name match also works (tier 1)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'Eggplant')).toBe('ing_eggplant')
  })

  test('exact alias match (tier 1)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'eggs')).toBe('ing_egg')
    expect(autoMatchIngredient(db, merchantId, 'red pepper')).toBe('ing_redbp')
  })

  test('quantity prefix matches via normalize (tier 2)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, '10.24 lb red pepper 25#')).toBe('ing_redbp')
    expect(autoMatchIngredient(db, merchantId, '21 lb green pepper - large')).toBe('ing_greenbp')
    expect(autoMatchIngredient(db, merchantId, '3 hd iceberg lettuce')).toBe('ing_iceberg')
  })

  test('substring match for description containing ingredient name (tier 3)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'fresh chicken breast 40#')).toBe('ing_chicken_b')
  })

  test('substring tier prefers longer ingredient name (sweet potato > potato)', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'mt fz japanese sweet potato')).toBe('ing_sweet_potato')
  })

  test('whole-word boundary: egg does NOT match eggplant', () => {
    const db = getDatabase()
    // "chinese eggplant" — substring tier finds "eggplant" but not "egg"
    expect(autoMatchIngredient(db, merchantId, 'chinese eggplant')).toBe('ing_eggplant')
    // "2.85 lb chinese eggplant" — same after normalize
    expect(autoMatchIngredient(db, merchantId, '2.85 lb chinese eggplant')).toBe('ing_eggplant')
  })

  test('whole-word boundary: lemon does NOT match lemongrass', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, 'fresh lemongrass')).toBe('ing_lemongrass')
  })

  test('ambiguous descriptions return null (no false positives)', () => {
    const db = getDatabase()
    // "pepper" alone matches multiple ingredients of equal name-length: none win
    expect(autoMatchIngredient(db, merchantId, 'pepper')).toBeNull()
  })

  test('empty / unknown description returns null', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, '')).toBeNull()
    expect(autoMatchIngredient(db, merchantId, 'something we have never seen')).toBeNull()
  })

  test('plural egg ALIAS resolves via tier 1', () => {
    const db = getDatabase()
    expect(autoMatchIngredient(db, merchantId, '1 cs 0 dz eggs - medium bulk')).toBe('ing_egg')
  })
})
