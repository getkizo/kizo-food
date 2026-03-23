/**
 * Playwright globalSetup — seeds the test DB with a merchant + menu.
 *
 * Runs once after webServer is ready, before any test file executes.
 * Writes e2e/.cache/world.json so test fixtures can read IDs.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath }    from 'node:url'
import { resolve, dirname } from 'node:path'

const __dir  = dirname(fileURLToPath(import.meta.url))
const BASE   = 'http://127.0.0.1:3099'

export default async function globalSetup() {
  // ── 1. Register merchant ───────────────────────────────────────────────────
  const regRes = await fetch(`${BASE}/api/auth/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      email:        'e2e@test.local',
      password:     'E2ETestPass123!', // TEST-ONLY — ephemeral DB, no production equivalent
      fullName:     'E2E Owner',
      businessName: 'Test Cafe',
      slug:         'test-cafe',
    }),
  })
  if (!regRes.ok) {
    const text = await regRes.text()
    throw new Error(`Registration failed (${regRes.status}): ${text}`)
  }
  const reg: any       = await regRes.json()
  const ownerToken: string = reg.tokens.accessToken
  const merchantId: string = reg.merchant.id

  // ── 2. Create menu category ────────────────────────────────────────────────
  const catRes = await fetch(`${BASE}/api/merchants/${merchantId}/menu/categories`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ name: 'Mains' }),
  })
  if (!catRes.ok) throw new Error(`Category creation failed: ${await catRes.text()}`)
  const { id: catId }: any = await catRes.json()

  // ── 3. Create menu item ────────────────────────────────────────────────────
  const itemRes = await fetch(`${BASE}/api/merchants/${merchantId}/menu/items`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({
      categoryId:      catId,
      name:            'Pad Thai',
      priceCents:      1400,
      availableOnline: true,
    }),
  })
  if (!itemRes.ok) throw new Error(`Item creation failed: ${await itemRes.text()}`)
  const { itemId }: any = await itemRes.json()

  // ── 4. Create a modifier group + modifier (for modifier-sheet tests) ───────
  const mgRes = await fetch(`${BASE}/api/merchants/${merchantId}/menu/items/${itemId}/modifier-groups`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({
      name:        'Protein',
      minRequired: 0,
      maxAllowed:  1,
      modifiers: [
        { name: 'Tofu',   priceCents: 0   },
        { name: 'Shrimp', priceCents: 200 },
      ],
    }),
  })
  // Modifier groups are nice-to-have; don't fail setup if endpoint differs
  const modGroupId: string | null = mgRes.ok ? ((await mgRes.json()) as any).id ?? null : null

  // ── 5. Create employee for PIN exit tests ─────────────────────────────────
  const empRes = await fetch(`${BASE}/api/merchants/${merchantId}/employees`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({
      nickname:   'E2E Staff',
      accessCode: '1234',
      role:       'server',
    }),
  })
  const employeeId: string | null = empRes.ok ? ((await empRes.json()) as any).id ?? null : null

  // ── 6. Persist world for tests ─────────────────────────────────────────────
  const world = {
    BASE,
    merchantId,
    ownerToken,
    refreshToken: reg.tokens.refreshToken as string,
    catId,
    itemId,
    modGroupId,
    employeeId,
    employeePin: '1234',
  }

  await mkdir(resolve(__dir, '.cache'), { recursive: true })
  await writeFile(
    resolve(__dir, '.cache', 'world.json'),
    JSON.stringify(world, null, 2),
    'utf8',
  )

  console.log('[globalSetup] World seeded:', { merchantId, catId, itemId })
}
