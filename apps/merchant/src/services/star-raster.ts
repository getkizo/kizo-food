/**
 * Star Graphic Mode (raster) receipt rendering via receiptline v4 + sharp
 *
 * The TSP100/TSP143 III has NO device font ROM — text commands (Star Line Mode,
 * ESC/POS) are silently ignored.  The only working TCP path is Star Graphic
 * Mode (raster), which sends a bitmap the printer paints dot-by-dot.
 *
 * Pipeline (mirrors receiptline's designer.js `asImage: true` path):
 *   1. receiptline.transform(markup, { command: 'svg' })  → SVG string
 *   2. sharp(svg).png()                                    → PNG buffer
 *   3. receiptline.transform(`{i:base64}`, stargraphic)   → Star Graphic bytes
 *
 * receiptline's stargraphic command has NO text renderer — text elements are
 * silently no-ops.  Only {image} elements produce bitmap data.  Step 1+2
 * converts all text to a PNG image; step 3 dithers that PNG into the
 * Star Graphic Mode byte stream the printer understands.
 *
 * Usage:
 *   const bytes = await buildStarGraphicBytes(buildKitchenTicketMarkup(opts))
 *   await connectAndPrint(ip, 9100, bytes)
 *
 * Ticket types:
 *   buildKitchenTicketMarkup()   — Kitchen copy: large text, inverted modifiers, no prices
 *   buildCounterTicketMarkup()   — Counter copy: large text (no subtotalCents) OR
 *                                  branded takeout bag receipt (with subtotalCents)
 *   buildCustomerBillMarkup()    — Pre-payment check: logo, items, tip table, write-in lines
 *   buildCustomerReceiptMarkup() — Post-payment receipt: logo, totals, tip, sig note
 *
 * Receiptline markup key:
 *   `text`          — inverted (white-on-black) text; used for modifier labels in kitchen
 *                     and counter tickets so they stand out from item names at a glance.
 *                     Wrap user content with backticks: e.g. `` `No onion` `` →
 *                     prints as a dark badge. Backticks inside the content must be escaped.
 *   "text"          — bold text (double-quote wraps).
 *   ^^text          — 2× scale; ^^^text — 3× scale (prefix carets, rest-of-line).
 *   {align:center}  — alignment property; MUST be on its own line (not inline with text).
 *   {width:*,N}     — two-column row; N is right-column char width; line: `left|right`.
 *   -               — thin rule.
 *   {cut}           — explicit paper cut.
 *
 * References:
 *   https://github.com/receiptline/receiptline  (designer.js rasterize())
 *   https://github.com/receiptline/receiptline/issues/8 (TSP100IIILAN confirmed)
 */

// receiptline is CJS — Bun handles the interop
import receiptline from 'receiptline'
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sortItemsByCourse, kitchenItems } from '../utils/course-items'
import { LANG, type Lang } from './print-lang'
import type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions, TestPageOptions, GiftCardReceiptOptions } from './print-types'

/** Options for the SVG render step (text → vector). */
const SVG_RENDER_OPTIONS = {
  command:  'svg' as const,
  cpl:      42,             // characters per line (Font A, 80mm)
  encoding: 'multilingual',
  spacing:  true,           // add inter-line spacing — improves readability
}

/** Options for the Star Graphic Mode encode step (PNG → raster bytes). */
const STAR_GRAPHIC_OPTIONS = {
  command:   'stargraphic' as const,
  cpl:       42,
  encoding:  'multilingual',
  gradient:  false,         // pure black/white — required for thermal raster
  threshold: 210,           // raised from 128 default: SVG text is anti-aliased (grey ~180–220),
                            // so threshold must exceed those grey values to produce solid black dots
}

/**
 * Printable dot width for the TSP100/TSP143 III (80mm paper, 203 DPI).
 *
 * 80mm × (203 dpi / 25.4 mm/in) = 640 total dots, ~576 printable dots.
 *
 * The receiptline stargraphic encoder writes the PNG 1:1 — one PNG pixel
 * becomes one printer dot.  Setting this to exactly 576 ensures every pixel
 * lands on paper.  Using 2× (1152) caused the right half to fall off-paper
 * because the physical print head is only 576 dots wide.
 */
