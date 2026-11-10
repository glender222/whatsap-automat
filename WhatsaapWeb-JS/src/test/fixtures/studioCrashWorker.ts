import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { OpenAiBoundedTextAdapter } from '../../services/ai/gateway/adapters/OpenAiBoundedTextAdapter';
import { createStudioVerification } from '../../services/ai/studio/StudioVerification';

async function run() {
  const endpoint = new URL(process.argv[2]);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.pathname, '/v1/chat/completions');
  const connectionString = process.env.AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL;
  assert.ok(connectionString);
  const pool = new Pool({ connectionString });
  try {
    const adapter = new OpenAiBoundedTextAdapter((_url, options) => fetch(endpoint, options));
    await createStudioVerification(new TenantScopedUoW(pool), adapter).evaluator.evaluate(JSON.parse(process.argv[3]));
  } finally {
    await pool.end();
  }
}

void run().catch(() => { process.exitCode = 1; });
