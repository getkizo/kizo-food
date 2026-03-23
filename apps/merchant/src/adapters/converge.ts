/**
 * Converge (Elavon) Hosted Payment Page adapter
 *
 * Generates session tokens for the Converge Hosted Payment Page flow.
 * Token generation happens server-side (PIN is secret); the client only
 * receives the resulting hosted-payments URL to open in a tab.
 *
 * Docs: https://developer.elavon.com/
 * IP whitelist: https://www.convergepay.com/hosted-payments/myip
 */

export interface ConvergeCredentials {
  /** ssl_merchant_id — e.g. "0022458" */
  sslMerchantId: string
  /** ssl_user_id — e.g. "apiuser" */
  sslUserId: string
  /** ssl_pin — the secret, never exposed to the browser */
  sslPin: string
  /** true = demo environment, false = production */
  sandbox?: boolean
}

const DEMO_TOKEN_URL  = 'https://api.demo.convergepay.com/hosted-payments/transaction_token'
const PROD_TOKEN_URL  = 'https://api.convergepay.com/hosted-payments/transaction_token'
const DEMO_HOSTED_URL = 'https://api.demo.convergepay.com/hosted-payments'
const PROD_HOSTED_URL = 'https://api.convergepay.com/hosted-payments'
const DEMO_API_URL    = 'https://api.demo.convergepay.com/VirtualMerchantDemo/processxml.do'
const PROD_API_URL    = 'https://api.convergepay.com/VirtualMerchant/processxml.do'

/**
 * Requests a Converge transaction token and returns the full hosted-payments URL.
 *
 * @param creds       - Converge credentials (PIN is secret — server-side only)
 * @param amountDollars - Amount formatted as "12.50"
 * @param returnUrl   - Where Converge redirects after payment (our return page)
 * @param description - Optional memo shown on the payment page (truncated to 255 chars)
 * @returns Full URL to open in the browser: https://api.convergepay.com/hosted-payments?ssl_txn_auth_token=TOKEN
 */
