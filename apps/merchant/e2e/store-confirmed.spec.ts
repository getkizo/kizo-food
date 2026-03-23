/**
 * Store confirmed screen — order tracking, cancel/toast regression.
 *
 * Key regression: #confirmed-cancel-section and #confirmed-cancelled-msg
 * must NEVER be simultaneously visible.
 *
 * Root cause (fixed): both elements had `display: flex` in store.css which
 * overrides the browser UA's `[hidden] { display: none }` rule (equal CSS
 * specificity, author stylesheet wins). The fix adds explicit
 * `[hidden] { display: none !important }` overrides for both selectors.
 *
 * These tests use `page.evaluate()` to call `window.Store.updateStatusTracker()`
 * directly, simulating poll results without relying on actual network timing.
 */

import { test, expect } from './fixtures/index'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Navigate to the confirmed screen by seeding localStorage and tapping the bar. */
async function goToConfirmed(
  page:        import('@playwright/test').Page,
  seedActive:  (s: import('./fixtures/index').ActiveOrderSeed) => Promise<void>,
  opts: {
    orderId:      string
    pickupCode:   string
    scheduledFor?: string | null
  },
) {
  await page.goto('/')
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

  // Abort the status-poll endpoint so no real polls fire during setup.
  // Using abort() (network error) rather than fulfill() so the optimistic
  // cancel section for scheduled orders isn't hidden by an immediate poll
  // returning cancellable: false before the test can assert on it.
  await page.route(`/api/store/orders/${opts.orderId}/status`, (route) => route.abort())

  await seedActive({
    orderId:     opts.orderId,
    pickupCode:  opts.pickupCode,
    status:      'received',
    scheduledFor: opts.scheduledFor ?? null,
  })
  await page.reload()
  await expect(page.locator('#state-browsing')).toBeVisible({ timeout: 10_000 })

  // Tap the active-order bar to navigate to CONFIRMED
  await expect(page.locator('#active-order-bar')).toBeVisible()
  await page.locator('#active-order-bar').click()
  await expect(page.locator('#state-confirmed')).toBeVisible()
}

// ── Basic confirmed screen ────────────────────────────────────────────────────

test('confirmed screen shows pickup code from localStorage', async ({ page, seedActiveOrder }) => {
  await goToConfirmed(page, seedActiveOrder, {
    orderId:    'ord_e2e_code',
    pickupCode: 'XKCD',
  })

  await expect(page.locator('#confirmed-pickup-code')).toHaveText('XKCD')
})

test('scheduled order shows "Ready by" time', async ({ page, seedActiveOrder }) => {
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)

  await goToConfirmed(page, seedActiveOrder, {
    orderId:     'ord_e2e_sched',
    pickupCode:  'SCH1',
    scheduledFor: noon.toISOString(),
  })

  await expect(page.locator('#confirmed-scheduled-time')).toBeVisible()
  await expect(page.locator('#confirmed-scheduled-label')).toContainText('Ready by')
})

test('non-scheduled order hides the scheduled-time element', async ({ page, seedActiveOrder }) => {
  await goToConfirmed(page, seedActiveOrder, {
    orderId:    'ord_e2e_nosched',
    pickupCode: 'NS01',
  })

  await expect(page.locator('#confirmed-scheduled-time')).toBeHidden()
})

// ── Cancel / toast mutual exclusion — REGRESSION ─────────────────────────────

test('cancel section and cancelled toast are hidden on initial confirmed render', async ({ page, seedActiveOrder }) => {
  // Non-scheduled order: cancel section should start hidden
  await goToConfirmed(page, seedActiveOrder, {
    orderId:    'ord_e2e_init',
    pickupCode: 'INIT',
  })

  await expect(page.locator('#confirmed-cancel-section')).toBeHidden()
  await expect(page.locator('#confirmed-cancelled-msg')).toBeHidden()
})

test('scheduled order optimistically shows cancel section', async ({ page, seedActiveOrder }) => {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(12, 0, 0, 0)

  await goToConfirmed(page, seedActiveOrder, {
    orderId:     'ord_e2e_optsched',
    pickupCode:  'OPT1',
    scheduledFor: tomorrow.toISOString(),
  })

  // Cancel section shown optimistically for scheduled orders
  await expect(page.locator('#confirmed-cancel-section')).toBeVisible()
  // But toast must NOT be visible
  await expect(page.locator('#confirmed-cancelled-msg')).toBeHidden()
})

