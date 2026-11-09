import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHmac, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { sendMessageResultV1Schema } from '@whatsap-automat/contracts';
import express, { type Request } from 'express';
import { AutomatClient } from '../../../packages/sdk/src';
import { Pool } from 'pg';
import config from '../config/index';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createConversationV1Routes from '../routes/conversationV1Routes';
import createMetaWebhookRoutes from '../routes/metaWebhookRoutes';
import { ConversationSendService } from '../services/conversations/ConversationSendService';
import { ConversationQueryService } from '../services/conversations/ConversationQueryService';
import { ConversationCasService } from '../services/conversations/ConversationCasService';
import WhatsAppService from '../services/whatsappService';
import MetaAccountStore from '../services/whatsapp/meta/MetaAccountStore';
import { MetaCloudClient } from '../services/whatsapp/meta/MetaCloudClient';
import { MetaInboxStore } from '../services/whatsapp/meta/MetaInboxStore';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.CONVERSATION_SEND_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 700_000_000);
const tenantB = tenantA + 1;
const actor = randomInt(700_000_000, 800_000_000);
const appSecret = 'fixture-only-signature-secret';

function token(tenantId: number, userId = actor, rol = 'EMPLEADO', secret = process.env.JWT_SECRET!) {
  return jwt.sign({ companyId: tenantId, userId, rol }, secret);
}

