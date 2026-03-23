/**
 * Merchant dashboard IP allowlist middleware
 *
 * Restricts access to staff-facing routes (/merchant, /api/auth/*, /api/merchants/*)
 * to a configurable set of IP addresses or CIDR ranges.  Supports both IPv4 and IPv6.
 *
 * Configuration (v2/.env):
 *
 *   RESTRICT_MERCHANT_TO_LOCAL=true
 *     Auto-includes all RFC 1918 private ranges (IPv4) and RFC 4193/4291 private
 *     ranges (IPv6):
 *       IPv4 : 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
 *       IPv6 : ::1/128 (loopback), fe80::/10 (link-local), fc00::/7 (ULA)
 *     Use this to allow any device on the same LAN (restaurant WiFi).
 *     NOTE: Devices with public IPv6 addresses (e.g. Comcast/ISP-assigned) are NOT
 *     covered by these ranges — add their /64 subnet to ALLOWED_MERCHANT_IPS.
 *
 *   ALLOWED_MERCHANT_IPS=203.0.113.42,198.51.100.0/24,2600:382:30e1:405::/64
 *     Comma-separated list of individual IPs or CIDR ranges (IPv4 or IPv6).
 *     Combined with RESTRICT_MERCHANT_TO_LOCAL if both are set.
 *     Use this to add a home IP/subnet on top of the local network allowlist.
 *
 * If neither variable is set, the middleware is disabled and all IPs are allowed.
 *
 * IP extraction order (already resolved by the context middleware in server.ts):
 *   1. CF-Connecting-IP  — real client IP forwarded by Cloudflare Tunnel
 *   2. X-Forwarded-For   — first entry from a proxy chain
 *   3. X-Real-IP         — single-proxy header
 *   The resolved IP is stored in the Hono context as 'ipAddress'.
 *
 * Android / iOS tablets tip: modern devices on a dual-stack network often advertise
 * a public IPv6 address (e.g. 2600::/24 for Comcast) even when on a local WiFi.
 * Add the router's delegated /64 prefix to ALLOWED_MERCHANT_IPS to cover all
 * devices on that network without listing each device individually.
 */

import type { MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// IPv4 CIDR matching
// ---------------------------------------------------------------------------

/** Convert a dotted-decimal IPv4 address to a 32-bit unsigned integer. */
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

/** Test whether an IPv4 address falls within a CIDR range or is an exact match. */
function matchesCidrV4(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr

  const [network, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr, 10)

  if (prefix === 0) return true  // 0.0.0.0/0 matches everything

  const mask = prefix === 32
    ? 0xffffffff
    : (~(0xffffffff >>> prefix)) >>> 0

  return (ipv4ToNum(ip) & mask) === (ipv4ToNum(network) & mask)
}

// ---------------------------------------------------------------------------
// IPv6 CIDR matching (BigInt — no external dependencies)
// ---------------------------------------------------------------------------

const MAX_IPV6 = (1n << 128n) - 1n

/**
 * Expand a potentially-abbreviated IPv6 address to its full 8-group form.
 * Handles '::' shorthand and does NOT validate the input — garbage in, garbage out.
 */
function expandIPv6(ip: string): string {
  // Strip optional zone ID (e.g. "fe80::1%eth0")
  const bare = ip.split('%')[0]

  if (!bare.includes('::')) return bare

  const [left, right] = bare.split('::')
  const leftParts  = left  ? left.split(':')  : []
  const rightParts = right ? right.split(':') : []
  const missing = 8 - leftParts.length - rightParts.length
  return [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':')
}

/** Convert a full (or abbreviated) IPv6 address to a 128-bit BigInt. */
function ipv6ToNum(ip: string): bigint {
  return expandIPv6(ip)
    .split(':')
    .reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16)), 0n)
}

/** Test whether an IPv6 address falls within a CIDR range or is an exact match. */
function matchesCidrV6(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.includes('/') ? cidr.split('/') : [cidr, '128']
  const prefix = parseInt(prefixStr, 10)

  if (prefix === 0) return true   // ::/0 matches everything
  if (prefix === 128) return ipv6ToNum(ip) === ipv6ToNum(network)

  // Top-prefix bits mask: set the top `prefix` bits to 1, rest to 0
  const mask = ~((1n << BigInt(128 - prefix)) - 1n) & MAX_IPV6

  return (ipv6ToNum(ip) & mask) === (ipv6ToNum(network) & mask)
}

// ---------------------------------------------------------------------------
// Unified matcher — dispatches on address family
// ---------------------------------------------------------------------------

