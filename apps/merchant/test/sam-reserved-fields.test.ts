/**
 * SAM reserved fields guard
 *
 * sam-pattern's Model class exposes a fixed set of methods. Model.update()
 * does Object.assign(this, state), which means any application state field
 * whose name collides with a Model method will silently overwrite that method,
 * causing the SAM instance to malfunction.
 *
 * This test asserts that the OrderModel's initialState keys never intersect
 * the reserved set. If this test fails, rename the offending field (e.g.
 * `error` → `posError`, `state` → `workflowState`).
 */

import { describe, it, expect } from 'bun:test'

/** Exhaustive list of sam-pattern Model method / property names. */
const SAM_RESERVED = new Set([
  'error',
  'hasError',
  'errorMessage',
  'clearError',
  'state',
  'update',
  'flush',
  'clone',
  'continue',
  'hasNext',
  'allow',
  'log',
])

/** The keys used in order-relay initialState — keep in sync with createOrderWorkflow. */
const ORDER_RELAY_INITIAL_STATE_KEYS: string[] = [
  'orderId',
  'merchantId',
  'status',
  'order',
  'posOrderId',
  'posProvider',
  'pickupCode',
  'retryCount',
  'posError',
  'estimatedMinutes',
]

describe('SAM reserved field names', () => {
  it('order-relay initialState keys do not collide with SAM Model reserved names', () => {
    const collisions = ORDER_RELAY_INITIAL_STATE_KEYS.filter(k => SAM_RESERVED.has(k))
    expect(collisions).toEqual([])
  })

  it('SAM_RESERVED set is non-empty (guard against an accidentally empty set)', () => {
    expect(SAM_RESERVED.size).toBeGreaterThan(0)
  })
})
