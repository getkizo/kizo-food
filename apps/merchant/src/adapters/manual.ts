/**
 * Manual POS Adapter
 * For merchants without an integrated POS system
 * Orders are manually confirmed/updated through the dashboard
 */

import type {
  POSAdapter,
  POSOrderData,
  POSOrderResult,
  POSStatusResult,
  POSMenuData,
  POSConnectionTest,
} from './types'
import { getDatabase } from '../db/connection'

/**
 * Manual POS Adapter
 * Stores orders locally, merchant manages them through dashboard
 */
export class ManualPOSAdapter implements POSAdapter {
  readonly posType = 'manual'

  /**
   * "Submits" order to manual queue (just stores locally)
   */
  async submitOrder(order: POSOrderData): Promise<POSOrderResult> {
    try {
      // Manual adapter always succeeds - order goes to dashboard queue
      return {
        success: true,
        posOrderId: order.orderId, // Use our order ID as POS order ID
        estimatedMinutes: 30, // Default estimate
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorCode: 'MANUAL_ERROR',
      }
    }
  }

  /**
   * Gets order status from our database
   */
  async getOrderStatus(posOrderId: string): Promise<POSStatusResult> {
    const db = getDatabase()

    const order = db
      .query<{ status: string; completed_at: string | null }, [string]>(
        `SELECT status, completed_at FROM orders WHERE id = ? OR pos_order_id = ?`
      )
      .get(posOrderId, posOrderId)

    if (!order) {
      return {
        status: 'error',
        error: 'Order not found',
      }
    }

    // Map our status to POS status
    const statusMap: Record<string, POSStatusResult['status']> = {
      received: 'pending',
      submitted: 'confirmed',
      confirmed: 'confirmed',
      preparing: 'preparing',
      ready: 'ready',
      picked_up: 'picked_up',
      completed: 'picked_up',  // legacy — treat old 'completed' as 'picked_up'
      cancelled: 'cancelled',
      pos_error: 'error',
    }

    return {
      status: statusMap[order.status] || 'pending',
      completedAt: order.completed_at || undefined,
    }
  }

  /**
   * Fetches menu from our database
   */
  async fetchMenu(): Promise<POSMenuData> {
    const db = getDatabase()

    const dishes = db
      .query<{
        id: string
        name: string
        description: string | null
        base_price_cents: number
        category: string | null
        is_available: number
        image_url: string | null
      }, []>(
        `SELECT id, name, description, base_price_cents, category, is_available, image_url
         FROM dishes
         ORDER BY category, name`
      )
      .all()

    return {
      items: dishes.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description || undefined,
        priceCents: d.base_price_cents,
        category: d.category || undefined,
        available: d.is_available === 1,
        imageUrl: d.image_url || undefined,
      })),
      lastUpdated: new Date().toISOString(),
    }
  }

  /**
   * Tests connection (always succeeds for manual adapter)
   */
  async testConnection(): Promise<POSConnectionTest> {
    return {
      ok: true,
      latencyMs: 0,
      version: 'manual-v1',
    }
  }
}

/**
 * Factory function to create manual adapter
 */
export function createManualAdapter(): POSAdapter {
  return new ManualPOSAdapter()
}
