/**
 * Printer Emulator — TCP/9100 + WebPRNT/9101 + Web UI/9200
 *
 * Intercepts print jobs so you can debug the full print pipeline at your desk.
 *
 * Usage:
 *   bun run src/tools/printer-emulator.ts
 *
 * Then in the dashboard Settings, set any printer IP to 127.0.0.1.
 * Protocol matrix:
 *   star-graphic        → TCP 9100  (decoded to a visible bitmap)
 *   star-line           → TCP 9100  (ESC sequences stripped, text shown)
 *   star-line-tsp100    → TCP 9100  (ESC sequences stripped, text shown)
 *   generic-escpos      → TCP 9100  (ESC sequences stripped, text shown)
 *   webprnt             → HTTP 9101 (set printerPort=9101 in DB)
 *                         The fallback to star-graphic still hits TCP 9100.
 *
 * Web UI: http://localhost:9200
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import sharp from 'sharp'

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------

interface PrintJob {
  id: string
  receivedAt: string
  label: string  // e.g. "star-graphic · 14 320 B"
  protocol: 'star-graphic' | 'star-line' | 'generic-escpos' | 'webprnt' | 'unknown'
  sizeBytes: number
  /** base64-encoded PNG for star-graphic jobs */
  imagePng?: string
  /** extracted text lines for ESC text / WebPRNT jobs */
  textLines?: string[]
}

const MAX_JOBS = 50
const jobs: PrintJob[] = []
const sseClients: Set<(data: string) => void> = new Set()
let jobSeq = 0

function broadcast(job: PrintJob) {
  const payload = JSON.stringify(job)
  for (const fn of sseClients) {
    try { fn(payload) } catch { sseClients.delete(fn) }
  }
}

function storeJob(job: PrintJob) {
  jobs.unshift(job)
  if (jobs.length > MAX_JOBS) jobs.pop()
  broadcast(job)
  const ts = new Date(job.receivedAt).toLocaleTimeString('en-US')
  console.log(`[emulator] ✓ Job #${jobs.length}: ${job.label} @ ${ts}`)
}

// ---------------------------------------------------------------------------
// Star Graphic decoder  (1-bit raster → PNG)
//
// Wire format (from receiptline stargraphic encoder):
//   open  → ESC RS a 0  +  ESC * r A  +  ESC * r P 0 NUL
//   rows  → 'b' nL nH [nL+nH×256 bytes of packed 1-bit data]
//   feeds → ESC * r Y {decimal} NUL   (blank pixel rows between elements)
//   cut   → ESC FF NUL
//   close → ESC * r B  +  ESC ACK SOH
// ---------------------------------------------------------------------------

