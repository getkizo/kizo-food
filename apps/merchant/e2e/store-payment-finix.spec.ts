/**
 * Finix payment flow — E2E tests
 *
 * Strategy: Finix hosted checkout is an external URL we cannot control.
 * We intercept at two seams:
 *
 *   1. POST /api/store/orders/:id/pay
 *      → mocked to return paymentUrl = /pay-return?order=ID&provider=finix
 *        (skips the real Finix hop — store.js does window.location.href = paymentUrl,
 *        which navigates the browser directly to /pay-return just as Finix would)
 *
 *   2. POST /api/store/orders/:id/payment-result
 *      → mocked per-test (success / decline / network error)
 *
 * No real Finix sandbox credentials are required.
 *
 * Verified selectors (from store/index.html + store-menu.js):
 *   .menu-item-card          — individual menu items in the grid
 *   #sheet-add-btn           — "Add to Order" in the modifier/item sheet
 *   #cart-bar-btn            — tappable cart bar (opens CHECKOUT)
 *   #checkout-pay-btn        — "Pay Now" button (submits order + initiates payment)
 *   #state-paying            — interim state while redirecting to Finix
 *   #state-confirmed         — post-payment confirmed screen
 *   #state-error             — error screen
 *   #confirmed-pickup-code   — pickup code shown after payment
 */

import { test, expect } from './fixtures/index'

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE_URL = 'http://127.0.0.1:3099'

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Seed the customer name in localStorage (replaces the UI name-entry step).
 * Must be called after page.goto('/') so the origin is established.
 */
async function seedCustomerName(page: import('@playwright/test').Page, name = 'E2E Tester') {
  await page.evaluate((n) => {
    localStorage.setItem('kizo_customer', JSON.stringify({ name: n, phone: '' }))
  }, name)
}

/**
 * Mock POST /api/store/orders/:orderId/pay to return paymentUrl pointing directly
 * at /pay-return (simulating what Finix does after checkout — it redirects the
 * browser back to our returnUrl).
 *
 * Note: page.route() 302 responses are not followed as real browser navigations,
 * so we skip the intermediate fake-Finix hop and return the final destination URL
 * directly as paymentUrl. store.js does `window.location.href = paymentUrl`, which
 * causes a real navigation to /pay-return exactly as Finix would.
 */
async function mockFinixPayRedirect(
  page:    import('@playwright/test').Page,
  orderId: string,
) {
  const payReturnUrl = `${BASE_URL}/pay-return?order=${orderId}&provider=finix`
  await page.route(`/api/store/orders/${orderId}/pay`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    // Brief delay so the PAYING state (set synchronously before this fetch) is
    // visible long enough for Playwright's polling to observe it.
    await new Promise(r => setTimeout(r, 150))
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({ paymentUrl: payReturnUrl }),
    })
  })
}

/**
 * Mock POST /api/store/orders/:orderId/payment-result.
 */
async function mockPaymentResult(
  page:     import('@playwright/test').Page,
  orderId:  string,
  response: { status: number; body: object },
) {
  await page.route(`/api/store/orders/${orderId}/payment-result`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status:      response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    })
  })
}

/**
 * Go through the full cart UI: menu → item sheet → cart → checkout → pay.
 *
 * Requires:
 *   - mockFinixPayRedirect() called with a known orderId BEFORE calling this
 *   - POST /api/store/orders mocked to return that orderId
 *   - mockPaymentResult() called BEFORE calling this
 */
async function goThroughCartAndPay(
  page:    import('@playwright/test').Page,
  orderId: string,
  pickupCode: string,
) {
  await page.goto('/')
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

  // Seed customer name so the checkout doesn't block waiting for input
  await seedCustomerName(page)

  // Mock order creation to return our known orderId
  await page.route('/api/store/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({
        orderId,
        pickupCode,
        totalCents: 1400,
        subtotalCents: 1400,
        taxCents: 0,
      }),
    })
  })

  // Tap the first menu item card → opens item/modifier sheet
  await page.locator('.menu-item-card').first().click()
  await expect(page.locator('#sheet-add-btn')).toBeVisible()

  // Add to order
  await page.locator('#sheet-add-btn').click()

  // Cart bar should appear → tap it to open CHECKOUT
  await expect(page.locator('#cart-bar-btn')).toBeVisible()
  await page.locator('#cart-bar-btn').click()
  await expect(page.locator('#state-checkout')).toBeVisible()

  // Dismiss the privacy overlay if it's blocking the pay button
  const privacyOverlay = page.locator('#privacy-overlay')
  if (await privacyOverlay.isVisible()) {
    await page.locator('#privacy-close-btn').click()
    await expect(privacyOverlay).toBeHidden()
  }

  // Tap Pay Now — triggers POST /api/store/orders → POST /api/store/orders/:id/pay
  await page.locator('#checkout-pay-btn').click()

  // PAYING state shown while redirecting
  await expect(page.locator('#state-paying')).toBeVisible({ timeout: 8_000 })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('Finix: happy path via /pay-return — paid order reaches CONFIRMED', async ({ page, placeOrder }) => {
  const { orderId, pickupCode } = await placeOrder()

  // Seed localStorage before navigating to /pay-return
  await page.goto('/')
  await page.evaluate(([activeKey, activeVal, detailKey, detailVal]) => {
    localStorage.setItem(activeKey, activeVal)
    localStorage.setItem(detailKey, detailVal)
  }, [
    'kizo_active_order',
    JSON.stringify({ orderId, pickupCode, status: 'received', estimatedReadyAt: null }),
    `kizo_order_${orderId}`,
    JSON.stringify({ orderId, pickupCode, status: 'received', items: [], subtotalCents: 0, taxCents: 0, totalCents: 0, scheduledFor: null }),
  ])

  await mockPaymentResult(page, orderId, { status: 200, body: { status: 'paid', orderId } })
  await page.route(`/api/store/orders/${orderId}/status`, route => route.abort())

  // Simulate Finix redirecting back
  await page.goto(`/pay-return?order=${orderId}&provider=finix`)

  await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#confirmed-pickup-code')).toHaveText(pickupCode)
})

