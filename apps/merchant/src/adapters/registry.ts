/**
 * POS Adapter Registry
 * Factory pattern for creating POS adapters based on type
 */

import type { POSAdapter, POSAdapterConfig } from './types'
import { createManualAdapter } from './manual'

/**
 * Adapter factory function type
 */
type AdapterFactory = (config: POSAdapterConfig) => POSAdapter | Promise<POSAdapter>

/**
 * Registry of available POS adapters
 */
const adapterRegistry = new Map<string, AdapterFactory>()

/**
 * Registers a POS adapter factory
 */
export function registerAdapter(posType: string, factory: AdapterFactory): void {
  adapterRegistry.set(posType, factory)
}

/**
 * Creates a POS adapter instance for a merchant
 */
export async function createAdapter(config: POSAdapterConfig): Promise<POSAdapter> {
  const factory = adapterRegistry.get(config.posType)

  if (!factory) {
    throw new Error(
      `Unknown POS type: ${config.posType}. Available types: ${Array.from(adapterRegistry.keys()).join(', ')}`
    )
  }

  const adapter = await factory(config)

  // Test connection on creation
  const connectionTest = await adapter.testConnection()
  if (!connectionTest.ok) {
    throw new Error(
      `Failed to connect to ${config.posType} POS: ${connectionTest.error}`
    )
  }

  return adapter
}

/**
 * Gets a cached adapter for a merchant
 * Adapters are cached to avoid recreating on every request
 */
const adapterCache = new Map<string, POSAdapter>()

export async function getAdapter(config: POSAdapterConfig): Promise<POSAdapter> {
  const cacheKey = `${config.merchantId}:${config.posType}`

  if (adapterCache.has(cacheKey)) {
    return adapterCache.get(cacheKey)!
  }

  const adapter = await createAdapter(config)
  adapterCache.set(cacheKey, adapter)

  return adapter
}

/**
 * Clears cached adapter for a merchant (e.g., after config change)
 */
export function clearAdapterCache(merchantId: string): void {
  for (const key of adapterCache.keys()) {
    if (key.startsWith(`${merchantId}:`)) {
      adapterCache.delete(key)
    }
  }
}

/**
 * Lists all available POS types
 */
export function getAvailableAdapters(): string[] {
  return Array.from(adapterRegistry.keys())
}

/**
 * Register built-in adapters
 * Only the manual adapter is registered here (used by the order relay).
 * Menu import adapters (Clover, Toast, Square) are instantiated directly
 * in the menu sync route — they don't need registry entry.
 */
registerAdapter('manual', () => createManualAdapter())
