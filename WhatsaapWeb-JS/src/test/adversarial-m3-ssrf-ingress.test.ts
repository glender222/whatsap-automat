// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { SsrfGuard } = require('../services/temporal/activities/ssrfGuard') as typeof import('../services/temporal/activities/ssrfGuard');
const { executeHttpRequestActivity } = require('../services/temporal/activities/executeHttpRequestActivity') as typeof import('../services/temporal/activities/executeHttpRequestActivity');

describe('Adversarial Penetration: SSRF Multi-Layer Firewall', () => {
  // ---------------------------------------------------------------------------
  // SUITE 1: SSRF Firewall Penetration & Filter Evasion
  // ---------------------------------------------------------------------------
  describe('Suite 1: SSRF Penetration & Bypass Attacks', () => {
    test('1.1 RFC 1918 Private IPv4 Ranges: strictly blocked across all classes and subnets', () => {
      const privateIps = [
        // Class A (10.0.0.0/8)
        '10.0.0.1',
        '10.0.0.254',
        '10.128.0.1',
        '10.255.255.254',
        '10.255.255.255',
        // Class B (172.16.0.0/12)
        '172.16.0.1',
        '172.20.10.5',
        '172.31.255.254',
        '172.31.255.255',
        // Class C (192.168.0.0/16)
        '192.168.0.1',
        '192.168.1.1',
        '192.168.100.254',
        '192.168.255.255',
      ];

      for (const ip of privateIps) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, true, `Failed to block RFC 1918 private IP: ${ip}`);
        assert.strictEqual(check.rangeName, 'RFC 1918 Private');
      }

      // Boundary arithmetic validation: adjacent public IPs MUST NOT be blocked
      const publicBoundaries = ['172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '9.255.255.255', '11.0.0.0'];
      for (const ip of publicBoundaries) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, false, `Public boundary IP incorrectly blocked: ${ip}`);
      }
    });

    test('1.2 Loopback, IMDS, CGNAT, Multicast, Reserved & Broadcast IPv4 ranges', () => {
      const testCases: [string, string][] = [
        ['127.0.0.1', 'Loopback'],
        ['127.0.0.2', 'Loopback'],
        ['127.255.255.254', 'Loopback'],
        ['169.254.169.254', 'Link-local / Cloud IMDS'],
        ['169.254.0.1', 'Link-local / Cloud IMDS'],
        ['100.64.0.1', 'Carrier-grade NAT'],
        ['100.100.100.200', 'Carrier-grade NAT'], // Alibaba Cloud IMDS
        ['100.127.255.255', 'Carrier-grade NAT'],
        ['0.0.0.0', 'Current network'],
        ['0.255.255.255', 'Current network'],
        ['198.18.0.1', 'Benchmarking'],
        ['224.0.0.1', 'Multicast'],
        ['239.255.255.255', 'Multicast'],
        ['240.0.0.1', 'Reserved'],
        ['255.255.255.255', 'Reserved'], // Matched by 240.0.0.0/4 Reserved first
      ];

      for (const [ip, expectedRange] of testCases) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, true, `Failed to block IP: ${ip}`);
        assert.strictEqual(check.rangeName, expectedRange);
      }
    });

    test('1.3 Obfuscated and alternate IPv4 representations in URLs', async () => {
      const obfuscatedUrls = [
        // Decimal integer IP
        { url: 'http://2130706433/admin', expectedIp: '127.0.0.1' }, // 127.0.0.1
        { url: 'http://2852039166/latest/meta-data', expectedIp: '169.254.169.254' }, // 169.254.169.254
        { url: 'http://167772161/api', expectedIp: '10.0.0.1' }, // 10.0.0.1
        // Hexadecimal representation
        { url: 'http://0x7f000001/', expectedIp: '127.0.0.1' },
        { url: 'http://0xa9fea9fe/', expectedIp: '169.254.169.254' },
        { url: 'http://0x0a000001/', expectedIp: '10.0.0.1' },
        // Dotted Hex & Octal
        { url: 'http://0x7f.0.0.1/', expectedIp: '127.0.0.1' },
        { url: 'http://0177.0.0.1/', expectedIp: '127.0.0.1' },
        { url: 'http://012.0.0.1/', expectedIp: '10.0.0.1' },
        // Shortened dotted & Zero IP
        { url: 'http://127.1/', expectedIp: '127.0.0.1' },
        { url: 'http://0/', expectedIp: '0.0.0.0' },
        // URL encoded characters
        { url: 'http://%31%32%37%2E%30%2E%30%2E%31/', expectedIp: '127.0.0.1' },
      ];

      for (const item of obfuscatedUrls) {
        const result = await SsrfGuard.validateUrl(item.url);
        assert.strictEqual(result.safe, false, `Obfuscated URL bypassed filter: ${item.url}`);
        assert.ok(
          result.reason?.includes(item.expectedIp) || result.reason?.includes('blocked range') || result.reason?.includes('Current network'),
          `Unexpected reason for ${item.url}: ${result.reason}`
        );
      }
    });

    test('1.4 IPv6 Loopback, ULA (RFC 4193), Link-Local and IPv4-Mapped IPv6', async () => {
      // IPv6 Unit Validator Tests
      const ipv6Cases: [string, boolean, string?][] = [
        ['::1', true, 'Loopback / Unspecified IPv6'],
        ['::', true, 'Loopback / Unspecified IPv6'],
        ['fc00::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fd00::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fd12:3456:789a:1::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fe80::1', true, 'IPv6 Link-Local Unicast'],
        ['fe90::1', true, 'IPv6 Link-Local Unicast'],
        ['febf::1', true, 'IPv6 Link-Local Unicast'],
        ['::ffff:127.0.0.1', true, 'Loopback'],
        ['::ffff:169.254.169.254', true, 'Link-local / Cloud IMDS'],
        ['::ffff:10.0.0.1', true, 'RFC 1918 Private'],
        ['2606:4700:4700::1111', false], // Public Cloudflare IPv6
      ];

      for (const [ip, shouldBlock, expectedRange] of ipv6Cases) {
        const check = SsrfGuard.isBlockedIpv6(ip);
        assert.strictEqual(check.blocked, shouldBlock, `isBlockedIpv6 mismatch for ${ip}`);
        if (shouldBlock && expectedRange) {
          assert.strictEqual(check.rangeName, expectedRange);
        }
      }

      // IPv6 in URLs: Bracketed notation MUST be rejected safely
      const ipv6Urls = [
        'http://[::1]/',
        'http://[::1]:8080/secret',
        'http://[0:0:0:0:0:0:0:1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[fc00::1]/internal',
        'http://[fe80::1]/metadata',
      ];

      for (const url of ipv6Urls) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `IPv6 URL bypassed guard: ${url}`);
      }
    });

    test('1.5 Cloud IMDS and Internal Hostnames', async () => {
      const blockedHostnames = [
        'http://localhost',
        'http://localhost:8080',
        'http://metadata.google.internal',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://instance-data/latest/',
        'http://metadata/latest/',
        'http://database.internal',
        'http://k8s-service.local',
      ];

      for (const url of blockedHostnames) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Target hostname was not blocked: ${url}`);
        assert.ok(result.reason?.includes('blocked') || result.reason?.includes('Loopback'));
      }
    });

    test('1.6 DNS Magic Hostnames and Rebinding (.nip.io)', async () => {
      const nipUrls = [
        'http://127.0.0.1.nip.io',
        'http://169.254.169.254.nip.io/latest/meta-data',
        'http://10.0.0.1.nip.io',
        'http://192.168.1.1.nip.io',
        'http://172.16.0.1.nip.io',
      ];

      for (const url of nipUrls) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Magic nip.io hostname bypassed SSRF Guard: ${url}`);
        assert.ok(result.reason?.includes('falls into blocked range'));
      }
    });

    test('1.7 Non-HTTP and Dangerous Schemes', async () => {
      const dangerousSchemes = [
        'file:///etc/passwd',
        'file:///C:/Windows/win.ini',
        'ftp://evil-server.com/payload',
        'gopher://127.0.0.1:25/xHELO',
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'dict://127.0.0.1:2628/show',
        'ldap://127.0.0.1/dc=corp',
        'ws://127.0.0.1:8080/events',
        'wss://127.0.0.1:8443/stream',
      ];

      for (const url of dangerousSchemes) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Dangerous scheme permitted: ${url}`);
        assert.ok(result.reason?.includes('Disallowed URL protocol'));
      }
    });

    test('1.8 HTTP Redirect Bypasses (301, 302, 307, 308) to Internal Targets', async () => {
      // Mock global fetch to simulate external redirect responses
      const originalFetch = globalThis.fetch;

      try {
        // Attack A: 301 Redirect to loopback 127.0.0.1
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/start') {
            return new Response('', {
              status: 301,
              headers: { Location: 'http://127.0.0.1:8080/secret-key' },
            });
          }
          return new Response('internal secret content', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/start',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Loopback');
          },
          'Failed to block 301 redirect to 127.0.0.1'
        );

        // Attack B: 302 Redirect to Cloud IMDS 169.254.169.254
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/oauth') {
            return new Response('', {
              status: 302,
              headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
            });
          }
          return new Response('imds credentials', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/oauth',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Link-local / Cloud IMDS');
          },
          'Failed to block 302 redirect to Cloud IMDS'
        );

        // Attack C: 307 Redirect to DNS Rebinding hostname (127.0.0.1.nip.io)
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/hook') {
            return new Response('', {
              status: 307,
              headers: { Location: 'http://127.0.0.1.nip.io/admin' },
            });
          }
          return new Response('admin panel', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/hook',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Loopback');
          },
          'Failed to block 307 redirect to 127.0.0.1.nip.io'
        );

        // Attack D: Infinite Redirect Loop (> 3 hops)
        let redirectHop = 0;
        globalThis.fetch = async () => {
          redirectHop++;
          return new Response('', {
            status: 302,
            headers: { Location: `https://public-api.external.com/hop-${redirectHop}` },
          });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/hop-0',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'MAX_REDIRECTS_EXCEEDED';
          },
          'Failed to block redirect chain exceeding MAX_REDIRECTS (3)'
        );

        // Attack E: Malformed redirect missing Location header
        globalThis.fetch = async () => {
          return new Response('', { status: 302 }); // No Location header
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/empty-redirect',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'MALFORMED_REDIRECT';
          },
          'Failed to reject 302 without Location header'
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

});
