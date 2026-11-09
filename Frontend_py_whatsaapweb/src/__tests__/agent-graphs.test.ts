import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  compareGraphSpecs, draftSpec, exampleGraph, getGraphDraft, graphFixtureProblem, graphPath, graphProblem, listGraphDrafts, saveGraphDraft,
  simulateGraphDraft, validateGraphDraft, type GraphDraft, type GraphFixtureResult, type GraphValidation,
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

test('revision comparison ignores object key order and detects ordered graph changes', () => {
  const previous = { ...exampleGraph, nodes: [{ ...exampleGraph.nodes[0], config: { a: 1, b: 2 } }] };
  const same = { ...previous, nodes: [{ ...previous.nodes[0], config: { b: 2, a: 1 } }] };
  assert.deepEqual(compareGraphSpecs(previous, same), []);
  const next = { ...same, policyRef: 'otra-politica', nodes: [...same.nodes, exampleGraph.nodes[1]] };
  const changes = compareGraphSpecs(previous, next);
  assert.deepEqual(changes.map(({ key }) => key), ['policyRef', 'nodes']);
  assert.match(changes[0].after, /otra-politica/);
  assert.match(changes[1].after, /"id": "fin"/);
});

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

test('simulation posts the saved revision and test input and confirms its immutable fixture identity', async (context) => {
  const signal = new AbortController().signal;
  const fixture: GraphFixtureResult = {
    graphId: draft.graphId, graphVersion: draft.version, specHash: draft.specHash, mode: 'fixture',
    publicationEvidence: false, finalState: 'completed', totalSteps: 2,
    executedNodes: [
      { nodeId: 'inicio', kind: 'agent', output: { text: 'Prueba' }, durationMs: 1 },
      { nodeId: 'fin', kind: 'end', output: { state: 'completed' }, durationMs: 1 },
    ],
    simulatedMessages: [{ kind: 'text', text: 'Prueba' }], approvalsTriggered: [], failureReasons: [],
  };
  let response: unknown = fixture;
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/agent-graphs/nuevo/simulate');
    assert.equal(request.signal, signal);
    assert.deepEqual(JSON.parse(request.data), { graphVersion: 1, mockInput: 'Mensaje de prueba' });
    return response;
  });
  assert.deepEqual(await simulateGraphDraft(draft, 'Mensaje de prueba', signal), fixture);
  for (const invalid of [
    { graphVersion: 2 }, { specHash: 'b'.repeat(64) }, { publicationEvidence: true },
    { totalSteps: 3 }, { executedNodes: [{ ...fixture.executedNodes[0], nodeId: 'desconocido' }, fixture.executedNodes[1]] },
  ]) {
    response = { ...fixture, ...invalid };
    await assert.rejects(simulateGraphDraft(draft, 'Mensaje de prueba', signal), /no confirmó una simulación de prueba/);
  }
});

test('structurally invalid revisions point the operator to the saved revision validator', async (context) => {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => {
    throw new AxiosError('Validation failed', undefined, request, undefined, {
      status: 422, statusText: 'Unprocessable Content', config: request, headers: {},
      data: { detail: 'The stored revision has structural errors. Use the validate endpoint for details.' },
    });
  };
  context.after(() => { api.defaults.adapter = original; });
  await assert.rejects(simulateGraphDraft(draft, 'Mensaje de prueba', new AbortController().signal), (cause) => {
    assert.match(graphFixtureProblem(cause).message, /errores estructurales.*Validar esta revisión/);
    return true;
  });
});
