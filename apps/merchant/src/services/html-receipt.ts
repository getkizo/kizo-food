/**
 * HTML receipt renderer
 *
 * Renders receipt HTML via Puppeteer headless Chrome, converts the screenshot
 * to 1-bit monochrome, and encodes as Star Graphic Mode commands for TCP/9100.
 *
 * Pipeline: HTML template → Puppeteer screenshot → Sharp greyscale → 1-bit
 *           packed raster → ESC * r A … b n1 n2 <data> … ESC * r B
 *           (Star Graphic byte stream produced by receiptline stargraphic command)
 *
 * The four template builders match the four ticket types in printer.ts:
 *   buildKitchenTicketHtml()   — large type, dark-badge modifiers, no prices
 *   buildCounterTicketHtml()   — counter copy; with subtotalCents = bag receipt
 *   buildCustomerBillHtml()    — pre-payment bill with gratuity table
 *   buildCustomerReceiptHtml() — post-payment receipt with paid badge
 */

import puppeteer from 'puppeteer-core'
import type { Browser } from 'puppeteer-core'
import sharp from 'sharp'
import receiptline from 'receiptline'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Config ──────────────────────────────────────────────────────────────────

/** 80mm paper at 203 DPI ≈ 576 printable pixels */
const PAPER_WIDTH_PX = 576

/**
 * Luminance threshold for 1-bit conversion: pixel < THRESHOLD → black dot.
 * 200 (vs the naive 128) catches grey anti-aliased font edges that would
 * otherwise print as white (invisible) on thermal paper.
 */
const THRESHOLD = 200

// ─── Logo ────────────────────────────────────────────────────────────────────

let LOGO_B64 = ''
try {
  LOGO_B64 = readFileSync(
    join(import.meta.dir, '../assets/printers/logo-sm-b64.txt'),
    'utf8',
  ).trim()
} catch {
  // No logo file — renders without it
}

// ─── Local DM Sans font (offline-safe) ───────────────────────────────────────
//
// Font files are stored in src/assets/printers/fonts/ (copied from @fontsource/dm-sans).
// Loaded as base64 data URIs so Puppeteer never needs an internet connection.
// Falls back to Helvetica/Arial if the font files are missing.

function loadFontB64(filename: string): string {
  try {
    const buf = readFileSync(join(import.meta.dir, '../assets/printers/fonts', filename))
    return buf.toString('base64')
  } catch {
    console.warn(`[html-receipt] Font file not found: ${filename} — falling back to Helvetica/Arial`)
    return ''
  }
}

const DM_SANS_500 = loadFontB64('dm-sans-latin-500-normal.woff2')
const DM_SANS_600 = loadFontB64('dm-sans-latin-600-normal.woff2')
const DM_SANS_700 = loadFontB64('dm-sans-latin-700-normal.woff2')
const DM_SANS_800 = loadFontB64('dm-sans-latin-800-normal.woff2')

/**
 * Build the @font-face CSS for locally-bundled DM Sans.
 * Returns an empty string if the font files were not found (Puppeteer will
 * use the Helvetica/Arial system fallback declared in BASE_CSS).
 */
function dmSansFontFaces(): string {
  const weights: [string, number][] = [
    [DM_SANS_500, 500],
    [DM_SANS_600, 600],
    [DM_SANS_700, 700],
    [DM_SANS_800, 800],
  ]
  return weights
    .filter(([b64]) => b64.length > 0)
    .map(([b64, w]) => `
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: ${w};
  src: url('data:font/woff2;base64,${b64}') format('woff2');
}`)
    .join('\n')
}

// ─── System Chrome detection ─────────────────────────────────────────────────

const CHROME_CANDIDATES: string[] = [
  // Linux / ARM appliance (apt install chromium-browser)
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
]

function findChrome(): string {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  throw new Error(
    '[html-receipt] No system Chrome found.\n' +
    '  On ARM appliances:  sudo apt install -y chromium-browser\n' +
    '  On Ubuntu/Debian:   sudo apt install -y google-chrome-stable\n' +
    '  On macOS:           brew install --cask google-chrome\n' +
    '  On Windows:         install Chrome from https://www.google.com/chrome\n' +
    '  Or set CHROME_EXECUTABLE_PATH env variable to the chrome binary.',
  )
}

// ─── Browser singleton ───────────────────────────────────────────────────────

let _browser: Browser | null = null

/** Launch (or reuse) the Puppeteer browser instance. */
export async function initHtmlRenderer(): Promise<Browser> {
  if (!_browser) {
    const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? findChrome()
    // Cast required: puppeteer-core's CJS default export does not satisfy its own
    // ESM type declaration under Bun's module resolver, so `.launch` is not visible
    // without the cast. The options below match the puppeteer-core v22 launch API.
    _browser = await (puppeteer as unknown as { launch: typeof puppeteer.launch }).launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    })
  }
  return _browser
}

