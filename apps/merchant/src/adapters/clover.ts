/**
 * Clover Menu Importer
 * Fetches the full menu hierarchy from Clover REST API v3
 *
 * Menu hierarchy: categories → items → modifierGroups → modifiers
 *
 * API Documentation: https://docs.clover.com/reference
 * Authentication: Bearer token (API Token or OAuth)
 */

import type {
  POSMenuData,
  POSMenuCategory,
  POSMenuItem,
  POSModifierGroup,
  POSModifier,
  POSAdapterConfig,
  POSOrderData,
  POSOrderResult,
  POSStatusResult,
  POSConnectionTest,
  MenuImportAdapter,
  POSAdapter,
} from './types'

/** Clover API base URLs */
const CLOVER_API_BASE = {
  production: 'https://api.clover.com',
  sandbox: 'https://sandbox.dev.clover.com',
}

// ---------------------------------------------------------------------------
// Clover API raw response shapes
// ---------------------------------------------------------------------------

interface CloverModifier {
  id: string
  name: string
  price: number         // in cents
  available?: boolean
  modifierGroup?: { id: string }
}

interface CloverModifierGroup {
  id: string
  name: string
  minRequired?: number  // min selections; 0 = optional
  maxAllowed?: number   // max selections; 0 = unlimited
  modifiers?: { elements: CloverModifier[] }
  items?: { elements: Array<{ id: string }> }
}

interface CloverItem {
  id: string
  name: string
  alternateName?: string
  code?: string
  price: number         // in cents
  priceType?: 'FIXED' | 'VARIABLE' | 'PER_UNIT'
  available?: boolean
  hidden?: boolean
  isRevenue?: boolean
  modifiedTime?: number
  categories?: { elements: Array<{ id: string; name: string; sortOrder?: number }> }
  modifierGroups?: { elements: CloverModifierGroup[] }
}

interface CloverCategory {
  id: string
  name: string
  sortOrder?: number
  items?: { elements: Array<{ id: string }> }
}

interface CloverPagedResponse<T> {
  elements: T[]
  href?: string
}

// Raw Clover order shapes (used by CloverPOSAdapter.fetchOrders)
interface CloverLineItem {
  id: string
  name: string
  /** Quantity in 1/1000 units — 1000 = one item */
  unitQty: number
  /** Unit price in cents */
  price: number
  note?: string | null
}

interface CloverCustomer {
  id: string
  name?: string | null
  phoneNumber?: string | null
  emailAddresses?: { elements: Array<{ emailAddress: string }> }
}

