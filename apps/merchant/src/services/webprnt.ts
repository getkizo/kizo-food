/**
 * Star WebPRNT — HTTP-based printing for TSP100 III and compatible printers.
 *
 * Instead of raw TCP on port 9100, the TSP100 III exposes a built-in web
 * server that accepts print commands as XML over HTTP POST:
 *
 *   POST http://{ip}/StarWebPRNT/SendMessage
 *   Content-Type: text/xml; charset=UTF-8
 *
 * The XML body uses Star's proprietary schema with semantic elements
 * like <text>, <alignment>, <cutpaper>, etc.  The printer firmware
 * interprets these and produces the thermal output.
 *
 * This is the same protocol used by the official Star WebPRNT JavaScript SDK
 * (https://github.com/star-micronics/starwebprnt-sdk) and is how apps like
 * Grubhub print to the TSP100 III.
 */

import { LANG, type Lang } from './print-lang'
import type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions, TestPageOptions } from './print-types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLS    = 42
const COLS_2X = 21
const PRINT_MARGIN_LINES = 10

// ---------------------------------------------------------------------------
// XML builder
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe embedding in XML/HTML attribute values and text content.
 * Replaces `&`, `<`, `>`, and `"` with their XML entity equivalents.
 * Must be applied to all user-supplied strings before they enter the XML payload.
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * NF-3.1: Truncate user-supplied strings before they enter the XML payload.
 * Unbounded item names or notes can exceed the printer's firmware buffer (~4KB),
 * producing blank or corrupt tickets.
 */
function truncate(s: string, max: number, label?: string): string {
  if (s.length <= max) return s
  console.warn(`[webprnt] truncating ${label ?? 'string'} from ${s.length} to ${max} chars`)
  return s.slice(0, max)
}

/**
 * Fluent builder for Star WebPRNT XML request payloads.
 *
 * Usage pattern:
 * ```ts
 * const xml = new WebPRNTXml()
 *   .init()                          // must be first — resets printer state
 *   .align('center')                 // affects all subsequent text() calls until changed
 *   .text('KITCHEN', { emphasis: true, width: 2, height: 2 })
 *   .align('left')
 *   .text('1x Pad Thai')
 *   .feed(3)
 *   .cut()
 *   .toRequestXml()                  // returns the full XML string for HTTP POST
 * ```
 *
 * XML envelope produced by {@link toRequestXml}:
 * ```xml
 * <StarWebPrint xmlns="http://www.star-m.jp" ...>
 *   <Request>
 *     <initialization/>
 *     <alignment position="center"/>
 *     <text emphasis="true" width="2" height="2">KITCHEN&#10;</text>
 *     ...
 *   </Request>
 * </StarWebPrint>
 * ```
 *
 * Notes:
 *   - `init()` must be called first; the printer ignores commands preceding it.
 *   - `align()` is sticky: it applies to all subsequent `text()` and `textRaw()` calls
 *     until another `align()` overrides it.
 *   - All user-supplied strings are XML-escaped by `esc()` and length-truncated by
 *     `truncate()` before being emitted.
 */
class WebPRNTXml {
  private parts: string[] = []

  /**
   * Emit the `<initialization/>` element — resets the printer to its default state.
   *
   * @warning **Must be called first**, before any other builder method.
   * The TSP100 III firmware ignores all commands that precede `<initialization/>`;
   * omitting it or calling it after other elements produces a blank ticket.
   */
  init(): this {
    this.parts.push('<initialization/>')
    return this
  }

  align(pos: 'left' | 'center' | 'right'): this {
    this.parts.push(`<alignment position="${pos}"/>`)
    return this
  }

  /** Emit a text element.  Always appends \n (line break). */
  text(s: string, opts?: { emphasis?: boolean; width?: number; height?: number }): this {
    const attrs: string[] = []
    if (opts?.emphasis) attrs.push('emphasis="true"')
    if (opts?.width  && opts.width  > 1) attrs.push(`width="${opts.width}"`)
    if (opts?.height && opts.height > 1) attrs.push(`height="${opts.height}"`)
    const a = attrs.length ? ' ' + attrs.join(' ') : ''
    this.parts.push(`<text${a}>${esc(s)}&#10;</text>`)
    return this
  }

  /** Emit a text element WITHOUT trailing newline (for inline fragments). */
  textRaw(s: string, opts?: { emphasis?: boolean; width?: number; height?: number }): this {
    const attrs: string[] = []
    if (opts?.emphasis) attrs.push('emphasis="true"')
    if (opts?.width  && opts.width  > 1) attrs.push(`width="${opts.width}"`)
    if (opts?.height && opts.height > 1) attrs.push(`height="${opts.height}"`)
    const a = attrs.length ? ' ' + attrs.join(' ') : ''
    this.parts.push(`<text${a}>${esc(s)}</text>`)
    return this
  }

