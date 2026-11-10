/**
 * SSRF guard for test runs (F12 security hardening).
 *
 * Used by goto and api_request steps (DNS-level check) and by page.route
 * interception (covers browser-level redirects and sub-requests).
 *
 * Always blocked regardless of settings:
 *   - 169.254.0.0/16 link-local (cloud metadata IP on AWS/GCE/Azure)
 *   - fe80::/10 link-local IPv6
 *   - Known cloud metadata hostnames: metadata.google.internal, metadata.azure.internal,
 *     metadata.internal, etc.
 *
 * Controlled by settings key test.allowPrivateNetworks (default 'true'):
 *   true  — loopback (127.x.x.x, ::1) and RFC-1918 private ranges allowed (local dev)
 *   false — all private/loopback addresses blocked in addition to the always-blocked set
 */

import dns from 'node:dns/promises';

// ── IP range helpers ──────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  return parts.reduce((acc, p) => (acc * 256 + parseInt(p, 10)), 0);
}

function inCidr4(ip: string, cidr: string): boolean {
  const [network, bits] = cidr.split('/');
  const mask = bits ? ~((1 << (32 - parseInt(bits, 10))) - 1) : -1;
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  return !isNaN(ipInt) && !isNaN(netInt) && (ipInt & mask) === (netInt & mask);
}

/**
 * Normalise alternate IPv4 representations to dotted-decimal notation:
 *   - Decimal integer:  2852039166           → "169.254.169.254"
 *   - Octal octets:     0251.0376.0251.0376  → "169.254.169.254"
 *   - Hex octets:       0xa9.0xfe.0xa9.0xfe  → "169.254.169.254"
 * Returns the normalised string, or null if the input cannot be parsed.
 */
export function normaliseIpv4(raw: string): string | null {
  // Already dotted — try parsing each octet (possibly octal/hex)
  const parts = raw.split('.');
  if (parts.length === 4) {
    const octets = parts.map((p) => {
      const n = Number(p); // handles 0x... and octal strings via Number()
      // Number() does NOT parse octal literals like 0251 — use parseInt with radix
      if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
      return Number(p);
    });
    if (octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255)) {
      return octets.join('.');
    }
  }

  // Pure decimal integer (no dots)
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8)  & 0xff,
        n          & 0xff,
      ].join('.');
    }
  }

  // Hex integer  0x...
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    const n = parseInt(raw, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8)  & 0xff,
        n          & 0xff,
      ].join('.');
    }
  }

  return null;
}

/**
 * Normalise an IPv4-mapped IPv6 address to its dotted-decimal IPv4 form.
 *
 * Handles:
 *   ::ffff:a.b.c.d          (standard mapped form)
 *   ::ffff:0102:0304        (hex-word form)
 *   ::ffff:0a00:0005        (hex-word form with leading zeroes)
 *
 * Returns null if the input is not an IPv4-mapped IPv6 address.
 */
export function extractMappedIpv4(addr: string): string | null {
  const lower = addr.toLowerCase();

  // Standard form ::ffff:a.b.c.d
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  // Hex-word form ::ffff:hhhh:hhhh
  const hexWord = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexWord) {
    const hi = parseInt(hexWord[1], 16);
    const lo = parseInt(hexWord[2], 16);
    return [
      (hi >>> 8) & 0xff,
      hi         & 0xff,
      (lo >>> 8) & 0xff,
      lo         & 0xff,
    ].join('.');
  }

  return null;
}

// ── Always-blocked hostnames (cloud metadata) ─────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.internal',
  '169.254.169.254',    // AWS/GCE/Azure metadata endpoint
  '169.254.169.250',    // Azure WireServer
  '169.254.169.251',    // Azure Hybrid
  '169.254.170.2',      // ECS task metadata
]);

// ── IP classification ──────────────────────────────────────────────────────────

function isAlwaysBlockedIpv4(ip: string): boolean {
  return inCidr4(ip, '169.254.0.0/16'); // link-local
}

function isPrivateIpv4(ip: string): boolean {
  return (
    inCidr4(ip, '10.0.0.0/8') ||
    inCidr4(ip, '172.16.0.0/12') ||
    inCidr4(ip, '192.168.0.0/16')
  );
}

function isLoopbackIpv4(ip: string): boolean {
  return inCidr4(ip, '127.0.0.0/8');
}

