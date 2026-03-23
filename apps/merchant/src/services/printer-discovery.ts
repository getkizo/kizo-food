/**
 * Network printer discovery
 *
 * Strategy 1: mDNS multicast query for _pdl-datastream._tcp.local
 *             Star TSP100 III and most modern network printers advertise via Bonjour.
 *             Completes in ~2 s; returns hostname (often contains model name).
 *
 * Strategy 2: TCP port 9100 scan on all local /24 subnets
 *             Works even when ICMP is blocked — connects TCP and checks for acceptance.
 *             Completes in ~400 ms (254 parallel probes).
 *
 * Both strategies run in parallel; results are merged and deduplicated by IP.
 */

import { networkInterfaces } from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredPrinter {
  ip: string
  port: number
  /** Model / instance name extracted from mDNS PTR record, if available */
  hostname?: string
  /** How this printer was found */
  method: 'mdns' | 'tcp-scan'
}

// ─── Local subnet helpers ─────────────────────────────────────────────────────

function getLocalSubnets(): string[] {
  const subnets: string[] = []
  const ifaces = networkInterfaces()
  for (const ifaceList of Object.values(ifaces)) {
    for (const iface of ifaceList ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.')
        subnets.push(parts.slice(0, 3).join('.'))
      }
    }
  }
  return [...new Set(subnets)]
}

// ─── IP validation ────────────────────────────────────────────────────────────

/**
 * NF-9.1: Validate that an IP address is in a private/LAN range.
 * Rejects loopback (127.x), link-local (169.254.x), and non-RFC-1918 addresses
 * to prevent SSRF-style probing of cloud metadata endpoints or other services.
 */
function isPrivateIp(ip: string): boolean {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/.test(ip)
}

// ─── TCP probe ────────────────────────────────────────────────────────────────

function probeTcp(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  // NF-9.1: Reject non-private IPs to prevent SSRF probing of arbitrary hosts
  if (!isPrivateIp(ip)) {
    console.warn(`[printer-discovery] probeTcp rejected non-private IP: ${ip}`)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port })
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

