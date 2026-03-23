/**
 * Receipt printer service
 *
 * Supported protocols:
 *   star-line        — Star Line Mode (TSP700II, TSP654II, etc.) — TCP/9100
 *   star-line-tsp100 — TSP100 III Star Line variant (factory default) — TCP/9100
 *   generic-escpos   — True ESC/POS emulation mode or third-party printers — TCP/9100
 *   webprnt          — TSP100/TSP143 III via HTTP WebPRNT (port 80);
 *                      auto-falls back to star-graphic raster if WebPRNT is disabled
 *   star-graphic     — Star Graphic Mode raster via TCP/9100 (receiptline renderer);
 *                      required for TSP143 III, which has no device font ROM and silently
 *                      ignores all text-mode commands (Star Line, ESC/POS)
 *
 * Ticket types:
 *   printKitchenTicket()   — fired when staff press the Fire button
 *   printCounterTicket()   — server copy for packing/table delivery
 *   printCustomerReceipt() — fired after a card payment is confirmed
 *   printCustomerBill()    — pre-payment bill with items + total
 *
 * Each print* TCP sender has a corresponding build* byte-builder that can be
 * called independently (e.g. for testing or WebPRNT fallback):
 *   buildKitchenTicket()   — returns ticket bytes without opening a TCP socket
 *   buildCounterTicket()   — returns ticket bytes without opening a TCP socket
 *   buildCustomerBill()    — returns ticket bytes without opening a TCP socket
 *   buildCustomerReceipt() — returns ticket bytes without opening a TCP socket
 */

// NOTE: TCP transport uses PowerShell's TcpClient (.NET) instead of Bun's
// native TCP.  Bun.connect() + socket.flush() returns undefined on Windows,
// causing print data to sit in an application buffer and never reach the wire.
// PowerShell's .NET TcpClient guarantees flush before close.
import {
  sendWebPRNT,
  WebPRNTNotEnabledError,
  buildKitchenTicketXml,
  buildCounterTicketXml,
  buildCustomerReceiptXml,
  buildCustomerBillXml,
  buildTestPageXml,
} from './webprnt'
import {
  buildKitchenTicketRaster,
  buildCounterTicketRaster,
  buildCustomerReceiptRaster,
  buildCustomerBillRaster,
  buildTestPageRaster,
  buildGiftCardReceiptRaster,
} from './star-raster'
import {
  renderHtmlToRasterBuffer,
  buildKitchenTicketHtml,
  buildCounterTicketHtml,
  buildCustomerBillHtml,
  buildCustomerReceiptHtml,
} from './html-receipt'
import type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions, TestPageOptions, GiftCardReceiptOptions } from './print-types'
import { LANG, type Lang } from './print-lang'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Characters per line on 80mm paper (Font A):
 *   Normal / double-height:  42 chars
 *   Double-width+height 2×:  21 chars
 */
const COLS    = 42
const COLS_2X = 21

/** Blank lines at top and bottom of every ticket. */
const PRINT_MARGIN_LINES = 10

/** Standard raw-print TCP port used by Star and ESC/POS printers. */
const PRINTER_TCP_PORT = 9100

const ESC = 0x1b
const GS  = 0x1d

// ---------------------------------------------------------------------------
// Command sets
// ---------------------------------------------------------------------------

interface CmdSet {
  INIT:         Buffer
  BOLD_ON:      Buffer
  BOLD_OFF:     Buffer
  ALIGN_LEFT:   Buffer
  ALIGN_CENTER: Buffer
  COLOR_BLACK:  Buffer
  COLOR_RED:    Buffer
  SIZE_DBL_H:   Buffer   // double-height, normal width
  SIZE_2X:      Buffer   // double-height + double-width
  SIZE_NORMAL:  Buffer
  FULL_CUT:     Buffer
  FEED:         (n: number) => Buffer
}

/**
 * Star Line Mode — factory default on TSP700II, TSP654II, etc.
 *
 * Key differences from ESC/POS:
 *   • Bold:      ESC E (on) / ESC F (off)  — NO parameter byte
 *   • Align:     ESC GS a n  (4 bytes, not ESC a n)
 *   • Color:     ESC 4 (red) / ESC 5 (black)
 *   • Sizing:    ESC W n + ESC h n  (not GS ! n)
 *   • Cut:       ESC d n  (n=2 full+feed, not GS V)
 *   • Feed:      LF chars  (ESC d is CUT in Star Line!)
 */
const STAR_CMD: CmdSet = {
  INIT:         Buffer.from([ESC, 0x40]),
  BOLD_ON:      Buffer.from([ESC, 0x45]),
  BOLD_OFF:     Buffer.from([ESC, 0x46]),
  ALIGN_LEFT:   Buffer.from([ESC, GS, 0x61, 0x00]),
  ALIGN_CENTER: Buffer.from([ESC, GS, 0x61, 0x01]),
  COLOR_BLACK:  Buffer.from([ESC, 0x35]),
  COLOR_RED:    Buffer.from([ESC, 0x34]),
  SIZE_DBL_H:   Buffer.from([ESC, 0x57, 0x00, ESC, 0x68, 0x01]),
  SIZE_2X:      Buffer.from([ESC, 0x57, 0x01, ESC, 0x68, 0x01]),
  SIZE_NORMAL:  Buffer.from([ESC, 0x57, 0x00, ESC, 0x68, 0x00]),
  FULL_CUT:     Buffer.from([ESC, 0x64, 0x02]),
  FEED:         (n) => Buffer.from('\n'.repeat(n), 'utf8'),
}

/**
 * TSP100 III in Star Line Mode (factory default).
 *
 * DB key: 'star-line-tsp100' (previously 'esc-pos' — renamed for clarity).
 * This is a Star Line variant with slightly different commands from the TSP700II:
 *   • Bold:    ESC E (on) / ESC F (off)  — NO parameter byte (same as TSP700II)
 *   • Align:   ESC a n  (3 bytes, 1B 61 n)  ← differs from TSP700II (ESC GS a n)
 *   • Color:   no-op — single-color printer (black only)
 *   • Sizing:  ESC W n + ESC h n  (Star Line style, same as TSP700II)
 *   • Cut:     ESC RS i  (1B 1E 69, full cut)  ← differs from TSP700II (ESC d n)
 *   • Feed:    LF chars (same)
 *
 * Key gotcha: ESC d n on TSP100 III = feed n lines (NOT cut!).
 */
