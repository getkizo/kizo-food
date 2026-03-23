/**
 * Customer email notification service
 *
 * Sends two types of transactional emails to customers:
 *  1. **Order receipt** — sent after payment is confirmed (online, in-person, $0 orders).
 *  2. **Order ready** — sent when staff marks an order as ready for pickup.
 *
 * The merchant configures a from-address and credential in Store Profile → Email Settings.
 * Emails are sent fire-and-forget; failures are logged but never block responses.
 *
 * ## Supported SMTP providers and credential types
 *
 * | Provider  | Auth mechanism             | Daily limit    | Notes |
 * |-----------|----------------------------|----------------|-------|
 * | `gmail`   | App Password (16-char)     | 500 emails/day | Requires 2FA; generate at myaccount.google.com/apppasswords |
 * | `outlook` | App Password (16-char)     | 300 emails/day | Requires Modern Auth + app password in Microsoft account settings |
 * | `yahoo`   | App Password (16-char)     | ~500/day       | Generate at account.yahoo.com/security |
 * | `sendgrid`| API key (SG.xxx…)          | plan-dependent | Store full API key as the credential; from-address must be verified |
 * | `smtp`    | Password (provider varies) | provider limit | Generic fallback; configure host/port via buildSmtpTransport |
 *
 * All providers support both email types (receipt and ready notification).
 * SendGrid is the only provider that accepts an API key instead of an App Password.
 * Gmail, Outlook, and Yahoo require the merchant's regular account to have 2FA enabled
 * before App Passwords can be generated.
 *
 * The credential is stored encrypted in `api_keys` (key_type='email', provider=smtpProvider).
 * The from-address is stored in `merchants.receipt_email_from`.
 */

import { getAPIKey } from '../crypto/api-keys'
import { getDatabase } from '../db/connection'
import { buildSmtpTransport } from './smtp'