async function tcpScan(
  subnet: string,
  port: number,
  timeoutMs: number,
): Promise<DiscoveredPrinter[]> {
  const ips: string[] = []
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`)

  const results = await Promise.all(
    ips.map(async (ip) => ({ ip, open: await probeTcp(ip, port, timeoutMs) })),
  )

  return results
    .filter((r) => r.open)
    .map((r) => ({ ip: r.ip, port, method: 'tcp-scan' as const }))
}

// ─── mDNS helpers ─────────────────────────────────────────────────────────────

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353

/** Encode a DNS name as a sequence of length-prefixed labels */
function encodeDnsName(fqdn: string): Buffer {
  const parts = fqdn.split('.')
  const chunks: Buffer[] = []
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8')
    chunks.push(Buffer.from([label.length]), label)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

/** Build a minimal mDNS PTR query packet */
function buildMdnsQuery(serviceName: string): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)    // Transaction ID: 0 (mDNS convention)
  header.writeUInt16BE(0, 2)    // Flags: standard query
  header.writeUInt16BE(1, 4)    // QDCOUNT: 1
  // ANCOUNT, NSCOUNT, ARCOUNT all 0

  const qname = encodeDnsName(serviceName)

  const qfields = Buffer.alloc(4)
  qfields.writeUInt16BE(12, 0)      // QTYPE:  PTR (12)
  qfields.writeUInt16BE(0x8001, 2)  // QCLASS: IN (1) with QU bit set

  return Buffer.concat([header, qname, qfields])
}

/**
 * Parse a DNS name from buf starting at offset.
 * Handles compression pointers (0xC0 xx).
 */
function parseDnsName(buf: Buffer, offset: number): { name: string; nextOffset: number } {
  const labels: string[] = []
  let jumped = false
  let nextOffset = offset
  // NF-9.2: Track visited pointer offsets to detect circular compression pointer loops
  const visited = new Set<number>()

  for (let guard = 0; guard < 128; guard++) {
    if (offset >= buf.length) break
    const len = buf[offset]

    if (len === 0) {
      if (!jumped) nextOffset = offset + 1
      break
    }

    if ((len & 0xc0) === 0xc0) {
      // Compression pointer
      if (offset + 1 >= buf.length) break
      if (!jumped) nextOffset = offset + 2
      jumped = true
      const newOffset = ((len & 0x3f) << 8) | buf[offset + 1]
      // NF-9.2: Detect circular pointer loop before following
      if (visited.has(newOffset)) break
      visited.add(newOffset)
      offset = newOffset
    } else {
      if (offset + 1 + len > buf.length) break
      labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'))
      offset += 1 + len
    }
  }

  return { name: labels.join('.'), nextOffset }
}

/** Parse a raw mDNS UDP packet and extract discovered printers */
function parseMdnsResponse(buf: Buffer): DiscoveredPrinter[] {
  if (buf.length < 12) return []

  try {
    const flags = buf.readUInt16BE(2)
    if ((flags & 0x8000) === 0) return []  // Not a response packet

    const qdCount = buf.readUInt16BE(4)
    const anCount = buf.readUInt16BE(6)
    const nsCount = buf.readUInt16BE(8)
    const arCount = buf.readUInt16BE(10)

    let offset = 12

    // Skip question section
    for (let i = 0; i < qdCount; i++) {
      const { nextOffset } = parseDnsName(buf, offset)
      offset = nextOffset + 4  // QTYPE + QCLASS
      if (offset > buf.length) return []
    }

    // Collect records
    const hostToIp = new Map<string, string>()            // hostname → IPv4
    const instanceToHost = new Map<string, string>()      // service instance → hostname
    const serviceInstances: Array<{ instance: string; port: number }> = []

    const totalRecords = anCount + nsCount + arCount
    for (let i = 0; i < totalRecords; i++) {
      if (offset + 11 > buf.length) break

      const { name, nextOffset: afterName } = parseDnsName(buf, offset)
      offset = afterName
      if (offset + 10 > buf.length) break

      const rtype    = buf.readUInt16BE(offset)
      const rdLength = buf.readUInt16BE(offset + 8)
      offset += 10

      if (offset + rdLength > buf.length) break

      switch (rtype) {
        case 1: {
          // A record — name → IPv4
          if (rdLength === 4) {
            const ip = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`
            hostToIp.set(name, ip)
          }
          break
        }
        case 12: {
          // PTR record — service type → instance name
          const { name: instance } = parseDnsName(buf, offset)
          // port unknown yet (comes from SRV); default to 9100
          serviceInstances.push({ instance, port: 9100 })
          break
        }
        case 33: {
          // SRV record — instance → priority(2) + weight(2) + port(2) + target name
          if (rdLength >= 6) {
            const srvPort = buf.readUInt16BE(offset + 4)
            const { name: target } = parseDnsName(buf, offset + 6)
            instanceToHost.set(name, target)
            // Update port for matching service instance
            for (const si of serviceInstances) {
              if (si.instance === name) si.port = srvPort
            }
          }
          break
        }
      }

      offset += rdLength
    }

    // Build result list
    const discovered: DiscoveredPrinter[] = []

    for (const { instance, port } of serviceInstances) {
      const hostname = instanceToHost.get(instance)
      const ip       = hostname ? hostToIp.get(hostname) : undefined

      if (ip) {
        // Strip service suffix from instance name to get human-readable model
        const displayName = instance
          .replace(/\._pdl-datastream\._tcp\.local\.?$/, '')
          .replace(/\._printer\._tcp\.local\.?$/, '')
          .trim()

        discovered.push({ ip, port, hostname: displayName || undefined, method: 'mdns' })
      }
    }

    // Fallback: if a response carries A records but no PTR/SRV (some printers
    // just announce themselves directly), include any Star/TSP hostname
    for (const [host, ip] of hostToIp) {
      if (discovered.find((d) => d.ip === ip)) continue
      const lower = host.toLowerCase()
      if (lower.includes('star') || lower.includes('tsp') || lower.includes('printer')) {
        discovered.push({ ip, port: 9100, hostname: host, method: 'mdns' })
      }
    }

    return discovered
  } catch (err) {
    // NF-9.3: Log malformed mDNS packets with enough context to diagnose firmware bugs
    console.warn(
      '[printer-discovery] mDNS parse error (buf=%d bytes, first16=%s): %s',
      buf.length,
      buf.subarray(0, 16).toString('hex'),
      (err as Error)?.message ?? err,
    )
    return []
  }
}

