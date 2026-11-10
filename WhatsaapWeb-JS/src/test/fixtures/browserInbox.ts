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
  const { MetaInboxStore } = await import('../../services/whatsapp/meta/MetaInboxStore');
  const { tenantScopedUoW } = await import('../../db/TenantScopedUoW');
  const postAuth = async (action: string, body: object, token?: string) => {
    const response = await fetch(`${url.origin}/api/auth/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `Auth fixture ${action}`);
    return (await response.json()).data;
  };
  try {
    const store = new MetaAccountStore();
    const firstLine = randomInt(200_000_000_000_000, 300_000_000_000_000);
    const companies = [];
    const outboundId = process.argv.includes('--outbound') ? 'wamid.' + randomUUID() : undefined;
    const send = process.argv.includes('--send');
    const studio = process.argv.includes('--studio');
    const studioProvider = studio && process.env.STUDIO_PROVIDER_FIXTURE === '1';
    if (send || studio) {
      const provider = new URL((send ? process.env.PRODUCT_GRAPH_FIXTURE_URL : process.env.STUDIO_FIXTURE_URL) ?? '');
      assert.equal(provider.protocol, 'http:');
      assert.equal(provider.hostname, '127.0.0.1');
      const health = await fetch(provider.origin + '/health', { signal: AbortSignal.timeout(3000) });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { backend: url.origin });
    }
    for (const [index, nombre] of ['Alfa', 'Bravo'].entries()) {
      let data = await postAuth('register', { nombre, email: randomUUID() + '@example.invalid', password: randomUUID() });
      const phoneNumberId = String(firstLine + index);
      await store.upsertConnection(data.user.companyId, {
        phoneNumberId, status: 'configured',
        ...(send && { accessToken: 'synthetic-local-token', graphVersion: 'v25.0' }),
      });
      if (studio && !studioProvider) {
        await tenantScopedUoW.run(data.user.companyId, (db) => db.query(`
          INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd)
          VALUES ($1, 10000000, 10000000)
          ON CONFLICT (tenant_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit,
            monthly_cost_limit_micro_usd = EXCLUDED.monthly_cost_limit_micro_usd
        `, [data.user.companyId]));
      }
      if (studioProvider) {
        const { tenantAiDispatchPolicy } = await import('../../services/ai/gateway/TenantAiDispatchPolicy');
        await tenantAiDispatchPolicy.transition(data.user.companyId, 'draining');
        await tenantAiDispatchPolicy.transition(data.user.companyId, 'strict');
      }
      if (outboundId) {
        await new MetaInboxStore({ companyId: data.user.companyId }).persistOutbound({
          chatId: '12025550145', body: 'Envío de ' + nombre, messageType: 'text',
          providerMessageId: outboundId, phoneNumberId, raw: {},
        });
      }
      if (send && index === 0) {
        const credentials = { email: randomUUID() + '@example.invalid', password: randomUUID() };
        await postAuth('create-station', { nombre: 'Operador Alfa', ...credentials }, data.accessToken);
        data = await postAuth('login', credentials);
        assert.equal(data.user.rol, 'EMPLEADO');
      }
      companies.push({
        phoneNumberId,
        outboundId,
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