/** Return true when `ip` is an IPv6 address (contains a colon). */
function isIPv6(ip: string): boolean {
  return ip.includes(':')
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address
 * (e.g. "::ffff:192.168.1.1" → "192.168.1.1").
 * Returns null for all other addresses.
 */
function extractIPv4Mapped(ip: string): string | null {
  const lower = ip.toLowerCase()
  if (lower.startsWith('::ffff:') && !lower.slice(7).includes(':')) {
    return lower.slice(7)
  }
  return null
}

/**
 * Test whether `ip` falls within `cidr`, handling IPv4 and IPv6 transparently.
 *
 * Cross-family mismatches (e.g. IPv4 IP vs IPv6 CIDR) return false.
 * IPv4-mapped IPv6 addresses are unwrapped and tested against IPv4 CIDRs.
 */
function matchesCidr(ip: string, cidr: string): boolean {
  const cidrIsV6  = isIPv6(cidr.split('/')[0])
  const ipIsV6    = isIPv6(ip)

  if (!ipIsV6 && !cidrIsV6) return matchesCidrV4(ip, cidr)  // IPv4 vs IPv4
  if ( ipIsV6 &&  cidrIsV6) return matchesCidrV6(ip, cidr)  // IPv6 vs IPv6

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) vs an IPv4 CIDR
  if (ipIsV6 && !cidrIsV6) {
    const v4 = extractIPv4Mapped(ip)
    return v4 !== null && matchesCidrV4(v4, cidr)
  }

  return false  // IPv4 IP vs IPv6 CIDR — no match
}

// ---------------------------------------------------------------------------
// Allowlist (built once at module load — no per-request env reads)
// ---------------------------------------------------------------------------

/** RFC 1918 IPv4 private ranges + loopback */
const PRIVATE_RANGES_V4 = [
  '10.0.0.0/8',       // Class A private
  '172.16.0.0/12',    // Class B private
  '192.168.0.0/16',   // Class C private
  '127.0.0.0/8',      // Loopback
]

/**
 * RFC 4291 / 4193 IPv6 private ranges.
 *
 * These cover loopback, link-local, and ULA (unique local) addresses.
 * They do NOT cover public IPv6 addresses assigned by ISPs to home routers
 * (e.g. 2600::/24 Comcast, 2001::/32 Teredo, etc.).  If your devices use
 * ISP-assigned public IPv6 addresses on a local WiFi, add the /64 prefix
 * to ALLOWED_MERCHANT_IPS (e.g. 2600:382:30e1:405::/64).
 */
const PRIVATE_RANGES_V6 = [
  '::1/128',          // IPv6 loopback
  'fe80::/10',        // Link-local (assigned by OS on every interface)
  'fc00::/7',         // Unique local addresses (ULA — fd00::/8 and fc00::/8)
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

  // M-08: Warn about overly broad IPv6 CIDR ranges
  for (const cidr of explicit) {
    const [addr, prefixStr] = cidr.split('/')
    if (isIPv6(addr) && prefixStr) {
      const prefix = parseInt(prefixStr, 10)
      if (!isNaN(prefix) && prefix < 64) {
        console.warn(
          `[ip-allowlist] ⚠️  IPv6 CIDR ${cidr} has a /${prefix} prefix (< /64). ` +
          `This covers 2^${128 - prefix} addresses and may be overly broad. Consider using /${Math.max(prefix, 64)} or narrower.`
        )
      }
    }
  }

  allowedCidrs.push(...explicit)
}

/** True when IP restriction is active (at least one range is configured). */
export const merchantIpRestrictionEnabled = allowedCidrs.length > 0

if (merchantIpRestrictionEnabled) {
  const v4 = allowedCidrs.filter(c => !isIPv6(c.split('/')[0]))
  const v6 = allowedCidrs.filter(c =>  isIPv6(c.split('/')[0]))
  console.log(`[ip-allowlist] Merchant access restricted.`)
  if (v4.length) console.log(`  IPv4: ${v4.join(', ')}`)
  if (v6.length) console.log(`  IPv6: ${v6.join(', ')}`)
} else {
  console.log('[ip-allowlist] No IP restriction configured — merchant routes are publicly accessible')
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that blocks requests from IPs not in the allowlist.
 *
 * Apply to staff-facing routes in server.ts:
 *   app.use('/merchant', merchantIpGuard)
 *   app.use('/setup', merchantIpGuard)
 *   app.use('/api/auth/*', merchantIpGuard)
 *   app.use('/api/merchants/*', merchantIpGuard)
 *
 * Responses:
 *   - API routes (/api/*): 403 JSON { error: 'Access denied' }
 *   - Browser routes (/merchant, /setup): redirect to customer store (/)
 */
export const merchantIpGuard: MiddlewareHandler = async (c, next) => {
  if (!merchantIpRestrictionEnabled) return next()
  // Never restrict in automated test environment
  if (process.env.NODE_ENV === 'test') return next()

  const ip = c.get('ipAddress') ?? 'unknown'

  if (ip !== 'unknown' && allowedCidrs.some(cidr => matchesCidr(ip, cidr))) {
    return next()
  }

  // Compute the /64 hint for IPv6 addresses so operators can copy-paste the fix
  let hint = ''
  if (ip !== 'unknown' && isIPv6(ip)) {
    const groups = expandIPv6(ip).split(':').slice(0, 4).join(':')
    hint = ` — to allow this device add ${groups}::/64 to ALLOWED_MERCHANT_IPS`
  }
  console.warn(`[ip-allowlist] Blocked request from ${ip} to ${c.req.path}${hint}`)

  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Browser navigation — redirect to the public customer store
  return c.redirect('/')
}
