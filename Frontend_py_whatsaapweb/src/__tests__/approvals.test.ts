import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  currentApprovalSession, decideApproval, isSensitiveApproval, listApprovals, readApproval, type Approval, type DecisionIntent,
} from '../factures/dashboard/approvals/approvalApi';

let session = 'approval-session-a';
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: (key: string) => key === 'refreshToken' ? session : null },
});
const approval: Approval = {
  id: 'appr_fixture', tenantId: '4', runId: 'run-1', nodeId: 'send', policyVersion: 2, risk: 'send',
  status: 'pending', createdAt: '2026-11-09T12:00:00Z', expiresAt: '2026-11-10T12:00:00Z',
};

function respond(context: TestContext, response: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (config) => ({ data: response(config), status: 200, statusText: 'OK', headers: {}, config });
  context.after(() => { api.defaults.adapter = original; });
}

test('sensitive approval risk includes outbound, financial and irreversible effects', () => {
  assert.deepEqual((['high', 'send', 'financial', 'destructive'] as const).map(isSensitiveApproval), [true, true, true, true]);
  assert.deepEqual((['low', 'medium', 'read', 'write'] as const).map(isSensitiveApproval), [false, false, false, false]);
});

test('approval queue uses the real pending filter and rejects an unexpected tenant or status', async (context) => {
  let items = [approval];
  const { signal } = new AbortController();
  respond(context, (request) => {
    assert.equal(request.url, '/v1/approvals');
    assert.equal(request.signal, signal);
    assert.deepEqual(request.params, { status: 'pending', offset: 20, limit: 20, risk: 'send' });
    return items;
  });
  assert.deepEqual(await listApprovals('4', 20, 'send', signal), [approval]);
  items = [{ ...approval, tenantId: '8' }];
  await assert.rejects(listApprovals('4', 20, 'send', signal), /no confirmó la cola/);
  items = [{ ...approval, status: 'expired' }];
  await assert.rejects(listApprovals('4', 20, 'send', signal), /no confirmó la cola/);
});

test('approval detail requires the requested identifier and workspace', async (context) => {
  let item = { ...approval, status: 'expired' as const };
  respond(context, (request) => {
    assert.equal(request.url, '/v1/approvals/appr_fixture');
    return item;
  });
  const { signal } = new AbortController();
  assert.deepEqual(await readApproval(approval.id, '4', signal), item);
  item = { ...item, id: 'appr_other' };
  await assert.rejects(readApproval(approval.id, '4', signal), /no confirmó esta solicitud/);
});

test('a retry preserves its exact decision intent and stops when the session changes', async (context) => {
  const intent: DecisionIntent = {
    approvalId: approval.id, decision: 'rejected', expectedVersion: 2, key: 'stable-key', reason: 'Razón revisada',
  };
  let returnedStatus = 'rejected';
  let requests = 0;
  respond(context, (request) => {
    requests += 1;
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/approvals/appr_fixture/decision');
    assert.equal(request.headers.get('Idempotency-Key'), 'stable-key');
    assert.deepEqual(JSON.parse(request.data), { decision: 'rejected', expectedVersion: 2, reason: 'Razón revisada' });
    return { approvalId: approval.id, status: returnedStatus, decidedAt: '2026-11-09T12:01:00Z' };
  });
  const originalGeneration = currentApprovalSession()!;
  const expected = await decideApproval(intent, originalGeneration);
  assert.deepEqual(await decideApproval(intent, originalGeneration), expected);
  returnedStatus = 'approved';
  await assert.rejects(decideApproval(intent, originalGeneration), /no confirmó la decisión/);
  session = 'approval-session-b';
  context.after(() => { session = 'approval-session-a'; });
  await assert.rejects(decideApproval(intent, originalGeneration), /La sesión cambió/);
  assert.equal(requests, 3);
});
