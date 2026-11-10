import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { AutomatClient } from '../src/client';
import { HttpClient } from '../src/http';
import { RateLimitedError, ProblemDetailsError } from '../src/errors';

describe('@whatsap-automat/sdk: AutomatClient & HttpClient', () => {
  it('instantiates AutomatClient with all resources', () => {
    const client = AutomatClient.create({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-api-key',
      tenantId: 'tenant-101',
    });

    assert.ok(client.http instanceof HttpClient);
    assert.ok(client.conversations);
    assert.ok(client.channels);
    assert.ok(client.agents);
    assert.ok(client.workflows);
    assert.ok(client.approvals);
  });

  it('injects Authorization and X-Tenant-Id headers properly', async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedUrl: string | undefined;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ id: 'conv_123', status: 'ACTIVE' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      token: 'jwt-auth-token-xyz',
      tenantId: 'tenant-999',
      fetchFn: mockFetch as any,
    });

    const conversation = await client.conversations.get('conv_123');
    assert.equal((conversation as any).id, 'conv_123');
    assert.equal(capturedUrl, 'https://api.example.com/api/v1/conversations/conv_123');
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer jwt-auth-token-xyz');
    assert.equal(headers['X-Tenant-Id'], 'tenant-999');
  });

  it('projects the simulation envelope to the existing node list', async () => {
    const nodes = [{ nodeId: 'finish', kind: 'end', output: {}, durationMs: 1 }];
    const request = { graphId: 'demo', graphVersion: 2, mockInput: 'fixture' };
    for (const payload of [{ executedNodes: nodes, mode: 'fixture' }, nodes]) {
      const client = AutomatClient.create({
        baseUrl: 'https://api.example.com',
        fetchFn: async (url, init) => {
          assert.equal(url.toString(), 'https://api.example.com/api/v1/agent-runs/simulate');
          assert.deepEqual(JSON.parse(init?.body as string), request);
          return Response.json(payload);
        },
      });
      assert.deepEqual(await client.agents.simulate(request), nodes);
    }
  });

  it('retries on 429 RateLimited and succeeds when downstream recovers', async () => {
    let attempts = 0;

    const mockFetch = async (): Promise<Response> => {
      attempts++;
      if (attempts < 2) {
        return new Response(JSON.stringify({ title: 'Rate Limited' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      maxRetries: 2,
      fetchFn: mockFetch as any,
    });

    const channels = await client.channels.list();
    assert.deepEqual(channels, []);
    assert.equal(attempts, 2);
  });

  it('throws RateLimitedError when max retries exceeded', async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ title: 'Rate Limited', detail: 'Quota exceeded' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    };

    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      maxRetries: 1,
      fetchFn: mockFetch as any,
    });

    await assert.rejects(
      async () => client.channels.list(),
      (err: any) => err instanceof RateLimitedError && err.status === 429
    );
  });

  it('does not replay an unkeyed mutation after HTTP or network failure', async () => {
    let attempts = 0;
    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      fetchFn: async () => {
        attempts++;
        if (attempts === 1) return new Response('Proxy unavailable', { status: 503 });
        throw new TypeError('Network closed before the response');
      },
    });
    await assert.rejects(client.conversations.takeover('conv_1', { expectedVersion: 1 }),
      (error) => error instanceof ProblemDetailsError && error.status === 503 &&
        error.detail === 'Proxy unavailable');
    assert.equal(attempts, 1);
    await assert.rejects(client.conversations.takeover('conv_1', { expectedVersion: 1 }),
      (error) => error instanceof ProblemDetailsError && error.status === 500);
    assert.equal(attempts, 2);
  });

  it('replays a keyed send with the same key and body after a retryable response', async () => {
    const attempts: Array<[string | null, RequestInit['body']]> = [];
    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      fetchFn: async (_url, request) => {
        attempts.push([new Headers(request?.headers).get('idempotency-key'), request?.body]);
        if (attempts.length === 1) return new Response(null, { status: 503, headers: { 'retry-after': '0' } });
        return Response.json({ accepted: true });
      },
    });
    assert.equal((await client.conversations.sendText('conv_1', 'hola', 1, 'effect-key')).accepted, true);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(attempts[0][0], 'effect-key');
  });

  it('handles takeover command invoking /conversations/{id}/takeover', async () => {
    let capturedBody: any;
    let capturedMethod: string | undefined;

    const mockFetch = async (_url: any, init?: RequestInit): Promise<Response> => {
      capturedMethod = init?.method;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: 'conv_1', assignment: { type: 'HUMAN', agentId: 'usr_1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new AutomatClient({
      baseUrl: 'https://api.example.com',
      fetchFn: mockFetch as any,
    });

    const result = await client.conversations.takeover('conv_1', {
      expectedVersion: 3,
      userId: 'usr_1',
      reason: 'Agent escalation',
    });

    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedBody.expectedVersion, 3);
    assert.equal(capturedBody.userId, 'usr_1');
    assert.equal((result as any).assignment.type, 'HUMAN');
  });
});


