# Changelog

All notable changes to Merchant v2 are documented here.

## [Unreleased] — 2026-05-07 (2)

### Added

- **Ingredient prices — vendor/unit grouping** (`src/routes/manager.ts`, `public/manager-app/js/manager-ingredients.js`, `public/manager-app/js/manager.js`) — The price snapshot now returns one row per `(description, vendor, unit)` combination (previously collapsed to one row per description). Search results show separate selectable cards for each vendor variant (e.g. "Broccoli / case — Citi Produce" vs "Broccoli / lbs — QFC"). Tapping a card fetches a 30-day sparkline filtered to that specific vendor via the new optional `?vendor=` query parameter on `price-history`. IDB keyPath changed from `'description'` to a composite `'key'` field (`description|vendor|unit`); IDB upgraded to v2 with an `offline_cache` object store.

- **Offline cache for receipts** — `_loadReceipts` now saves the receipts list to IDB on every successful fetch. On failure (offline or 403 from IP allowlist) it restores the cached list and shows a yellow "Offline — showing cached data" banner above the list.

- **Offline cache for reports** — A `_makeCachedFetch` wrapper transparently caches every GET API response by URL path. Report renderers receive this wrapper instead of bare `apiFetch`; on next open while offline they are served the cached JSON and render normally. If any response came from cache a yellow "Offline — showing cached data" banner is prepended to the report container. Also fixed four fire-and-forget `_fetch()` calls in `manager-reports.js` (changed to `return _fetch()`) so the outer async Promise resolves after the initial render — required for the offline banner to appear at the right time.

### Changed

- **Manager PWA SW cache** bumped from `manager-v2` to `manager-v3` to force refresh of all updated shell files.

---

## [Unreleased] — 2026-05-07

### Added

- **Manager PWA — Prices tab** (`public/manager-app/js/manager-ingredients.js`, `public/manager-app/js/manager.js`, `public/manager-app/index.html`, `public/manager-app/css/manager.css`) — New fourth nav tab ("Prices") in the manager PWA. Staff can type any ingredient description and instantly see the last price paid (vendor, unit, date) plus an inline 30-day SVG sparkline chart pulled live from the server. Results fall back to an offline-first IndexedDB snapshot (pre-fetched silently on login) so the tab remains usable without network. Rapid-typing race conditions are prevented with a generation counter that discards stale async results.

- **`GET /api/merchants/:id/manager/ingredients/price-snapshot`** (`src/routes/manager.ts`) — Returns the most-recent price row for every distinct ingredient description purchased in the last 90 days, using a correlated subquery (greatest-N-per-group). Used by the PWA to seed IndexedDB on boot.

- **`GET /api/merchants/:id/manager/ingredients/price-history?q=`** (`src/routes/manager.ts`) — Returns the last 30 days of purchase history for any ingredient matching the query string (case-insensitive LIKE). Used by the PWA to render the sparkline chart when online.

- **`manager-ingredients.js` module** — Isolated IIFE that manages a dedicated IndexedDB database (`kizo-manager-prices` v1, separate from the receipt-queue DB) with `prefetchSnapshot`, `searchSnapshot`, and `fetchHistory` entry points.

### Fixed

- **`manager-reports.js` missing from SW shell cache** (`public/manager-app/sw.js`) — The file was loaded by the app but absent from `SHELL_FILES`, so it was never pre-cached and failed offline. Added alongside the new `manager-ingredients.js`. Cache name bumped to `manager-v2` to force an immediate refresh.

---

## [Unreleased] — 2026-05-05

### Added

- **Weather tab** (`src/routes/weather.ts`, `public/dashboard.html`, `public/js/dashboard.js`, `public/css/dashboard.css`) — New sidebar section showing the 7-day NWS forecast for Kirkland, WA. A large hero card displays the current period (temperature, condition, wind). The remaining 13 periods are shown as a responsive card grid. Data is proxied server-side from the U.S. National Weather Service public API (`api.weather.gov/gridpoints/SEW/129,71/forecast`) with the required `User-Agent` header and a 1-hour in-process cache to avoid hammering the API. No API key or registration required; data is public domain with no commercial restrictions. A NWS credit and link appear at the bottom of the section. Dashboard CSS bumped to v90, JS to v164.

