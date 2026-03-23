/**
 * Gift Card PDF Generator
 *
 * Renders a gift card PDF using Puppeteer (shares the Chrome instance with
 * html-receipt.ts — no second browser process).
 * Each card occupies a styled section in the PDF.
 * The PDF is returned as a Buffer and attached to the delivery email.
 */

import { initHtmlRenderer } from './html-receipt'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GiftCardPdfCard {
  code: string
  faceValueCents: number
  expiresAt: string  // ISO date string
}

export interface GiftCardPdfOpts {
  cards: GiftCardPdfCard[]
  /** Person who purchased the gift card. */
  purchaserName: string
  /** Person the card is intended for (may differ from purchaser). */
  recipientName?: string | null
  businessName: string
  address?: string | null
  phone?: string | null
  website?: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str: string | null | undefined): string {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2)
}

function formatExpiry(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Generate an SVG QR code for a URL, returned as a data URL for <img src>. */
async function qrDataUrl(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    color: { dark: '#ffffff', light: '#00000000' },
    width: 120,
  })
  const b64 = Buffer.from(svg).toString('base64')
  return `data:image/svg+xml;base64,${b64}`
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

async function buildGiftCardHtml(opts: GiftCardPdfOpts): Promise<string> {
  const { cards, purchaserName, recipientName, businessName, address, phone, website } = opts

  // Logo — load base64 if available, fall back gracefully
  let logoB64 = ''
  try {
    logoB64 = readFileSync(join(import.meta.dir, '../assets/printers/logo-sm-b64.txt'), 'utf-8').trim()
  } catch {
    // no logo — that's fine
  }
  const logoHtml = logoB64
    ? `<img src="data:image/png;base64,${logoB64}" alt="${esc(businessName)}" style="max-height:56px;max-width:200px;object-fit:contain;filter:invert(1);">`
    : `<span style="font-size:22px;font-weight:700;letter-spacing:0.05em;">${esc(businessName)}</span>`

  // QR code — only if website provided
  const websiteUrl = website ? (website.startsWith('http') ? website : `https://${website}`) : null
  const qrHtml = websiteUrl
    ? `<img src="${await qrDataUrl(websiteUrl)}" alt="QR code" style="width:80px;height:80px;display:block;">`
    : ''

  // Contact footer line
  const contactParts: string[] = []
  if (address) contactParts.push(esc(address))
  if (phone)   contactParts.push(esc(phone))
  if (website) contactParts.push(`<a href="${esc(websiteUrl!)}" style="color:#aaa;text-decoration:none;">${esc(website.replace(/^https?:\/\//, ''))}</a>`)
  const contactHtml = contactParts.join('&ensp;·&ensp;')

  // "Gift for" label — show recipient if different from purchaser, otherwise purchaser
  const giftForName = recipientName || purchaserName

  const cardSections = cards.map((card) => `
    <div style="page-break-inside:avoid;margin-bottom:32px;">
      <div style="
        background:linear-gradient(135deg,#1a1a1a 0%,#2d2d2d 50%,#1a1a1a 100%);
        border-radius:16px;
        padding:36px 40px;
        color:#fff;
        font-family:Helvetica,Arial,sans-serif;
        position:relative;
        overflow:hidden;
        min-height:200px;
        box-shadow:0 4px 24px rgba(0,0,0,0.3);
      ">
        <!-- Decorative circles -->
        <div style="position:absolute;top:-60px;right:-60px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,0.04);"></div>
        <div style="position:absolute;bottom:-80px;left:-40px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,0.03);"></div>

        <!-- Header row: logo left, value right -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
          <div style="color:rgba(255,255,255,0.9);">
            ${logoHtml}
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Gift Card Value</div>
            <div style="font-size:36px;font-weight:700;letter-spacing:0.02em;">${esc(formatCents(card.faceValueCents))}</div>
          </div>
        </div>

        <!-- Card code -->
        <div style="margin-bottom:20px;">
          <div style="font-size:10px;color:rgba(255,255,255,0.45);letter-spacing:0.14em;text-transform:uppercase;margin-bottom:6px;">Card Code</div>
          <div style="
            font-size:28px;font-weight:700;letter-spacing:0.25em;
            font-family:'Courier New',monospace;color:#fff;
          ">${esc(card.code)}</div>
        </div>

        <!-- Footer row: recipient + expiry left, QR right -->
        <div style="display:flex;justify-content:space-between;align-items:flex-end;padding-top:16px;border-top:1px solid rgba(255,255,255,0.12);">
          <div>
            <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:2px;">Gift for <strong>${esc(giftForName)}</strong></div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);">Valid through ${esc(formatExpiry(card.expiresAt))}</div>
          </div>
          ${qrHtml ? `<div style="background:rgba(255,255,255,0.08);border-radius:8px;padding:6px;">${qrHtml}</div>` : ''}
        </div>
      </div>

      <!-- Redemption note below the card -->
      <div style="
        margin-top:12px;padding:12px 16px;
        background:#f8f8f8;border-radius:8px;
        font-size:12px;color:#666;font-family:Helvetica,Arial,sans-serif;
      ">
        Present this card code at <strong>${esc(businessName)}</strong> when placing your order.
        This gift card has no cash value and cannot be redeemed for cash.
      </div>
    </div>
  `).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gift Card — ${esc(businessName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    background: #fff;
    color: #222;
    padding: 40px 48px;
  }
  .page-header {
    text-align: center;
    margin-bottom: 36px;
    padding-bottom: 20px;
    border-bottom: 2px solid #eee;
  }
  .page-header h1 { font-size: 20px; font-weight: 700; color: #111; margin-bottom: 4px; }
  .page-header .meta { font-size: 13px; color: #888; margin-bottom: 2px; }
  .page-header .contact { font-size: 12px; color: #aaa; margin-top: 6px; }
</style>
</head>
<body>
  <div class="page-header">
    <h1>Gift ${cards.length > 1 ? 'Cards' : 'Card'} from ${esc(businessName)}</h1>
    <div class="meta">Purchased by ${esc(purchaserName)}${recipientName && recipientName !== purchaserName ? ` &nbsp;·&nbsp; For ${esc(recipientName)}` : ''} &nbsp;·&nbsp; ${cards.length} card${cards.length > 1 ? 's' : ''}</div>
    ${contactHtml ? `<div class="contact">${contactHtml}</div>` : ''}
  </div>

  ${cardSections}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// PDF renderer
// ---------------------------------------------------------------------------

/**
 * Generate a PDF Buffer containing all gift cards in the purchase.
 * Shares the Puppeteer browser instance from html-receipt.ts.
 */
export async function generateGiftCardPdf(opts: GiftCardPdfOpts): Promise<Buffer> {
  const browser = await initHtmlRenderer()
  const page = await browser.newPage()
  try {
    const html = await buildGiftCardHtml(opts)
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await page.close()
  }
}

/**
 * No-op — browser lifecycle is owned by html-receipt.ts / server.ts shutdown hook.
 * Kept for API symmetry with the original standalone design.
 */
export async function closeGiftCardPdfRenderer(): Promise<void> {
  // Browser is shared with html-receipt; closed by closeHtmlRenderer() in shutdown()
}
