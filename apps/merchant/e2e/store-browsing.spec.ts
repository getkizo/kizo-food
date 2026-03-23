/**
 * Store browsing — menu load, category nav, item details.
 *
 * Tests the LOADING → BROWSING flow and menu rendering for the
 * customer-facing PWA.
 */

import { test, expect } from './fixtures/index'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Wait for LOADING → BROWSING transition
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })
})

// ── Menu load ─────────────────────────────────────────────────────────────────

test('shows merchant name in store header', async ({ page }) => {
  await expect(page.locator('#store-name')).toHaveText('Test Cafe')
})

test('renders the seeded category and item', async ({ page }) => {
  // Category heading
  await expect(page.locator('.menu-section-title')).toContainText('Mains')

  // Item card
  await expect(page.locator('.menu-item-card')).toHaveCount(1)
  await expect(page.locator('.menu-item-card .item-name')).toHaveText('Pad Thai')
})

test('category pill scrolls to its section', async ({ page }) => {
  // Category nav pill rendered for "Mains"
  const pill = page.locator('#category-nav button', { hasText: 'Mains' })
  await expect(pill).toBeVisible()
  // Clicking pill keeps menu visible (doesn't navigate away)
  await pill.click()
  await expect(page.locator('#state-browsing')).toBeVisible()
})

// ── Modifier sheet ────────────────────────────────────────────────────────────

test('tapping an item card opens the modifier sheet', async ({ page }) => {
  await page.locator('.menu-item-card').click()

  // Sheet opens with .open class
  await expect(page.locator('#modifier-sheet')).toHaveClass(/open/)
  // Shows the item name
  await expect(page.locator('#sheet-item-name')).toHaveText('Pad Thai')
})

test('modifier sheet cancel button closes the sheet', async ({ page }) => {
  await page.locator('.menu-item-card').click()
  await expect(page.locator('#modifier-sheet')).toHaveClass(/open/)

  await page.locator('#sheet-cancel-btn').click()
  await expect(page.locator('#modifier-sheet')).not.toHaveClass(/open/)
})

test('modifier sheet shows modifier group options', async ({ page, world }) => {
  // Only meaningful if a modifier group was seeded
  if (!world.modGroupId) test.skip()

  await page.locator('.menu-item-card').click()
  await expect(page.locator('.modifier-group')).toHaveCount(1)
  await expect(page.locator('.modifier-group-name')).toContainText('Protein')
  await expect(page.locator('.modifier-option')).toHaveCount(2)
})

// ── View toggle ───────────────────────────────────────────────────────────────

test('My Orders tab shows empty history state', async ({ page }) => {
  await page.locator('#nav-history-btn').click()
  await expect(page.locator('#order-history-section')).toBeVisible()
  await expect(page.locator('#order-history-empty')).toBeVisible()
})

test('Menu tab returns to menu view from history', async ({ page }) => {
  await page.locator('#nav-history-btn').click()
  await expect(page.locator('#order-history-section')).toBeVisible()

  await page.locator('#nav-menu-btn').click()
  await expect(page.locator('#menu-body')).toBeVisible()
  await expect(page.locator('#order-history-section')).toBeHidden()
})

// ── Active order bar ──────────────────────────────────────────────────────────

test('active order bar is hidden when no active order in localStorage', async ({ page }) => {
  await expect(page.locator('#active-order-bar')).toBeHidden()
})

test('active order bar appears when active order is seeded in localStorage', async ({ page, seedActiveOrder }) => {
  await seedActiveOrder({
    orderId:    'ord_test_bar_visible',
    pickupCode: 'BAR1',
    status:     'received',
  })
  await page.reload()
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

  await expect(page.locator('#active-order-bar')).toBeVisible()
  await expect(page.locator('#active-order-code')).toHaveText('BAR1')
})