test('REGRESSION: cancel section and toast are never simultaneously visible', async ({ page, seedActiveOrder }) => {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(12, 0, 0, 0)
  const deadline = new Date(tomorrow)
  deadline.setMinutes(deadline.getMinutes() - 20)  // 11:40

  await goToConfirmed(page, seedActiveOrder, {
    orderId:     'ord_e2e_reg',
    pickupCode:  'REG1',
    scheduledFor: tomorrow.toISOString(),
  })

  const cancelSection = page.locator('#confirmed-cancel-section')
  const cancelledMsg  = page.locator('#confirmed-cancelled-msg')

  // ── Step 1: simulate poll → 'received' + cancellable ────────────────────
  await page.evaluate((deadlineISO) => {
    window.Store?.updateStatusTracker('received', null, {
      cancellable:    true,
      cancelDeadline: deadlineISO,
    })
  }, deadline.toISOString())

  // Cancel section visible with specific deadline, toast hidden
  await expect(cancelSection).toBeVisible()
  await expect(cancelledMsg).toBeHidden()
  await expect(page.locator('#confirmed-cancel-deadline')).toContainText(':')  // time string

  // ── Step 2: simulate poll → 'cancelled' ─────────────────────────────────
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('cancelled', null, {})
  })

  // REGRESSION ASSERTION: toast visible, cancel section hidden (never both visible)
  await expect(cancelledMsg).toBeVisible()
  await expect(cancelSection).toBeHidden()
})

test('REGRESSION: toast remains visible after a stale "received" poll fires post-cancel', async ({ page, seedActiveOrder }) => {
  // Simulates an out-of-order network response: 'cancelled' arrives first,
  // then a stale 'received' result arrives. The toast must stay visible and
  // the cancel section must NOT re-appear.
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(12, 0, 0, 0)

  await goToConfirmed(page, seedActiveOrder, {
    orderId:     'ord_e2e_stale',
    pickupCode:  'STL1',
    scheduledFor: tomorrow.toISOString(),
  })

  const cancelSection = page.locator('#confirmed-cancel-section')
  const cancelledMsg  = page.locator('#confirmed-cancelled-msg')

  // Simulate 'cancelled' poll first
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('cancelled', null, {})
  })
  await expect(cancelledMsg).toBeVisible()
  await expect(cancelSection).toBeHidden()

  // Now a stale 'received' response arrives (out-of-order network)
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('received', null, {
      cancellable:    true,
      cancelDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    })
  })

  // Cancel section must NOT re-appear; toast must remain visible
  await expect(cancelledMsg).toBeVisible()
  await expect(cancelSection).toBeHidden()
})

// ── Status tracker ────────────────────────────────────────────────────────────

test('status tracker steps update with poll results', async ({ page, seedActiveOrder }) => {
  await goToConfirmed(page, seedActiveOrder, {
    orderId:    'ord_e2e_steps',
    pickupCode: 'STP1',
  })

  // Initial: step-received should be active
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('received', null, {})
  })
  await expect(page.locator('#step-received')).toHaveClass(/active/)

  // After 'confirmed': step-received done, step-accepted active
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('confirmed', null, {})
  })
  await expect(page.locator('#step-received')).toHaveClass(/done/)
  await expect(page.locator('#step-accepted')).toHaveClass(/active/)

  // After 'ready': step-ready active
  await page.evaluate(() => {
    window.Store?.updateStatusTracker('ready', null, {})
  })
  await expect(page.locator('#step-ready')).toHaveClass(/active/)
})

// ── "Place Another Order" ─────────────────────────────────────────────────────

test('"Place Another Order" returns to browsing state', async ({ page, seedActiveOrder }) => {
  await goToConfirmed(page, seedActiveOrder, {
    orderId:    'ord_e2e_neworder',
    pickupCode: 'NEW1',
  })

  await page.locator('#confirmed-new-order-btn').click()
  await expect(page.locator('#state-browsing')).toBeVisible()
})
