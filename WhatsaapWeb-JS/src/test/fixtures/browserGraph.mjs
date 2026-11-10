import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

const provider = new URL(process.env.PRODUCT_GRAPH_FIXTURE_URL);
const backend = new URL(process.env.PRODUCT_SMOKE_URL);
for (const address of [provider, backend]) {
  assert.equal(address.protocol, 'http:');
  assert.equal(address.hostname, '127.0.0.1');
  assert.match(address.port, /^\d+$/);
}
assert.equal(backend.port, process.env.PORT);
assert.equal(process.env.HOST, '127.0.0.1');
assert.equal(process.env.DB_HOST, '127.0.0.1');
assert.match(process.env.DB_NAME ?? '', /_smoke$/);
assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');
assert.equal(process.env.WHATSAPP_PROVIDER, 'meta-cloud');

const attempts = new Map();
const media = new Map();
const fixtureFile = Buffer.from('Archivo QA');
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, provider.origin);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { backend: backend.origin });
  if (req.method === 'GET' && url.pathname === '/attempts') {
    return json(res, 200, attempts.get(url.searchParams.get('line')) ?? []);
  }

  const match = /^\/v\d+\.\d+\/([0-9]+)\/(media|messages)$/.exec(url.pathname);
  if (req.headers.authorization !== 'Bearer synthetic-local-token') {
    return json(res, 401, { error: { code: 190, message: 'Unexpected fixture credential' } });
  }
  const mediaId = /^\/v\d+\.\d+\/([0-9]+)$/.exec(url.pathname)?.[1];
  if (req.method === 'GET' && mediaId && media.get(mediaId) === url.searchParams.get('phone_number_id')) {
    return json(res, 200, { url: `https://graph.facebook.com/fixture-content/${mediaId}`,
      mime_type: 'text/plain', file_size: fixtureFile.length });
  }
  const fileId = /^\/fixture-content\/([0-9]+)$/.exec(url.pathname)?.[1];
  if (req.method === 'GET' && fileId && media.has(fileId)) {
    return res.writeHead(200, { 'content-type': 'text/plain' }).end(fixtureFile);
  }
  if (!match || req.method !== 'POST') {
    return json(res, 400, { error: { code: 100, message: 'Unexpected Graph fixture request' } });
  }
  const [, line, operation] = match;
  const calls = attempts.get(line) ?? [];
  attempts.set(line, calls);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  if (operation === 'media') {
    const firstUpload = calls.every((call) => call.operation !== 'media');
    calls.push({ operation });
    if (firstUpload) return json(res, 400, { error: { code: 100, message: 'Fixture upload rejection' } });
    assert.ok(body.includes(fixtureFile.toString()));
    const id = String(100000123456 + media.size);
    media.set(id, line);
    return json(res, 200, { id });
  }

  const message = JSON.parse(body);
  if (message.status === 'read') return json(res, 200, { success: true });
  const id = 'wamid.' + randomUUID();
  calls.push({ operation, id, to: message.to, type: message.type, callback: message.biz_opaque_callback_data });
  if (message.text?.body?.startsWith('Envío QA sin confirmación')) return res.destroy();
  return json(res, 200, { messages: [{ id }] });
}).listen(Number(provider.port), provider.hostname);
await once(server, 'listening');
server.unref();

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://graph.facebook.com') return originalFetch(input, init);
  assert.ok(!(input instanceof Request));
  return originalFetch(provider.origin + url.pathname + url.search, init);
};
