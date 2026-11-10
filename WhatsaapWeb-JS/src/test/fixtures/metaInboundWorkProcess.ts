import './metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import config from '../../config/index';
import pool from '../../config/database';
import { MetaInboundWorkRepository, type MetaInboundClaim } from '../../services/whatsapp/meta/MetaInboundWorkRepository';
import { MetaInboundWorker } from '../../services/whatsapp/meta/MetaInboundWorker';

async function main() {
  assert.equal(process.env.META_INBOUND_CRASH_TEST, '1');
  assert.ok(process.send);
  assert.match(config.database.name, /^meta_inbound_recovery_[a-z0-9_]+_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  const companyId = Number(process.env.META_INBOUND_CRASH_TENANT_ID);
  assert.ok(Number.isSafeInteger(companyId) && companyId > 0);
  const graph = new URL(process.env.META_INBOUND_CRASH_GRAPH_URL!);
  assert.equal(graph.protocol, 'http:');
  assert.equal(graph.hostname, '127.0.0.1');
  const cutStage = process.env.META_INBOUND_WORK_CUT_STAGE;
  async function cut(stage: string) {
    if (cutStage === stage) {
      process.send!({ type: stage });
      await new Promise<never>(() => {});
    }
  }
  class CutRepository extends MetaInboundWorkRepository {
    override async enterRuntime(claim: MetaInboundClaim, timeoutMs: number) {
      await cut('claimed');
      const entered = await super.enterRuntime(claim, timeoutMs);
      if (entered) await cut('reserved');
      return entered;
    }
  }
  const worker = new MetaInboundWorker({
    repository: new CutRepository(), leaseMs: 20_000, runtimeTimeoutMs: 20_000, maxConcurrency: 1,
    onError: () => process.send!({ type: 'fixture-error' }),
    execute: async (work, authority) => {
      assert.equal(await authority.isCurrent(), true);
      process.send!({ type: 'callback-entered' });
      const response = await fetch(`${graph.origin}/effect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: work.jobId }), signal: authority.signal,
      });
      assert.equal(response.status, 200);
      await cut('effect');
      return { status: 'completed' };
    },
  });
  process.once('message', () => {
    void worker.processBatch(companyId).then(async (processed) => {
      await worker.stop();
      await pool.end();
      process.send!({ type: 'done', processed }, () => process.disconnect?.());
    }).catch(() => {
      process.send!({ type: 'fixture-error' });
      process.exit(1);
    });
  });
  process.send!({ type: 'ready' });
}

void main().catch(() => {
  process.send?.({ type: 'fixture-error' });
  process.exit(1);
});
