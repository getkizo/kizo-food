/**
 * Finix payment adapter
 *
 * Two payment flows:
 *   1. Checkout Pages — hosted payment URL for online orders (redirect flow)
 *   2. Terminal Sales  — push payment to a PAX terminal for in-person orders
 *
 * Docs:
 *   - Checkout Pages: https://docs.finix.com/low-code-no-code/pre-built-checkout-page/checkout-pages
 *   - POS Integration: https://docs.finix.com/guides/in-person-payments/building-your-integration/pos-integration
 */

/**
 * Thrown when Finix returns 422 for a duplicate idempotency key whose
 * original transfer was cancelled (CANCELLATION_VIA_DEVICE or CANCELLATION_VIA_API).
 * The caller should retry with a fresh idempotency key.
 */
export class FinixTransferCancelledError extends Error {
  constructor(
    public readonly existingTransferId: string,
    public readonly failureCode: string,
    message: string,
  ) {
    super(message)
    this.name = 'FinixTransferCancelledError'
  }
}

export interface FinixCredentials {
  /** API username — e.g. "USsRhsHYZGBPnQw8CByJyEQW" */
  apiUsername: string
  /** Application ID — e.g. "APgPDQrLD52TYvqazjHJJchM" */
  applicationId: string
  /** Merchant ID — e.g. "MUeDVrf2ahuKc9Eg5TeZugvs" */
  merchantId: string
  /** API password (UUID) — secret, never exposed to the browser */
  apiPassword: string
  /** true = sandbox/test environment, false = production */
  sandbox?: boolean
}

export interface CheckoutFormParams {
  /** Amount in cents (e.g. 1250 = $12.50) */
  amountCents: number
  /** Customer first name */
  customerFirstName?: string
  /** Customer last name */
  customerLastName?: string
  /** Checkout form nickname (shown as title on payment page) */
  nickname?: string
  /** Item description shown on the checkout page */
  description?: string
  /** URL Finix redirects to after a successful payment */
  returnUrl: string
  /** URL Finix redirects to when the buyer clicks "back to cart" */
  cartReturnUrl?: string
  /** URL to your terms of service page (required by Finix) */
  termsOfServiceUrl: string
  /** Absolute URL for the merchant logo (200×60 recommended). Required by Finix. */
  logoUrl?: string
  /** Absolute URL for the merchant icon (64×64 recommended). Required by Finix. */
  iconUrl?: string
  /** How long until form expires in minutes — default 30 (max 3 weeks = 30240) */
  expirationMinutes?: number
  /** Image URL for the first item (shown on checkout page) */
  itemImageUrl?: string
  /**
   * Client-generated fraud session ID from the Finix fraud detection SDK.
   * Passed as `fraud_session_id` in the checkout form body.
   */
  fraudSessionId?: string
  /**
   * Idempotency key for this request (UUID).  Passed as `idempotency_id` in the body.
   * Using the orderId ensures that retrying the same order returns the same form.
   * Defaults to a fresh UUID if not supplied.
   */
  idempotencyId?: string
  /**
   * Key-value tags attached to the checkout form.
   * Finix propagates these tags to the resulting Transfer, enabling order-level
   * traceability in the Finix dashboard even when transfer.idempotency_id is null.
   */
  tags?: Record<string, string>
}

export interface CheckoutFormResult {
  /** The Finix Checkout Form ID */
  checkoutFormId: string
  /** The hosted payment page URL to redirect the user to */
  linkUrl: string
}

const SANDBOX_BASE = 'https://finix.sandbox-payments-api.com'
const LIVE_BASE    = 'https://finix.live-payments-api.com'

/**
 * When FINIX_EMULATOR_URL is set (e.g. "http://localhost:9333"), all API
 * requests are routed to the local Finix emulator instead of the real API.
 * Used for development and demos when no sandbox credentials are available.
 *
 * Read lazily (at call time) so that tests can temporarily set/unset the
 * env var without being affected by the module-level snapshot.
 */
function resolveBase(creds: FinixCredentials): string {
  const emulatorBase = process.env.FINIX_EMULATOR_URL?.replace(/\/$/, '') ?? null
  if (emulatorBase) return emulatorBase
  return creds.sandbox ? SANDBOX_BASE : LIVE_BASE
}

/**
 * Shared POST helper — Basic auth.
 * Pass apiVersion to include the Finix-Version header (older endpoints require it;
 * newer endpoints like /checkout_forms do not accept it).
 * Throws on non-2xx responses with the Finix error message.
 */
