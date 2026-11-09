import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  dispatchLabel, executionStatuses, listExecutions, validWorkflowFilter,
  type ExecutionPage, type ExecutionRecord,
} from '../pages/Admin/operationExecutionsApi';

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'fixture-admin-token' } });
const execution: ExecutionRecord = {
  id: 'run-123', workflowId: 'workflow-123', workflowRunId: 'run-123', revisionId: 'rev-1', triggerType: 'webhook',
  status: 'queued', recordedAt: '2026-11-08T00:00:00.000200Z', completedAt: null, stepCount: 0,
  failureCode: null, dispatchEvidence: 'recorded',
  dispatch: {
    status: 'delivery_unknown', retryCount: 2, maxRetries: 5, nextRetryAt: '2026-11-08T01:06:00.000Z',
    leaseExpiresAt: null, updatedAt: '2026-11-08T01:05:00.000Z',
  },
};
const response: ExecutionPage = {
  items: [execution], nextCursor: 'fixture-cursor', pageSummary: { retryCount: 2, deliveryUnknownCount: 1 },
};

function withResponse(context: TestContext, read: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => ({
    data: read(request), status: 200, statusText: 'OK', headers: {}, config: request,
  });
  context.after(() => { api.defaults.adapter = original; });
}

test('passes only supported filters and an opaque cursor to the administrator endpoint', async (context) => {
  const signal = new AbortController().signal;
  withResponse(context, (request) => {
    assert.equal(request.url, '/v1/operations/executions');
    assert.equal(request.method, 'get');
    assert.equal(request.signal, signal);
    assert.equal(request.headers.get('Authorization'), 'Bearer fixture-admin-token');
    assert.deepEqual(request.params, { workflowId: 'workflow-123', status: 'queued', limit: 20, cursor: 'cursor-by-api' });
    return response;
  });
  assert.deepEqual(await listExecutions({ workflowId: 'workflow-123', status: 'queued' }, 'cursor-by-api', signal), response);
  assert.equal(validWorkflowFilter('workflow_123-abc'), true);
  assert.equal(validWorkflowFilter('otro%tenant'), false);
  assert.equal(executionStatuses.some((status: string) => status === 'timed_out'), false);
});

test('keeps absent, conflicting and unconfirmed dispatch evidence distinct', () => {
  assert.equal(dispatchLabel(execution), 'Despacho sin confirmar');
  assert.equal(dispatchLabel({ ...execution, dispatchEvidence: 'missing', dispatch: null }), 'Sin registro de despacho');
  assert.equal(dispatchLabel({ ...execution, dispatchEvidence: 'ambiguous', dispatch: null }), 'Registros de despacho en conflicto');
});

test('rejects malformed pagination or dispatch evidence instead of displaying a successful list', async (context) => {
  let payload: unknown = { ...response, nextCursor: '?cursor=injected' };
  withResponse(context, () => payload);
  const query = () => listExecutions({ workflowId: '', status: '' }, null, new AbortController().signal);
  await assert.rejects(query(), /listado de ejecuciones incompleto/);
  payload = { ...response, items: [{ ...execution, dispatch: null }] };
  await assert.rejects(query(), /listado de ejecuciones incompleto/);
});
