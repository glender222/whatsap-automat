import assert from 'node:assert/strict';
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