async function finixPost(
  creds: FinixCredentials,
  path: string,
  body: Record<string, unknown>,
  apiVersion?: string,
): Promise<Record<string, unknown>> {
  const base = resolveBase(creds)
  const auth = btoa(`${creds.apiUsername}:${creds.apiPassword}`)

  const headers: Record<string, string> = {
    'Authorization': `Basic ${auth}`,
    'Content-Type':  'application/json',
  }
  if (apiVersion) headers['Finix-Version'] = apiVersion

  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  return parseFinixResponse(response, path)
}

/**
 * Shared GET helper — Basic auth.
 */
async function finixGet(
  creds: FinixCredentials,
  path: string,
  apiVersion?: string,
): Promise<Record<string, unknown>> {
  const base = resolveBase(creds)
  const auth = btoa(`${creds.apiUsername}:${creds.apiPassword}`)

  const headers: Record<string, string> = { 'Authorization': `Basic ${auth}` }
  if (apiVersion) headers['Finix-Version'] = apiVersion

  const response = await fetch(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) })

  return parseFinixResponse(response, path)
}

/**
 * Shared PUT helper — Basic auth.
 */
async function finixPut(
  creds: FinixCredentials,
  path: string,
  body: Record<string, unknown>,
  apiVersion?: string,
): Promise<Record<string, unknown>> {
  const base = resolveBase(creds)
  const auth = btoa(`${creds.apiUsername}:${creds.apiPassword}`)

  const headers: Record<string, string> = {
    'Authorization': `Basic ${auth}`,
    'Content-Type':  'application/json',
  }
  if (apiVersion) headers['Finix-Version'] = apiVersion

  const response = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers,
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  return parseFinixResponse(response, path)
}

/** API version required by device/transfer endpoints */
const FINIX_VERSION = '2022-02-01'

/**
 * Parses a Finix API response. Logs and throws on non-2xx.
 */
async function parseFinixResponse(
  response: Response,
  path: string,
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {}
  try {
    data = await response.json() as Record<string, unknown>
  } catch {
    // Response body was not JSON (e.g. empty 401/503)
  }

  if (!response.ok) {
    // Log full body so API rejections can be diagnosed from server logs
    console.error(`[finix] ${response.status} ${path}:`, JSON.stringify(data))

    const errors = (data?._embedded as Record<string, unknown>)?.errors
    const firstErr = Array.isArray(errors) && errors.length > 0
      ? errors[0] as Record<string, unknown>
      : null

    // 422 duplicate idempotency key — the original transfer is in a terminal
    // FAILED state (device cancel, bad read, technical error, etc.).
    // Finix won't reuse a failed idempotency key; throw a typed error so the
    // caller can retry with a fresh key regardless of failure_code.
    const failureCode       = firstErr?.failure_code as string | undefined
    const existingTransfer  = firstErr?.transfer     as string | undefined
    if (response.status === 422 && existingTransfer) {
      throw new FinixTransferCancelledError(
        existingTransfer,
        failureCode ?? 'UNKNOWN',
        `Finix API error (${response.status}): ${(firstErr?.message as string | undefined) ?? 'Unknown error'}`,
      )
    }

    const msg =
      (firstErr?.message as string | undefined) ??
      (firstErr?.code    as string | undefined) ??
      (data?.message     as string | undefined) ??
      (data?.code        as string | undefined)
    throw new Error(`Finix API error (${response.status}): ${msg ?? 'Unknown error'}`)
  }

  return data
}

/**
 * Creates a Finix Checkout Form (hosted payment page).
 *
 * POST /checkout_forms → returns a link_url for the hosted page.
 *
 * @param creds  - Finix credentials (password server-side only)
 * @param params - Amount, return URL, customer info
 * @returns      - Checkout form ID and the redirect URL
 */
