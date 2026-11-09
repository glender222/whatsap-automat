import assert from 'node:assert/strict';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { io, Socket } from 'socket.io-client';
import { conversationMessageV1Schema, conversationV1Schema } from '@whatsap-automat/contracts';
import { AutomatClient } from '../../../packages/sdk/src';
import config from '../config/index';
import pool from '../config/database';
import { auditLogger } from '../services/audit/AuditLogger';
import { hitlApprovalService } from '../services/ai/broker';
import { withTenantTransaction } from '../db/TenantScopedUoW';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';

const base = process.env.PRODUCT_SMOKE_URL;

async function api(path: string, status: number, token?: string, data?: object) {
  const response = await fetch(`${base}${path}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(data && { 'Content-Type': 'application/json' }),
    },
    body: data && JSON.stringify(data),
  });
  const body = await response.json();
  assert.equal(response.status, status, `${path}: ${body.error || body.detail || response.statusText}`);
  return 'data' in body ? body.data : body;
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

test('real API isolates two companies through auth, signed ingress, inbox, sockets and CAS', {
  skip: !base && 'Run against a dedicated local smoke database and set PRODUCT_SMOKE_URL',
  timeout: 20000,
}, async (t) => {
  assert.equal(new URL(base!).hostname, '127.0.0.1');
  assert.match(config.database.name, /_smoke$/);
  assert.equal(config.whatsapp.provider, 'meta-cloud');
  t.after(() => pool.end());

  const accounts = ['Alfa', 'Bravo'].map((nombre) => ({
    nombre, email: `${randomUUID()}@example.invalid`, password: randomUUID(),
  }));
  const [owner, other] = await Promise.all(accounts.map((account) => api('/api/auth/register', 200, undefined, account)));
  assert.notEqual(owner.user.companyId, other.user.companyId);
  const [first, second] = await Promise.all([1, 2].map(() => api('/api/auth/login', 200, undefined, accounts[0])));
  assert.notEqual(first.refreshToken, second.refreshToken);
  const renewal = await api('/api/auth/refresh', 200, undefined, { refreshToken: first.refreshToken });
  assert.equal((await api('/api/auth/me', 200, renewal.accessToken)).companyId, owner.user.companyId);
  await api('/api/auth/logout', 200, first.accessToken, { refreshToken: first.refreshToken });
  await api('/api/auth/refresh', 401, undefined, { refreshToken: first.refreshToken });

  const ownerSocket = await connect(owner.accessToken);
  t.after(() => { ownerSocket.disconnect(); });
  const otherSocket = await connect(other.accessToken);
  t.after(() => { otherSocket.disconnect(); });
  const ownerMessages: unknown[] = [];
  const otherMessages: unknown[] = [];
  ownerSocket.on('message', (message) => ownerMessages.push(message));
  otherSocket.on('message', (message) => otherMessages.push(message));

  const phoneNumberId = String(randomInt(100_000_000_000_000, 200_000_000_000_000));
  await new MetaAccountStore().upsertConnection(owner.user.companyId, { phoneNumberId, status: 'configured' });
  const chatId = '51987654321';
  const messageId = `wamid.${randomUUID()}`;
  const inbound = (id: string, body: string) => JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    messages: [{ id, from: chatId, type: 'text', text: { body } }],
  } }] }] });
  const sign = (body: string) => createHmac('sha256', config.meta.appSecret).update(body).digest('hex');
  const payload = inbound(messageId, 'Mensaje de prueba');
  const signature = sign(payload);
  async function webhook(sig: string, status: number, body = payload) {
    const response = await fetch(`${base}/api/webhooks/meta/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
      body,
    });
    const data = await response.json();
    assert.equal(response.status, status, data.error || data.message);
    return data;
  }

  await webhook('0'.repeat(64), 403);
  assert.equal((await webhook(signature, 200)).results[0].duplicate, false);
  assert.equal((await webhook(signature, 200)).results[0].duplicate, true);

  const chats = await api('/api/chats', 200, owner.accessToken);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, chatId);
  const messages = await api(`/api/chats/${chatId}/messages`, 200, owner.accessToken);
  assert.deepEqual(messages.map((message: { id: string }) => message.id), [messageId]);
  const canonicalPath = `/api/v1/conversations/${chats[0].conversationId}`;
  const canonicalList = await api('/api/v1/conversations?channel=whatsapp-cloud&limit=1', 200, owner.accessToken);
  assert.equal(canonicalList.items.length, 1);
  const canonical = conversationV1Schema.parse(canonicalList.items[0]);
  assert.equal(canonical.externalConversationId, chatId);
  assert.deepEqual(await api(canonicalPath, 200, owner.accessToken), canonical);
  const messagePage = await api(`${canonicalPath}/messages`, 200, owner.accessToken);
  assert.equal(conversationMessageV1Schema.parse(messagePage.items[0]).body, 'Mensaje de prueba');
  await api('/api/v1/conversations?cursor=invalido', 422, owner.accessToken);
  await api(canonicalPath, 404, other.accessToken);
  await api(`${canonicalPath}/messages`, 404, other.accessToken);
  assert.deepEqual(await api('/api/chats', 200, other.accessToken), []);
  await api(`/api/chats/${chatId}/messages`, 404, other.accessToken);
  const room = await ownerSocket.timeout(2000).emitWithAck('join_conversation', chatId);
  assert.equal(room.success, true);
  const deniedRoom = await otherSocket.timeout(2000).emitWithAck('join_conversation', chatId);
  assert.equal(deniedRoom.success, false);
  assert.equal(deniedRoom.status, 404);
  const takeover = `/api/conversations/${chats[0].conversationId}/takeover`;
  const command = { expectedVersion: chats[0].stateVersion, reason: 'Validación de producto' };
  await api(takeover, 404, other.accessToken, command);
  const updated = await api(takeover, 200, owner.accessToken, command);
  assert.equal(updated.aiPaused, true);
  await api(takeover, 409, owner.accessToken, command);
  const resumed = conversationV1Schema.parse(await api(`${canonicalPath}/resume-ai`, 200, owner.accessToken, {
    expectedVersion: updated.newVersion,
  }));
  assert.equal(resumed.aiPaused, false);
  await api(`${canonicalPath}/pause-ai`, 409, owner.accessToken, command);

  for (let attempt = 0; attempt < 20 && ownerMessages.length === 0; attempt++) await delay(25);
  assert.equal(ownerMessages.length, 1);
  assert.deepEqual(otherMessages, []);

  const secondPayload = inbound(`wamid.${randomUUID()}`, 'Segundo mensaje de prueba');
  assert.equal((await webhook(sign(secondPayload), 200, secondPayload)).results[0].duplicate, false);
  const latest = await api(`${canonicalPath}/messages?limit=1`, 200, owner.accessToken);
  const earlier = await api(`${canonicalPath}/messages?limit=1&cursor=${latest.nextCursor}`, 200, owner.accessToken);
  const forward = await api(`${canonicalPath}/messages?limit=1&cursor=${earlier.prevCursor}`, 200, owner.accessToken);
  assert.equal(latest.items[0].body, 'Segundo mensaje de prueba');
  assert.equal(earlier.items[0].body, 'Mensaje de prueba');
  assert.equal(earlier.nextCursor, null);
  assert.deepEqual(forward, latest);
  const client = new AutomatClient({ baseUrl: `${base}/api/v1`, token: owner.accessToken });
  const connectionId = `wa-meta-${owner.user.companyId}-${phoneNumberId}`;
  const [connection] = await client.channels.list({ limit: 1 });
  assert.equal(connection.id, connectionId);
  assert.equal(connection.externalAccountId, phoneNumberId);
  assert.deepEqual(await client.channels.get(connectionId), connection);
  assert.deepEqual(await client.channels.validate(connectionId), {
    configured: false, authorized: false, lastErrorCode: 'META_CREDENTIAL_MISSING', lastCheckedAt: null,
  });
  await api(`/api/v1/channel-connections/${connectionId}`, 404, other.accessToken);
  assert.deepEqual(await client.conversations.list({ limit: 1 }).all(), [await client.conversations.get(canonical.id)]);
  assert.deepEqual((await client.conversations.listMessages(canonical.id, { limit: 1 }).all()).map((item) => item.body), [
    'Segundo mensaje de prueba', 'Mensaje de prueba',
  ]);
  const claimed = await client.conversations.takeover(canonical.id, {
    expectedVersion: resumed.stateVersion,
    userId: String(other.user.id),
  });
  assert.equal(claimed.assignedUserId, String(owner.user.id));
  assert.equal(claimed.aiPaused, true);
  assert.equal(claimed.stateVersion, resumed.stateVersion + 1);

  const pausedMessageId = `wamid.${randomUUID()}`;
  const pausedPayload = inbound(pausedMessageId, 'Mensaje durante toma de control');
  assert.equal((await webhook(sign(pausedPayload), 200, pausedPayload)).results[0].duplicate, false);
  const logPath = `/api/agents/runtime-logs?chatId=${chatId}`;
  const runtimeLogs = await api(logPath, 200, owner.accessToken);
  const stagesFor = (id: string) => runtimeLogs.filter((entry: { inboundProviderMessageId: string }) =>
    entry.inboundProviderMessageId === id).map((entry: { stage: string }) => entry.stage);
  assert.ok(stagesFor(messageId).includes('router_missing'));
  assert.ok(stagesFor(messageId).includes('agent_runtime_completed'));
  assert.ok(stagesFor(pausedMessageId).includes('agent_skipped_paused'));
  assert.ok(!stagesFor(pausedMessageId).includes('agent_runtime_started'));
  assert.deepEqual(await api(logPath, 200, other.accessToken), []);

  const legacyPausePath = `/api/chats/ia/${chatId}`;
  await api(`${legacyPausePath}/status`, 404, other.accessToken);
  assert.equal((await api(`${legacyPausePath}/status`, 200, owner.accessToken)).paused, true);
  await api(`${legacyPausePath}/resume`, 200, owner.accessToken, {});
  assert.equal((await api(canonicalPath, 200, owner.accessToken)).stateVersion, claimed.stateVersion + 1);
  const timed = await client.conversations.pauseAi(canonical.id, { expectedVersion: claimed.stateVersion + 1, durationSeconds: 1 });
  assert.equal(timed.aiPaused, true);
  await delay(1100);
  assert.equal((await client.conversations.get(canonical.id)).aiPaused, false);
  assert.equal((await api(`${legacyPausePath}/status`, 200, owner.accessToken)).paused, false);
  await api(`${legacyPausePath}/pause`, 200, owner.accessToken, { reason: 'Pausa humana' });
  assert.equal((await api(`${legacyPausePath}/status`, 200, owner.accessToken)).reason, 'Pausa humana');

  const event = await auditLogger.log({ tenantId: owner.user.companyId, action: 'SMOKE_CHECK', resourceType: 'conversation' });
  const audit = await fetch(`${base}/api/v1/admin/audit-events?search=SMOKE_CHECK`, {
    headers: { Authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(audit.status, 200);
  assert.deepEqual((await audit.json()).events.map((row: { id: string }) => row.id), [event.id]);
  await api(`/api/v1/admin/audit-events?tenantId=${owner.user.companyId}`, 403, other.accessToken);
  const health = await fetch(`${base}/api/v1/admin/health/diagnostics`, {
    headers: { Authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(health.status, 200);
  const report = await health.json();
  assert.ok(report.checks.some((check: { code: string; status: string }) => check.code === 'DB-PG-001' && check.status === 'PASS'));

  const approvals = '/api/v1/ai/approvals';
  const station = { nombre: 'Operador QA', email: `${randomUUID()}@example.invalid`, password: randomUUID() };
  const { employee } = await api('/api/auth/create-station', 200, owner.accessToken, station);
  const stationSession = await api('/api/auth/login', 200, undefined, station);
  assert.equal(stationSession.user.id, employee.id);
  assert.equal(stationSession.user.companyId, owner.user.companyId);
  const employeeToken = stationSession.accessToken;
  const workspacePath = '/api/v1/workspaces/current';
  await api(workspacePath, 401);
  const ownerWorkspace = await api(workspacePath, 200, owner.accessToken);
  assert.equal(ownerWorkspace.tenantId, String(owner.user.companyId));
  assert.equal(ownerWorkspace.tenantName, accounts[0].nombre);
  assert.equal(ownerWorkspace.workspaceName, 'Principal');
  assert.deepEqual(ownerWorkspace.roles, ['owner']);
  assert.ok(ownerWorkspace.capabilities.includes('approvals.review'));
  const operatorWorkspace = await api(workspacePath, 200, employeeToken);
  assert.equal(operatorWorkspace.workspaceId, ownerWorkspace.workspaceId);
  assert.deepEqual(operatorWorkspace.roles, ['member']);
  assert.ok(!operatorWorkspace.capabilities.includes('approvals.review'));
  const otherWorkspace = await fetch(`${base}${workspacePath}`, {
    headers: { Authorization: `Bearer ${other.accessToken}`, 'x-tenant-id': ownerWorkspace.tenantId, 'x-workspace-id': ownerWorkspace.workspaceId },
  });
  assert.equal(otherWorkspace.status, 200);
  const otherWorkspaceBody = await otherWorkspace.json();
  assert.equal(otherWorkspaceBody.tenantId, String(other.user.companyId));
  assert.notEqual(otherWorkspaceBody.workspaceId, ownerWorkspace.workspaceId);
  const graphs = '/api/v1/agent-graphs';
  await api(graphs, 403, employeeToken);
  const graphId = `qa-${randomUUID()}`;
  const draft = await api(graphs, 201, owner.accessToken, {
    graphId, entryNodeId: 'entry',
    nodes: [{ id: 'entry', kind: 'router', config: {} }, { id: 'end', kind: 'end', config: {} }],
    edges: [{ id: 'flow', from: 'entry', to: 'end' }], policyRef: 'qa',
    limits: { maxSteps: 10, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10, maxModelTokens: 100, maxCostMicroUsd: 100 },
  });
  assert.equal(draft.status, 'draft');
  await api(`${graphs}/${graphId}`, 404, other.accessToken);
  const validation = await api(`${graphs}/${graphId}/validate`, 200, owner.accessToken, {});
  assert.equal(validation.specHash, draft.specHash);
  assert.equal(validation.publicationEvidence, false);
  await api(`${graphs}/${graphId}/publish`, 501, owner.accessToken, {});

  await api('/api/v1/admin/health/diagnostics', 403, employeeToken);
  await api(`/api/v1/channel-connections/${connectionId}/validate`, 403, employeeToken, {});
  const createApproval = (expiresInSeconds: number) => hitlApprovalService.createApprovalRequest({
    tenantId: owner.user.companyId, runId: randomUUID(), toolName: 'test-review', risk: 'financial',
    effectKey: randomUUID(), proposedActionHash: 'synthetic-action-hash', expiresInSeconds,
    inputPayload: { lineItems: [{ description: 'QA only', api_key: 'fixture-secret' }] },
  });
  const [approval, expired] = await Promise.all([createApproval(60), createApproval(-1)]);
  const decision = { decision: 'approved', expectedVersion: 1, decidedBy: other.user.id };
  await api(approvals, 403, employeeToken);
  assert.deepEqual(await api(approvals, 200, other.accessToken), []);
  const pending = await api(approvals, 200, owner.accessToken);
  assert.deepEqual(pending.map((item: { id: string }) => item.id), [approval.id]);
  assert.deepEqual(pending[0].details.parametersRedacted.lineItems, [{ description: 'QA only', api_key: '[REDACTED]' }]);
  const approvalPath = `${approvals}/${approval.id}/decision`;
  await api(approvalPath, 403, employeeToken, decision);
  await api(approvalPath, 404, other.accessToken, decision);
  await api(approvalPath, 409, owner.accessToken, { ...decision, expectedVersion: 2 });
  await api(`${approvals}/${expired.id}/decision`, 410, owner.accessToken, decision);
  assert.equal((await hitlApprovalService.getApprovalById(owner.user.companyId, expired.id))?.status, 'pending');
  const approved = await api(approvalPath, 200, owner.accessToken, decision);
  assert.equal(approved.decidedBy, String(owner.user.id));
  assert.equal(approved.status, 'approved');
  await api(approvalPath, 409, owner.accessToken, decision);
  const auditRows = await withTenantTransaction(owner.user.companyId, (client) => client.query(
    `SELECT actor_user_id FROM operational_actions
     WHERE company_id = $1 AND action_type = 'approval_decision' AND metadata_json->>'approvalId' = $2`,
    [owner.user.companyId, approval.id]
  ));
  assert.deepEqual(auditRows.rows.map((row) => String(row.actor_user_id)), [String(owner.user.id)]);

  const retryApproval = await createApproval(60);
  const canonicalApprovals = '/api/v1/approvals';
  assert.deepEqual(await client.approvals.list({ risk: 'financial' }), [retryApproval]);
  assert.deepEqual(await client.approvals.get(retryApproval.id), retryApproval);
  assert.equal((await client.approvals.get(expired.id)).status, 'expired');
  await api(`${canonicalApprovals}/${retryApproval.id}`, 404, other.accessToken);
  await api(`${canonicalApprovals}/${retryApproval.id}`, 403, employeeToken);
  await api(`${canonicalApprovals}/${retryApproval.id}/decision`, 422, owner.accessToken, decision);
  const retryKey = randomUUID();
  const approve = { decision: 'approved' as const, expectedVersion: 1 };
  const [firstDecision, replay] = await Promise.all([
    client.approvals.decide(retryApproval.id, approve, retryKey),
    client.approvals.decide(retryApproval.id, approve, retryKey),
  ]);
  assert.deepEqual(firstDecision, replay);
  await assert.rejects(client.approvals.decide(retryApproval.id, { ...approve, decision: 'rejected' }, retryKey), { status: 409 });
  await assert.rejects(client.approvals.decide(retryApproval.id, approve), { status: 409 });
  const replayAudit = await withTenantTransaction(owner.user.companyId, (db) => db.query(
    `SELECT id FROM operational_actions WHERE action_type = 'approval_decision' AND metadata_json->>'approvalId' = $1`,
    [retryApproval.id]
  ));
  assert.equal(replayAudit.rowCount, 1);
});
