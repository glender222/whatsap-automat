import { crashFixture } from './metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import config from '../../config/index';
import pool from '../../config/database';
import createMetaWebhookRoutes from '../../routes/metaWebhookRoutes';
import WhatsAppService from '../../services/whatsappService';
import { MetaInboxStore } from '../../services/whatsapp/meta/MetaInboxStore';
import { MetaInboundWorkRepository } from '../../services/whatsapp/meta/MetaInboundWorkRepository';
import type { OrchestratorInput } from '../../modules/ai/application/AiRuntimeOrchestrator';

async function main() {
  assert.equal(process.env.META_INBOUND_CRASH_TEST, '1');
  assert.ok(process.send, 'Run this fixture only through its integration test');
  assert.match(config.database.name, /_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  const tenantId = Number(process.env.META_INBOUND_CRASH_TENANT_ID);
  assert.ok(Number.isSafeInteger(tenantId) && tenantId > 0);
  const port = Number(process.env.META_INBOUND_CRASH_HTTP_PORT || 34380);
  assert.ok(port > 1024 && port <= 65535 && (port < 34262 || port > 34267));
  const graph = new URL(process.env.META_INBOUND_CRASH_GRAPH_URL!);
  assert.equal(graph.protocol, 'http:');
  assert.equal(graph.hostname, '127.0.0.1');

  // The production Meta client still constructs and signs its HTTP request. Only
  // transport is redirected to the parent's fixture; other network calls fail.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof globalThis.Request ? input.url : String(input));
    assert.equal(target.origin, 'https://graph.facebook.com');
    assert.equal(target.pathname, `/${crashFixture.graphVersion}/${crashFixture.phoneNumberId}/messages`);
    assert.equal(init?.method, 'POST');
    return nativeFetch(`${graph.origin}${target.pathname}`, init);
  };

  class CommitBoundaryStore extends MetaInboxStore {
    override async persistInboundMessage(input: any): Promise<Record<string, unknown>> {
      const result = await super.persistInboundMessage(input);
      if (!result.duplicate && input.message?.id === process.env.META_INBOUND_CRASH_CUT_ID) {
        process.send!({ type: 'inbound-committed' });
        // The parent observes the committed row from another connection, then
        // sends SIGKILL. No production exception or graceful shutdown is used.
        await new Promise<never>(() => {});
      }
      return result;
    }
  }

  const service = new WhatsAppService();
  Object.assign(service, {
    metaStore: new CommitBoundaryStore({ companyId: tenantId }),
    getRuntimeOrchestrator: () => ({
      processInbound: async ({ inboundProviderMessageId, history }: OrchestratorInput) => {
        process.send!({ type: 'runtime-entered', inboundProviderMessageId, history });
        return {
          routerMissing: false, route: 'ventas', agentId: null, action: 'auto_reply',
          reply: `Fixture reply for ${inboundProviderMessageId}`, confidence: 1,
          handoffTicketId: null, toolResults: [], rounds: 1, delivery: null,
        };
      },
    }),
  });

  const app = express();
  app.use(express.json({
    verify(req, _res, body) { (req as Request & { rawBody?: Buffer }).rawBody = body; },
  }));
  app.use('/api/webhooks/meta/whatsapp', createMetaWebhookRoutes(service));
  app.use((error: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode || 500).json({ code: error.code || 'FIXTURE_HTTP_FAILED' });
  });
  let stopWorker: (() => Promise<void>) | undefined;
  const server = app.listen(port, '127.0.0.1', () => {
    if (process.env.META_INBOUND_CRASH_RUN_WORKER === '1') {
      class FixtureWorkRepository extends MetaInboundWorkRepository {
        override async getTenantIds() { return [tenantId]; }
      }
      stopWorker = service.startMetaInboundWorker(new FixtureWorkRepository());
    }
    process.send!({ type: 'ready' });
  });
  server.on('error', () => {
    process.send!({ type: 'fixture-error', code: 'FIXTURE_LISTEN_FAILED' });
    process.exitCode = 1;
  });
  process.on('SIGTERM', () => {
    server.close(() => { void Promise.resolve(stopWorker?.()).then(() => pool.end()).then(() => process.exit(0)); });
    server.closeIdleConnections();
  });
}

void main().catch((error: { code?: string }) => {
  process.send?.({ type: 'fixture-error', code: error.code || 'FIXTURE_START_FAILED' });
  process.exit(1);
});