export async function createCheckoutForm(
  creds: FinixCredentials,
  params: CheckoutFormParams,
): Promise<CheckoutFormResult> {
  const data = await finixPost(creds, '/checkout_forms', {
    ...(params.fraudSessionId ? { fraud_session_id: params.fraudSessionId } : {}),
    idempotency_id:           params.idempotencyId ?? crypto.randomUUID(),
    merchant_id:              creds.merchantId,
    tags:                     params.tags ?? {},
    payment_frequency:        'ONE_TIME',
    allowed_payment_methods:  ['PAYMENT_CARD'],
    nickname:                 params.nickname ?? 'Order Payment',
    // Omitting `items` intentionally: sending an items array causes Finix to
    // render a collapsible "Order Summary" accordion, hiding the total until
    // the customer taps to expand it. Without items, Finix displays the total
    // amount prominently above the payment fields with no accordion.
    ...(params.customerFirstName || params.customerLastName
      ? {
          buyer_details: {
            first_name: params.customerFirstName ?? null,
            last_name:  params.customerLastName  ?? null,
          },
        }
      : {}),
    amount_details: {
      amount_type:   'FIXED',
      total_amount:  params.amountCents,
      currency:      'USD',
    },
    branding: {
      brand_color:  '#1a1a2e',  // Kizo dark navy (header background)
      accent_color: '#e85d04',  // Kizo orange (buttons / CTAs)
      logo: params.logoUrl ?? 'https://placehold.co/200x60/1a1a2e/e85d04?text=Kizo',
      icon: params.iconUrl ?? 'https://placehold.co/64x64/1a1a2e/e85d04?text=B',
    },
    additional_details: {
      success_return_url:      params.returnUrl,
      cart_return_url:         params.cartReturnUrl ?? params.returnUrl,
      terms_of_service_url:    params.termsOfServiceUrl,
      expiration_in_minutes:   params.expirationMinutes ?? 30,
      collect_name:            false,
      collect_email:           false,
      collect_phone_number:    false,
      collect_billing_address: false,
      collect_shipping_address: false,
    },
  })

  // Finix Checkout Pages returns link_url as a top-level field.
  // Fall back to _links.redirect.href for forward-compatibility.
  const linkUrl =
    (data.link_url as string | undefined) ??
    ((data._links as Record<string, unknown>)?.redirect as Record<string, unknown>)?.href as string | undefined

  if (!linkUrl) {
    console.error('[finix] checkout_forms response (no link_url):', JSON.stringify(data))
    throw new Error('Finix Checkout Form created but no redirect link returned')
  }

  return {
    checkoutFormId: data.id as string,
    linkUrl,
  }
}

/**
 * Fetches the status of a Finix Checkout Form to determine payment outcome.
 *
 * @param creds          - Finix credentials
 * @param checkoutFormId - The checkout form ID to query
 * @returns              - The checkout form data including payment_frequency_state
 */
export async function getCheckoutFormStatus(
  creds: FinixCredentials,
  checkoutFormId: string,
): Promise<Record<string, unknown>> {
  return finixGet(creds, `/checkout_forms/${checkoutFormId}`)
}

/**
 * Queries a Finix Checkout Form to determine payment outcome and transfer ID.
 *
 * Strategy (in order):
 *   1. Check `_embedded.transfers` (older API versions embed them)
 *   2. Follow `_links.transfers.href` sub-resource (HAL pattern)
 *   3. If state is COMPLETED but no transfer found, still report success —
 *      the payment went through on Finix's side; the transfer ID can be
 *      resolved later (e.g. at refund time) via the Finix dashboard or API.
 *
 * @param creds          - Finix credentials
 * @param checkoutFormId - The checkout form ID saved when /pay was called
 * @returns              - { state, transferId } — transferId may be null even if COMPLETED
 */