const TSP100_STAR_CMD: CmdSet = {
  INIT:         Buffer.from([ESC, 0x40]),
  BOLD_ON:      Buffer.from([ESC, 0x45]),                  // no param byte
  BOLD_OFF:     Buffer.from([ESC, 0x46]),                  // no param byte
  ALIGN_LEFT:   Buffer.from([ESC, 0x61, 0x00]),            // ESC a 0
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),            // ESC a 1
  COLOR_BLACK:  Buffer.alloc(0),                           // single-color — no-op
  COLOR_RED:    Buffer.alloc(0),                           // single-color — no-op
  SIZE_DBL_H:   Buffer.from([ESC, 0x57, 0x00, ESC, 0x68, 0x01]),  // width×1, height×2
  SIZE_2X:      Buffer.from([ESC, 0x57, 0x01, ESC, 0x68, 0x01]),  // width×2, height×2
  SIZE_NORMAL:  Buffer.from([ESC, 0x57, 0x00, ESC, 0x68, 0x00]),  // width×1, height×1
  FULL_CUT:     Buffer.from([ESC, 0x1e, 0x69]),            // ESC RS i (1B 1E 69) — full cut on TSP100 III
  FEED:         (n) => Buffer.from('\n'.repeat(n), 'utf8'),
}

/**
 * True ESC/POS — for TSP100 III when switched to ESC/POS emulation mode
 * via the futurePRNT Configuration Utility (Section 2.5/4.18 in the manual),
 * or for any generic ESC/POS third-party receipt printer (Epson, etc.).
 *
 * In this mode:
 *   • Bold:    ESC E n  (n=1 on, n=0 off) — HAS parameter byte
 *   • Align:   ESC a n  (same as TSP100 III Star Line variant)
 *   • Sizing:  GS ! n   (bit-packed: high nibble = width, low nibble = height)
 *   • Cut:     GS V 0   (full cut)
 *   • Feed:    ESC d n  (feed n lines)
 */
const GENERIC_ESC_POS_CMD: CmdSet = {
  INIT:         Buffer.from([ESC, 0x40]),
  BOLD_ON:      Buffer.from([ESC, 0x45, 0x01]),            // ESC E 1
  BOLD_OFF:     Buffer.from([ESC, 0x45, 0x00]),            // ESC E 0
  ALIGN_LEFT:   Buffer.from([ESC, 0x61, 0x00]),            // ESC a 0
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),            // ESC a 1
  COLOR_BLACK:  Buffer.alloc(0),                           // no-op
  COLOR_RED:    Buffer.alloc(0),                           // no-op
  SIZE_DBL_H:   Buffer.from([GS, 0x21, 0x01]),             // GS ! 0x01: width×1, height×2
  SIZE_2X:      Buffer.from([GS, 0x21, 0x11]),             // GS ! 0x11: width×2, height×2
  SIZE_NORMAL:  Buffer.from([GS, 0x21, 0x00]),             // GS ! 0x00: width×1, height×1
  FULL_CUT:     Buffer.from([GS, 0x56, 0x00]),             // GS V 0 — full cut
  FEED:         (n) => Buffer.from([ESC, 0x64, n]),         // ESC d n — feed n lines
}

/**
 * Protocol key → command set mapping.
 *
 * DB values:
 *   'star-line'        — TSP700II / TSP654II (original Star Line)
 *   'star-line-tsp100' — TSP100 III in Star Line mode (factory default)
 *   'generic-escpos'   — TSP100 III in ESC/POS emulation or any third-party ESC/POS printer
 */
