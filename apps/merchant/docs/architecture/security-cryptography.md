# Security & Cryptography

Details of the cryptographic mechanisms used in the Merchant Appliance.

## Table of Contents

- [Envelope Encryption](#envelope-encryption)
- [Master Key Derivation](#master-key-derivation)
- [API Key Storage](#api-key-storage)
- [Ed25519 Code Signing](#ed25519-code-signing)
- [JWT Authentication](#jwt-authentication)
- [File Integrity Verification](#file-integrity-verification)
- [Transport Security](#transport-security)
- [Known Limitations](#known-limitations)

## Envelope Encryption

All sensitive credentials (POS API keys, payment provider secrets, SMTP passwords) are stored using AES-256-GCM envelope encryption.

```
plaintext secret
     │
     ▼
[scrypt KDF]  ← MASTER_KEY_PASSPHRASE + hardware UUID (CPU serial)
     │
     ▼
 master key (256-bit)
     │
     ▼
[AES-256-GCM encrypt]  ← random 96-bit IV per encryption
     │
     ▼
 ciphertext + auth tag + IV  →  stored in `api_keys` table
```

Each credential uses a fresh random IV. Decryption requires both the passphrase and the hardware UUID, binding secrets to the specific device.

See [ADR-005: Envelope Encryption](./ADRs/ADR-005-envelope-encryption.md) for the design rationale.

## Master Key Derivation

The master encryption key is derived using **scrypt**:

| Parameter | Value | Purpose |
|---|---|---|
| `N` | 65536 | CPU/memory cost |
| `r` | 8 | Block size |
| `p` | 1 | Parallelism |
| salt | `sha256(hardwareUUID)` | Binds key to device |
| passphrase | `MASTER_KEY_PASSPHRASE` env var | Operator-supplied secret |
| output | 32 bytes | AES-256 key |

In development mode (no readable CPU serial), a mock UUID derived from the computer hostname is used. **This is insecure — never use development mode in production.**

## API Key Storage

```typescript
// Storing a credential
const dek = crypto.randomBytes(32);           // data encryption key (random per secret)
const encrypted = aesGcmEncrypt(dek, secret); // encrypt the actual secret
const encryptedDek = aesGcmEncrypt(masterKey, dek); // wrap the DEK with the master key

// Row in api_keys table
{ provider, encrypted_dek, encrypted_secret, iv_dek, iv_secret, auth_tag_dek, auth_tag_secret }
```

This two-layer scheme means rotating the master key only requires re-encrypting the DEKs, not all secrets.

## Ed25519 Code Signing

Production builds are signed with an Ed25519 private key held by the release pipeline.

```bash
# Sign a release
bun run sign   # produces merchant-v2.x.x.tar.gz.sig

# Verify on device (automatic on startup in production mode)
bun run verify
```

On startup in `NODE_ENV=production`, the server computes SHA-256 of each source file and verifies the aggregate signature. A mismatch halts startup and logs `INTEGRITY_FAILURE`.

See [ADR-006: Ed25519 Code Signing](./ADRs/ADR-006-ed25519-code-signing.md) for details.

## JWT Authentication

| Token | Algorithm | Lifetime | Storage |
|---|---|---|---|
| Access token | HS256 (`JWT_SECRET`) | 15 minutes | Memory / `Authorization` header |
| Refresh token | HS256 (`JWT_SECRET`) | 7 days | `refresh_tokens` table (hashed) |

Refresh tokens are stored as **SHA-256 hashes** — the plaintext is never persisted. Logout invalidates the stored hash; the next refresh attempt returns 401.

**Passkeys (WebAuthn / FIDO2)** — Touch ID, Face ID, Windows Hello, and hardware security keys — are supported as a phishing-resistant alternative to passwords. Credentials are stored in the `webauthn_credentials` table; the server validates the authenticator assertion using the `@simplewebauthn/server` library.

## File Integrity Verification

On each startup the server reads `build/checksums.json` (produced by `bun run sign`) and verifies SHA-256 hashes for all files in `src/`. Any mismatch is logged and (in strict mode) causes the process to exit.

```json
// build/checksums.json (example)
{
  "src/server.ts": "e3b0c44298fc1c149afb...",
  "src/routes/auth.ts": "a665a45920422f9d417e..."
}
```

## Transport Security

All external traffic is tunnelled through **Cloudflare Tunnel** (`cloudflared`), which terminates TLS at Cloudflare's edge. The appliance itself listens on HTTP (`127.0.0.1:3000`) — it is never directly exposed to the internet.

Internal LAN traffic (dashboard access from staff tablets) is plain HTTP unless the operator configures a reverse proxy with a self-signed certificate.

## Known Limitations

| ID | Description | Location |
|----|-------------|----------|
| ARC-4.3 | Clover webhook HMAC signature (`X-Clover-Signature`) is not verified — all incoming Clover webhooks are accepted | `src/routes/webhooks.ts` |
| TD-2.5 | Legacy `GET /api/orders` route performs no merchant ownership check — any authenticated user can list any merchant's orders | `src/routes/orders.ts` — **scheduled for removal** |