test('Finix: full cart UI flow — pay button triggers Finix redirect and reaches CONFIRMED', async ({ page }) => {
  const orderId    = 'ord_e2e_finix_ui'
  const pickupCode = 'FNX1'

  await page.goto('/')

  // Set up all mocks before interacting with the UI
  await mockFinixPayRedirect(page, orderId)
  await mockPaymentResult(page, orderId, { status: 200, body: { status: 'paid', orderId } })
  await page.route(`/api/store/orders/${orderId}/status`, route => route.abort())

  await goThroughCartAndPay(page, orderId, pickupCode)

  // After Finix redirect → pay-return → payment-result mock → CONFIRMED
  await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#confirmed-pickup-code')).toHaveText(pickupCode)
})

test('Finix: declined payment — 402 from payment-result does not show CONFIRMED', async ({ page, placeOrder }) => {
  const { orderId, pickupCode } = await placeOrder()

  await page.goto('/')
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [
    'kizo_active_order',
    JSON.stringify({ orderId, pickupCode, status: 'received', estimatedReadyAt: null }),
  ])

  await mockPaymentResult(page, orderId, {
    status: 402,
    body:   { error: 'Payment not confirmed by processor' },
  })

  await page.goto(`/pay-return?order=${orderId}&provider=finix`)

  await expect(page.locator('#state-confirmed')).toBeHidden({ timeout: 10_000 })
  // App must not be stuck in PAYING — either error or browsing is acceptable
  await expect(page.locator('#state-paying')).toBeHidden({ timeout: 8_000 })
})

test('Finix: network failure on payment-result does not show CONFIRMED', async ({ page, placeOrder }) => {
  const { orderId, pickupCode } = await placeOrder()

  await page.goto('/')
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [
    'kizo_active_order',
    JSON.stringify({ orderId, pickupCode, status: 'received', estimatedReadyAt: null }),
  ])

  await page.route(`/api/store/orders/${orderId}/payment-result`, route => route.abort())

  await page.goto(`/pay-return?order=${orderId}&provider=finix`)

  await expect(page.locator('#state-confirmed')).toBeHidden({ timeout: 10_000 })
})

test('Finix: missing order param on /pay-return does not crash the app', async ({ page }) => {
  await page.goto('/pay-return?provider=finix')

  // Must not be stuck in PAYING or CONFIRMED — app should remain usable
  await expect(page.locator('#state-confirmed')).toBeHidden({ timeout: 10_000 })
  await expect(page.locator('#state-paying')).toBeHidden({ timeout: 5_000 })
})

test('Finix: duplicate /pay-return navigation does not double-charge', async ({ page, placeOrder }) => {
  const { orderId, pickupCode } = await placeOrder()

  await page.goto('/')
  await page.evaluate(([activeKey, activeVal, detailKey, detailVal]) => {
    localStorage.setItem(activeKey, activeVal)
    localStorage.setItem(detailKey, detailVal)
  }, [
    'kizo_active_order',
    JSON.stringify({ orderId, pickupCode, status: 'received', estimatedReadyAt: null }),
    `kizo_order_${orderId}`,
    JSON.stringify({ orderId, pickupCode, status: 'received', items: [], subtotalCents: 0, taxCents: 0, totalCents: 0, scheduledFor: null }),
  ])

  let callCount = 0
  await page.route(`/api/store/orders/${orderId}/payment-result`, async (route) => {
    callCount++
    const first = callCount === 1
    await route.fulfill({
      status:      first ? 200 : 409,
      contentType: 'application/json',
      body: JSON.stringify(
        first
          ? { status: 'paid', orderId }
          : { error: 'Order is not awaiting payment' }
      ),
    })
  })
  await page.route(`/api/store/orders/${orderId}/status`, route => route.abort())

  // First visit
  await page.goto(`/pay-return?order=${orderId}&provider=finix`)
  await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10_000 })

  // Second visit (e.g. browser back → forward) — must not crash or get stuck in PAYING
  await page.goto(`/pay-return?order=${orderId}&provider=finix`)
  await expect(page.locator('#state-paying')).toBeHidden({ timeout: 8_000 })

  // Server-side 409 idempotency guard — never called more than twice
  expect(callCount).toBeLessThanOrEqual(2)
})
