# Clover POS Integration Setup Guide

This guide walks through setting up Clover POS integration for the Merchant Appliance.

---

## Overview

The Clover integration allows automatic order submission to Clover POS systems, menu synchronization, and webhook-based status updates.

**Features:**
- ✅ Automatic order submission
- ✅ Real-time order status updates (via webhooks)
- ✅ Menu synchronization
- ✅ Order cancellation support
- ✅ Sandbox mode for testing

---

## Prerequisites

1. **Clover Merchant Account** - You need a Clover merchant account
2. **Clover Developer Account** - Sign up at [https://www.clover.com/developers](https://www.clover.com/developers)
3. **Merchant Appliance** - v2.0.0 or later installed and running

---

## Step 1: Create Clover App

### 1.1 Register Your App

1. Go to [Clover Developer Dashboard](https://www.clover.com/developers)
2. Click "Create App"
3. Fill in app details:
   - **App Name**: `Kizo Register`
   - **Market**: Select your target market (e.g., North America)
   - **App Type**: `Web App`

### 1.2 Configure Permissions

Your app needs the following permissions:

**Required Permissions:**
- ✅ **Orders** - Read & Write
- ✅ **Inventory** - Read
- ✅ **Merchants** - Read

**Optional Permissions:**
- ⬜ **Customers** - Read (if you want to sync customer data)
- ⬜ **Employees** - Read (for staff management)

### 1.3 Get API Credentials

After creating the app:
1. Navigate to **Settings** → **API Tokens**
2. Generate a new **API Token** for your merchant
3. Copy the token - you'll need it for configuration

**Important:** Keep this token secure. It provides access to your Clover account.

---

## Step 2: Configure Merchant Appliance

### 2.1 Store API Token

Store your Clover API token securely using the appliance's encrypted key storage:

```bash
# Using the API
curl -X POST http://localhost:3000/api/merchants/m_your_merchant_id/keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "keyType": "pos",
    "provider": "clover",
    "apiKey": "YOUR_CLOVER_API_TOKEN"
  }'
```

**Security:** The API token is encrypted with AES-256-GCM before storage. See [security-cryptography.md](../architecture/security-cryptography.md) for details.

### 2.2 Update POS Configuration

Update your merchant's POS settings to use Clover:

```typescript
// In your merchant configuration
{
  merchantId: 'm_your_merchant_id',
  posType: 'clover',
  posConfig: {
    merchantId: 'YOUR_CLOVER_MERCHANT_ID', // From Clover dashboard
    sandboxMode: false  // Set to true for testing
  }
}
```

### 2.3 Test Connection

Test the Clover connection:

```bash
curl http://localhost:3000/api/merchants/m_your_merchant_id/pos/test
```

Expected response:
```json
{
  "ok": true,
  "latencyMs": 120,
  "version": "clover-v3"
}
```

---

## Step 3: Configure Webhooks (Optional but Recommended)

Webhooks enable real-time order status updates from Clover.

### 3.1 Get Webhook URL

Your webhook URL will be:
```
https://your-domain.kizo.app/webhooks/clover/m_your_merchant_id
```

If using Cloudflare Tunnel:
```
https://merchants.kizo.app/webhooks/clover/m_your_merchant_id
```

### 3.2 Configure in Clover Dashboard

1. Go to [Clover Developer Dashboard](https://www.clover.com/developers)
2. Select your app
3. Navigate to **Settings** → **Webhooks**
4. Click **Add Webhook**
5. Enter your webhook URL
6. Subscribe to events:
   - ✅ `ORDER_CREATED`
   - ✅ `ORDER_UPDATED`
   - ✅ `ORDER_DELETED`
7. Save configuration

### 3.3 Test Webhook

Test webhook reception:

```bash
# Send test webhook
curl -X POST https://your-domain.kizo.app/webhooks/clover/m_your_merchant_id \
  -H "Content-Type: application/json" \
  -d '{
    "type": "ORDER_CREATED",
    "objectId": "test_order_123",
    "merchants": {
      "id": "YOUR_CLOVER_MERCHANT_ID"
    }
  }'
```

Check server logs for:
```
📥 Clover webhook received: { merchantId: 'm_...', type: 'ORDER_CREATED', objectId: 'test_order_123' }
```

---

## Step 4: Test Order Flow

### 4.1 Place Test Order

```bash
curl -X POST http://localhost:3000/joes-pizza/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerName": "Test Customer",
    "customerPhone": "+1-555-0100",
    "items": [
      {
        "dishId": "dish_margherita",
        "quantity": 1
      }
    ],
    "orderType": "pickup"
  }'
```

### 4.2 Verify in Clover

1. Log in to [Clover Dashboard](https://www.clover.com/dashboard)
2. Navigate to **Orders**
3. You should see the new order appear

### 4.3 Check Order Status

```bash
curl http://localhost:3000/api/orders/ord_...
```

Expected response:
```json
{
  "id": "ord_...",
  "status": "confirmed",
  "posOrderId": "clover_order_123",
  "pickupCode": "A7K2",
  ...
}
```

---

## Step 5: Menu Synchronization

### 5.1 Manual Sync

Trigger a manual menu sync:

```bash
curl -X POST http://localhost:3000/api/merchants/m_your_merchant_id/menu/sync
```

### 5.2 Automatic Sync

Configure automatic menu sync (every 5 minutes):

```typescript
// In merchant settings
{
  menuSyncInterval: 300000,  // 5 minutes in milliseconds
  autoSync: true
}
```

### 5.3 Verify Synced Menu

```bash
curl http://localhost:3000/joes-pizza/menu
```

Expected response:
```json
{
  "merchant": {
    "name": "Joe's Pizza",
    "slug": "joes-pizza"
  },
  "dishes": [
    {
      "id": "clover_item_123",
      "name": "Margherita Pizza",
      "price": 1499,
      "category": "pizzas",
      "available": true
    },
    ...
  ]
}
```

---

## Sandbox vs Production

### Sandbox Mode (Testing)

```typescript
{
  sandboxMode: true,
  apiToken: 'YOUR_SANDBOX_API_TOKEN'
}
```

- **API Base:** `https://sandbox.dev.clover.com`
- **Use for:** Testing, development, staging
- **Limitations:** No real payments, limited data retention

### Production Mode

```typescript
{
  sandboxMode: false,
  apiToken: 'YOUR_PRODUCTION_API_TOKEN'
}
```

- **API Base:** `https://api.clover.com`
- **Use for:** Live production environment
- **Requirements:** PCI compliance for payment processing

---

## Troubleshooting

### Issue: "Failed to connect to Clover"

**Causes:**
1. Invalid API token
2. Incorrect merchant ID
3. Network connectivity issues
4. API permissions not granted

**Solutions:**
```bash
# Test connection manually
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://api.clover.com/v3/merchants/YOUR_MERCHANT_ID

# Check audit logs
curl http://localhost:3000/api/admin/logs?event=key_failed
```

### Issue: "Order not appearing in Clover"

**Causes:**
1. Order submission failed
2. Network timeout
3. Clover API rate limit hit
4. Invalid item IDs

**Solutions:**
```bash
# Check order status
curl http://localhost:3000/api/orders/ord_...

# Check SAM state for errors
# Look for sam_state.error field in response

# Retry order submission
curl -X POST http://localhost:3000/api/orders/ord_.../retry
```

### Issue: "Webhooks not received"

**Causes:**
1. Webhook URL not publicly accessible
2. Firewall blocking requests
3. Incorrect webhook configuration in Clover
4. SSL certificate issues

**Solutions:**
```bash
# Test webhook endpoint
curl https://your-domain.kizo.app/webhooks/health

# Check webhook logs
tail -f /var/log/kizo/webhooks.log

# Verify Cloudflare Tunnel is running
systemctl status cloudflared
```

### Issue: "Menu items not syncing"

**Causes:**
1. Items are hidden in Clover
2. Items marked as unavailable
3. API permissions insufficient
4. Network timeout during sync

**Solutions:**
```bash
# Force menu sync
curl -X POST http://localhost:3000/api/merchants/m_your_merchant_id/menu/sync \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Check Clover inventory API directly
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
  "https://api.clover.com/v3/merchants/YOUR_MERCHANT_ID/items?expand=categories"
```

---

## API Rate Limits

Clover API has rate limits:
- **Production:** 16 requests per second per merchant
- **Sandbox:** 4 requests per second per merchant

**Best Practices:**
- Cache menu data (5-minute default)
- Use webhooks for status updates instead of polling
- Implement exponential backoff on failures
- Monitor rate limit headers: `X-RateLimit-*`

---

## Security Considerations

### API Token Security

1. **Never commit tokens to Git**
   ```bash
   # Add to .gitignore
   echo "*.env" >> .gitignore
   echo ".clover-token" >> .gitignore
   ```

2. **Rotate tokens regularly**
   - Recommended: Every 90 days
   - After employee turnover
   - After suspected breach

3. **Use separate tokens for sandbox/production**
   - Prevents accidental production usage during testing

### Webhook Security

1. **Verify webhook signatures** (TODO in webhook handler)
   ```typescript
   const signature = request.headers.get('clover-signature')
   if (!verifyCloverSignature(payload, signature, webhookSecret)) {
     return Response.json({ error: 'Invalid signature' }, 401)
   }
   ```

2. **Use HTTPS only**
   - Cloudflare Tunnel provides automatic SSL
   - Never expose webhooks over HTTP

3. **Rate limit webhook endpoint**
   ```typescript
   // Max 100 webhooks per minute per merchant
   rateLimiter.limit(merchantId, 100, 60000)
   ```

---

## Advanced Configuration

### Custom Order Mapping

Map Clover order states to custom statuses:

```typescript
const customStateMapping = {
  'open': 'pending',
  'locked': 'confirmed',
  'paid': 'ready',  // Custom: mark as ready when paid
}
```

### Item Matching Strategy

Configure how menu items are matched:

```typescript
{
  itemMatching: 'exact',  // 'exact' | 'fuzzy' | 'sku'
  createMissingItems: true,  // Auto-create items not in Clover
  syncDirection: 'bidirectional'  // 'clover->app' | 'app->clover' | 'bidirectional'
}
```

### Error Handling

Configure retry behavior:

```typescript
{
  maxRetries: 3,
  retryDelay: 2000,  // 2 seconds
  timeoutMs: 5000     // 5 second timeout
}
```

---

## Next Steps

After setting up Clover integration:

1. **Test thoroughly in sandbox** before going live
2. **Configure monitoring** for order failures
3. **Set up alerts** for webhook failures
4. **Train staff** on order management
5. **Plan for failover** (manual mode if Clover is down)

---

## Support

- **Clover API Docs:** [https://docs.clover.com](https://docs.clover.com)
- **Clover Support:** [https://www.clover.com/support](https://www.clover.com/support)
- **Appliance Issues:** GitHub Issues or support@kizo.app

---

**Last Updated:** 2026-02-16
**Clover API Version:** v3
**Appliance Version:** 2.0.0
