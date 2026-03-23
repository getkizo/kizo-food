#!/usr/bin/env bun
/**
 * Printer TCP Sniffer / Proxy
 *
 * Sits between a POS system (Grubhub, Clover, etc.) and the real printer.
 * Captures every byte in both directions with timestamps, then forwards
 * to the actual printer so it still prints.
 *
 * Usage:
 *   bun run v2/src/tools/printer-sniffer.ts [printer-ip] [listen-port]
 *
 * Defaults:
 *   printer-ip  = 192.168.1.179
 *   listen-port = 9100
 *
 * Example:
 *   1. Stop any other service on port 9100
 *   2. bun run v2/src/tools/printer-sniffer.ts 192.168.1.179 9100
 *   3. In Grubhub/Clover, change the printer IP to THIS machine's IP
 *   4. Send a print job from Grubhub/Clover
 *   5. The sniffer logs every byte and forwards to the real printer
 *   6. Check the captures/ directory for saved sessions
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const PRINTER_IP   = process.argv[2] || '192.168.1.179'
const PRINTER_PORT = 9100
const LISTEN_PORT  = parseInt(process.argv[3] || '9100', 10)
const CAPTURE_DIR  = join(import.meta.dir, '..', '..', 'captures')

// Ensure capture directory exists
try { mkdirSync(CAPTURE_DIR, { recursive: true }) } catch {}

let sessionId = 0

function hexDump(data: Buffer | Uint8Array, maxBytes = 200): string {
  const bytes = Buffer.from(data)
  const lines: string[] = []
  const limit = Math.min(bytes.length, maxBytes)

  for (let offset = 0; offset < limit; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, limit))
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    lines.push(`  ${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(48)}  |${ascii}|`)
  }
  if (bytes.length > maxBytes) {
    lines.push(`  ... (${bytes.length - maxBytes} more bytes)`)
  }
  return lines.join('\n')
}

function analyzeCommands(data: Buffer): string[] {
  const notes: string[] = []
  const len = data.length

  for (let i = 0; i < len; i++) {
    if (data[i] === 0x1b) { // ESC
      if (i + 1 < len) {
        const next = data[i + 1]
        if (next === 0x40) notes.push(`  [${i}] ESC @ — Initialize printer`)
        else if (next === 0x45) notes.push(`  [${i}] ESC E — Bold ON`)
        else if (next === 0x46) notes.push(`  [${i}] ESC F — Bold OFF`)
        else if (next === 0x06 && i + 2 < len) notes.push(`  [${i}] ESC ACK ${data[i+2].toString(16)} — ASB request`)
        else if (next === 0x61 && i + 2 < len) notes.push(`  [${i}] ESC a ${data[i+2]} — Alignment (3-byte)`)
        else if (next === 0x57 && i + 2 < len) notes.push(`  [${i}] ESC W ${data[i+2]} — Width expansion`)
        else if (next === 0x68 && i + 2 < len) notes.push(`  [${i}] ESC h ${data[i+2]} — Height expansion`)
        else if (next === 0x64 && i + 2 < len) notes.push(`  [${i}] ESC d ${data[i+2]} — Cut/Feed (model-dependent)`)
        else if (next === 0x1e && i + 2 < len) notes.push(`  [${i}] ESC RS ${data[i+2].toString(16)} — Star-specific command`)
        else if (next === 0x1d) { // ESC GS
          if (i + 3 < len && data[i+2] === 0x61) notes.push(`  [${i}] ESC GS a ${data[i+3]} — Alignment (4-byte Star Line)`)
          else notes.push(`  [${i}] ESC GS ${data[i+2]?.toString(16)} — Star GS command`)
        }
        else notes.push(`  [${i}] ESC ${next.toString(16)} — Unknown ESC command`)
      }
    } else if (data[i] === 0x1d) { // GS (standalone, not after ESC)
      if (i + 1 < len) {
        const next = data[i + 1]
        if (next === 0x56 && i + 2 < len) notes.push(`  [${i}] GS V ${data[i+2]} — ESC/POS cut`)
        else if (next === 0x21 && i + 2 < len) notes.push(`  [${i}] GS ! ${data[i+2].toString(16)} — ESC/POS size`)
        else if (next === 0x61 && i + 2 < len) notes.push(`  [${i}] GS a ${data[i+2]} — ASB enable (ESC/POS)`)
      }
    }
  }

  return notes
}

interface SessionLog {
  id: number
  startTime: Date
  clientAddr: string
  events: Array<{
    time: number  // ms since session start
    dir: 'C→P' | 'P→C' | 'INFO'
    data?: Buffer
    msg?: string
  }>
}

/** Per-connection state, keyed by client socket instance. */
interface SessionState {
  session: SessionLog
  startMs: number
  sid: number
  clientChunks: Buffer[]
  printerSocket: ReturnType<typeof Bun.connect> | null
}

