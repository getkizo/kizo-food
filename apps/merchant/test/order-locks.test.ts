/**
 * Order Locks tests
 *
 * Covers the in-memory edit-lock and webhook-lock mechanisms in order-locks.ts.
 * Uses unique order IDs per describe block to avoid cross-test state bleed
 * (the Map is module-level singleton — there is no reset API by design).
 */

import { test, expect, describe, afterEach } from 'bun:test'
import { acquireLock, releaseLock, isLocked, acquireWebhookLock, acquirePaymentLock, releasePaymentLock, isPaymentLocked } from '../src/services/order-locks'

// ── Edit locks ──────────────────────────────────────────────────────────────

describe('acquireLock — basic grant', () => {
  const orderId = 'ord_lock_basic_01'

  afterEach(() => releaseLock(orderId))

  test('grants lock to first requester', () => {
    const result = acquireLock(orderId, 'emp_alice', 'Alice')
    expect(result.ok).toBe(true)
    expect(result.lockedBy).toBeUndefined()
  })

  test('re-lock by the same employee is idempotent', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    const result = acquireLock(orderId, 'emp_alice', 'Alice')
    expect(result.ok).toBe(true)
  })

  test('blocks second employee while first holds lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    const result = acquireLock(orderId, 'emp_bob', 'Bob')
    expect(result.ok).toBe(false)
    expect(result.lockedBy).toBe('Alice')
  })
})

describe('acquireLock — TTL eviction', () => {
  const orderId = 'ord_lock_ttl_02'

  afterEach(() => {
    releaseLock(orderId)
    // Ensure Date.now is restored even if a test throws
    Date.now = globalDateNow
  })

  const globalDateNow = Date.now

  test('evicts stale lock after 3-minute TTL', () => {
    // Alice locks now
    acquireLock(orderId, 'emp_alice', 'Alice')

    // Simulate time advancing 4 minutes (past 3-minute TTL)
    Date.now = () => globalDateNow() + 4 * 60 * 1000

    // Bob can now acquire the expired lock
    const result = acquireLock(orderId, 'emp_bob', 'Bob')
    expect(result.ok).toBe(true)
  })

  test('does not evict lock within TTL window', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')

    // Simulate only 2 minutes passing (within 3-minute TTL)
    Date.now = () => globalDateNow() + 2 * 60 * 1000

    const result = acquireLock(orderId, 'emp_bob', 'Bob')
    expect(result.ok).toBe(false)
    expect(result.lockedBy).toBe('Alice')
  })
})

// ── releaseLock ──────────────────────────────────────────────────────────────

describe('releaseLock', () => {
  const orderId = 'ord_lock_release_03'

  afterEach(() => releaseLock(orderId))

  test('owner can release their own lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    releaseLock(orderId, 'emp_alice')
    const { locked } = isLocked(orderId)
    expect(locked).toBe(false)
  })

  test('non-owner cannot release someone else\'s lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    releaseLock(orderId, 'emp_bob')  // Bob tries to release Alice's lock
    const { locked } = isLocked(orderId)
    expect(locked).toBe(true)
  })

  test('force release (no employeeId) clears any lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    releaseLock(orderId)  // force — no employeeId
    const { locked } = isLocked(orderId)
    expect(locked).toBe(false)
  })

  test('releasing an unlocked order is a no-op', () => {
    // Should not throw
    expect(() => releaseLock(orderId)).not.toThrow()
  })
})

// ── isLocked ─────────────────────────────────────────────────────────────────

describe('isLocked', () => {
  const orderId = 'ord_lock_query_04'

  afterEach(() => releaseLock(orderId))

  test('returns locked:false for an unlocked order', () => {
    const result = isLocked(orderId)
    expect(result.locked).toBe(false)
    expect(result.lockedBy).toBeUndefined()
  })

  test('returns locked:true with lockedBy name', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    const result = isLocked(orderId)
    expect(result.locked).toBe(true)
    expect(result.lockedBy).toBe('Alice')
  })

  test('evicts stale lock on isLocked check', () => {
    const globalDateNow = Date.now
    acquireLock(orderId, 'emp_alice', 'Alice')

    Date.now = () => globalDateNow() + 4 * 60 * 1000
    const result = isLocked(orderId)
    Date.now = globalDateNow

    expect(result.locked).toBe(false)
  })
})

// ── acquireWebhookLock ────────────────────────────────────────────────────────