/** Shut down the Puppeteer browser instance. */
export async function closeHtmlRenderer(): Promise<void> {
  if (_browser) {
    await _browser.close()
    _browser = null
  }
}

// ─── Core pipeline ───────────────────────────────────────────────────────────

async function renderToImage(
  html: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  // Render at 2× device pixel ratio so Chrome produces full-density subpixel
  // coverage for every glyph stroke. We then downscale with Lanczos3 — the
  // high-quality filter computes a proper weighted average of the 2× pixels,
  // keeping stroke edges dark rather than letting them fade to mid-grey (which
  // the threshold would map to white / invisible on thermal paper).
  const SCALE = 2
  const b = await initHtmlRenderer()
  const page = await b.newPage()
  try {
    await page.setViewport({ width: PAPER_WIDTH_PX, height: 100, deviceScaleFactor: SCALE })
    await page.setContent(html, { waitUntil: 'load' })
    // Wait for @font-face fonts (base64 DM Sans) to fully decode and apply.
    // Without this, offsetHeight is measured with fallback font metrics (Helvetica),
    // producing a taller measurement than the final DM Sans layout → whitespace.
    const height = await page.evaluate(async () => {
      await document.fonts.ready
      return (document.querySelector('#receipt') as HTMLElement).offsetHeight
    })
    console.log(`[html-receipt] 1. offsetHeight = ${height}px`)
    await page.setViewport({ width: PAPER_WIDTH_PX, height, deviceScaleFactor: SCALE })
    // clip is in CSS pixels; screenshot output will be PAPER_WIDTH_PX*SCALE × height*SCALE
    const rawPng = (await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: PAPER_WIDTH_PX, height },
      omitBackground: false,
    })) as Buffer
    const rawMeta = await sharp(rawPng).metadata()
    console.log(`[html-receipt] 2. screenshot = ${rawMeta.width}×${rawMeta.height}px`)
    // Downscale back to printer width — Lanczos3 preserves contrast at edges
    const png = await sharp(rawPng)
      .resize(PAPER_WIDTH_PX, null, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer()
    const finalMeta = await sharp(png).metadata()
    console.log(`[html-receipt] 3. final bitmap = ${finalMeta.width}×${finalMeta.height}px → ${height} raster rows`)
    return { png, width: PAPER_WIDTH_PX, height }
  } finally {
    await page.close()
  }
}

async function toMonochrome(pngBuffer: Buffer): Promise<{
  data: Buffer
  width: number
  height: number
  bytesPerRow: number
}> {
  const { data, info } = await sharp(pngBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const bytesPerRow = Math.ceil(width / 8)
  const mono = Buffer.alloc(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gray = data[y * width + x]
      if (gray < THRESHOLD) {
        const byteIndex = y * bytesPerRow + Math.floor(x / 8)
        const bitIndex = 7 - (x % 8)
        mono[byteIndex] |= 1 << bitIndex
      }
    }
  }
  return { data: mono, width, height, bytesPerRow }
}

function toStarGraphicCommands(monoData: {
  data: Buffer
  height: number
  bytesPerRow: number
}): Buffer {
  const { data, height, bytesPerRow } = monoData
  const parts: Buffer[] = [Buffer.from([0x1b, 0x2a, 0x72, 0x41])] // ESC * r A
  for (let y = 0; y < height; y++) {
    const line = data.slice(y * bytesPerRow, (y + 1) * bytesPerRow)
    parts.push(Buffer.from([0x62, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff]))
    parts.push(line)
  }
  parts.push(Buffer.from([0x1b, 0x2a, 0x72, 0x42])) // ESC * r B  (exit raster)
  // No explicit cut — TSP143 III auto-cuts on Star Graphic mode exit.
  // ESC RS i (Star Line cut) is rejected by TSP143 III (no font ROM) and kills the print job.
  return Buffer.concat(parts)
}

/** Options for the receiptline Star Graphic encode step (PNG → raster bytes). */
const STAR_GRAPHIC_OPTIONS = {
  command:   'stargraphic' as const,
  cpl:       42,
  encoding:  'multilingual',
  gradient:  false,         // pure black/white — required for thermal raster
  threshold: 210,           // SVG text is anti-aliased (grey ~180–220)
}

/**
 * Full HTML → Star Graphic raster buffer pipeline.
 * Returns a Buffer compatible with connectAndPrint() in printer.ts.
 *
 * Uses receiptline's stargraphic encoder (same as star-raster.ts) to convert
 * the PNG to Star Graphic bytes.  This guarantees correct ESC * r A/B framing
 * and cut commands — the manual approach missed the cut, causing the TSP143 III
 * to hold the paper.
 */
