/**
 * Custom Playwright test fixture.
 *
 * Provides:
 *   world       — seeded DB IDs (merchantId, ownerToken, itemId, etc.)
 *   placeOrder  — places an order via the store API; returns orderId + pickupCode
 *   seedActiveOrder — writes active-order data to localStorage so the bar appears
 */

import { test as base, expect } from '@playwright/test'
import { readFileSync }          from 'node:fs'
import { fileURLToPath }         from 'node:url'
import { resolve, dirname }      from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Types ──────────────────────────────────────────────────────────────────────

export interface World {
  BASE:         string
  merchantId:   string
  ownerToken:   string
  refreshToken: string
  catId:        string
  itemId:       string
  modGroupId:   string | null
  employeeId:   string | null
  employeePin:  string
}

export interface ActiveOrderSeed {
  orderId:      string
  pickupCode:   string
  status?:      string
  scheduledFor?: string | null
}

// ── World loader ───────────────────────────────────────────────────────────────

function loadWorld(): World {
  const worldPath = resolve(__dir, '..', '.cache', 'world.json')
  return JSON.parse(readFileSync(worldPath, 'utf8'))
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

interface StoreFixtures {
  world:           World
  placeOrder:      (opts?: { scheduledFor?: string }) => Promise<{ orderId: string; pickupCode: string; totalCents: number }>
  seedActiveOrder: (seed: ActiveOrderSeed) => Promise<void>
}

export const test = base.extend<StoreFixtures>({

  // ── world ────────────────────────────────────────────────────────────────────
  world: async ({}, use) => {
    await use(loadWorld())
  },

  // ── placeOrder ───────────────────────────────────────────────────────────────
  /** Places an order via the public store API. Does NOT set localStorage. */
  placeOrder: async ({ request, world }, use) => {
    await use(async (opts = {}) => {
      const body: Record<string, unknown> = {
        customerName: 'E2E Customer',
        items:        [{ itemId: world.itemId }],
      }
      if (opts.scheduledFor) body.scheduledFor = opts.scheduledFor

      const res = await request.post('/api/store/orders', { data: body })
      if (!res.ok()) {
        throw new Error(`placeOrder failed (${res.status()}): ${await res.text()}`)
      }
      return res.json()
    })
  },

  // ── seedActiveOrder ──────────────────────────────────────────────────────────
  /**
   * Seeds localStorage with an active order so the status bar is visible.
   * Must be called AFTER page.goto('/') (localStorage requires an origin).
   */
  seedActiveOrder: async ({ page }, use) => {
    await use(async (seed: ActiveOrderSeed) => {
      const active = {
        orderId:          seed.orderId,
        pickupCode:       seed.pickupCode,
        status:           seed.status ?? 'received',
        estimatedReadyAt: null,
      }
      const detail = {
        orderId:       seed.orderId,
        pickupCode:    seed.pickupCode,
        status:        seed.status ?? 'received',
        items:         [],
        subtotalCents: 0,
        taxCents:      0,
        totalCents:    0,
        scheduledFor:  seed.scheduledFor ?? null,
      }

      await page.evaluate(
        ([activeKey, activeVal, detailKey, detailVal]) => {
          localStorage.setItem(activeKey,  activeVal)
          localStorage.setItem(detailKey, detailVal)
        },
        [
          'kizo_active_order',
          JSON.stringify(active),
          `kizo_order_${seed.orderId}`,
          JSON.stringify(detail),
        ],
      )
    })
  },
})

export { expect }
