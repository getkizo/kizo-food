# ADR-005: Envelope Encryption for API Key Storage

**Status:** Accepted
**Date:** 2026-01-22
**Deciders:** Kizo engineering

## Context

The Merchant Appliance stores third-party API credentials (Clover API tokens, Finix credentials, Converge vendor tokens, SMTP passwords) in its local SQLite database. If the database file is copied off the device by an attacker, these credentials must not be immediately usable.

Requirements:

1. Credentials encrypted at rest — database theft should not yield plaintext secrets
2. Encryption key not stored in the database — must be derived at runtime
3. Key bound to the specific device — a stolen database file is unusable on a different machine
4. Key rotation feasible — changing the passphrase should not require re-entering all credentials

## Decision

Use **AES-256-GCM envelope encryption** with a **scrypt-derived master key**.

### Key Hierarchy

```
MASTER_KEY_PASSPHRASE (env var, operator-supplied)
    +
hardware UUID (CPU serial number, read from /proc/cpuinfo or WMI)
    │
    ▼
scrypt(N=65536, r=8, p=1, salt=sha256(hardwareUUID))
    │
    ▼
master key (256-bit)
    │
    ├──► AES-256-GCM encrypt(DEK₁)  →  encrypted_dek stored in DB
    ├──► AES-256-GCM encrypt(DEK₂)  →  encrypted_dek stored in DB
    └──► ...

DEK₁ (random 256-bit, one per credential)
    │
    ▼
AES-256-GCM encrypt(secret₁)  →  encrypted_secret stored in DB
```

### Why Envelope Encryption?

Encrypting each credential directly with the master key would require re-encrypting all secrets if the passphrase changes. With envelope encryption, key rotation only requires re-encrypting the DEKs (a fast, DB-only operation), not the secrets themselves.

### Hardware Binding

The scrypt salt is derived from the device's CPU serial number. An attacker who copies the SQLite file to another machine cannot derive the master key without also knowing both the passphrase and the original hardware UUID.

In development mode (`NODE_ENV !== 'production'`), the UUID falls back to a hash of the machine hostname. This is explicitly insecure and logged as a warning on startup.

## Schema

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  provider      TEXT NOT NULL,        -- 'clover', 'finix', 'converge', 'smtp', …
  encrypted_dek TEXT NOT NULL,        -- base64(AES-GCM(masterKey, dek))
  iv_dek        TEXT NOT NULL,        -- base64(96-bit IV for dek encryption)
  tag_dek       TEXT NOT NULL,        -- base64(128-bit auth tag)
  encrypted_secret TEXT NOT NULL,     -- base64(AES-GCM(dek, secret))
  iv_secret     TEXT NOT NULL,
  tag_secret    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

## Consequences

**Positive:**
- Stolen database file is useless without the passphrase + hardware UUID
- Key rotation (passphrase change) only touches the `encrypted_dek` columns — O(n credentials), not O(n secret bytes)
- AES-256-GCM provides both confidentiality and integrity — tampered ciphertext fails authentication

**Negative:**
- Cold start requires scrypt derivation (~200 ms on Raspberry Pi 4). Acceptable — happens once at startup, not per-request
- If the operator loses the passphrase, all stored credentials are permanently unrecoverable — must be re-entered. Mitigated by clear operator documentation.
- Hardware UUID is not secret — scrypt cost (N=65536) provides the brute-force resistance against dictionary attacks

## Alternatives Considered

| Alternative | Rejected because |
|---|---|
| Store credentials in plain text | Unacceptable — single-file DB theft exposes all merchant secrets |
| OS keychain (libsecret, Keychain) | Not available headless on Raspberry Pi OS; brittle across OS upgrades |
| Hardware TPM | Not universally available on target ARM boards |
| Asymmetric encryption (RSA/EC) | No benefit here — the decryption key must be present on the device anyway |
| bcrypt KDF | Lower memory hardness than scrypt; scrypt is the standard for storage encryption |
