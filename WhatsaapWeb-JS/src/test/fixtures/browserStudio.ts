import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { boundedTextCapability } from '../../services/ai/gateway/BoundedTextCompletion';
import { OpenAiBoundedTextAdapter } from '../../services/ai/gateway/adapters/OpenAiBoundedTextAdapter';
import { AiQuotaReservationStore } from '../../services/ai/gateway/AiQuotaReservationStore';
import { AgentExecutionEvaluator } from '../../services/ai/studio/AgentExecutionEvaluator';
import { BoundedAgentDispatch } from '../../services/ai/studio/BoundedAgentDispatch';

async function main() {
  const backend = new URL(process.env.PRODUCT_SMOKE_URL ?? '');
  const provider = new URL(process.env.STUDIO_FIXTURE_URL ?? '');
  for (const address of [backend, provider]) {
    assert.equal(address.protocol, 'http:');
    assert.equal(address.hostname, '127.0.0.1');
    assert.match(address.port, /^\d+$/);
  }
  assert.equal(process.env.PORT, backend.port);
  assert.equal(process.env.HOST, '127.0.0.1');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.WHATSAPP_PROVIDER, 'meta-cloud');
  assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');
  const providerMode = process.env.STUDIO_PROVIDER_FIXTURE === '1';
  const fixtureAuthorization = 'Bearer fixture-studio-provider';

  const checkpoints = new Map<string, () => void>();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ backend: backend.origin }));
    const checkpoint = req.url?.match(/^\/checkpoint\/([a-f0-9-]{36})$/)?.[1];
    if (checkpoint && req.method === 'GET') return res.writeHead(checkpoints.has(checkpoint) ? 200 : 404).end('{}');
    if (checkpoint && req.method === 'POST') {
      const resume = checkpoints.get(checkpoint);
      resume?.();
      return res.writeHead(resume ? 200 : 404).end('{}');
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' ||
        req.headers.authorization !== (providerMode ? fixtureAuthorization : undefined)) return res.writeHead(400).end('{}');
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, boundedTextCapability.model);
      res.end(JSON.stringify({ model: body.model, service_tier: 'default',
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Resultado de prueba: ' + body.messages[1].content } }],
      }));
    } catch { res.writeHead(400).end('{}'); }
  }).listen(Number(provider.port), provider.hostname);
  await once(server, 'listening');
  server.unref();

  const { App } = await import('../../app');
  if (providerMode) {
    const fetchNetwork = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (url !== 'https://api.openai.com/v1/chat/completions') return fetchNetwork(url, options);
      assert.equal(new Headers(options?.headers).get('authorization'), fixtureAuthorization);
      assert.equal(options?.redirect, 'error');
      return fetchNetwork(provider.origin + '/v1/chat/completions', options);
    };
    await new App().start();
    return;
  }

  const adapter = new OpenAiBoundedTextAdapter((url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
    return fetch(provider.origin + '/v1/chat/completions', options);
  });
  const { tenantScopedUoW } = await import('../../db/TenantScopedUoW');
  const { createStudioVerification } = await import('../../services/ai/studio/StudioVerification');
  const verification = createStudioVerification(tenantScopedUoW, adapter);
  const dispatcher = new BoundedAgentDispatch(new AiQuotaReservationStore(tenantScopedUoW), adapter, false);
  const evaluator = new AgentExecutionEvaluator(tenantScopedUoW, {
    async dispatch(command) {
      const result = await dispatcher.dispatch(command);
      const checkpoint = command.input.match(/^Pausa QA ([a-f0-9-]{36})$/)?.[1];
      if (checkpoint) {
        // Hold the settled dispatch before the evaluator writes its checkpoint.
        await new Promise<void>((resolve) => {
          const resume = () => {
            clearTimeout(timer);
            checkpoints.delete(checkpoint);
            resolve();
          };
          const timer = setTimeout(resume, 8000);
          checkpoints.set(checkpoint, resume);
        });
      }
      return result;
    },
  });
  await new App({ ...verification, evaluator }).start();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Studio fixture failed');
  process.exitCode = 1;
});