interface CloverOrder {
  id: string
  /** Total charged in cents */
  total: number
  createdTime: number
  modifiedTime: number
  state: 'open' | 'locked' | 'paid' | 'deleted'
  lineItems?: { elements: CloverLineItem[] }
  customers?: { elements: CloverCustomer[] }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all pages from a Clover endpoint */
async function fetchAllPages<T>(
  fetcher: (offset: number) => Promise<CloverPagedResponse<T>>
): Promise<T[]> {
  const all: T[] = []
  let offset = 0
  const limit = 100

  while (true) {
    const page = await fetcher(offset)
    all.push(...page.elements)
    if (page.elements.length < limit) break
    offset += limit
  }

  return all
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

/**
 * Clover Menu Importer
 * Fetches the full menu from Clover REST API v3 for import into this appliance.
 */
export class CloverMenuImporter implements MenuImportAdapter {
  private apiToken: string
  private _merchantId: string
  private baseUrl: string

  /** Expose merchantId for sub-classes (avoids `as any` casts). */
  get merchantId(): string { return this._merchantId }

  constructor(config: POSAdapterConfig) {
    if (!config.apiKey) {
      throw new Error('Clover API token is required')
    }

    this.apiToken = config.apiKey
    this._merchantId = config.merchantId
    this.baseUrl = config.sandboxMode
      ? CLOVER_API_BASE.sandbox
      : CLOVER_API_BASE.production
  }

  // -------------------------------------------------------------------------
  // Menu — full hierarchy: categories → items → modifierGroups → modifiers
  // -------------------------------------------------------------------------

  /**
   * Fetches the complete menu from Clover.
   *
   * Strategy:
   *  1. Fetch all categories
   *  2. Fetch all items with modifierGroups expanded
   *  3. Fetch all modifier groups with modifiers expanded (for min/max data)
   *  4. Assemble: category → [items] → [modifierGroups] → [modifiers]
   */
  async fetchMenu(): Promise<POSMenuData> {
    // 1. Fetch all categories
    const rawCategories = await fetchAllPages<CloverCategory>((offset) =>
      this.makeRequest<CloverPagedResponse<CloverCategory>>(
        'GET',
        `/v3/merchants/${this._merchantId}/categories?limit=100&offset=${offset}&expand=items`
      )
    )

    // 2. Fetch all items with categories + modifierGroups expanded
    const rawItems = await fetchAllPages<CloverItem>((offset) =>
      this.makeRequest<CloverPagedResponse<CloverItem>>(
        'GET',
        `/v3/merchants/${this._merchantId}/items?limit=100&offset=${offset}&expand=categories%2CmodifierGroups`
      )
    )

    // 3. Fetch modifier groups with modifiers expanded (gives us min/max)
    const rawGroups = await fetchAllPages<CloverModifierGroup>((offset) =>
      this.makeRequest<CloverPagedResponse<CloverModifierGroup>>(
        'GET',
        `/v3/merchants/${this._merchantId}/modifier_groups?limit=100&offset=${offset}&expand=modifiers`
      )
    )

    // Index modifier groups by ID for fast lookup
    const groupById = new Map<string, CloverModifierGroup>(
      rawGroups.map((g) => [g.id, g])
    )

    // Build a set of item IDs that appear in at least one category
    const categorizedItemIds = new Set<string>()
    for (const cat of rawCategories) {
      for (const item of cat.items?.elements ?? []) {
        categorizedItemIds.add(item.id)
      }
    }

    /** Map a raw Clover modifier to our shape */
    const mapModifier = (m: CloverModifier): POSModifier => ({
      id: m.id,
      posModifierId: m.id,
      name: m.name,
      priceCents: m.price ?? 0,
      isAvailable: m.available !== false,
      sortOrder: 0,
    })

    /** Map a raw Clover modifierGroup to our shape, using the full group data */
    const mapModifierGroup = (groupRef: CloverModifierGroup): POSModifierGroup => {
      const full = groupById.get(groupRef.id) ?? groupRef
      const modifiers = (full.modifiers?.elements ?? []).map(mapModifier)
      return {
        id: full.id,
        posGroupId: full.id,
        name: full.name,
        minRequired: full.minRequired ?? 0,
        maxAllowed: full.maxAllowed === 0 ? null : (full.maxAllowed ?? null),
        modifiers,
      }
    }

    /** Map a raw Clover item to our shape */
    const mapItem = (raw: CloverItem): POSMenuItem => ({
      id: raw.id,
      posItemId: raw.id,
      name: raw.name,
      description: raw.alternateName,  // Clover uses alternateName as description
      priceCents: raw.price ?? 0,
      priceType: raw.priceType ?? 'FIXED',
      categoryId: raw.categories?.elements?.[0]?.id,
      isAvailable: raw.available !== false && raw.hidden !== true,
      imageUrl: undefined,  // Added separately by merchant
      sortOrder: 0,
      modifierGroups: (raw.modifierGroups?.elements ?? []).map(mapModifierGroup),
    })

    // Build category list (sorted by sortOrder)
    const categories: POSMenuCategory[] = rawCategories
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((cat) => {
        const catItemIds = new Set((cat.items?.elements ?? []).map((i) => i.id))
        const items = rawItems
          .filter((item) => catItemIds.has(item.id) && item.hidden !== true)
          .map(mapItem)

        return {
          id: cat.id,
          posCategoryId: cat.id,
          name: cat.name,
          sortOrder: cat.sortOrder ?? 0,
          items,
        }
      })

    // Items that don't belong to any category
    const uncategorizedItems = rawItems
      .filter((item) => !categorizedItemIds.has(item.id) && item.hidden !== true)
      .map(mapItem)

    return {
      categories,
      uncategorizedItems,
      lastUpdated: new Date().toISOString(),
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Authenticated fetch wrapper for the Clover REST API (public for CloverPOSAdapter delegation).
   * Uses linear backoff on 429, no request timeout (batch menu imports may run longer than 10s).
   *
   * Note: CloverOrderClient (services/clover-order-client.ts) has a parallel implementation
   * intentionally kept separate: it uses exponential backoff and a 10s AbortSignal timeout
   * for order-level operations where responsiveness matters.
   * Do not unify without preserving both sets of behavior.
   */
  async makeRequest<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Accept': 'application/json',
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
    }

    const options: RequestInit = { method, headers }

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)

    if (response.status === 429 && attempt <= 3) {
      const retryAfterMs = Number(response.headers.get('Retry-After') ?? 0) * 1000 || attempt * 1000
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
      return this.makeRequest<T>(method, path, body, attempt + 1)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Clover API error (${response.status}): ${errorText || response.statusText}`)
    }

    if (response.status === 204) return {} as T

    return response.json()
  }
}

// ---------------------------------------------------------------------------
// Order Sync Adapter
// ---------------------------------------------------------------------------

/** Normalized order returned by CloverPOSAdapter.fetchOrders */
export interface CloverSyncedOrder {
  posOrderId: string
  createdTime: number
  modifiedTime: number
  totalCents: number
  status: string
  customerName: string | null
  customerPhone: string | null
  customerEmail: string | null
  lineItems: Array<{
    name: string
    quantity: number
    priceCents: number
    note: string | null
  }>
}

const CLOVER_STATUS_MAP: Record<string, string> = {
  open:   'received',
  locked: 'confirmed',
  paid:   'picked_up',
}

/**
 * Clover POS Adapter
 * Implements the full POSAdapter interface for the order workflow, and additionally
 * provides fetchOrders() for syncing existing Clover orders into the local DB.
 */
export class CloverPOSAdapter implements POSAdapter {
  private importer: CloverMenuImporter

  readonly posType = 'clover'

  constructor(config: POSAdapterConfig) {
    this.importer = new CloverMenuImporter(config)
  }

  // ── POSAdapter interface ──────────────────────────────────────────────────

  /**
   * Tests connectivity by fetching the Clover merchant record.
   */
  async testConnection(): Promise<POSConnectionTest> {
    const start = Date.now()
    try {
      const merchant = await this.importer.makeRequest<{ id: string; name?: string }>(
        'GET',
        `/v3/merchants/${this.importer.merchantId}`
      )
      return {
        ok:        true,
        latencyMs: Date.now() - start,
        version:   'clover-v3',
      }
    } catch (err) {
      return {
        ok:    false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Delegates to CloverMenuImporter. */
  fetchMenu() {
    return this.importer.fetchMenu()
  }

  /**
   * Submits an order to Clover by creating a Clover order with line items.
   * Returns the Clover order ID on success.
   */
  async submitOrder(order: POSOrderData): Promise<POSOrderResult> {
    try {
      // 1. Create the order
      const cloverOrder = await this.importer.makeRequest<CloverOrder>(
        'POST',
        `/v3/merchants/${this.importer.merchantId}/orders`,
        { note: `${order.customerName} — ${order.orderType}` }
      )

      // 2. Add line items
      for (const item of order.items) {
        // Find the matching Clover item by name (best-effort match)
        const items = await this.importer.makeRequest<CloverPagedResponse<{ id: string; name: string }>>(
          'GET',
          `/v3/merchants/${this.importer.merchantId}/items?filter=name=${encodeURIComponent(item.dishName)}`
        )
        const cloverItemId = items.elements[0]?.id
        if (cloverItemId) {
          await this.importer.makeRequest(
            'POST',
            `/v3/merchants/${this.importer.merchantId}/orders/${cloverOrder.id}/line_items`,
            { item: { id: cloverItemId }, quantity: item.quantity }
          )
        }
      }

      return {
        success:          true,
        posOrderId:       cloverOrder.id,
        estimatedMinutes: 30,
      }
    } catch (err) {
      return {
        success:   false,
        error:     err instanceof Error ? err.message : String(err),
        errorCode: 'CLOVER_SUBMIT_ERROR',
      }
    }
  }

  /**
   * Fetches the current status of a Clover order.
   * Maps Clover order states to POSOrderStatus values.
   */
  async getOrderStatus(posOrderId: string): Promise<POSStatusResult> {
    const order = await this.importer.makeRequest<CloverOrder>(
      'GET',
      `/v3/merchants/${this.importer.merchantId}/orders/${posOrderId}`
    )
    /** Clover state → POSOrderStatus (different from dashboard sync map). */
    const posStatusMap: Record<string, POSStatusResult['status']> = {
      open:    'pending',
      locked:  'confirmed',
      paid:    'picked_up',
      deleted: 'cancelled',
    }
    return {
      status: posStatusMap[order.state] ?? 'pending',
    }
  }

  /**
   * Cancels a Clover order by deleting it.
   * Returns true on success, false on failure.
   */
  async cancelOrder(posOrderId: string): Promise<boolean> {
    try {
      await this.importer.makeRequest(
        'DELETE',
        `/v3/merchants/${this.importer.merchantId}/orders/${posOrderId}`
      )
      return true
    } catch {
      return false
    }
  }

  // ── Order sync (read-only, dashboard use) ────────────────────────────────

  /**
   * Fetches Clover orders created within the given Unix-ms time window.
   *
   * @param fromMs - Start of window (inclusive), Unix milliseconds
   * @param toMs   - End of window (inclusive), Unix milliseconds
   */
  async fetchOrders(fromMs: number, toMs: number): Promise<CloverSyncedOrder[]> {
    const merchantId = this.importer.merchantId
    const params = new URLSearchParams({
      limit: '100',
      offset: '0',
      expand: 'lineItems,customers',
      [`filter`]: `createdTime>=${fromMs}`,
    })
    // Clover requires multiple filter params — append second separately
    params.append('filter', `createdTime<=${toMs}`)

    const raw = await fetchAllPages<CloverOrder>((offset) =>
      this.importer.makeRequest<CloverPagedResponse<CloverOrder>>(
        'GET',
        `/v3/merchants/${merchantId}/orders?expand=lineItems,customers&filter=createdTime>=${fromMs}&filter=createdTime<=${toMs}&limit=100&offset=${offset}`
      )
    )

    return raw
      .filter((o) => o.state !== 'deleted')
      .map((o): CloverSyncedOrder => {
        const customer = o.customers?.elements?.[0] ?? null
        const email = customer?.emailAddresses?.elements?.[0]?.emailAddress ?? null

        return {
          posOrderId:   o.id,
          createdTime:  o.createdTime,
          modifiedTime: o.modifiedTime,
          totalCents:   o.total ?? 0,
          status:       CLOVER_STATUS_MAP[o.state] ?? 'received',
          customerName:  customer?.name ?? null,
          customerPhone: customer?.phoneNumber ?? null,
          customerEmail: email,
          lineItems: (o.lineItems?.elements ?? []).map((li) => ({
            name:       li.name,
            // Clover stores unitQty in thousandths (1000 = 1 item)
            quantity:   Math.max(1, Math.round((li.unitQty ?? 1000) / 1000)),
            priceCents: li.price ?? 0,
            note:       li.note ?? null,
          })),
        }
      })
  }
}
