/**
 * Code integrity verification using Ed25519 signatures
 * Verifies manifest.json signature and file hashes on startup
 *
 * Security properties:
 * - Ed25519 signature verification (fast on ARM)
 * - SHA256 file hashing
 * - Tamper detection
 * - Auto-shutdown on verification failure
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as ed25519 from '@noble/ed25519'
import { auditSecurityEvent } from './audit'

// Public key for Ed25519 signature verification.
// Injected at build time via CODE_SIGNING_PUBLIC_KEY environment variable.
// The build/sign-release.ts script sets this to the hex-encoded public key
// that corresponds to the private key used to sign the manifest.
// Falls back to the zero placeholder — the fail-closed guard below will
// exit(1) if a manifest is present and the key is still the placeholder.
const PUBLIC_KEY_HEX =
  process.env.CODE_SIGNING_PUBLIC_KEY ??
  '0000000000000000000000000000000000000000000000000000000000000000' // Placeholder

const PLACEHOLDER_KEY = '0'.repeat(64)

interface Manifest {
  version: string
  timestamp: string
  files: Record<string, string> // filename -> SHA256 hash
  signature: string // Ed25519 signature (hex)
}

/**
 * Recursively sorts all object keys so that JSON.stringify produces a
 * deterministic canonical representation at every level of nesting.
 * Required for Ed25519 signature verification — the array-replacer form of
 * JSON.stringify only filters top-level keys, leaving nested objects (such as
 * `files`) serialized as `{}` which would exclude file hashes from the signed
 * payload.
 */
function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const obj = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = deepSortKeys(obj[key])
  }
  return sorted
}

/**
 * Verifies the code signature on startup.
 * Exits process if verification fails.
 *
 * @param manifestPath - Path to manifest.json
 * @returns Promise that resolves if verification succeeds
 */
export async function verifyCodeIntegrity(
  manifestPath: string = join(import.meta.dir, '../../manifest.json')
): Promise<void> {
  console.log('🔐 Verifying code integrity...')

  // C-09: Fail-closed — refuse to verify with a placeholder key in ANY environment.
  // The server.ts `hasManifest()` gate already skips verification entirely in dev
  // when no manifest is present — this function only runs when a manifest exists,
  // so a placeholder key here means the build process never injected the real key.
  if (PUBLIC_KEY_HEX === PLACEHOLDER_KEY) {
    console.error('❌ Code integrity cannot start: PUBLIC_KEY_HEX is still the placeholder zero key.')
    console.error('   Build the server with `bun run sign` to inject the real Ed25519 public key.')
    process.exit(1)
  }

  try {
    // Read manifest.json
    const manifestContent = readFileSync(manifestPath, 'utf-8')
    const manifest: Manifest = JSON.parse(manifestContent)

    // 1. Verify signature
    const { signature, ...manifestWithoutSig } = manifest
    const canonicalJSON = JSON.stringify(deepSortKeys(manifestWithoutSig))
    const messageHash = createHash('sha256').update(canonicalJSON).digest()

    const publicKey = Buffer.from(PUBLIC_KEY_HEX, 'hex')
    const signatureBytes = Buffer.from(signature, 'hex')

    const isValid = await ed25519.verify(signatureBytes, messageHash, publicKey)

    if (!isValid) {
      console.error('❌ SIGNATURE VERIFICATION FAILED')
      console.error('   Code has been tampered with or signature is invalid.')
      console.error('   Shutting down for security.')

      auditSecurityEvent('code_verification_failed', {
        reason: 'invalid_signature',
        version: manifest.version,
        timestamp: manifest.timestamp,
      })

      process.exit(1)
    }

    // 2. Verify file hashes
    let mismatchFound = false
    const basePath = join(import.meta.dir, '../..')

    for (const [filepath, expectedHash] of Object.entries(manifest.files)) {
      const fullPath = join(basePath, filepath)

      try {
        const content = readFileSync(fullPath)
        const actualHash = createHash('sha256').update(content).digest('hex')

        if (actualHash !== expectedHash) {
          console.error(`❌ HASH MISMATCH: ${filepath}`)
          console.error(`   Expected: ${expectedHash}`)
          console.error(`   Actual:   ${actualHash}`)
          mismatchFound = true

          auditSecurityEvent('file_integrity_failed', {
            filepath,
            expectedHash,
            actualHash,
          })
        }
      } catch (error) {
        console.error(`❌ FILE MISSING: ${filepath}`)
        console.error(`   ${error}`)
        mismatchFound = true

        auditSecurityEvent('file_integrity_failed', {
          filepath,
          error: 'file_missing',
        })
      }
    }

    if (mismatchFound) {
      console.error('❌ CODE INTEGRITY CHECK FAILED')
      console.error('   One or more files have been modified or are missing.')
      console.error('   Shutting down for security.')

      auditSecurityEvent('code_verification_failed', {
        reason: 'hash_mismatch',
        version: manifest.version,
      })

      process.exit(1)
    }

    console.log(`✅ Code integrity verified (v${manifest.version})`)
    console.log(`   Signed at: ${manifest.timestamp}`)
    console.log(`   Files checked: ${Object.keys(manifest.files).length}`)
  } catch (error) {
    console.error('❌ CODE VERIFICATION ERROR:', error)
    console.error('   Cannot verify code integrity. Shutting down.')

    auditSecurityEvent('code_verification_failed', {
      reason: 'verification_error',
      error: error instanceof Error ? error.message : String(error),
    })

    process.exit(1)
  }
}

/**
 * Skips code verification (for development only)
 * WARNING: Never use in production
 */
export function skipCodeVerification(): void {
  console.warn('⚠️  CODE VERIFICATION SKIPPED (development mode)')
  console.warn('   This is insecure and should NEVER be used in production')
}

/**
 * Checks if manifest.json exists
 */
export function hasManifest(
  manifestPath: string = join(import.meta.dir, '../../manifest.json')
): boolean {
  try {
    readFileSync(manifestPath)
    return true
  } catch {
    return false
  }
}