  feed(lines: number): this {
    this.parts.push(`<feed line="${lines}"/>`)
    return this
  }

  cut(partial = false): this {
    this.parts.push(`<cutpaper feed="true" type="${partial ? 'partial' : 'full'}"/>`)
    return this
  }

  /** Wrap accumulated elements in the WebPRNT request envelope. */
  toRequestXml(): string {
    return (
      '<StarWebPrint xmlns="http://www.star-m.jp" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
      '<Request>' +
      this.parts.join('') +
      '</Request>' +
      '</StarWebPrint>'
    )
  }
}

// ---------------------------------------------------------------------------
// Text helpers (mirrored from printer.ts for plain-string output)
// ---------------------------------------------------------------------------

function dividerStr(ch = '-', width = COLS): string {
  return ch.repeat(width)
}

function cols2Str(left: string, right: string, width = COLS): string {
  const pad = Math.max(1, width - left.length - right.length)
  return left + ' '.repeat(pad) + right
}

function rpadStr(label: string, value: string, width = COLS): string {
  const pad = Math.max(1, width - label.length - value.length)
  return label + ' '.repeat(pad) + value
}

function fmtCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

function parseDate(iso?: string | null): Date {
  if (!iso) return new Date()
  if (!iso.includes('T') && !iso.includes('Z') && !iso.includes('+')) {
    return new Date(iso.replace(' ', 'T') + 'Z')
  }
  return new Date(iso)
}

function fmtTime(iso?: string | null, timezone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  if (timezone) opts.timeZone = timezone
  return parseDate(iso).toLocaleTimeString('en-US', opts)
}

function fmtDate(iso?: string | null, timezone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  if (timezone) opts.timeZone = timezone
  return parseDate(iso).toLocaleDateString('en-US', opts)
}

// ---------------------------------------------------------------------------
// Types — re-exported from print-types (single source of truth)
// ---------------------------------------------------------------------------

export type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions, TestPageOptions } from './print-types'

// ---------------------------------------------------------------------------
// Kitchen ticket (WebPRNT XML)
// ---------------------------------------------------------------------------

export function buildKitchenTicketXml(opts: KitchenTicketOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt, opts.timezone)
  const x       = new WebPRNTXml()

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn.toUpperCase()  :
    opts.orderType === 'delivery' ? L.delivery.toUpperCase() : L.takeout.toUpperCase()
  const typeLabelMixed =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  x.init()
   .feed(PRINT_MARGIN_LINES)
   .align('center')
   .text(typeLabel, { emphasis: true, width: 2, height: 2 })
   .align('left')
   .text(dividerStr('='))

  // Order ID + time (2x)
  x.text(cols2Str(`#${shortId}`, time, COLS_2X), { width: 2, height: 2 })

  // Location
  const locParts: string[] = []
  if (opts.roomLabel)  locParts.push(opts.roomLabel)
  if (opts.tableLabel) locParts.push(`Table ${opts.tableLabel}`)
  const locationLine = locParts.length > 0
    ? `${typeLabelMixed} -- ${locParts.join(' / ')}`
    : typeLabelMixed
  x.text(locationLine, { emphasis: true })

  if (opts.customerName && opts.orderType !== 'dine_in' && opts.customerName !== 'Dine-in') {
    x.text(truncate(opts.customerName, 80, 'customer name'))
  }

  x.text(dividerStr('='))

  // Items
  for (const item of opts.items) {
    x.text(` ${item.quantity}  ${truncate(item.dishName, 80, 'dish name')}`, { emphasis: true, width: 2, height: 2 })

    if ((item.modifiers?.length ?? 0) > 0) {
      for (const mod of item.modifiers!) {
        x.text(`   - ${truncate(mod.name ?? '', 80, 'modifier name')}`, { height: 2 })
      }
    }

    if (item.specialInstructions) {
      x.text(`   >> ${truncate(item.specialInstructions, 200, 'special instructions')}`, { emphasis: true, height: 2 })
    }
    if (item.serverNotes) {
      x.text(`   * ${truncate(item.serverNotes, 200, 'server notes')}`, { emphasis: true, height: 2 })
    }
  }

  x.text(dividerStr())

  if (opts.notes) {
    x.text(`${L.note}: ${truncate(opts.notes, 200, 'order notes')}`, { emphasis: true, width: 2, height: 2 })
    x.text(dividerStr())
  }

  x.feed(PRINT_MARGIN_LINES)
   .cut()

  return x.toRequestXml()
}