function getCmdSet(protocol?: string): CmdSet {
  switch (protocol) {
    case 'star-line-tsp100': return TSP100_STAR_CMD
    case 'generic-escpos':   return GENERIC_ESC_POS_CMD
    case 'star-line':
    case undefined:
      return STAR_CMD
    default:
      // 'webprnt' and 'star-graphic' are dispatched before getCmdSet() is called.
      // Any other value is unexpected — warn and fall back to star-line.
      console.warn(`[printer] Unrecognized protocol '${protocol}' — falling back to star-line`)
      return STAR_CMD
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function txt(s: string): Buffer {
  return Buffer.from(s + '\n', 'utf8')
}

function divider(ch = '-', width = COLS): Buffer {
  return txt(ch.repeat(width))
}

/**
 * Two-column line: fills the gap between `left` and `right` with spaces so the
 * combined line is exactly `width` chars.  Use for symmetric layouts (e.g. order
 * number on the left, time on the right).
 */
function cols2(left: string, right: string, width = COLS): Buffer {
  const pad = Math.max(1, width - left.length - right.length)
  return txt(left + ' '.repeat(pad) + right)
}

/**
 * Label + value line: left-aligns `label`, right-aligns `value`, padding between them.
 * Use for key/value pairs (e.g. `Subtotal` ... `$12.50`).
 * Alias of {@link cols2} — communicates key/value intent at call sites.
 */
function rpad(label: string, value: string, width = COLS): Buffer {
  return cols2(label, value, width)
}

function fmtCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

/**
 * Parse an ISO date string from SQLite into a Date.
 *
 * SQLite stores timestamps as bare strings like `"2026-02-26 14:30:00"` (no timezone
 * indicator).  Without normalization, `new Date("2026-02-26 14:30:00")` is interpreted
 * as local time on some runtimes and UTC on others, causing ticket timestamps to be
 * off by the server's UTC offset.
 *
 * Bare strings (no `T`, `Z`, or `+`) are treated as UTC by replacing the space
 * separator with `T` and appending `Z`.  Strings that already carry timezone info
 * are passed through unchanged.
 */
function parseDate(iso?: string | null): Date {
  if (!iso) return new Date()
  if (!iso.includes('T') && !iso.includes('Z') && !iso.includes('+')) {
    return new Date(iso.replace(' ', 'T') + 'Z')
  }
  return new Date(iso)
}

function fmtTime(iso?: string | null): string {
  return parseDate(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtDate(iso?: string | null): string {
  return parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Types — re-exported from print-types (single source of truth)
// ---------------------------------------------------------------------------

export type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions } from './print-types'

import { sortItemsByCourse, kitchenItems, course1Items, course2Items } from '../utils/course-items'
export { sortItemsByCourse, kitchenItems, course1Items, course2Items }

// ---------------------------------------------------------------------------
// Kitchen ticket builder
// ---------------------------------------------------------------------------

/**
 * Build a raw byte buffer for the kitchen ticket.
 *
 * Protocol dispatch:
 *   - `star-line` / `star-line-tsp100` / `generic-escpos` → Star Line or ESC/POS binary
 *   - `webprnt` → delegated to {@link buildKitchenTicketXml} (caller handles HTTP transport)
 *   - `star-graphic` → delegated to {@link buildKitchenTicketRaster} (receiptline renderer)
 *   - `html` receipt style → delegated to {@link buildKitchenTicketHtml} (Puppeteer pipeline)
 *
 * Item filtering: counter-only items (`printDestination: 'counter'`) are stripped
 * via {@link kitchenItems} before the ticket is built.  Items are then sorted by
 * course order via {@link sortItemsByCourse}.
 *
 * Modifiers are printed in red on Star Line (TSP700II) and double-height black on all
 * other protocols (color is a no-op on TSP100 III and ESC/POS).
 *
 * The returned buffer starts with INIT + COLOR_BLACK + margin feed and ends with FEED + FULL_CUT.
 * Callers are responsible for opening the TCP connection and writing the buffer.
 */
export function buildKitchenTicket(opts: KitchenTicketOptions): Buffer {
  const C       = getCmdSet(opts.printerProtocol)
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)

  // Apply course sorting and strip counter-only items before building ticket
  const sortedItems = sortItemsByCourse(kitchenItems(opts.items))

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn.toUpperCase()  :
    opts.orderType === 'delivery' ? L.delivery.toUpperCase() : L.takeout.toUpperCase()
  const typeLabelMixed =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const parts: Buffer[] = [
    C.INIT,
    C.COLOR_BLACK,
    C.FEED(PRINT_MARGIN_LINES),

    C.ALIGN_CENTER,
    C.SIZE_2X,
    C.BOLD_ON,
    txt(typeLabel),
    C.BOLD_OFF,
    C.SIZE_NORMAL,
    C.ALIGN_LEFT,
    divider('='),

    C.SIZE_2X,
    cols2(`#${shortId}`, time, COLS_2X),
  ]

  const locParts: string[] = []
  if (opts.roomLabel)  locParts.push(opts.roomLabel)
  if (opts.tableLabel) locParts.push(`Table ${opts.tableLabel}`)
  const locationLine = locParts.length > 0
    ? `${typeLabelMixed} -- ${locParts.join(' / ')}`
    : typeLabelMixed
  parts.push(C.BOLD_ON, txt(locationLine), C.BOLD_OFF)

  if (opts.customerName && opts.orderType !== 'dine_in' && opts.customerName !== 'Dine-in') {
    parts.push(txt(opts.customerName))
  }

  parts.push(C.SIZE_NORMAL, divider('='))

  for (const item of sortedItems) {
    parts.push(
      C.SIZE_2X,
      C.BOLD_ON,
      C.COLOR_BLACK,
      txt(` ${item.quantity}  ${item.dishName}`),
      C.BOLD_OFF,
    )

    if ((item.modifiers?.length ?? 0) > 0) {
      parts.push(C.SIZE_DBL_H, C.COLOR_RED)
      for (const mod of item.modifiers!) {
        parts.push(txt(`   - ${mod.name}`))
      }
      parts.push(C.COLOR_BLACK)
    }

    if (item.specialInstructions) {
      parts.push(C.SIZE_2X, C.BOLD_ON, txt(`   >> ${item.specialInstructions}`), C.BOLD_OFF)
    }
    if (item.serverNotes) {
      parts.push(C.SIZE_2X, C.BOLD_ON, txt(`   * ${item.serverNotes}`), C.BOLD_OFF)
    }
  }

  parts.push(C.SIZE_NORMAL, divider())

  if (opts.notes) {
    parts.push(
      C.SIZE_2X,
      C.BOLD_ON,
      txt(`${L.note}: ${opts.notes}`),
      C.BOLD_OFF,
      C.SIZE_NORMAL,
      divider(),
    )
  }

  parts.push(C.FEED(PRINT_MARGIN_LINES), C.FULL_CUT)
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Counter ticket builder
// ---------------------------------------------------------------------------

/**
 * Build a raw byte buffer for the counter/server ticket.
 *
 * Two rendering modes controlled by `opts.subtotalCents`:
 *   - **Present**: branded takeout bag receipt with merchant name, itemised prices,
 *     tax, total, and a "PAID" footer.  Used for takeout bag sealing.
 *   - **Absent**: compact dine-in counter copy (order ID, type, items without prices).
 *     Used for table delivery confirmation.
 *
 * Same protocol dispatch as {@link buildKitchenTicket}.
 */
export function buildCounterTicket(opts: CounterTicketOptions): Buffer {
  const C      = getCmdSet(opts.printerProtocol)
  const L      = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const parts: Buffer[] = [
    C.INIT,
    C.SIZE_NORMAL,
    C.FEED(PRINT_MARGIN_LINES),

    C.ALIGN_CENTER,
    C.BOLD_ON,
    txt(L.counter),
    C.BOLD_OFF,
    divider('=', COLS),

    C.ALIGN_LEFT,
    cols2(`#${shortId}`, time, COLS),
  ]

  let locationLine = typeLabel
  if (opts.roomLabel)  locationLine += `  ${opts.roomLabel}`
  if (opts.tableLabel) locationLine += `  Table ${opts.tableLabel}`
  parts.push(C.BOLD_ON, txt(locationLine), C.BOLD_OFF)

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    parts.push(C.SIZE_2X, C.BOLD_ON, txt(opts.customerName), C.BOLD_OFF, C.SIZE_NORMAL)
  }

  if (opts.pickupCode) {
    parts.push(C.SIZE_2X, C.BOLD_ON, txt(`CODE: ${opts.pickupCode}`), C.BOLD_OFF, C.SIZE_NORMAL)
  }

  parts.push(divider('-', COLS))

  for (const item of opts.items) {
    parts.push(txt(` ${item.quantity}  ${item.dishName}`))

    if ((item.modifiers?.length ?? 0) > 0) {
      for (const mod of item.modifiers!) {
        const extra = mod.priceCents !== 0
          ? `  ${mod.priceCents > 0 ? '+' : ''}${fmtCents(Math.abs(mod.priceCents))}`
          : ''
        parts.push(txt(`       - ${mod.name}${extra}`))
      }
    }

    if (item.dishLabel) {
      parts.push(C.BOLD_ON, txt(`       ${item.dishLabel}`), C.BOLD_OFF)
    }
    if (item.specialInstructions) {
      parts.push(C.BOLD_ON, txt(`       >> ${item.specialInstructions}`), C.BOLD_OFF)
    }
    if (item.serverNotes) {
      parts.push(C.BOLD_ON, txt(`       * ${item.serverNotes}`), C.BOLD_OFF)
    }
  }

  parts.push(divider('-', COLS))

  if (opts.notes) {
    parts.push(C.BOLD_ON, txt(`${L.note}: ${opts.notes}`), C.BOLD_OFF, divider('-', COLS))
  }

  if (opts.utensilsNeeded) {
    parts.push(C.BOLD_ON, txt(L.utensils), C.BOLD_OFF, divider('-', COLS))
  }

  parts.push(C.FEED(PRINT_MARGIN_LINES), C.FULL_CUT)
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Customer receipt builder
// ---------------------------------------------------------------------------

/**
 * Build a raw byte buffer for the post-payment customer receipt (text-mode path).
 *
 * Printed after a card payment is confirmed.  Shows the merchant name, order ID,
 * itemised list, subtotal, tax, and paid total, followed by a thank-you line.
 *
 * **Text-mode path limitations** (star-line / star-line-tsp100 / generic-escpos):
 * - `opts.tipCents` is declared on the interface but is **not rendered** in this
 *   text-mode path — it is only printed by the HTML (`buildCustomerReceiptHtml`)
 *   and raster (`buildCustomerReceiptRaster`) paths.
 * - "Signature captured on device" is printed by the HTML/raster paths only;
 *   it is absent here.
 *
 * Note: `opts.taxCents` is informational only — if `opts.taxRate` is also provided
 * the displayed tax is re-derived as `round(subtotalCents × taxRate)` for consistency
 * with the payment processor's calculation.
 *
 * Same protocol dispatch as {@link buildKitchenTicket}.
 */
export function buildCustomerReceipt(opts: CustomerReceiptOptions): Buffer {
  const C       = getCmdSet(opts.printerProtocol)
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId  = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time     = fmtTime(opts.createdAt)
  const date     = fmtDate(opts.createdAt)

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const parts: Buffer[] = [
    C.INIT,
    C.FEED(PRINT_MARGIN_LINES),

    C.ALIGN_CENTER,
    C.BOLD_ON,
    txt(opts.merchantName ?? L.receipt),
    C.BOLD_OFF,
  ]

  if (opts.address) parts.push(txt(opts.address))

  parts.push(
    divider('='),
    C.ALIGN_LEFT,
    cols2(`${L.order} #${shortId}`, typeLabel),
    cols2(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time),
  )

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    parts.push(txt(`${L.customer}: ${opts.customerName}`))
  }

  parts.push(divider())

  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    parts.push(rpad(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        parts.push(rpad(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        parts.push(txt(`       ${mod.name}`))
      }
    }
  }

  parts.push(divider())

  parts.push(rpad(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  parts.push(rpad(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  parts.push(
    divider(),
    C.BOLD_ON,
    rpad(`  ${L.total}`, fmtCents(opts.paidAmountCents)),
    C.BOLD_OFF,
    divider('='),
    C.ALIGN_CENTER,
    C.BOLD_ON,
    txt(`${L.paid}  ${fmtCents(opts.paidAmountCents)}`),
    C.BOLD_OFF,
    txt(L.paidByCard),
    divider('='),
  )

  if (opts.phoneNumber) parts.push(txt(opts.phoneNumber))
  if (opts.website)     parts.push(txt(opts.website))
  parts.push(
    txt(''),
    txt(L.thankYou),
    C.ALIGN_LEFT,
    C.FEED(PRINT_MARGIN_LINES),
    C.FULL_CUT,
  )

  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Customer bill builder
// ---------------------------------------------------------------------------

/**
 * Build a raw byte buffer for the pre-payment customer bill (text-mode path).
 *
 * Printed before a card is swiped.  Shows the merchant name, order ID,
 * itemised list, subtotal, optional discount, tax, and grand total,
 * followed by a thank-you line.
 *
 * **Text-mode path limitations** (star-line / star-line-tsp100 / generic-escpos):
 * - No merchant logo — text-mode protocols have no image support.
 * - No suggested gratuity table — rendered only by the HTML
 *   (`buildCustomerBillHtml`) and raster (`buildCustomerBillRaster`) paths.
 * - No write-in tip / total lines — HTML/raster paths only.
 * - No signature line — HTML/raster paths only.
 * - `opts.tipPercentages` is ignored in this path.
 *
 * Same protocol dispatch as {@link buildKitchenTicket}.
 */
export function buildCustomerBill(opts: CustomerBillOptions): Buffer {
  const C      = getCmdSet(opts.printerProtocol)
  const L      = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time   = fmtTime(opts.createdAt)
  const date   = fmtDate(opts.createdAt)

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const discountCents = opts.discountCents ?? 0
  const serviceChargeCents = opts.serviceChargeCents ?? 0
  const discountedSubtotal = opts.subtotalCents - discountCents
  const totalCents = discountedSubtotal + serviceChargeCents + opts.taxCents

  const parts: Buffer[] = [
    C.INIT,
    C.FEED(PRINT_MARGIN_LINES),

    C.ALIGN_CENTER,
    C.BOLD_ON,
    txt(opts.merchantName ?? L.bill),
    C.BOLD_OFF,
  ]

  if (opts.address) parts.push(txt(opts.address))

  parts.push(
    divider('='),
    C.ALIGN_LEFT,
    cols2(`${L.order} #${shortId}`, typeLabel),
    cols2(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time),
  )

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    parts.push(txt(`${L.customer}: ${opts.customerName}`))
  }

  parts.push(divider())

  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    parts.push(rpad(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        parts.push(rpad(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        parts.push(txt(`       ${mod.name}`))
      }
    }
  }

  parts.push(divider())

  parts.push(rpad(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  if (discountCents > 0) {
    const discLabel = opts.discountLabel ? ` (${opts.discountLabel})` : ''
    parts.push(rpad(`  Discount${discLabel}`, `-${fmtCents(discountCents)}`))
  }

  if (serviceChargeCents > 0) {
    const scLabel = opts.serviceChargeLabel ? ` (${opts.serviceChargeLabel})` : ''
    parts.push(rpad(`  Service Charge${scLabel}`, `+${fmtCents(serviceChargeCents)}`))
  }

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  parts.push(rpad(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  parts.push(
    divider('='),
    C.BOLD_ON,
    rpad(`  ${L.total}`, fmtCents(totalCents)),
    C.BOLD_OFF,
    divider('='),
  )

  parts.push(C.ALIGN_CENTER)
  if (opts.phoneNumber) parts.push(txt(opts.phoneNumber))
  if (opts.website)     parts.push(txt(opts.website))
  parts.push(
    txt(''),
    txt(L.thankYou),
    C.ALIGN_LEFT,
    C.FEED(PRINT_MARGIN_LINES),
    C.FULL_CUT,
  )

  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// TCP transport
// ---------------------------------------------------------------------------

import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'

/**
 * Send raw bytes to a printer via TCP using PowerShell's TcpClient.
 *
 * Includes StarIO ASB handshake by default: sends ESC ACK SOH (1B 06 01) first to
 * enable the printer's data channel, waits for a status response, then
 * sends the actual print data.  Without this handshake, the TSP100 III's
 * futurePRNT firmware silently ignores raw data on port 9100.
 *
 * PowerShell's .NET TcpClient is used instead of Bun.connect() because
 * Bun's socket.flush() returns undefined on Windows.
 *
 * On Linux (ARM appliance), the PowerShell path is skipped — `connectAndPrintLinux()`
 * is called directly via `Bun.connect()`.
 *
 * @param ip - Printer IP address
 * @param port - TCP port (normally {@link PRINTER_TCP_PORT} 9100)
 * @param data - Raw print command bytes to send
 * @param opts.skipAsb - When `true`, omit the StarIO ASB handshake.
 *   Use for printers that do not implement ASB (e.g. Star Graphic Mode raster
 *   jobs, or third-party ESC/POS hardware that interprets the handshake bytes
 *   as stray print data).  Defaults to `false` (handshake enabled).
 */
function connectAndPrint(ip: string, port: number, data: Buffer, opts?: { skipAsb?: boolean }): Promise<void> {
  // Log first 40 bytes hex for command diagnosis
  const preview = Array.from(data.subarray(0, Math.min(40, data.length)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
  console.log(`[printer] TCP sending to ${ip}:${port} (${data.length} bytes) asb=${!opts?.skipAsb}`)
  if (process.env.DEBUG_PRINT_MARKUP) {
    console.log(`[printer] First ${Math.min(40, data.length)} bytes: ${preview}`)
  }

  // Write data to a temp file, then have PowerShell read+send it
  const tmpFile = join(tmpdir(), `prn_${Date.now()}.bin`)
  writeFileSync(tmpFile, data)

  // On non-Windows platforms (ARM Linux appliance), use Bun.connect() directly.
  // socket.flush() works correctly on Linux; PowerShell is not available.
  if (process.platform !== 'win32') {
    return connectAndPrintLinux(ip, port, data)
  }

  const useAsb = !opts?.skipAsb

  // PowerShell script:
  // - Optionally sends StarIO ASB handshake first
  // - Sends print data
  // - Waits for printer to process before closing
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  $c = New-Object System.Net.Sockets.TcpClient('${ip}', ${port})
  $c.ReceiveTimeout = 2000
  $c.SendTimeout = 5000
  $s = $c.GetStream()
${useAsb ? `
  # StarIO ASB handshake
  $asb = [byte[]]@(0x1B, 0x06, 0x01)
  $s.Write($asb, 0, $asb.Length)
  $s.Flush()
  Write-Output "ASB_SENT"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt 1000) {
    if ($s.DataAvailable) {
      $buf = New-Object byte[] 256
      $n = $s.Read($buf, 0, 256)
      $hex = ($buf[0..($n-1)] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
      Write-Output "ASB_RECV:$n bytes [$hex]"
      break
    }
    Start-Sleep -Milliseconds 50
  }
` : '  Write-Output "NO_ASB"'}

  # Send print data
  $b = [System.IO.File]::ReadAllBytes('${tmpFile.replace(/\\/g, '\\\\')}')
  $s.Write($b, 0, $b.Length)
  $s.Flush()
  Write-Output "DATA_SENT:$($b.Length)"

  # Wait for printer to process (longer wait to ensure printing completes)
  Start-Sleep -Milliseconds 3000

  # Check for any response
  if ($s.DataAvailable) {
    $buf = New-Object byte[] 256
    $n = $s.Read($buf, 0, 256)
    $hex = ($buf[0..($n-1)] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
    Write-Output "RESPONSE:$n bytes [$hex]"
  }

  $c.Close()
  Write-Output "OK:$($b.Length)"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`
  return new Promise<void>(async (resolve, reject) => {
    try {
      const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      // Cleanup temp file
      try { unlinkSync(tmpFile) } catch {}

      // Log all output lines for diagnosis
      for (const line of stdout.trim().split('\n')) {
        if (line.trim()) console.log(`[printer] PS: ${line.trim()}`)
      }

      if (exitCode === 0) {
        resolve()
      } else {
        console.error(`[printer] PowerShell TCP error: ${stderr.trim()}`)
        reject(new Error(`Printer TCP error: ${stderr.trim()}`))
      }
    } catch (err) {
      try { unlinkSync(tmpFile) } catch {}
      reject(err)
    }
  })
}

// ---------------------------------------------------------------------------
// Linux TCP transport (Bun.connect — no PowerShell required)
// ---------------------------------------------------------------------------

/**
 * Send raw bytes to a printer via TCP using Bun.connect().
 *
 * Used on the ARM Linux appliance where PowerShell is not available.
 *
 * CRITICAL: socket.write() may not accept the full payload in one call —
 * it returns the number of bytes actually written.  For large raster jobs
 * (e.g. 78 KB bill), the kernel TCP send buffer fills up and the remainder
 * MUST be written in subsequent drain() callbacks.  If we don't do this,
 * the tail of the data (ESC * r B + cut command) is never sent and the
 * printer waits indefinitely for more data, appearing to "not print".
 *
 * We also wait for the `close` event before resolving — Star printers
 * process buffered data only after full TCP teardown.
 */
async function connectAndPrintLinux(ip: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

    // Overall timeout — covers connect + write + drain + close.
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`[printer] TCP timeout for ${ip}:${port}`)))
    }, 20_000)

    let offset = 0                                        // bytes written so far
    let endTimer: ReturnType<typeof setTimeout> | null = null

    function writeRemaining(socket: any) {
      while (offset < data.length) {
        const chunk = data.subarray(offset)
        const n = socket.write(chunk)
        if (n === 0) {
          // Buffer full — wait for drain to continue
          console.log(`[printer] Linux TCP: backpressure at ${offset}/${data.length} bytes`)
          return
        }
        offset += n
      }
      // All data written — flush and schedule FIN
      socket.flush()
      console.log(`[printer] Linux TCP: all ${offset} bytes written, scheduling end()`)
      if (endTimer) clearTimeout(endTimer)
      endTimer = setTimeout(() => {
        console.log(`[printer] Linux TCP: end() after 2 s post-write`)
        socket.end()
      }, 2_000)
    }

    Bun.connect({
      hostname: ip,
      port,
      socket: {
        open(socket) {
          writeRemaining(socket)
          // Fallback: if drain never fires AND writeRemaining didn't finish,
          // something is stuck — the overall 20 s timeout will catch it.
        },
        drain(socket) {
          if (offset < data.length) {
            // More data to send — continue writing
            writeRemaining(socket)
          }
          // If writeRemaining already scheduled the endTimer, do nothing.
        },
        error(_socket, err) {
          if (endTimer) clearTimeout(endTimer)
          clearTimeout(timer)
          settle(() => reject(err))
        },
        close() {
          // TCP fully torn down — printer will now process the buffered data.
          if (endTimer) clearTimeout(endTimer)
          clearTimeout(timer)
          console.log(`[printer] Linux TCP: close event → resolve (sent ${offset}/${data.length} bytes)`)
          settle(() => resolve())
        },
        data() {},   // ignore ACK/status bytes
      },
    }).catch(err => {
      if (endTimer) clearTimeout(endTimer)
      clearTimeout(timer)
      settle(() => reject(err))
    })
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test page
// ---------------------------------------------------------------------------

export type { TestPageOptions } from './print-types'

/**
 * Build the simplest possible test page: INIT → center → label text → cut.
 * Used to verify TCP connectivity and protocol selection without needing an order.
 */
export function buildTestPageText(opts: TestPageOptions): Buffer {
  const C    = getCmdSet(opts.printerProtocol)
  const proto = opts.printerProtocol ?? 'star-line'
  const label = opts.label ?? 'Printer'
  const now   = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  return Buffer.concat([
    C.INIT,
    C.FEED(PRINT_MARGIN_LINES),
    C.ALIGN_CENTER,
    C.BOLD_ON,
    C.SIZE_2X,
    txt('TEST'),
    C.SIZE_NORMAL,
    C.BOLD_OFF,
    txt(''),
    txt(label.toUpperCase() + ' PRINTER'),
    txt(opts.printerIp),
    txt(proto),
    txt(now),
    C.ALIGN_LEFT,
    divider(),
    txt('If you can read this, the printer is'),
    txt('configured correctly.'),
    C.FEED(PRINT_MARGIN_LINES),
    C.FULL_CUT,
  ])
}

/**
 * WebPRNT-with-raster-fallback helper.
 *
 * If WebPRNT returns 405/404 (not enabled on this printer), automatically
 * falls back to Star Graphic Mode raster bytes over TCP.  Raster mode
 * works on TSP100/TSP143 III regardless of firmware settings — it does not
 * depend on device fonts, which the TSP143 III lacks.
 *
 * **Lazy raster evaluation (ARC-06):** `rasterBuffer` is a thunk — it is only
 * called when the WebPRNT path fails.  If WebPRNT succeeds, the ~100ms
 * receiptline render is avoided entirely.  Call sites must always pass a
 * builder function, never a pre-computed Buffer.
 *
 * **Application-level printer errors (ARC-07):** sendWebPRNT() parses the XML
 * response and throws a plain Error (not WebPRNTNotEnabledError) for firmware
 * error conditions such as paper-out or paper-jam.  These are intentionally
 * re-thrown to the caller — they indicate a hardware fault that raster TCP
 * cannot resolve, so no fallback is attempted.
 *
 * @param ip           - Printer IP address
 * @param httpPort     - WebPRNT HTTP port (default 80)
 * @param xml          - WebPRNT XML payload
 * @param rasterBuffer - Lazy builder for the raster fallback payload (thunk)
 * @param tcpPort      - TCP raw-print port used when falling back (default 9100)
 */
async function webprntWithFallback(
  ip: string,
  httpPort: number | undefined,
  xml: string,
  rasterBuffer: () => Promise<Buffer>,
  tcpPort: number = PRINTER_TCP_PORT,
): Promise<{ webprntFallbackUsed: boolean }> {
  try {
    await sendWebPRNT(ip, xml, httpPort ?? 80)
    return { webprntFallbackUsed: false }
  } catch (err) {
    if (err instanceof WebPRNTNotEnabledError) {
      console.warn(`[printer] WebPRNT not available on ${ip}, falling back to Star Graphic Mode raster (TCP/${tcpPort})`)
      await connectAndPrint(ip, tcpPort, await rasterBuffer())
      return { webprntFallbackUsed: true }
    } else {
      throw err
    }
  }
}

export async function printTestPage(opts: TestPageOptions): Promise<void> {
  if (opts.printerProtocol === 'webprnt') {
    await webprntWithFallback(
      opts.printerIp, opts.printerPort,
      buildTestPageXml(opts),
      () => buildTestPageRaster(opts),
      PRINTER_TCP_PORT,
    )
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildTestPageRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildTestPageText(opts))
  }
}

/**
 * Diagnostic v3: Tests WebPRNT (HTTP) first, then raw TCP as fallback.
 *
 * The TSP100 III LAN's futurePRNT firmware intercepts port 9100 and routes
 * data through its processing pipeline.  Raw TCP printing only works if
 * the printer is configured with virtual TCP/IP ports or ESC/POS routing
 * via the futurePRNT Configuration Utility (Windows-only).
 *
 * WebPRNT (HTTP POST to the printer's built-in web server) is the correct
 * path for non-Windows apps.  Grubhub, Square, and other tablet POS apps
 * all use WebPRNT to print to the TSP100 III.
 *
 * Test sequence:
 *   1. HTTP probe — can we reach the printer's web server at all?
 *   2. WebPRNT test — POST XML to /StarWebPRNT/SendMessage
 *   3. Raw TCP fallback tests (in case WebPRNT isn't enabled)
 */
export interface DiagnosticResult {
  test: string
  success: boolean
  detail: string
}

export async function printDiagnostic(ip: string, port = PRINTER_TCP_PORT): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = []

  // ─── Test 1: HTTP probe — is the printer's web server reachable? ───
  console.log(`\n[printer] ═══ Diagnostic 1: HTTP probe http://${ip}/ ═══`)
  let httpReachable = false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(`http://${ip}/`, { signal: controller.signal })
    clearTimeout(timer)
    httpReachable = true
    const bodySnippet = await res.text().catch(() => '')
    const isStar = bodySnippet.includes('Star') || bodySnippet.includes('star') || bodySnippet.includes('TSP')
    console.log(`[printer] ✓ HTTP ${res.status} — ${isStar ? 'Star printer web UI detected' : 'web server responded'}`)
    results.push({
      test: 'HTTP probe',
      success: true,
      detail: `HTTP ${res.status}${isStar ? ' — Star printer web UI detected' : ''}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[printer] ✗ HTTP probe failed: ${msg}`)
    results.push({
      test: 'HTTP probe',
      success: false,
      detail: `Cannot reach http://${ip}/ — ${msg.includes('abort') ? 'timeout (4s)' : msg}`,
    })
  }

  // ─── Test 2: WebPRNT — the recommended path for TSP100 III LAN ───
  console.log(`\n[printer] ═══ Diagnostic 2: WebPRNT (HTTP POST) ═══`)
  try {
    const xml = buildTestPageXml({ printerIp: ip, label: 'Diagnostic' })
    await sendWebPRNT(ip, xml, 80, 6000)
    console.log(`[printer] ✓ WebPRNT succeeded — receipt should print now`)
    results.push({
      test: 'WebPRNT (HTTP)',
      success: true,
      detail: 'WebPRNT XML accepted by printer — this is the correct protocol',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isNotEnabled = err instanceof WebPRNTNotEnabledError
    console.log(`[printer] ✗ WebPRNT failed: ${msg}`)
    results.push({
      test: 'WebPRNT (HTTP)',
      success: false,
      detail: isNotEnabled
        ? 'WebPRNT not enabled. Open http://' + ip + '/ in browser, login (root/public), enable WebPRNT.'
        : msg,
    })
  }

  // ─── Test 3: Raw TCP with TSP100 Star Line commands ───
  console.log(`\n[printer] ═══ Diagnostic 3: Raw TCP (TSP100 Star Line) ═══`)
  try {
    const data = Buffer.concat([
      TSP100_STAR_CMD.INIT,
      TSP100_STAR_CMD.FEED(3),
      TSP100_STAR_CMD.ALIGN_CENTER,
      TSP100_STAR_CMD.BOLD_ON,
      TSP100_STAR_CMD.SIZE_2X,
      txt('TCP TEST'),
      TSP100_STAR_CMD.SIZE_NORMAL,
      TSP100_STAR_CMD.BOLD_OFF,
      txt(''),
      txt('TSP100 Star Line commands'),
      txt('Raw TCP port 9100'),
      txt(ip),
      txt(new Date().toLocaleTimeString('en-US')),
      TSP100_STAR_CMD.ALIGN_LEFT,
      divider(),
      txt('If this printed, use "TSP100 III (TCP)"'),
      txt('protocol in Settings.'),
      TSP100_STAR_CMD.FEED(5),
      TSP100_STAR_CMD.FULL_CUT,
    ])
    await connectAndPrint(ip, port, data, { skipAsb: true })
    console.log(`[printer] ✓ TCP data sent (no ASB) — check if receipt printed`)
    results.push({
      test: 'Raw TCP (no ASB)',
      success: true,
      detail: 'Data sent successfully — check printer for output',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[printer] ✗ Raw TCP failed: ${msg}`)
    results.push({
      test: 'Raw TCP (no ASB)',
      success: false,
      detail: msg,
    })
  }

  // ─── Test 4: Raw TCP WITH StarIO ASB handshake ───
  console.log(`\n[printer] ═══ Diagnostic 4: Raw TCP + ASB handshake ═══`)
  try {
    const data = Buffer.concat([
      TSP100_STAR_CMD.INIT,
      TSP100_STAR_CMD.FEED(3),
      TSP100_STAR_CMD.ALIGN_CENTER,
      TSP100_STAR_CMD.BOLD_ON,
      TSP100_STAR_CMD.SIZE_2X,
      txt('TCP+ASB TEST'),
      TSP100_STAR_CMD.SIZE_NORMAL,
      TSP100_STAR_CMD.BOLD_OFF,
      txt(''),
      txt('TSP100 Star Line + ASB handshake'),
      txt('Raw TCP port 9100'),
      txt(ip),
      txt(new Date().toLocaleTimeString('en-US')),
      TSP100_STAR_CMD.ALIGN_LEFT,
      divider(),
      txt('If this printed, use "TSP100 III (TCP)"'),
      txt('protocol in Settings.'),
      TSP100_STAR_CMD.FEED(5),
      TSP100_STAR_CMD.FULL_CUT,
    ])
    await connectAndPrint(ip, port, data, { skipAsb: false })
    console.log(`[printer] ✓ TCP+ASB data sent — check if receipt printed`)
    results.push({
      test: 'Raw TCP (with ASB)',
      success: true,
      detail: 'Data sent successfully — check printer for output',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[printer] ✗ TCP+ASB failed: ${msg}`)
    results.push({
      test: 'Raw TCP (with ASB)',
      success: false,
      detail: msg,
    })
  }

  // ─── Test 5: Star Graphic Mode raster (receiptline) ───
  console.log(`\n[printer] ═══ Diagnostic 5: Star Graphic Mode raster (TCP/9100) ═══`)
  try {
    const data = await buildTestPageRaster({
      printerIp: ip,
      printerProtocol: 'star-graphic',
      label: 'Diagnostic Raster',
    })
    await connectAndPrint(ip, port, data, { skipAsb: true })
    console.log(`[printer] ✓ Star Graphic raster data sent — check if receipt printed`)
    results.push({
      test: 'Star Graphic raster',
      success: true,
      detail: 'Raster data sent — if printed, use "Star Graphic (TSP143 III)" protocol',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[printer] ✗ Star Graphic raster failed: ${msg}`)
    results.push({
      test: 'Star Graphic raster',
      success: false,
      detail: msg,
    })
  }

  // ─── Summary ───
  console.log(`\n[printer] ═══ Diagnostic complete — ${results.length} tests ═══`)
  for (const r of results) {
    console.log(`[printer]   ${r.success ? '✓' : '✗'} ${r.test}: ${r.detail}`)
  }

  return results
}

/**
 * Print a kitchen ticket.
 *
 * **receiptStyle='html' (ARC-05):** The HTML rendering path is only engaged
 * when `printerProtocol` is `'star-graphic'` or `'webprnt'` — both support
 * bitmap raster transport.  Text-mode protocols (`star-line`, `star-line-tsp100`,
 * `generic-escpos`) always use classic command-set rendering regardless of
 * `receiptStyle`.  Setting `receipt_style = 'html'` on a merchant with a
 * TSP700II (star-line) has no effect.
 */
export async function printKitchenTicket(opts: KitchenTicketOptions): Promise<{ webprntFallbackUsed: boolean }> {
  const useHtml = opts.receiptStyle === 'html' &&
    (opts.printerProtocol === 'star-graphic' || opts.printerProtocol === 'webprnt')
  if (useHtml) {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT,
      await renderHtmlToRasterBuffer(buildKitchenTicketHtml(opts)))
    return { webprntFallbackUsed: false }
  }
  if (opts.printerProtocol === 'webprnt') {
    return webprntWithFallback(
      opts.printerIp, opts.printerPort,
      buildKitchenTicketXml(opts),
      () => buildKitchenTicketRaster(opts),
      PRINTER_TCP_PORT,
    )
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildKitchenTicketRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildKitchenTicket(opts))
  }
  return { webprntFallbackUsed: false }
}

export async function printCounterTicket(opts: CounterTicketOptions): Promise<{ webprntFallbackUsed: boolean }> {
  const useHtml = opts.receiptStyle === 'html' &&
    (opts.printerProtocol === 'star-graphic' || opts.printerProtocol === 'webprnt')
  if (useHtml) {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT,
      await renderHtmlToRasterBuffer(buildCounterTicketHtml(opts)))
    return { webprntFallbackUsed: false }
  }
  if (opts.printerProtocol === 'webprnt') {
    return webprntWithFallback(
      opts.printerIp, opts.printerPort,
      buildCounterTicketXml(opts),
      () => buildCounterTicketRaster(opts),
      PRINTER_TCP_PORT,
    )
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildCounterTicketRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildCounterTicket(opts))
  }
  return { webprntFallbackUsed: false }
}

export async function printCustomerReceipt(opts: CustomerReceiptOptions): Promise<{ webprntFallbackUsed: boolean }> {
  const useHtml = opts.receiptStyle === 'html' &&
    (opts.printerProtocol === 'star-graphic' || opts.printerProtocol === 'webprnt')
  console.log(`[printer] Customer receipt: style=${opts.receiptStyle} protocol=${opts.printerProtocol} → ${useHtml ? 'HTML/Puppeteer' : 'star-raster'}`)
  if (useHtml) {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT,
      await renderHtmlToRasterBuffer(buildCustomerReceiptHtml(opts)))
    return { webprntFallbackUsed: false }
  }
  if (opts.printerProtocol === 'webprnt') {
    return webprntWithFallback(
      opts.printerIp, opts.printerPort,
      buildCustomerReceiptXml(opts),
      () => buildCustomerReceiptRaster(opts),
      PRINTER_TCP_PORT,
    )
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildCustomerReceiptRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildCustomerReceipt(opts))
  }
  return { webprntFallbackUsed: false }
}

export async function printCustomerBill(opts: CustomerBillOptions): Promise<{ webprntFallbackUsed: boolean }> {
  const useHtml = opts.receiptStyle === 'html' &&
    (opts.printerProtocol === 'star-graphic' || opts.printerProtocol === 'webprnt')
  console.log(`[printer] Customer bill: style=${opts.receiptStyle} protocol=${opts.printerProtocol} ip=${opts.printerIp} → ${useHtml ? 'HTML/Puppeteer' : opts.printerProtocol === 'star-graphic' ? 'star-raster' : 'text-mode'}`)
  if (useHtml) {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT,
      await renderHtmlToRasterBuffer(buildCustomerBillHtml(opts)))
    return { webprntFallbackUsed: false }
  }
  if (opts.printerProtocol === 'webprnt') {
    return webprntWithFallback(
      opts.printerIp, opts.printerPort,
      buildCustomerBillXml(opts),
      () => buildCustomerBillRaster(opts),
      PRINTER_TCP_PORT,
    )
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildCustomerBillRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildCustomerBill(opts))
  }
  return { webprntFallbackUsed: false }
}

// ---------------------------------------------------------------------------
// Gift card receipt — text-mode builder
// ---------------------------------------------------------------------------

/**
 * Build raw bytes for a gift card purchase receipt (text-mode protocols).
 *
 * Printed to the receipt printer when a gift card purchase is confirmed, or
 * on-demand from the dashboard Gift Cards tab.  Shows each card code, face
 * value, balance, purchaser name, optional recipient name, and expiry.
 */
export function buildGiftCardReceiptText(opts: GiftCardReceiptOptions): Buffer {
  const C = getCmdSet(opts.printerProtocol)
  const fmtCents = (c: number) => '$' + (c / 100).toFixed(2).replace(/\.00$/, '')
  const fmtExpiry = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const parts: Buffer[] = [
    C.INIT,
    C.FEED(PRINT_MARGIN_LINES),
    C.ALIGN_CENTER,
    C.BOLD_ON,
    txt(opts.merchantName),
    C.BOLD_OFF,
    divider('='),
    C.BOLD_ON,
    txt('  GIFT CARD'),
    C.BOLD_OFF,
    divider('='),
    C.ALIGN_LEFT,
  ]

  for (const card of opts.cards) {
    parts.push(
      rpad('  Code:', card.code),
      rpad('  Value:', fmtCents(card.faceValueCents)),
      rpad('  Balance:', fmtCents(card.balanceCents)),
      rpad('  Expires:', fmtExpiry(card.expiresAt)),
      divider(),
    )
  }

  parts.push(rpad('  Purchased by:', opts.purchaserName))
  if (opts.recipientName) {
    parts.push(rpad('  For:', opts.recipientName))
  }

  parts.push(
    divider('='),
    C.ALIGN_CENTER,
    txt('Thank you!'),
    C.ALIGN_LEFT,
    C.FEED(PRINT_MARGIN_LINES),
    C.FULL_CUT,
  )

  return Buffer.concat(parts)
}

/**
 * Print a gift card purchase receipt to the receipt printer.
 *
 * Dispatches to the correct rendering path based on the printer protocol:
 *   star-graphic / webprnt → raster (receiptline)
 *   star-line / star-line-tsp100 / generic-escpos → text-mode bytes
 */
export async function printGiftCardReceipt(opts: GiftCardReceiptOptions): Promise<void> {
  if (opts.printerProtocol === 'webprnt') {
    // For gift cards, use raster directly rather than a WebPRNT XML builder.
    // webprntWithFallback's raster path (TCP/9100) is equivalent and simpler here.
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildGiftCardReceiptRaster(opts))
  } else if (opts.printerProtocol === 'star-graphic') {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, await buildGiftCardReceiptRaster(opts))
  } else {
    await connectAndPrint(opts.printerIp, opts.printerPort ?? PRINTER_TCP_PORT, buildGiftCardReceiptText(opts))
  }
}
