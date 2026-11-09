import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  deliveryLabel, inboxActor, messageProblem, resolveCanonicalChat, sendCanonicalText, takeConversationControl,
} from '../factures/mensajeria/services/canonicalConversationApi';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

function mockResponse(context: TestContext, respond: (request: InternalAxiosRequestConfig) => { data: unknown; status: number }) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => ({
    ...respond(request), statusText: 'Fixture', headers: {}, config: request,
  });
  context.after(() => { api.defaults.adapter = original; });
}

const actor = { id: '15', tenantId: '27' };
const conversation = {
  id: '321', tenantId: actor.tenantId, externalConversationId: '51999999999',
  channel: 'whatsapp-cloud', status: 'open', stateVersion: 4, assignedUserId: null,
  assignedAgentId: 'agent-1', aiPaused: false, serviceWindowExpiresAt: '2026-12-01T12:00:00.000Z',
};

test('the Inbox resolves external chat identity before verifying its tenant-owned state', async (context) => {
  let tenantId = actor.tenantId;
  mockResponse(context, (request) => {
    if (request.url === '/chats/51999999999/session/status') return { status: 200, data: { success: true, conversationId: '321' } };
    assert.equal(request.url, '/v1/conversations/321');
    return { status: 200, data: { ...conversation, tenantId } };
  });
  const signal = new AbortController().signal;
  assert.deepEqual(inboxActor({ id: 15, companyId: 27, rol: 'EMPLEADO' }), actor);
  assert.deepEqual(await resolveCanonicalChat('51999999999', undefined, actor, signal), conversation);
  tenantId = '28';
  await assert.rejects(resolveCanonicalChat('51999999999', '321', actor, signal), /esta empresa/);
});

test('takeover must confirm the requested version and the exact same signed operator', async (context) => {
  let assignedUserId = actor.id;
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/conversations/321/takeover');
    assert.deepEqual(JSON.parse(request.data), { expectedVersion: 4 });
    return { status: 200, data: { ...conversation, stateVersion: 5, assignedUserId, assignedAgentId: null, aiPaused: true } };
  });
  assert.equal((await takeConversationControl(conversation, actor)).assignedUserId, actor.id);
  assignedUserId = '17';
  await assert.rejects(takeConversationControl(conversation, actor), /tu sesión/);
});

test('exact text retries keep their request key and version and require an actual provider receipt', async (context) => {
  const intent = { key: 'inbox-fixture-1', conversationId: '321', version: 5, text: '  Texto exacto\n' };
  const receipt = { accepted: true, providerMessageId: 'wamid.fixture', deliveryState: 'provider_accepted' };
  const data = { ...receipt };
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/conversations/321/messages');
    assert.equal(request.headers.get('Idempotency-Key'), intent.key);
    assert.deepEqual(JSON.parse(request.data), { expectedConversationVersion: 5, message: { kind: 'text', text: intent.text } });
    return { status: 202, data };
  });
  assert.deepEqual(await sendCanonicalText(intent), { kind: 'accepted', deliveryState: 'provider_accepted' });
  assert.equal(deliveryLabel('provider_accepted'), 'Aceptado por WhatsApp');
  assert.equal(deliveryLabel('delivered'), 'Entregado');
  data.providerMessageId = '';
  assert.equal((await sendCanonicalText(intent)).kind, 'unknown');
  data.accepted = false;
  data.deliveryState = 'failed';
  assert.equal((await sendCanonicalText(intent)).kind, 'failed');
});

test('transport uncertainty is separate from a definitive stale-state rejection', () => {
  assert.equal(messageProblem(new AxiosError('Network Error')).uncertain, true);
  const response = {
    status: 409, statusText: 'Conflict', config: {} as InternalAxiosRequestConfig, headers: {},
    data: { metadata: { reasonCode: 'CONVERSATION_VERSION_CHANGED' } },
  };
  const problem = messageProblem(new AxiosError('Conflict', undefined, undefined, undefined, response));
  assert.equal(problem.uncertain, false);
  assert.match(problem.message, /La conversación cambió/);
});