interface OrderItem {
  dishName: string
  quantity?: number
  priceCents?: number
  lineTotalCents?: number
  modifiers?: Array<{ name: string; priceCents?: number }>
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

function esc(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatReadyTime(isoStr: string): string {
  const d = new Date(isoStr)
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

/**
 * Resolve the SMTP transporter for a merchant.
 * Returns null if the merchant has no email config or no stored credentials.
 */
async function resolveTransporter(
  merchantId: string,
  fromAddress: string,
  smtpProvider: string,
) {
  const appPassword = await getAPIKey(merchantId, 'email', smtpProvider)
  if (!appPassword) return null
  return buildSmtpTransport(smtpProvider, fromAddress, appPassword)
}

// ---------------------------------------------------------------------------
// sendReceiptEmail
// ---------------------------------------------------------------------------

/**
 * Sends a payment receipt email to the customer if:
 *  1. The merchant has `receipt_email_from` configured
 *  2. The customer provided an email address on their order
 *  3. SMTP credentials are stored in api_keys
 *
 * Shows: items, subtotal, service charge, discount, tax, tip, amount paid.
 */
export async function sendReceiptEmail(merchantId: string, orderId: string): Promise<void> {
  const db = getDatabase()

  const merchantRow = db
    .query<{
      business_name: string
      receipt_email_from: string | null
      smtp_provider: string | null
      phone_number: string | null
      website: string | null
      address: string | null
    }, [string]>(
      `SELECT business_name, receipt_email_from, smtp_provider,
              phone_number, website, address
       FROM merchants WHERE id = ?`,
    )
    .get(merchantId)

  if (!merchantRow?.receipt_email_from) return

  const fromAddress  = merchantRow.receipt_email_from
  const businessName = merchantRow.business_name
  const smtpProvider = merchantRow.smtp_provider ?? 'gmail'

  const order = db
    .query<
      {
        customer_name: string
        customer_email: string | null
        items: string
        subtotal_cents: number
        tax_cents: number
        tip_cents: number
        total_cents: number
        paid_amount_cents: number | null
        discount_cents: number
        discount_label: string | null
        service_charge_cents: number
        service_charge_label: string | null
        pickup_code: string
        order_type: string
        pickup_time: string | null
        estimated_ready_at: string | null
      },
      [string]
    >(
      `SELECT customer_name, customer_email, items,
              subtotal_cents, tax_cents,
              COALESCE(tip_cents, 0) AS tip_cents,
              total_cents,
              paid_amount_cents,
              COALESCE(discount_cents, 0) AS discount_cents,
              discount_label,
              COALESCE(service_charge_cents, 0) AS service_charge_cents,
              service_charge_label,
              pickup_code, order_type, pickup_time, estimated_ready_at
       FROM orders WHERE id = ?`,
    )
    .get(orderId)

  if (!order?.customer_email) return

  const transporter = await resolveTransporter(merchantId, fromAddress, smtpProvider)
  if (!transporter) return

  let items: OrderItem[] = []
  try { items = JSON.parse(order.items) } catch { /* ignore malformed */ }

  const smtpName = businessName.replace(/[\\"]/g, '\\$&')

  await transporter.sendMail({
    from:    `"${smtpName}" <${fromAddress}>`,
    to:      order.customer_email,
    subject: `Your receipt from ${businessName} — #${order.pickup_code}`,
    html:    buildReceiptHtml({
      businessName,
      address: merchantRow.address,
      phone:   merchantRow.phone_number,
      website: merchantRow.website,
      order,
      items,
    }),
  })

  console.log(`[email] Receipt sent to ${order.customer_email} for order ${orderId}`)
}

// ---------------------------------------------------------------------------
// sendOrderReadyEmail
// ---------------------------------------------------------------------------

/**
 * Sends a "your order is ready for pickup" email to the customer.
 * Only sent for pickup / delivery orders (not dine-in, where staff brings food to the table).
 */
export async function sendOrderReadyEmail(merchantId: string, orderId: string): Promise<void> {
  const db = getDatabase()

  const merchantRow = db
    .query<{
      business_name: string
      receipt_email_from: string | null
      smtp_provider: string | null
      phone_number: string | null
      address: string | null
    }, [string]>(
      `SELECT business_name, receipt_email_from, smtp_provider, phone_number, address
       FROM merchants WHERE id = ?`,
    )
    .get(merchantId)

  if (!merchantRow?.receipt_email_from) return

  const fromAddress  = merchantRow.receipt_email_from
  const businessName = merchantRow.business_name
  const smtpProvider = merchantRow.smtp_provider ?? 'gmail'

  const order = db
    .query<
      {
        customer_name: string
        customer_email: string | null
        pickup_code: string
        order_type: string
        items: string
      },
      [string]
    >(
      `SELECT customer_name, customer_email, pickup_code, order_type, items
       FROM orders WHERE id = ?`,
    )
    .get(orderId)

  if (!order?.customer_email) return
  // Only send for pickup/delivery; dine-in staff bring food to the table
  if (order.order_type === 'dine_in') return

  const transporter = await resolveTransporter(merchantId, fromAddress, smtpProvider)
  if (!transporter) return

  let items: OrderItem[] = []
  try { items = JSON.parse(order.items) } catch { /* ignore malformed */ }

  const isDelivery   = order.order_type === 'delivery'
  const subjectVerb  = isDelivery ? 'on its way' : 'ready for pickup'
  const smtpName     = businessName.replace(/[\\"]/g, '\\$&')

  await transporter.sendMail({
    from:    `"${smtpName}" <${fromAddress}>`,
    to:      order.customer_email,
    subject: `Your order is ${subjectVerb}! — #${order.pickup_code}`,
    html:    buildReadyHtml({
      businessName,
      address: merchantRow.address,
      phone:   merchantRow.phone_number,
      order,
      items,
      isDelivery,
    }),
  })

  console.log(`[email] Ready notification sent to ${order.customer_email} for order ${orderId}`)
}

// ---------------------------------------------------------------------------
// HTML template — receipt
// ---------------------------------------------------------------------------

interface ReceiptOpts {
  businessName: string
  address?: string | null
  phone?: string | null
  website?: string | null
  order: {
    customer_name: string
    pickup_code: string
    order_type: string
    pickup_time: string | null
    estimated_ready_at: string | null
    subtotal_cents: number
    discount_cents: number
    discount_label: string | null
    service_charge_cents: number
    service_charge_label: string | null
    tax_cents: number
    tip_cents: number
    total_cents: number
    paid_amount_cents: number | null
  }
  items: OrderItem[]
}

function buildReceiptHtml(opts: ReceiptOpts): string {
  const { businessName, address, phone, website, order, items } = opts

  const contactParts: string[] = []
  if (address) contactParts.push(esc(address))
  if (phone)   contactParts.push(esc(phone))
  if (website) {
    const href = website.startsWith('http') ? website : `https://${website}`
    contactParts.push(`<a href="${esc(href)}" style="color:#aaa;text-decoration:underline;">${esc(website.replace(/^https?:\/\//, ''))}</a>`)
  }
  const contactHtml = contactParts.length > 0
    ? `<p style="margin:8px 0 0;font-size:12px;color:#aaa;line-height:1.5;">${contactParts.join(' &middot; ')}</p>`
    : ''

  const itemRows = items.map((item) => {
    const qty  = item.quantity && item.quantity > 1 ? ` &times;${item.quantity}` : ''
    const mods = item.modifiers && item.modifiers.length > 0
      ? `<br><span style="font-size:12px;color:#666;">${esc(item.modifiers.map((m) => m.name).join(', '))}</span>`
      : ''
    const price = formatCents(item.lineTotalCents ?? item.priceCents ?? 0)
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
          ${esc(item.dishName)}${qty}${mods}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;">
          ${price}
        </td>
      </tr>`
  }).join('')

  const discountRow = order.discount_cents > 0
    ? `<tr>
        <td style="padding:4px 8px;color:#555;">Discount${order.discount_label ? ` (${esc(order.discount_label)})` : ''}</td>
        <td style="padding:4px 8px;text-align:right;color:#c0392b;">−${formatCents(order.discount_cents)}</td>
       </tr>`
    : ''

  const serviceChargeRow = order.service_charge_cents > 0
    ? `<tr>
        <td style="padding:4px 8px;color:#555;">${esc(order.service_charge_label) || 'Service charge'}</td>
        <td style="padding:4px 8px;text-align:right;">${formatCents(order.service_charge_cents)}</td>
       </tr>`
    : ''

  const taxRow = order.tax_cents > 0
    ? `<tr>
        <td style="padding:4px 8px;color:#555;">Tax</td>
        <td style="padding:4px 8px;text-align:right;">${formatCents(order.tax_cents)}</td>
       </tr>`
    : ''

  const tipRow = order.tip_cents > 0
    ? `<tr>
        <td style="padding:4px 8px;color:#555;">Tip</td>
        <td style="padding:4px 8px;text-align:right;">${formatCents(order.tip_cents)}</td>
       </tr>`
    : ''

  // Use paid_amount_cents when available (in-person payments update both
  // total_cents and paid_amount_cents to the full settled amount).
  // For online orders paid_amount_cents == total_cents anyway.
  const finalCents = order.paid_amount_cents ?? order.total_cents

  let pickupNote = ''
  if (order.order_type === 'pickup') {
    if (order.pickup_time) {
      pickupNote = `<p style="margin:0 0 8px;color:#555;">Scheduled pickup: <strong>${formatReadyTime(order.pickup_time)}</strong></p>`
    } else if (order.estimated_ready_at) {
      pickupNote = `<p style="margin:0 0 8px;color:#555;">Estimated ready: <strong>${formatReadyTime(order.estimated_ready_at)}</strong></p>`
    } else {
      pickupNote = `<p style="margin:0 0 8px;color:#555;">Pickup: <strong>ASAP</strong></p>`
    }
  } else if (order.estimated_ready_at) {
    pickupNote = `<p style="margin:0 0 8px;color:#555;">Estimated ready: <strong>${formatReadyTime(order.estimated_ready_at)}</strong></p>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt from ${esc(businessName)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table width="100%" style="max-width:480px;background:#fff;border-radius:8px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#111;padding:24px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:bold;color:#fff;">${esc(businessName)}</p>
              <p style="margin:8px 0 0;font-size:13px;color:#aaa;">Payment Receipt</p>
              ${contactHtml}
            </td>
          </tr>

          <!-- Order meta -->
          <tr>
            <td style="padding:16px 24px 8px;">
              <p style="margin:0 0 4px;">Hi <strong>${esc(order.customer_name)}</strong>, thank you for your order!</p>
              <p style="margin:0 0 8px;color:#555;">Order #<strong>${esc(order.pickup_code)}</strong></p>
              ${pickupNote}
            </td>
          </tr>

          <!-- Items -->
          <tr>
            <td style="padding:0 24px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #111;">
                ${itemRows}
              </table>
            </td>
          </tr>

          <!-- Totals -->
          <tr>
            <td style="padding:0 24px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ddd;">
                <tr>
                  <td style="padding:4px 8px;color:#555;">Subtotal</td>
                  <td style="padding:4px 8px;text-align:right;">${formatCents(order.subtotal_cents)}</td>
                </tr>
                ${discountRow}
                ${serviceChargeRow}
                ${taxRow}
                ${tipRow}
                <tr>
                  <td style="padding:8px 8px 4px;font-weight:bold;border-top:2px solid #111;">Amount Paid</td>
                  <td style="padding:8px 8px 4px;text-align:right;font-weight:bold;border-top:2px solid #111;">${formatCents(finalCents)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;font-size:12px;color:#999;">Thank you for dining with us!</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// HTML template — order ready
// ---------------------------------------------------------------------------

interface ReadyOpts {
  businessName: string
  address?: string | null
  phone?: string | null
  order: {
    customer_name: string
    pickup_code: string
    order_type: string
  }
  items: OrderItem[]
  isDelivery: boolean
}

function buildReadyHtml(opts: ReadyOpts): string {
  const { businessName, address, phone, order, items, isDelivery } = opts

  const headline    = isDelivery ? "Your order is on its way!" : "Your order is ready for pickup!"
  const instruction = isDelivery
    ? "Your delivery is heading your way."
    : `Show pickup code <strong>#${esc(order.pickup_code)}</strong> at the counter.`

  const contactParts: string[] = []
  if (address) contactParts.push(esc(address))
  if (phone)   contactParts.push(esc(phone))
  const contactHtml = contactParts.length > 0
    ? `<p style="margin:8px 0 0;font-size:12px;color:#aaa;">${contactParts.join(' &middot; ')}</p>`
    : ''

  const itemList = items.map((item) => {
    const qty  = item.quantity && item.quantity > 1 ? ` &times;${item.quantity}` : ''
    const mods = item.modifiers && item.modifiers.length > 0
      ? `<span style="font-size:12px;color:#666;"> (${esc(item.modifiers.map((m) => m.name).join(', '))})</span>`
      : ''
    return `<li style="padding:3px 0;">${esc(item.dishName)}${qty}${mods}</li>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${headline}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table width="100%" style="max-width:480px;background:#fff;border-radius:8px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#111;padding:24px;text-align:center;">
              <p style="margin:0;font-size:20px;font-weight:bold;color:#fff;">${esc(businessName)}</p>
              ${contactHtml}
            </td>
          </tr>

          <!-- Ready badge -->
          <tr>
            <td style="padding:24px;text-align:center;">
              <p style="margin:0 0 8px;font-size:28px;">🎉</p>
              <p style="margin:0 0 8px;font-size:20px;font-weight:bold;color:#27ae60;">${headline}</p>
              <p style="margin:0;color:#555;">${instruction}</p>
            </td>
          </tr>

          <!-- Items summary -->
          ${itemList ? `
          <tr>
            <td style="padding:0 24px 16px;">
              <p style="margin:0 0 8px;font-weight:bold;border-top:1px solid #eee;padding-top:16px;">Your order</p>
              <ul style="margin:0;padding-left:20px;color:#333;">
                ${itemList}
              </ul>
            </td>
          </tr>` : ''}

          <!-- Footer -->
          <tr>
            <td style="background:#f9f9f9;padding:16px 24px;text-align:center;border-top:1px solid #eee;">
              <p style="margin:0;font-size:12px;color:#999;">Thank you for dining with us!</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
