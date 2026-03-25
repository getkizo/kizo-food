# ADR-006: Ed25519 Code Signing for Production Builds

**Status:** Accepted
**Date:** 2026-01-29
**Deciders:** Kizo engineering

## Context

The Merchant Appliance runs on devices physically located at merchant premises. An attacker with local network access (or brief physical access) could replace source files with malicious versions. We need a way to detect tampering before the server processes real payment data.

Requirements:

1. Detect modified source files before startup completes
2. Signing key held only by the release pipeline — operators cannot self-sign
3. Verification must be fast (< 500 ms) on Raspberry Pi 4
4. No network call required to verify — works offline

## Decision

Use **Ed25519 signatures** over a SHA-256 manifest of all source files.

### Build Pipeline

```
bun run build
  │
  ├── Transpile TypeScript → build/
  ├── Compute SHA-256 of each file in src/
  └── Write build/checksums.json

bun run sign
  │
  ├── Read build/checksums.json
  ├── Sign with Ed25519 private key (stored in CI secrets)
  └── Write build/checksums.json.sig (base64-encoded signature)

# Package release
tar -czf merchant-v2.x.x.tar.gz src/ build/ package.json ...
```

### Verification (on device startup)

```typescript
// src/crypto/integrity.ts (simplified)
import { verify } from '@noble/ed25519';

const manifest = JSON.parse(readFileSync('build/checksums.json', 'utf8'));
const sig = readFileSync('build/checksums.json.sig', 'base64');
const pubkey = PUBLIC_KEY_HEX; // embedded in source

if (!await verify(sig, JSON.stringify(manifest), pubkey)) {
  logger.error('INTEGRITY_FAILURE: signature mismatch');
  process.exit(1);
}

// Verify each file hash
for (const [path, expectedHash] of Object.entries(manifest)) {
  const actual = sha256Hex(readFileSync(path));
  if (actual !== expectedHash) {
    logger.error(`INTEGRITY_FAILURE: ${path} hash mismatch`);
    process.exit(1);
  }
}
```

Verification is only enforced in `NODE_ENV=production`. Development and test runs skip it.

### Why Ed25519?

| Property | Ed25519 | RSA-2048 | ECDSA (P-256) |
|---|---|---|---|
| Key size | 32 bytes | 256 bytes | 32 bytes |
| Signature size | 64 bytes | 256 bytes | 64 bytes |
| Verify speed (Pi 4) | ~0.3 ms | ~15 ms | ~2 ms |
| Side-channel resistance | Strong (deterministic) | Weak (timing varies) | Moderate |
| Library (`@noble/ed25519`) | Zero native deps | Requires OpenSSL binding | Requires OpenSSL binding |

Ed25519's deterministic signing eliminates the risk of nonce reuse that affects ECDSA. `@noble/ed25519` is a pure-TypeScript implementation with no native addon required.

## Consequences

**Positive:**
- A tampered `src/` file is detected before any merchant data is processed
- Verification adds ~250 ms to startup on Raspberry Pi 4 — acceptable
- Ed25519 public key is embedded in the binary — no network call required

**Negative:**
- Operators cannot apply hotfixes without going through the release pipeline. Mitigated by the fast CI turnaround (< 5 min from merge to signed artifact).
- If the CI signing key is compromised, all devices will accept malicious releases until the public key is rotated. Mitigation: key is stored in a hardware-backed CI secret (GitHub Actions environment secret with restricted access).
- Integrity check only covers files listed in the manifest — an attacker who can modify the manifest file and re-sign (without the private key) cannot produce a valid signature.

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| No code signing | Unacceptable given physical device access risk |
| Checksum-only (no signature) | Attacker can modify both source and checksums.json |
| RSA-2048 | Larger keys, slower verification, native OpenSSL dependency |
| Secure Boot (OS level) | Protects bootloader but not application-level code replacement |
| Package manager signature (npm audit) | Only covers dependency integrity, not our own source |
