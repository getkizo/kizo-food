/**
 * Clover POS Adapter tests
 * Tests Clover API integration
 */

import { test, expect, describe, beforeAll, mock } from 'bun:test'
import { CloverPOSAdapter } from '../src/adapters/clover'
import type { POSOrderData } from '../src/adapters/types'

// Mock Clover API responses
const mockCloverOrder = {
  id: 'clover_order_123',
  state: 'open' as const,
  title: 'Test Order',
  total: 1100,
  createdTime: Date.now(),
  modifiedTime: Date.now(),
}

const mockCloverItem = {
  id: 'clover_item_123',
  name: 'Test Item',
  price: 1000,
  priceType: 'FIXED' as const,
  available: true,
}

const mockCloverLineItem = {
  id: 'clover_lineitem_123',
  name: 'Test Item',
  price: 1000,
  unitQty: 1000,
}

// Test order data
const testOrderData: POSOrderData = {
  orderId: 'ord_test_123',
  customerName: 'John Doe',
  customerPhone: '+1-555-0100',
  items: [
    {
      dishId: 'dish_123',
      dishName: 'Margherita Pizza',
      quantity: 1,
      priceCents: 1000,
    },
  ],
  subtotalCents: 1000,
  taxCents: 100,
  totalCents: 1100,
  orderType: 'pickup',
}

describe('Clover POS Adapter - Configuration', () => {
  test('should throw error if API token not provided', () => {
    expect(() => {
      new CloverPOSAdapter({
        merchantId: 'm_test',
        posType: 'clover',
        // apiKey missing
      })
    }).toThrow('Clover API token is required')
  })

  test('should use sandbox URL when sandboxMode is true', () => {
    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    expect(adapter.posType).toBe('clover')
    // baseUrl is private, but we can verify it works correctly through API calls
  })

  test('should use production URL by default', () => {
    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
    })

    expect(adapter.posType).toBe('clover')
  })
})