---

## [Unreleased] — 2026-05-02

### Added

- **QR offer preview modal** (`public/store/index.html`, `js/store.js`, `css/store.css`) — When a customer arrives via a QR marketing link (`?c=SLUG`), a bottom sheet now shows the campaign name, discount label, validity dates, and optional coupon code before applying it to the cart. The customer must explicitly accept or decline. States handled: active (apply on accept), pending/not-yet-started (reminder toast on accept, not applied), already-redeemed (informational "Got it"), and ended (410 toast, sheet not shown). Backdrop tap closes without clearing the saved campaign; Decline clears it.

- **`POST /api/store/campaign-preview`** (`src/routes/campaigns.ts`) — New public endpoint that returns full campaign data including `computed_status` (`active` | `pending`) and `already_redeemed` flag. Accepts optional SHA-256 hashes of customer phone and email in the POST body (kept out of access logs). Returns 404 for unknown slugs, 422 for inactive campaigns, 410 for ended campaigns.

- **`coupon_hash_redemptions` table** (`src/db/schema.sql`, `src/db/migrate.ts`) — Privacy-preserving per-customer redemption tracking using SHA-256 hashes of normalised phone/email. Schema version bumped to 2.15.0. Columns: `campaign_id`, `identifier_hash`, `identifier_type` (`phone`|`email`), `order_id`, `redeemed_at`.

### Fixed

- **Feedback submission broken — missing `manager_note` column** (`src/db/schema.sql`, `src/routes/store.ts`, `public/store/js/store.js`) — The `feedback` table in `schema.sql` was missing the `manager_note` column that the `INSERT` statement in `store.ts` referenced. This caused SQLite to throw on every feedback submission (the column migration in `migrate.ts` would add it on next server restart, but the schema was never updated). Three-part fix: (1) added `manager_note TEXT` to `schema.sql` so fresh installs have the column immediately; (2) wrapped the INSERT in try/catch so DB errors return a proper 500 JSON response instead of an unhandled exception; (3) `store.js` now shows a "Could not submit feedback" toast when the API call fails, so the customer knows to retry (previously the button silently reset with no feedback).

- **Campaign-preview rate limiter** (`src/routes/campaigns.ts`) — Tightened from 30 requests/60 s to 1 request/s per IP to prevent burst enumeration of hashed phone numbers for `already_redeemed` probing.

- **Per-customer redemption cap** (`src/routes/store.ts`) — `POST /api/store/orders` now checks `coupon_hash_redemptions` (hashed phone + email) in addition to the legacy plaintext `campaign_redemptions` table. On order creation, hash records are written via `INSERT OR IGNORE` for both identifiers. The phone normalisation was also fixed to strip non-digits consistently.

- **Offer preview UX** (`public/store/js/store.js`) — Three UX fixes applied to the QR offer flow:
  - **C2**: Toast "We'll remind you when this offer is active." when customer accepts a pending (not-yet-started) campaign.
  - **C3**: Toast "This promotion has ended." when the server returns HTTP 410; the previous code conflated 404 and 410 with the same handler and no toast on 410.
  - **M1**: Tapping the backdrop now closes the offer preview sheet (neutral dismiss — does not clear the saved campaign, consistent with all other bottom sheets in the PWA).

- **Offer preview accessibility** (`public/store/index.html`) — `#offer-preview-sheet` changed from `aria-label="Offer details"` (static) to `aria-labelledby="offer-preview-title"` (dynamic) so screen readers announce the actual campaign name.

- **Order edit — duplicate item ID accumulation** (`src/routes/dashboard-orders.ts`) — When building the `oldItemQty` map for kitchen-reprint delta computation, items with the same `itemId` were overwriting each other (`.set` on duplicate key). Changed to accumulate quantities: `oldItemQty.set(key, (oldItemQty.get(key) ?? 0) + quantity)`.

---

## [Unreleased] — 2026-04-28

### Fixed

- **`src/services/star-raster.ts` / `src/services/html-receipt.ts`** — Dish names and modifier option names with parenthetical annotations (e.g. "No Fish Sauce (Vegetarian)") now print without the parenthetical on kitchen tickets, counter tickets, and takeout bag receipts. A `stripParens()` helper removes any `(…)` suffix before the text reaches the receiptline/HTML renderer. Customer bill and receipt are unaffected.

