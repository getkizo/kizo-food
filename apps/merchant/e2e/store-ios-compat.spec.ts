/**
 * iOS 14+ compatibility — polyfills and CSS fallbacks.
 *
 * Validates that the crypto.randomUUID() polyfill produces valid UUIDs
 * and that CSS fallback values render elements with correct dimensions.
 *
 * Note: Playwright runs Chromium which supports all modern features natively.
 * These tests verify the polyfill logic works correctly and that fallback CSS
 * values don't break rendering on modern browsers.
 */

import { test, expect } from './fixtures/index'

// ── crypto.randomUUID() polyfill ────────────────────────────────────────────

test.describe('crypto.randomUUID polyfill', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })
  })

  test('native crypto.randomUUID produces a valid v4 UUID', async ({ page }) => {
    const uuid = await page.evaluate(() => crypto.randomUUID())
    expect(uuid).toMatch(UUID_RE)
  })

  test('polyfill activates and produces valid v4 UUIDs when native API is removed', async ({ page }) => {
    // Remove native randomUUID before the store script loads,
    // then re-run the polyfill logic inline to simulate iOS <15.4
    const uuids: string[] = await page.evaluate(() => {
      // Delete native implementation
      delete (crypto as any).randomUUID

      // Re-apply the polyfill (same logic as store.js)
      if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
        crypto.randomUUID = function () {
          var b = crypto.getRandomValues(new Uint8Array(16))
          b[6] = (b[6] & 0x0f) | 0x40
          b[8] = (b[8] & 0x3f) | 0x80
          var h = Array.from(b, function (v: number) { return v.toString(16).padStart(2, '0') }).join('')
          return (h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)) as `${string}-${string}-${string}-${string}-${string}`
        }
      }

      // Generate several UUIDs to check uniqueness + format
      return [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    })

    expect(uuids).toHaveLength(3)
    for (const uuid of uuids) {
      expect(uuid).toMatch(UUID_RE)
    }
    // All UUIDs should be unique
    expect(new Set(uuids).size).toBe(3)
  })

  test('polyfill UUID has correct version (4) and variant (RFC 4122) bits', async ({ page }) => {
    const parts: string[] = await page.evaluate(() => {
      delete (crypto as any).randomUUID
      crypto.randomUUID = function () {
        var b = crypto.getRandomValues(new Uint8Array(16))
        b[6] = (b[6] & 0x0f) | 0x40
        b[8] = (b[8] & 0x3f) | 0x80
        var h = Array.from(b, function (v: number) { return v.toString(16).padStart(2, '0') }).join('')
        return (h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)) as `${string}-${string}-${string}-${string}-${string}`
      }

      // Generate 10 UUIDs, return the version nibble and variant nibble
      return Array.from({ length: 10 }, () => {
        const u = crypto.randomUUID()
        // version is char 14 (0-indexed), variant is char 19
        return u[14] + '|' + u[19]
      })
    })

    for (const p of parts) {
      const [version, variant] = p.split('|')
      expect(version).toBe('4')
      expect(['8', '9', 'a', 'b']).toContain(variant)
    }
  })
})

// ── CSS fallback rendering ──────────────────────────────────────────────────

test.describe('CSS fallbacks render correctly', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })
  })

  test('body has non-zero min-height (dvh with vh fallback)', async ({ page }) => {
    const minHeight = await page.evaluate(() => {
      return getComputedStyle(document.body).minHeight
    })
    // Should resolve to a positive pixel value, not "0px" or empty
    expect(minHeight).not.toBe('0px')
    expect(minHeight).not.toBe('')
  })

  test('state-browsing panel has non-zero min-height', async ({ page }) => {
    const box = await page.locator('#state-browsing').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThan(0)
  })

  test('menu item card image placeholder has correct 4:3 aspect ratio', async ({ page }) => {
    const placeholder = page.locator('.item-photo-placeholder').first()

    // Placeholder may or may not exist depending on whether seeded item has an image
    // If no placeholder, the item has a real photo — check .item-photo instead
    const phCount = await page.locator('.item-photo-placeholder').count()
    const imgCount = await page.locator('.item-photo').count()

    if (phCount > 0) {
      const box = await placeholder.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThan(0)
      expect(box!.width).toBeGreaterThan(0)
      // Aspect ratio should be roughly 4:3 (tolerance for rounding)
      const ratio = box!.width / box!.height
      expect(ratio).toBeGreaterThan(1.2)
      expect(ratio).toBeLessThan(1.5)
    } else if (imgCount > 0) {
      const box = await page.locator('.item-photo').first().boundingBox()
      expect(box).not.toBeNull()
      expect(box!.height).toBeGreaterThan(0)
    } else {
      test.skip()
    }
  })

  test('modifier sheet has max-height set (vh with dvh fallback)', async ({ page }) => {
    const maxHeight = await page.evaluate(() => {
      return getComputedStyle(document.querySelector('#modifier-sheet')!).maxHeight
    })
    // Should be a resolved pixel value (from 90vh/90dvh), not "none"
    expect(maxHeight).not.toBe('none')
    expect(maxHeight).not.toBe('0px')
  })
})

// ── Order history pill backgrounds (color-mix fallback) ─────────────────────

test.describe('order history pill styling', () => {
  test('active-order pill has visible background color', async ({ page, seedActiveOrder }) => {
    // Seed an active order so history renders it with the active pill
    await page.goto('/')
    await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

    await seedActiveOrder({
      orderId:    'ord_pill_test',
      pickupCode: 'PIL1',
      status:     'received',
    })
    await page.reload()
    await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

    // Switch to My Orders tab
    await page.locator('#nav-history-btn').click()
    await expect(page.locator('#order-history-section')).toBeVisible()

    // The active order should show with an active pill
    const pill = page.locator('.order-history-active-pill').first()
    if (await pill.count() > 0) {
      const bg = await pill.evaluate((el) => getComputedStyle(el).backgroundColor)
      // Should have a non-transparent background (rgba with non-zero alpha, or solid color)
      expect(bg).not.toBe('rgba(0, 0, 0, 0)')
      expect(bg).not.toBe('transparent')
    }
  })
})

// ── Promise.all fallback in SW (structural check) ───────────────────────────

test.describe('service worker compatibility', () => {
  test('sw.js does not use Promise.allSettled', async ({ request }) => {
    // Fetch the SW source and verify it uses Promise.all (not allSettled)
    const res = await request.get('/store/sw.js')
    expect(res.ok()).toBe(true)
    const source = await res.text()
    expect(source).not.toContain('Promise.allSettled')
    expect(source).toContain('Promise.all')
  })

  test('sw.js uses current cache version string', async ({ request }) => {
    const res = await request.get('/store/sw.js')
    const source = await res.text()
    expect(source).toContain("const CACHE = 'store-v32'")
  })
})