const PRINTER_DOT_WIDTH = 576

/**
 * Convert receiptline markup to Star Graphic Mode bytes ready to send via TCP.
 *
 * Async because sharp's SVG→PNG conversion is asynchronous.
 */
/** NF-4.1: Maximum receiptline markup size before refusing to rasterize.
 * A large order (100+ items) or abnormally long item names can produce an SVG
 * hundreds of KB in size; sharp's librsvg rasterizer is memory-intensive and
 * can exhaust the 4GB ARM node's RAM on a single malformed ticket.
 */
const MAX_MARKUP_BYTES = 512_000

/** NF-4.1: Timeout for the sharp rasterization pipeline. */
const SHARP_TIMEOUT_MS = 30_000

export async function buildStarGraphicBytes(markup: string, cpl = 42): Promise<Buffer> {
  // NF-4.1: Guard against pathologically large markup
  if (markup.length > MAX_MARKUP_BYTES) {
    console.warn(`[star-raster] markup too large (${markup.length} chars > ${MAX_MARKUP_BYTES}), refusing to rasterize`)
    throw new Error(`Receipt markup exceeds size limit (${markup.length} chars)`)
  }

  // Full markup dump — only when DEBUG_PRINT_MARKUP is set (can be verbose / PII-sensitive)
  if (process.env.DEBUG_PRINT_MARKUP) {
    console.log('[star-raster] markup ─────────────────────────────────────')
    console.log(markup)
    console.log('[star-raster] ─────────────────────────────────────────────')
  }

  // Step 1: render markup to SVG
  const svgOptions = cpl === 42 ? SVG_RENDER_OPTIONS : { ...SVG_RENDER_OPTIONS, cpl }
  const svg = receiptline.transform(markup, svgOptions)
  console.log(`[star-raster] SVG length: ${svg.length} chars`)

  // Step 2: rasterize SVG to PNG via sharp (librsvg, ARM-safe, no headless browser).
  // Resize to PRINTER_DOT_WIDTH wide, preserving aspect ratio (height adjusts to
  // accommodate the full receipt).  White background prevents transparent areas
  // becoming black after binarisation.
  // NF-4.1: Race against a timeout to prevent unbounded CPU/memory usage.
  const png = await Promise.race([
    sharp(Buffer.from(svg))
      .resize(PRINTER_DOT_WIDTH, undefined, {
        fit:        'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .png()
      .toBuffer(),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`[star-raster] sharp rasterization timed out after ${SHARP_TIMEOUT_MS}ms`)), SHARP_TIMEOUT_MS)
    ),
  ])

  // NF-4.3: Wrap metadata call — a corrupt/empty PNG from receiptline would
  // otherwise throw an unhandled error and crash the print handler.
  let meta: { width?: number; height?: number }
  try {
    meta = await sharp(png).metadata()
  } catch (err) {
    console.error(`[star-raster] PNG metadata read failed (SVG length=${svg.length}):`, err)
    throw new Error('[star-raster] PNG metadata read failed — SVG may be empty or corrupt')
  }
  console.log(`[star-raster] PNG ${meta.width}×${meta.height} px, ${png.length} bytes`)
  const base64 = png.toString('base64')

  // Step 3: encode PNG as Star Graphic Mode bytes.
  //
  // IMPORTANT — do NOT use `|{i:...}` here.  The leading `|` creates a
  // two-column table (empty left | image right), squishing the receipt into
  // the right half of the paper.  Use a bare `{i:...}` line so the image
  // occupies the full paper width.
  //
  // The `{cut}` in the per-ticket markup becomes a scissors icon in the SVG
  // (visual only).  The `\n{cut}` here generates the actual paper-cut command
  // in the Star Graphic byte stream.
  const result = receiptline.transform(`{i:${base64}}\n{cut}`, STAR_GRAPHIC_OPTIONS)
  // NF-4.4: receiptline stargraphic returns a Latin-1 encoded string (byte-per-char).
  // 'latin1' is the explicit alias for this encoding; 'binary' is a deprecated alias.
  const bytes = Buffer.from(result, 'latin1')
  console.log(`[star-raster] stargraphic bytes: ${bytes.length}`)
  return bytes
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

