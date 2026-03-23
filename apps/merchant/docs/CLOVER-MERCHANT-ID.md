# Clover Merchant ID Architecture

## Overview

Clover uses **two different merchant identifiers** that serve different purposes:

1. **Clover Merchant ID** (e.g., `WJ3EYD26EN771`) - Clover's unique identifier
2. **Our Internal Merchant ID** (e.g., `m_abc123xyz`) - Kizo's internal identifier

## The Problem

When making Clover API requests, you **must use Clover's merchant ID**, not our internal one.

### Example API Request

```bash
# ✅ CORRECT - Using Clover's merchant ID
curl "https://api.clover.com/v3/merchants/WJ3EYD26EN771/employees/EMQKATB8ATKQG/shifts" \
  -H "Authorization: Bearer YOUR_TOKEN"

# ❌ WRONG - Using our internal merchant ID
curl "https://api.clover.com/v3/merchants/m_abc123xyz/employees/EMQKATB8ATKQG/shifts" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

The wrong merchant ID returns **401 Unauthorized** because the API token belongs to `WJ3EYD26EN771`, not `m_abc123xyz`.

## Database Schema

The Clover merchant ID is stored in the `api_keys` table:

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,           -- Our internal ID (m_abc123xyz)
  key_type TEXT NOT NULL,              -- 'pos' or 'payment'
  provider TEXT NOT NULL,              -- 'clover', 'square', etc.
  encrypted_value TEXT NOT NULL,       -- Encrypted API token
  pos_merchant_id TEXT,                -- Clover's merchant ID (WJ3EYD26EN771)
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
```

## Where to Find Clover Merchant ID

### Option 1: Clover Dashboard
1. Log in to https://www.clover.com/dashboard
2. Look at the URL: `https://www.clover.com/merchants/WJ3EYD26EN771/...`
3. The segment after `/merchants/` is your Clover merchant ID

### Option 2: API Call
```bash
# Get merchant info using your API token
curl "https://api.clover.com/v3/merchants/{YOUR_MERCHANT_ID}" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response includes:
{
  "id": "WJ3EYD26EN771",
  "name": "Joe's Pizza",
  ...
}
```

### Option 3: During Onboarding
When merchants add their Clover credentials in the onboarding flow, they provide:
- **Clover API Token** - Authentication token
- **Clover Merchant ID** - Their merchant ID from Clover

Both are required and stored together.

## Implementation

### Storing Clover Credentials

```typescript
// POST /api/merchants/:id/keys
await fetch(`/api/merchants/${merchantId}/keys`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    keyType: 'pos',
    provider: 'clover',
    apiKey: 'YOUR_CLOVER_API_TOKEN',
    posMerchantId: 'WJ3EYD26EN771', // ← Clover's merchant ID
  }),
})
```

### Retrieving and Using

```typescript
import { getAPIKey, getPOSMerchantId } from '../crypto/api-keys'
import { CloverPOSAdapter } from '../adapters/clover'

// Get stored credentials
const cloverToken = await getAPIKey(merchantId, 'pos', 'clover')
const cloverMerchantId = getPOSMerchantId(merchantId, 'clover')

// Create adapter with CLOVER's merchant ID
const adapter = new CloverPOSAdapter({
  merchantId: cloverMerchantId, // ← Use Clover's ID, not ours!
  posType: 'clover',
  apiKey: cloverToken,
  sandboxMode: false,
})

// Now API calls use the correct merchant ID
const menu = await adapter.fetchMenu()
```

## API Reference

### `storeAPIKey()`

```typescript
/**
 * Stores encrypted API key with optional POS merchant ID
 */
await storeAPIKey(
  merchantId: string,        // Our internal ID
  keyType: 'pos' | 'payment',
  provider: string,          // 'clover', 'square', etc.
  apiKey: string,            // Encrypted API token
  ipAddress?: string,        // For audit log
  posMerchantId?: string     // Clover's merchant ID (if applicable)
)
```

### `getPOSMerchantId()`

```typescript
/**
 * Retrieves the POS provider's merchant ID
 */
const cloverMerchantId = getPOSMerchantId(
  merchantId: string,  // Our internal ID
  provider: string     // 'clover'
)
// Returns: 'WJ3EYD26EN771' or null
```

## Migration

If you have existing merchants with Clover credentials stored, you need to:

1. Run the migration to add the `pos_merchant_id` column:
   ```bash
   bun run src/db/migrate.ts
   ```

2. Update existing records with their Clover merchant ID:
   ```sql
   -- Manually update each merchant's record
   UPDATE api_keys
   SET pos_merchant_id = 'WJ3EYD26EN771'
   WHERE merchant_id = 'm_abc123xyz' AND provider = 'clover';
   ```

3. Or have merchants re-enter their credentials through the dashboard

## Testing

### Test with Correct Merchant ID

```bash
# Your working test
TOKEN="6b8ce1f4-224b-16c9-18fa-c2fa3de37599"
MERCHANT_ID="WJ3EYD26EN771"  # ← Clover's merchant ID

curl "https://api.clover.com/v3/merchants/$MERCHANT_ID/employees/EMQKATB8ATKQG/shifts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"

# Should return 200 OK with shift data
```

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Using wrong merchant ID | Use Clover's merchant ID, not ours |
| 401 Unauthorized | Token doesn't match merchant | Verify token belongs to this merchant |
| 404 Not Found | Invalid merchant ID format | Check merchant ID spelling |
| 403 Forbidden | Missing permissions | Add required permissions to API token |

## Security Note

The Clover merchant ID is **not sensitive** - it's visible in URLs and API responses. However, the **API token** is highly sensitive and must be encrypted using envelope encryption with the merchant's DEK.

## Architecture Decision

**Why store both IDs?**

1. **Our internal ID** (`m_abc123xyz`) - Used for all internal operations, database joins, and business logic
2. **Clover merchant ID** (`WJ3EYD26EN771`) - Used only for Clover API calls

This separation allows us to:
- Support multiple POS providers (each with their own merchant ID format)
- Maintain consistent internal referential integrity
- Migrate merchants between POS systems without breaking internal references
- Support multi-POS scenarios (one merchant using multiple POS systems)

---

**Summary**: Always use `getPOSMerchantId()` when creating POS adapters to ensure you're using the provider's merchant ID, not our internal one.
