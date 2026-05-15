import { describe, it, expect } from 'bun:test'
import { normalizeSlug, isValidSlug } from '../src/utils/slug'

describe('normalizeSlug', () => {
  it('uppercases and strips hyphens', () => {
    expect(normalizeSlug('VP-2606-KIR')).toBe('VP2606KIR')
  })
  it('lowercased input normalizes the same way', () => {
    expect(normalizeSlug('vp2606kir')).toBe('VP2606KIR')
  })
  it('already-clean slug is unchanged', () => {
    expect(normalizeSlug('VP2606KIR')).toBe('VP2606KIR')
  })
  it('strips all non-alphanumeric characters', () => {
    expect(normalizeSlug('vp_2606.kir!')).toBe('VP2606KIR')
  })
  it('empty string produces empty string', () => {
    expect(normalizeSlug('')).toBe('')
  })
  it('numeric-only slug works', () => {
    expect(normalizeSlug('12345')).toBe('12345')
  })
})

describe('isValidSlug', () => {
  it('accepts valid slug with hyphens', () => {
    expect(isValidSlug('VP-2606-KIR')).toBe(true)
  })
  it('accepts alphanumeric only', () => {
    expect(isValidSlug('RECEIPT')).toBe(true)
  })
  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false)
  })
  it('rejects slug over 24 chars', () => {
    expect(isValidSlug('A'.repeat(25))).toBe(false)
  })
  it('rejects slug with spaces', () => {
    expect(isValidSlug('VP 2606 KIR')).toBe(false)
  })
})