- **`tools/marketing-engine/src/scripts/seed-admin.ts`** — Script could hang indefinitely after completing (or on unhandled error) because the open SQLite connection kept Bun's event loop alive. Added `closeDatabase()` in a `finally` block and an explicit `process.exit(0)` at the end. The unexpected-error branch now also calls `closeDatabase()` + `process.exit(1)` instead of re-throwing, which would have left the DB handle open.

---

## [Unreleased] — 2026-04-26

### Fixed

- **Split payment PIN-exit regression** — After leg 1 of a split payment completed, clicking "Next" triggered the server PIN prompt and returned to the orders tab instead of starting leg 2. Root cause: three independent bugs interacted:
  1. **`src/workflows/terminal-payment.ts`** — `INITIATE_PAYMENT` acceptor was not copying `splitMode`/`splitLegNumber`/`splitTotalLegs` from the SAM proposal into the model, so `_lastModel` always saw `null` split fields. As a result, `recordTerminalPayment` always computed `isLastLeg = true` and marked the order `paid` after leg 1, making the `/record-payment` endpoint return 409 on subsequent legs.
  2. **`src/workflows/terminal-payment.ts`** — `recordTerminalPayment` was split-unaware: it always wrote `UPDATE orders SET status='paid'` regardless of leg number. Rewritten to check `isLastLeg = !splitMode || splitLegNumber >= splitTotalLegs`; the order-paid UPDATE and the tip/amount aggregation only run on the final leg. Split columns (`split_mode`, `split_leg_number`, `split_total_legs`) are now populated for each terminal-path payment row.
  3. **`src/routes/dashboard-payments.ts`** — The pre-transaction 409 response (order already paid) returned `{ error, paymentId }` with no `isLastLeg` field. The in-transaction duplicate-insert 409 path had the same omission. Both now include `isLastLeg` computed from the existing `payments` row so the frontend can route correctly.
  4. **`public/js/payment-modal.js`** — The 409 handler hardcoded `_lastLegFromServer = true`, sending every duplicate-payment recovery to `PIN_EXIT`. Now reads `body.isLastLeg` from the server; falls back to `(!_splitMode || _splitCurrentLeg >= _splitTotalLegs)` if absent.
  5. **`public/js/payment-modal.js`** — Terminal-sale `POST` body was missing `splitMode`/`splitTotalLegs`; the server could not propagate split metadata to the FSM model. Body now sends all three split fields.
  6. **`src/routes/dashboard-payments.ts`** — `startTerminalPaymentForDashboard` call was not forwarding `splitMode`/`splitTotalLegs` parsed from the request body; both now passed through to the FSM.

- **`src/routes/dashboard-payments.ts`** — Sales-tax rounding drift on split payments. The final-leg `record-payment` handler now **always preserves** `orders.tax_cents` from the original order (was: only when Σ per-leg `tax_cents = 0`). For `splitMode='by_items'`, per-leg `round(legSubtotal × taxRate)` could sum to ±N¢ off the order's `round(orderSubtotal × taxRate)` — e.g., 3 × $11.10 at 10.4% rounds to 346¢ at the order level but 3 × 115¢ = 345¢ summed across legs. The order's tax was correctly rounded at creation; per-leg `payments.tax_cents` rows are not authoritative for the order. Per-leg rows are unchanged (immutable receipts of what each customer paid). `total_cents` is also recomputed as `subtotal − discount + service_charge + tax + Σ tip + Σ amex_surcharge` (mirrors `dashboard-orders.ts:560-562`) so it stays consistent with the preserved tax for orders with discount/service charge. Spec: `docs/by-items-tax-rounding-fix.md`.

### Added

- **`test/terminal-payment.test.ts`** — Three new tests (describe block "split payment — recordTerminalPayment split awareness"): intermediate leg (leg 1/2) does not mark the order paid and correctly populates `split_*` columns; final leg (leg 2/2) marks the order paid and aggregates totals across both legs; non-split backward-compatibility guard. Also covers the INITIATE_PAYMENT acceptor split-field propagation bug found during implementation.