async function listen(t: TestContext, server: Server) {
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function api(
  t: TestContext, sender?: ConversationSendService, webhookService?: WhatsAppService, query?: ConversationQueryService,
) {
  const app = express();
  app.use(express.json({
    verify(req, _res, buf) { (req as Request & { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use('/api/v1/conversations', createConversationV1Routes(sender, query));
  if (webhookService) app.use('/api/webhooks/meta/whatsapp', createMetaWebhookRoutes(webhookService));
  return listen(t, app.listen(0, '127.0.0.1'));
}

async function send(
  url: string, conversationId: number, key: string, version: number, access?: string, text = 'Hola desde la bandeja',
  kind = 'text',
) {
  const response = await fetch(`${url}/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'idempotency-key': key,
      ...(access ? { authorization: `Bearer ${access}` } : {}),
    },
    body: JSON.stringify({ expectedConversationVersion: version, message: { kind, text } }),
  });
  const body = await response.json();
  if (response.status === 202) sendMessageResultV1Schema.parse(body);
  return { status: response.status, body };
}

async function signedWebhook(
  url: string, phoneId: string, content: Record<string, unknown>, secret = appSecret,
) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, ...content } }] }],
  });
  return fetch(`${url}/api/webhooks/meta/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

test('canonical send rejects unauthorized and unsupported requests before reserving', async (t) => {
  const url = await api(t);
  assert.equal((await send(url, 1, 'valid', 1)).status, 401);
  assert.equal((await send(url, 1, 'valid', 1, token(tenantA, actor, 'EMPLEADO', 'forged-test-key'))).status, 401);
  assert.equal((await send(url, 1, 'valid', 1, token(tenantA, actor, 'READ_ONLY'))).status, 403);
  assert.equal((await send(url, 1, 'bad key', 1, token(tenantA))).status, 422);
  const unsupported = await send(url, 1, 'valid', 1, token(tenantA), 'fixture', 'template');
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.metadata.reasonCode, 'MESSAGE_KIND_UNSUPPORTED');
});

test('durable CAS sends one Graph POST per intent and reconciles authenticated receipts without retrying uncertainty', {
  skip: !connectionString && 'CONVERSATION_SEND_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const accounts = new MetaAccountStore(db);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'conversation_send_claims'::regclass
  `);
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, async (sql) => {
      await sql.query("INSERT INTO companies (id, name) VALUES ($1, 'Test sender')", [tenantId]);
      await sql.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Test sender', $2)", [tenantId, `send-${tenantId}`]);
      await sql.query(`
        INSERT INTO usuarios (id, company_id, nombre, email, password_hash)
        VALUES ($1, $2, 'Fixture Operator', $3, 'fixture-unused-hash')
      `, [tenantId === tenantA ? actor : actor + 1, tenantId, `operator-${tenantId}@invalid.test`]);
    });
  }
  const phoneA = `178${tenantA}`;
  const phoneB = `178${tenantB}`;
  const secondPhone = `179${tenantA}`;
  const missingCredential = `177${tenantA}`;
  const tenantToken = 'fixture-whatsapp-encrypted-token';
  for (const [tenantId, phoneNumberId, accessToken] of [
    [tenantA, phoneA, tenantToken], [tenantB, phoneB, 'fixture-other-tenant-token'],
    [tenantA, secondPhone, 'fixture-second-account-token'], [tenantA, missingCredential, null],
  ] as const) {
    await accounts.upsertConnection(tenantId, { phoneNumberId, accessToken, graphVersion: 'v25.0' });
  }
  const originalProvider = config.whatsapp.provider;
  const originalSecret = config.meta.appSecret;
  config.whatsapp.provider = 'meta-cloud';
  config.meta.appSecret = appSecret;
  t.after(() => { config.whatsapp.provider = originalProvider; config.meta.appSecret = originalSecret; });

  const webhook = Object.assign(Object.create(WhatsAppService.prototype) as WhatsAppService, {
    provider: 'meta-cloud',
    metaClient: new MetaCloudClient({ appSecret, phoneNumberId: phoneA, accessToken: '', graphVersion: 'v25.0' }),
    metaStore: true,
    metaAccountStore: accounts,
    getMetaStore: (tenantId: number) => new MetaInboxStore({ companyId: tenantId, db }),
    logAgentRuntime: async () => {},
    maybeAutoReplyWithAgent: async () => {},
  });

  type GraphRequest = { url?: string; method?: string; auth?: string; body: Record<string, any> };
  const graphRequests: GraphRequest[] = [];
  let reply = (_request: GraphRequest, response: ServerResponse): void => {
    response.end(JSON.stringify({ messages: [{ id: 'wamid.test-default' }] }));
  };
  const graph = await listen(t, createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const capture = {
      url: request.url, method: request.method, auth: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    graphRequests.push(capture);
    response.setHeader('Content-Type', 'application/json');
    reply(capture, response);
  }).listen(0, '127.0.0.1'));
  const fetchGraph: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://graph.facebook.com');
    return fetch(`${graph}${target.pathname}${target.search}`, init);
  };
  const sender = () => new ConversationSendService(uow, accounts, true, fetchGraph);
  const url = await api(t, sender(), webhook, new ConversationQueryService(uow));
  const accessA = token(tenantA);
  const accessB = token(tenantB, actor + 1);
  const now = () => String(Math.floor(Date.now() / 1000));
  let inboundCount = 0;
  async function inbound(phone: string, recipient: string, timestamp = now()) {
    const response = await signedWebhook(url, phone, {
      messages: [{ id: `wamid.inbound-${tenantA}-${++inboundCount}`, from: recipient, timestamp, type: 'text', text: { body: 'Fixture inbound' } }],
    });
    assert.equal(response.status, 200, await response.text());
  }
  async function conversation(tenantId: number, recipient: string, owner: number | null = actor): Promise<number> {
    return uow.run(tenantId, async (sql) => {
      const { rows: [record] } = await sql.query(`
        UPDATE conversations SET owner_type = $3, owner_id = $4
        WHERE company_id = $1 AND external_conversation_id = $2 RETURNING id
      `, [tenantId, recipient, owner === null ? 'ai_agent' : 'human', owner === null ? null : String(owner)]);
      return record.id;
    });
  }
  const recipient = '12025550101';
  await inbound(phoneA, recipient);
  const id = await conversation(tenantA, recipient, null);
  const missingTakeover = await send(url, id, 'takeover-required', 1, accessA);
  assert.equal(missingTakeover.status, 403);
  assert.equal(missingTakeover.body.metadata.reasonCode, 'HUMAN_TAKEOVER_REQUIRED');
  const takeover = await new ConversationCasService(uow).takeoverConversation({
    tenantId: tenantA, conversationId: id, userId: actor, expectedVersion: 1,
  });
  const version = takeover.newVersion;
  assert.equal(version, 2);

  const stale = await send(url, id, 'stale-version', 0, accessA);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.metadata.reasonCode, 'CONVERSATION_VERSION_CHANGED');
  assert.equal((await send(url, id, 'another-tenant', 1, accessB)).status, 404);

  await inbound(phoneA, '12025550102', String(Number(now()) - 86_401));
  const closedId = await conversation(tenantA, '12025550102');
  assert.equal((await send(url, closedId, 'closed-window', 1, accessA)).body.metadata.reasonCode, 'SERVICE_WINDOW_CLOSED');
  await inbound(phoneA, '12025550103');
  await inbound(secondPhone, '12025550103');
  const ambiguousId = await conversation(tenantA, '12025550103');
  assert.equal((await send(url, ambiguousId, 'ambiguous-account', 1, accessA)).body.metadata.reasonCode, 'SENDING_ACCOUNT_UNVERIFIED');
  await inbound(missingCredential, '12025550104');
  const unavailableId = await conversation(tenantA, '12025550104');
  assert.equal((await send(url, unavailableId, 'missing-tenant-credential', 1, accessA)).body.metadata.reasonCode, 'SENDING_ACCOUNT_UNAVAILABLE');
  assert.equal(graphRequests.length, 0);

  const started = new Promise<ServerResponse>((resolve) => { reply = (_request, response) => resolve(response); });
  const pending = send(url, id, 'first-intent', version, accessA);
  const graphResponse = await Promise.race([started, pending.then((response) => {
    throw new Error(`Expected loopback Graph request, got ${JSON.stringify(response)}`);
  })]);
  t.after(() => graphResponse.destroy());
  const { rows: [claimed] } = await uow.run(tenantA, (sql) => sql.query(`
    SELECT state, actor_id, expected_version, phone_number_id FROM conversation_send_claims WHERE request_key = 'first-intent'
  `));
  assert.deepEqual(claimed, { state: 'unknown_delivery', actor_id: actor, expected_version: version, phone_number_id: phoneA });
  assert.equal((await db.query('SELECT request_key FROM conversation_send_claims')).rowCount, 0);
  assert.equal((await send(url, id, 'first-intent', version, accessA)).body.deliveryState, 'unknown_delivery');
  assert.equal((await send(url, id, 'first-intent', version, accessA, 'Changed text')).body.metadata.reasonCode, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal((await send(url, id, 'first-intent', version + 1, accessA)).body.metadata.reasonCode, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal((await send(url, id, 'first-intent', version, token(tenantA, actor + 1))).body.metadata.reasonCode, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal((await send(url, unavailableId, 'first-intent', version, accessA)).body.metadata.reasonCode, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal((await send(url, id, 'parallel-distinct-key', version, accessA)).body.metadata.reasonCode, 'CONVERSATION_VERSION_CHANGED');
  assert.equal((await send(url, id, 'new-key-while-unknown', version + 1, accessA)).body.metadata.reasonCode, 'DELIVERY_UNRESOLVED');

  const providerId = 'wamid.test-early-callback';
  const status = (state: string) => ({ statuses: [{ id: providerId, status: state, timestamp: now(), recipient_id: recipient }] });
  assert.equal((await signedWebhook(url, phoneA, status('read'), 'invalid-secret')).status, 403);
  const early = await signedWebhook(url, phoneA, status('delivered'));
  assert.equal(early.status, 200, await early.text());
  graphResponse.end(JSON.stringify({ messages: [{ id: providerId }] }));
  const acknowledged = await pending;
  assert.deepEqual(acknowledged, { status: 202, body: {
    providerMessageId: providerId, accepted: true, rawStatus: 'delivered', deliveryState: 'delivered',
  } });
  const firstCallback = graphRequests[0].body.biz_opaque_callback_data;
  assert.match(firstCallback, /^automat:[a-f0-9-]{36}$/);
  assert.deepEqual(graphRequests, [{
    url: `/v25.0/${phoneA}/messages`, method: 'POST', auth: `Bearer ${tenantToken}`,
    body: {
      messaging_product: 'whatsapp', to: recipient, type: 'text', biz_opaque_callback_data: firstCallback,
      text: { preview_url: false, body: 'Hola desde la bandeja' },
    },
  }]);
  for (const [phone, state] of [[secondPhone, 'read'], [phoneA, 'sent'], [phoneA, 'read'], [phoneA, 'failed']]) {
    const response = await signedWebhook(url, phone, status(state));
    assert.equal(response.status, 200, await response.text());
    const expected = state === 'read' && phone === phoneA || state === 'failed' ? 'read' : 'delivered';
    assert.equal((await send(url, id, 'first-intent', version, accessA)).body.deliveryState, expected);
  }

  const { rows: [stored] } = await uow.run(tenantA, (sql) => sql.query(`
    SELECT m.body, m.provider_message_id, m.status, c.version,
      ARRAY(SELECT s.status FROM message_statuses s WHERE s.message_id = m.id ORDER BY s.id) AS statuses
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.company_id = $1 AND m.client_request_id = 'first-intent'
  `, [tenantA]));
  assert.deepEqual(stored, {
    body: 'Hola desde la bandeja', provider_message_id: providerId, status: 'read', version: version + 1,
    statuses: ['accepted', 'delivered', 'sent', 'read', 'failed'],
  });

  const messageUrl = `${url}/api/v1/conversations/${id}/messages`;
  const read = (path: string) => fetch(path, { headers: { authorization: `Bearer ${accessA}` } });
  const history = await read(`${messageUrl}?limit=1`);
  assert.equal(history.status, 200);
  const page = await history.json();
  assert.deepEqual(page.items[0].causedBy, { type: 'human', id: String(actor) });
  assert.equal(page.items[0].connectionId, `wa-meta-${tenantA}-${phoneA}`);
  assert.equal(page.items[0].deliveryState, 'read');
  const previous = await (await read(`${messageUrl}?limit=1&cursor=${page.nextCursor}`)).json();
  assert.equal(previous.items[0].direction, 'inbound');
  assert.equal(previous.items[0].causedBy.type, 'customer');
  assert.equal(previous.items[0].connectionId, `legacy:${tenantA}:whatsapp-cloud`);

  reply = (_request, response) => {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: { code: 131030, message: 'fixture rejection' } }));
  };
  const rejected = await send(url, id, 'definitive-rejection', version + 1, accessA);
  assert.equal(rejected.body.deliveryState, 'failed');
  assert.deepEqual(await send(url, id, 'definitive-rejection', version + 1, accessA), rejected);

  reply = (_request, response) => { response.end('{}'); };
  const missingAck = await send(url, id, 'missing-provider-ack', version + 2, accessA);
  assert.equal(missingAck.body.deliveryState, 'unknown_delivery');
  const conversationUrl = `${url}/api/v1/conversations/${id}`;
  const exactHistoryUrl = `${messageUrl}?limit=1&clientRequestId=missing-provider-ack`;
  assert.equal((await (await read(conversationUrl)).json()).hasUnresolvedDelivery, true);
  assert.equal((await (await read(exactHistoryUrl)).json()).items[0].deliveryState, 'unknown_delivery');
  assert.equal((await read(`${messageUrl}?clientRequestId=invalid%20key`)).status, 422);
  assert.equal((await fetch(exactHistoryUrl, { headers: { authorization: `Bearer ${accessB}` } })).status, 404);
  const sessionStatus = new MetaInboxStore({ companyId: tenantA, db });
  assert.equal((await sessionStatus.getServiceWindowStatus(recipient)).hasUnresolvedDelivery, true);
  const restarted = await api(t, sender());
  const sdk = new AutomatClient({ baseUrl: `${restarted}/api/v1`, token: accessA });
  assert.deepEqual(await sdk.conversations.sendText(String(id), 'Hola desde la bandeja', version + 2, 'missing-provider-ack'), missingAck.body);
  assert.equal((await send(restarted, id, 'blind-retry-new-key', version + 3, accessA)).body.metadata.reasonCode, 'DELIVERY_UNRESOLVED');

  const recoveredId = 'wamid.test-recovered-without-ack';
  const callback = graphRequests[2].body.biz_opaque_callback_data;
  assert.notEqual(callback, firstCallback);
  const receipt = {
    id: recoveredId, status: 'delivered', timestamp: now(), recipient_id: recipient, biz_opaque_callback_data: callback,
  };
  assert.equal((await signedWebhook(url, phoneA, { statuses: [receipt] }, 'invalid-secret')).status, 403);
  for (const [phone, modified] of [
    [phoneA, { biz_opaque_callback_data: firstCallback }],
    [secondPhone, {}],
    [phoneB, {}],
    [phoneA, { recipient_id: '12025550999' }],
    [phoneA, { timestamp: String(Number(now()) - 3_600) }],
  ] as const) {
    assert.equal((await signedWebhook(url, phone, { statuses: [{ ...receipt, ...modified }] })).status, 200);
  }
  assert.deepEqual(await send(restarted, id, 'missing-provider-ack', version + 2, accessA), missingAck);
  const correlated = await signedWebhook(url, phoneA, { statuses: [receipt] });
  assert.equal(correlated.status, 200, await correlated.text());
  assert.equal((await (await signedWebhook(url, phoneA, { statuses: [receipt] })).json()).results[0].duplicate, true);
  assert.deepEqual(await sdk.conversations.sendText(String(id), 'Hola desde la bandeja', version + 2, 'missing-provider-ack'), {
    providerMessageId: recoveredId, accepted: true, rawStatus: 'delivered', deliveryState: 'delivered',
  });
  assert.equal((await (await read(conversationUrl)).json()).hasUnresolvedDelivery, false);
  assert.equal((await sessionStatus.getServiceWindowStatus(recipient)).hasUnresolvedDelivery, false);
  const recoveredHistory = await (await read(exactHistoryUrl)).json();
  assert.equal(recoveredHistory.items[0].deliveryState, 'delivered');
  assert.equal(recoveredHistory.items[0].clientRequestId, 'missing-provider-ack');
  assert.deepEqual((await (await read(`${messageUrl}?clientRequestId=no-such-attempt`)).json()).items, []);
  assert.equal(JSON.stringify(recoveredHistory).includes(callback), false);
  assert.equal(graphRequests.length, 3);

  const postRecoveryStarted = new Promise<ServerResponse>((resolve) => { reply = (_request, response) => resolve(response); });
  const postRecovery = send(restarted, id, 'new-intent-after-recovery', version + 3, accessA);
  const postRecoveryResponse = await Promise.race([postRecoveryStarted, postRecovery.then((result) => {
    throw new Error(`Expected a new Graph request after reconciliation, got ${JSON.stringify(result)}`);
  })]);
  t.after(() => postRecoveryResponse.destroy());
  const postRecoveryId = 'wamid.test-post-recovery';
  assert.equal((await signedWebhook(url, phoneA, { statuses: [{
    ...receipt, id: postRecoveryId, status: 'sent', biz_opaque_callback_data: graphRequests[3].body.biz_opaque_callback_data,
  }] })).status, 200);
  postRecoveryResponse.end(JSON.stringify({ messages: [{ id: postRecoveryId }] }));
  assert.equal((await postRecovery).body.deliveryState, 'dispatched');

  await inbound(phoneB, '12025550105');
  const tenantBId = await conversation(tenantB, '12025550105', actor + 1);
  reply = (_request, response) => { response.destroy(); };
  const networkLoss = await send(url, tenantBId, 'missing-provider-ack', 1, accessB);
  assert.equal(networkLoss.body.deliveryState, 'unknown_delivery');
  assert.deepEqual(await send(restarted, tenantBId, 'missing-provider-ack', 1, accessB), networkLoss);
  assert.equal(graphRequests.length, 5);
  assert.equal(graphRequests[4].auth, 'Bearer fixture-other-tenant-token');
});
