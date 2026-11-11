import assert from 'node:assert/strict';
import type { Pool } from 'pg';

async function main() {
  const endpoint = new URL(process.argv[2]);
  assert.equal(endpoint.protocol,'http:');
  assert.equal(endpoint.hostname,'127.0.0.1');
  const tenantId = Number(process.argv[3]);
  assert.ok(Number.isSafeInteger(tenantId) && tenantId > 0);
  const stage = process.argv[4];
  assert.ok(['before','after','router','snapshot','once'].includes(stage));
  const database = new URL(process.env.CATALOG_WHATSAPP_TEST_DATABASE_URL!);
  assert.equal(database.hostname,'127.0.0.1');
  assert.match(database.pathname,/_smoke$/);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input,init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(['https://api.openai.com','https://graph.facebook.com'].includes(url.origin));
    if (url.origin === 'https://api.openai.com') {
      assert.equal(url.pathname,'/v1/chat/completions');
      assert.equal(init?.redirect,'error');
    }
    return nativeFetch(`${endpoint.origin}${url.pathname}${url.search}`,init);
  };
  const pool = require('../../config/database') as Pool;
  const { TenantScopedUoW } = await import('../../db/TenantScopedUoW');
  const { StrictWhatsappRuntimeStore } = await import('../../services/ai/runtime/StrictWhatsappRuntimeStore');
  const { CatalogRouterCheckpointStore } = await import('../../services/ai/runtime/CatalogRouterCheckpointStore');
  const checkpoint = async (runId: string) => {
    process.send?.({ checkpoint: stage,runId });
    await new Promise<void>(() => setInterval(() => undefined,1000));
  };
  const record = StrictWhatsappRuntimeStore.prototype.recordCatalogCompletion;
  StrictWhatsappRuntimeStore.prototype.recordCatalogCompletion = async function(...args) {
    if (stage !== 'before' && stage !== 'after') return record.apply(this,args);
    assert.equal(args[0],tenantId);
    if (stage === 'after') await record.apply(this,args);
    await checkpoint(args[1]);
  };
  const getRound = CatalogRouterCheckpointStore.prototype.getRound;
  CatalogRouterCheckpointStore.prototype.getRound = async function(...args) {
    const result = await getRound.apply(this,args);
    if (stage === 'router' && args[2] === 'router' && result?.state === 'completed') await checkpoint(args[1]);
    return result;
  };
  const withTool = CatalogRouterCheckpointStore.prototype.withToolCheckpoint;
  CatalogRouterCheckpointStore.prototype.withToolCheckpoint = async function(...args) {
    const result = await withTool.apply(this,args);
    if (stage === 'snapshot') await checkpoint(args[1]);
    return result;
  };
  const { MetaInboundWorkRepository } = await import('../../services/whatsapp/meta/MetaInboundWorkRepository');
  const { MetaInboundWorker } = await import('../../services/whatsapp/meta/MetaInboundWorker');
  const { default: WhatsAppService } = await import('../../services/whatsappService');
  const uow = new TenantScopedUoW(pool);
  const runtime = new WhatsAppService();
  const worker = new MetaInboundWorker({ repository: new MetaInboundWorkRepository(pool,uow),
    execute: (work,authority) => runtime.processMetaInbound(work,authority),
    afterCompleted: (work,outcome) => runtime.publishMetaInboundOutcome(work,outcome),
    onError: () => process.send?.({ failed: true }),
  });
  try {
    const processed = await worker.processBatch(tenantId);
    process.send?.(stage === 'once' ? { processed } : { failed: true });
  } finally {
    await worker.stop();
    await pool.end();
  }
}
void main().catch(() => { process.send?.({ failed: true }); process.exitCode = 1; });