export async function renderHtmlToRasterBuffer(html: string): Promise<Buffer> {
  console.log('[html-receipt] Rendering HTML receipt via Puppeteer...')
  const { png } = await renderToImage(html)
  const base64 = png.toString('base64')
  const result = receiptline.transform(`{i:${base64}}\n\n\n\n{cut}`, STAR_GRAPHIC_OPTIONS)
  const buf = Buffer.from(result, 'latin1')
  console.log(`[html-receipt] Rendered: ${buf.length} raster bytes`)
  return buf
}

// ─── Minimal option types (structurally compatible with printer.ts) ───────────
// Defined here to avoid circular imports — printer.ts imports this module.

interface PrintItemHtml {
  quantity: number
  dishName: string
  priceCents: number
  modifiers?: Array<{ name: string; priceCents: number }>
  dishLabel?: string
  specialInstructions?: string
  serverNotes?: string
  lineTotalCents?: number
  courseOrder?: number | null
  isLastCourse?: boolean
  printDestination?: 'both' | 'kitchen' | 'counter'
}

interface BaseHtmlOpts {
  orderId: string
  orderType: string
  merchantName?: string | null
  customerName?: string | null
  tableLabel?: string | null
  roomLabel?: string | null
  notes?: string | null
  items: PrintItemHtml[]
  createdAt?: string | null
  address?: string | null
  phoneNumber?: string | null
  website?: string | null
}

export interface CounterHtmlOpts extends BaseHtmlOpts {
  pickupCode?: string | null
  utensilsNeeded?: boolean
  subtotalCents?: number
  taxCents?: number
  taxRate?: number
  paidAmountCents?: number
  tipCents?: number
}

export interface BillHtmlOpts extends BaseHtmlOpts {
  subtotalCents: number
  taxCents: number
  taxRate?: number
  discountCents?: number
  discountLabel?: string | null
  serviceChargeCents?: number
  serviceChargeLabel?: string | null
  tipPercentages?: number[]
}

