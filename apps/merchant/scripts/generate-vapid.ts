/**
 * Generate VAPID key pair for Web Push notifications.
 * Run once: bun run scripts/generate-vapid.ts
 * Then copy the output into your .env file.
 */

import { generateKeyPairSync } from 'node:crypto'

// Generate an EC key pair using the P-256 curve (required for VAPID)
const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
})

// Export as uncompressed base64url (Web Push standard)
const pubKeyRaw = publicKey.export({ type: 'spki', format: 'der' })
const privKeyRaw = privateKey.export({ type: 'pkcs8', format: 'der' })

// The last 65 bytes of SPKI-encoded P-256 public key is the uncompressed point
const pubKeyBase64 = Buffer.from(pubKeyRaw.slice(-65)).toString('base64url')
// The last 32 bytes of PKCS8-encoded P-256 private key is the raw scalar
const privKeyBase64 = Buffer.from(privKeyRaw.slice(-32)).toString('base64url')

console.log('✅ VAPID keys generated successfully!\n')
console.log('Add these to your .env file:\n')
console.log(`VAPID_PUBLIC_KEY=${pubKeyBase64}`)
console.log(`VAPID_PRIVATE_KEY=${privKeyBase64}`)
console.log(`VAPID_SUBJECT=mailto:dev@kizo.app\n`)
console.log('⚠️  Keep VAPID_PRIVATE_KEY secret — never commit it!')
