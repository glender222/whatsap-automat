import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  draftSpec, exampleGraph, getGraphDraft, graphPath, graphProblem, listGraphDrafts, saveGraphDraft, validateGraphDraft,
  type GraphDraft, type GraphValidation,
} from '../components/agent-studio/canonical/agentGraphApi';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

function mockResponse(context: TestContext, respond: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => ({
    data: respond(request), status: 200, statusText: 'OK', headers: {}, config: request,
  });
  context.after(() => { api.defaults.adapter = original; });
}

const draft: GraphDraft = {
  ...exampleGraph, schemaVersion: 1, graphId: 'nuevo', tenantId: '27', version: 1, status: 'draft', specHash: 'a'.repeat(64),
};

test('Agent Studio reads catalog pages and immutable revisions from the canonical API', async (context) => {
  mockResponse(context, (request) => {
    assert.equal(request.method, 'get');
    if (request.url === '/v1/agent-graphs') {
      assert.deepEqual(request.params, { after: 'anterior', limit: 12 });
      return { items: [draft], nextAfter: null };
    }
    assert.equal(request.url, '/v1/agent-graphs/nuevo');
    assert.deepEqual(request.params, { version: 2 });
    return { ...draft, version: 2 };
  });
  const signal = new AbortController().signal;
  assert.deepEqual((await listGraphDrafts('anterior', signal)).items, [draft]);
  assert.equal((await getGraphDraft(draft.graphId, 2, signal)).version, 2);
  assert.equal(graphPath('nuevo'), '/dashboard/ia/estudio/grafos/nuevo');
});

test('new drafts and appended revisions send only the editable specification', async (context) => {
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    if (request.url === '/v1/agent-graphs') {
      assert.deepEqual(JSON.parse(request.data), { ...exampleGraph, graphId: 'nuevo' });
      return draft;
    }
    assert.equal(request.url, '/v1/agent-graphs/nuevo/revisions');
    assert.deepEqual(JSON.parse(request.data), exampleGraph);
    return { ...draft, version: 2 };
  });
  assert.equal((await saveGraphDraft('nuevo', { ...draftSpec(draft) }, 'create')).version, 1);
  assert.equal((await saveGraphDraft('nuevo', { ...exampleGraph }, 'revision')).version, 2);
});

test('lint is bound to the saved revision and never treats evidence as publication', async (context) => {
  const report: GraphValidation = {
    graphId: draft.graphId, version: 1, specHash: draft.specHash, scope: 'structural',
    publicationEvidence: false, valid: false, issues: [{ severity: 'error', code: 'MISSING_ENTRY', message: 'Missing', nodeId: 'start' }],
  };
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/agent-graphs/nuevo/validate');
    assert.deepEqual(request.params, { version: 1 });
    return report;
  });
  const signal = new AbortController().signal;
  assert.equal((await validateGraphDraft(draft, signal)).issues[0].code, 'MISSING_ENTRY');
  report.specHash = 'other-hash';
  await assert.rejects(validateGraphDraft(draft, signal), /no confirmó una validación estructural/);
});

test('a 422 response exposes field names and explanations from the canonical validator', async (context) => {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => {
    throw new AxiosError('Validation failed', undefined, request, undefined, {
      status: 422, statusText: 'Unprocessable Content', config: request, headers: {},
      data: { invalidParams: [{ name: 'limits.maxSteps', reason: 'Must be positive' }] },
    });
  };
  context.after(() => { api.defaults.adapter = original; });
  await assert.rejects(saveGraphDraft('nuevo', {}, 'create'), (cause) => {
    assert.deepEqual(graphProblem(cause, 'Error'), {
      message: 'El servidor rechazó campos del borrador.',
      fields: [{ name: 'limits.maxSteps', reason: 'Must be positive' }],
    });
    return true;
  });
});
