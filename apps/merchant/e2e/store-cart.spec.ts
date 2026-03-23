/**
 * Store cart — add/remove items, cart bar, checkout panel.
 */

import { test, expect } from './fixtures/index'

/** Navigate to the store and wait for the menu to load. */
async function goToMenu(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })
}

/** Open the modifier sheet for the first item and click "Add to Order". */
async function addItemToCart(page: import('@playwright/test').Page) {
  await page.locator('.menu-item-card').first().click()
  await expect(page.locator('#modifier-sheet')).toHaveClass(/open/)
  await page.locator('#sheet-add-btn').click()
  // Sheet should close after add
  await expect(page.locator('#modifier-sheet')).not.toHaveClass(/open/)
}

// ── Cart bar ──────────────────────────────────────────────────────────────────

test('cart bar is hidden when cart is empty', async ({ page }) => {
  await goToMenu(page)
  await expect(page.locator('#cart-bar')).toBeHidden()
})

test('adding an item shows the cart bar with count 1', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)

  await expect(page.locator('#cart-bar')).toBeVisible()
  await expect(page.locator('#cart-bar-count')).toHaveText('1')
})

test('adding the same item twice increments count to 2', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await addItemToCart(page)

  await expect(page.locator('#cart-bar-count')).toHaveText('2')
})

// ── Cart sheet (checkout panel pre-state) ─────────────────────────────────────

test('tapping cart bar opens the checkout panel', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)

  await page.locator('#cart-bar-btn').click()
  await expect(page.locator('#state-checkout')).toBeVisible()
})

test('checkout panel shows the item in the order summary', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await page.locator('#cart-bar-btn').click()

  await expect(page.locator('#checkout-items-list')).toContainText('Pad Thai')
})

test('checkout panel shows non-zero totals', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await page.locator('#cart-bar-btn').click()

  const subtotal = page.locator('#checkout-subtotal')
  await expect(subtotal).toContainText('$')
  // $14.00 for Pad Thai
  await expect(subtotal).toContainText('14')
})

// ── Remove items ──────────────────────────────────────────────────────────────

test('delete button removes item from cart', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await page.locator('#cart-bar-btn').click()
  await expect(page.locator('#state-checkout')).toBeVisible()

  // Click the × delete button on the first item
  await page.locator('.checkout-item-del').first().click()

  // removeFromCart stays in CHECKOUT state (no auto-redirect) but re-renders
  // the items list — Pad Thai should be gone from the summary.
  await expect(page.locator('#checkout-items-list')).not.toContainText('Pad Thai')
})

test('Clear button empties entire cart', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await addItemToCart(page)
  await page.locator('#cart-bar-btn').click()

  // The Clear button triggers a confirm() dialog — accept it
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('#checkout-clear-btn').click()

  // clearCart() transitions to BROWSING and calls renderBar with empty cart
  await expect(page.locator('#state-browsing')).toBeVisible()
  await expect(page.locator('#cart-bar')).toBeHidden()
})

// ── Back navigation ───────────────────────────────────────────────────────────

test('back button from checkout returns to browsing', async ({ page }) => {
  await goToMenu(page)
  await addItemToCart(page)
  await page.locator('#cart-bar-btn').click()
  await expect(page.locator('#state-checkout')).toBeVisible()

  await page.locator('#checkout-back-btn').click()
  await expect(page.locator('#state-browsing')).toBeVisible()
})