function isAlwaysBlockedIpv6(ip: string): boolean {
  // fe80::/10 — link-local
  const lower = ip.toLowerCase();
  return lower.startsWith('fe8') || lower.startsWith('fe9') ||
    lower.startsWith('fea') || lower.startsWith('feb');
}

function isLoopbackIpv6(ip: string): boolean {
  return ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ── Main check ────────────────────────────────────────────────────────────────

export interface SsrfCheckResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check whether a URL hostname is safe to connect to.
 *
 * @param hostname  The hostname or IP to check (already extracted from the URL).
 * @param allowPrivateNetworks  Whether loopback + RFC-1918 ranges are permitted.
 *                              Cloud metadata endpoints are ALWAYS blocked.
 */
export async function checkSsrf(
  hostname: string,
  allowPrivateNetworks: boolean,
): Promise<SsrfCheckResult> {
  // 1. Reject known metadata hostnames without even resolving
  const lc = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lc)) {
    return { blocked: true, reason: `Hostname "${hostname}" is a blocked cloud metadata endpoint` };
  }

  // 2. Determine the set of IPs to check.
  //    If hostname is already an IP literal, skip DNS and check it directly.
  //    Also normalise alternate IPv4 representations (decimal, octal, hex, IPv4-mapped IPv6).
  const isIpv4Literal = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  // IPv6 literals may contain ':'; IPv4-mapped IPv6 (::ffff:a.b.c.d) also contains dots
  const isIpv6Literal = hostname.startsWith('[') || hostname.includes(':');
  // Non-standard IPv4 encodings (pure decimal int, hex int, octal octets)
  const isAltIpv4 = !isIpv4Literal && !isIpv6Literal && normaliseIpv4(hostname) !== null;

  let addrs: string[];
  if (isIpv4Literal || isAltIpv4) {
    const normalised = normaliseIpv4(hostname);
    addrs = normalised ? [normalised] : [hostname];
  } else if (isIpv6Literal) {
    const stripped = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    // Check for IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh)
    const mapped = extractMappedIpv4(stripped);
    addrs = mapped ? [stripped, mapped] : [stripped];
  } else {
    // Resolve via DNS
    const v4 = await dns.resolve4(hostname).catch(() => [] as string[]);
    const v6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    addrs = [...v4, ...v6];
    if (addrs.length === 0) {
      // DNS failed to resolve — allow (the subsequent request will just fail)
      return { blocked: false };
    }
  }

  for (const addr of addrs) {
    // Always block link-local IPv4 and IPv6
    if (isAlwaysBlockedIpv4(addr)) {
      return { blocked: true, reason: `Address ${addr} is in link-local range 169.254.0.0/16` };
    }
    if (isAlwaysBlockedIpv6(addr)) {
      return { blocked: true, reason: `Address ${addr} is in link-local IPv6 range fe80::/10` };
    }
    // Check IPv4-mapped IPv6 (::ffff:169.254.x.x etc.)
    const mappedV4 = extractMappedIpv4(addr);
    if (mappedV4 && isAlwaysBlockedIpv4(mappedV4)) {
      return { blocked: true, reason: `Address ${addr} is an IPv4-mapped IPv6 in link-local range` };
    }

    // If private networks are not allowed, also block loopback + RFC-1918
    if (!allowPrivateNetworks) {
      if (isLoopbackIpv4(addr)) {
        return { blocked: true, reason: `Address ${addr} is loopback (test.allowPrivateNetworks=false)` };
      }
      if (isLoopbackIpv6(addr)) {
        return { blocked: true, reason: `Address ${addr} is loopback (test.allowPrivateNetworks=false)` };
      }
      if (isPrivateIpv4(addr)) {
        return { blocked: true, reason: `Address ${addr} is in a private RFC-1918 range (test.allowPrivateNetworks=false)` };
      }
    }
  }

  return { blocked: false };
}

/**
 * Convenience wrapper: throws an Error if the URL is blocked.
 */
export async function assertNotBlocked(
  url: string,
  allowPrivateNetworks: boolean,
): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return; // unparseable URL will fail naturally
  }
  const result = await checkSsrf(hostname, allowPrivateNetworks);
  if (result.blocked) {
    throw new Error(`SSRF blocked: ${result.reason}`);
  }
}