async function decodeStarGraphic(buf: Buffer): Promise<string | null> {
  // Locate ESC * r A  (1B 2A 72 41)
  let pos = buf.indexOf(Buffer.from([0x1b, 0x2a, 0x72, 0x41]))
  if (pos === -1) return null
  pos += 4  // skip ESC * r A

  // Skip optional ESC * r P ... NUL  (set position offset)
  if (
    pos + 3 < buf.length &&
    buf[pos] === 0x1b && buf[pos + 1] === 0x2a &&
    buf[pos + 2] === 0x72 && buf[pos + 3] === 0x50
  ) {
    pos += 4
    while (pos < buf.length && buf[pos] !== 0x00) pos++
    if (pos < buf.length) pos++  // skip NUL
  }

  type ImageRow = Buffer
  type BlankFeed = { blank: number }
  const rows: Array<ImageRow | BlankFeed> = []
  let lineByteWidth = 0

  while (pos < buf.length) {
    // ESC * r B  →  end of raster section
    if (
      buf[pos] === 0x1b && pos + 3 < buf.length &&
      buf[pos + 1] === 0x2a && buf[pos + 2] === 0x72 && buf[pos + 3] === 0x42
    ) break

    // Image row:  'b' (0x62)  nL  nH  [data]
    if (buf[pos] === 0x62 && pos + 2 < buf.length) {
      pos++
      const nL = buf[pos++]
      const nH = buf[pos++]
      const lineBytes = nL + nH * 256
      if (lineBytes === 0) continue
      if (lineByteWidth === 0) lineByteWidth = lineBytes
      rows.push(buf.subarray(pos, pos + lineBytes) as unknown as Buffer)
      pos += lineBytes
      continue
    }

    // Blank feed:  ESC * r Y  {decimal string}  NUL
    if (
      buf[pos] === 0x1b && pos + 3 < buf.length &&
      buf[pos + 1] === 0x2a && buf[pos + 2] === 0x72 && buf[pos + 3] === 0x59
    ) {
      pos += 4
      let numStr = ''
      while (pos < buf.length && buf[pos] !== 0x00) numStr += String.fromCharCode(buf[pos++])
      if (pos < buf.length) pos++  // skip NUL
      const feedPx = parseInt(numStr, 10)
      if (feedPx > 0 && feedPx < 4000) rows.push({ blank: feedPx })
      continue
    }

    // Cut:  ESC FF NUL  (1B 0C 00)
    if (buf[pos] === 0x1b && pos + 2 < buf.length && buf[pos + 1] === 0x0c && buf[pos + 2] === 0x00) {
      pos += 3
      continue
    }

    pos++
  }

  if (lineByteWidth === 0 || rows.length === 0) return null

  const imgWidth = lineByteWidth * 8
  let totalHeight = 0
  for (const r of rows) totalHeight += 'blank' in r ? (r as BlankFeed).blank : 1
  if (totalHeight === 0) return null

  // Build RGBA pixel buffer (white background)
  const rawBuf = Buffer.alloc(imgWidth * totalHeight * 4, 0xff)
  let y = 0

  for (const row of rows) {
    if ('blank' in row) {
      y += (row as BlankFeed).blank
    } else {
      const rb = row as Buffer
      for (let x = 0; x < imgWidth; x++) {
        if (((rb[x >> 3] ?? 0) >> (7 - (x & 7))) & 1) {
          const off = (y * imgWidth + x) * 4
          rawBuf[off] = rawBuf[off + 1] = rawBuf[off + 2] = 0
          // alpha already 0xff from fill
        }
      }
      y++
    }
  }

  const pngBuf = await sharp(rawBuf, {
    raw: { width: imgWidth, height: totalHeight, channels: 4 },
  }).png().toBuffer()

  console.log(`[emulator]   star-graphic: ${rows.length} rows, ${imgWidth}×${totalHeight}px → ${pngBuf.length} B PNG`)
  return pngBuf.toString('base64')
}

// ---------------------------------------------------------------------------
// ESC/Star-Line text decoder
// Strips all control sequences and returns printable lines.
// ---------------------------------------------------------------------------

function decodeTextProtocol(buf: Buffer): string[] {
  const lines: string[] = []
  let current = ''
  let i = 0

  while (i < buf.length) {
    const b = buf[i]

    if (b === 0x1b) {  // ESC
      const n1 = buf[i + 1] ?? 0
      const n2 = buf[i + 2] ?? 0

      // ESC @  (init)
      if (n1 === 0x40) { i += 2; continue }
      // ESC E / ESC F  (bold on/off — no param)
      if (n1 === 0x45 || n1 === 0x46) { i += 2; continue }
      // ESC 4 / ESC 5  (color)
      if (n1 === 0x34 || n1 === 0x35) { i += 2; continue }
      // ESC a n  (align)
      if (n1 === 0x61) { i += 3; continue }
      // ESC W n  (width scale)
      if (n1 === 0x57) { i += 3; continue }
      // ESC h n  (height scale)
      if (n1 === 0x68) { i += 3; continue }
      // ESC d n  (cut on TSP700II / feed on TSP100III)
      if (n1 === 0x64) { i += 3; continue }
      // ESC FF NUL  (cut in star-graphic / raster)
      if (n1 === 0x0c) { i += 3; continue }
      // ESC ACK SOH  (StarIO ASB)
      if (n1 === 0x06) { i += 3; continue }
      // ESC GS a n  (align, TSP700II)
      if (n1 === 0x1d && n2 === 0x61) { i += 4; continue }
      // ESC RS a n  (ASB enable)
      if (n1 === 0x1e && n2 === 0x61) { i += 4; continue }
      // ESC RS i  (cut, TSP100III)
      if (n1 === 0x1e && n2 === 0x69) { i += 3; continue }
      // ESC RS a n (StarIO mode)
      if (n1 === 0x1e) { i += 4; continue }
      // ESC * r ...  (star-graphic commands — shouldn't appear in text path)
      if (n1 === 0x2a) { i += 2; continue }
      // Unknown ESC — skip 2 bytes
      i += 2; continue
    }

    if (b === 0x1d) {  // GS
      const n1 = buf[i + 1] ?? 0
      if (n1 === 0x21) { i += 3; continue }  // GS ! n  (size)
      if (n1 === 0x56) { i += 3; continue }  // GS V n  (cut)
      if (n1 === 0x61) { i += 3; continue }  // GS a n  (status)
      i += 2; continue
    }

    if (b === 0x0a) {  // LF → new line
      lines.push(current)
      current = ''
      i++; continue
    }

    if (b === 0x0d || b === 0x0c) { i++; continue }  // CR / FF

    // Printable ASCII
    if (b >= 0x20 && b < 0x80) current += String.fromCharCode(b)
    i++
  }

  if (current.trim()) lines.push(current)

  // Trim leading/trailing blank lines
  let start = 0, end = lines.length - 1
  while (start <= end && lines[start].trim() === '') start++
  while (end >= start && lines[end].trim() === '') end--
  return lines.slice(start, end + 1)
}

