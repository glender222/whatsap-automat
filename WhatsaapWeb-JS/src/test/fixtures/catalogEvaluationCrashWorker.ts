import './testEnv';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { createTenantBoundedModelExecution } from '../../services/ai/gateway/TenantBoundedModelExecution';
import { CatalogRouterCheckpointStore } from '../../services/ai/runtime/CatalogRouterCheckpointStore';
import { CatalogRouterCheckpointRuntime } from '../../services/ai/runtime/CatalogRouterCheckpointRuntime';
import { CatalogExecutionEvaluator } from '../../services/ai/studio/CatalogExecutionEvaluator';

async function main() {
  const endpoint = new URL(process.argv[2]);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.pathname, '/v1/chat/completions');
  const database = new URL(process.env.STRICT_CATALOG_TEST_DATABASE_URL!);
  assert.equal(database.hostname, '127.0.0.1');
  assert.match(database.pathname, /_smoke$/);
  const pool = new Pool({ connectionString: database.toString() });
  const uow = new TenantScopedUoW(pool);
  class StopAfterCheckpoint extends CatalogRouterCheckpointStore {
    override async getRound(...args: Parameters<CatalogRouterCheckpointStore['getRound']>) {
      const result = await super.getRound(...args);
      if (result?.state === 'completed' && args[2] === process.argv[4]) {
        process.send?.({ checkpoint: args[2] });
        await new Promise<void>(() => setInterval(() => undefined, 1000));
      }
      return result;
    }
  }
  try {
    const execution = createTenantBoundedModelExecution(uow, (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      return fetch(endpoint, init);
    });
    const runtime = new CatalogRouterCheckpointRuntime(uow, undefined, new StopAfterCheckpoint(uow), execution);
    await new CatalogExecutionEvaluator(uow, runtime).evaluate(JSON.parse(process.argv[3]));
  } finally { await pool.end(); }
}
void main().catch(() => { process.send?.({ failed: true }); process.exitCode = 1; });
