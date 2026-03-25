# Payment Modal — In-Person Payment Flow

Documentation for the in-person payment flow and split-payment support in the merchant dashboard.

## Table of Contents

- [Overview](#overview)
- [Payment Methods](#payment-methods)
- [Standard Payment Flow](#standard-payment-flow)
- [Split Payments](#split-payments)
- [PAX Terminal Flow (Finix)](#pax-terminal-flow-finix)
- [Kizo Counter WebSocket Flow](#kizo-counter-websocket-flow)
- [Refunds](#refunds)
- [API Reference](#api-reference)

## Overview

The payment modal (`/merchant` dashboard → open order → "Review & Pay") handles all in-person payment scenarios:

- Cash
- Card via PAX A920 Pro terminal (Finix terminal API)
- Card via Kizo Counter Android app (WebSocket + PAX device)
- Card-not-present phone charge (Finix.js token)
- Gift card redemption
- Split payments (any combination of the above)

## Payment Methods

| Method | Provider | Auth Required |
|---|---|---|
| Cash | — | Owner / Manager |
| Terminal (card-present) | Finix | Owner / Manager |
| Phone charge (CNP) | Finix | Owner / Manager |
| Converge hosted page | Converge/Elavon | — (customer self-service) |
| Gift card | Built-in | Owner / Manager / Staff |

## Standard Payment Flow

```
Staff clicks "Review & Pay"
        │
        ▼
Dashboard fetches GET /api/merchants/:id/orders/:orderId/detail
        │  (returns itemized total, existing payment legs, outstanding balance)
        ▼
Staff selects payment method + amount
        │
        ▼
Dashboard POSTs /api/merchants/:id/orders/:orderId/record-payment
        │  body: { method, amount, reference? }
        ▼
Server records payment leg in `payments` table
Server recalculates order balance
        │
        ├── balance > 0  →  show "Add another payment" (split flow)
        └── balance = 0  →  advance order status to 'paid'
                            fire kitchen ticket (if not already fired)
                            broadcast SSE event to dashboard
```

## Split Payments

Split payments are supported natively. Each call to `record-payment` creates one payment leg. The order remains open (and the modal stays open) until the full balance is covered.

Example — $100 order paid half cash, half card:

```
POST .../record-payment  { method: 'cash', amount: 5000 }   → balance: $50.00
POST .../record-payment  { method: 'terminal', amount: 5000 } → balance: $0.00 → order paid
```

The `GET .../detail` response includes the `payments` array so the modal can display a running ledger of payment legs with their amounts and methods.

## PAX Terminal Flow (Finix)

```
Staff clicks "Card → Terminal → Confirm"
        │
        ▼
Dashboard POSTs /api/merchants/:id/orders/:orderId/record-payment
        │  { method: 'terminal', amount, terminalId }
        ▼
Server calls Finix terminal API:
  POST https://finix.com/transfers  { device: terminalId, amount, currency }
        │
        ▼
Server stores Finix transfer ID + status 'PENDING' in payment leg
        │
        ▼
Dashboard polls GET .../counter/payment-status every 2 s
        │
        ▼
Customer taps card on PAX A920 Pro
Finix terminal API transitions transfer to SUCCEEDED / FAILED
        │
        ├── SUCCEEDED  →  Server marks payment leg 'completed'
        │                 Order balance recalculated
        │                 SSE event pushed to dashboard
        └── FAILED     →  Server marks payment leg 'failed'
                          Dashboard shows error — staff can retry
```

**Testing without a physical terminal** — use the PAX A920 Pro emulator:

```bash
bun run emulator:a920
FINIX_EMULATOR_URL=http://127.0.0.1:9333 bun run dev
```

Open `http://127.0.0.1:9334` to approve or decline test payments. See the main README for full emulator documentation.

## Kizo Counter WebSocket Flow

When the Kizo Counter Android app is connected, card payments route through the Counter app instead of calling the Finix terminal API directly.

```
Staff clicks "Card → Counter → Confirm"
        │
        ▼
Dashboard POSTs /api/merchants/:id/counter/request-payment
        │  { orderId, amount }
        ▼
Server sends payment_request over WebSocket to Counter app
        │
        ▼
Counter app displays payment prompt on the Android device (facing customer)
Customer taps card on paired PAX reader
Counter app sends payment_result back over WebSocket
        │
        ▼
Server records payment result + broadcasts SSE to dashboard
Dashboard polls GET .../counter/payment-status for confirmation
```

**Counter app connection status** is shown in the dashboard header. If the Counter app is not connected, the "Counter" payment option is disabled.

## Refunds

```
POST /api/merchants/:id/orders/:orderId/refunds
Authorization: Bearer <access_token>  (owner only)
Content-Type: application/json

{
  "paymentId": "pay_abc123",   // which payment leg to refund
  "amount": 2500,              // partial refund in cents; omit for full refund
  "reason": "Customer request"
}
```

The server routes the refund to the appropriate provider:
- **Finix** — calls `POST /refunds` on the Finix API
- **Converge** — calls the Converge void/refund API
- **Cash / gift card** — records refund locally (no external call)

Refunds are stored in the `refunds` table and linked to the original payment leg. The order's `refunded_amount` column is updated accordingly.

## API Reference

| Endpoint | Purpose |
|---|---|
| `GET /api/merchants/:id/orders/:orderId/detail` | Full order with itemized payments breakdown |
| `POST /api/merchants/:id/orders/:orderId/record-payment` | Record a payment leg (cash, terminal, CNP, gift card) |
| `POST /api/merchants/:id/orders/:orderId/phone-charge` | Card-not-present charge via Finix.js token |
| `GET /api/merchants/:id/payments/config` | Which payment providers are configured |
| `POST /api/merchants/:id/orders/:orderId/refunds` | Initiate a refund |
| `GET /api/merchants/:id/payments/reconciliation` | List payments with Finix reconciliation status |
| `POST /api/merchants/:id/payments/reconcile-pending` | Re-trigger reconciliation for unmatched payments |
| `GET /api/merchants/:id/counter/status` | Counter app connection status |
| `POST /api/merchants/:id/counter/request-payment` | Send payment request to Counter app |
| `GET /api/merchants/:id/counter/payment-status` | Poll for Counter payment result |