- **`test/payment-record.test.ts`** — Two new tests guarding the tax-preservation rule: the §3 reproduction case (3 × $11.10, 10.4%, by_items 3-way → `orders.tax_cents = 346`, `Σ payments.tax_cents = 345`) and a single-payment regression guard. `insertOrder` helper extended with `taxCents` parameter.

---

## [Unreleased] — 2026-04-25

### Fixed

- **`src/workflows/terminal-payment.ts`** — Terminal payment lost-charge bug: when the Finix transfer succeeded but the local DB write was skipped (the `recordLocally=false` dashboard path), charges could go unrecorded. Fixed across four discovery paths:
  - **Immediate SUCCEEDED on create** (E.1): `runCreateSale` now calls `recordSucceededTransferAndAdvance` when Finix returns `state='SUCCEEDED'` synchronously on the create response.
  - **422 idempotency collision** (E.2): When Finix returns 422 "transfer already exists" and the existing transfer is SUCCEEDED, the helper writes the DB immediately and dispatches FSM actions rather than leaving the charge unrecorded.
  - **Best-effort cancel — cancel response SUCCEEDED** (E.3): When a best-effort cancel returns `state='SUCCEEDED'`, the helper records the charge immediately. A secondary `getTerminalTransferStatus` fetch enriches amount/card details; details are only used if the re-fetch also confirms SUCCEEDED (guards against stale PENDING responses inflating the amount).
  - **Cancel re-check SUCCEEDED** (E.4): When the post-cancel verification poll finds `state='SUCCEEDED'`, the helper records the charge immediately.
  - New `recordSucceededTransferAndAdvance(transferId, details)` helper: writes DB unconditionally (bypasses `recordLocally=false`), logs reconciliation errors, then dispatches `_transferCreated` + `_tapApproved` FSM actions via `setTimeout` to keep SAM action ordering correct.
- **`src/workflows/terminal-payment.ts`** — Fix A: Starting a new terminal payment flow on an order that already has state `COMPLETED` now returns HTTP 409 immediately ("This order has already been charged") instead of accepting the flow and silently double-charging.
- **`src/workflows/terminal-payment.ts`** — `recordTerminalPayment` idempotent skip now returns the existing `paymentId` (looked up by `order_id + finix_transfer_id`) instead of `null` when the order is already `paid` and the same transfer ID is present. Prevents a second call from broadcasting `paymentId: null` to the frontend.
- **`src/db/migrate.ts`** — `terminal_transactions` table was missing `entry_mode`, `tip_amount_cents`, and `approved_amount_cents` columns on fresh DB installs. These columns were in `columnMigrations` (which runs before `tableMigrations` creates the table) and were silently skipped. Moved all three into the `CREATE TABLE` statement inside the `tableMigration`.
- **`src/db/schema.sql`** — Added `finix_transfer_id TEXT` column to `payments` base schema (was only added via `ALTER TABLE` migration, causing `CREATE UNIQUE INDEX` on that column to fail for fresh installs).
- **`public/js/payment-modal.js`** — Fix B: Terminal initiation endpoint returning 409 is now handled gracefully: the modal shows the error message inline instead of throwing an unhandled exception.

### Changed

- **`src/db/schema.sql`** / **`src/db/migrate.ts`** — Added `UNIQUE INDEX idx_payments_order_transfer_unique ON payments(order_id, finix_transfer_id)` (no WHERE clause — SQLite UNIQUE indexes permit multiple NULLs natively). `recordTerminalPayment` uses `ON CONFLICT (order_id, finix_transfer_id) DO NOTHING` to make duplicate charge rows impossible even under concurrent retries.

---

## [Unreleased] — 2026-04-16

### Added

- **`src/routes/dashboard-orders.ts`** — New `POST /api/merchants/:id/orders/manual` endpoint (owner/manager). Accepts `customerName`, `customerEmail`, `notes`, `subtotalCents`, `discountCents`, `tipCents`, and optional `finixTransferId`. Tax is auto-calculated from the merchant's tax rate. If a `finixTransferId` is provided: updates an existing webhook-created catering stub order in place (reconciliation), creates a fresh order + payment record if no stub exists, or returns 409 if already reconciled.
- **`public/dashboard.html`** / **`public/js/dashboard.js`** / **`public/css/dashboard.css`** — "New Manual Order" button in the orders toolbar opens a modal with Customer Name, Email, Notes, Subtotal, Discount, Tax (auto), Tip, and Finix Transfer ID fields. Total is computed live from tax rate. On save the modal shows a success/error message, refreshes the orders list, and auto-closes.

