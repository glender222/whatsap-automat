import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET ||= 'test-jwt-secret-with-at-least-32-characters';
process.env.DB_PASSWORD ||= 'test-password';

test('OpenAIProvider usa Responses API y extrae solo output_text anidado', async () => {
  const { OpenAIProvider } = await import('../modules/ai/infra/provider/OpenAIProvider');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"type":"final","reply":"ok"}' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test-secret',
      model: 'gpt-test',
      requestTimeoutMs: 1000,
      apiUrl: 'https://openai.invalid/v1',
    });
    const reply = await provider.complete([
      { role: 'system', content: 'Devuelve JSON.' },
      { role: 'tool', content: '{"stock":3}' },
    ]);

    assert.equal(reply, '{"type":"final","reply":"ok"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openai.invalid/v1/responses');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test-secret');

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'gpt-test');
    assert.equal(body.input[0].role, 'system');
    assert.equal(body.input[1].role, 'user');
    assert.match(body.input[1].content, /Resultado de herramienta/);
    assert.equal(JSON.stringify(body).includes('sk-test-secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAIProvider devuelve errores controlados sin filtrar clave ni prompt', async () => {
  const { OpenAIProvider } = await import('../modules/ai/infra/provider/OpenAIProvider');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: 'invalid key' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  )) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: 'sk-never-expose',
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });
    await assert.rejects(
      provider.complete([{ role: 'user', content: 'mensaje privado del cliente' }]),
      (error: unknown) => {
        const providerError = error as Error & { code?: string; providerStatusCode?: number };
        assert.equal(providerError.code, 'AI_PROVIDER_AUTH_ERROR');
        assert.equal(providerError.providerStatusCode, 401);
        assert.equal(providerError.message.includes('sk-never-expose'), false);
        assert.equal(providerError.message.includes('mensaje privado'), false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AiProviderFactory conserva OpenCode y agrega OpenAI', async () => {
  const { AiProviderFactoryPg } = await import('../modules/ai/infra/provider/AiProviderFactory');
  const factory = new AiProviderFactoryPg();
  assert.equal(factory.create('opencode').providerName, 'opencode');
  assert.equal(factory.create('openai').providerName, 'openai');
});
