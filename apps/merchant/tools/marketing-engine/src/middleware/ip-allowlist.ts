/**
 * Marketing dashboard IP allowlist middleware
 *
 * Restricts access to /marketing/* to a configurable set of IP addresses or
 * CIDR ranges.  Uses the same environment variables as the Kizo merchant
 * dashboard so operators only need one set of IPs in their env file.
 *
 * Configuration:
 *
 *   RESTRICT_MERCHANT_TO_LOCAL=true
 *     Auto-includes all RFC 1918 / RFC 4193 private ranges:
 *       IPv4 : 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
 *       IPv6 : ::1/128, fe80::/10, fc00::/7
 *
 *   ALLOWED_MERCHANT_IPS=203.0.113.42,198.51.100.0/24,2600:382:30e1:405::/64
 *     Comma-separated individual IPs or CIDR ranges (IPv4 or IPv6).
 *     Combined with RESTRICT_MERCHANT_TO_LOCAL when both are set.
 *
 * If neither variable is set the middleware is disabled and all IPs are allowed.
 *
 * IP extraction order (Cloudflare Tunnel → proxy → direct):
 *   1. CF-Connecting-IP
 *   2. X-Forwarded-For  (first entry)
 *   3. X-Real-IP
 */

import type { MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// IPv4 CIDR matching
// ---------------------------------------------------------------------------

function ipv4ToNum(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) return 0
  return (
    ((parseInt(parts[0], 10) << 24) |
     (parseInt(parts[1], 10) << 16) |
     (parseInt(parts[2], 10) <<  8) |
      parseInt(parts[3], 10)) >>> 0
  )
}

function matchesCidrV4(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr
  const [network, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr, 10)
  if (prefix === 0) return true
  const mask = prefix === 32 ? 0xffffffff : (~(0xffffffff >>> prefix)) >>> 0
  return (ipv4ToNum(ip) & mask) === (ipv4ToNum(network) & mask)
}

// ---------------------------------------------------------------------------
// IPv6 CIDR matching (BigInt)
// ---------------------------------------------------------------------------

const MAX_IPV6 = (1n << 128n) - 1n

function expandIPv6(ip: string): string {
  const bare = ip.split('%')[0]
  if (!bare.includes('::')) return bare
  const [left, right] = bare.split('::')
  const leftParts  = left  ? left.split(':')  : []
  const rightParts = right ? right.split(':') : []
  const missing = 8 - leftParts.length - rightParts.length
  return [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':')
}

function ipv6ToNum(ip: string): bigint {
  return expandIPv6(ip)
    .split(':')
    .reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16)), 0n)
}

function matchesCidrV6(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.includes('/') ? cidr.split('/') : [cidr, '128']
  const prefix = parseInt(prefixStr, 10)
  if (prefix === 0)   return true
  if (prefix === 128) return ipv6ToNum(ip) === ipv6ToNum(network)
  const mask = ~((1n << BigInt(128 - prefix)) - 1n) & MAX_IPV6
  return (ipv6ToNum(ip) & mask) === (ipv6ToNum(network) & mask)
}

// ---------------------------------------------------------------------------
// Unified matcher
// ---------------------------------------------------------------------------

function isIPv6(ip: string): boolean { return ip.includes(':') }

function extractIPv4Mapped(ip: string): string | null {
  const lower = ip.toLowerCase()
  if (lower.startsWith('::ffff:') && !lower.slice(7).includes(':')) return lower.slice(7)
  return null
}

function matchesCidr(ip: string, cidr: string): boolean {
  const cidrIsV6 = isIPv6(cidr.split('/')[0])
  const ipIsV6   = isIPv6(ip)
  if (!ipIsV6 && !cidrIsV6) return matchesCidrV4(ip, cidr)
  if ( ipIsV6 &&  cidrIsV6) return matchesCidrV6(ip, cidr)
  if ( ipIsV6 && !cidrIsV6) {
    const v4 = extractIPv4Mapped(ip)
    return v4 !== null && matchesCidrV4(v4, cidr)
  }
  return false
}

// ---------------------------------------------------------------------------
// Allowlist — built once at module load
// ---------------------------------------------------------------------------

const PRIVATE_RANGES_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
]

const PRIVATE_RANGES_V6 = [
  '::1/128',
  'fe80::/10',
  'fc00::/7',
]

const allowedCidrs: string[] = []

if (process.env.RESTRICT_MERCHANT_TO_LOCAL === 'true') {
  allowedCidrs.push(...PRIVATE_RANGES_V4, ...PRIVATE_RANGES_V6)
}

if (process.env.ALLOWED_MERCHANT_IPS) {
  const explicit = process.env.ALLOWED_MERCHANT_IPS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  for (const cidr of explicit) {
    const [addr, prefixStr] = cidr.split('/')
    if (isIPv6(addr) && prefixStr) {
      const prefix = parseInt(prefixStr, 10)
      if (!isNaN(prefix) && prefix < 64) {
        console.warn(
          `[marketing-ip-allowlist] ⚠️  IPv6 CIDR ${cidr} has a /${prefix} prefix (< /64). ` +
          `Consider using /${Math.max(prefix, 64)} or narrower.`
        )
      }
    }
  }

  allowedCidrs.push(...explicit)
}

export const marketingIpRestrictionEnabled = allowedCidrs.length > 0

if (marketingIpRestrictionEnabled) {
  const v4 = allowedCidrs.filter(c => !isIPv6(c.split('/')[0]))
  const v6 = allowedCidrs.filter(c =>  isIPv6(c.split('/')[0]))
  console.log(`[marketing-ip-allowlist] Marketing dashboard access restricted.`)
  if (v4.length) console.log(`  IPv4: ${v4.join(', ')}`)
  if (v6.length) console.log(`  IPv6: ${v6.join(', ')}`)
} else {
  console.log('[marketing-ip-allowlist] No IP restriction — /marketing/* is publicly accessible')
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that blocks requests to /marketing/* from IPs not in the
 * allowlist.  Apply before marketing routes in server.ts:
 *
 *   app.use('/marketing/*', marketingIpGuard)
 *   app.route('/', marketing)
 */
export const marketingIpGuard: MiddlewareHandler = async (c, next) => {
  if (!marketingIpRestrictionEnabled) return next()
  if (process.env.NODE_ENV === 'test') return next()

  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'

  if (ip !== 'unknown' && allowedCidrs.some(cidr => matchesCidr(ip, cidr))) {
    return next()
  }

  let hint = ''
  if (ip !== 'unknown' && isIPv6(ip)) {
    const groups = expandIPv6(ip).split(':').slice(0, 4).join(':')
    hint = ` — to allow this device add ${groups}::/64 to ALLOWED_MERCHANT_IPS`
  }
  console.warn(`[marketing-ip-allowlist] Blocked request from ${ip} to ${c.req.path}${hint}`)

  if (c.req.path.startsWith('/marketing/') && c.req.header('accept')?.includes('application/json')) {
    return c.json({ error: 'Access denied' }, 403)
  }

  return c.redirect('/')
}
