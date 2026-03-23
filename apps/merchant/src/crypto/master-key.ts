/**
 * Master key derivation and management
 * Uses scrypt (memory-hard KDF) with hardware UUID binding
 *
 * Security properties:
 * - Master key derived from passphrase + hardware UUID
 * - Never persisted to disk (memory-only)
 * - Hardware binding prevents database portability attacks
 * - Scrypt parameters resist GPU brute-force
 */

import { scrypt, createHmac } from 'node:crypto'
import { promisify } from 'node:util'
import { execSync } from 'node:child_process'

const scryptAsync = promisify(scrypt)

interface MasterKeyDerivation {
  salt: Buffer
  key: Buffer
}

/**
 * Derives the master key from hardware UUID and user passphrase.
 * Uses scrypt (memory-hard KDF) to resist brute-force attacks.
 *
 * @param passphrase - User-provided passphrase (minimum 12 characters recommended)
 * @returns Master key and salt
 */
async function deriveMasterKey(passphrase: string): Promise<MasterKeyDerivation> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters')
  }

  // Get hardware UUID (ARM CPU serial or machine-id)
  const hardwareUUID = getHardwareUUID()

  // Salt = HMAC-SHA256(hardwareUUID, "kizo-v1")
  // This binds the salt to the hardware, preventing database portability
  const salt = createHmac('sha256', hardwareUUID)
    .update('kizo-v2')
    .digest()

  // Master Key = scrypt(passphrase, salt, keylen=32, N=2^17, r=8, p=1)
  // N=2^17 (~130ms on RPi4, 128MB RAM) balances security vs startup time
  const key = (await scryptAsync(passphrase, salt, 32, {
    N: 131072, // 2^17 iterations
    r: 8,      // block size
    p: 1,      // parallelization
    maxmem: 256 * 1024 * 1024, // 256MB max memory
  })) as Buffer

  return { salt, key }
}

/**
 * Gets hardware-specific identifier (ARM CPU serial or machine-id).
 * Falls back to /etc/machine-id if CPU serial unavailable.
 * In development mode (NODE_ENV !== 'production'), uses a mock UUID.
 *
 * @returns Hardware UUID string
 * @throws Error if no hardware identifier found
 */
function getHardwareUUID(): string {
  // Development mode: Use environment variable or mock UUID
  if (process.env.NODE_ENV !== 'production') {
    const devUuid = process.env.DEV_HARDWARE_UUID || 'dev-hardware-uuid-localhost'
    console.warn(`⚠️  Using development hardware UUID: ${devUuid}`)
    console.warn(`   DO NOT use this in production!`)
    return devUuid
  }

  try {
    // Raspberry Pi CPU serial (from /proc/cpuinfo)
    const cpuInfo = execSync('cat /proc/cpuinfo | grep Serial', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
    }).trim()

    const match = cpuInfo.match(/Serial\s*:\s*([0-9a-f]+)/i)
    if (match && match[1] !== '0000000000000000') {
      return match[1]
    }
  } catch {
    // Fall through to next method
  }

  try {
    // Fallback: /etc/machine-id (systemd)
    const machineId = execSync('cat /etc/machine-id', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    if (machineId && machineId.length > 0) {
      return machineId
    }
  } catch {
    // Fall through to error
  }

  throw new Error(
    'Cannot derive hardware UUID: No CPU serial or machine-id found. ' +
    'This appliance requires a hardware identifier for security.'
  )
}

/**
 * In-memory cache for master key (never persisted)
 */
let cachedMasterKey: Buffer | null = null

/**
 * Initializes the master key on server startup.
 * Prompts user for passphrase if not provided via environment variable.
 *
 * @param passphrase - Optional passphrase (defaults to MASTER_KEY_PASSPHRASE env var)
 * @returns Promise that resolves when master key is initialized
 */
export async function initializeMasterKey(passphrase?: string): Promise<void> {
  const passphraseToUse =
    passphrase ||
    process.env.MASTER_KEY_PASSPHRASE ||
    (await promptForPassphrase('Enter master key passphrase: '))

  // Warn if passphrase does not meet strength requirements.
  // scrypt still hardens weak passphrases, but a strong one maximises security.
  const { valid, errors } = validatePassphrase(passphraseToUse)
  if (!valid) {
    console.warn('⚠️  MASTER_KEY_PASSPHRASE is weak:', errors.join('; '))
    console.warn('   Consider setting a stronger passphrase before going to production.')
  }

  const { key } = await deriveMasterKey(passphraseToUse)
  cachedMasterKey = key

  console.log('✅ Master key initialized (hardware-bound)')
}

/**
 * Gets the cached master key.
 *
 * @returns Master key buffer
 * @throws Error if master key not initialized
 */
export function getMasterKey(): Buffer {
  if (!cachedMasterKey) {
    throw new Error('Master key not initialized (call initializeMasterKey first)')
  }
  return cachedMasterKey
}

/**
 * Checks if master key is initialized
 */
export function isMasterKeyInitialized(): boolean {
  return cachedMasterKey !== null
}

/**
 * Clears the cached master key from memory (zero-fill for security)
 */
export function clearMasterKey(): void {
  if (cachedMasterKey) {
    cachedMasterKey.fill(0)
    cachedMasterKey = null
    console.log('✅ Master key cleared from memory')
  }
}

/**
 * Prompts user for passphrase via stdin (for interactive setup)
 *
 * @param prompt - Prompt message
 * @returns Promise resolving to passphrase
 */
async function promptForPassphrase(prompt: string): Promise<string> {
  // For now, throw error requiring env var
  // In production, would use readline or similar for interactive input
  throw new Error(
    'MASTER_KEY_PASSPHRASE environment variable required. ' +
    'Set it before starting the server:\n' +
    'export MASTER_KEY_PASSPHRASE="your-secure-passphrase"'
  )
}

/**
 * Validates passphrase strength
 *
 * @param passphrase - Passphrase to validate
 * @returns Validation result
 */
export function validatePassphrase(passphrase: string): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (passphrase.length < 12) {
    errors.push('Passphrase must be at least 12 characters')
  }

  if (!/[a-z]/.test(passphrase)) {
    errors.push('Passphrase must contain lowercase letters')
  }

  if (!/[A-Z]/.test(passphrase)) {
    errors.push('Passphrase must contain uppercase letters')
  }

  if (!/[0-9]/.test(passphrase)) {
    errors.push('Passphrase must contain numbers')
  }

  if (!/[^a-zA-Z0-9]/.test(passphrase)) {
    errors.push('Passphrase must contain special characters')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// Export for testing
export { deriveMasterKey, getHardwareUUID }
