import dns from 'node:dns/promises';
import { ApplicationFailure } from '@temporalio/activity';

export interface BlockedCidr {
  readonly cidr: string;
  readonly name: string;
}

export interface SsrfValidationResult {
  readonly safe: boolean;
  readonly resolvedIps?: string[];
  readonly reason?: string;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchesCidr(ipInt: number, cidr: string): boolean {
  const [baseIp, prefixLengthStr] = cidr.split('/');
  const prefixLength = Number(prefixLengthStr);
  const baseInt = ipv4ToInt(baseIp);
  const mask = prefixLength === 0 ? 0 : ((0xffffffff << (32 - prefixLength)) >>> 0);
  return (ipInt & mask) === (baseInt & mask);
}

export class SsrfGuard {
  public static readonly BLOCKED_IPV4_RANGES: readonly BlockedCidr[] = [
    { cidr: '0.0.0.0/8', name: 'Current network' },
    { cidr: '10.0.0.0/8', name: 'RFC 1918 Private' },
    { cidr: '100.64.0.0/10', name: 'Carrier-grade NAT' },
    { cidr: '127.0.0.0/8', name: 'Loopback' },
    { cidr: '169.254.0.0/16', name: 'Link-local / Cloud IMDS' },
    { cidr: '172.16.0.0/12', name: 'RFC 1918 Private' },
    { cidr: '192.0.0.0/24', name: 'IETF Protocol Assignments' },
    { cidr: '192.168.0.0/16', name: 'RFC 1918 Private' },
    { cidr: '198.18.0.0/15', name: 'Benchmarking' },
    { cidr: '224.0.0.0/4', name: 'Multicast' },
    { cidr: '240.0.0.0/4', name: 'Reserved' },
    { cidr: '255.255.255.255/32', name: 'Broadcast' },
  ];

  public static readonly BLOCKED_HOSTNAMES: readonly string[] = [
    'localhost',
    'metadata.google.internal',
    'metadata',
    'instance-data',
  ];

  /**
   * Tests if an IPv4 address string falls into any blocked CIDR range.
   */
  public static isBlockedIpv4(ip: string): { blocked: boolean; rangeName?: string } {
    try {
      const ipInt = ipv4ToInt(ip);
      for (const range of this.BLOCKED_IPV4_RANGES) {
        if (matchesCidr(ipInt, range.cidr)) {
          return { blocked: true, rangeName: range.name };
        }
      }
      return { blocked: false };
    } catch {
      return { blocked: true, rangeName: 'Malformed IP address' };
    }
  }

  /**
   * Tests if an IPv6 address string is private, loopback, link-local, or IPv4-mapped blocked.
   */
  public static isBlockedIpv6(ip: string): { blocked: boolean; rangeName?: string } {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') {
      return { blocked: true, rangeName: 'Loopback / Unspecified IPv6' };
    }
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
      const v4Part = normalized.replace('::ffff:', '');
      if (v4Part.includes('.')) {
        return this.isBlockedIpv4(v4Part);
      }
    }
    // Unique Local Address (ULA) fc00::/7
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) {
      return { blocked: true, rangeName: 'IPv6 Unique Local Address (ULA)' };
    }
    // Link-Local unicast fe80::/10
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
      return { blocked: true, rangeName: 'IPv6 Link-Local Unicast' };
    }
    return { blocked: false };
  }

  /**
   * Validates a URL against protocol, hostname, and resolved IP restrictions.
   */
  public static async validateUrl(urlString: string): Promise<SsrfValidationResult> {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch (err: any) {
      return { safe: false, reason: `Malformed URL: ${err.message}` };
    }

    // 1. Strict protocol validation
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        safe: false,
        reason: `Disallowed URL protocol: ${parsed.protocol}. Only http: and https: are allowed.`,
      };
    }

    const hostname = parsed.hostname.toLowerCase();

    // 2. Blocked hostnames check
    if (
      this.BLOCKED_HOSTNAMES.includes(hostname) ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return {
        safe: false,
        reason: `Target hostname is blocked: ${hostname}`,
      };
    }

    // 3. DNS Pre-resolution & IP blocklist validation
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

    for (const ip of resolvedIps) {
      // IPv4
      if (ip.includes('.')) {
        const v4Check = this.isBlockedIpv4(ip);
        if (v4Check.blocked) {
          return {
            safe: false,
            resolvedIps,
            reason: `Resolved IP ${ip} for ${hostname} falls into blocked range: ${v4Check.rangeName}`,
          };
        }
      } else {
        // IPv6
        const v6Check = this.isBlockedIpv6(ip);
        if (v6Check.blocked) {
          return {
            safe: false,
            resolvedIps,
            reason: `Resolved IPv6 ${ip} for ${hostname} falls into blocked range: ${v6Check.rangeName}`,
          };
        }
      }
    }

    return { safe: true, resolvedIps };
  }

  /**
   * Asserts URL is safe, throwing an ApplicationFailure if blocked.
   */
  public static async assertUrlIsSafe(urlString: string): Promise<string[]> {
    const result = await this.validateUrl(urlString);
    if (!result.safe) {
      throw ApplicationFailure.nonRetryable(
        result.reason || 'SSRF violation: destination URL is prohibited',
        'SSRF_BLOCKED',
        { url: urlString, resolvedIps: result.resolvedIps }
      );
    }
    return result.resolvedIps || [];
  }
}
