import dns from 'node:dns/promises';
import { URL } from 'node:url';

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  readonly statusCode = 403;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.details = details;
  }
}

export class SsrfRedirectError extends Error {
  readonly code: string;
  readonly statusCode = 403;

  constructor(message: string, code: string = 'SSRF_REDIRECT_ERROR') {
    super(message);
    this.name = 'SsrfRedirectError';
    this.code = code;
  }
}

export interface CidrRangeV4 {
  name: string;
  cidr: string;
}

export interface CidrRangeV6 {
  name: string;
  cidr: string;
}

export const BLOCKED_IPV4_RANGES: readonly CidrRangeV4[] = [
  { name: 'Current network', cidr: '0.0.0.0/8' },
  { name: 'RFC 1918 Private Class A', cidr: '10.0.0.0/8' },
  { name: 'Carrier-Grade NAT (CGNAT)', cidr: '100.64.0.0/10' },
  { name: 'Loopback', cidr: '127.0.0.0/8' },
  { name: 'Link-Local / Cloud IMDS', cidr: '169.254.0.0/16' },
  { name: 'RFC 1918 Private Class B', cidr: '172.16.0.0/12' },
  { name: 'IETF Protocol Assignments', cidr: '192.0.0.0/24' },
  { name: 'TEST-NET-1', cidr: '192.0.2.0/24' },
  { name: '6to4 Anycast Relay', cidr: '192.88.99.0/24' },
  { name: 'RFC 1918 Private Class C', cidr: '192.168.0.0/16' },
  { name: 'Network Interconnect Benchmarking', cidr: '198.18.0.0/15' },
  { name: 'TEST-NET-2', cidr: '198.51.100.0/24' },
  { name: 'TEST-NET-3', cidr: '203.0.113.0/24' },
  { name: 'Multicast Class D', cidr: '224.0.0.0/4' },
  { name: 'Reserved Class E', cidr: '240.0.0.0/4' },
  { name: 'Limited Broadcast', cidr: '255.255.255.255/32' },
];

export const BLOCKED_IPV6_RANGES: readonly CidrRangeV6[] = [
  { name: 'Unspecified IPv6 Address', cidr: '::/128' },
  { name: 'Loopback IPv6 Address', cidr: '::1/128' },
  { name: 'IPv4-Compatible IPv6', cidr: '::/96' },
  { name: 'IPv4-Mapped IPv6', cidr: '::ffff:0:0/96' },
  { name: 'IPv4/IPv6 Translation (NAT64)', cidr: '64:ff9b::/96' },
  { name: 'Discard-Only Address Block', cidr: '100::/64' },
  { name: 'Documentation Prefix', cidr: '2001:db8::/32' },
  { name: 'Unique Local Address (ULA)', cidr: 'fc00::/7' },
  { name: 'Link-Local Unicast', cidr: 'fe80::/10' },
  { name: 'Site-Local Unicast', cidr: 'fec0::/10' },
  { name: 'Multicast IPv6', cidr: 'ff00::/8' },
];

export const BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
];

export const BLOCKED_HOSTNAME_SUFFIXES: readonly string[] = [
  '.internal',
  '.local',
  '.onion',
  '.localhost',
  '.arpa',
];

export interface SsrfValidationResult {
  safe: boolean;
  resolvedIps?: string[];
  reason?: string;
}

/**
 * Converts a standard dotted-quad IPv4 string into a 32-bit unsigned integer.
 */
export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => {
    const trimmed = p.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid IPv4 octet (non-digit): ${p}`);
    }
    const n = Number(trimmed);
    if (isNaN(n) || n < 0 || n > 255) {
      throw new Error(`Invalid IPv4 octet out of range [0-255]: ${p}`);
    }
    return n;
  });

  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 format: expected 4 octets, got ${parts.length}`);
  }

  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Matches a 32-bit unsigned integer IPv4 against a CIDR block string (e.g. 10.0.0.0/8).
 */