// ---------------------------------------------------------------------------
// Counter ticket (WebPRNT XML)
// ---------------------------------------------------------------------------

export function buildCounterTicketXml(opts: CounterTicketOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt, opts.timezone)
  const x       = new WebPRNTXml()

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  x.init()
   .feed(PRINT_MARGIN_LINES)
   .align('center')
   .text(L.counter, { emphasis: true })
   .text(dividerStr('='))
   .align('left')
   .text(cols2Str(`#${shortId}`, time))

  let locationLine = typeLabel
  if (opts.roomLabel)  locationLine += `  ${opts.roomLabel}`
  if (opts.tableLabel) locationLine += `  Table ${opts.tableLabel}`
  x.text(locationLine, { emphasis: true })

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    x.text(truncate(opts.customerName, 80, 'customer name'), { emphasis: true, width: 2, height: 2 })
  }

  if (opts.pickupCode) {
    x.text(`CODE: ${truncate(opts.pickupCode, 20, 'pickup code')}`, { emphasis: true, width: 2, height: 2 })
  }

  x.text(dividerStr())

  for (const item of opts.items) {
    x.text(` ${item.quantity}  ${truncate(item.dishName, 80, 'dish name')}`)

    if ((item.modifiers?.length ?? 0) > 0) {
      for (const mod of item.modifiers!) {
        const extra = mod.priceCents !== 0
          ? `  ${mod.priceCents > 0 ? '+' : ''}${fmtCents(Math.abs(mod.priceCents))}`
          : ''
        x.text(`       - ${truncate(mod.name ?? '', 80, 'modifier name')}${extra}`)
      }
    }

    if (item.dishLabel) {
      x.text(`       ${truncate(item.dishLabel, 200, 'dish label')}`, { emphasis: true })
    }
    if (item.specialInstructions) {
      x.text(`       >> ${truncate(item.specialInstructions, 200, 'special instructions')}`, { emphasis: true })
    }
    if (item.serverNotes) {
      x.text(`       * ${truncate(item.serverNotes, 200, 'server notes')}`, { emphasis: true })
    }
  }

  x.text(dividerStr())

  if (opts.notes) {
    x.text(`${L.note}: ${truncate(opts.notes, 200, 'order notes')}`, { emphasis: true })
    x.text(dividerStr())
  }

  if (opts.utensilsNeeded) {
    x.text(L.utensils, { emphasis: true })
    x.text(dividerStr())
  }

  x.feed(PRINT_MARGIN_LINES)
   .cut()

  return x.toRequestXml()
}

// ---------------------------------------------------------------------------
// Customer receipt (WebPRNT XML)
// ---------------------------------------------------------------------------

