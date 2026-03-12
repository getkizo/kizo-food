# BaanBaan Counter WebSocket API Specification

**Version:** 1.0
**Transport:** WebSocket (`ws://` on LAN, `wss://` if TLS terminated upstream)
**Endpoint:** `/counter`
**Implemented by:** BaanBaan Bun server
**Consumed by:** BaanBaan Counter Android app (Lenovo Tab One, counter tablet)

---

## Connection

```
ws://<baanbaan-host>:<port>/counter?token=<api_token>
```

- `token` — optional bearer token for authentication. BaanBaan should reject connections with an invalid or missing token with HTTP 401 before the WebSocket handshake completes.
- The counter app reconnects automatically with exponential backoff (1s → 2s → 4s … max 30s) on any disconnect or failure.
- BaanBaan should support **one active counter connection per terminal** (identified by token or a `terminalId` query param if you need multiple counters).

### On connect

BaanBaan **must** immediately send a `config` message so the counter app knows the restaurant name and Finix credentials before any payment request arrives.

---

## Message Format

All messages are JSON text frames. Every message has a `type` field as a string discriminator.

---

## Messages: BaanBaan → Counter

### `config`

Sent immediately after the WebSocket handshake and whenever merchant settings change. The counter app persists these values locally and re-initializes the Finix SDK if credentials change.