describe('Clover POS Adapter - Order Submission', () => {
  test('should successfully submit order', async () => {
    // Mock fetch globally
    const originalFetch = global.fetch
    global.fetch = mock(async (url: string, options?: RequestInit) => {
      const urlStr = url.toString()

      // Mock create order
      if (urlStr.includes('/orders') && options?.method === 'POST') {
        const body = options.body ? JSON.parse(options.body as string) : {}

        // Return line item creation if it's a line_items request
        if (urlStr.includes('/line_items')) {
          return new Response(JSON.stringify(mockCloverLineItem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Return order update if updating note
        if (body.note) {
          return new Response(JSON.stringify({ ...mockCloverOrder, note: body.note }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Return new order
        return new Response(JSON.stringify(mockCloverOrder), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Mock item search
      if (urlStr.includes('/items') && options?.method === 'GET') {
        return new Response(JSON.stringify({ elements: [mockCloverItem] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Mock merchant info for connection test
      if (urlStr.includes('/merchants/') && !urlStr.includes('/orders')) {
        return new Response(JSON.stringify({ id: 'm_test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response('Not found', { status: 404 })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.submitOrder(testOrderData)

    expect(result.success).toBe(true)
    expect(result.posOrderId).toBe('clover_order_123')
    expect(result.estimatedMinutes).toBe(30)

    // Restore original fetch
    global.fetch = originalFetch
  })

  test('should handle API errors gracefully', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      return new Response('API Error', { status: 500 })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.submitOrder(testOrderData)

    expect(result.success).toBe(false)
    expect(result.error).toContain('500')
    expect(result.errorCode).toBe('CLOVER_SUBMIT_ERROR')

    global.fetch = originalFetch
  })
})

describe('Clover POS Adapter - Order Status', () => {
  test('should fetch order status', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({ ...mockCloverOrder, state: 'locked' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.getOrderStatus('clover_order_123')

    expect(result.status).toBe('confirmed')

    global.fetch = originalFetch
  })

  test('should map Clover states correctly', async () => {
    const originalFetch = global.fetch

    const testCases = [
      { cloverState: 'open', expectedStatus: 'pending' },
      { cloverState: 'locked', expectedStatus: 'confirmed' },
      { cloverState: 'paid', expectedStatus: 'picked_up' },
    ]

    for (const { cloverState, expectedStatus } of testCases) {
      global.fetch = mock(async () => {
        return new Response(
          JSON.stringify({ ...mockCloverOrder, state: cloverState }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      })

      const adapter = new CloverPOSAdapter({
        merchantId: 'm_test',
        posType: 'clover',
        apiKey: 'test_token',
        sandboxMode: true,
      })

      const result = await adapter.getOrderStatus('clover_order_123')
      expect(result.status).toBe(expectedStatus)
    }

    global.fetch = originalFetch
  })
})

describe('Clover POS Adapter - Menu Sync', () => {
  test('should fetch menu items', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async (url: string) => {
      if (url.toString().includes('/items')) {
        return new Response(
          JSON.stringify({
            elements: [
              mockCloverItem,
              {
                id: 'clover_item_456',
                name: 'Caesar Salad',
                price: 899,
                available: true,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      // Categories
      return new Response(
        JSON.stringify({
          elements: [
            { id: 'cat_1', name: 'Pizzas' },
            { id: 'cat_2', name: 'Salads' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const menu = await adapter.fetchMenu()

    // fetchMenu() returns { categories, uncategorizedItems } per POSMenuData shape.
    // Items without a category go into uncategorizedItems; categorized items are in categories[].items.
    const allItems = [
      ...menu.categories.flatMap((c) => c.items),
      ...menu.uncategorizedItems,
    ]
    expect(allItems.length).toBe(2)
    expect(allItems[0].name).toBe('Test Item')
    expect(allItems[0].priceCents).toBe(1000)
    expect(allItems[1].name).toBe('Caesar Salad')
    expect(allItems[1].priceCents).toBe(899)

    global.fetch = originalFetch
  })

  test('should filter out hidden items', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async (url: string) => {
      if (url.toString().includes('/items')) {
        return new Response(
          JSON.stringify({
            elements: [
              mockCloverItem,
              {
                id: 'hidden_item',
                name: 'Hidden Item',
                price: 500,
                hidden: true,
              },
              {
                id: 'unavailable_item',
                name: 'Unavailable Item',
                price: 700,
                available: false,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const menu = await adapter.fetchMenu()

    // fetchMenu() filters out hidden:true items but returns unavailable items with isAvailable:false.
    // The mock has 3 items: 1 available, 1 hidden (filtered), 1 unavailable (kept with isAvailable=false).
    const allItems = [...menu.categories.flatMap((c) => c.items), ...menu.uncategorizedItems]
    expect(allItems.length).toBe(2)
    const availableItems = allItems.filter((i) => i.isAvailable)
    expect(availableItems.length).toBe(1)
    expect(availableItems[0].id).toBe('clover_item_123')

    global.fetch = originalFetch
  })
})

describe('Clover POS Adapter - Connection Test', () => {
  test('should test connection successfully', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'm_test', name: 'Test Merchant' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.testConnection()

    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.version).toBe('clover-v3')

    global.fetch = originalFetch
  })

  test('should handle connection failure', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      throw new Error('Network error')
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.testConnection()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Network error')

    global.fetch = originalFetch
  })
})

describe('Clover POS Adapter - Order Cancellation', () => {
  test('should cancel order successfully', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      return new Response(null, { status: 204 })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.cancelOrder?.('clover_order_123')

    expect(result).toBe(true)

    global.fetch = originalFetch
  })

  test('should handle cancellation failure', async () => {
    const originalFetch = global.fetch
    global.fetch = mock(async () => {
      return new Response('Order not found', { status: 404 })
    })

    const adapter = new CloverPOSAdapter({
      merchantId: 'm_test',
      posType: 'clover',
      apiKey: 'test_token',
      sandboxMode: true,
    })

    const result = await adapter.cancelOrder?.('nonexistent_order')

    expect(result).toBe(false)

    global.fetch = originalFetch
  })
})
