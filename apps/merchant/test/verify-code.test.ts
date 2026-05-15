/**
 * verify-code.ts unit tests
 *
 * Tests Ed25519 code-signing integrity verification utilities:
 *   hasManifest, skipCodeVerification, verifyCodeIntegrity (placeholder-key guard).
 *
 * Note: verifyCodeIntegrity with a real valid signature is not tested here because
 * it requires running the sign-release build step. We test the fail-closed paths
 * and the no-manifest skip path.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hasManifest, skipCodeVerification, verifyCodeIntegrity } from '../src/crypto/verify-code'

// ---------------------------------------------------------------------------
// hasManifest
// ---------------------------------------------------------------------------

describe('hasManifest', () => {
  test('returns false for a non-existent path', () => {
    expect(hasManifest('/tmp/does-not-exist-kizo-test-xyz.json')).toBe(false)
  })

  test('returns true when the file exists', () => {
    const tmpPath = join(tmpdir(), `test-manifest-${Date.now()}.json`)
    writeFileSync(tmpPath, JSON.stringify({ version: '1.0.0', files: {}, signature: 'abc' }))
    try {
      expect(hasManifest(tmpPath)).toBe(true)
    } finally {
      unlinkSync(tmpPath)
    }
  })
})

// ---------------------------------------------------------------------------
// skipCodeVerification
// ---------------------------------------------------------------------------

describe('skipCodeVerification', () => {
  test('runs without throwing (development no-op)', () => {
    expect(() => skipCodeVerification()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// verifyCodeIntegrity — fail-closed: placeholder key
// ---------------------------------------------------------------------------

describe('verifyCodeIntegrity — placeholder key guard', () => {
  let originalExit: typeof process.exit
  let exitCode: number | undefined

  afterEach(() => {
    if (originalExit) {
      process.exit = originalExit
    }
  })

  test('calls process.exit(1) when PUBLIC_KEY_HEX is the placeholder zero key', async () => {
    // Remove any real signing key so the module sees the placeholder
    const savedKey = process.env.CODE_SIGNING_PUBLIC_KEY
    delete process.env.CODE_SIGNING_PUBLIC_KEY

    // Intercept process.exit so the test runner survives
    originalExit = process.exit
    exitCode     = undefined
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error(`process.exit(${code})`)
    }) as typeof process.exit

    // Create a minimal but syntactically valid manifest so the function gets
    // past the readFileSync and into the placeholder-key check
    const tmpPath = join(tmpdir(), `test-manifest-ph-${Date.now()}.json`)
    writeFileSync(tmpPath, JSON.stringify({
      version:   '0.0.0',
      timestamp: new Date().toISOString(),
      files:     {},
      signature: 'a'.repeat(128),
    }))

    try {
      await verifyCodeIntegrity(tmpPath)
    } catch (err) {
      // Expected: our mock throws after capturing the exit code
      expect((err as Error).message).toContain('process.exit(1)')
    } finally {
      unlinkSync(tmpPath)
      if (savedKey !== undefined) {
        process.env.CODE_SIGNING_PUBLIC_KEY = savedKey
      }
    }
    // Assert outside catch so the test fails if process.exit was never called
    expect(exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// verifyCodeIntegrity — no manifest → resolves (handled by caller in server.ts)
// ---------------------------------------------------------------------------

describe('verifyCodeIntegrity — error path when manifest is unreadable', () => {
  let originalExit: typeof process.exit
  let exitCode: number | undefined

  afterEach(() => {
    if (originalExit) {
      process.exit = originalExit
    }
  })

  test('calls process.exit(1) when manifest path does not exist', async () => {
    originalExit = process.exit
    exitCode     = undefined
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error(`process.exit(${code})`)
    }) as typeof process.exit

    // Provide a non-placeholder key so we get past the placeholder guard
    const savedKey = process.env.CODE_SIGNING_PUBLIC_KEY
    process.env.CODE_SIGNING_PUBLIC_KEY = 'a'.repeat(64)

    try {
      await verifyCodeIntegrity('/tmp/no-such-manifest-kizo-test.json')
    } catch (err) {
      expect((err as Error).message).toContain('process.exit(1)')
    } finally {
      if (savedKey !== undefined) {
        process.env.CODE_SIGNING_PUBLIC_KEY = savedKey
      } else {
        delete process.env.CODE_SIGNING_PUBLIC_KEY
      }
    }
    // Assert outside catch so the test fails if process.exit was never called
    expect(exitCode).toBe(1)
  })
})
