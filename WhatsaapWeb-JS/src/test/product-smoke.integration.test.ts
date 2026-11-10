import assert from 'node:assert/strict';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Server as SocketIOServer } from 'socket.io';
import { io, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { conversationMessageV1Schema, conversationV1Schema } from '@whatsap-automat/contracts';
import { AutomatClient } from '../../../packages/sdk/src';
import config from '../config/index';
import pool from '../config/database';
import { auditLogger } from '../services/audit/AuditLogger';
import { hitlApprovalService } from '../services/ai/broker';
import { withTenantTransaction } from '../db/TenantScopedUoW';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';
import { setSocketIo } from '../sockets/socketEmitter';

const base = process.env.PRODUCT_SMOKE_URL;
const peer = process.env.PRODUCT_SMOKE_PEER_URL || base;

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

function connect(token: string, origin = base): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(origin, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

function invalidation(socket: Socket) {
  let reason: unknown;
  socket.once('auth:invalidated', (event) => { reason = event?.reason; });
  return Promise.race([
    new Promise<unknown>((resolve) => socket.once('disconnect', () => resolve(reason))),
    delay(5000, undefined, { ref: false }).then(() => { throw new Error('Socket invalidation timed out'); }),
  ]);
}

test('real API isolates two companies through auth, signed ingress, inbox, sockets and CAS', {
  skip: !base && 'Run against a dedicated local smoke database and set PRODUCT_SMOKE_URL',
  timeout: 40000,
}, async (t) => {
  assert.equal(new URL(base!).hostname, '127.0.0.1');
  assert.equal(new URL(peer!).hostname, '127.0.0.1');
  assert.match(config.database.name, /_smoke$/);
  assert.equal(config.whatsapp.provider, 'meta-cloud');
  t.after(() => pool.end());
  assert.deepEqual(await api('/ready', 200), { status: 'ready' });

  const accounts = ['Alfa', 'Bravo'].map((nombre) => ({
    nombre, email: `${randomUUID()}@example.invalid`, password: randomUUID(),
  }));
  const [owner, other] = await Promise.all(accounts.map((account) => api('/api/auth/register', 200, undefined, account)));
  assert.notEqual(owner.user.companyId, other.user.companyId);
  const reconciliationUnavailable = await api(
    `/api/payments/checkout-intents/${randomUUID()}/reconcile`, 501, owner.accessToken, {},
  );
  assert.equal(reconciliationUnavailable.error, 'PAYMENT_RECONCILIATION_UNAVAILABLE');
  const expiredAccess = jwt.sign({ userId: owner.user.id, companyId: owner.user.companyId },
    config.jwt.secret, { expiresIn: -1 });
  assert.equal((await api('/api/auth/me', 401, expiredAccess)).code, 'ACCESS_TOKEN_EXPIRED');
  assert.equal((await api('/api/v1/workspaces/current', 401, expiredAccess)).code, 'ACCESS_TOKEN_EXPIRED');
  const [first, second] = await Promise.all([1, 2].map(() => api('/api/auth/login', 200, undefined, accounts[0])));
  assert.notEqual(first.refreshToken, second.refreshToken);
  const digest = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex')}`;
  const { rows: sessions } = await withTenantTransaction(owner.user.companyId, (db) => db.query(
    'SELECT token FROM refresh_tokens WHERE usuario_id = $1 ORDER BY token',
    [owner.user.id],
  ));
  const expectedDigests = [
    digest(owner.refreshToken), digest(first.refreshToken), digest(second.refreshToken),
  ].sort();
  assert.ok(sessions.length === expectedDigests.length &&
    sessions.every(({ token }, index) => token === expectedDigests[index]), 'PostgreSQL must store only session token digests');
  assert.equal((await pool.query('SELECT id FROM refresh_tokens WHERE usuario_id = $1', [owner.user.id])).rowCount, 0);
  assert.equal((await withTenantTransaction(other.user.companyId, (db) => db.query(
    'UPDATE refresh_tokens SET revocado = true WHERE usuario_id = $1 RETURNING id', [owner.user.id],
  ))).rowCount, 0);
  const renewal = await api('/api/auth/refresh', 200, undefined, { refreshToken: first.refreshToken });
  assert.equal(jwt.decode(renewal.accessToken)?.sessionId, jwt.decode(first.accessToken)?.sessionId);
  assert.match(String(jwt.decode(first.accessToken)?.sessionId), /^[1-9]\d*$/);
  assert.equal((await api('/api/auth/me', 200, renewal.accessToken)).companyId, owner.user.companyId);
  await api('/api/auth/logout', 200, other.accessToken, { refreshToken: first.refreshToken });
  await api('/api/auth/refresh', 200, undefined, { refreshToken: first.refreshToken });
  const revokedSocket = await connect(renewal.accessToken, peer);
  t.after(() => { revokedSocket.disconnect(); });
  const revoked = invalidation(revokedSocket);
  await api('/api/auth/logout', 200, first.accessToken, { refreshToken: first.refreshToken });
  assert.equal(await revoked, 'revoked');
  assert.equal((await api('/api/auth/me', 401, renewal.accessToken)).code, 'SESSION_REVOKED');
  assert.equal((await api('/api/v1/workspaces/current', 401, first.accessToken)).code, 'SESSION_REVOKED');
  await assert.rejects(connect(first.accessToken, peer), (error: { data?: { code?: string } }) =>
    error.data?.code === 'SESSION_REVOKED');
  await api('/api/auth/refresh', 401, undefined, { refreshToken: first.refreshToken });
  const { exp, iat, ...secondClaims } = jwt.decode(second.accessToken) as jwt.JwtPayload;
  const shortAccess = jwt.sign(secondClaims, config.jwt.secret, { expiresIn: 2 });
  const expiringSocket = await connect(shortAccess, peer);
  t.after(() => { expiringSocket.disconnect(); });
  assert.equal(await invalidation(expiringSocket), 'expiry');
  await assert.rejects(connect(shortAccess, peer), (error: { data?: { code?: string } }) =>
    error.data?.code === 'ACCESS_TOKEN_EXPIRED');
  await api('/api/auth/refresh', 200, undefined, { refreshToken: second.refreshToken });
  await api('/api/auth/logout', 200, second.accessToken, {});
  assert.equal((await api('/api/auth/me', 401, second.accessToken)).code, 'SESSION_REVOKED');

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
  const dashboard = '/api/dashboard';
  const [stats, actionCards, heatmap, otherStats, otherHeatmap] = await Promise.all([
    api(`${dashboard}/quick-stats`, 200, owner.accessToken),
    api(`${dashboard}/action-cards`, 200, owner.accessToken),
    api(`${dashboard}/heatmap?days=7`, 200, owner.accessToken),
    api(`${dashboard}/quick-stats`, 200, other.accessToken),
    api(`${dashboard}/heatmap?days=7`, 200, other.accessToken),
  ]);
  assert.equal(stats.activeChatsCount, 1);
  assert.equal(stats.averageResponseTimeMin, 0);
  assert.equal(actionCards.pendingChatsCount, 1);
  assert.equal(heatmap.days.length, 7);
  assert.equal(heatmap.totalMessages, 1);
  assert.equal(heatmap.days.at(-1).total, 1);
  assert.equal(heatmap.days.at(-1).label, 'Hoy');
  assert.equal(heatmap.days.slice(0, -1).every((day: { total: number }) => day.total === 0), true);
  assert.equal(otherStats.activeChatsCount, 0);
  assert.equal(otherHeatmap.totalMessages, 0);
  assert.equal(otherHeatmap.maxCount, 0);
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
  assert.equal((await api(`${dashboard}/action-cards`, 200, owner.accessToken)).pendingChatsCount, 0);
  await withTenantTransaction(owner.user.companyId, (db) => db.query(
    `UPDATE conversations SET last_message_at = NOW() - INTERVAL '10 minutes' WHERE company_id = $1 AND id = $2`,
    [owner.user.companyId, canonical.id]
  ));
  const alerts = await api(`${dashboard}/sla-alerts`, 200, owner.accessToken);
  assert.deepEqual(alerts.alerts.map((alert: { chatId: string; statusTag: string }) => [alert.chatId, alert.statusTag]), [[chatId, 'attention']]);
  assert.deepEqual((await api(`${dashboard}/sla-alerts`, 200, other.accessToken)).alerts, []);

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
  const station = { nombre: 'Operador QA', email: `${randomUUID()}@example.invalid` };
  const { employee, tempPassword } = await api('/api/auth/create-station', 200, owner.accessToken, station);
  assert.ok(typeof tempPassword === 'string' && /^[A-Za-z0-9!@#$%^&*]{12}$/.test(tempPassword),
    'Creating a station without a password must return a temporary credential');
  const stationSession = await api('/api/auth/login', 200, undefined, { ...station, password: tempPassword });
  assert.equal(stationSession.user.id, employee.id);
  assert.equal(stationSession.user.companyId, owner.user.companyId);
  const employeeToken = stationSession.accessToken;
  const employeeId = employee.id;
  const employeeSocket = await connect(employeeToken);
  t.after(() => { employeeSocket.disconnect(); });
  const employeeApprovalEvents: string[] = [];
  employeeSocket.onAny((event) => {
    if (event === 'approval.created' || event === 'approval.decided') employeeApprovalEvents.push(event);
  });
  const workspacePath = '/api/v1/workspaces/current';
  await api(workspacePath, 401);
  const ownerWorkspace = await api(workspacePath, 200, owner.accessToken);
  assert.equal(ownerWorkspace.tenantId, String(owner.user.companyId));
  assert.equal(ownerWorkspace.tenantName, accounts[0].nombre);
  assert.equal(ownerWorkspace.workspaceName, 'Principal');
  assert.deepEqual(ownerWorkspace.roles, ['owner']);
  assert.ok(ownerWorkspace.capabilities.includes('approvals.review'));
  assert.ok(ownerWorkspace.capabilities.includes('approvals.reauthenticate'));
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
  const executions = '/api/v1/operations/executions';
  await api(executions, 403, employeeToken);
  assert.deepEqual(await api(`${executions}?limit=5`, 200, owner.accessToken), {
    items: [], nextCursor: null, pageSummary: { retryCount: 0, deliveryUnknownCount: 0 },
  });
  await api(`/api/v1/channel-connections/${connectionId}/validate`, 403, employeeToken, {});
  const createApproval = (expiresInSeconds: number, risk = 'financial') => hitlApprovalService.createApprovalRequest({
    tenantId: owner.user.companyId, runId: randomUUID(), toolName: 'test-review', risk,
    effectKey: randomUUID(), proposedActionHash: 'synthetic-action-hash', expiresInSeconds,
    inputPayload: { lineItems: [{ description: 'QA only', api_key: 'fixture-secret' }] },
  });
  // The fixture creates requests in this process. Decisions use the running API and its live socket.
  const fixtureSocket = new SocketIOServer();
  const fixtureBroadcast = t.mock.method(fixtureSocket, 'to');
  setSocketIo(fixtureSocket);
  const [approval, expired] = await Promise.all([createApproval(60), createApproval(-1)]);
  assert.equal(fixtureBroadcast.mock.callCount(), 0, 'Creating approvals must not broadcast to socket rooms');
  const decision = { decision: 'approved', expectedVersion: 1, decidedBy: other.user.id, reason: 'Reviewed fixture' };
  const verifiedDecision = { ...decision, password: accounts[0].password };
  await api(approvals, 403, employeeToken);
  assert.deepEqual(await api(approvals, 200, other.accessToken), []);
  const pending = await api(approvals, 200, owner.accessToken);
  assert.deepEqual(pending.map((item: { id: string }) => item.id), [approval.id]);
  assert.deepEqual(pending[0].details.parametersRedacted.lineItems, [{ description: 'QA only', api_key: '[REDACTED]' }]);
  const approvalPath = `${approvals}/${approval.id}/decision`;
  await api(approvalPath, 403, employeeToken, decision);
  await api(approvalPath, 404, other.accessToken, decision);
  assert.equal((await api(approvalPath, 403, owner.accessToken, decision)).error, 'APPROVAL_REAUTH_REQUIRED');
  assert.equal((await api(approvalPath, 403, owner.accessToken, { ...decision, password: randomUUID() })).error, 'APPROVAL_REAUTH_INVALID');
  await api(approvalPath, 409, owner.accessToken, { ...verifiedDecision, expectedVersion: 2 });
  await api(`${approvals}/${expired.id}/decision`, 410, owner.accessToken, verifiedDecision);
  assert.equal((await hitlApprovalService.getApprovalById(owner.user.companyId, expired.id))?.status, 'pending');
  const approved = await api(approvalPath, 200, owner.accessToken, verifiedDecision);
  assert.equal(approved.decidedBy, String(owner.user.id));
  assert.equal(approved.status, 'approved');
  await api(approvalPath, 409, owner.accessToken, verifiedDecision);
  const auditRows = await withTenantTransaction(owner.user.companyId, (client) => client.query(
    `SELECT actor_user_id FROM operational_actions
     WHERE company_id = $1 AND action_type = 'approval_decision' AND metadata_json->>'approvalId' = $2`,
    [owner.user.companyId, approval.id]
  ));
  assert.deepEqual(auditRows.rows.map((row) => String(row.actor_user_id)), [String(owner.user.id)]);

  const retryApproval = await createApproval(60, 'write');
  const canonicalApprovals = '/api/v1/approvals';
  assert.deepEqual(await client.approvals.list({ risk: 'write' }), [retryApproval]);
  assert.deepEqual(await client.approvals.get(retryApproval.id), retryApproval);
  assert.equal((await client.approvals.get(expired.id)).status, 'expired');
  await api(canonicalApprovals, 403, employeeToken);
  await api(`${canonicalApprovals}/${retryApproval.id}`, 404, other.accessToken);
  await api(`${canonicalApprovals}/${retryApproval.id}`, 403, employeeToken);
  await api(`${canonicalApprovals}/${retryApproval.id}/decision`, 422, owner.accessToken, decision);
  const retryKey = randomUUID();
  const approve = { decision: 'approved' as const, expectedVersion: 1 };
  const canonicalDecision = (token: string) => fetch(`${base}${canonicalApprovals}/${retryApproval.id}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': retryKey },
    body: JSON.stringify(approve),
  });
  assert.equal((await canonicalDecision(employeeToken)).status, 403);
  assert.equal((await canonicalDecision(other.accessToken)).status, 404);

  const updateOwnerMembership = (role: string) => withTenantTransaction(owner.user.companyId, (db) => db.query(
    'UPDATE memberships SET role = $1 WHERE tenant_id = $2 AND user_id = $3',
    [role, owner.user.companyId, owner.user.id]
  ));
  assert.equal((await updateOwnerMembership('member')).rowCount, 1);
  try {
    await api(canonicalApprovals, 403, owner.accessToken);
    await api(approvals, 403, owner.accessToken);
    await api(approvalPath, 403, owner.accessToken, verifiedDecision);
    await api(`${canonicalApprovals}/${retryApproval.id}`, 403, owner.accessToken);
    assert.equal((await canonicalDecision(owner.accessToken)).status, 403);
  } finally {
    await updateOwnerMembership('owner');
  }
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

  const sensitive = await createApproval(60, 'destructive');
  const sensitivePath = `${base}${canonicalApprovals}/${sensitive.id}/decision`;
  const sensitiveKey = randomUUID();
  const reject = (payload: object, token = owner.accessToken) => fetch(sensitivePath, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': sensitiveKey },
    body: JSON.stringify({ decision: 'rejected', expectedVersion: 1, ...payload }),
  });
  const passwordRequired = await reject({ reason: 'Reviewed fixture' });
  assert.equal(passwordRequired.status, 403);
  assert.equal((await passwordRequired.json()).metadata.reason, 'APPROVAL_REAUTH_REQUIRED');
  assert.equal((await reject({ password: accounts[0].password })).status, 422);
  assert.equal((await reject({ reason: 'Reviewed fixture', password: accounts[0].password }, other.accessToken)).status, 404);
  const invalidAttempts = await Promise.all(Array.from({ length: 5 }, () => reject({ reason: 'Reviewed fixture', password: randomUUID() })));
  assert.ok(invalidAttempts.every(({ status }) => status === 403));
  const limited = await reject({ reason: 'Reviewed fixture', password: accounts[0].password });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).metadata.reason, 'APPROVAL_REAUTH_LIMITED');
  assert.equal((await client.approvals.get(sensitive.id)).status, 'pending');
  await withTenantTransaction(owner.user.companyId, (db) => db.query(
    'UPDATE approval_reauth_attempts SET window_ends_at = clock_timestamp() WHERE tenant_id = $1 AND actor_id = $2',
    [owner.user.companyId, owner.user.id],
  ));
  const accepted = await reject({ reason: 'Reviewed fixture', password: accounts[0].password });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, 'rejected');
  const { rows: [sensitiveAudit] } = await withTenantTransaction(owner.user.companyId, (db) => db.query(
    `SELECT metadata_json FROM operational_actions WHERE action_type = 'approval_decision' AND metadata_json->>'approvalId' = $1`,
    [sensitive.id],
  ));
  assert.equal(sensitiveAudit.metadata_json.reauthentication, 'current_password');
  assert.ok(!JSON.stringify(sensitiveAudit).includes(accounts[0].password));
  assert.equal((await employeeSocket.timeout(2000).emitWithAck('join_conversation', chatId)).success, true);
  assert.deepEqual(employeeApprovalEvents, []);

  const payments = '/api/payments';
  await api(payments, 403, employeeToken);
  const tenantId = owner.user.companyId;
  const conversationId = Number(chats[0].conversationId);
  const { rows: [customerConversation] } = await withTenantTransaction(tenantId, (db) => db.query(
    'SELECT contact_id FROM conversations WHERE company_id = $1 AND id = $2', [tenantId, conversationId],
  ));
  const contactId = customerConversation.contact_id;
  const createOrder = (companyId: number, stock: number, forCustomer = false) => withTenantTransaction(companyId, async (db) => {
    const { rows: [order] } = await db.query(
      `INSERT INTO customer_orders (company_id, contact_id, conversation_id, title, notes, order_type, status)
       VALUES ($1, $2, $3, '=QA()', 'Nota <QA>', 'commercial', 'pending_approval') RETURNING id`,
      [companyId, forCustomer ? contactId : null, forCustomer ? conversationId : null],
    );
    const { rows: [product] } = await db.query(
      "INSERT INTO products (company_id, name, stock_available) VALUES ($1, 'Producto historial QA', $2) RETURNING id",
      [companyId, stock],
    );
    await db.query(
      `INSERT INTO order_items (company_id, order_id, product_id, commercial_item_id, product_name, quantity, status)
       VALUES ($1, $2, $3, $3, 'Producto historial QA', 2, 'pending_approval')`,
      [companyId, order.id, product.id],
    );
    return Number(order.id);
  });
  const [order, foreignOrder, unavailableOrder] = await Promise.all([
    createOrder(tenantId, 2, true),
    createOrder(other.user.companyId, 2),
    createOrder(tenantId, 1),
  ]);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ8sAAAAASUVORK5CYII=', 'base64');
  async function uploadVoucher(orderId: number, amount: string, expectedStatus: number) {
    const body = new FormData();
    body.append('file', new Blob([image], { type: 'image/png' }), 'voucher-fixture.png');
    body.append('orderId', String(orderId));
    body.append('amount', amount);
    const response = await fetch(`${base}${payments}`, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}` }, body,
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, result.message || result.error);
    return result.data;
  }
  await uploadVoucher(foreignOrder, '18.50', 404);
  await uploadVoucher(order, 'invalid-amount', 400);
  const voucher = await uploadVoucher(order, '18.50', 201);
  assert.equal(voucher.status, 'pending');
  assert.equal(voucher.orderId, order);
  await api(`${payments}/${voucher.id}`, 404, other.accessToken);
  const protectedFile = (token: string) => fetch(`${base}${voucher.fileUrl}`, { headers: { Authorization: `Bearer ${token}` } });
  const preview = await protectedFile(owner.accessToken);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image);
  assert.equal((await protectedFile(other.accessToken)).status, 404);
  const [decisionA, decisionB] = await Promise.all([1, 2].map(() => api(`${payments}/${voucher.id}/validate`, 200, owner.accessToken, {})));
  assert.deepEqual(decisionA, decisionB);
  assert.equal(decisionA.status, 'validated');
  await api(`${payments}/${voucher.id}/reject`, 409, owner.accessToken, { rejectionReason: 'Decisión anterior' });
  const orderAudit = await withTenantTransaction(tenantId, (db) => db.query(
    `SELECT o.status, o.confirmed_at IS NOT NULL AS confirmed, o.reserved_at IS NOT NULL AS reserved,
            p.stock_available, p.stock_reserved,
            (SELECT COUNT(*)::int FROM operational_actions WHERE company_id = o.company_id AND order_id = o.id AND action_type = 'payment_validated') AS decisions,
            (SELECT COUNT(*)::int FROM stock_movements WHERE company_id = o.company_id AND order_id = o.id AND movement_type = 'reservation') AS movements
     FROM customer_orders o JOIN order_items i ON i.company_id = o.company_id AND i.order_id = o.id
     JOIN products p ON p.company_id = i.company_id AND p.id = i.commercial_item_id
     WHERE o.company_id = $1 AND o.id = $2`,
    [tenantId, order]
  ));
  assert.deepEqual(orderAudit.rows, [{ status: 'confirmed', confirmed: true, reserved: true, stock_available: 0, stock_reserved: 2, decisions: 1, movements: 1 }]);

  const unreservable = await uploadVoucher(unavailableOrder, '18.50', 201);
  await api(`${payments}/${unreservable.id}/validate`, 409, owner.accessToken, {});
  assert.equal((await api(`${payments}/${unreservable.id}`, 200, owner.accessToken)).status, 'pending');
  const rolledBack = await withTenantTransaction(tenantId, (db) => db.query(
    `SELECT o.status, p.stock_available, p.stock_reserved,
            NOT EXISTS (SELECT 1 FROM operational_actions WHERE company_id = o.company_id AND order_id = o.id) AS clean
     FROM customer_orders o JOIN order_items i ON i.company_id = o.company_id AND i.order_id = o.id
     JOIN products p ON p.company_id = i.company_id AND p.id = i.commercial_item_id
     WHERE o.company_id = $1 AND o.id = $2`,
    [tenantId, unavailableOrder]
  ));
  assert.deepEqual(rolledBack.rows, [{ status: 'pending_approval', stock_available: 1, stock_reserved: 0, clean: true }]);

  const mediaMessageId = `wamid.${randomUUID()}`;
  const document = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    messages: [{ id: mediaMessageId, from: chatId, type: 'document', document: {
      id: 'fixture-media-id', mime_type: 'application/pdf', filename: 'voucher-fixture.pdf',
    } }],
  } }] }] });
  assert.equal((await webhook(sign(document), 200, document)).results[0].duplicate, false);
  const uploadedMessage = await withTenantTransaction(owner.user.companyId, (db) => db.query(
    'SELECT id FROM messages WHERE company_id = $1 AND provider_message_id = $2', [owner.user.companyId, mediaMessageId]
  ));
  const fromMessage = await api(`${payments}/from-message`, 201, owner.accessToken, { messageId: uploadedMessage.rows[0].id });
  assert.equal(fromMessage.fileUrl, `/api/media/${mediaMessageId}`);
  assert.equal(fromMessage.chatId, chatId);
  assert.equal(fromMessage.mimeType, 'application/pdf');

  const documentId = uploadedMessage.rows[0].id;
  const uploadDir = process.env.PRODUCT_SMOKE_UPLOAD_DIR ?? config.whatsapp.uploadDir;
  const tenantMedia = path.join(uploadDir, 'tenants', String(owner.user.companyId), 'meta-cloud');
  const primaryPath = path.join(tenantMedia, `${randomUUID()}.pdf`);
  const secondaryPath = path.join(tenantMedia, `${randomUUID()}.png`);
  const primaryBytes = Buffer.from('%PDF-1.4\nfixture first attachment\n%%EOF\n');
  const secondaryBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  await mkdir(tenantMedia, { recursive: true });
  t.after(() => Promise.all([rm(primaryPath, { force: true }), rm(secondaryPath, { force: true })]));
  await Promise.all([writeFile(primaryPath, primaryBytes), writeFile(secondaryPath, secondaryBytes)]);
  const [primaryId, secondaryId] = await withTenantTransaction(owner.user.companyId, async (db) => {
    const first = await db.query(
      `UPDATE message_attachments SET internal_path=$2, size_bytes=$3, storage_status='downloaded'
       WHERE message_id=$1 RETURNING id`, [documentId, primaryPath, primaryBytes.length],
    );
    const second = await db.query(
      `INSERT INTO message_attachments (message_id, provider, provider_media_id, filename, mime_type, size_bytes, internal_path, storage_status)
       VALUES ($1, 'meta-cloud', $4, 'second-fixture.png', 'image/png', $2, $3, 'downloaded') RETURNING id`,
      [documentId, secondaryBytes.length, secondaryPath, String(documentId)],
    );
    return [first.rows[0].id, second.rows[0].id];
  });
  const attachmentPage = await api(`${canonicalPath}/messages?limit=1`, 200, owner.accessToken);
  const pagedDocument = conversationMessageV1Schema.parse(attachmentPage.items[0]);
  assert.equal(pagedDocument.id, String(documentId));
  assert.deepEqual(pagedDocument.attachments.map(({ id }) => id), [String(primaryId), String(secondaryId)]);
  assert.ok(attachmentPage.nextCursor);
  const olderPage = await api(`${canonicalPath}/messages?limit=1&cursor=${encodeURIComponent(attachmentPage.nextCursor)}`, 200, owner.accessToken);
  assert.ok(olderPage.items.every(({ id }: { id: string }) => id !== pagedDocument.id));

  const files = `${canonicalPath}/messages/${documentId}/attachments`;
  const downloadAttachment = (url: string, token?: string, range?: string) => fetch(`${base}${url}`, {
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(range && { Range: range }) },
  });
  for (const [attachmentId, expected, mimetype] of [[primaryId, primaryBytes, 'application/pdf'], [secondaryId, secondaryBytes, 'image/png']] as const) {
    const file = await downloadAttachment(`${files}/${attachmentId}`, owner.accessToken);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('cache-control'), 'private, no-store');
    assert.equal(file.headers.get('content-type'), mimetype);
    assert.match(file.headers.get('content-disposition') || '', /^attachment;/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
  }
  const partial = await downloadAttachment(`${files}/${primaryId}`, owner.accessToken, 'bytes=0-4');
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('cache-control'), 'private, no-store');
  assert.equal(partial.headers.get('content-range'), `bytes 0-4/${primaryBytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), primaryBytes.subarray(0, 5));
  const invalidRange = await downloadAttachment(`${files}/${primaryId}`, owner.accessToken, 'bytes=9999-');
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${primaryBytes.length}`);
  await api(`${files}/${primaryId}`, 401);
  await api(`${files}/${primaryId}`, 404, other.accessToken);
  await api(`${canonicalPath}/messages/${messagePage.items[0].id}/attachments/${primaryId}`, 404, owner.accessToken);
  await api(`${canonicalPath}/messages/${mediaMessageId}/attachments/${primaryId}`, 404, owner.accessToken);

  await withTenantTransaction(tenantId, (db) => db.query(
    `INSERT INTO operational_actions (company_id, contact_id, order_id, conversation_id, action_type, description)
     VALUES ($1, $2, $3, $4, 'history_smoke', 'Acción registrada')`,
    [tenantId, contactId, order, conversationId],
  ));
  const tagsRoot = '/api/tags';
  const tagsBefore = await api(tagsRoot, 200, owner.accessToken);
  const defaultTag = tagsBefore.find((tag: { is_default: boolean }) => tag.is_default);
  assert.equal(defaultTag.name, 'Todo');
  await api(tagsRoot, 403, employeeToken, { name: 'Operador sin permiso' });
  const createdTag = await api(tagsRoot, 200, owner.accessToken, { name: 'Seguimiento QA' });
  await api(tagsRoot, 409, owner.accessToken, { name: 'SEGUIMIENTO QA' });
  await api(`${tagsRoot}/${createdTag.id}`, 404, other.accessToken);
  const tagChats = `${tagsRoot}/${createdTag.id}/chats`;
  await api(tagChats, 404, owner.accessToken, { chatId: 'not-an-existing-chat' });
  await Promise.all([chatId, `${chatId}@c.us`].map((id) => api(tagChats, 200, owner.accessToken, { chatId: id })));
  assert.deepEqual(await api(tagChats, 200, owner.accessToken), [chatId]);
  const filteredChats = await api(`${tagChats}/full`, 200, owner.accessToken);
  assert.equal(filteredChats.length, 1);
  assert.equal(filteredChats[0].conversationId, String(conversationId));
  assert.equal(filteredChats[0].id, chatId);
  const tagUsers = `${tagsRoot}/${createdTag.id}/users`;
  await api(tagUsers, 404, owner.accessToken, { employeeId: other.user.id });
  await api(tagUsers, 200, owner.accessToken, { employeeId });
  const taggedUsers = await api(tagUsers, 200, owner.accessToken);
  assert.deepEqual(taggedUsers.map((user: { id: string }) => user.id), [String(employeeId)]);
  const tagStats = await api(`${tagsRoot}/${createdTag.id}/stats`, 200, owner.accessToken);
  assert.deepEqual(tagStats, { chat_count: 1, employee_count: 1 });
  const historyRoot = '/api/customer-history';
  const history = await api(`${historyRoot}/chats/${encodeURIComponent(chatId + '@c.us')}?messageLimit=1&conversationLimit=1`, 200, owner.accessToken);
  assert.equal(history.contact.id, contactId);
  assert.deepEqual(history.conversations.map((entry: { id: number }) => entry.id), [conversationId]);
  assert.equal(history.recentMessages.length, 1);
  assert.equal(history.recentMessages[0].providerMessageId, mediaMessageId);
  assert.equal(history.recentMessages[0].hasAttachments, true);
  assert.ok(history.tags.some((tag: { name: string }) => tag.name === 'Seguimiento QA'));
  assert.equal(history.orders[0].id, order);
  assert.equal(history.orders[0].items[0].quantity, 2);
  assert.equal(history.orders[0].stockMovements[0].movementType, 'reservation');
  assert.equal(history.actions[0].description, 'Acción registrada');
  const byContact = await api(`${historyRoot}/contacts/${contactId}?messageLimit=1000`, 200, employeeToken);
  assert.equal(byContact.contact.id, contactId);
  assert.equal(byContact.meta.messageLimit, 100);
  await api(`${historyRoot}/contacts/${contactId}`, 404, other.accessToken);
  await api(`${historyRoot}/chats/${chatId}`, 404, other.accessToken);
  await api(`${historyRoot}/chats/reference-${chatId}`, 404, owner.accessToken);

  const reports = '/api/reports';
  const calendarDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const period = `startDate=${calendarDay(-1)}&endDate=${calendarDay(1)}&timezone=UTC`;
  await api(`${reports}/metrics?${period}`, 403, employeeToken);
  await api(`${reports}/metrics?startDate=2026-02-31`, 400, owner.accessToken);
  const tagId = history.tags.find((tag: { name: string }) => tag.name === 'Seguimiento QA').id;
  const metrics = await api(`${reports}/metrics?${period}&tagId=${tagId}`, 200, owner.accessToken);
  assert.equal(metrics.totalChats, 1);
  assert.ok(metrics.totalMessages >= 2);
  assert.equal(metrics.topChats[0].chatId, chatId);
  const otherMetrics = await api(`${reports}/metrics?${period}`, 200, other.accessToken);
  assert.equal(otherMetrics.totalMessages, 0);
  assert.deepEqual(otherMetrics.topChats, []);
  const statsResult = await api(`${reports}/stats?${period}`, 200, owner.accessToken);
  assert.equal(statsResult.averageDaily, Math.round(statsResult.totalMessages / 3));
  const heatmapResult = await api(`${reports}/heatmap?${period}&tagId=${tagId}`, 200, owner.accessToken);
  assert.ok(heatmapResult.totalMessages >= 2);
  assert.equal(heatmapResult.days.length, 7);
  const reportResult = await api(`${reports}/operations?${period}&tagId=${tagId}&status=confirmed`, 200, owner.accessToken);
  assert.equal(reportResult.total, 1);
  assert.equal(reportResult.rows[0].orderId, order);
  assert.equal(reportResult.rows[0].totalQuantity, 2);
  const pageAfterLast = await api(`${reports}/operations?${period}&tagId=${tagId}&limit=1&offset=1`, 200, owner.accessToken);
  assert.equal(pageAfterLast.total, 1);
  assert.deepEqual(pageAfterLast.rows, []);
  const otherReport = await api(`${reports}/operations?${period}&tagId=${tagId}`, 200, other.accessToken);
  assert.equal(otherReport.total, 0);
  const download = async (format: string) => {
    const response = await fetch(`${base}${reports}/operations/export?${period}&tagId=${tagId}&format=${format}`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', new RegExp(`\\.${format}"$`));
    return response.text();
  };
  const csv = await download('csv');
  assert.ok(csv.includes(`"'=QA()"`));
  const xls = await download('xls');
  assert.ok(xls.includes('<Data ss:Type="String">=QA()</Data>'));
  assert.ok(xls.includes('Nota &lt;QA&gt;'));
  const reportChat = await api(`${reports}/chat/${encodeURIComponent(chatId + '@s.whatsapp.net')}/history`, 200, owner.accessToken);
  assert.ok(reportChat.messages.some((message: { id: string; hasMedia: boolean }) => message.id === mediaMessageId && message.hasMedia));
  await api(`${reports}/chat/${chatId}/history`, 404, other.accessToken);

  const remove = (path: string) => fetch(`${base}${path}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal((await remove(`${tagChats}/${encodeURIComponent(chatId + '@s.whatsapp.net')}`)).status, 200);
  assert.equal((await remove(`${tagUsers}/${employeeId}`)).status, 200);
  assert.deepEqual(await api(tagChats, 200, owner.accessToken), []);
  assert.deepEqual(await api(tagUsers, 200, owner.accessToken), []);
  assert.equal((await remove(`${tagsRoot}/${defaultTag.id}`)).status, 400);
  assert.equal((await remove(`${tagsRoot}/${createdTag.id}`)).status, 200);
  await api(`${tagsRoot}/${createdTag.id}`, 404, owner.accessToken);

  const stationPath = `/api/auth/employees/${employeeId}`;
  const updateStation = (data: object, accessToken = owner.accessToken) => fetch(`${base}${stationPath}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const renewStation = (refreshToken: string, status: number) => api('/api/auth/refresh', status, undefined, { refreshToken });
  assert.equal((await updateStation({ nombre: 'Operador actualizado', email: station.email })).status, 200);
  await renewStation(stationSession.refreshToken, 200);
  assert.equal((await updateStation({ password: randomUUID() }, other.accessToken)).status, 404);
  await renewStation(stationSession.refreshToken, 200);
  const nextPassword = randomUUID();
  const employeeRevoked = invalidation(employeeSocket);
  const [changed, concurrentLogin] = await Promise.all([
    updateStation({ password: nextPassword }),
    fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: station.email, password: tempPassword }) }),
  ]);
  assert.equal(changed.status, 200);
  assert.equal(await employeeRevoked, 'revoked');
  assert.equal((await api('/api/auth/me', 401, employeeToken)).code, 'SESSION_REVOKED');
  assert.ok([200, 401].includes(concurrentLogin.status));
  if (concurrentLogin.ok) await renewStation((await concurrentLogin.json()).data.refreshToken, 401);
  await renewStation(stationSession.refreshToken, 401);
  const currentStation = await api('/api/auth/login', 200, undefined, { email: station.email, password: nextPassword });
  await renewStation(currentStation.refreshToken, 200);
  assert.equal((await updateStation({ email: `${randomUUID()}@example.invalid` })).status, 200);
  assert.equal((await updateStation({ email: station.email })).status, 200);
  await renewStation(currentStation.refreshToken, 401);
  const lastStation = await api('/api/auth/login', 200, undefined, { email: station.email, password: nextPassword });
  assert.equal((await remove(stationPath)).status, 200);
  await renewStation(lastStation.refreshToken, 401);
  const { rows: [revocations] } = await withTenantTransaction(owner.user.companyId, (db) => db.query(
    'SELECT bool_and(revocado) AS revoked FROM refresh_tokens WHERE usuario_id = $1', [employeeId],
  ));
  assert.equal(revocations.revoked, true);

  const disconnected = invalidation(ownerSocket);
  const listeners = await pool.query(`
    SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = 'whatsap-session-monitor'
  `);
  assert.ok(listeners.rowCount && listeners.rows.every(({ terminated }) => terminated));
  assert.equal(await disconnected, undefined);
  assert.equal((await api('/api/auth/me', 200, owner.accessToken)).companyId, owner.user.companyId);
  const recoveredSocket = await connect(owner.accessToken);
  t.after(() => { recoveredSocket.disconnect(); });
});