describe('acquireWebhookLock', () => {
  const orderId = 'ord_lock_webhook_05'

  afterEach(() => releaseLock(orderId))

  test('grants webhook lock when no lock exists', () => {
    const result = acquireWebhookLock(orderId)
    expect(result).toBe(true)
  })

  test('blocks duplicate webhook when lock is still fresh', () => {
    acquireWebhookLock(orderId)
    const result = acquireWebhookLock(orderId)
    expect(result).toBe(false)
  })

  test('evicts stale webhook lock after 2-minute TTL', () => {
    const globalDateNow = Date.now
    acquireWebhookLock(orderId)

    // Advance time by 3 minutes — past the 2-minute webhook TTL
    Date.now = () => globalDateNow() + 3 * 60 * 1000
    const result = acquireWebhookLock(orderId)
    Date.now = globalDateNow

    expect(result).toBe(true)
  })

  test('does not evict fresh webhook lock within TTL', () => {
    const globalDateNow = Date.now
    acquireWebhookLock(orderId)

    // Advance time by only 1 minute — still within the 2-minute TTL
    Date.now = () => globalDateNow() + 1 * 60 * 1000
    const result = acquireWebhookLock(orderId)
    Date.now = globalDateNow

    expect(result).toBe(false)
  })

  test('edit lock blocks webhook lock (same Map)', () => {
    // An edit lock held by a staff member should also block a concurrent webhook
    acquireLock(orderId, 'emp_alice', 'Alice')
    const result = acquireWebhookLock(orderId)
    expect(result).toBe(false)
  })
})

// ── acquirePaymentLock / releasePaymentLock / isPaymentLocked ─────────────────

describe('payment lock — basic grant and query', () => {
  const orderId = 'ord_lock_payment_06'

  afterEach(() => releasePaymentLock(orderId))

  test('grants payment lock when order is free', () => {
    const result = acquirePaymentLock(orderId)
    expect(result).toBe(true)
    expect(isPaymentLocked(orderId)).toBe(true)
  })

  test('blocks a second payment lock while first is held', () => {
    acquirePaymentLock(orderId)
    const result = acquirePaymentLock(orderId)
    expect(result).toBe(false)
  })

  test('isPaymentLocked returns false for unlocked order', () => {
    expect(isPaymentLocked(orderId)).toBe(false)
  })

  test('releasePaymentLock clears the lock', () => {
    acquirePaymentLock(orderId)
    releasePaymentLock(orderId)
    expect(isPaymentLocked(orderId)).toBe(false)
  })

  test('releasePaymentLock is a no-op on an unlocked order', () => {
    expect(() => releasePaymentLock(orderId)).not.toThrow()
  })
})

describe('payment lock — TTL eviction', () => {
  const orderId = 'ord_lock_payment_ttl_07'
  const globalDateNow = Date.now

  afterEach(() => {
    releasePaymentLock(orderId)
    Date.now = globalDateNow
  })

  test('evicts stale payment lock after 10-minute TTL', () => {
    acquirePaymentLock(orderId)

    // Advance 11 minutes — past the 10-minute TTL
    Date.now = () => globalDateNow() + 11 * 60 * 1000

    expect(isPaymentLocked(orderId)).toBe(false)
    // New payment lock can be granted after eviction
    expect(acquirePaymentLock(orderId)).toBe(true)
  })

  test('does not evict payment lock within TTL window', () => {
    acquirePaymentLock(orderId)

    // Advance only 5 minutes — still within the 10-minute TTL
    Date.now = () => globalDateNow() + 5 * 60 * 1000

    expect(isPaymentLocked(orderId)).toBe(true)
  })
})

describe('payment lock — interaction with other lock types', () => {
  const orderId = 'ord_lock_payment_interact_08'

  afterEach(() => {
    releasePaymentLock(orderId)
    releaseLock(orderId)
  })

  test('payment lock blocks an edit lock attempt by staff', () => {
    acquirePaymentLock(orderId)
    const result = acquireLock(orderId, 'emp_alice', 'Alice')
    expect(result.ok).toBe(false)
    expect(result.lockedBy).toBe('Payment in progress')
  })

  test('edit lock held by staff blocks a payment lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    const result = acquirePaymentLock(orderId)
    expect(result).toBe(false)
  })

  test('releasePaymentLock does not release an edit lock', () => {
    acquireLock(orderId, 'emp_alice', 'Alice')
    releasePaymentLock(orderId)  // should be a no-op — not held by __payment__
    const { locked } = isLocked(orderId)
    expect(locked).toBe(true)
  })
})