const _socketState = new WeakMap<object, SessionState>()

function saveSession(session: SessionLog): void {
  const ts = session.startTime.toISOString().replace(/[:.]/g, '-')
  const filename = `session-${session.id}-${ts}`

  // Save human-readable log
  const lines: string[] = [
    `=== Printer Sniffer Session #${session.id} ===`,
    `Start: ${session.startTime.toISOString()}`,
    `Client: ${session.clientAddr}`,
    `Printer: ${PRINTER_IP}:${PRINTER_PORT}`,
    `Events: ${session.events.length}`,
    '',
  ]

  for (const ev of session.events) {
    const timeStr = `+${ev.time}ms`
    if (ev.msg) {
      lines.push(`[${timeStr}] ${ev.dir}: ${ev.msg}`)
    }
    if (ev.data) {
      lines.push(`[${timeStr}] ${ev.dir} (${ev.data.length} bytes):`)
      lines.push(hexDump(ev.data, 2000))
      const cmds = analyzeCommands(ev.data)
      if (cmds.length > 0) {
        lines.push('  Commands detected:')
        lines.push(...cmds)
      }
      lines.push('')
    }
  }

  const logPath = join(CAPTURE_DIR, `${filename}.log`)
  writeFileSync(logPath, lines.join('\n'))
  console.log(`\n📁 Session saved: ${logPath}`)

  // Also save raw binary of all client→printer data for replay
  const clientData = Buffer.concat(
    session.events
      .filter(e => e.dir === 'C→P' && e.data)
      .map(e => e.data!)
  )
  if (clientData.length > 0) {
    const binPath = join(CAPTURE_DIR, `${filename}.bin`)
    writeFileSync(binPath, clientData)
    console.log(`📁 Raw client data: ${binPath} (${clientData.length} bytes)`)
  }
}

console.log('╔══════════════════════════════════════════════════╗')
console.log('║          Star Printer TCP Sniffer/Proxy         ║')
console.log('╠══════════════════════════════════════════════════╣')
console.log(`║  Listening on:   0.0.0.0:${LISTEN_PORT.toString().padEnd(24)}║`)
console.log(`║  Forwarding to:  ${PRINTER_IP}:${PRINTER_PORT.toString().padEnd(16)}║`)
console.log(`║  Captures dir:   captures/                      ║`)
console.log('╠══════════════════════════════════════════════════╣')
console.log('║  Steps:                                         ║')
console.log('║  1. In Grubhub/Clover, change printer IP to     ║')
console.log('║     THIS machine\'s local IP address              ║')
console.log('║  2. Send a print job                             ║')
console.log('║  3. Watch the captured bytes below               ║')
console.log('║  4. Press Ctrl+C to stop                         ║')
console.log('╚══════════════════════════════════════════════════╝')
console.log('')

