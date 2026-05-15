/**
 * Gift Card payment flow debugger — runs against the live dev server.
 *
 * ⚠️  THIS SCRIPT TARGETS THE LIVE PRODUCTION SERVER. It must NEVER be run
 * accidentally. An explicit opt-in env flag is required.
 *
 * Usage:
 *   GC_DEBUG_MODE=1 bunx playwright test scripts/debug/gift-card-debug.ts \
 *     --config scripts/debug/gift-card-debug.config.ts --headed
 */
import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

if (!process.env.GC_DEBUG_MODE) {
  throw new Error(
    'gift-card-debug.ts: set GC_DEBUG_MODE=1 to confirm you intend to run against the live server.'
  )
}

const BASE_URL = 'https://dev.kizo.example'
const LOG_FILE = 'scripts/debug/gift-card-debug-results.json'

test('gift card purchase flow — full diagnostic', async ({ page }) => {
  const apiLogs: { url: string; method: string; status: number; body: unknown }[] = []
  const failedRequests: { url: string; method: string; status: number }[] = []
  const consoleLogs: string[] = []
  const errors: string[] = []

  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))
  page.on('pageerror', err => errors.push(err.message))

  // Capture ALL responses — including 4xx so we can see what's failing
  page.on('response', async resp => {
    const url = resp.url()
    const status = resp.status()
    const method = resp.request().method()
    let body: unknown = null
    try { body = await resp.json() } catch { body = null }
    apiLogs.push({ url, method, status, body })
    if (status >= 400) {
      failedRequests.push({ url, method, status })
    }
  })

  // ── Step 1: Load the gift card store ──────────────────────────────────────
  await page.goto(`${BASE_URL}/gift-cards`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'scripts/debug/screenshots/gc-01-loaded.png', fullPage: true })
  await page.locator('#gc-step-select').waitFor({ state: 'visible', timeout: 8_000 })

  // ── Step 2: Add $50 and proceed to checkout ───────────────────────────────
  await page.click('[data-cents="5000"]')
  await page.click('#gc-add-btn')
  await page.click('#gc-to-checkout-btn')
  await page.locator('#gc-step-checkout').waitFor({ state: 'visible', timeout: 5_000 })
  await page.fill('#gc-name', 'Test Buyer')
  await page.fill('#gc-email', 'testbuyer@example.com')
  await page.screenshot({ path: 'scripts/debug/screenshots/gc-03-checkout.png', fullPage: true })

  // ── Step 3: Click Purchase — wait for Finix redirect ─────────────────────
  await page.click('#gc-purchase-btn')
  try {
    await page.waitForURL(url => !url.toString().startsWith(BASE_URL + '/gift-cards'), { timeout: 15_000 })
  } catch {
    console.log('No Finix navigation in 15s. Current URL:', page.url())
    writeResults({ apiLogs, failedRequests, consoleLogs, errors, formInspection: null }, page.url())
    return
  }

  // ── Step 4: Inspect the Finix checkout form ───────────────────────────────
  // Wait for React + card iframes to fully mount
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(4000)

  await page.screenshot({ path: 'scripts/debug/screenshots/gc-06-finix-top.png' })

  // Scroll down to reveal ToS checkbox / Pay button at bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'scripts/debug/screenshots/gc-07-finix-bottom.png' })
  await page.screenshot({ path: 'scripts/debug/screenshots/gc-08-finix-full.png', fullPage: true })

  // --- Collect form inspection data for the JSON ---
  const formInspection = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim(),
      disabled: b.disabled,
      classList: Array.from(b.classList),
    }))

    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(cb => ({
      id: (cb as HTMLInputElement).id,
      name: (cb as HTMLInputElement).name,
      checked: (cb as HTMLInputElement).checked,
      visible: (cb as HTMLElement).offsetParent !== null,
      label: cb.closest('label')?.innerText?.trim() ?? null,
    }))

    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src,
      id: f.id,
      name: f.name,
    }))

    const pageText = document.body.innerText.slice(0, 3000)

    return { buttons, checkboxes, iframes, pageText }
  })

  // --- Try to fill in the card form (cross-origin iframe) ---
  // Finix.js renders card fields inside an iframe from js.finix.com
  const cardFrameLocator = page.frameLocator('iframe[src*="js.finix.com/v/2/application"]')

  let cardFormFillResult: {
    success: boolean
    error?: string
    fieldsFound?: string[]
    buttonsAfterFill?: { text: string; disabled: boolean }[]
  } = { success: false }

  try {
    // Discover what inputs exist in the card iframe
    const inputNames = await cardFrameLocator.locator('input').evaluateAll(
      (inputs: HTMLInputElement[]) => inputs.map(i => ({ name: i.name, type: i.type, placeholder: i.placeholder }))
    ).catch(() => [])
    console.log('Card iframe inputs:', JSON.stringify(inputNames))

    // Fill card number
    const cardInput = cardFrameLocator.locator('input[name="number"], input[placeholder*="card"], input[data-elements-stable-field-name="cardNumber"]').first()
    await cardInput.fill('4111111111111111', { timeout: 5000 }).catch(() => {})

    // Fill name on card
    const nameInput = cardFrameLocator.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="Name"]').first()
    await nameInput.fill('Test Buyer', { timeout: 5000 }).catch(() => {})

    // Fill expiry
    const expiryInput = cardFrameLocator.locator('input[name="expiry"], input[placeholder*="MM"], input[placeholder*="expir" i]').first()
    await expiryInput.fill('10/30', { timeout: 5000 }).catch(() => {})

    // Fill CVV
    const cvvInput = cardFrameLocator.locator('input[name="security_code"], input[name="cvv"], input[placeholder*="CVV"], input[placeholder*="CVC"]').first()
    await cvvInput.fill('123', { timeout: 5000 }).catch(() => {})

    // Fill zip
    const zipInput = cardFrameLocator.locator('input[name="address.postal_code"], input[placeholder*="Zip"], input[placeholder*="ZIP"], input[placeholder*="postal"]').first()
    await zipInput.fill('12345', { timeout: 5000 }).catch(() => {})

    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'scripts/debug/screenshots/gc-09-card-filled.png', fullPage: true })

    // Check button state after filling
    const buttonsAfterFill = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.innerText.trim(),
        disabled: b.disabled,
      }))
    )

    // Also check for ToS checkbox on main page (outside card iframe)
    const tosCheckboxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="checkbox"]')).map(cb => ({
        id: (cb as HTMLInputElement).id,
        checked: (cb as HTMLInputElement).checked,
        label: cb.closest('label')?.innerText?.trim() ??
               document.querySelector(`label[for="${(cb as HTMLInputElement).id}"]`)?.innerText?.trim() ?? null,
      }))
    )

    // If there's an unchecked ToS checkbox, try clicking it
    for (const cb of tosCheckboxes) {
      if (!cb.checked) {
        console.log(`Clicking unchecked checkbox: id="${cb.id}" label="${cb.label}"`)
        const el = page.locator(`input[type="checkbox"]${cb.id ? `#${cb.id}` : ''}`)
        await el.click({ timeout: 3000 }).catch(() => {})
      }
    }
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'scripts/debug/screenshots/gc-10-after-tos.png', fullPage: true })

    const finalButtons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.innerText.trim(),
        disabled: b.disabled,
      }))
    )

    cardFormFillResult = {
      success: true,
      fieldsFound: (inputNames as Array<{name: string}>).map((i: {name: string}) => i.name),
      buttonsAfterFill: finalButtons,
    }
  } catch (err) {
    cardFormFillResult = { success: false, error: String(err) }
  }

  writeResults({ apiLogs, failedRequests, consoleLogs, errors, formInspection, cardFormFillResult }, page.url())
})