---

## [Unreleased] — 2026-04-15

### Added

- **`public/js/payment-modal.js`** / **`public/css/payment-modal.css`** — By-items split now shows a dimmed "Already paid" section below the selectable items list. Items covered in previous legs render with a strikethrough and 45% opacity so staff can see at a glance what has already been settled without being able to re-select them.
- **`src/routes/store.ts`** — New public page `GET /terms-of-service-catering` serves catering order terms and conditions (payment due 48 h before pickup, 24 h cancellation window for 50% refund, trays/utensils included). Linked from Finix invoice payment pages via the Terms of Service URL field.

### Changed

- **`public/js/payment-modal.js`** — Removed automatic service charge on split payments. Each leg now opens with tip at $0.00; the server adds a service charge manually using the tip buttons. Single full-bill payments are unaffected.

---

## [Unreleased] — 2026-04-14 (2)

### Fixed

- **`src/services/auto-fire.ts`** — Non-GF (and course-2) delayed kitchen tickets never fired: `fire_at` is stored as ISO 8601 (`2026-04-14T18:50:10.913Z`) but the `WHERE` clause compared it directly against `datetime('now')` (`2026-04-14 20:15:00`). Because `'T' > ' '` lexicographically, the condition was always false regardless of elapsed time. Fixed by wrapping the column in SQLite's `datetime()` function — `datetime(pcf.fire_at) <= datetime('now')` — which normalises both sides to the same format before comparing. Also added `ticket_type` to the `SELECT` (was missing, causing `pcf.ticket_type` to be `undefined` at runtime, so non-GF rows would have fallen through to the `course2Items` path even after the comparison fix).

---

## [Unreleased] — 2026-04-14

### Added

- **`src/routes/oos.ts`** (new) — Out-of-stock ingredient shortcuts API: 12 endpoints covering CRUD for named ingredient buttons (Avocado, Broccoli, Duck…), per-ingredient association of menu items + modifier options, bulk toggle (marks/restores all linked items in one call), and server-accessible stock-patch endpoints (`PATCH /oos/items/:id/stock`, `PATCH /oos/modifiers/:id/stock`) that bypass the owner/manager restriction on the existing menu endpoints.
- **`src/db/schema.sql`** — Three new tables: `oos_ingredients` (named ingredient shortcuts with `is_out` flag), `oos_ingredient_items` (ingredient→menu item links), `oos_ingredient_modifiers` (ingredient→modifier option links). Schema bumped to 2.13.0.
- **`public/js/dashboard.js`** — New "86'd" tab (`section-oos`) accessible to server role: ingredient shortcut card grid with one-tap bulk toggle and ⚙ configure modal (manager/owner), dish search panel, modifier option search panel. Voice event `oos:ingredientToggled` refreshes the tab when triggered from voice commands.
- **`public/js/voice.js`** — Ingredient shortcut matching: before falling through to individual item name matching, `handleTranscripts` now checks `window._voiceOosIngredients` for a name match; if found, calls `_toggleIngredientVoice()` (POST …/toggle) and dispatches `oos:ingredientToggled`. Saying "avocado out" / "avocado back" toggles the entire shortcut in one command.
- **`public/css/dashboard.css`** — Styles for the 86'd tab: ingredient card grid, toggle button states (Available / 86'd), configure modal, dish/modifier list rows, inline add-form.

### Fixed

- **`src/routes/dashboard-orders.ts`** — Kitchen printer printed a header-only blank ticket when all added/reprinted items were counter-only (e.g. beverages). Two unguarded `printKitchenTicket` call sites — the add-items-to-existing-order path and the standalone reprint path — now check `kitchenItems(items).length > 0` before printing. Counter ticket still prints unconditionally.
- **`src/services/printer.ts`** — Kitchen ticket modifier options printed at `SIZE_DBL_H` (double height, single width), making them noticeably smaller than item names. Changed to `SIZE_2X` (double width + double height) so modifiers render at the same physical size as item names on the TSP700II.
- **`public/js/payment-modal.js`** — `CANCELLATION_VIA_API` (terminal timed out waiting for customer tap) was listed as non-retryable, requiring staff to manually tap Retry. Removed from `_NON_RETRYABLE_CODES`; the modal now auto-retries silently. A 3-second delay is added before the retry to let the terminal fully reset. Client-side fetch timeout bumped 45 s → 75 s to give slower customers more time to present their card.

