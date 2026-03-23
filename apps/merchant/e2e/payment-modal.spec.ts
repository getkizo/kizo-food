/**
 * E2E tests for the in-person payment modal (dine-in / takeout flow).
 *
 * Covers:
 *   - Cash payment with signature capture
 *   - Cash payment skipping signature
 *   - Cash payment with 20% tip
 *   - Close button exits from BILL_REVIEW
 *   - PIN exit after final payment leg
 *   - Split payment (2-way equal) with PIN exit
 */

import { test, expect } from './fixtures'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set auth tokens in localStorage and navigate to the dashboard Orders section.
 * Uses hash navigation (#orders) so we avoid sidebar interaction entirely.
 * Waits until the dashboard has booted and order cards are rendered in the DOM.
 */
async function goToDashboardOrders(
  page: import('@playwright/test').Page,
  world: import('./fixtures').World,
) {
  // Establish the origin before writing localStorage
  await page.goto('/')
  await page.evaluate(
    ([token, refresh, mid]) => {
      localStorage.setItem('accessToken', token)
      localStorage.setItem('refreshToken', refresh)
      localStorage.setItem('merchantId', mid)
    },
    [world.ownerToken, world.refreshToken, world.merchantId],
  )

  // Navigate directly to the Orders section via hash — dashboard reads
  // window.location.hash in its DOMContentLoaded handler and calls showSection('orders')
  await page.goto('/merchant#orders')

  // Wait for auth to complete (window.state.merchantId set after /api/auth/me)
  await page.waitForFunction(
    () => !!(window as any).state?.merchantId,
    { timeout: 10_000 },
  )

  // Wait for order cards to be rendered in the list DOM
  // Using waitForFunction bypasses all CSS hidden/visibility issues
  await page.waitForFunction(
    () => (document.getElementById('orders-list')?.children.length ?? 0) > 0,
    { timeout: 15_000 },
  )
}

/** Create a dine-in order via the dashboard API and return its ID. */
async function createDineInOrder(
  world: import('./fixtures').World,
): Promise<string> {
  const res = await fetch(
    `${world.BASE}/api/merchants/${world.merchantId}/orders`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${world.ownerToken}`,
      },
      body: JSON.stringify({
        orderType: 'dine_in',
        customerName: 'E2E Diner',
        tableLabel: 'Table 1',
        items: [
          {
            itemId: world.itemId,
            name: 'Pad Thai',
            priceCents: 1400,
            quantity: 2,
          },
        ],
      }),
    },
  )
  if (!res.ok) throw new Error(`createDineInOrder failed (${res.status}): ${await res.text()}`)
  const data: any = await res.json()
  return data.orderId ?? data.id
}

/** Draw a simple diagonal stroke on the signature canvas. */
async function drawSignature(page: import('@playwright/test').Page) {
  const canvas = page.locator('#pm-sig-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Signature canvas not visible')
  await page.mouse.move(box.x + 20, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 5 })
  await page.mouse.up()
}

/** Enter a 4-digit PIN on the payment modal keypad.
 *  The modal auto-submits after the 4th digit — no submit button click needed.
 */
async function enterPin(page: import('@playwright/test').Page, pin: string) {
  for (const digit of pin) {
    await page.locator(`.pm-key[data-key="${digit}"]`).click()
  }
}

/** Expand an order card and open the payment modal. */
async function openPaymentModal(
  page: import('@playwright/test').Page,
  orderId: string,
) {
  const card = page.locator(`.order-card[data-order-id="${orderId}"]`)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('.order-card-header').click()
  await card.locator('button', { hasText: 'Review & Pay' }).click()
  const overlay = page.locator('#payment-modal-overlay')
  await expect(overlay).toBeVisible()
  return overlay
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Payment Modal — Dine-in', () => {

  test('full cash payment with signature and PIN exit', async ({ page, world }) => {
    const orderId = await createDineInOrder(world)
    await goToDashboardOrders(page, world)

    const overlay = await openPaymentModal(page, orderId)

    // BILL_REVIEW — verify items shown, select No Tip, go Cash
    await expect(overlay.locator('.pm-screen')).toContainText('Pad Thai')
    await overlay.locator('.pm-tip-btn[data-tip-pct="0"]').click()
    await overlay.locator('#pm-btn-cash').click()

    // CASH_CONFIRM
    await expect(overlay.locator('#pm-btn-confirm-cash')).toBeVisible()
    await overlay.locator('#pm-btn-confirm-cash').click()

    // SIGNATURE — draw then accept
    await expect(overlay.locator('#pm-sig-canvas')).toBeVisible()
    await drawSignature(page)
    await overlay.locator('#pm-sig-accept').click()

    // RECEIPT_OPTIONS — uncheck print (no printer in test env)
    await expect(overlay.locator('#pm-btn-done')).toBeVisible()
    const printCheck = overlay.locator('#pm-print-check')
    if (await printCheck.isChecked()) await printCheck.uncheck()
    await overlay.locator('#pm-btn-done').click()

    // PIN_EXIT — enter PIN → modal closes
    await expect(overlay.locator('#pm-keypad')).toBeVisible({ timeout: 10_000 })
    await enterPin(page, world.employeePin)
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })

  test('cash payment skipping signature', async ({ page, world }) => {
    const orderId = await createDineInOrder(world)
    await goToDashboardOrders(page, world)

    const overlay = await openPaymentModal(page, orderId)

    // BILL_REVIEW → CASH_CONFIRM
    await overlay.locator('.pm-tip-btn[data-tip-pct="0"]').click()
    await overlay.locator('#pm-btn-cash').click()
    await overlay.locator('#pm-btn-confirm-cash').click()

    // SIGNATURE — skip
    await expect(overlay.locator('#pm-sig-skip')).toBeVisible()
    await overlay.locator('#pm-sig-skip').click()

    // RECEIPT_OPTIONS → Done
    await expect(overlay.locator('#pm-btn-done')).toBeVisible()
    const printCheck = overlay.locator('#pm-print-check')
    if (await printCheck.isChecked()) await printCheck.uncheck()
    await overlay.locator('#pm-btn-done').click()

    // PIN_EXIT
    await expect(overlay.locator('#pm-keypad')).toBeVisible({ timeout: 10_000 })
    await enterPin(page, world.employeePin)
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })

  test('cash payment with 20% tip', async ({ page, world }) => {
    const orderId = await createDineInOrder(world)
    await goToDashboardOrders(page, world)

    const overlay = await openPaymentModal(page, orderId)

    // Select 20% tip — 2 items × $14.00 = $28.00 subtotal → tip = $5.60
    await overlay.locator('.pm-tip-btn[data-tip-pct="20"]').click()
    await expect(overlay.locator('.pm-screen')).toContainText('$5.60')

    // Cash → Confirm → Skip sig → Done
    await overlay.locator('#pm-btn-cash').click()
    await overlay.locator('#pm-btn-confirm-cash').click()
    await overlay.locator('#pm-sig-skip').click()

    const printCheck = overlay.locator('#pm-print-check')
    if (await printCheck.isChecked()) await printCheck.uncheck()
    await overlay.locator('#pm-btn-done').click()

    // PIN_EXIT
    await expect(overlay.locator('#pm-keypad')).toBeVisible({ timeout: 10_000 })
    await enterPin(page, world.employeePin)
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })

  test('close button exits from BILL_REVIEW', async ({ page, world }) => {
    const orderId = await createDineInOrder(world)
    await goToDashboardOrders(page, world)

    const overlay = await openPaymentModal(page, orderId)

    // X button should dismiss from BILL_REVIEW without completing payment
    await overlay.locator('.pm-close-btn').click()
    await expect(overlay).toBeHidden()
  })

  test('2-way equal split cash payment', async ({ page, world }) => {
    const orderId = await createDineInOrder(world)
    await goToDashboardOrders(page, world)

    const overlay = await openPaymentModal(page, orderId)

    // BILL_REVIEW → SPLIT_SELECT via "⚡ Split" button
    await overlay.locator('#pm-btn-split').click()

    // SPLIT_SELECT → click Equal card, then "2 people" sub-button
    await overlay.locator('#pm-split-equal').click()
    await overlay.locator('.pm-split-way-btn[data-ways="2"]').click()

    // Back in BILL_REVIEW — split banner shows "Person 1 of 2"
    await expect(overlay.locator('.pm-screen')).toContainText('Person 1 of 2')

    // ── Leg 1 of 2 ──────────────────────────────────────────────────────────
    await overlay.locator('.pm-tip-btn[data-tip-pct="0"]').click()
    await overlay.locator('#pm-btn-cash').click()
    await overlay.locator('#pm-btn-confirm-cash').click()
    await overlay.locator('#pm-sig-skip').click()

    const printCheck1 = overlay.locator('#pm-print-check')
    if (await printCheck1.isChecked()) await printCheck1.uncheck()
    // Button text is "Record & Next →" for non-final legs
    await overlay.locator('#pm-btn-done').click()

    // LEG_COMPLETE — "Person 2 →" button (#pm-btn-next-person)
    await expect(overlay.locator('#pm-btn-next-person')).toBeVisible({ timeout: 10_000 })
    await overlay.locator('#pm-btn-next-person').click()

    // ── Leg 2 of 2 (final) ──────────────────────────────────────────────────
    await expect(overlay.locator('.pm-screen')).toContainText('Person 2 of 2')
    await overlay.locator('.pm-tip-btn[data-tip-pct="0"]').click()
    await overlay.locator('#pm-btn-cash').click()
    await overlay.locator('#pm-btn-confirm-cash').click()
    await overlay.locator('#pm-sig-skip').click()

    const printCheck2 = overlay.locator('#pm-print-check')
    if (await printCheck2.isChecked()) await printCheck2.uncheck()
    // Button text is "Done & Close Tab" for the final leg
    await overlay.locator('#pm-btn-done').click()

    // PIN_EXIT — final leg triggers PIN exit
    await expect(overlay.locator('#pm-keypad')).toBeVisible({ timeout: 10_000 })
    await enterPin(page, world.employeePin)
    await expect(overlay).toBeHidden({ timeout: 10_000 })
  })
})