Bun.listen({
  hostname: '0.0.0.0',
  port: LISTEN_PORT,
  socket: {
    open(clientSocket) {
      const sid = ++sessionId
      const session: SessionLog = {
        id: sid,
        startTime: new Date(),
        clientAddr: `${clientSocket.remoteAddress}`,
        events: [],
      }
      const startMs = Date.now()

      console.log(`\n🔌 [#${sid}] Client connected from ${session.clientAddr}`)
      session.events.push({
        time: 0,
        dir: 'INFO',
        msg: `Client connected from ${session.clientAddr}`,
      })

      // Track accumulated client data for this session
      const clientChunks: Buffer[] = []
      let printerConnected = false
      let printerClosed = false

      // Connect to the real printer
      Bun.connect({
        hostname: PRINTER_IP,
        port: PRINTER_PORT,
        socket: {
          open(pSocket) {
            printerConnected = true
            const elapsed = Date.now() - startMs
            console.log(`  🖨️  [#${sid}] Connected to printer ${PRINTER_IP}:${PRINTER_PORT} (+${elapsed}ms)`)
            session.events.push({
              time: elapsed,
              dir: 'INFO',
              msg: `Connected to printer ${PRINTER_IP}:${PRINTER_PORT}`,
            })

            // Forward any buffered client data
            for (const chunk of clientChunks) {
              pSocket.write(chunk)
            }
            clientChunks.length = 0

            // Store reference for forwarding
            const state = _socketState.get(clientSocket)
            if (state) state.printerSocket = pSocket
          },
          data(pSocket, received) {
            const elapsed = Date.now() - startMs
            const buf = Buffer.from(received)
            console.log(`  ◀️  [#${sid}] Printer → Client: ${buf.length} bytes (+${elapsed}ms)`)
            console.log(hexDump(buf))
            session.events.push({
              time: elapsed,
              dir: 'P→C',
              data: buf,
            })

            // Forward to client
            try { clientSocket.write(buf) } catch {}
          },
          close() {
            printerClosed = true
            const elapsed = Date.now() - startMs
            console.log(`  🔒 [#${sid}] Printer connection closed (+${elapsed}ms)`)
            session.events.push({
              time: elapsed,
              dir: 'INFO',
              msg: 'Printer connection closed',
            })
            saveSession(session)
            try { clientSocket.end() } catch {}
          },
          error(pSocket, err) {
            const elapsed = Date.now() - startMs
            console.error(`  ❌ [#${sid}] Printer error: ${err.message} (+${elapsed}ms)`)
            session.events.push({
              time: elapsed,
              dir: 'INFO',
              msg: `Printer error: ${err.message}`,
            })
          },
          connectError(pSocket, err) {
            const elapsed = Date.now() - startMs
            console.error(`  ❌ [#${sid}] Printer connect error: ${err.message} (+${elapsed}ms)`)
            session.events.push({
              time: elapsed,
              dir: 'INFO',
              msg: `Printer connect error: ${err.message}`,
            })
            saveSession(session)
            try { clientSocket.end() } catch {}
          },
        },
      })

      // Store session state on the socket for access in data/close handlers
      _socketState.set(clientSocket, { session, startMs, sid, clientChunks, printerSocket: null })
    },

    data(clientSocket, received) {
      const { session, startMs, sid, clientChunks } = _socketState.get(clientSocket)!
      const elapsed = Date.now() - startMs

      const buf = Buffer.from(received)
      console.log(`  ▶️  [#${sid}] Client → Printer: ${buf.length} bytes (+${elapsed}ms)`)
      console.log(hexDump(buf))
      const cmds = analyzeCommands(buf)
      if (cmds.length > 0) {
        console.log('  Commands:')
        cmds.forEach(c => console.log(c))
      }

      session.events.push({
        time: elapsed,
        dir: 'C→P',
        data: buf,
      })

      // Forward to printer
      const pSocket = _socketState.get(clientSocket)?.printerSocket
      if (pSocket) {
        try { pSocket.write(buf) } catch {}
      } else {
        // Buffer until printer connection is ready
        clientChunks.push(buf)
      }
    },

    close(clientSocket) {
      const { session, startMs, sid } = _socketState.get(clientSocket)!
      const elapsed = Date.now() - startMs

      console.log(`  🔒 [#${sid}] Client disconnected (+${elapsed}ms)`)
      session.events.push({
        time: elapsed,
        dir: 'INFO',
        msg: 'Client disconnected',
      })

      // Close printer connection
      const pSocket = _socketState.get(clientSocket)?.printerSocket
      if (pSocket) {
        try { pSocket.end() } catch {}
      } else {
        // Printer never connected; save what we have
        saveSession(session)
      }
    },

    error(clientSocket, err) {
      const sid = _socketState.get(clientSocket)?.sid ?? '?'
      console.error(`  ❌ [#${sid}] Client error: ${err.message}`)
    },
  },
})

// Also provide a "replay" mode: send a captured .bin file directly to the printer
if (process.argv[4] === '--replay') {
  const binFile = process.argv[5]
  if (!binFile) {
    console.error('Usage: --replay <capture.bin>')
    process.exit(1)
  }
  const data = require('fs').readFileSync(binFile) as Buffer
  console.log(`\n🔄 Replaying ${binFile} (${data.length} bytes) to ${PRINTER_IP}:${PRINTER_PORT}...`)

  Bun.connect({
    hostname: PRINTER_IP,
    port: PRINTER_PORT,
    socket: {
      open(socket) {
        console.log('  Connected, sending...')
        console.log(hexDump(data, 200))
        socket.write(data)
        setTimeout(() => {
          console.log('  Closing...')
          socket.end()
        }, 3000)
      },
      data(socket, received) {
        const buf = Buffer.from(received)
        console.log(`  ◀️  Printer response: ${buf.length} bytes`)
        console.log(hexDump(buf))
      },
      close() {
        console.log('  Done.')
      },
      error(socket, err) {
        console.error('  Error:', err.message)
      },
    },
  })
}
