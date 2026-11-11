import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import express from 'express';
import http from 'http';
import { createOpenApiRoutes } from '../routes/openapiRoutes';

describe('PR-F7-01: OpenAPI v1 Routes & Specification Endpoint', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use('/api/v1', createOpenApiRoutes());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { address: string; port: number };
        baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('serves openapi.json with status 200, application/json header, and valid JSON spec', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
    assert.ok(res.headers.get('cache-control')?.includes('public'));
    assert.ok(res.headers.get('etag') !== null);

    const body = await res.json();
    assert.ok(body.openapi.startsWith('3.1'));
    assert.ok(body.paths);
    assert.ok(body.paths['/conversations']);
    assert.ok(body.paths['/channel-connections']);
    const approval = body.components.schemas.ApprovalRequest;
    assert.deepEqual(approval.properties.executionBlocker.enum, ['APPROVAL_EFFECT_CONFLICT']);
    assert.equal(approval.required.includes('executionBlocker'), false);
  });

  it('serves openapi.yaml with status 200 and application/yaml header', async () => {
    const res = await fetch(`${baseUrl}/openapi.yaml`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('yaml'));
    assert.ok(res.headers.get('cache-control')?.includes('public'));

    const text = await res.text();
    assert.ok(text.includes('openapi:'));
    assert.ok(text.includes('/conversations:'));
    assert.ok(text.includes('executionBlocker:'));
    assert.ok(text.includes('enum: [APPROVAL_EFFECT_CONFLICT]'));
  });

  it('supports conditional GET with If-None-Match returning 304 Not Modified', async () => {
    const firstRes = await fetch(`${baseUrl}/openapi.json`);
    const etag = firstRes.headers.get('etag');
    assert.ok(etag, 'ETag must be present');

    const secondRes = await fetch(`${baseUrl}/openapi.json`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(secondRes.status, 304);
  });

  it('handles content negotiation on /openapi redirecting to json by default', async () => {
    const res = await fetch(`${baseUrl}/openapi`, { redirect: 'manual' });
    assert.ok([307, 302, 308].includes(res.status));
    assert.ok(res.headers.get('location')?.endsWith('/openapi.json'));
  });

  it('handles content negotiation on /openapi redirecting to yaml when requested', async () => {
    const res = await fetch(`${baseUrl}/openapi`, {
      headers: { accept: 'application/yaml' },
      redirect: 'manual',
    });
    assert.ok([307, 302, 308].includes(res.status));
    assert.ok(res.headers.get('location')?.endsWith('/openapi.yaml'));
  });

  it('serves /docs with status 200 and html content type', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('Whatsap-Automat API v1 Reference'));
  });
});
