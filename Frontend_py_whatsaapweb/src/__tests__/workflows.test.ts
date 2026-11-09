import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  createWorkflowWebhook, disableWorkflowWebhook, getWorkflowRun, publishWorkflow, validateWorkflow, workflowStatus,
} from '../components/workflows/workflowApi';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

function mockResponse(context: TestContext, respond: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => ({
    data: { success: true, data: respond(request) },
    status: 200, statusText: 'OK', headers: {}, config: request,
  });
  context.after(() => { api.defaults.adapter = original; });
}

test('workflow validation is separate from publishing a precise saved revision', async (context) => {
  const spec = { dagGraph: { nodes: [], edges: [] }, limits: {} };
  let publishedRevisionId = 'rev_1';
  mockResponse(context, (request) => {
    if (request.url === '/v1/workflows/validate') {
      assert.deepEqual(JSON.parse(request.data), spec);
      return { nodeCount: 2, edgeCount: 1 };
    }
    assert.equal(request.url, '/v1/workflows/wf_1/publish');
    assert.deepEqual(JSON.parse(request.data), { revisionId: 'rev_1' });
    return { workflowId: 'wf_1', publishedRevisionId, status: 'published' };
  });
  assert.equal((await validateWorkflow(spec)).nodeCount, 2);
  await publishWorkflow('wf_1', 'rev_1');
  publishedRevisionId = 'rev_2';
  await assert.rejects(publishWorkflow('wf_1', 'rev_1'), /no confirmó qué revisión/);
});

test('webhook creation requires a confirmed token and disabling verifies the returned state', async (context) => {
  let secret = 'local-fixture';
  let isActive = false;
  mockResponse(context, (request) => {
    if (request.method === 'post') {
      assert.equal(request.url, '/v1/workflows/wf_1/triggers/webhook');
      return { id: 'tr_1', workflowId: 'wf_1', endpointKey: 'opaque', token: secret };
    }
    assert.equal(request.method, 'patch');
    assert.equal(request.url, '/v1/workflows/wf_1/triggers/tr_1');
    assert.deepEqual(JSON.parse(request.data), { isActive: false });
    return { id: 'tr_1', workflowId: 'wf_1', isActive };
  });
  assert.equal((await createWorkflowWebhook('wf_1')).token, secret);
  secret = '';
  await assert.rejects(createWorkflowWebhook('wf_1'), /no confirmó el webhook/);
  await disableWorkflowWebhook('wf_1', 'tr_1');
  isActive = true;
  await assert.rejects(disableWorkflowWebhook('wf_1', 'tr_1'), /no confirmó la desactivación/);
});

test('run inspection preserves queued and completed states returned by PostgreSQL', async (context) => {
  const run = { id: 'run_1', revisionId: 'rev_1', status: 'queued', stepCount: 0 };
  mockResponse(context, (request) => {
    assert.equal(request.url, '/v1/workflows/runs/run_1');
    return run;
  });
  const signal = new AbortController().signal;
  assert.equal(workflowStatus((await getWorkflowRun('run_1', signal)).status), 'En cola');
  run.status = 'completed';
  assert.equal(workflowStatus((await getWorkflowRun('run_1', signal)).status), 'Completada');
  run.id = 'wrong_run';
  await assert.rejects(getWorkflowRun('run_1', signal), /no confirmó la ejecución/);
});
