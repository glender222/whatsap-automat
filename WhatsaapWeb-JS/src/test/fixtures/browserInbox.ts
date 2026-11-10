import { randomInt, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

async function main() {
  const url = new URL(process.env.PRODUCT_SMOKE_URL ?? '');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');
  assert.equal(process.env.WHATSAPP_PROVIDER, 'meta-cloud');

  const { default: pool } = await import('../../config/database');
  const { MetaAccountStore } = await import('../../services/whatsapp/meta/MetaAccountStore');
  try {
    const store = new MetaAccountStore();
    const firstLine = randomInt(200_000_000_000_000, 300_000_000_000_000);
    const companies = [];
    for (const [index, nombre] of ['Alfa', 'Bravo'].entries()) {
      const response = await fetch(url.origin + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nombre, email: randomUUID() + '@example.invalid', password: randomUUID() }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      const phoneNumberId = String(firstLine + index);
      await store.upsertConnection(data.user.companyId, { phoneNumberId, status: 'configured' });
      companies.push({
        phoneNumberId,
        auth: {
          browserSessionId: randomUUID(),
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.user,
        },
      });
    }
    console.log(JSON.stringify(companies));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Browser fixtures failed');
  process.exitCode = 1;
});