function loadLogoB64(filename: string): string {
  try {
    return readFileSync(join(import.meta.dir, '../assets/printers', filename), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Monochrome logo, black on white — for check and receipt header */
const LOGO_SM  = loadLogoB64('logo-sm-b64.txt')
/** Inverted logo, white on black — for takeout bag header */
const LOGO_INV = loadLogoB64('logo-inv-b64.txt')

if (!LOGO_SM)  console.warn('[star-raster] logo-sm-b64.txt not found — receipts will print without logo')
if (!LOGO_INV) console.warn('[star-raster] logo-inv-b64.txt not found — takeout tickets will print without logo')

/**
 * Returns a receiptline `{i:base64}` image line, or empty string if the logo
 * file was not loaded.  Must be placed on its own line in the markup.
 */
function logoBlock(useInverted = false): string {
  const b64 = useInverted ? LOGO_INV : LOGO_SM
  return b64 ? `{i:${b64}}` : ''
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

/** Escape receiptline special characters in raw text content. */
function rl(s: string): string {
  return s.replace(/[{}\\|]/g, '\\$&')
}

/**
 * Wrap an already-escaped receiptline string in bold decorator `"..."`.
 * The `"` character is the receiptline bold toggle, so any `"` in the
 * content must be escaped as `\x22`.
 *
 * Pass the result of `rl(s)` (or a literal with already-escaped specials).
 */
function bold(escaped: string): string {
  return '"' + escaped.replace(/"/g, '\\x22') + '"'
}

/** Format cents as "$12.50". */
function fmtCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

/**
 * Two-column line: left fills remaining width, right is fixed to its content length.
 *
 * IMPORTANT (receiptline v4): the `{property}` block MUST be on its own line —
 * a line like `{width:*,6}text|right` is silently discarded as an error.
 * This function always emits the property on line N and the columns on line N+1.
 *
 * Pass `style='bold'` to wrap the left column in bold decorator `"..."`.
 * Other style values (e.g. `'size:2'`) are forwarded to the property block as
 * unknown keys — receiptline ignores them silently (no error), so they are
 * harmless but have no visible effect.
 */
function row(left: string, right: string, style?: string): string {
  const isBold = style?.includes('bold') ?? false
  // Remove 'bold' from the property block — it is handled as a text decorator,
  // not a receiptline property key.
  const cleanStyle = style
    ?.split(';').map(s => s.trim()).filter(s => s !== 'bold' && s !== '').join(';') || ''
  const stylePrefix = cleanStyle ? `${cleanStyle};` : ''
  const l = isBold ? bold(rl(left)) : rl(left)
  const r = rl(right)
  // Trailing space on left col → left-aligned; leading space on right col → right-aligned.
  // Without explicit spaces, receiptline's auto-detection reverses the alignment.
  // {width:auto} resets column state so subsequent single-column lines are not
  // rendered as phantom two-column rows.
  return `{${stylePrefix}width:*,${right.length}}\n${l} | ${r}\n{width:auto}`
}

// ---------------------------------------------------------------------------
// Date / time helpers (match printer.ts)
// ---------------------------------------------------------------------------

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

/** Blank lines used as top/bottom margin (paper feeds through printer head). */
const MARGIN_LINES = 1

function margin(): string {
  return '\n'.repeat(MARGIN_LINES)
}

// ---------------------------------------------------------------------------
// Types — re-exported from print-types (single source of truth)
// ---------------------------------------------------------------------------

export type { PrintItem, KitchenTicketOptions, CounterTicketOptions, CustomerReceiptOptions, CustomerBillOptions, TestPageOptions } from './print-types'

// ---------------------------------------------------------------------------
// Kitchen ticket — large text, inverted modifiers, no prices
// ---------------------------------------------------------------------------

export function buildKitchenTicketMarkup(opts: KitchenTicketOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)

  // Apply course sorting and strip counter-only items
  const sortedItems = sortItemsByCourse(kitchenItems(opts.items))

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn.toUpperCase()  :
    opts.orderType === 'delivery' ? L.delivery.toUpperCase() : L.takeout.toUpperCase()
  const typeLabelMixed =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const lines: string[] = [
    '',
    // Property MUST be on its own line — inline `{property}text` is silently
    // discarded by receiptline.  Bold uses the `"text"` decorator; scale uses
    // `^` prefixes (^^^= roughly triple-height on the printer image).
    '{align:center}',
    `^^^${bold(rl(typeLabel))}`,
    '{align:left}',
    '=',
    row(`#${shortId}`, time, 'size:2'),
  ]

  const locParts: string[] = []
  if (opts.roomLabel)  locParts.push(rl(opts.roomLabel))
  if (opts.tableLabel) locParts.push(`Table ${rl(opts.tableLabel)}`)
  const locationLine = locParts.length > 0
    ? `${rl(typeLabelMixed)} -- ${locParts.join(' / ')}`
    : rl(typeLabelMixed)
  lines.push(`^^${bold(locationLine)}`)

  if (opts.customerName && opts.orderType !== 'dine_in' && opts.customerName !== 'Dine-in') {
    lines.push(`^^${rl(opts.customerName)}`)
  }

  lines.push('=')

  for (const item of sortedItems) {
    lines.push(`^^${bold(` ${item.quantity}  ${rl(item.dishName)}`)}`)
    if ((item.modifiers?.length ?? 0) > 0) {
      for (const mod of item.modifiers!) {
        // Inverted (white on black) for high kitchen visibility
        lines.push(`^^   \`${rl(mod.name)}\``)
      }
    }

    if (item.specialInstructions) {
      lines.push(`^^   ${bold('>> ' + rl(item.specialInstructions))}`)
    }
    if (item.serverNotes) {
      lines.push(`^^   ${bold('* ' + rl(item.serverNotes))}`)
    }
  }

  lines.push('-')

  if (opts.notes) {
    lines.push(
      `^^${bold(rl(L.note))}: ${rl(opts.notes)}`,
      '-',
    )
  }

  // 12 blank lines (~240px @ cpl=42/~20px per line) clears the TSP100 III
  // platen-to-cutter gap (~30mm / 240 dots) before the cut fires.
  lines.push('', '', '', '', '', '', '', '', '', '', '', '')
  lines.push('{align:left}')
  lines.push(margin())
  return lines.join('\n')
}

export function buildKitchenTicketRaster(opts: KitchenTicketOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildKitchenTicketMarkup(opts))
}

// ---------------------------------------------------------------------------
// Counter ticket — standard server copy OR branded takeout bag receipt
// ---------------------------------------------------------------------------

export function buildCounterTicketMarkup(opts: CounterTicketOptions): string {
  return opts.subtotalCents !== undefined
    ? buildTakeoutBagMarkup(opts as CounterTicketOptions & { subtotalCents: number })
    : buildStandardCounterMarkup(opts)
}

/**
 * Standard dine-in counter copy — large text, inverted modifiers, no prices.
 * Used by servers to verify food at the table.
 */
function buildStandardCounterMarkup(opts: CounterTicketOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)

  const typeLabelMixed =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const lines: string[] = [
    '',
    '{align:center}',
    `^^^${bold(rl(L.counter))}`,
    '{align:left}',
    '-',
    row(`#${shortId}`, time, 'size:2'),
  ]

  const locParts: string[] = []
  if (opts.roomLabel)  locParts.push(rl(opts.roomLabel))
  if (opts.tableLabel) locParts.push(`Table ${rl(opts.tableLabel)}`)
  const locationLine = locParts.length > 0
    ? `${rl(typeLabelMixed)} -- ${locParts.join(' / ')}`
    : rl(typeLabelMixed)
  lines.push(`^^${bold(locationLine)}`)

  if (opts.customerName && opts.orderType !== 'dine_in' && opts.customerName !== 'Dine-in') {
    lines.push(`^^^${bold(rl(opts.customerName))}`)
  }

  if (opts.pickupCode) {
    lines.push(`^^^${bold('CODE: ' + rl(opts.pickupCode))}`)
    lines.push('=')
  } else {
    lines.push('-')
  }

  for (const item of opts.items) {
    lines.push(`^^${bold(` ${item.quantity}  ${rl(item.dishName)}`)}`)
    if ((item.modifiers?.length ?? 0) > 0) {
      for (const mod of item.modifiers!) {
        // Inverted for easy scanning when packing the order
        lines.push(`^^   \`${rl(mod.name)}\``)
      }
    }

    if (item.dishLabel) {
      lines.push(`^^   ${bold(rl(item.dishLabel))}`)
    }
    if (item.specialInstructions) {
      lines.push(`^^   ${bold('>> ' + rl(item.specialInstructions))}`)
    }
    if (item.serverNotes) {
      lines.push(`^^   ${bold('* ' + rl(item.serverNotes))}`)
    }
  }

  lines.push('-')

  if (opts.notes) {
    lines.push(
      `^^${bold(rl(L.note))}: ${rl(opts.notes)}`,
      '-',
    )
  }

  if (opts.utensilsNeeded) {
    lines.push(`^^${bold(rl(L.utensils))}`, '-')
  }

  // 12 blank lines (~240px @ cpl=42/~20px per line) clears the TSP100 III
  // platen-to-cutter gap (~30mm / 240 dots) before the cut fires.
  lines.push('', '', '', '', '', '', '', '', '', '', '', '')
  lines.push('{align:left}')
  lines.push(margin())
  return lines.join('\n')
}

/**
 * Branded takeout/bag receipt — inverted logo, items with prices, PAID footer.
 * Stapled to the bag so the customer can verify their order.
 */
function buildTakeoutBagMarkup(opts: CounterTicketOptions & { subtotalCents: number }): string {
  const L        = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId  = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time     = fmtTime(opts.createdAt)
  const date     = fmtDate(opts.createdAt)
  const taxCents = opts.taxCents ?? 0
  const totalCents = opts.subtotalCents + taxCents
  const paidCents  = opts.paidAmountCents ?? totalCents

  const orderLabel =
    opts.orderType === 'delivery' ? L.delivery.toUpperCase() : L.takeout.toUpperCase()

  const lines: string[] = [margin()]

  // Branded header — inverted logo + merchant name + contact
  const logo = logoBlock(true)
  lines.push('{align:center}')
  if (logo) lines.push(logo)
  if (opts.merchantName) lines.push(`^^${bold(rl(opts.merchantName))}`)
  if (opts.address)      lines.push(rl(opts.address))
  if (opts.phoneNumber)  lines.push(rl(opts.phoneNumber))

  lines.push('')
  lines.push(`^^^${bold(rl(orderLabel))}`)
  lines.push('{align:left}')
  lines.push('-')

  // Order info
  lines.push(row(`#${shortId}`, time))
  lines.push(rl(date))
  if (opts.customerName && opts.customerName !== 'Dine-in') {
    lines.push(`^^^${bold(rl(opts.customerName))}`)
  }
  if (opts.pickupCode) {
    lines.push(`^^^${bold('CODE: ' + rl(opts.pickupCode))}`)
  }
  lines.push('-')
  lines.push('')

  // Items with prices
  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    lines.push(row(` ${item.quantity}x  ${item.dishName}`, fmtCents(lineTotal)))
    if (item.quantity > 1) {
      lines.push(`        @ ${fmtCents(item.priceCents)} each`)
    }
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        lines.push(row(`        ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        lines.push(`        ${rl(mod.name)}`)
      }
    }

    if (item.dishLabel) {
      lines.push(`        ${rl(item.dishLabel)}`)
    }
    if (item.specialInstructions) {
      lines.push(`        >> ${rl(item.specialInstructions)}`)
    }
  }

  lines.push('')

  if (opts.notes) {
    lines.push(`^^${bold(rl(L.note))}: ${rl(opts.notes)}`)
  }

  if (opts.utensilsNeeded) {
    lines.push(`^^${bold(rl(L.utensils))}`)
  }

  lines.push('-')

  // Totals
  lines.push(row(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))
  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  lines.push(row(`  ${L.tax}${taxPct}`, fmtCents(taxCents)))
  if (opts.tipCents && opts.tipCents > 0) {
    lines.push(row(`  ${L.tip}`, fmtCents(opts.tipCents)))
  }
  lines.push('-')
  lines.push(row(`  ${L.total}`, fmtCents(paidCents), 'bold'))
  lines.push('-')

  // Payment footer
  lines.push('{align:center}')
  lines.push(`^${bold(`${rl(L.paid)}  ${fmtCents(paidCents)}`)}`)
  lines.push(rl(L.paidByCard))
  lines.push('')
  lines.push('-')

  // Thank you + website
  lines.push(`^${rl(L.thankYou)}`)
  if (opts.website) {
    const displayUrl = opts.website.replace(/^https?:\/\//, '')
    lines.push(rl(displayUrl))
  }
  // 12 blank lines (~240px @ cpl=42/~20px per line) clears the TSP100 III
  // platen-to-cutter gap (~30mm / 240 dots) before the cut fires.
  lines.push('', '', '', '', '', '', '', '', '', '', '', '')
  lines.push('{align:left}')
  lines.push(margin())

  return lines.join('\n')
}

export function buildCounterTicketRaster(opts: CounterTicketOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildCounterTicketMarkup(opts))
}

// ---------------------------------------------------------------------------
// Customer receipt — post-payment, with logo, tip line, and signature note
// ---------------------------------------------------------------------------

export function buildCustomerReceiptMarkup(opts: CustomerReceiptOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)
  const date    = fmtDate(opts.createdAt)

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const lines: string[] = [margin()]

  // Header — logo + merchant name + contact
  const logo = logoBlock(false)
  lines.push('{align:center}')
  if (logo) lines.push(logo)
  lines.push(bold(rl(opts.merchantName ?? L.receipt)))
  if (opts.address)     lines.push(rl(opts.address))
  if (opts.phoneNumber) lines.push(rl(opts.phoneNumber))

  lines.push(
    '{align:left}',
    '-',
    row(`${L.order} #${shortId}`, typeLabel),
    row(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time),
  )

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    lines.push(`${rl(L.customer)}: ${rl(opts.customerName)}`)
  }

  lines.push('-')

  // Items
  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    lines.push(row(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        lines.push(row(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        lines.push(`       ${rl(mod.name)}`)
      }
    }
  }

  lines.push('-')
  lines.push(row(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  if ((opts.discountCents ?? 0) > 0) {
    const discLabel = opts.discountLabel ? ` (${rl(opts.discountLabel)})` : ''
    lines.push(row(`  Discount${discLabel}`, `-${fmtCents(opts.discountCents!)}`))
  }

  if ((opts.serviceChargeCents ?? 0) > 0) {
    const scLabel = opts.serviceChargeLabel ? ` (${rl(opts.serviceChargeLabel)})` : ''
    lines.push(row(`  Service Charge${scLabel}`, fmtCents(opts.serviceChargeCents!)))
  }

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  lines.push(row(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  if (opts.tipCents && opts.tipCents > 0) {
    lines.push(row(`  ${L.tip}`, fmtCents(opts.tipCents)))
  }

  lines.push(
    '-',
    row(`  ${L.total}`, fmtCents(opts.paidAmountCents), 'bold'),
    '-',
    '{align:center}',
    bold(`${rl(L.paid)}  ${fmtCents(opts.paidAmountCents)}`),
    rl(L.paidByCard),
    '',
    rl(L.sigNote),
    '-',
  )

  // Footer
  if (opts.website) {
    const displayUrl = opts.website.replace(/^https?:\/\//, '')
    lines.push(rl(displayUrl))
  }

  lines.push(
    '',
    rl(L.thankYou),
    // 9 blank lines (~252px @ 28px/line) ensures the last printed pixel clears
    // the TSP100 III platen-to-cutter gap (~30mm / 240 dots) before the cut fires.
    '', '', '', '', '', '', '', '', '',
    '{align:left}',
    margin(),
  )

  return lines.join('\n')
}

export function buildCustomerReceiptRaster(opts: CustomerReceiptOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildCustomerReceiptMarkup(opts), 28)
}

// ---------------------------------------------------------------------------
// Customer bill — pre-payment check with logo + suggested tip table
// ---------------------------------------------------------------------------

export function buildCustomerBillMarkup(opts: CustomerBillOptions): string {
  const L       = LANG[(opts.printLanguage ?? 'en') as Lang] ?? LANG.en
  const shortId = opts.orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
  const time    = fmtTime(opts.createdAt)
  const date    = fmtDate(opts.createdAt)

  const typeLabel =
    opts.orderType === 'dine_in'  ? L.dineIn   :
    opts.orderType === 'delivery' ? L.delivery  : L.takeout

  const discountCents = opts.discountCents ?? 0
  const serviceChargeCents = opts.serviceChargeCents ?? 0
  const discountedSubtotal = opts.subtotalCents - discountCents
  const totalCents = discountedSubtotal + serviceChargeCents + opts.taxCents
  const tipPcts    = opts.tipPercentages ?? [15, 20, 25]

  const lines: string[] = [margin()]

  // Header — logo + merchant name + contact
  const logo = logoBlock(false)
  lines.push('{align:center}')
  if (logo) lines.push(logo)
  lines.push(bold(rl(opts.merchantName ?? L.bill)))
  if (opts.address)     lines.push(rl(opts.address))
  if (opts.phoneNumber) lines.push(rl(opts.phoneNumber))

  lines.push(
    '{align:left}',
    '-',
    row(`${L.order} #${shortId}`, typeLabel),
    row(opts.tableLabel ? `Table ${opts.tableLabel}` : date, time),
  )

  if (opts.customerName && opts.customerName !== 'Dine-in') {
    lines.push(`${rl(L.customer)}: ${rl(opts.customerName)}`)
  }

  lines.push('-')

  // Items
  for (const item of opts.items) {
    const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
    lines.push(row(` ${item.quantity}  ${item.dishName}`, fmtCents(lineTotal)))
    for (const mod of item.modifiers ?? []) {
      if (mod.priceCents !== 0) {
        const sign = mod.priceCents > 0 ? '+' : '-'
        lines.push(row(`       ${mod.name}`, `${sign}${fmtCents(Math.abs(mod.priceCents))}`))
      } else {
        lines.push(`       ${rl(mod.name)}`)
      }
    }
  }

  lines.push('-')
  lines.push(row(`  ${L.subtotal}`, fmtCents(opts.subtotalCents)))

  if (discountCents > 0) {
    const discLabel = opts.discountLabel ? ` (${rl(opts.discountLabel)})` : ''
    lines.push(row(`  Discount${discLabel}`, `-${fmtCents(discountCents)}`))
  }

  if (serviceChargeCents > 0) {
    const scLabel = opts.serviceChargeLabel ? ` (${rl(opts.serviceChargeLabel)})` : ''
    lines.push(row(`  Service Charge${scLabel}`, fmtCents(serviceChargeCents)))
  }

  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  lines.push(row(`  ${L.tax}${taxPct}`, fmtCents(opts.taxCents)))

  lines.push(
    '-',
    row(`  ${L.total}`, fmtCents(totalCents), 'bold'),
    '-',
  )

  // Suggested gratuity table — omitted when a service charge is applied
  if (serviceChargeCents === 0) {
    lines.push(
      '',
      '{align:center}',
      `^${bold(rl(L.gratuity))}`,
      '',
    )
    for (const pct of tipPcts) {
      const tipAmt       = Math.round(opts.subtotalCents * pct / 100)
      const totalWithTip = totalCents + tipAmt
      lines.push(rl(`${pct}%  •  ${fmtCents(tipAmt)}  →  ${fmtCents(totalWithTip)}`))
    }
    lines.push('{align:left}')

    // Write-in lines
    lines.push(
      '-',
      '',
      rl(L.tipWriteIn),
      '',
      rl(L.totalWriteIn),
      '',
      '',
    )
  } else {
    lines.push('', '')
  }

  // Footer
  lines.push('{align:center}')
  if (opts.website) {
    const displayUrl = opts.website.replace(/^https?:\/\//, '')
    lines.push(rl(displayUrl))
  }
  lines.push(
    '',
    rl(L.thankYouDining),
    // 9 blank lines (~252px @ 28px/line) ensures the last printed pixel clears
    // the TSP100 III platen-to-cutter gap (~30mm / 240 dots) before the cut fires.
    '', '', '', '', '', '', '', '', '',
    '{align:left}',
    margin(),
  )

  return lines.join('\n')
}

export function buildCustomerBillRaster(opts: CustomerBillOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildCustomerBillMarkup(opts))
}

// ---------------------------------------------------------------------------
// Test page
// ---------------------------------------------------------------------------

export function buildTestPageMarkup(opts: TestPageOptions): string {
  const label = opts.label ?? 'Printer'
  const proto = opts.printerProtocol ?? 'star-graphic'
  const now   = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  return [
    margin(),
    '{align:center}',
    `^^^${bold('TEST')}`,
    // alignment persists (center) for the lines below
    `${rl(label.toUpperCase())} PRINTER`,
    rl(opts.printerIp),
    rl(proto),
    rl(now),
    '{align:left}',
    '-',
    'If you can read this, the printer is',
    'configured correctly.',
    // 12 blank lines (~240px @ cpl=42/~20px per line) clears the
    // TSP100 III platen-to-cutter gap before the cut fires.
    '', '', '', '', '', '', '', '', '', '', '', '',
    '{align:left}',
    margin(),
  ].join('\n')
}

export function buildTestPageRaster(opts: TestPageOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildTestPageMarkup(opts))
}

// ---------------------------------------------------------------------------
// Gift card receipt
// ---------------------------------------------------------------------------

/**
 * Build receiptline markup for a gift card purchase receipt.
 *
 * Printed when a gift card purchase is confirmed (auto) or on-demand from the
 * dashboard Gift Cards tab.  Shows each card code, face value, balance, the
 * purchaser name, optional recipient name, and expiry date.
 */
export function buildGiftCardReceiptMarkup(opts: GiftCardReceiptOptions): string {
  const fmt = (c: number) => '$' + (c / 100).toFixed(2)
  const fmtExpiry = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const logo = logoBlock(false)

  const lines: string[] = [margin()]

  // Header — logo + merchant name (same pattern as customer receipt)
  lines.push('{align:center}')
  if (logo) lines.push(logo)
  lines.push(bold(rl(opts.merchantName)))
  lines.push('')
  lines.push('^^' + bold('GIFT CARD'))
  lines.push('{align:left}')
  lines.push('-')

  // Card details — use row() helper for proper two-column layout
  for (const card of opts.cards) {
    lines.push(row('Code', card.code, 'bold'))
    lines.push(row('Value', fmt(card.faceValueCents)))
    lines.push(row('Balance', fmt(card.balanceCents)))
    lines.push(row('Expires', fmtExpiry(card.expiresAt)))
    if (opts.cards.length > 1) lines.push('-')
  }

  lines.push('-')
  lines.push(row('Purchased by', opts.purchaserName))

  if (opts.recipientName) {
    lines.push(row('For', opts.recipientName))
  }

  if (opts.purchasedAt) {
    lines.push(row('Date', fmtDate(opts.purchasedAt)))
  }

  // Footer
  lines.push(
    '-',
    '{align:center}',
    '',
    'Thank you!',
    '', '', '', '', '', '', '', '', '',
    '{align:left}',
    margin(),
  )

  return lines.join('\n')
}

export function buildGiftCardReceiptRaster(opts: GiftCardReceiptOptions): Promise<Buffer> {
  return buildStarGraphicBytes(buildGiftCardReceiptMarkup(opts))
}