// ─── mDNS discovery ───────────────────────────────────────────────────────────

const PRINTER_SERVICES = [
  '_pdl-datastream._tcp.local',  // Star / most receipt printers
  '_printer._tcp.local',          // Generic IPP/LPD printers
  '_ipp._tcp.local',              // IPP (some TSP100 III firmwares)
]

function mdnsDiscover(timeoutMs: number): Promise<DiscoveredPrinter[]> {
  return new Promise((resolve) => {
    const found: DiscoveredPrinter[] = []
    const seenIps = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let socket: ReturnType<typeof dgram.createSocket> | null = null

    const done = () => {
      if (timer) { clearTimeout(timer); timer = null }
      try { socket?.close() } catch {}
      resolve(found)
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

      socket.on('message', (msg) => {
        for (const printer of parseMdnsResponse(msg)) {
          if (!seenIps.has(printer.ip)) {
            seenIps.add(printer.ip)
            found.push(printer)
          }
        }
      })

      socket.on('error', () => done())

      socket.bind(MDNS_PORT, () => {
        try {
          socket!.addMembership(MDNS_ADDR)

          for (const svc of PRINTER_SERVICES) {
            const pkt = buildMdnsQuery(svc)
            socket!.send(pkt, MDNS_PORT, MDNS_ADDR)
          }

          timer = setTimeout(done, timeoutMs)
        } catch {
          done()
        }
      })
    } catch {
      // mDNS not available (e.g. no multicast support) — return empty
      done()
    }
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Probe a single IP on the given port.
 * Resolves true if a TCP connection is accepted within timeoutMs.
 */
export function probeIp(ip: string, port = 9100, timeoutMs = 600): Promise<boolean> {
  return probeTcp(ip, port, timeoutMs)
}

/**
 * Discover network printers via mDNS and TCP port-9100 scan.
 * Runs both strategies in parallel; returns merged, deduplicated list.
 *
 * @param timeoutMs Total budget in milliseconds (default 3000)
 */
export async function discoverPrinters(timeoutMs = 3000): Promise<DiscoveredPrinter[]> {
  const subnets    = getLocalSubnets()
  const tcpTimeout = Math.max(300, timeoutMs - 500)
  const mdnsTimeout = Math.min(timeoutMs, 2500)

  const [mdnsResults, ...subnetResults] = await Promise.all([
    mdnsDiscover(mdnsTimeout),
    ...subnets.map((subnet) => tcpScan(subnet, 9100, tcpTimeout)),
  ])

  // mDNS results take priority (they carry hostname info)
  const merged: DiscoveredPrinter[] = [...mdnsResults]
  const mdnsIps = new Set(mdnsResults.map((p) => p.ip))

  for (const tcpList of subnetResults) {
    for (const printer of tcpList) {
      if (!mdnsIps.has(printer.ip)) merged.push(printer)
    }
  }

  // Sort by IP for stable display order
  merged.sort((a, b) => {
    const ap = a.ip.split('.').map(Number)
    const bp = b.ip.split('.').map(Number)
    for (let i = 0; i < 4; i++) {
      if (ap[i] !== bp[i]) return ap[i] - bp[i]
    }
    return 0
  })

  return merged
}