export function buildCustomerReceiptXml(opts: CustomerReceiptOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt, opts.timezone)
  const date    = fmtDate(opts.createdAt, opts.timezone)
  const x       = new WebPRNTXml()

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  x.init()
   .feed(PRINT_MARGIN_LINES)
   .align('center')
   .text(opts.merchantName ?? L.receipt, { emphasis: true })

  if (opts.address) x.text(opts.address)

  x.text(dividerStr('='))
   .align('left')
   .text(cols2Str(`${L.order} #${shortId}`, typeLabel))
   .text(cols2Str(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time))

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    x.text(`${L.customer}: ${opts.customerName}`)
  }

  x.text(dividerStr())

  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    x.text(rpadStr(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        x.text(rpadStr(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        x.text(`       ${mod.name}`)
      }
    }
  }

  x.text(dividerStr())
  x.text(rpadStr(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  x.text(rpadStr(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  x.text(dividerStr())
   .text(rpadStr(`  ${L.total}`, fmtCents(opts.paidAmountCents)), { emphasis: true })
   .text(dividerStr('='))
   .align('center')
   .text(`${L.paid}  ${fmtCents(opts.paidAmountCents)}`, { emphasis: true })
   .text(L.paidByCard)
   .text(dividerStr('='))

  if (opts.phoneNumber) x.text(opts.phoneNumber)
  if (opts.website)     x.text(opts.website)
  x.text('')
   .text(L.thankYou)
   .align('left')
   .feed(PRINT_MARGIN_LINES)
   .cut()

  return x.toRequestXml()
}

// ---------------------------------------------------------------------------
// Customer bill (WebPRNT XML)
// ---------------------------------------------------------------------------

export function buildCustomerBillXml(opts: CustomerBillOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt, opts.timezone)
  const date    = fmtDate(opts.createdAt, opts.timezone)
  const x       = new WebPRNTXml()

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const discountCents = opts.discountCents ?? 0
  const serviceChargeCents = opts.serviceChargeCents ?? 0
  const discountedSubtotal = opts.subtotalCents - discountCents
  const totalCents = discountedSubtotal + serviceChargeCents + opts.taxCents

  x.init()
   .feed(PRINT_MARGIN_LINES)
   .align('center')
   .text(opts.merchantName ?? L.bill, { emphasis: true })

  if (opts.address) x.text(opts.address)

  x.text(dividerStr('='))
   .align('left')
   .text(cols2Str(`${L.order} #${shortId}`, typeLabel))
   .text(cols2Str(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time))

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    x.text(`${L.customer}: ${opts.customerName}`)
  }

  x.text(dividerStr())

  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    x.text(rpadStr(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        x.text(rpadStr(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        x.text(`       ${mod.name}`)
      }
    }
  }

  x.text(dividerStr())
  x.text(rpadStr(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  if (discountCents > 0) {
    const discLabel = opts.discountLabel ? ` (${opts.discountLabel})` : ''
    x.text(rpadStr(`  Discount${discLabel}`, `-${fmtCents(discountCents)}`))
  }

  if (serviceChargeCents > 0) {
    const scLabel = opts.serviceChargeLabel ? ` (${opts.serviceChargeLabel})` : ''
    x.text(rpadStr(`  Service Charge${scLabel}`, `+${fmtCents(serviceChargeCents)}`))
  }

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  x.text(rpadStr(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  x.text(dividerStr('='))
   .text(rpadStr(`  ${L.total}`, fmtCents(totalCents)), { emphasis: true })
   .text(dividerStr('='))
   .align('center')

  if (opts.phoneNumber) x.text(opts.phoneNumber)
  if (opts.website)     x.text(opts.website)
  x.text('')
   .text(L.thankYou)
   .align('left')
   .feed(PRINT_MARGIN_LINES)
   .cut()

  return x.toRequestXml()
}

// ---------------------------------------------------------------------------
// Test page (WebPRNT XML)
// ---------------------------------------------------------------------------

export function buildTestPageXml(opts: TestPageOptions): string {
  const label = opts.label ?? 'Printer'
  const now   = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const x = new WebPRNTXml()

  x.init()
   .feed(PRINT_MARGIN_LINES)
   .align('center')
   .text('TEST', { emphasis: true, width: 2, height: 2 })
   .text('')
   .text(label.toUpperCase() + ' PRINTER')
   .text(opts.printerIp)
   .text('webprnt')
   .text(now)
   .align('left')
   .text(dividerStr())
   .text('If you can read this, the printer is')
   .text('configured correctly.')
   .feed(PRINT_MARGIN_LINES)
   .cut()

  return x.toRequestXml()
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/**
 * Send a WebPRNT XML request to the printer's built-in web server.
 *
 * Default URL: http://{ip}/StarWebPRNT/SendMessage
 * The TSP100 III listens on port 80 by default.
 */
/**
 * Error thrown when the printer responds but WebPRNT endpoint is not available.
 * This typically means WebPRNT needs to be enabled in the printer's configuration.
 */
export class WebPRNTNotEnabledError extends Error {
  constructor(ip: string, status: number, reason?: string) {
    const detail = reason ?? 'WebPRNT not enabled'
    super(
      `${detail} on ${ip} (HTTP ${status}). ` +
      `Open http://${ip}/ in a browser, login (root/public), and enable WebPRNT. ` +
      `Or switch the printer protocol to "TSP100 III (TCP)" in Settings.`,
    )
    this.name = 'WebPRNTNotEnabledError'
  }
}

export async function sendWebPRNT(
  ip: string,
  xml: string,
  port = 80,
  timeoutMs = 8000,
): Promise<void> {
  const url = `http://${ip}:${port}/StarWebPRNT/SendMessage`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
      body: xml,
      signal: controller.signal,
    })

    // NF-3.3: Distinguish firmware-incompatible (404) from feature-disabled (405)
    if (res.status === 404) {
      throw new WebPRNTNotEnabledError(ip, res.status, 'WebPRNT endpoint not found — firmware may be incompatible or wrong printer model')
    }
    if (res.status === 405) {
      throw new WebPRNTNotEnabledError(ip, res.status, 'WebPRNT not enabled in printer settings')
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`WebPRNT HTTP ${res.status}: ${body}`)
    }

    // NF-3.3: Printer XML errors must be thrown, not just warned — otherwise
    // callers have no way to surface the failure to the merchant dashboard.
    const responseText = await res.text()
    if (responseText.includes('errors="true"') || responseText.includes('ASB_PRINT_SUCCESS="false"')) {
      throw new Error(`[webprnt] Printer reported error for ${ip}: ${responseText.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