```json
{
  "type": "config",
  "restaurantName": "Baan Baan Thai Kitchen",
  "finixDeviceId": "DVxxxxxxxxxxxxxxxxxx",
  "finixMerchantId": "MUxxxxxxxxxxxxxxxxxx",
  "finixMid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "finixUserId": "USxxxxxxxxxxxxxxxxxx",
  "finixPassword": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "environment": "PROD"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `restaurantName` | string | yes | Displayed on idle and payment screens |
| `finixDeviceId` | string | yes | Finix device ID (`DV…`) |
| `finixMerchantId` | string | yes | Finix merchant ID (`MU…`) |
| `finixMid` | string | yes | Finix MID (GUID) |
| `finixUserId` | string | yes | Finix user ID (`US…`) |
| `finixPassword` | string | yes | Finix password |
| `environment` | string | yes | `"PROD"` or `"SB"` (sandbox) |

---

### `payment_request`

Sent when the cashier initiates a payment on BaanBaan. The counter app transitions from idle to the tip selection screen immediately on receipt.

```json
{
  "type": "payment_request",
  "orderId": "ORD-20260310-0042",
  "amountCents": 2850,
  "currency": "USD",
  "tipOptions": [15, 18, 20]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | string | yes | BaanBaan order ID, echoed back in the result |
| `amountCents` | integer | yes | Pre-tip order total in cents (e.g. `2850` = $28.50) |
| `currency` | string | no | ISO 4217 currency code. Default: `"USD"` |
| `tipOptions` | integer[] | no | Tip percentages shown as buttons (e.g. `[15, 18, 20]`). Empty array = only "No Tip" and "Custom". |

**Constraints:**
- Do **not** send a `payment_request` if one is already in progress. Wait for `payment_result` or `cancel_payment` first.
- If the counter app receives a `payment_request` while not idle, it logs a warning and ignores the message.

---

### `cancel_payment`

Cancels the in-progress payment. The counter app will cancel any active D135 transaction, send back a `payment_result` with `status: "cancelled"`, and return to idle.

```json
{
  "type": "cancel_payment",
  "orderId": "ORD-20260310-0042"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | string | yes | Must match the `orderId` of the current active session |

---

## Messages: Counter → BaanBaan

### `counter_status`

Sent on WebSocket connect (after BaanBaan sends `config`) and whenever the D135 terminal connection state changes.

```json
{
  "type": "counter_status",
  "deviceConnected": true
}
```

| Field | Type | Description |
|---|---|---|
| `deviceConnected` | boolean | `true` if the D135 is connected via Bluetooth and ready |

BaanBaan should surface this to the cashier UI (e.g. "Counter terminal offline" warning) to prevent sending payment requests to a disconnected terminal.

---

### `payment_result`

Sent **immediately** when the transaction resolves — before the customer dismisses the result screen. BaanBaan should unblock as soon as this arrives.

```json
{
  "type": "payment_result",
  "orderId": "ORD-20260310-0042",
  "transactionId": "TRxxxxxxxxxxxxxxxxxx",
  "status": "approved",
  "amountCents": 2850,
  "tipCents": 513,
  "totalCents": 3363,
  "signatureBase64": "<base64-encoded PNG>"
}
```

| Field | Type | Description |
|---|---|---|
| `orderId` | string | Echoed from `payment_request` |
| `transactionId` | string \| null | Finix transaction ID. `null` if not approved |
| `status` | string | `"approved"` `"declined"` `"error"` `"cancelled"` |
| `amountCents` | integer | Pre-tip amount (same as requested) |
| `tipCents` | integer | Tip selected by customer (0 if no tip) |
| `totalCents` | integer | `amountCents + tipCents` — this is what was charged |
| `signatureBase64` | string \| null | PNG signature image, Base64 encoded (no wrap). `null` if not approved |

**BaanBaan's responsibilities on receipt:**
- If `status === "approved"`: mark the order paid, attach `transactionId`, store the signature blob.
- If `status === "declined"` or `"error"`: notify the cashier; the order remains open for retry.
- If `status === "cancelled"`: return the order to unpaid state.

---

### `receipt_request`

Sent **after** `payment_result` if the customer opts into an email receipt on the result screen. May arrive seconds after `payment_result`. BaanBaan should handle it independently.

```json
{
  "type": "receipt_request",
  "orderId": "ORD-20260310-0042",
  "transactionId": "TRxxxxxxxxxxxxxxxxxx",
  "email": "customer@example.com"
}
```

| Field | Type | Description |
|---|---|---|
| `orderId` | string | Order the receipt is for |
| `transactionId` | string \| null | Finix transaction ID for the receipt |
| `email` | string | Customer-entered email address |

---

## Full Sequence Diagram

```
BaanBaan (Bun)                          Counter App (Android)
      │                                         │
      │◀──────── WS connect (GET /counter) ─────│
      │──── config {...} ──────────────────────▶│  (app stores creds, shows restaurant name)
      │◀─── counter_status {deviceConnected} ───│
      │                                         │  [idle screen]
      │                                         │
      │  [cashier taps Charge]                  │
      │──── payment_request {...} ─────────────▶│
      │                                         │  [tip selection screen]
      │                                         │  [customer selects 18%]
      │                                         │  [signature screen]
      │                                         │  [customer signs]
      │                                         │  [processing screen — D135 active]
      │                                         │  [customer taps/inserts/swipes card]
      │                                         │  [result screen]
      │◀─── payment_result {approved, ...} ─────│
      │                                         │  [customer optionally requests receipt]
      │                                         │  [idle screen]
      │                                         │
      │  [cashier cancels mid-flow]             │
      │──── cancel_payment {orderId} ──────────▶│
      │◀─── payment_result {cancelled, ...} ────│
```

---

## Error Handling

| Scenario | BaanBaan behavior |
|---|---|
| Counter disconnects mid-payment | Wait for reconnect; counter will resume or timeout and send `payment_result {status: "error"}` on reconnect |
| Counter never responds | BaanBaan should implement a timeout (suggested: 3 minutes) and allow the cashier to cancel |
| `payment_result` received with `status: "declined"` | Keep order open; cashier can retry by sending a new `payment_request` |
| Counter sends unknown message type | Ignore silently |

---

## Bun Server Implementation Notes

```typescript
// Minimal Bun WebSocket handler sketch
Bun.serve({
  port: 3000,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/counter") {
      const token = url.searchParams.get("token")
      if (!isValidToken(token)) return new Response("Unauthorized", { status: 401 })
      if (server.upgrade(req, { data: { token } })) return
    }
    return new Response("Not found", { status: 404 })
  },
  websocket: {
    open(ws) {
      // Send config immediately
      ws.send(JSON.stringify({
        type: "config",
        restaurantName: "Baan Baan Thai Kitchen",
        finixDeviceId: process.env.FINIX_DEVICE_ID,
        finixMerchantId: process.env.FINIX_MERCHANT_ID,
        finixMid: process.env.FINIX_MID,
        finixUserId: process.env.FINIX_USER_ID,
        finixPassword: process.env.FINIX_PASSWORD,
        environment: process.env.FINIX_ENV ?? "PROD"
      }))
    },
    message(ws, data) {
      const msg = JSON.parse(data as string)
      switch (msg.type) {
        case "counter_status":
          // update cashier UI with terminal status
          break
        case "payment_result":
          handlePaymentResult(msg)
          break
      }
    },
    close(ws) {
      // mark counter as offline in cashier UI
    }
  }
})

function handlePaymentResult(msg: PaymentResult) {
  if (msg.status === "approved") {
    // mark order paid, store signature, optionally send receipt
    markOrderPaid(msg.orderId, msg.transactionId, msg.totalCents)
    storeSignature(msg.orderId, msg.signatureBase64)
    if (msg.receiptRequested && msg.receiptEmail) {
      sendReceiptEmail(msg.orderId, msg.receiptEmail)
    }
  }
}
```

---

## Versioning

This is v1.0. If the protocol needs to change, add a `"version"` field to the `config` message so the counter app can adapt gracefully.