### Changed

- **`public/css/order-entry.css`** — Item modifier modal: width doubled (max-width 520 px → 1040 px); all font sizes increased 30% (item name 1.05 → 1.37 rem, modifier option pills 0.8125 → 1.06 rem, group labels 0.75 → 0.975 rem, etc.); close button, image thumbnail, and option pill padding scaled proportionally.

---

## [Unreleased] — 2026-04-13

### Fixed

- **`src/services/reconcile.ts`** — Orphan terminal sale sweep crashed with `NOT NULL constraint failed: payments.subtotal_cents` on every cycle: the `OrderRow` SQL query selected only `id, status, total_cents`, so `order.subtotal_cents` and `order.tax_cents` were `undefined` at runtime. Bun:sqlite binds `undefined` as NULL, hitting the NOT NULL constraint. Fixed the SELECT to include `subtotal_cents, tax_cents`.
- **`src/services/reconcile.ts`** — Orphan recovery computed tip incorrectly: used `finixAmount − orderSubtotalCents − orderTaxCents` as the pre-tip base, which ignores any service charges or surcharges added before the terminal was activated. `pending_terminal_sales.amount_cents` is the exact pre-tip amount sent to the terminal (subtotal + tax + any surcharges). Fixed tip calculation to `finixAmount − row.amount_cents`, and payment `subtotal_cents` to `row.amount_cents − orderTaxCents` so the payment record is self-consistent (subtotal + tax + tip = amount).
- **`public/js/dashboard.js`** — Orders view summary bar total excluded tax and service charge: formula was `o.totalCents + tip` where `o.totalCents` is the raw DB column (food subtotal only, set at order creation). Fixed to `discSub + svc + tax + tip`, using the same tax recalculation from merchant profile rate already applied to the Tax line.
- **`public/js/dashboard.js`** — Order detail modal showed Tax `$0.00` and Total equal to food subtotal only for locally-created orders: `order.taxCents` is stored as 0 in the DB (tax handled at POS level); the modal was rendering it raw. Now recalculates tax from `state.profile.taxRate` (same logic as the summary bar) and derives Total from components (`discSub + svc + displayTax + tip`).

---

## [Unreleased] — 2026-04-10

### Fixed

- **`src/services/reconcile.ts`** — Orphan terminal sale auto-recovery never committed: `db.transaction(fn)` returns a callable wrapper in bun:sqlite and must be invoked as `db.transaction(fn)()`. The missing `()` meant every sweep logged "auto-recovered" but wrote nothing to the DB.
- **`src/services/reconcile.ts`** — Orphan recovery recorded incorrect subtotal/tax/tip split: was treating the full order `total_cents` as subtotal and hardcoding `tax_cents = 0`. Now reads `subtotal_cents` and `tax_cents` from the order and computes `tip = finixAmount − subtotal − tax`.
- **`src/routes/dashboard-payments.ts`** — 30-second Finix terminal timeout left no orphan row: if `createTerminalSale` timed out, the transfer may have already succeeded on Finix. Now calls `cancelTerminalSale` on timeout to discover the state; if the transfer `SUCCEEDED`, writes a `pending_terminal_sales` row so the background sweep can auto-recover it.
- **`public/js/dashboard.js`** — Orders tab period total excluded tip: `totalCents` was summing `o.totalCents` (subtotal + tax only). Changed to `total + tip` so the Total line reflects actual money collected.
- **`public/js/payment-modal.js`** — Cancelling a counter (Android app) payment from the dashboard did not reset the tablet: the PIN-exit close path stopped the poll timer locally but never called `POST /counter/cancel-payment`. Now fires the cancel request before cleanup so the Android app receives `cancel_payment` and returns to idle.

---

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
