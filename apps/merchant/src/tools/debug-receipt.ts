#!/usr/bin/env bun
/**
 * Receipt render debugger
 *
 * Runs receiptline markup through the full star-graphic pipeline and saves
 * the intermediate SVG and PNG to /tmp so you can visually inspect exactly
 * what is being sent to the printer.
 *
 * Usage:
 *   bun run v2/src/tools/debug-receipt.ts
 *   bun run v2/src/tools/debug-receipt.ts 192.168.1.179   # also prints
 */

import receiptline from 'receiptline'
import sharp from 'sharp'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir, EOL } from 'os'
import { join } from 'path'

const PRINTER_DOT_WIDTH = 576

const SVG_OPTS = {
  command:  'svg' as const,
  cpl:      42,
  encoding: 'multilingual',
  spacing:  true,
}

const STAR_GRAPHIC_OPTS = {
  command:   'stargraphic' as const,
  cpl:       42,
  encoding:  'multilingual',
  gradient:  false,
  threshold: 210,
}

// Use the actual production markup builder so the debug output exactly matches
// what the printer receives.
import { buildCustomerReceiptMarkup } from '../services/star-raster'

const MARKUP = buildCustomerReceiptMarkup({
  printerIp:       '192.168.1.179',
  printerProtocol: 'star-graphic',
  orderId:         'ord_FFB577',
  orderType:       'takeout',
  merchantName:    'Hanuman Thai Cafe',
  address:         '115 Central Way, Kirkland WA 98033',
  customerName:    'Jj',
  tableLabel:      null,
  roomLabel:       null,
  notes:           null,
  phoneNumber:     '425-822-2629',
  website:         'https://www.hanuman-thai-cafe-kirkland.com',
  subtotalCents:   1100,
  taxCents:        114,
  taxRate:         0.104,
  paidAmountCents: 1214,
  createdAt:       '2026-02-24T16:11:00Z',
  printLanguage:   'en',
  items: [
    {
      quantity:   1,
      dishName:   'Spring Rolls',
      priceCents: 1100,
      modifiers:  [],
    },
  ],
})

// ---------------------------------------------------------------------------
// Step 1: markup → SVG
// ---------------------------------------------------------------------------
console.log('Step 1: rendering markup → SVG ...')
const svg = receiptline.transform(MARKUP, SVG_OPTS)
const tmp = tmpdir()
const svgPath   = join(tmp, 'receipt-debug.svg')
const pngPath   = join(tmp, 'receipt-debug.png')
const bytesPath = join(tmp, 'receipt-debug.bin')

writeFileSync(svgPath, svg, 'utf8')
console.log(`  SVG: ${svg.length} chars  →  ${svgPath}`)

// ---------------------------------------------------------------------------
// Step 2: SVG → PNG via sharp
// ---------------------------------------------------------------------------
console.log('Step 2: rasterizing SVG → PNG via sharp ...')
const png = await sharp(Buffer.from(svg))
  .resize(PRINTER_DOT_WIDTH, undefined, {
    fit:        'contain',
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  })
  .png()
  .toBuffer()

const meta = await sharp(png).metadata()
writeFileSync(pngPath, png)
console.log(`  PNG: ${meta.width}×${meta.height} px, ${png.length} bytes  →  ${pngPath}`)

// ---------------------------------------------------------------------------
// Step 3: PNG → Star Graphic bytes
// ---------------------------------------------------------------------------
console.log('Step 3: encoding PNG → Star Graphic bytes ...')
const base64 = png.toString('base64')
const result = receiptline.transform(`{i:${base64}}\n{cut}`, STAR_GRAPHIC_OPTS)
const bytes = Buffer.from(result, 'binary')
writeFileSync(bytesPath, bytes)
console.log(`  Bytes: ${bytes.length}  →  ${bytesPath}`)

// ---------------------------------------------------------------------------
// Step 4 (optional): send to printer
// ---------------------------------------------------------------------------
const printerIp = process.argv[2]
if (printerIp) {
  console.log(`\nStep 4: sending to printer at ${printerIp}:9100 ...`)
  const sent = await sendTcp(printerIp, 9100, bytes, bytesPath)
  console.log(sent ? '  OK' : '  FAILED — check IP/network')
} else {
  console.log('\nTip: pass a printer IP to also send to the printer.')
  console.log('     bun run v2/src/tools/debug-receipt.ts 192.168.1.179')
}

console.log('\nOpen the PNG to see exactly what will print:')
console.log(`  start ${pngPath}`)

// ---------------------------------------------------------------------------
// TCP helper — writes a .ps1 script to a temp file to avoid Windows
// command-line length limits (~32KB) when embedding large binary payloads.
// ---------------------------------------------------------------------------
async function sendTcp(host: string, port: number, data: Buffer, binPath: string): Promise<boolean> {
  // binPath already written to disk by Step 3 above — PowerShell reads it directly.
  const scriptPath = join(tmpdir(), 'receipt-send.ps1')
  const ps = `
$bytes = [System.IO.File]::ReadAllBytes('${binPath.replace(/\\/g, '\\\\')}')
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect('${host}', ${port})
$stream = $tcp.GetStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Flush()
$stream.Close()
$tcp.Close()
`.trim()

  writeFileSync(scriptPath, ps, 'utf8')
  try {
    const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-File', scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      console.error('  PowerShell error:', err.trim())
      return false
    }
    return true
  } finally {
    try { unlinkSync(scriptPath) } catch {}
  }
}
