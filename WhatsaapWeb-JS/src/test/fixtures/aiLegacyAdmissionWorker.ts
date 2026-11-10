import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { TenantAiDispatchPolicy } from '../../services/ai/gateway/TenantAiDispatchPolicy';

async function run() {
  const tenantId = Number(process.argv[2]);
  const connectionString = process.env.AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL;
  assert.ok(Number.isSafeInteger(tenantId) && tenantId > 0 && connectionString && process.send);
  const pool = new Pool({ connectionString });
  try {
    await new TenantAiDispatchPolicy(new TenantScopedUoW(pool)).withLegacyDispatch(tenantId, () =>
      new Promise<void>((resolve) => {
        process.once('disconnect', resolve);
        process.send!('legacy-admitted');
      }));
  } finally {
    await pool.end();
  }
}

void run().catch(() => { process.exitCode = 1; });
