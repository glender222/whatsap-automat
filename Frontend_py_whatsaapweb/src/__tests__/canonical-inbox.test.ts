import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  deliveryLabel, inboxActor, messageProblem, readCanonicalHistory, readPublishedWhatsappSuggestion, resolveCanonicalChat, sendCanonicalAttachment,
  sendCanonicalText, takeConversationControl,
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

test('published suggestions accept catalog evidence only when it belongs to the requested conversation', async (context) => {
  const evidence = { profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1', evidenceHash: 'b'.repeat(64) };
  const linear = { runId: '42424242-4242-4242-8242-424242424242', graphId: 'fixture', version: 2, specHash: 'a'.repeat(64),
    inboundMessageId: '12', conversationId: conversation.id, reply: 'Catálogo', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const catalog = { ...linear, ...evidence };
  const signal = new AbortController().signal;
  let suggestion: unknown = catalog;
  mockResponse(context, (request) => {
    assert.equal(request.url, '/v1/ai/whatsapp-suggestions');
    assert.deepEqual(request.params, { conversationId: conversation.id });
    assert.equal(request.signal, signal);
    return { status: 200, data: { suggestion } };
  });
  const read = () => readPublishedWhatsappSuggestion(conversation.id, signal, 0);
  assert.deepEqual(await read(), catalog);
  suggestion = linear;
  assert.deepEqual(await read(), linear);
  for (const invalid of [{ evidenceHash: 'b' }, { evidenceVersion: 'catalog-evaluation-v1' }, { profile: undefined }, { conversationId: '322' }]) {
    suggestion = { ...catalog, ...invalid };
    await assert.rejects(read(), /no confirmó la sugerencia/);
  }
  suggestion = { ...catalog, expiresAt: '2000-01-01T00:00:00Z' };
  assert.equal(await read(), null);
});

test('the legacy file route requires an explicitly identified Web.js chat', async (context) => {
  let reason: string | undefined = 'legacy_webjs';
  mockResponse(context, (request) => {
    assert.equal(request.url, '/chats/51999999999%40c.us/session/status');
    return { status: 200, data: { success: true, reason } };
  });
  const signal = new AbortController().signal;
  assert.equal(await resolveCanonicalChat('51999999999@c.us', undefined, actor, signal), null);
  reason = undefined;
  await assert.rejects(resolveCanonicalChat('51999999999@c.us', undefined, actor, signal), /identidad de envío verificable/);
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

test('attachment retries keep the same File, caption, flags, version and key in the canonical multipart request', async (context) => {
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'fixture.pdf', { type: 'application/pdf' });
  const intent = { key: 'attachment-key', conversationId: '321', version: 5, caption: '  Pie exacto\n', forceDocument: true, file };
  let receipt: { accepted: boolean; providerMessageId: string | null; deliveryState: string } =
    { accepted: true, providerMessageId: 'wamid.fixture-file', deliveryState: 'provider_accepted' };
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    assert.equal(request.url, '/v1/conversations/321/messages/attachments');
    assert.equal(request.headers.get('Idempotency-Key'), intent.key);
    assert.equal(request.headers.get('Content-Type'), 'multipart/form-data');
    assert.ok(request.data instanceof FormData);
    assert.equal(request.data.get('file'), file);
    assert.deepEqual([...request.data.entries()].filter(([field]) => field !== 'file'), [
      ['message', intent.caption], ['forceDocument', 'true'], ['expectedConversationVersion', '5'],
    ]);
    return { status: 202, data: receipt };
  });
  assert.deepEqual(await sendCanonicalAttachment(intent), { kind: 'accepted', deliveryState: 'provider_accepted' });
  receipt = { accepted: false, providerMessageId: null, deliveryState: 'unknown_delivery' };
  assert.deepEqual(await sendCanonicalAttachment(intent), { kind: 'unknown', deliveryState: 'unknown_delivery' });
  receipt = { accepted: false, providerMessageId: null, deliveryState: 'failed' };
  assert.deepEqual(await sendCanonicalAttachment(intent), { kind: 'failed', deliveryState: 'failed' });
  receipt = { ...receipt, accepted: true };
  assert.equal((await sendCanonicalAttachment(intent)).kind, 'unknown');
});

test('attachment rejection 413 and 422 are definitive and provide a next action', () => {
  for (const [status, expected] of [[413, /archivo más pequeño/], [422, /formato y el pie/]] as const) {
    const response = { status, statusText: 'Fixture', config: {} as InternalAxiosRequestConfig, headers: {}, data: {} };
    const problem = messageProblem(new AxiosError('Fixture', undefined, undefined, undefined, response), 'attachment');
    assert.equal(problem.uncertain, false);
    assert.match(problem.message, expected);
  }
  const response = {
    status: 422, statusText: 'Fixture', config: {} as InternalAxiosRequestConfig, headers: {},
    data: { metadata: { reasonCode: 'ATTACHMENT_CAPTION_UNSUPPORTED' } },
  };
  const problem = messageProblem(new AxiosError('Fixture', undefined, undefined, undefined, response), 'attachment');
  assert.equal(problem.uncertain, false);
  assert.match(problem.message, /Los audios no admiten pie/);
});

test('recovery queries the canonical history by clientRequestId outside the latest page', async (context) => {
  const item = {
    id: 'older', conversationId: conversation.id, tenantId: actor.tenantId, direction: 'outbound',
    deliveryState: 'delivered', clientRequestId: 'attachment-key', causedBy: { type: 'human' },
  };
  mockResponse(context, (request) => {
    assert.equal(request.url, '/v1/conversations/321/messages');
    assert.deepEqual(request.params, { limit: 1, clientRequestId: 'attachment-key' });
    return { status: 200, data: { items: [item] } };
  });
  assert.deepEqual(await readCanonicalHistory(conversation, new AbortController().signal, 'attachment-key'), [item]);
});
