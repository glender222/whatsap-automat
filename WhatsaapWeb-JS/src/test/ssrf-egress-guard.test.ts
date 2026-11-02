import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import {
  isBlockedIp,
  ipv4ToInt,
  ipv6ToBigInt,
  matchesCidrV4,
  matchesCidrV6,
  SsrfEgressGuard,
  SsrfBlockedError,
  SsrfRedirectError,
} from '../services/ai/broker/SsrfEgressGuard';
import { SafeHttpClient } from '../services/ai/broker/SafeHttpClient';

describe('PR-F5-02: Bitwise SSRF Egress Firewall & DNS Rebinding Security Tests', () => {
  describe('Vector 1: IPv4 Bitwise CIDR Boundary Arithmetic', () => {
    it('correctly handles RFC 1918 Class A (10.0.0.0/8) boundaries', () => {
      assert.equal(isBlockedIp('9.255.255.255').blocked, false);
      assert.equal(isBlockedIp('10.0.0.0').blocked, true);
      assert.equal(isBlockedIp('10.255.255.255').blocked, true);
      assert.equal(isBlockedIp('11.0.0.0').blocked, false);
    });

    it('correctly handles RFC 1918 Class B (172.16.0.0/12) boundaries', () => {
      assert.equal(isBlockedIp('172.15.255.255').blocked, false);
      assert.equal(isBlockedIp('172.16.0.0').blocked, true);
      assert.equal(isBlockedIp('172.31.255.255').blocked, true);
      assert.equal(isBlockedIp('172.32.0.0').blocked, false);
    });

    it('correctly handles RFC 1918 Class C (192.168.0.0/16) boundaries', () => {
      assert.equal(isBlockedIp('192.167.255.255').blocked, false);
      assert.equal(isBlockedIp('192.168.0.0').blocked, true);
      assert.equal(isBlockedIp('192.168.255.255').blocked, true);
      assert.equal(isBlockedIp('192.169.0.0').blocked, false);
    });

    it('blocks Cloud IMDS and Auto-IP (169.254.0.0/16)', () => {
      assert.equal(isBlockedIp('169.254.169.254').blocked, true);
      assert.equal(isBlockedIp('169.254.0.1').blocked, true);
      assert.equal(isBlockedIp('169.253.255.255').blocked, false);
      assert.equal(isBlockedIp('169.255.0.0').blocked, false);
    });

    it('blocks CGNAT (100.64.0.0/10) including Alibaba Cloud IMDS (100.100.100.200)', () => {
      assert.equal(isBlockedIp('100.64.0.0').blocked, true);
      assert.equal(isBlockedIp('100.100.100.200').blocked, true);
      assert.equal(isBlockedIp('100.127.255.255').blocked, true);
      assert.equal(isBlockedIp('100.128.0.0').blocked, false);
    });

    it('blocks loopback (127.0.0.0/8), current network (0.0.0.0/8), and broadcast', () => {
      assert.equal(isBlockedIp('127.0.0.1').blocked, true);
      assert.equal(isBlockedIp('127.255.255.254').blocked, true);
      assert.equal(isBlockedIp('0.0.0.0').blocked, true);
      assert.equal(isBlockedIp('255.255.255.255').blocked, true);
    });

    it('allows routable public IPv4 addresses', () => {
      assert.equal(isBlockedIp('93.184.216.34').blocked, false); // example.com
      assert.equal(isBlockedIp('8.8.8.8').blocked, false);       // Google DNS
      assert.equal(isBlockedIp('1.1.1.1').blocked, false);       // Cloudflare DNS
    });
  });

  describe('Vector 2: IPv6 Mathematical 128-Bit CIDR & Parser Edge Cases', () => {
    it('blocks all permutations of IPv6 loopback (::1)', () => {
      assert.equal(isBlockedIp('::1').blocked, true);
      assert.equal(isBlockedIp('0:0:0:0:0:0:0:1').blocked, true);
      assert.equal(isBlockedIp('::0001').blocked, true);
      assert.equal(isBlockedIp('0000:0000:0000:0000:0000:0000:0000:0001').blocked, true);
    });

    it('blocks all permutations of unspecified IPv6 (::)', () => {
      assert.equal(isBlockedIp('::').blocked, true);
      assert.equal(isBlockedIp('0:0:0:0:0:0:0:0').blocked, true);
      assert.equal(isBlockedIp('::0').blocked, true);
    });

    it('blocks IPv4-mapped IPv6 addresses matching private/loopback/IMDS subnets', () => {
      assert.equal(isBlockedIp('::ffff:127.0.0.1').blocked, true);
      assert.equal(isBlockedIp('::ffff:7f00:1').blocked, true);
      assert.equal(isBlockedIp('::ffff:169.254.169.254').blocked, true);
      assert.equal(isBlockedIp('::ffff:10.0.0.1').blocked, true);
      assert.equal(isBlockedIp('::ffff:192.168.1.100').blocked, true);
    });

    it('allows IPv4-mapped IPv6 pointing to public routable IPv4', () => {
      assert.equal(isBlockedIp('::ffff:93.184.216.34').blocked, false);
      assert.equal(isBlockedIp('::ffff:8.8.8.8').blocked, false);
    });

    it('blocks Unique Local Address (ULA) RFC 4193 (fc00::/7)', () => {
      assert.equal(isBlockedIp('fc00::1').blocked, true);
      assert.equal(isBlockedIp('fd00::1').blocked, true);
      assert.equal(isBlockedIp('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff').blocked, true);
    });

    it('blocks Link-Local Unicast (fe80::/10)', () => {
      assert.equal(isBlockedIp('fe80::1').blocked, true);
      assert.equal(isBlockedIp('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff').blocked, true);
    });

    it('blocks documentation (2001:db8::/32) and discard (100::/64) prefixes', () => {
      assert.equal(isBlockedIp('2001:db8::1').blocked, true);
      assert.equal(isBlockedIp('100::1').blocked, true);
    });

    it('allows public routable IPv6 addresses', () => {
      assert.equal(isBlockedIp('2606:4700:4700::1111').blocked, false); // Cloudflare IPv6
      assert.equal(isBlockedIp('2001:4860:4860::8888').blocked, false); // Google IPv6
    });
  });

  describe('Vector 3: URL Protocol Whitelist & Hostnames', () => {
    it('rejects disallowed protocols (file, gopher, ftp, ldap)', async () => {
      const protocols = [
        'file:///etc/passwd',
        'gopher://127.0.0.1:70/',
        'ftp://example.com/file',
        'ldap://127.0.0.1:389/dc=example',
      ];

      for (const url of protocols) {
        const result = await SsrfEgressGuard.validateUrl(url);
        assert.equal(result.safe, false);
        assert.match(result.reason!, /Disallowed URL protocol/);
      }
    });

    it('blocks localhost and cloud metadata internal hostnames', async () => {
      const hostnames = [
        'http://localhost/api',
        'http://localhost:8080/admin',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://metadata/latest/meta-data/',
        'http://instance-data/latest/meta-data/',
        'http://service.internal/status',
        'http://my-host.local/info',
      ];

      for (const url of hostnames) {
        const result = await SsrfEgressGuard.validateUrl(url);
        assert.equal(result.safe, false);
        assert.match(result.reason!, /is blocked/i);
      }
    });

    it('assertUrlIsSafe throws SsrfBlockedError with HTTP 403 status code', async () => {
      await assert.rejects(
        () => SsrfEgressGuard.assertUrlIsSafe('http://169.254.169.254/latest/meta-data/'),
        (err: any) => {
          assert.equal(err.name, 'SsrfBlockedError');
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, 'SSRF_BLOCKED');
          return true;
        }
      );
    });
  });

  describe('Vector 4: SafeHttpClient Redirect & Credential Security', () => {
    let server: http.Server;
    let serverPort: number;

    it('sets up a mock HTTP server to test redirect state machine', async () => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);

        if (url.pathname === '/redirect-1') {
          res.writeHead(302, { Location: '/final' });
          res.end('Redirecting to final');
          return;
        }

        if (url.pathname === '/redirect-loop') {
          res.writeHead(302, { Location: '/redirect-loop' });
          res.end('Infinite loop');
          return;
        }

        if (url.pathname === '/final') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Success', authHeader: req.headers['authorization'] || null }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as any;
          serverPort = addr.port;
          resolve();
        });
      });
    });

    it('blocks requests attempting to connect to private mock server via SafeHttpClient', async () => {
      // 127.0.0.1 is blocked by SsrfEgressGuard
      await assert.rejects(
        () => SafeHttpClient.request(`http://127.0.0.1:${serverPort}/final`),
        (err: any) => {
          assert.equal(err.name, 'SsrfBlockedError');
          assert.equal(err.statusCode, 403);
          return true;
        }
      );
    });

    it('cleans up mock HTTP server', async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
