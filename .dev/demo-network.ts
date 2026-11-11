import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { demoToken } from './demo-guard';

/** Isolated transports; this module never opens an outgoing HTTP connection. */
export function installDemoNetwork() {
  const requireBackend = createRequire(__filename);
  // Defense in depth for HTTP clients that do not use global fetch (e.g. tools).
  const blocked = () => { throw new Error('DEMO_NETWORK_BLOCKED'); };
  for (const name of ['node:http', 'node:https']) {
    const transport = requireBackend(name);
    transport.request = blocked;
    transport.get = blocked;
  }
  syncBuiltinESMExports();

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const media = new Map<string, { bytes: Uint8Array; type: string }>();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const token = request.headers.get('authorization');
    if (url.origin === 'https://graph.facebook.com' && token === `Bearer ${demoToken}`) {
      const resource = /^\/v25\.0\/([0-9]+)(?:\/(messages|media|message_templates))?$/.exec(url.pathname);
      if (resource) {
        const [, id, operation] = resource;
        if (request.method === 'GET' && !operation && url.searchParams.get('fields') === 'id') {
          return json({ id });
        }
        if (request.method === 'GET' && operation === 'message_templates') return json({ data: [] });
        if (request.method === 'POST' && operation === 'messages') {
          const body = await request.json() as { status?: string };
          return body.status === 'read' ? json({ success: true })
            : json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.demo.${randomUUID()}` }] });
        }
        if (request.method === 'POST' && operation === 'media') {
          const form = await request.formData();
          const file = form.get('file');
          if (!(file instanceof Blob) || file.size > 100_000_000) return json({ error: { code: 100, message: 'Demo media rejected' } }, 400);
          const mediaId = String(Date.now()) + String(media.size);
          media.set(mediaId, { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type });
          return json({ id: mediaId });
        }
        const file = media.get(id);
        if (file && request.method === 'GET' && !operation) {
          return json({ url: `https://graph.facebook.com/demo-content/${id}`, mime_type: file.type, file_size: file.bytes.length });
        }
      }
      const contentId = /^\/demo-content\/([0-9]+)$/.exec(url.pathname)?.[1];
      const file = contentId ? media.get(contentId) : undefined;
      if (file && request.method === 'GET') return new Response(new Uint8Array(file.bytes).buffer, { headers: { 'content-type': file.type } });
      return json({ error: { code: 100, message: 'Operation unavailable in local demo' } }, 400);
    }
    if (url.origin === 'http://127.0.0.1:3999' && token === `Bearer ${demoToken}`) {
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return json({ data: [{ id: 'demo-local-model', object: 'model' }] });
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return json({ model: 'demo-local-model', choices: [{ finish_reason: 'stop', message: {
          role: 'assistant', content: 'Respuesta simulada local. Tu equipo puede revisar el catálogo y continuar la atención.',
        } }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } });
      }
    }
    // No network fallback, redirects, localhost proxies or arbitrary provider URLs.
    throw new Error('DEMO_NETWORK_BLOCKED');
  };

}