describe('@whatsap-automat/sdk: approval reauthentication', () => {
  const password = 'fixture-current-password';
  const decision = { decision: 'approved' as const, expectedVersion: 3, reason: 'Reviewed refund' };
  const capabilities = ['approvals.review', 'approvals.reauthenticate'];
  const key = 'fixture-approval-key';

  it('verifies workspace capabilities and submits the current password with the existing key', async () => {
    const requests: string[] = [];
    const client = AutomatClient.create({
      baseUrl: 'http://127.0.0.1:3000',
      fetchFn: async (url, request) => {
        const path = new URL(url.toString()).pathname;
        requests.push(path);
        assert.equal(request?.redirect, 'error');
        assert.equal(request?.cache, 'no-store');
        if (request?.method === 'GET') {
          assert.equal(request.body, undefined);
          return Response.json({ capabilities });
        }
        assert.equal(new Headers(request?.headers).get('Idempotency-Key'), key);
        assert.deepEqual(JSON.parse(request?.body as string), { ...decision, password });
        return Response.json({ approvalId: 'app_99', status: 'approved' });
      },
    });
    assert.equal((await client.approvals.decide('app_99', { ...decision, password }, key)).status, 'approved');
    assert.deepEqual(requests, ['/api/v1/workspaces/current', '/api/v1/approvals/app_99/decision']);
  });

  it('blocks credential delivery if either capability is missing or the endpoint is unsafe', async () => {
    for (const offered of [[], ['approvals.review'], ['approvals.reauthenticate']]) {
      const methods: Array<string | undefined> = [];
      const client = AutomatClient.create({
        baseUrl: 'https://api.example.com',
        fetchFn: async (_url, request) => {
          methods.push(request?.method);
          assert.equal(request?.body, undefined);
          return Response.json({ capabilities: offered });
        },
      });
      await assert.rejects(client.approvals.decide('app_99', { ...decision, password }, key),
        (err) => err instanceof ProblemDetailsError && err.status === 403);
      assert.deepEqual(methods, ['GET']);
    }

    for (const [baseUrl, id] of [['http://api.example.com', 'app_99'], ['https://api.example.com', '..']]) {
      let calls = 0;
      const client = AutomatClient.create({
        baseUrl,
        fetchFn: async () => { calls++; return Response.json({ capabilities }); },
      });
      await assert.rejects(client.approvals.decide(id, { ...decision, password }, key),
        (err) => err instanceof ProblemDetailsError && err.status === 422);
      assert.equal(calls, 0);
    }
  });

  it('makes one password-bearing POST and redacts sensitive failure details', async () => {
    const failures = [
      { status: 403, code: 'POLICY_DENIED', reason: 'APPROVAL_REAUTH_INVALID' },
      { status: 429, code: 'RATE_LIMITED', reason: 'APPROVAL_REAUTH_LIMITED' },
      { status: 503, code: 'RETRYABLE', reason: password },
      { status: 500, code: undefined, reason: undefined },
    ];
    for (const { status, code, reason } of failures) {
      let posts = 0;
      const client = AutomatClient.create({
        baseUrl: 'https://api.example.com',
        fetchFn: async (_url, request) => {
          if (request?.method === 'GET') return Response.json({ capabilities });
          posts++;
          assert.equal(request?.redirect, 'error');
          if (status === 500) throw new ProblemDetailsError({ detail: password });
          return Response.json({
            code, detail: password, title: password, correlationId: password,
            metadata: { reason, reflected: password },
          }, { status, headers: { 'retry-after': '0' } });
        },
      });
      await assert.rejects(client.approvals.decide('app_99', { ...decision, password }, key), (err) => {
        assert.ok(err instanceof ProblemDetailsError);
        assert.equal(err.status, status);
        assert.equal(err.code, code);
        assert.deepEqual(err.metadata, status === 403 || status === 429 ? { reason } : undefined);
        assert.ok(!err.message.includes(password));
        assert.ok(!JSON.stringify(err).includes(password));
        return true;
      });
      assert.equal(posts, 1);
    }
  });

  it('blocks a real loopback 307 redirect after the single approval POST', async (t) => {
    const paths: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      paths.push(req.url);
      req.resume();
      if (req.url === '/api/v1/workspaces/current') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ capabilities }));
        return;
      }
      res.writeHead(307, { location: '/redirected' }).end();
    });
    t.after(() => { server.close(); server.closeAllConnections(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = AutomatClient.create({ baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(client.approvals.decide('app_99', { ...decision, password }, key), ProblemDetailsError);
    assert.deepEqual(paths, ['/api/v1/workspaces/current', '/api/v1/approvals/app_99/decision']);
  });

  it('keeps existing keyed retries when the command omits a password', async () => {
    const requests: Array<[string | null, unknown]> = [];
    const client = AutomatClient.create({
      baseUrl: 'https://api.example.com',
      fetchFn: async (_url, request) => {
        assert.equal(request?.method, 'POST');
        assert.equal(request.redirect, undefined);
        requests.push([new Headers(request.headers).get('Idempotency-Key'), JSON.parse(request.body as string)]);
        if (requests.length === 1) return new Response(null, { status: 503, headers: { 'retry-after': '0' } });
        return Response.json({ status: 'approved' });
      },
    });
    assert.equal((await client.approvals.decide('app_99', decision, key)).status, 'approved');
    assert.deepEqual(requests, [[key, decision], [key, decision]]);
  });
});
