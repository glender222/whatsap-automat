import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import {
  isBlockedIp,
  matchesCidrV4,
  matchesCidrV6,
  ipv4ToInt,
  ipv6ToBigInt,
  SsrfEgressGuard,
  SsrfBlockedError,
  SsrfRedirectError,
} from '../services/ai/broker/SsrfEgressGuard';
import { SafeHttpClient } from '../services/ai/broker/SafeHttpClient';

describe('M2 Adversarial Stress Challenge: SSRF Egress Firewall & SafeHttpClient (PR-F5-02)', () => {
  // =========================================================================
  // SUITE 1: IPv6 Evasion & Parser Stress Testing
  // =========================================================================
  describe('Suite 1: IPv6 Evasion & Canonical Normalization', () => {
    it('blocks all permutations of IPv6 loopback (::1, expanded, omitted zeros)', () => {
      const loopbacks = [
        '::1',
        '0:0:0:0:0:0:0:1',
        '::0001',
        '0000:0000:0000:0000:0000:0000:0000:0001',
        '0:0:0:0:0:0:0:0001',
      ];
      for (const ip of loopbacks) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, true, `IPv6 loopback permutation ${ip} was not blocked`);
        assert.equal(res.rangeName, 'Loopback IPv6 Address');
      }
    });

    it('blocks all permutations of IPv6 unspecified (::)', () => {
      const unspecified = [
        '::',
        '0:0:0:0:0:0:0:0',
        '::0',
        '0000:0000:0000:0000:0000:0000:0000:0000',
      ];
      for (const ip of unspecified) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, true, `IPv6 unspecified permutation ${ip} was not blocked`);
        assert.equal(res.rangeName, 'Unspecified IPv6 Address');
      }
    });

    it('blocks IPv4-mapped IPv6 pointing to private, loopback, and IMDS ranges', () => {
      const mappedTargets = [
        { ip: '::ffff:127.0.0.1', expected: 'IPv4-Mapped: Loopback' },
        { ip: '::ffff:7f00:1', expected: 'IPv4-Mapped: Loopback' },
        { ip: '::ffff:7f00:0001', expected: 'IPv4-Mapped: Loopback' },
        { ip: '::ffff:169.254.169.254', expected: 'IPv4-Mapped: Link-Local / Cloud IMDS' },
        { ip: '::ffff:a9fe:a9fe', expected: 'IPv4-Mapped: Link-Local / Cloud IMDS' },
        { ip: '::ffff:100.100.100.200', expected: 'IPv4-Mapped: Carrier-Grade NAT (CGNAT)' },
        { ip: '::ffff:10.0.0.1', expected: 'IPv4-Mapped: RFC 1918 Private Class A' },
        { ip: '::ffff:172.16.0.1', expected: 'IPv4-Mapped: RFC 1918 Private Class B' },
        { ip: '::ffff:192.168.1.1', expected: 'IPv4-Mapped: RFC 1918 Private Class C' },
        { ip: '::ffff:0.0.0.0', expected: 'IPv4-Mapped: Current network' },
        { ip: '::ffff:255.255.255.255', expected: 'IPv4-Mapped: Reserved Class E' },
      ];

      for (const { ip, expected } of mappedTargets) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, true, `IPv4-mapped IP ${ip} should be blocked`);
        assert.equal(res.rangeName, expected, `Range mismatch for mapped IP ${ip}`);
      }
    });

    it('allows IPv4-mapped IPv6 pointing to public routable addresses', () => {
      const publicMapped = ['::ffff:93.184.216.34', '::ffff:8.8.8.8', '::ffff:1.1.1.1'];
      for (const ip of publicMapped) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, false, `Public IPv4-mapped IP ${ip} should be permitted`);
      }
    });

    it('blocks Unique Local Address (ULA) RFC 4193 (fc00::/7)', () => {
      const ulaIps = [
        'fc00::',
        'fc00::1',
        'fd00::1',
        'fd12:3456:789a:bcde::1',
        'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      ];
      for (const ip of ulaIps) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, true, `ULA IP ${ip} was not blocked`);
        assert.equal(res.rangeName, 'Unique Local Address (ULA)');
      }
    });

    it('blocks Link-Local Unicast (fe80::/10) with and without zone identifiers', () => {
      const linkLocal = [
        'fe80::',
        'fe80::1',
        'fe80::1%eth0',
        'fe80::1%1',
        'fe90::1',
        'fea0::1',
        'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      ];
      for (const ip of linkLocal) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, true, `Link-Local IP ${ip} was not blocked`);
        assert.equal(res.rangeName, 'Link-Local Unicast');
      }
    });

    it('blocks site-local unicast (fec0::/10), documentation (2001:db8::/32), and discard (100::/64)', () => {
      assert.equal(isBlockedIp('fec0::1').blocked, true);
      assert.equal(isBlockedIp('2001:db8::1').blocked, true);
      assert.equal(isBlockedIp('100::1').blocked, true);
      assert.equal(isBlockedIp('64:ff9b::192.0.2.1').blocked, true);
    });

    it('allows public routable global unicast IPv6', () => {
      const publicV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:828::200e'];
      for (const ip of publicV6) {
        const res = isBlockedIp(ip);
        assert.equal(res.blocked, false, `Public IPv6 ${ip} was erroneously blocked`);
      }
    });
  });

  // =========================================================================
  // SUITE 2: IPv4 Boundary CIDR Mathematical Stress Testing
  // =========================================================================
  describe('Suite 2: IPv4 Boundary CIDR Mathematical Verification', () => {
    it('blocks Link-Local / Cloud IMDS (169.254.0.0/16) and verifies boundary arithmetic', () => {
      // Internal Link-Local & Cloud IMDS
      assert.equal(isBlockedIp('169.254.169.254').blocked, true);
      assert.equal(isBlockedIp('169.254.0.0').blocked, true);
      assert.equal(isBlockedIp('169.254.255.255').blocked, true);

      // Adjacent public IPv4 outside /16
      assert.equal(isBlockedIp('169.253.255.255').blocked, false);
      assert.equal(isBlockedIp('169.255.0.0').blocked, false);
    });

    it('blocks Carrier-Grade NAT (100.64.0.0/10) including Alibaba Cloud IMDS (100.100.100.200)', () => {
      // Alibaba Cloud IMDS
      const alibabaRes = isBlockedIp('100.100.100.200');
      assert.equal(alibabaRes.blocked, true);
      assert.equal(alibabaRes.rangeName, 'Carrier-Grade NAT (CGNAT)');

      // Exact boundaries of /10 (100.64.0.0 - 100.127.255.255)
      assert.equal(isBlockedIp('100.64.0.0').blocked, true);
      assert.equal(isBlockedIp('100.127.255.255').blocked, true);

      // Adjacent public IPv4
      assert.equal(isBlockedIp('100.63.255.255').blocked, false);
      assert.equal(isBlockedIp('100.128.0.0').blocked, false);
    });

    it('blocks RFC 1918 Class A (10.0.0.0/8) and verifies boundaries', () => {
      assert.equal(isBlockedIp('10.0.0.1').blocked, true);
      assert.equal(isBlockedIp('10.0.0.0').blocked, true);
      assert.equal(isBlockedIp('10.255.255.255').blocked, true);

      // Adjacent public IPv4
      assert.equal(isBlockedIp('9.255.255.255').blocked, false);
      assert.equal(isBlockedIp('11.0.0.0').blocked, false);
    });

    it('blocks RFC 1918 Class B (172.16.0.0/12) and verifies boundaries', () => {
      assert.equal(isBlockedIp('172.16.0.1').blocked, true);
      assert.equal(isBlockedIp('172.16.0.0').blocked, true);
      assert.equal(isBlockedIp('172.31.255.255').blocked, true);

      // Adjacent public IPv4
      assert.equal(isBlockedIp('172.15.255.255').blocked, false);
      assert.equal(isBlockedIp('172.32.0.0').blocked, false);
    });

    it('blocks RFC 1918 Class C (192.168.0.0/16) and verifies boundaries', () => {
      assert.equal(isBlockedIp('192.168.1.1').blocked, true);
      assert.equal(isBlockedIp('192.168.0.0').blocked, true);
      assert.equal(isBlockedIp('192.168.255.255').blocked, true);

      // Adjacent public IPv4
      assert.equal(isBlockedIp('192.167.255.255').blocked, false);
      assert.equal(isBlockedIp('192.169.0.0').blocked, false);
    });

    it('blocks Loopback (127.0.0.0/8) and verifies boundaries', () => {
      assert.equal(isBlockedIp('127.0.0.1').blocked, true);
      assert.equal(isBlockedIp('127.0.0.0').blocked, true);
      assert.equal(isBlockedIp('127.255.255.255').blocked, true);

      // Adjacent public IPv4
      assert.equal(isBlockedIp('126.255.255.255').blocked, false);
      assert.equal(isBlockedIp('128.0.0.0').blocked, false);
    });

    it('blocks Current Network (0.0.0.0/8), Broadcast, Multicast, and Reserved ranges', () => {
      assert.equal(isBlockedIp('0.0.0.0').blocked, true);
      assert.equal(isBlockedIp('0.255.255.255').blocked, true);
      assert.equal(isBlockedIp('255.255.255.255').blocked, true);
      assert.equal(isBlockedIp('224.0.0.1').blocked, true); // Multicast
      assert.equal(isBlockedIp('240.0.0.1').blocked, true); // Reserved Class E
    });

    it('blocks obfuscated and non-standard IPv4 notations via URL parsing', async () => {
      const obfuscated = [
        { url: 'http://0177.0.0.1/', expectedIp: '127.0.0.1' }, // Octal
        { url: 'http://2130706433/', expectedIp: '127.0.0.1' }, // Decimal integer
        { url: 'http://0x7f000001/', expectedIp: '127.0.0.1' }, // Hex
        { url: 'http://127.1/', expectedIp: '127.0.0.1' },      // Short notation
        { url: 'http://0/', expectedIp: '0.0.0.0' },            // Zero
      ];

      for (const item of obfuscated) {
        const res = await SsrfEgressGuard.validateUrl(item.url);
        assert.equal(res.safe, false, `Obfuscated URL ${item.url} was not blocked`);
        assert.match(res.reason!, /falls into blocked range/i);
      }
    });
  });

  // =========================================================================
  // SUITE 3: Scheme Whitelist & Hostname Blacklist
  // =========================================================================
  describe('Suite 3: Scheme Whitelist & Blocked Hostnames', () => {
    it('blocks dangerous non-HTTP schemes (file, gopher, dict, ftp, ldap, data)', async () => {
      const disallowed = [
        'file:///etc/passwd',
        'file://localhost/etc/passwd',
        'gopher://127.0.0.1:70/_GET%20/admin',
        'dict://127.0.0.1:2628/show',
        'ftp://example.com/sensitive.txt',
        'sftp://host.com/data',
        'ldap://127.0.0.1:389/o=example',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'javascript:alert(document.cookie)',
      ];

      for (const url of disallowed) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Disallowed scheme URL was allowed: ${url}`);
        assert.match(res.reason!, /Disallowed URL protocol/i);
      }
    });

    it('blocks prohibited internal hostnames and suffix patterns', async () => {
      const internal = [
        'http://localhost/metrics',
        'http://foo.localhost/api',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://metadata/latest/meta-data/',
        'http://instance-data/latest/meta-data/',
        'http://kube-dns.internal/',
        'http://app.local/',
        'http://hidden.onion/',
        'http://in-addr.arpa/',
      ];

      for (const url of internal) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Internal hostname bypassed guard: ${url}`);
        assert.match(res.reason!, /is blocked/i);
      }
    });

    it('assertUrlIsSafe throws SsrfBlockedError (HTTP 403) on violation', async () => {
      await assert.rejects(
        () => SsrfEgressGuard.assertUrlIsSafe('http://169.254.169.254/latest/meta-data/'),
        (err: any) => {
          assert.equal(err instanceof SsrfBlockedError, true);
          assert.equal(err.name, 'SsrfBlockedError');
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, 'SSRF_BLOCKED');
          assert.ok(err.details?.targetUrl);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // SUITE 4: DNS Rebinding Simulation & Socket Pinning Verification
  // =========================================================================
  describe('Suite 4: DNS Rebinding Prevention & Socket Pinning', () => {
    it('verifies SafeHttpClient pins socket connection to pre-resolved IP, preventing secondary lookup rebinding', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      let capturedRequestOptions: http.RequestOptions | null = null;
      let lookupCount = 0;

      try {
        // Step 1: Mock DNS lookup to simulate domain resolution
        (dns as any).lookup = async (hostname: string, options?: any) => {
          if (hostname === 'simulated-rebind.example.org') {
            lookupCount++;
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return originalLookup(hostname, options);
        };

        // Step 2: Spy on http.request to verify socket pinning options
        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          capturedRequestOptions = options;

          // Return mock request that emits response immediately
          const mockReq: any = {
            on: (_event: string, _handler: any) => mockReq,
            setTimeout: (_ms: number, _handler: any) => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 200,
                  statusMessage: 'OK',
                  headers: { 'content-type': 'application/json' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'data') fn(Buffer.from('{"status":"ok"}'));
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        const result = await SafeHttpClient.request('http://simulated-rebind.example.org/api/data');

        assert.equal(result.status, 200);
        assert.equal(result.resolvedIp, '93.184.216.34');
        assert.ok(capturedRequestOptions, 'http.request was not invoked');

        // Critical Empirical Assertion:
        // SafeHttpClient MUST connect to host: pinnedIp ('93.184.216.34') directly at the socket level.
        // It must NOT pass host: 'simulated-rebind.example.org', which would trigger secondary DNS lookup.
        assert.equal(
          (capturedRequestOptions as any).host,
          '93.184.216.34',
          'Socket connection host was NOT pinned to pre-resolved IP'
        );

        // Virtual host must be preserved in headers and SNI
        assert.equal(
          (capturedRequestOptions as any).headers['Host'],
          'simulated-rebind.example.org',
          'Host header was not preserved'
        );
        assert.equal(
          (capturedRequestOptions as any).servername,
          'simulated-rebind.example.org',
          'TLS servername was not set'
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('rejects multi-homed domain if ANY resolved IP address is in a prohibited range (fail-closed)', async () => {
      const originalLookup = dns.lookup;
      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'dual-homed-attack.com') {
            return [
              { address: '93.184.216.34', family: 4 }, // Safe public IP
              { address: '169.254.169.254', family: 4 }, // Cloud IMDS (Prohibited!)
            ];
          }
          return originalLookup(hostname, { all: true });
        };

        const result = await SsrfEgressGuard.validateUrl('http://dual-homed-attack.com/');
        assert.equal(result.safe, false, 'Multi-homed domain with prohibited IP was erroneously accepted');
        assert.match(result.reason!, /falls into blocked range: Link-Local \/ Cloud IMDS/);
      } finally {
        (dns as any).lookup = originalLookup;
      }
    });
  });

  // =========================================================================
  // SUITE 5: Safe Redirect State Machine & Header Security
  // =========================================================================
  describe('Suite 5: Safe Redirect State Machine & Sensitive Header Stripping', () => {
    let mockServer: http.Server;
    let mockPort: number;

    it('sets up redirect test mock server', async () => {
      mockServer = http.createServer();
      await new Promise<void>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as any;
          mockPort = addr.port;
          resolve();
        });
      });
    });

    it('blocks HTTP 302 redirect targeting loopback (127.0.0.1)', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'trusted-initial.org') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location: `http://127.0.0.1:${mockPort}/secret` },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://trusted-initial.org/start'),
          (err: any) => {
            assert.equal(err.name, 'SsrfBlockedError');
            assert.equal(err.statusCode, 403);
            assert.match(err.message, /Loopback/);
            return true;
          }
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('blocks HTTP 302 redirect targeting Cloud IMDS (169.254.169.254)', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'trusted-initial.org') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://trusted-initial.org/start'),
          (err: any) => {
            assert.equal(err.name, 'SsrfBlockedError');
            assert.equal(err.statusCode, 403);
            assert.match(err.message, /Link-Local \/ Cloud IMDS/);
            return true;
          }
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('blocks HTTP 302 redirect targeting non-HTTP scheme (file:///etc/passwd)', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'trusted-initial.org') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location: 'file:///etc/passwd' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://trusted-initial.org/start'),
          (err: any) => {
            assert.equal(err.name, 'SsrfBlockedError');
            assert.match(err.message, /Disallowed URL protocol/);
            return true;
          }
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('rejects infinite redirect loop exceeding maximum permitted hops (5 hops)', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;
      let hopCounter = 0;

      try {
        (dns as any).lookup = async (hostname: string) => {
          return [{ address: '93.184.216.34', family: 4 }];
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          hopCounter++;
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location: `http://trusted-initial.org/loop-${hopCounter}` },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://trusted-initial.org/start', { maxRedirects: 5 }),
          (err: any) => {
            assert.equal(err.name, 'SsrfRedirectError');
            assert.equal(err.code, 'MAX_REDIRECTS_EXCEEDED');
            assert.equal(err.statusCode, 403);
            return true;
          }
        );
        assert.equal(hopCounter, 6); // 1 initial + 5 redirects -> 6th attempt triggers error
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('strips Authorization header on cross-origin redirects while preserving it on same-origin redirects', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;
      const capturedHeaders: Record<string, string>[] = [];

      try {
        (dns as any).lookup = async () => [{ address: '93.184.216.34', family: 4 }];

        // Phase 1: Cross-origin redirect test (origin-a.org -> origin-b.org)
        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          capturedHeaders.push({ ...(options.headers as any) });
          const isInitial = capturedHeaders.length === 1;

          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: isInitial ? 302 : 200,
                  statusMessage: isInitial ? 'Found' : 'OK',
                  headers: isInitial ? { location: 'http://origin-b.org/target' } : {},
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await SafeHttpClient.request('http://origin-a.org/start', {
          headers: {
            Authorization: 'Bearer secret-capital-token',
            authorization: 'Bearer secret-lower-token',
            'x-custom-trace': 'trace-123',
          },
        });

        assert.equal(capturedHeaders.length, 2);
        // Initial request had Authorization
        assert.ok(capturedHeaders[0]['Authorization'] || capturedHeaders[0]['authorization']);
        // Redirect request to origin-b.org MUST have stripped both forms of Authorization
        assert.equal(capturedHeaders[1]['Authorization'], undefined);
        assert.equal(capturedHeaders[1]['authorization'], undefined);
        // Non-sensitive custom header is preserved
        assert.equal(capturedHeaders[1]['x-custom-trace'], 'trace-123');

        // Phase 2: Same-origin redirect test (origin-a.org/step1 -> origin-a.org/step2)
        capturedHeaders.length = 0;
        let sameOriginCount = 0;
        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          capturedHeaders.push({ ...(options.headers as any) });
          sameOriginCount++;

          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: sameOriginCount === 1 ? 302 : 200,
                  statusMessage: sameOriginCount === 1 ? 'Found' : 'OK',
                  headers: sameOriginCount === 1 ? { location: 'http://origin-a.org/step2' } : {},
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await SafeHttpClient.request('http://origin-a.org/step1', {
          headers: {
            Authorization: 'Bearer preserve-this-token',
          },
        });

        assert.equal(capturedHeaders.length, 2);
        // Same-origin redirect MUST preserve Authorization header
        assert.equal(capturedHeaders[1]['Authorization'], 'Bearer preserve-this-token');
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('adversarial caveat check: verifies header casing behavior for Cookie and X-Api-Key on cross-origin redirects', async () => {
        const originalLookup = dns.lookup;
        const originalHttpRequest = http.request;
        const capturedHeaders: Record<string, string>[] = [];

        try {
          (dns as any).lookup = async () => [{ address: '93.184.216.34', family: 4 }];

          (http as any).request = (options: http.RequestOptions, callback?: any) => {
            capturedHeaders.push({ ...(options.headers as any) });
            const isInitial = capturedHeaders.length === 1;

            const mockReq: any = {
              on: () => mockReq,
              setTimeout: () => mockReq,
              write: () => {},
              end: () => {
                if (callback) {
                  const mockRes: any = {
                    statusCode: isInitial ? 302 : 200,
                    statusMessage: isInitial ? 'Found' : 'OK',
                    headers: isInitial ? { location: 'http://origin-cross.org/data' } : {},
                    on: (evt: string, fn: any) => {
                      if (evt === 'end') fn();
                      return mockRes;
                    },
                  };
                  callback(mockRes);
                }
              },
            };
            return mockReq;
          };

          // Supplying lowercase cookie and lowercase x-api-key
          await SafeHttpClient.request('http://origin-source.org/init', {
            headers: {
              cookie: 'sess=lower-case-token',
              'x-api-key': 'key-lower',
            },
          });

          assert.equal(capturedHeaders.length, 2);
          // Lowercase cookie and x-api-key are properly deleted by delete currentHeaders['cookie']
          assert.equal(capturedHeaders[1]['cookie'], undefined);
          assert.equal(capturedHeaders[1]['x-api-key'], undefined);
        } finally {
          (dns as any).lookup = originalLookup;
          (http as any).request = originalHttpRequest;
        }
      });

    it('empirical finding: demonstrates that non-normalized header casing (Cookie, X-Api-Key) survives cross-origin redirects', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;
      const capturedHeaders: Record<string, string>[] = [];

      try {
        (dns as any).lookup = async () => [{ address: '93.184.216.34', family: 4 }];

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          capturedHeaders.push({ ...(options.headers as any) });
          const isInitial = capturedHeaders.length === 1;

          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: isInitial ? 302 : 200,
                  statusMessage: isInitial ? 'Found' : 'OK',
                  headers: isInitial ? { location: 'http://origin-cross.org/data' } : {},
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        // Supplying PascalCase Cookie and KebabCase X-Api-Key
        await SafeHttpClient.request('http://origin-source.org/init', {
          headers: {
            Cookie: 'sess=capitalized-cookie',
            'X-Api-Key': 'key-capitalized',
          },
        });

        assert.equal(capturedHeaders.length, 2);
        // Note: SafeHttpClient only deletes currentHeaders['cookie'] and currentHeaders['x-api-key']
        // Consequently, 'Cookie' and 'X-Api-Key' remain on cross-origin redirect
        assert.equal(capturedHeaders[1]['Cookie'], 'sess=capitalized-cookie');
        assert.equal(capturedHeaders[1]['X-Api-Key'], 'key-capitalized');
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('cleans up mock server', async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });
  });
});