export async function getTransferIdFromCheckoutForm(
  creds: FinixCredentials,
  checkoutFormId: string,
): Promise<{ state: string; transferId: string | null }> {
  const data = await finixGet(creds, `/checkout_forms/${checkoutFormId}`)

  const state        = (data.state as string) ?? 'UNKNOWN'
  const embedded     = data._embedded as Record<string, unknown> | undefined
  const embeddedKeys = embedded ? Object.keys(embedded) : []
  const transfers    = embedded?.transfers as Array<Record<string, unknown>> | undefined
  const links        = data._links as Record<string, unknown> | undefined
  const linkKeys     = links ? Object.keys(links) : []

  console.log(
    `[finix] checkout_form ${checkoutFormId}: state=${state}` +
    ` top_keys=[${Object.keys(data).join(',')}]` +
    ` _embedded=[${embeddedKeys.join(',')}]` +
    ` _links=[${linkKeys.join(',')}]` +
    ` transfers=${transfers?.length ?? 0}` +
    (transfers?.length ? ` first_id=${transfers[0].id} first_state=${transfers[0].state}` : '')
  )

  // Strategy 1: _embedded.transfers (legacy / some API versions)
  let transferId = (transfers?.[0]?.id as string | undefined) ?? null

  // Strategy 2: follow _links.transfers HAL sub-resource
  if (!transferId) {
    const transfersHref = (links?.transfers as Record<string, unknown>)?.href as string | undefined
    if (transfersHref) {
      try {
        const pathname = new URL(transfersHref).pathname
        const subData  = await finixGet(creds, pathname)
        const subEmbedded  = subData._embedded as Record<string, unknown> | undefined
        const subTransfers = subEmbedded?.transfers as Array<Record<string, unknown>> | undefined
        if (subTransfers?.length) {
          transferId = subTransfers[0].id as string
          console.log(`[finix] Resolved transfer via _links.transfers: ${transferId}`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[finix] _links.transfers fetch failed: ${msg}`)
      }
    }
  }

  return { state, transferId }
}

/**
 * Fetches a Finix Transfer's current state and amount.
 *
 * Used as a preflight before issuing a reversal — Finix only allows reversals
 * on SUCCEEDED transfers. PENDING transfers (common in sandbox) will be rejected.
 *
 * @param creds      - Finix credentials
 * @param transferId - The transfer to inspect (e.g. "tra_abc123")
 * @returns          - Transfer state, amount in cents, and type
 */
export async function getTransfer(
  creds: FinixCredentials,
  transferId: string,
): Promise<{ id: string; state: string; amount: number; type: string }> {
  const data = await finixGet(creds, `/transfers/${transferId}`, FINIX_VERSION)
  return {
    id:     data.id     as string,
    state:  data.state  as string,
    amount: data.amount as number,
    type:   data.type   as string,
  }
}

/**
 * Issues a refund (reversal) against a Finix Transfer.
 *
 * POST /transfers/:transferId/reversals
 *
 * @param creds        - Finix credentials
 * @param transferId   - The transfer to reverse (e.g. "tra_abc123")
 * @param amountCents  - Amount to refund in cents; omit for full refund
 * @returns            - The reversal Transfer ID (e.g. "tra_xyz789")
 */
export async function createRefund(
  creds: FinixCredentials,
  transferId: string,
  amountCents?: number,
  idempotencyId?: string,
): Promise<string> {
  const body: Record<string, unknown> = { idempotency_id: idempotencyId ?? crypto.randomUUID(), tags: {} }
  if (amountCents !== undefined) {
    body.refund_amount = amountCents
  }
  const data = await finixPost(creds, `/transfers/${transferId}/reversals`, body, FINIX_VERSION)
  return data.id as string
}

// ---------------------------------------------------------------------------
// Transfer listing (reconciliation)
// ---------------------------------------------------------------------------

export interface FinixTransfer {
  id: string
  state: string
  /** Amount in cents */
  amount: number
  currency: string
  /** ISO 8601 creation timestamp from Finix */
  createdAt: string
  /** Card brand (e.g. "VISA") — may be absent */
  cardBrand?: string
  /** Last 4 digits of card — may be absent */
  cardLast4?: string
}

/**
 * Lists Finix Transfers for reconciliation.
 *
 * Fetches transfers created within an optional time window.  Handles
 * HAL pagination: follows `_links.next` until all pages are collected or
 * `limit` is satisfied.  Returns at most `opts.limit` records (default 200).
 *
 * @param creds   - Finix credentials
 * @param opts    - `fromIso`: lower-bound ISO 8601 datetime (inclusive)
 *                  `toIso`:   upper-bound ISO 8601 datetime (inclusive, optional)
 *                  `limit`:   max total records to return (default 200)
 */
export async function listTransfers(
  creds: FinixCredentials,
  opts: { fromIso: string; toIso?: string; limit?: number },
): Promise<FinixTransfer[]> {
  const max = opts.limit ?? 200
  const results: FinixTransfer[] = []

  // Finix requires date format YYYY-MM-DDTHH:MM:SS (no ms, no Z)
  const stripIso = (s: string) => s.replace(/\.\d{3}Z$/, '').replace(/Z$/, '')

  // Build initial query string
  const params = new URLSearchParams({
    'created_at.gte': stripIso(opts.fromIso),
    'merchant_id':    creds.merchantId,
    'limit':          String(Math.min(max, 100)),
  })
  if (opts.toIso) params.set('created_at.lte', stripIso(opts.toIso))

  let path: string | null = `/transfers?${params.toString()}`

  while (path && results.length < max) {
    const data = await finixGet(creds, path)

    const embedded  = data._embedded as Record<string, unknown> | undefined
    const transfers = (embedded?.transfers ?? []) as Array<Record<string, unknown>>

    for (const t of transfers) {
      if (results.length >= max) break
      const instrument = t.instrument_type_info as Record<string, unknown> | undefined
      results.push({
        id:        t.id as string,
        state:     t.state as string,
        amount:    t.amount as number,
        currency:  (t.currency as string) ?? 'USD',
        createdAt: (t.created_at as string) ?? '',
        cardBrand: instrument?.brand      as string | undefined,
        cardLast4: instrument?.last_four  as string | undefined,
      })
    }

    // Follow HAL next link for pagination
    const links    = data._links as Record<string, unknown> | undefined
    const nextHref = (links?.next as Record<string, unknown> | undefined)?.href as string | undefined
    if (nextHref && results.length < max) {
      path = new URL(nextHref).pathname + new URL(nextHref).search
    } else {
      path = null
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// In-person terminal payments (POS)
// ---------------------------------------------------------------------------

export interface FinixDevice {
  id: string
  serialNumber: string | null
  model: string
  enabled: boolean
  connection?: string
}

/**
 * Lists devices registered under the merchant's Finix account.
 * Used to auto-discover the Finix device ID from a terminal's serial number.
 */
export async function listDevices(
  creds: FinixCredentials,
): Promise<FinixDevice[]> {
  const data = await finixGet(
    creds,
    `/merchants/${creds.merchantId}/devices`,
    FINIX_VERSION,
  )
  const embedded = data._embedded as Record<string, unknown> | undefined
  const devices  = (embedded?.devices ?? []) as Array<Record<string, unknown>>
  return devices.map(d => ({
    id:           d.id as string,
    serialNumber: (d.serial_number as string | undefined) ?? null,
    model:        (d.model as string) ?? '',
    enabled:      (d.enabled as boolean) ?? false,
  }))
}

/**
 * Checks if a device is connected and ready to process payments.
 *
 * @returns connection "Open" = ready, anything else = not reachable
 */
export async function checkDeviceConnection(
  creds: FinixCredentials,
  deviceId: string,
): Promise<{ connection: string; enabled: boolean }> {
  const data = await finixGet(
    creds,
    `/devices/${deviceId}?include_connection=true`,
    FINIX_VERSION,
  )
  return {
    connection: (data.connection as string) ?? 'unknown',
    enabled:    (data.enabled as boolean) ?? false,
  }
}

export interface TerminalSaleResult {
  transferId: string
  state: string
}

/**
 * Creates a sale on a physical PAX terminal via Finix's POS API.
 *
 * POST /transfers with device ID — pushes the payment prompt to the terminal.
 * Returns immediately with the transfer ID; poll getTransfer() for completion.
 */
export async function createTerminalSale(
  creds: FinixCredentials,
  deviceId: string,
  amountCents: number,
  tags?: Record<string, string>,
  idempotencyId?: string,
): Promise<TerminalSaleResult> {
  const idem = idempotencyId ?? crypto.randomUUID()
  const t0   = Date.now()
  try {
    const data = await finixPost(creds, '/transfers', {
      amount:           amountCents,
      currency:         'USD',
      device:           deviceId,
      operation_key:    'CARD_PRESENT_DEBIT',
      idempotency_id:   idem,
      tags:             tags ?? {},
    }, FINIX_VERSION)
    const transferId = data.id as string
    const state      = (data.state as string) ?? 'PENDING'
    console.log(JSON.stringify({ ts: new Date().toISOString(), label: '[finix-api]', method: 'POST', path: '/transfers', durationMs: Date.now() - t0, transferId, state, amountCents, deviceId, orderId: tags?.order_id ?? null }))
    return { transferId, state }
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), label: '[finix-api]', method: 'POST', path: '/transfers', durationMs: Date.now() - t0, error: (err as Error).message, amountCents, deviceId, orderId: tags?.order_id ?? null }))
    throw err
  }
}

/**
 * Fetches a terminal transfer's status with card-present details.
 * Returns enriched data including card brand, last 4, approval code, and
 * tip amount (populated once the customer has selected a tip on the terminal).
 */
export async function getTerminalTransferStatus(
  creds: FinixCredentials,
  transferId: string,
): Promise<{
  state: string
  amount: number
  tipAmountCents: number
  cardBrand: string | null
  cardLastFour: string | null
  approvalCode: string | null
  entryMode: string | null
  failureCode: string | null
  failureMessage: string | null
}> {
  const t0   = Date.now()
  const data = await finixGet(creds, `/transfers/${transferId}`, FINIX_VERSION)
  const cpd  = data.card_present_details as Record<string, unknown> | undefined
  const ab   = data.amount_breakdown as Record<string, unknown> | undefined
  const result = {
    state:          (data.state as string) ?? 'UNKNOWN',
    amount:         (data.amount as number) ?? 0,
    tipAmountCents: (ab?.tip_amount as number | undefined) ?? 0,
    cardBrand:      (cpd?.brand as string | undefined) ?? null,
    cardLastFour:   (cpd?.masked_account_number as string | undefined)?.slice(-4) ?? null,
    approvalCode:   (cpd?.approval_code as string | undefined) ?? null,
    entryMode:      (cpd?.entry_mode as string | undefined) ?? null,
    failureCode:    (data.failure_code as string | undefined) ?? null,
    failureMessage: (data.failure_message as string | undefined) ?? null,
  }
  // Only log non-PENDING states to keep poll noise low; PENDING is the normal waiting state
  if (result.state !== 'PENDING') {
    console.log(JSON.stringify({ ts: new Date().toISOString(), label: '[finix-api]', method: 'GET', path: `/transfers/${transferId}`, durationMs: Date.now() - t0, transferId, state: result.state, failureCode: result.failureCode ?? undefined }))
  }
  return result
}

/**
 * Updates the tipping configuration for a Finix device.
 *
 * PUT /devices/:deviceId — sets or clears `configuration.tipping_details`.
 *
 * When enabled, the PAX terminal will prompt the customer to select a tip
 * from the provided percentage options before requesting card tap.
 * When disabled, `tipping_details` is cleared and no tip prompt appears.
 *
 * @param creds          - Finix credentials
 * @param deviceId       - Finix device ID (DEV_...)
 * @param enabled        - true to enable tip prompt, false to disable
 * @param percentOptions - Tip percentage options shown on device (default [15, 20, 25])
 */
export async function updateDeviceTippingConfig(
  creds: FinixCredentials,
  deviceId: string,
  enabled: boolean,
  percentOptions: number[] = [15, 20, 25],
): Promise<void> {
  const body = enabled
    ? {
        configuration: {
          tipping_details: {
            percent_options:            percentOptions,
            percent_tipping_threshold:  1,   // minimum purchase amount (cents) to show tip prompt
          },
        },
      }
    : {
        configuration: {
          tipping_details: null,
        },
      }
  await finixPut(creds, `/devices/${deviceId}`, body, FINIX_VERSION)
  console.log(JSON.stringify({
    ts: new Date().toISOString(), label: '[finix-api]', method: 'PUT',
    path: `/devices/${deviceId}`, enabled, percentOptions: enabled ? percentOptions : null,
  }))
}

// ---------------------------------------------------------------------------
// Card-not-present (phone / MOTO) payments via tokenization
// ---------------------------------------------------------------------------

/**
 * Creates a buyer Identity in Finix for phone/MOTO transactions.
 *
 * POST /identities { entity: { first_name, last_name } }
 *
 * Finix requires a buyer identity when creating a PaymentInstrument from a token.
 *
 * @param creds         - Finix credentials
 * @param customerName  - Customer name (split into first/last)
 * @returns             - Identity ID (ID_...)
 */
async function createBuyerIdentity(
  creds: FinixCredentials,
  customerName?: string,
): Promise<string> {
  const parts = (customerName ?? 'Phone Customer').trim().split(/\s+/)
  const firstName = parts[0] || 'Phone'
  const lastName  = parts.length > 1 ? parts.slice(1).join(' ') : 'Customer'
  const data = await finixPost(creds, '/identities', {
    entity: { first_name: firstName, last_name: lastName },
  }, FINIX_VERSION)
  return data.id as string
}

/**
 * Creates a Finix PaymentInstrument from a one-time tokenization token.
 *
 * POST /payment_instruments { type: 'TOKEN', token, identity }
 *
 * The token is produced by the Finix.js hosted-fields form in the browser.
 * Raw card details never touch Kizo servers — only the opaque token.
 * A buyer identity is created automatically if not provided.
 *
 * @param creds        - Finix credentials (server-side only)
 * @param token        - One-time token from Finix.js
 * @param postalCode   - Optional zip code for AVS postal match (lowers interchange)
 * @param customerName - Optional customer name for the buyer identity
 * @returns            - PaymentInstrument ID (PI_...)
 */
export async function createPaymentInstrumentFromToken(
  creds: FinixCredentials,
  token: string,
  postalCode?: string,
  customerName?: string,
): Promise<string> {
  const identityId = await createBuyerIdentity(creds, customerName)
  const body: Record<string, unknown> = { type: 'TOKEN', token, identity: identityId }
  if (postalCode) body.address = { postal_code: postalCode }
  const data = await finixPost(creds, '/payment_instruments', body, FINIX_VERSION)
  return data.id as string
}

/**
 * Creates a card-not-present Transfer from a PaymentInstrument.
 *
 * POST /transfers { source: PI_id, merchant: MU_id, amount, currency: 'USD' }
 *
 * Used for phone/MOTO orders where card details were entered via the
 * tokenization form.  Returns immediately with the transfer state.
 *
 * @param creds               - Finix credentials
 * @param paymentInstrumentId - PI_... from createPaymentInstrumentFromToken
 * @param amountCents         - Total amount to charge in cents
 * @param tags                - Optional key-value tags (order_id, merchant_id)
 */
export async function createCNPTransfer(
  creds: FinixCredentials,
  paymentInstrumentId: string,
  amountCents: number,
  tags?: Record<string, string>,
  idempotencyId?: string,
): Promise<{
  transferId: string
  state: string
  cardBrand: string | null
  cardLastFour: string | null
  approvalCode: string | null
}> {
  const data = await finixPost(creds, '/transfers', {
    source:         paymentInstrumentId,
    merchant:       creds.merchantId,
    amount:         amountCents,
    currency:       'USD',
    idempotency_id: idempotencyId ?? crypto.randomUUID(),
    tags:           tags ?? {},
  }, FINIX_VERSION)

  const instrument = data.instrument_type_info as Record<string, unknown> | undefined
  return {
    transferId:   data.id as string,
    state:        (data.state as string) ?? 'UNKNOWN',
    cardBrand:    (instrument?.brand as string | undefined) ?? null,
    cardLastFour: (instrument?.masked_account_number as string | undefined)?.slice(-4) ?? null,
    approvalCode: (data.approval_code as string | undefined) ?? null,
  }
}

/**
 * Cancels an in-progress terminal transaction.
 *
 * PUT /devices/:id with action=CANCEL — tells the terminal to abort and return
 * to the idle screen. Returns the Transfer object so the caller can detect the
 * race where the customer tapped just before the cancel reached the device.
 *
 * Normal outcome:  state=FAILED,    failure_code=CANCELLATION_VIA_API
 * Tap-beat-cancel: state=SUCCEEDED  (payment went through — caller must honour it)
 */
export async function cancelTerminalSale(
  creds: FinixCredentials,
  deviceId: string,
): Promise<{
  transferId:   string | null
  state:        string
  amount:       number
  cardBrand:    string | null
  cardLastFour: string | null
  approvalCode: string | null
  failureCode:  string | null
}> {
  const t0   = Date.now()
  try {
    const data = await finixPut(creds, `/devices/${deviceId}`, { action: 'CANCEL' }, FINIX_VERSION)
    const cpd  = data.card_present_details as Record<string, unknown> | undefined
    const result = {
      transferId:   (data.id as string | undefined) ?? null,
      state:        (data.state as string) ?? 'UNKNOWN',
      amount:       (data.amount as number) ?? 0,
      cardBrand:    (cpd?.brand as string | undefined) ?? null,
      cardLastFour: (cpd?.masked_account_number as string | undefined)?.slice(-4) ?? null,
      approvalCode: (cpd?.approval_code as string | undefined) ?? null,
      failureCode:  (data.failure_code as string | undefined) ?? null,
    }
    console.log(JSON.stringify({ ts: new Date().toISOString(), label: '[finix-api]', method: 'PUT', path: `/devices/${deviceId}`, durationMs: Date.now() - t0, transferId: result.transferId, state: result.state, failureCode: result.failureCode ?? undefined }))
    return result
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), label: '[finix-api]', method: 'PUT', path: `/devices/${deviceId}`, durationMs: Date.now() - t0, error: (err as Error).message }))
    throw err
  }
}
