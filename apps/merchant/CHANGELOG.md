# Changelog

All notable changes to Merchant v2 are documented here.

## [Unreleased] — 2026-02-21

### Fixed

- **`public/js/order-entry.js`** — Table/room section not hiding for non-dine-in order types: `[hidden]` attribute was overridden by the CSS `display:flex` rule on the section. Switched to `style.display = 'none' / ''` and clear `selectedRoom`/`selectedTable` when hiding.
- **`public/js/dashboard.js`** — Orders list date range going stale on reload: rolling presets (`today`, `week`) were computed once at init and never refreshed. `loadOrders()` now re-applies the active preset before fetching so the range always reflects the current time.

### Changed

- **`public/dashboard.html`** — `order-entry.js` cache version bumped to `?v=22`
- **`public/sw.js`** — Service worker cache name bumped to `merchant-v2.5`

---

## [Unreleased] — 2026-02-20

### Added

#### Finix Payment Integration
- **`src/adapters/finix.ts`** — New Finix payment adapter implementing a 3-step server-side charge flow:
  1. Create a buyer Identity (customer name)
  2. Create a Payment Instrument (client token → stored card record)
  3. Create a Transfer (charge)
  - Supports sandbox and production environments
  - Basic-auth + `Finix-Version` header on all requests
  - Typed interfaces: `FinixCredentials`, `FinixChargeParams`, `FinixChargeResult`
- **`src/db/migrate.ts`** — Added `finix_sandbox` column to `merchants` table (INTEGER, default 1)
- **`src/routes/dashboard-payments.ts`** — Finix config block in `/api/merchants/:id/payment-config` response; Finix charge endpoint; server-IP endpoint with sandbox-aware whitelist link
- **`src/routes/merchants.ts`** — `finixSandbox` field surfaced in GET and PUT `/api/merchants/:id`
- **`public/dashboard.html`** — Finix provider card UI (setup / configured states), Finix option in payment provider selector, Converge server-IP notice with copy button and whitelist link
- **`public/css/dashboard.css`** — Styles for Finix card, IP notice, copy button, and label-code chips
- **`public/js/dashboard.js`** — `initFinixUI()` and `updateFinixUI()` for Finix provider card; Finix option wired into provider selector and `updateProviderSelector()`; Converge server-IP auto-fetch with sandbox toggle reactivity
- **`public/js/order-entry.js`** — `_openFinixPaymentFromOrderEntry()`: Finix payment flow from Order Entry tab (tip preview → Finix modal → order POST → cart reset)

#### Converge (Elavon) Improvements
- **`public/dashboard.html`** — Server IP notice block added to Converge setup view (displays detected server IP, copy button, sandbox-aware whitelist link)
- **`public/js/dashboard.js`** — `initConvergeUI()` now fetches server IP on load and refreshes when sandbox toggle changes

#### Order Entry UX
- **`public/js/dashboard.js`** — After a successful Stax payment: calls `window.resetOrderEntry?.()` to clear the cart and `loadOrders()` to refresh the orders list before showing the receipt prompt

### Changed

- **`src/routes/dashboard-payments.ts`** — Refactored payment-config endpoint to parse Converge `pos_merchant_id` (`accountId:userId`) and Finix `pos_merchant_id` (`apiUsername:applicationId:merchantId`) from a single structured field
- **`src/db/migrate.ts`** — Updated `payment_provider` column description to include `'finix'` as a valid value
- **`public/dashboard.html`** — CSS version bumped to `?v=39`

### Fixed

- **`src/adapters/converge.ts`** — Removed `ssl_result_format: 'JSON'` parameter from hosted-payment form payload (caused form-response parsing issues)

---

## [2.0.2] — 2026-02-16 — Clover Merchant ID Fix

See `CHANGELOG-CLOVER-FIX.md` for full details.

### Summary
- Fixed 401 Unauthorized errors on Clover API requests by storing and using Clover's own merchant ID (`pos_merchant_id`) separately from the internal merchant ID
- Added `pos_merchant_id` column to `api_keys` table (migration `002_add_pos_merchant_id.ts`)
- Updated `storeAPIKey()` and added `getPOSMerchantId()` in `src/crypto/api-keys.ts`
- Updated merchant routes and frontend onboarding to capture `posMerchantId`

---

## [2.0.0] — Initial Release

- Initial commit: Merchant restaurant management system
- Hono + Bun + bun:sqlite stack
- REST API (~15 endpoints): merchants, menus, items, orders, employees, payments
- Payment adapters: Stax (token), Converge (Elavon hosted form), Clover POS sync
- Dashboard frontend: profile, hours, closures, menu management, order entry, payments
- Star TSP700II thermal printer support (Star Line Mode)
- Envelope encryption for API keys (scrypt + AES-256-GCM)
- Ed25519 code signing and file integrity monitoring