export function matchesCidrV4(ipInt: number, cidr: string): boolean {
  const [baseIp, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const baseInt = ipv4ToInt(baseIp);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Converts an arbitrary valid IPv6 string into a 128-bit unsigned BigInt.
 * Robustly normalizes double colon (::), embedded IPv4, zone indexes, and omitted leading zeros.
 */
export function ipv6ToBigInt(ip: string): bigint {
  let cleaned = ip.trim().toLowerCase();

  // Strip zone index if present (e.g. fe80::1%eth0)
  const zoneIdx = cleaned.indexOf('%');
  if (zoneIdx !== -1) {
    cleaned = cleaned.slice(0, zoneIdx);
  }

  // Handle embedded IPv4 dotted quad in IPv6 (e.g. ::ffff:192.168.1.1)
  const lastColon = cleaned.lastIndexOf(':');
  let v4Hextets: string[] = [];
  if (lastColon !== -1 && cleaned.slice(lastColon + 1).includes('.')) {
    const v4Part = cleaned.slice(lastColon + 1);
    cleaned = cleaned.slice(0, lastColon);
    const v4Octets = v4Part.split('.').map((o) => {
      const trimmed = o.trim();
      if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid IPv4 octet: ${o}`);
      const n = Number(trimmed);
      if (isNaN(n) || n < 0 || n > 255) throw new Error(`IPv4 octet out of range: ${o}`);
      return n;
    });
    if (v4Octets.length !== 4) {
      throw new Error(`Invalid embedded IPv4 part in IPv6: ${v4Part}`);
    }
    const h1 = ((v4Octets[0] << 8) | v4Octets[1]).toString(16);
    const h2 = ((v4Octets[2] << 8) | v4Octets[3]).toString(16);
    v4Hextets = [h1, h2];
  }

  const parts = cleaned.split('::');
  if (parts.length > 2) {
    throw new Error(`Invalid IPv6 address (multiple '::'): ${ip}`);
  }

  let hextets: string[] = [];
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = (parts[1] ? parts[1].split(':') : []).concat(v4Hextets);
    const missing = 8 - (left.length + right.length);
    if (missing < 0) {
      throw new Error(`Too many hextets in IPv6 address: ${ip}`);
    }
    hextets = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    hextets = parts[0].split(':').concat(v4Hextets);
    if (hextets.length !== 8) {
      throw new Error(`Invalid hextet count (${hextets.length}) in IPv6 address: ${ip}`);
    }
  }

  let result = 0n;
  for (let i = 0; i < 8; i++) {
    const hex = hextets[i] || '0';
    if (!/^[0-9a-f]{1,4}$/i.test(hex)) {
      throw new Error(`Invalid hex format in hextet '${hex}': ${ip}`);
    }
    const val = BigInt(parseInt(hex, 16));
    result = (result << 16n) | val;
  }
  return result;
}

/**
 * Matches a 128-bit unsigned BigInt IPv6 against an IPv6 CIDR block string (e.g. fc00::/7).
 */
export function matchesCidrV6(ipBigInt: bigint, cidr: string): boolean {
  const [baseIp, prefixStr] = cidr.split('/');
  const prefixLength = BigInt(prefixStr);
  const baseBigInt = ipv6ToBigInt(baseIp);
  const mask = prefixLength === 0n ? 0n : (((1n << prefixLength) - 1n) << (128n - prefixLength));
  return (ipBigInt & mask) === (baseBigInt & mask);
}

/**
 * Checks whether an IP address (IPv4 or IPv6) falls into any prohibited subnet.
 */
export function isBlockedIp(ip: string): { blocked: boolean; rangeName?: string } {
  const cleanIp = ip.replace(/^\[|\]$/g, '').trim();

  // IPv4 check
  if (cleanIp.includes('.') && !cleanIp.includes(':')) {
    try {
      const ipInt = ipv4ToInt(cleanIp);
      for (const range of BLOCKED_IPV4_RANGES) {
        if (matchesCidrV4(ipInt, range.cidr)) {
          return { blocked: true, rangeName: range.name };
        }
      }
      return { blocked: false };
    } catch {
      return { blocked: true, rangeName: 'Malformed IPv4 Address' };
    }
  }

  // IPv6 check
  try {
    const ipBigInt = ipv6ToBigInt(cleanIp);

    // Check if IPv4-mapped IPv6 (::ffff:0:0/96)
    if (matchesCidrV6(ipBigInt, '::ffff:0:0/96')) {
      const v4Int = Number(ipBigInt & 0xffffffffn);
      for (const range of BLOCKED_IPV4_RANGES) {
        if (matchesCidrV4(v4Int, range.cidr)) {
          return { blocked: true, rangeName: `IPv4-Mapped: ${range.name}` };
        }
      }
      return { blocked: false };
    }

    // Check IPv6 blocked CIDR table
    for (const range of BLOCKED_IPV6_RANGES) {
      if (matchesCidrV6(ipBigInt, range.cidr)) {
        return { blocked: true, rangeName: range.name };
      }
    }
    return { blocked: false };
  } catch {
    return { blocked: true, rangeName: 'Malformed IPv6 Address' };
  }
}

export class SsrfEgressGuard {
  /**
   * Validates a target URL against protocol whitelist, blocked hostnames, and bitwise CIDR firewall.
   * Performs full DNS pre-resolution and checks EVERY returned A/AAAA record (fail-closed).
   */
  public static async validateUrl(urlString: string): Promise<SsrfValidationResult> {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch (err: any) {
      return { safe: false, reason: `Malformed URL: ${err.message}` };
    }

    // 1. Protocol Whitelist (only http: and https:)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        safe: false,
        reason: `Disallowed URL protocol: '${parsed.protocol}'. Only http: and https: are allowed.`,
      };
    }

    const hostname = parsed.hostname.toLowerCase();

    // 2. Blocked Hostnames & Suffixes
    if (
      BLOCKED_HOSTNAMES.includes(hostname) ||
      BLOCKED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))
    ) {
      return {
        safe: false,
        reason: `Target hostname is blocked: ${hostname}`,
      };
    }

    // 3. Direct IP Literal Check
    const directIpCheck = isBlockedIp(hostname);
    if (
      directIpCheck.blocked &&
      directIpCheck.rangeName !== 'Malformed IPv4 Address' &&
      directIpCheck.rangeName !== 'Malformed IPv6 Address'
    ) {
      return {
        safe: false,
        resolvedIps: [hostname],
        reason: `Target IP ${hostname} falls into blocked range: ${directIpCheck.rangeName}`,
      };
    }

    // 4. DNS Pre-Resolution
    let resolvedIps: string[] = [];
    try {
      const records = await dns.lookup(hostname, { all: true });
      resolvedIps = records.map((r) => r.address);
    } catch (err: any) {
      return {
        safe: false,
        reason: `DNS lookup failed for hostname '${hostname}': ${err.message}`,
      };
    }

    if (resolvedIps.length === 0) {
      return {
        safe: false,
        reason: `DNS resolution returned zero IP addresses for hostname '${hostname}'`,
      };
    }

    // Fail-Closed: Assert EVERY resolved A/AAAA record
    for (const ip of resolvedIps) {
      const check = isBlockedIp(ip);
      if (check.blocked) {
        return {
          safe: false,
          resolvedIps,
          reason: `Resolved IP ${ip} for ${hostname} falls into blocked range: ${check.rangeName}`,
        };
      }
    }

    return { safe: true, resolvedIps };
  }

  /**
   * Asserts that a target URL is safe. If unsafe, throws SsrfBlockedError.
   * Returns array of pre-resolved safe IP addresses.
   */
  public static async assertUrlIsSafe(urlString: string): Promise<string[]> {
    const result = await this.validateUrl(urlString);
    if (!result.safe) {
      throw new SsrfBlockedError(
        `SSRF Protection Violation: ${result.reason}`,
        { targetUrl: urlString, resolvedIps: result.resolvedIps, reason: result.reason }
      );
    }
    return result.resolvedIps || [];
  }
}