function writeResults(data: {
  apiLogs: { url: string; method: string; status: number; body: unknown }[]
  failedRequests: { url: string; method: string; status: number }[]
  consoleLogs: string[]
  errors: string[]
  formInspection: unknown
  cardFormFillResult?: unknown
}, finalUrl: string) {
  const results = {
    timestamp: new Date().toISOString(),
    finalUrl,
    // Failed requests (4xx/5xx) — this is what we need to diagnose
    failedRequests: data.failedRequests,
    // API calls to our server
    apiLogs: data.apiLogs.filter(l => l.url.includes('/api/')),
    // Form inspection from Finix page
    formInspection: data.formInspection,
    // Card fill attempt result
    cardFormFillResult: data.cardFormFillResult,
    // All navigation (200-399 only)
    navigationLog: data.apiLogs
      .filter(l => !l.url.includes('/api/') && l.method === 'GET' && l.status < 400)
      .map(l => ({ url: l.url, status: l.status })),
    consoleLogs: data.consoleLogs,
    errors: data.errors,
  }
  writeFileSync(LOG_FILE, JSON.stringify(results, null, 2))
  console.log(`\nResults written to ${LOG_FILE}`)
  console.log('Failed requests (4xx/5xx):', JSON.stringify(data.failedRequests, null, 2))
  console.log('Console errors:', data.errors)
}