export interface ReceiptHtmlOpts extends BaseHtmlOpts {
  subtotalCents: number
  taxCents: number
  taxRate?: number
  paidAmountCents: number
  tipCents?: number
  discountCents?: number
  discountLabel?: string | null
  serviceChargeCents?: number
  serviceChargeLabel?: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

function fmtTime(iso?: string | null): string {
  return parseDate(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtDate(iso?: string | null): string {
  return parseDate(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function shortId(orderId: string): string {
  return orderId.replace(/^ord_/, '').slice(-6).toUpperCase()
}

function logoImg(inverted = false): string {
  if (!LOGO_B64) return ''
  const style = inverted ? ' style="filter:invert(1)"' : ''
  return `<img src="data:image/png;base64,${LOGO_B64}"${style} />`
}

// ─── Shared CSS ──────────────────────────────────────────────────────────────

// ─── Thermal-print CSS rules ──────────────────────────────────────────────────
//
// Thermal printers are 1-bit: every pixel is black ink or white paper.
// Anti-aliased browser rendering produces grey pixels that map to white after
// thresholding → invisible text. Rules below ensure nothing survives as grey:
//
//   • font-weight ≥ 500 everywhere (thin strokes alias to grey)
//   • font-size ≥ 14px (small text has < 1px strokes → all grey)
//   • All text is #000 or at most #333 (mid-grey disappears at any threshold)
//   • No opacity/rgba — opacity blends to grey
//   • Borders ≥ 2px solid #000 (hairlines vanish)
//   • -webkit-font-smoothing: none — disables subpixel AA, keeps edges crisp
//   • Colors (red, green, etc.) map to mid-grey in greyscale → must be #000

const BASE_CSS = `
${dmSansFontFaces()}

  * { margin: 0; padding: 0; box-sizing: border-box; }

  #receipt {
    width: ${PAPER_WIDTH_PX}px;
    background: #fff;
    color: #000;
    font-family: 'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-weight: 500;
    padding: 32px 28px 10px;
    -webkit-font-smoothing: none;
    -moz-osx-font-smoothing: unset;
    text-rendering: geometricPrecision;
  }

  .logo { text-align: center; margin-bottom: 14px; }
  .logo img { width: 80px; height: 80px; }

  .restaurant-name {
    text-align: center;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.1em;
    margin-bottom: 4px;
    color: #000;
  }
  .restaurant-detail {
    text-align: center;
    font-size: 14px;
    font-weight: 500;
    color: #000;
    line-height: 1.5;
  }

  .divider { border-top: 3px solid #000; margin: 14px 0; }
  .divider-light { border-top: 2px solid #000; margin: 12px 0; }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.7;
    color: #000;
  }
  .row-sm { font-size: 14px; }
  .row-lg { font-size: 22px; font-weight: 800; }
  .muted { color: #333; font-weight: 500; }
  .bold { font-weight: 700; }
  .center { text-align: center; }

  .item-mods {
    padding-left: 24px;
    font-size: 14px;
    font-weight: 500;
    color: #333;
    line-height: 1.6;
  }

  .gratuity-box {
    background: #f0f0f0;
    border: 2px solid #000;
    border-radius: 8px;
    padding: 16px 18px;
    margin: 18px 0;
  }
  .gratuity-title {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-align: center;
    margin-bottom: 12px;
    color: #000;
  }
  .gratuity-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 8px;
  }
  .gratuity-option {
    text-align: center;
    padding: 10px 4px;
    border-radius: 6px;
    border: 2px solid #000;
    background: #fff;
    color: #000;
  }
  /* .gratuity-option.highlight — intentionally removed; no tip tier is pre-selected */
  .gratuity-pct { font-weight: 800; font-size: 18px; }
  .gratuity-amt { font-size: 13px; font-weight: 600; margin-top: 2px; }

  .write-line {
    display: flex;
    align-items: baseline;
    margin: 16px 0;
    font-size: 16px;
  }
  .write-line-label { width: 70px; font-weight: 600; }
  .write-line-label.big { font-weight: 800; font-size: 18px; }
  .write-line-rule { flex: 1; border-bottom: 2px solid #000; margin-left: 8px; }
  .write-line-rule.bold-rule { border-bottom: 3px solid #000; }

  .footer {
    text-align: center;
    margin-top: 8px;
    font-size: 14px;
    font-weight: 500;
    color: #333;
    line-height: 1.6;
  }
  .footer-thanks {
    font-size: 15px;
    font-weight: 600;
    color: #000;
    margin-top: 4px;
  }

  /* Takeout bag receipt — dark header bleeds to receipt edges */
  .dark-header {
    background: #000;
    color: #fff;
    padding: 28px 28px 22px;
    text-align: center;
    margin: -32px -28px 0 -28px;
  }
  .dark-header .restaurant-name { color: #fff; }
  .dark-header .restaurant-detail { color: #ccc; font-weight: 600; }
  .banner {
    background: #eee;
    padding: 14px;
    text-align: center;
    margin: 0 -28px;
    border-bottom: 2px solid #000;
  }
  .banner-title { font-size: 28px; font-weight: 800; letter-spacing: 0.15em; }
  .banner-name { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .paid-badge {
    text-align: center;
    margin: 16px 0;
    padding: 12px;
    background: #fff;
    border: 3px solid #000;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 700;
    color: #000;
  }

  /* Kitchen / counter copy */
  .kitchen-header { text-align: center; padding: 8px 0; }
  .kitchen-type { font-size: 42px; font-weight: 800; letter-spacing: 0.1em; }
  .kitchen-table { font-size: 56px; font-weight: 800; }
  .kitchen-item { font-size: 28px; font-weight: 700; margin: 10px 0 2px; }
  .kitchen-mod {
    display: inline-block;
    background: #000;
    color: #fff;
    font-size: 20px;
    font-weight: 700;
    padding: 4px 14px;
    border-radius: 4px;
    margin: 3px 0 3px 28px;
  }
`

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Kitchen ticket: large type, dark-badge modifiers, no prices.
 */
export function buildKitchenTicketHtml(opts: BaseHtmlOpts): string {
  const typeLabel =
    opts.orderType === 'dine_in'  ? 'DINE-IN'  :
    opts.orderType === 'delivery' ? 'DELIVERY' : 'TAKEOUT'

  const locationParts: string[] = []
  if (opts.roomLabel)  locationParts.push(esc(opts.roomLabel))
  if (opts.tableLabel) locationParts.push(`Table ${esc(opts.tableLabel)}`)

  const itemsHtml = opts.items.map(item => {
    const mods = (item.modifiers ?? []).map(m =>
      `<div class="kitchen-mod">${esc(m.name)}</div>`
    ).join('')
    const instrHtml = item.specialInstructions
      ? `<div class="kitchen-mod" style="background:#555;font-style:italic">&gt;&gt; ${esc(item.specialInstructions)}</div>`
      : ''
    const serverNoteHtml = item.serverNotes
      ? `<div class="kitchen-mod" style="background:#555;font-style:italic">* ${esc(item.serverNotes)}</div>`
      : ''
    return `
      <div class="kitchen-item">${item.quantity}× ${esc(item.dishName)}</div>
      ${mods}
      ${instrHtml}
      ${serverNoteHtml}
    `
  }).join('')

  const notesHtml = opts.notes
    ? `<div class="divider"></div>
       <div style="font-size:18px;font-weight:700;padding:4px 0">NOTE: ${esc(opts.notes)}</div>`
    : ''

  return `<!DOCTYPE html><html><head><style>${BASE_CSS}</style></head><body>
  <div id="receipt">
    <div class="kitchen-header">
      <div class="kitchen-type">${typeLabel}</div>
      ${locationParts.length > 0
        ? `<div class="kitchen-table">${locationParts.join(' / ')}</div>`
        : ''}
    </div>
    <div class="row row-sm" style="margin-bottom:4px">
      <span>#${shortId(opts.orderId)}</span>
      <span>${fmtTime(opts.createdAt)}</span>
    </div>
    ${opts.customerName && opts.orderType !== 'dine_in'
      ? `<div class="center bold" style="font-size:18px;margin:6px 0">${esc(opts.customerName)}</div>`
      : ''}
    <div class="divider"></div>
    ${itemsHtml}
    ${notesHtml}
    <div class="divider" style="margin-top:16px"></div>
    <div class="center muted" style="font-size:14px">${fmtDate(opts.createdAt)} ${fmtTime(opts.createdAt)}</div>
  </div>
  </body></html>`
}

/**
 * Counter ticket.
 * With subtotalCents → branded takeout bag receipt (dark header, prices, paid badge).
 * Without subtotalCents → standard counter copy (items only, no prices).
 */
export function buildCounterTicketHtml(opts: CounterHtmlOpts): string {
  if (opts.subtotalCents !== undefined) {
    // ── Branded bag receipt ──────────────────────────────────────────────────
    const taxPct = opts.taxRate
      ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
      : ''
    const totalCents =
      opts.paidAmountCents ??
      (opts.subtotalCents + (opts.taxCents ?? 0) + (opts.tipCents ?? 0))

    const itemsHtml = opts.items.map(item => {
      const lineTotal = item.lineTotalCents ?? item.priceCents * item.quantity
      const mods = (item.modifiers ?? []).map(m => {
        if (m.priceCents !== 0) {
          const sign = m.priceCents > 0 ? '+' : '-'
          return `<div class="item-mods">${esc(m.name)} ${sign}${fmtCents(Math.abs(m.priceCents))}</div>`
        }
        return `<div class="item-mods">${esc(m.name)}</div>`
      }).join('')
      const labelHtml = item.dishLabel
        ? `<div class="item-mods" style="font-weight:700">${esc(item.dishLabel)}</div>`
        : ''
      const instrHtml = item.specialInstructions
        ? `<div class="item-mods" style="font-style:italic">&gt;&gt; ${esc(item.specialInstructions)}</div>`
        : ''
      const serverNoteHtml = item.serverNotes
        ? `<div class="item-mods" style="font-style:italic">* ${esc(item.serverNotes)}</div>`
        : ''
      return `
        <div class="row" style="font-weight:600">
          <span>${item.quantity}× ${esc(item.dishName)}</span>
          <span>${fmtCents(lineTotal)}</span>
        </div>
        ${mods}
        ${labelHtml}
        ${instrHtml}
        ${serverNoteHtml}
      `
    }).join('')

    return `<!DOCTYPE html><html><head><style>${BASE_CSS}</style></head><body>
    <div id="receipt" style="padding-top:0">
      <div class="dark-header">
        <div class="logo">${logoImg(true)}</div>
        <div class="restaurant-name">${esc(opts.merchantName ?? '')}</div>
        ${opts.address    ? `<div class="restaurant-detail">${esc(opts.address)}</div>`    : ''}
        ${opts.phoneNumber ? `<div class="restaurant-detail">${esc(opts.phoneNumber)}</div>` : ''}
      </div>
      <div class="banner">
        <div class="banner-title">TAKEOUT</div>
        <div class="row-sm center muted">#${shortId(opts.orderId)} · ${fmtTime(opts.createdAt)} · ${fmtDate(opts.createdAt)}</div>
        ${opts.customerName ? `<div class="banner-name" style="font-size:22px">${esc(opts.customerName)}</div>` : ''}
        ${opts.pickupCode ? `<div class="banner-name" style="font-size:28px;letter-spacing:4px">CODE: ${esc(opts.pickupCode)}</div>` : ''}
      </div>
      <div style="padding:16px 0 28px">
        ${itemsHtml}
        ${opts.notes ? `<div style="font-size:14px;font-weight:700;padding:2px 0">NOTE: ${esc(opts.notes)}</div>` : ''}
        ${opts.utensilsNeeded ? `<div style="font-size:14px;font-weight:700;padding:2px 0">✓ UTENSILS REQUESTED</div>` : ''}
        <div class="divider-light"></div>
        <div class="row row-sm muted"><span>Subtotal</span><span>${fmtCents(opts.subtotalCents)}</span></div>
        <div class="row row-sm muted"><span>Tax${taxPct}</span><span>${fmtCents(opts.taxCents ?? 0)}</span></div>
        ${opts.tipCents ? `<div class="row row-sm muted"><span>Tip</span><span>${fmtCents(opts.tipCents)}</span></div>` : ''}
        <div class="divider"></div>
        <div class="row row-lg"><span>TOTAL</span><span>${fmtCents(totalCents)}</span></div>
        <div class="paid-badge">✓ PAID ${fmtCents(totalCents)}</div>
        <div class="footer">
          ${opts.website ? esc(opts.website) : ''}
          <div class="footer-thanks">Thank you!</div>
        </div>
      </div>
    </div>
    </body></html>`
  }

  // ── Standard counter copy (no prices) ──────────────────────────────────────
  const typeLabel =
    opts.orderType === 'dine_in'  ? 'COUNTER'  :
    opts.orderType === 'delivery' ? 'DELIVERY' : 'TAKEOUT'

  const locationParts: string[] = []
  if (opts.roomLabel)  locationParts.push(esc(opts.roomLabel))
  if (opts.tableLabel) locationParts.push(`Table ${esc(opts.tableLabel)}`)

  const itemsHtml = opts.items.map(item => {
    const mods = (item.modifiers ?? []).map(m =>
      `<div class="kitchen-mod">${esc(m.name)}</div>`
    ).join('')
    const labelHtml = item.dishLabel
      ? `<div class="kitchen-mod" style="background:#fff;color:#000;font-weight:700">${esc(item.dishLabel)}</div>`
      : ''
    const instrHtml = item.specialInstructions
      ? `<div class="kitchen-mod" style="background:#fff;color:#000;font-style:italic">&gt;&gt; ${esc(item.specialInstructions)}</div>`
      : ''
    const serverNoteHtml = item.serverNotes
      ? `<div class="kitchen-mod" style="background:#fff;color:#000;font-style:italic">* ${esc(item.serverNotes)}</div>`
      : ''
    return `
      <div class="kitchen-item">${item.quantity}× ${esc(item.dishName)}</div>
      ${mods}
      ${labelHtml}
      ${instrHtml}
      ${serverNoteHtml}
    `
  }).join('')

  return `<!DOCTYPE html><html><head><style>${BASE_CSS}</style></head><body>
  <div id="receipt">
    <div class="kitchen-header">
      <div class="kitchen-type">${typeLabel}</div>
      ${locationParts.length > 0
        ? `<div class="kitchen-table">${locationParts.join(' / ')}</div>`
        : ''}
    </div>
    <div class="row row-sm" style="margin-bottom:4px">
      <span>#${shortId(opts.orderId)}</span>
      <span>${fmtTime(opts.createdAt)}</span>
    </div>
    ${opts.customerName
      ? `<div class="center bold" style="font-size:28px;margin:6px 0">${esc(opts.customerName)}</div>`
      : ''}
    ${opts.pickupCode
      ? `<div class="center bold" style="font-size:32px;letter-spacing:4px;margin:4px 0">CODE: ${esc(opts.pickupCode)}</div>`
      : ''}
    <div class="divider"></div>
    ${itemsHtml}
    <div class="divider" style="margin-top:16px"></div>
    ${opts.notes ? `<div style="font-size:16px;font-weight:700;padding:4px 0">NOTE: ${esc(opts.notes)}</div>` : ''}
    ${opts.utensilsNeeded ? `<div style="font-size:16px;font-weight:700;padding:4px 0">✓ UTENSILS REQUESTED</div>` : ''}
    ${(opts.notes || opts.utensilsNeeded) ? `<div class="divider"></div>` : ''}
    <div class="center muted" style="font-size:14px">${fmtDate(opts.createdAt)} ${fmtTime(opts.createdAt)}</div>
  </div>
  </body></html>`
}

/** Bill-specific font overrides — all sizes 50% larger than BASE_CSS defaults. */
const BILL_FONT_CSS = `
  .restaurant-name  { font-size: 33px; }
  .restaurant-detail { font-size: 21px; }
  .row              { font-size: 23px; }
  .row-sm           { font-size: 21px; }
  .row-lg           { font-size: 33px; }
  .item-mods        { font-size: 21px; }
  .gratuity-title   { font-size: 23px; }
  .gratuity-pct     { font-size: 27px; }
  .gratuity-amt     { font-size: 20px; }
  .write-line       { font-size: 24px; }
  .write-line-label.big { font-size: 27px; }
  .footer           { font-size: 21px; }
  .footer-thanks    { font-size: 23px; }
`

/**
 * Customer bill (pre-payment) with suggested gratuity table and write-in lines.
 */
export function buildCustomerBillHtml(opts: BillHtmlOpts): string {
  const tipPcts = opts.tipPercentages ?? [15, 20, 25]
  const discountCents = opts.discountCents ?? 0
  const serviceChargeCents = opts.serviceChargeCents ?? 0
  const discountedSubtotal = opts.subtotalCents - discountCents
  const totalCents = discountedSubtotal + serviceChargeCents + opts.taxCents
  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  const typeLabel =
    opts.orderType === 'dine_in'  ? 'Dine In'  :
    opts.orderType === 'delivery' ? 'Delivery' : 'Takeout'

  const itemsHtml = opts.items.map(item => {
    const lineTotal = item.lineTotalCents ?? item.priceCents * item.quantity
    const mods = (item.modifiers ?? []).map(m => {
      if (m.priceCents !== 0) {
        const sign = m.priceCents > 0 ? '+' : '-'
        return `<div class="item-mods">${esc(m.name)} ${sign}${fmtCents(Math.abs(m.priceCents))}</div>`
      }
      return `<div class="item-mods">${esc(m.name)}</div>`
    }).join('')
    return `
      <div class="row">
        <span><span class="bold">${item.quantity}</span>&nbsp;&nbsp;${esc(item.dishName)}</span>
        <span>${fmtCents(lineTotal)}</span>
      </div>
      ${mods}
    `
  }).join('')

  const tipsHtml = tipPcts.map(pct => {
    const amt = opts.subtotalCents * pct / 100
    return `
      <div class="gratuity-option">
        <div class="gratuity-pct">${pct}%</div>
        <div class="gratuity-amt">${fmtCents(amt)}</div>
      </div>
    `
  }).join('')

  return `<!DOCTYPE html><html><head><style>${BASE_CSS}${BILL_FONT_CSS}</style></head><body>
  <div id="receipt">
    <div class="logo">${logoImg()}</div>
    <div class="restaurant-name">${esc(opts.merchantName ?? '')}</div>
    ${opts.address    ? `<div class="restaurant-detail">${esc(opts.address)}</div>`    : ''}
    ${opts.phoneNumber ? `<div class="restaurant-detail">${esc(opts.phoneNumber)}</div>` : ''}
    <div style="height:16px"></div>
    <div class="row row-sm">
      <span>
        ${opts.tableLabel ? `Table ${esc(opts.tableLabel)}` : ''}
        ${opts.roomLabel  ? (opts.tableLabel ? ` · ${esc(opts.roomLabel)}` : esc(opts.roomLabel)) : ''}
        ${opts.tableLabel || opts.roomLabel ? ` · ${typeLabel}` : typeLabel}
      </span>
      <span>${fmtTime(opts.createdAt)}</span>
    </div>
    <div class="row row-sm muted"><span>#${shortId(opts.orderId)}</span><span>${fmtDate(opts.createdAt)}</span></div>
    <div class="divider"></div>
    ${itemsHtml}
    <div class="divider-light"></div>
    <div class="row row-sm"><span class="muted">Subtotal</span><span>${fmtCents(opts.subtotalCents)}</span></div>
    ${discountCents > 0 ? `<div class="row row-sm" style="color:#16a34a"><span>Discount${opts.discountLabel ? ` · ${esc(opts.discountLabel)}` : ''}</span><span>−${fmtCents(discountCents)}</span></div>` : ''}
    ${serviceChargeCents > 0 ? `<div class="row row-sm" style="color:#b45309"><span>Service Charge${opts.serviceChargeLabel ? ` · ${esc(opts.serviceChargeLabel)}` : ''}</span><span>+${fmtCents(serviceChargeCents)}</span></div>` : ''}
    <div class="row row-sm"><span class="muted">Tax${taxPct}</span><span>${fmtCents(opts.taxCents)}</span></div>
    <div class="divider"></div>
    <div class="row row-lg"><span>TOTAL</span><span>${fmtCents(totalCents)}</span></div>
    <div class="divider"></div>
    ${serviceChargeCents === 0 ? `
    <div class="gratuity-box">
      <div class="gratuity-title">SUGGESTED GRATUITY</div>
      <div class="gratuity-grid" style="grid-template-columns: repeat(${tipPcts.length}, 1fr)">${tipsHtml}</div>
    </div>
    <div class="write-line">
      <span class="write-line-label">Tip:</span>
      <span class="write-line-rule"></span>
    </div>
    <div class="write-line">
      <span class="write-line-label big">Total:</span>
      <span class="write-line-rule bold-rule"></span>
    </div>` : ''}
    <div class="footer">
      ${opts.website ? esc(opts.website) : ''}
      <div class="footer-thanks">Thank you for dining with us!</div>
    </div>
  </div>
  </body></html>`
}

/**
 * Customer receipt (post-payment) with paid badge and signature note.
 */
export function buildCustomerReceiptHtml(opts: ReceiptHtmlOpts): string {
  const taxPct = opts.taxRate
    ? ` (${(opts.taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)`
    : ''
  const typeLabel =
    opts.orderType === 'dine_in'  ? 'Dine In'  :
    opts.orderType === 'delivery' ? 'Delivery' : 'Takeout'

  const itemsHtml = opts.items.map(item => {
    const lineTotal = item.lineTotalCents ?? item.priceCents * item.quantity
    const mods = (item.modifiers ?? []).map(m => {
      if (m.priceCents !== 0) {
        const sign = m.priceCents > 0 ? '+' : '-'
        return `<div class="item-mods">${esc(m.name)} ${sign}${fmtCents(Math.abs(m.priceCents))}</div>`
      }
      return `<div class="item-mods">${esc(m.name)}</div>`
    }).join('')
    return `
      <div class="row">
        <span>${item.quantity}× ${esc(item.dishName)}</span>
        <span>${fmtCents(lineTotal)}</span>
      </div>
      ${mods}
    `
  }).join('')

  return `<!DOCTYPE html><html><head><style>${BASE_CSS}
  /* Customer receipt — 1.5× body font scale */
  .row     { font-size: 22px; }
  .row-sm  { font-size: 21px; }
  .row-lg  { font-size: 33px; }
  .item-mods { font-size: 21px; }
  </style></head><body>
  <div id="receipt">
    <div class="logo">${logoImg()}</div>
    <div class="restaurant-name">${esc(opts.merchantName ?? '')}</div>
    ${opts.address    ? `<div class="restaurant-detail">${esc(opts.address)}</div>`    : ''}
    ${opts.phoneNumber ? `<div class="restaurant-detail">${esc(opts.phoneNumber)}</div>` : ''}
    <div style="height:14px"></div>
    <div class="row row-sm">
      <span>#${shortId(opts.orderId)}</span>
      <span>${typeLabel}</span>
    </div>
    <div class="row row-sm">
      <span>${fmtDate(opts.createdAt)}</span>
      <span>${fmtTime(opts.createdAt)}</span>
    </div>
    ${opts.tableLabel
      ? `<div class="row row-sm"><span>Table: ${esc(opts.tableLabel)}</span></div>`
      : ''}
    ${opts.customerName && opts.customerName !== 'Dine-in'
      ? `<div class="row row-sm"><span>Customer: ${esc(opts.customerName)}</span></div>`
      : ''}
    <div class="divider"></div>
    ${itemsHtml}
    <div class="divider-light"></div>
    <div class="row row-sm"><span class="muted">Subtotal</span><span>${fmtCents(opts.subtotalCents)}</span></div>
    ${(opts.discountCents ?? 0) > 0
      ? `<div class="row row-sm" style="color:#16a34a"><span>Discount${opts.discountLabel ? ` · ${esc(opts.discountLabel)}` : ''}</span><span>−${fmtCents(opts.discountCents!)}</span></div>`
      : ''}
    ${(opts.serviceChargeCents ?? 0) > 0
      ? `<div class="row row-sm"><span class="muted">Service Charge${opts.serviceChargeLabel ? ` · ${esc(opts.serviceChargeLabel)}` : ''}</span><span>${fmtCents(opts.serviceChargeCents!)}</span></div>`
      : ''}
    <div class="row row-sm"><span class="muted">Tax${taxPct}</span><span>${fmtCents(opts.taxCents)}</span></div>
    ${(opts.tipCents ?? 0) > 0
      ? `<div class="row row-sm"><span class="muted">Tip</span><span>${fmtCents(opts.tipCents!)}</span></div>`
      : ''}
    <div class="divider"></div>
    <div class="row row-lg"><span>TOTAL</span><span>${fmtCents(opts.paidAmountCents)}</span></div>
    <div class="divider"></div>
    <div class="paid-badge">✓ PAID ${fmtCents(opts.paidAmountCents)}</div>
    <div class="center muted" style="font-size:14px;font-style:italic;margin-top:8px">
      Signature captured on device
    </div>
    <div class="footer">
      ${opts.website ? esc(opts.website) : ''}
      <div class="footer-thanks">Thank you!</div>
    </div>
  </div>
  </body></html>`
}
