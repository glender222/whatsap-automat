import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

type AuthResult = {
  accessToken: string;
  refreshToken: string;
  user: { id: number; companyId: number; rol: string; [key: string]: unknown };
};

async function main() {
  const endpoint = new URL(process.env.PRODUCT_SMOKE_URL ?? '');
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');

  const { default: pool } = await import('../../config/database');
  const { tenantScopedUoW } = await import('../../db/TenantScopedUoW');
  const { HitlApprovalService } = await import('../../services/ai/broker/HitlApprovalService');
  const service = new HitlApprovalService();
  const postAuth = async (action: string, body: object, token?: string): Promise<AuthResult> => {
    const response = await fetch(`${endpoint.origin}/api/auth/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `Approval auth fixture ${action}`);
    return (await response.json()).data;
  };
  const credentials = () => ({ email: `approvals-qa-${randomUUID()}@example.invalid`, password: randomUUID() });
  const browserAuth = (auth: AuthResult) => ({
    browserSessionId: randomUUID(), ...auth, user: { ...auth.user, id: String(auth.user.id) },
  });
  try {
    const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    const mode = process.argv[2];
    if (mode === '--expire' || mode === '--reviewer') {
      const tenantId = Number(process.argv[3]);
      const identity = process.argv[4];
      assert.ok(Number.isSafeInteger(tenantId) && tenantId > 0);
      assert.ok(identity);
      const updated = await tenantScopedUoW.run(tenantId, async (db) => {
        if (mode === '--expire') {
          return db.query(`
            UPDATE approval_requests SET expires_at = clock_timestamp() - interval '1 second'
            WHERE tenant_id = $1 AND id = $2 AND input_payload->>'fixture' = 'browser-approvals'
            RETURNING id
          `, [tenantId, identity]);
        }
        const enabled = process.argv[5];
        assert.ok(enabled === 'enabled' || enabled === 'disabled');
        const actorId = Number(identity);
        assert.ok(Number.isSafeInteger(actorId) && actorId > 0);
        return db.query(`
          UPDATE memberships AS m SET role = $3
          FROM usuarios AS u
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND u.id = m.user_id AND u.company_id = m.tenant_id
            AND u.email LIKE 'approvals-qa-%@example.invalid'
          RETURNING m.user_id
        `, [tenantId, actorId, enabled === 'enabled' ? 'owner' : 'member']);
      });
      assert.equal(updated.rowCount, 1, 'The requested approval fixture must exist in this tenant');
      process.stdout.write(JSON.stringify({ updated: true }));
      return;
    }
    assert.equal(mode, undefined, 'Unknown approval fixture mode');

    const adminCredentials = credentials();
    const admin = await postAuth('register', { nombre: 'Aprobaciones Alfa', ...adminCredentials });
    const other = await postAuth('register', { nombre: 'Aprobaciones Bravo', ...credentials() });
    const employeeCredentials = credentials();
    await postAuth('create-station', { nombre: 'Operador aprobaciones', ...employeeCredentials }, admin.accessToken);
    const employee = await postAuth('login', employeeCredentials);
    assert.equal(employee.user.rol, 'EMPLEADO');
    assert.equal(employee.user.companyId, admin.user.companyId);

    const create = async (toolName: string, risk: string, tenantId = admin.user.companyId, expiresInSeconds = 3600) => (
      service.createApprovalRequest({
        tenantId, runId: randomUUID(), nodeId: 'approval-fixture', toolName, risk,
        effectKey: randomUUID(), proposedActionHash: 'synthetic-browser-approval', expiresInSeconds,
        inputPayload: { fixture: 'browser-approvals', message: 'Operación sintética sin ejecución de herramientas' },
      })
    );
    const queue = [];
    for (let index = 1; index <= 21; index += 1) {
      const toolName = `qa.approval.queue.${String(index).padStart(2, '0')}`;
      const approval = await create(toolName, 'low');
      queue.push({ id: approval.id, toolName });
    }
    const responseLoss = await create('qa.approval.response-loss', 'write');
    const sensitive = await create('qa.approval.sensitive', 'financial');
    const expiring = await create('qa.approval.expiring', 'write', admin.user.companyId, 10);
    const expired = await create('qa.approval.expired', 'write', admin.user.companyId, -1);
    const foreign = await create('qa.approval.foreign', 'low', other.user.companyId);
    const [pageTwo] = await service.listPendingApprovals(admin.user.companyId, { risk: 'low', offset: 20, limit: 20 });
    assert.ok(pageTwo, 'The approval fixture must have a second filtered page');
    process.stdout.write(JSON.stringify({
      admin: { auth: browserAuth(admin), password: adminCredentials.password, tenantId: String(admin.user.companyId) },
      employee: { auth: browserAuth(employee) }, other: { auth: browserAuth(other) },
      expiresAt: expiring.expiresAt,
      ids: {
        queue, pageTwo: pageTwo.id, responseLoss: responseLoss.id, sensitive: sensitive.id,
        expiring: expiring.id, expired: expired.id, foreign: foreign.id,
      },
    }));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Browser approval fixtures failed');
  process.exitCode = 1;
});