export async function getConvergePaymentUrl(
  creds: ConvergeCredentials,
  amountDollars: string,
  returnUrl: string,
  description?: string
): Promise<string> {
  const tokenUrl  = creds.sandbox ? DEMO_TOKEN_URL  : PROD_TOKEN_URL
  const hostedUrl = creds.sandbox ? DEMO_HOSTED_URL : PROD_HOSTED_URL

  const params = new URLSearchParams({
    ssl_merchant_id:      creds.sslMerchantId,
    ssl_user_id:          creds.sslUserId,
    ssl_pin:              creds.sslPin,
    ssl_transaction_type: 'CCSALE',
    ssl_amount:           amountDollars,
    ssl_return_url:       returnUrl,
    ssl_show_form:        'true',
  })

  if (description) {
    params.set('ssl_description', description.substring(0, 255))
  }

  const response = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
    signal:  AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Converge token request failed: HTTP ${response.status}`)
  }

  const token = (await response.text()).trim()

  if (!token || token.startsWith('ERROR') || token.startsWith('error')) {
    throw new Error(`Converge returned error: ${token}`)
  }

  return `${hostedUrl}?ssl_txn_auth_token=${encodeURIComponent(token)}`
}

export interface ConvergeVerificationResult {
  /** Whether the transaction was approved */
  approved: boolean
  /** Amount in dollars as a string (e.g. "12.50") */
  amountDollars: string | null
  /** Converge transaction ID */
  txnId: string | null
  /** Raw response for logging on failure */
  raw: string
}

/**
 * Verifies a Converge transaction server-to-server using the `txnquery` API.
 *
 * After a customer pays on the Hosted Payment Page, Converge redirects back with
 * ssl_txn_id. This function calls Converge's direct API to confirm the transaction
 * is real and approved — never trust client-provided ssl_result.
 *
 * @param creds    - Converge credentials (same as used for payment)
 * @param txnId    - ssl_txn_id from the Converge redirect
 * @returns        - Verification result with approved flag and verified amount
 */
export async function verifyConvergeTransaction(
  creds: ConvergeCredentials,
  txnId: string,
): Promise<ConvergeVerificationResult> {
  const apiUrl = creds.sandbox ? DEMO_API_URL : PROD_API_URL

  const xmlData = [
    '<txn>',
    `<ssl_merchant_id>${escapeXml(creds.sslMerchantId)}</ssl_merchant_id>`,
    `<ssl_user_id>${escapeXml(creds.sslUserId)}</ssl_user_id>`,
    `<ssl_pin>${escapeXml(creds.sslPin)}</ssl_pin>`,
    '<ssl_transaction_type>txnquery</ssl_transaction_type>',
    `<ssl_txn_id>${escapeXml(txnId)}</ssl_txn_id>`,
    '</txn>',
  ].join('')

  const response = await fetch(apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `xmldata=${encodeURIComponent(xmlData)}`,
    signal:  AbortSignal.timeout(30_000),
  })

  const raw = await response.text()

  if (!response.ok) {
    console.error(`[converge] txnquery HTTP ${response.status}:`, raw)
    throw new Error(`Converge verification failed: HTTP ${response.status}`)
  }

  // Parse key fields from XML response (simple regex — no full XML parser needed)
  const result    = extractXmlTag(raw, 'ssl_result')
  const amount    = extractXmlTag(raw, 'ssl_amount')
  const verTxnId  = extractXmlTag(raw, 'ssl_txn_id')

  return {
    approved:      result === '0',
    amountDollars: amount,
    txnId:         verTxnId,
    raw,
  }
}

export interface ConvergeRefundResult {
  /** Whether the return was approved */
  approved: boolean
  /** Converge transaction ID for this refund record */
  refundTxnId: string | null
  /** Raw XML response for logging on failure */
  raw: string
}

/**
 * Issues a refund (CCRETURN) against a Converge transaction.
 *
 * Uses Converge's direct XML API with `ssl_transaction_type=CCRETURN`.
 * The original `ssl_txn_id` is required; `amountDollars` may be a partial amount.
 *
 * @param creds          - Converge credentials (same as used for the original payment)
 * @param txnId          - ssl_txn_id of the original sale transaction
 * @param amountDollars  - Amount to refund formatted as "12.50"
 * @returns              - Approval status and the new refund transaction ID
 */
export async function createConvergeRefund(
  creds: ConvergeCredentials,
  txnId: string,
  amountDollars: string,
): Promise<ConvergeRefundResult> {
  const apiUrl = creds.sandbox ? DEMO_API_URL : PROD_API_URL

  const xmlData = [
    '<txn>',
    `<ssl_merchant_id>${escapeXml(creds.sslMerchantId)}</ssl_merchant_id>`,
    `<ssl_user_id>${escapeXml(creds.sslUserId)}</ssl_user_id>`,
    `<ssl_pin>${escapeXml(creds.sslPin)}</ssl_pin>`,
    '<ssl_transaction_type>CCRETURN</ssl_transaction_type>',
    `<ssl_txn_id>${escapeXml(txnId)}</ssl_txn_id>`,
    `<ssl_amount>${escapeXml(amountDollars)}</ssl_amount>`,
    '</txn>',
  ].join('')

  const response = await fetch(apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `xmldata=${encodeURIComponent(xmlData)}`,
    signal:  AbortSignal.timeout(30_000),
  })

  const raw = await response.text()

  if (!response.ok) {
    console.error(`[converge] CCRETURN HTTP ${response.status}:`, raw)
    throw new Error(`Converge refund request failed: HTTP ${response.status}`)
  }

  const result      = extractXmlTag(raw, 'ssl_result')
  const refundTxnId = extractXmlTag(raw, 'ssl_txn_id')
  const errorMsg    = extractXmlTag(raw, 'ssl_result_message') ?? extractXmlTag(raw, 'errorMessage')

  if (result !== '0') {
    console.error(`[converge] CCRETURN declined:`, raw)
    throw new Error(`Converge refund declined: ${errorMsg ?? 'Unknown error'}`)
  }

  return { approved: true, refundTxnId, raw }
}

/** Escape special chars for XML element content */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Extract text content of a simple XML element (no attributes, no nesting) */
function extractXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`)
  return re.exec(xml)?.[1] ?? null
}