// ---------------------------------------------------------------------------
// WebPRNT XML text extractor
// ---------------------------------------------------------------------------

function extractWebPRNTText(xml: string): string[] {
  const lines: string[] = []
  // Pull content from <text ...>...</text> elements
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1]
      .replace(/&#10;/g, '\n')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    for (const line of raw.split('\n')) {
      if (line.trim()) lines.push(line)
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// TCP server — port 9100
// ---------------------------------------------------------------------------

const tcpConnBuffers = new Map<string, Buffer[]>()
let tcpConnSeq = 0

Bun.listen({
  hostname: '127.0.0.1',
  port: 9100,
  socket: {
    open(socket) {
      const connId = `c${++tcpConnSeq}`
      ;(socket as any)._connId = connId
      tcpConnBuffers.set(connId, [])
      console.log(`[emulator] TCP connect (${connId})`)
    },

    data(socket, data) {
      const connId = (socket as any)._connId as string
      const chunks = tcpConnBuffers.get(connId)
      if (!chunks) return

      const chunk = Buffer.from(data)
      chunks.push(chunk)

      // Respond immediately to StarIO ASB handshake (ESC ACK SOH)
      // so the PowerShell driver doesn't waste 1 s waiting
      if (chunk.length === 3 && chunk[0] === 0x1b && chunk[1] === 0x06 && chunk[2] === 0x01) {
        socket.write(new Uint8Array([0x00, 0x00, 0x00, 0x00]))
      }
    },

    async close(socket) {
      const connId = (socket as any)._connId as string
      const chunks = tcpConnBuffers.get(connId)
      tcpConnBuffers.delete(connId)
      if (!chunks || chunks.length === 0) return

      const buf = Buffer.concat(chunks)
      console.log(`[emulator] TCP close (${connId}): ${buf.length} B`)

      // Strip leading ASB bytes (1B 06 01) if they arrived in their own chunk
      let dataStart = 0
      if (buf[0] === 0x1b && buf[1] === 0x06 && buf[2] === 0x01) dataStart = 3
      const printBuf = buf.subarray(dataStart)
      if (printBuf.length === 0) return

      const id = `job_${++jobSeq}_${Date.now()}`
      const isStarGraphic = printBuf.indexOf(Buffer.from([0x1b, 0x2a, 0x72, 0x41])) !== -1

      if (isStarGraphic) {
        const imagePng = await decodeStarGraphic(printBuf)
        storeJob({
          id, receivedAt: new Date().toISOString(),
          label: `star-graphic · ${printBuf.length.toLocaleString()} B`,
          protocol: 'star-graphic',
          sizeBytes: printBuf.length,
          imagePng: imagePng ?? undefined,
          textLines: imagePng ? undefined : ['[Star Graphic decode failed — check console]'],
        })
      } else {
        const hasGS21 = printBuf.indexOf(Buffer.from([0x1d, 0x21])) !== -1
        const protocol = hasGS21 ? 'generic-escpos' : 'star-line'
        const textLines = decodeTextProtocol(printBuf)
        storeJob({
          id, receivedAt: new Date().toISOString(),
          label: `${protocol} · ${printBuf.length.toLocaleString()} B · ${textLines.length} lines`,
          protocol,
          sizeBytes: printBuf.length,
          textLines,
        })
      }
    },

    error(socket, err) {
      console.error(`[emulator] TCP error:`, err.message)
    },
  },
})

// ---------------------------------------------------------------------------
// HTTP server — port 9101  (WebPRNT endpoint)
// Set printerPort = 9101 in the dashboard for webprnt-protocol printers.
// ---------------------------------------------------------------------------

const webprntApp = new Hono()

webprntApp.post('/StarWebPRNT/SendMessage', async c => {
  const xml = await c.req.text()
  const textLines = extractWebPRNTText(xml)
  const id = `job_${++jobSeq}_${Date.now()}`
  storeJob({
    id, receivedAt: new Date().toISOString(),
    label: `webprnt · ${xml.length.toLocaleString()} B · ${textLines.length} lines`,
    protocol: 'webprnt',
    sizeBytes: xml.length,
    textLines,
  })
  // Return the success response the Star SDK expects
  return c.text(
    '<?xml version="1.0" encoding="utf-8"?><StarWebPrintCommandResult><Success /></StarWebPrintCommandResult>',
    200,
    { 'Content-Type': 'text/xml; charset=utf-8' },
  )
})

Bun.serve({ fetch: webprntApp.fetch, port: 9101, hostname: '127.0.0.1' })

// ---------------------------------------------------------------------------
// HTTP server — port 9200  (Web UI)
// ---------------------------------------------------------------------------

const uiApp = new Hono()

uiApp.get('/', c => c.html(UI_HTML))

uiApp.get('/jobs', c => c.json(jobs))

uiApp.delete('/jobs', c => {
  jobs.length = 0
  jobSeq = 0
  console.log('[emulator] Jobs cleared')
  return c.json({ ok: true })
})

uiApp.get('/events', c =>
  streamSSE(c, async stream => {
    let done = false
    const push = (data: string) => { if (!done) stream.writeSSE({ event: 'job', data }) }
    sseClients.add(push)
    stream.onAbort(() => { done = true; sseClients.delete(push) })
    while (!done && !stream.closed) {
      await stream.sleep(30_000)
      if (!done && !stream.closed) stream.write(': ping\n\n')
    }
    sseClients.delete(push)
  })
)

Bun.serve({ fetch: uiApp.fetch, port: 9200, hostname: '127.0.0.1' })

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

console.warn('⚠️  [printer-emulator] DEVELOPMENT TOOL ONLY — all servers bound to 127.0.0.1 (loopback). Do NOT run on a production appliance.')

console.log(`
╔══════════════════════════════════════════════════════╗
║            Kizo Printer Emulator                 ║
╠══════════════════════════════════════════════════════╣
║  TCP  port 9100  — star-graphic / star-line / esc    ║
║  HTTP port 9101  — WebPRNT (set printerPort=9101)    ║
║  Web UI          — http://127.0.0.1:9200            ║
╠══════════════════════════════════════════════════════╣
║  Set any printer IP to 127.0.0.1 in Settings         ║
╚══════════════════════════════════════════════════════╝
`)

// ---------------------------------------------------------------------------
// Web UI  (single-file SPA, embedded)
// ---------------------------------------------------------------------------

const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printer Emulator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0c0c0c;
    --surface: #151210;
    --border: rgba(255,255,255,0.07);
    --gold: #d4af37;
    --gold-dim: rgba(212,175,55,0.15);
    --text: #e0ddd5;
    --text-dim: #6a6560;
    --text-mid: #9a9590;
    --green: #10b981;
    --blue: #3b82f6;
    --orange: #f59e0b;
    --red: #ef4444;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* ── header ── */
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); flex-shrink: 0; }
  header h1 { font-size: 14px; font-weight: 700; color: var(--gold); letter-spacing: .06em; }
  header p  { font-size: 11px; color: var(--text-dim); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green);
    box-shadow: 0 0 6px var(--green); flex-shrink: 0; }
  .dot.off { background: #444; box-shadow: none; }
  .badge { padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600;
    background: var(--gold-dim); color: var(--gold); }
  .btn { padding: 4px 12px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer;
    font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.04); color: var(--text-mid);
    font-family: inherit; transition: all .15s; }
  .btn:hover { border-color: rgba(255,255,255,0.15); color: var(--text); }
  .btn.danger:hover { border-color: var(--red); color: var(--red); }
  header .spacer { flex: 1; }

  /* ── layout ── */
  .layout { display: flex; flex: 1; overflow: hidden; }

  /* ── job list ── */
  .job-list { width: 260px; flex-shrink: 0; border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden; }
  .job-list-header { padding: 8px 12px; font-size: 11px; color: var(--text-dim);
    letter-spacing: .05em; text-transform: uppercase; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .job-list-scroll { flex: 1; overflow-y: auto; }
  .job-item { padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer;
    transition: background .12s; }
  .job-item:hover { background: rgba(255,255,255,0.03); }
  .job-item.active { background: var(--gold-dim); border-left: 2px solid var(--gold); padding-left: 10px; }
  .job-item .job-time { font-size: 10px; color: var(--text-dim); margin-bottom: 2px; }
  .job-item .job-proto { display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: .03em; margin-bottom: 4px; }
  .job-item .job-size { font-size: 10px; color: var(--text-dim); }
  .proto-star-graphic { background: rgba(16,185,129,.18); color: #10b981; }
  .proto-star-line    { background: rgba(59,130,246,.18); color: #3b82f6; }
  .proto-generic-escpos { background: rgba(245,158,11,.18); color: #f59e0b; }
  .proto-webprnt      { background: rgba(168,85,247,.18); color: #a855f7; }
  .proto-unknown      { background: rgba(255,255,255,.06); color: #888; }
  .empty-list { padding: 32px 16px; text-align: center; color: var(--text-dim); font-size: 12px; line-height: 1.7; }

  /* ── preview panel ── */
  .preview { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center;
    padding: 24px 16px; background: radial-gradient(ellipse at center, #1f1a14 0%, #0c0c0c 70%); }
  .no-selection { display: flex; flex-direction: column; align-items: center; justify-content: center;
    flex: 1; color: var(--text-dim); gap: 8px; }
  .no-selection .icon { font-size: 40px; opacity: .3; }

  /* ── receipt paper ── */
  .receipt-paper {
    background: #faf9f5;
    width: 380px;
    min-width: 380px;
    padding: 20px 18px 28px;
    font-family: 'Courier New', Courier, monospace;
    position: relative;
    box-shadow: 4px 8px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.08);
    color: #1a1a1a;
  }
  .receipt-paper::before, .receipt-paper::after {
    content: '';
    position: absolute;
    left: 0; right: 0; height: 6px;
    background: repeating-linear-gradient(90deg, transparent 0, transparent 5px, #faf9f5 5px, #faf9f5 10px);
  }
  .receipt-paper::before { top: -6px; }
  .receipt-paper::after  { bottom: -6px; }
  .receipt-img { width: 100%; height: auto; display: block; image-rendering: pixelated; }
  .receipt-text { font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: hidden; word-break: break-all; }
  .receipt-text-line { display: block; }

  /* ── meta bar below receipt ── */
  .receipt-meta { margin-top: 14px; font-size: 11px; color: var(--text-dim); text-align: center; }

  /* scrollbar */
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.1); border-radius: 3px; }
</style>
</head>
<body>

<header>
  <div class="dot" id="dot"></div>
  <div>
    <h1>Printer Emulator</h1>
    <p>TCP :9100 · WebPRNT :9101 · set printer IP to 127.0.0.1</p>
  </div>
  <div class="spacer"></div>
  <span class="badge" id="badge">0 jobs</span>
  <button class="btn danger" onclick="clearJobs()">Clear</button>
</header>

<div class="layout">
  <div class="job-list">
    <div class="job-list-header">Received Jobs</div>
    <div class="job-list-scroll" id="jobList">
      <div class="empty-list" id="emptyMsg">
        Waiting for print jobs…<br>
        Set printer IP to <strong>127.0.0.1</strong>
      </div>
    </div>
  </div>

  <div class="preview" id="preview">
    <div class="no-selection" id="noSelection">
      <div class="icon">🖨️</div>
      <div>Select a job to preview</div>
    </div>
  </div>
</div>

<script>
let allJobs = []
let activeId = null

const PROTO_CLASS = {
  'star-graphic': 'proto-star-graphic',
  'star-line': 'proto-star-line',
  'generic-escpos': 'proto-generic-escpos',
  'webprnt': 'proto-webprnt',
  'unknown': 'proto-unknown',
}

function fmt(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function renderJobItem(job) {
  const div = document.createElement('div')
  div.className = 'job-item' + (job.id === activeId ? ' active' : '')
  div.dataset.id = job.id
  div.onclick = () => selectJob(job.id)
  const cls = PROTO_CLASS[job.protocol] ?? 'proto-unknown'
  div.innerHTML =
    '<div class="job-time">' + fmt(job.receivedAt) + '</div>' +
    '<div><span class="job-proto ' + cls + '">' + job.protocol + '</span></div>' +
    '<div class="job-size">' + job.sizeBytes.toLocaleString() + ' B</div>'
  return div
}

function rebuildList() {
  const list = document.getElementById('jobList')
  const empty = document.getElementById('emptyMsg')
  if (allJobs.length === 0) {
    list.innerHTML = ''
    list.appendChild(empty)
    return
  }
  empty.remove && empty.remove()
  list.innerHTML = ''
  for (const j of allJobs) list.appendChild(renderJobItem(j))
  document.getElementById('badge').textContent = allJobs.length + ' job' + (allJobs.length !== 1 ? 's' : '')
}

function selectJob(id) {
  activeId = id
  // Update active state in list
  document.querySelectorAll('.job-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id)
  })
  const job = allJobs.find(j => j.id === id)
  if (!job) return

  const preview = document.getElementById('preview')
  const noSel = document.getElementById('noSelection')
  noSel.style.display = 'none'

  // Remove old receipt if any
  const old = preview.querySelector('.receipt-wrap')
  if (old) old.remove()

  const wrap = document.createElement('div')
  wrap.className = 'receipt-wrap'
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.alignItems = 'center'

  const paper = document.createElement('div')
  paper.className = 'receipt-paper'

  if (job.imagePng) {
    const img = document.createElement('img')
    img.className = 'receipt-img'
    img.src = 'data:image/png;base64,' + job.imagePng
    paper.appendChild(img)
  } else if (job.textLines && job.textLines.length > 0) {
    const pre = document.createElement('div')
    pre.className = 'receipt-text'
    for (const line of job.textLines) {
      const span = document.createElement('span')
      span.className = 'receipt-text-line'
      span.textContent = line
      pre.appendChild(span)
    }
    paper.appendChild(pre)
  } else {
    paper.innerHTML = '<div style="color:#999;font-size:11px;text-align:center;padding:20px">No printable content decoded</div>'
  }

  const meta = document.createElement('div')
  meta.className = 'receipt-meta'
  meta.textContent = job.protocol + ' · ' + job.sizeBytes.toLocaleString() + ' B · ' + fmt(job.receivedAt)

  wrap.appendChild(paper)
  wrap.appendChild(meta)
  preview.appendChild(wrap)
}

function clearJobs() {
  fetch('/jobs', { method: 'DELETE' }).then(() => {
    allJobs = []
    activeId = null
    rebuildList()
    const preview = document.getElementById('preview')
    const old = preview.querySelector('.receipt-wrap')
    if (old) old.remove()
    document.getElementById('noSelection').style.display = ''
    document.getElementById('badge').textContent = '0 jobs'
  })
}

// Load existing jobs on start
fetch('/jobs').then(r => r.json()).then(data => {
  allJobs = data
  rebuildList()
  if (allJobs.length > 0) selectJob(allJobs[0].id)
})

// SSE live updates
const es = new EventSource('/events')
const dot = document.getElementById('dot')
es.onopen = () => dot.classList.remove('off')
es.onerror = () => dot.classList.add('off')
es.addEventListener('job', e => {
  const job = JSON.parse(e.data)
  allJobs.unshift(job)
  if (allJobs.length > 50) allJobs.pop()
  rebuildList()
  selectJob(job.id)  // auto-select latest
})
</script>
</body>
</html>`
