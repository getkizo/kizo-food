import { describe, it, expect } from 'bun:test'
import { computeDiscount, discountMatches } from '../src/utils/discount'

describe('computeDiscount — percent', () => {
  it('10% off $30 = $3', () => {
    expect(computeDiscount({ discountType: 'percent', discountValue: 10,
      subtotalCents: 3000, minOrderCents: 0 })).toBe(300)
  })
  it('rounds half-up', () => {
    // 15% of 333 = 49.95 → rounds to 50
    expect(computeDiscount({ discountType: 'percent', discountValue: 15,
      subtotalCents: 333, minOrderCents: 0 })).toBe(50)
  })
  it('returns 0 when subtotal < min_order_cents', () => {
    expect(computeDiscount({ discountType: 'percent', discountValue: 10,
      subtotalCents: 1000, minOrderCents: 2000 })).toBe(0)
  })
  it('applies when subtotal equals min exactly', () => {
    expect(computeDiscount({ discountType: 'percent', discountValue: 10,
      subtotalCents: 2000, minOrderCents: 2000 })).toBe(200)
  })
})

describe('computeDiscount — fixed_cents', () => {
  it('$5 off a $30 order', () => {
    expect(computeDiscount({ discountType: 'fixed_cents', discountValue: 500,
      subtotalCents: 3000, minOrderCents: 0 })).toBe(500)
  })
  it('caps at subtotal — cannot go negative', () => {
    expect(computeDiscount({ discountType: 'fixed_cents', discountValue: 5000,
      subtotalCents: 1000, minOrderCents: 0 })).toBe(1000)
  })
  it('returns 0 below min order', () => {
    expect(computeDiscount({ discountType: 'fixed_cents', discountValue: 500,
      subtotalCents: 800, minOrderCents: 1000 })).toBe(0)
  })
})

describe('discountMatches', () => {
  it('exact match returns true', () => {
    expect(discountMatches(300, 300)).toBe(true)
  })
  it('1 cent diff returns true (rounding tolerance)', () => {
    expect(discountMatches(300, 299)).toBe(true)
  })
  it('2 cent diff returns false', () => {
    expect(discountMatches(300, 298)).toBe(false)
  })
})
