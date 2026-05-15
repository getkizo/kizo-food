import { describe, it, expect, beforeEach } from 'bun:test'

// Use an in-memory DB for tests
process.env.DB_PATH = ':memory:'
process.env.SESSION_SECRET = 'test-secret-for-unit-tests-only'

import { getDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { checkAndIncrement } from '../src/services/rate-limiter'

beforeEach(() => {
  migrate()
  getDatabase().exec('DELETE FROM rate_limits')
})

describe('checkAndIncrement', () => {
  it('allows first request', () => {
    const result = checkAndIncrement('abc123')
    expect(result.allowed).toBe(true)
    expect(result.perMinute).toBe(1)
  })

  it('allows up to 10 requests per minute', () => {
    for (let i = 0; i < 9; i++) checkAndIncrement('ip1')
    const result = checkAndIncrement('ip1')
    expect(result.perMinute).toBe(10)
    expect(result.allowed).toBe(true)
  })

  it('blocks 11th request in the same minute window', () => {
    for (let i = 0; i < 10; i++) checkAndIncrement('ip2')
    const result = checkAndIncrement('ip2')
    expect(result.perMinute).toBe(11)
    expect(result.allowed).toBe(false)
  })

  it('independent IPs do not affect each other', () => {
    for (let i = 0; i < 10; i++) checkAndIncrement('ip3')
    const result = checkAndIncrement('ip4')
    expect(result.allowed).toBe(true)
    expect(result.perMinute).toBe(1)
  })
})
