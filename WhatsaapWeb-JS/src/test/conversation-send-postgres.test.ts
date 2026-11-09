import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHmac, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  app.use('/api/v1/conversations', createConversationV1Routes(sender, query, webhookService));
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

async function sendAttachment(
  url: string, conversationId: number, key: string, version: number, access?: string,
  options: { bytes?: string; filename?: string; mime?: string; caption?: string; forceDocument?: string } = {},
) {
  const body = new FormData();
  body.append('file', new Blob([options.bytes ?? 'Fixture attachment'], { type: options.mime ?? 'text/plain' }),
    options.filename ?? 'cotización.txt');
  body.append('expectedConversationVersion', String(version));
  if (options.caption !== undefined) body.append('message', options.caption);
  if (options.forceDocument !== undefined) body.append('forceDocument', options.forceDocument);
  const response = await fetch(`${url}/api/v1/conversations/${conversationId}/messages/attachments`, {
    method: 'POST',
    headers: { 'idempotency-key': key, ...(access ? { authorization: `Bearer ${access}` } : {}) },
    body,
  });
  const result = await response.json();
  if (response.status === 202) sendMessageResultV1Schema.parse(result);
  return { status: response.status, body: result };
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

test('durable CAS sends one Graph POST per text or attachment intent and reconciles signed receipts', {
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
  const originalUploadDir = config.multer.dest;
  const originalCacheDir = config.whatsapp.uploadDir;
  const uploadDir = await mkdtemp(join(tmpdir(), 'canonical-attachment-'));
  config.whatsapp.provider = 'meta-cloud';
  config.meta.appSecret = appSecret;
  config.multer.dest = uploadDir;
  config.whatsapp.uploadDir = join(uploadDir, 'downloads');
  t.after(async () => {
    config.whatsapp.provider = originalProvider;
    config.meta.appSecret = originalSecret;
    config.multer.dest = originalUploadDir;
    config.whatsapp.uploadDir = originalCacheDir;
    await rm(uploadDir, { recursive: true, force: true });
  });

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
  const mediaRequests: GraphRequest[] = [];
  let reply: (request: GraphRequest, response: ServerResponse) => void | Promise<void> = (_request, response) => {
    response.end(JSON.stringify({ messages: [{ id: 'wamid.test-default' }] }));
  };
  let uploadReply = (_request: GraphRequest, response: ServerResponse): void | Promise<void> => {
    response.end(JSON.stringify({ id: `fixture-media-${mediaRequests.length}` }));
  };
  const graph = await listen(t, createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const capture = { url: request.url, method: request.method, auth: request.headers.authorization };
    const bytes = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/media')) {
      const form = await new Response(new Uint8Array(bytes), {
        headers: { 'content-type': request.headers['content-type'] ?? '' },
      }).formData();
      const file = form.get('file');
      assert.ok(file instanceof File);
      const upload = { ...capture, body: {
        bytes: await file.text(), filename: file.name, type: file.type,
        messagingProduct: form.get('messaging_product'), declaredType: form.get('type'),
      } };
      mediaRequests.push(upload);
      await uploadReply(upload, response);
    } else {
      const message = { ...capture, body: JSON.parse(bytes.toString()) };
      graphRequests.push(message);
      await reply(message, response);
    }
  }).listen(0, '127.0.0.1'));
  const fetchGraph: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://graph.facebook.com');
    assert.equal(init?.redirect, 'error');
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

  await t.test('multipart replays exact bytes, rejects stale or foreign sends, and recovers lost acknowledgement', async () => {
    const attachmentRecipient = '12025550106';
    await inbound(phoneA, attachmentRecipient);
    const attachmentId = await conversation(tenantA, attachmentRecipient);
    const attachment = { caption: 'Fixture caption', forceDocument: 'true' };
    const perform = (key: string, expectedVersion = 1, input = attachment, access = accessA) =>
      sendAttachment(url, attachmentId, key, expectedVersion, access, input);
    assert.equal((await sendAttachment(url, attachmentId, 'unauthenticated', 1)).status, 401);
    assert.equal((await perform('read-only', 1, attachment, token(tenantA, actor, 'READ_ONLY'))).status, 403);
    assert.equal((await perform('another-operator', 1, attachment, token(tenantA, actor + 1))).body.metadata.reasonCode,
      'HUMAN_TAKEOVER_REQUIRED');
    assert.equal((await perform('another-tenant', 1, attachment, accessB)).status, 404);
    assert.equal((await perform('stale-attachment', 0)).body.metadata.reasonCode, 'CONVERSATION_VERSION_CHANGED');
    assert.equal((await sendAttachment(url, closedId, 'expired-attachment', 1, accessA)).body.metadata.reasonCode,
      'SERVICE_WINDOW_CLOSED');
    assert.equal((await sendAttachment(url, attachmentId, 'unsupported-attachment', 1, accessA,
      { mime: 'text/html' })).body.metadata.reasonCode, 'ATTACHMENT_TYPE_UNSUPPORTED');
    assert.equal((await perform('malformed-attachment', 1, { ...attachment, forceDocument: 'yes' })).status, 422);
    assert.equal(mediaRequests.length, 0);

    // Rotate the actual scoped credential after preflight but before upload returns.
    uploadReply = async (_request, response) => {
      await accounts.upsertConnection(tenantA, { phoneNumberId: phoneA, accessToken: 'fixture-rotated-token', graphVersion: 'v25.0' });
      response.end(JSON.stringify({ id: 'media-old-account' }));
    };
    const accountChanged = await perform('rotating-account');
    assert.equal(accountChanged.status, 409);
    assert.equal(accountChanged.body.metadata.reasonCode, 'SENDING_ACCOUNT_CHANGED');
    assert.equal(graphRequests.length, 5);

    // A provider upload with no media acknowledgement can be retried safely.
    uploadReply = (_request, response) => { response.destroy(); };
    const unavailable = await perform('attachment-key');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.metadata.reasonCode, 'ATTACHMENT_UPLOAD_UNAVAILABLE');
    assert.equal(graphRequests.length, 5);

    let observedAttachment: Record<string, unknown> | undefined;
    let observedForeignAttachment: unknown[] | undefined;
    uploadReply = (_request, response) => { response.end(JSON.stringify({ id: `fixture-media-${mediaRequests.length}` })); };
    reply = async (request, response) => {
      const rowsForTenant = (tenantId: number) => uow.run(tenantId, async (sql) => (await sql.query(`
        SELECT a.provider_media_id, a.filename, a.mime_type, a.caption, m.message_type, m.status
        FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.provider_media_id = $1
      `, [request.body.document.id])).rows);
      [observedAttachment] = await rowsForTenant(tenantA);
      observedForeignAttachment = await rowsForTenant(tenantB);
      // The provider may have accepted the recipient message before closing its socket.
      response.destroy();
    };
    const [first, concurrent] = await Promise.all([perform('attachment-key'), perform('attachment-key')]);
    assert.deepEqual(first, concurrent);
    assert.equal(first.status, 202);
    assert.equal(first.body.deliveryState, 'unknown_delivery');
    assert.equal(graphRequests.length, 6);
    assert.ok(mediaRequests.length === 3 || mediaRequests.length === 4);
    const sendRequest = graphRequests[5];
    const mediaId = sendRequest.body.document.id;
    assert.deepEqual(observedAttachment, {
      provider_media_id: mediaId, filename: 'cotización.txt', mime_type: 'text/plain', caption: 'Fixture caption',
      message_type: 'document', status: 'unknown_delivery',
    });
    assert.deepEqual(observedForeignAttachment, []);
    assert.equal(sendRequest.url, `/v25.0/${phoneA}/messages`);
    assert.equal(sendRequest.auth, 'Bearer fixture-rotated-token');
    assert.deepEqual(sendRequest.body, {
      messaging_product: 'whatsapp', to: attachmentRecipient, type: 'document',
      biz_opaque_callback_data: sendRequest.body.biz_opaque_callback_data,
      document: { id: mediaId, caption: 'Fixture caption', filename: 'cotización.txt' },
    });
    assert.match(sendRequest.body.biz_opaque_callback_data, /^automat:[a-f0-9-]{36}$/);
    assert.deepEqual(mediaRequests.at(-1), {
      url: `/v25.0/${phoneA}/media`, method: 'POST', auth: 'Bearer fixture-rotated-token',
      body: { bytes: 'Fixture attachment', filename: 'cotización.txt', type: 'text/plain',
        messagingProduct: 'whatsapp', declaredType: 'text/plain' },
    });
    const uploadsAfterDispatch = mediaRequests.length;
    for (const changed of [
      { bytes: 'Changed bytes' }, { filename: 'changed.txt' }, { mime: 'application/pdf' },
      { caption: 'Changed caption' }, { forceDocument: 'false' },
    ]) {
      const mismatch = await perform('attachment-key', 1, { ...attachment, ...changed });
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.body.metadata.reasonCode, 'IDEMPOTENCY_KEY_CONFLICT');
    }
    assert.equal((await send(url, attachmentId, 'attachment-key', 1, accessA)).body.metadata.reasonCode,
      'IDEMPOTENCY_KEY_CONFLICT');
    assert.deepEqual(await sendAttachment(restarted, attachmentId, 'attachment-key', 1, accessA, attachment), first);
    assert.equal((await perform('unsafe-new-key', 2)).body.metadata.reasonCode, 'DELIVERY_UNRESOLVED');
    assert.equal(mediaRequests.length, uploadsAfterDispatch);

    const mediaReceipt = {
      id: 'wamid.attachment-recovered', status: 'delivered', timestamp: now(), recipient_id: attachmentRecipient,
      biz_opaque_callback_data: sendRequest.body.biz_opaque_callback_data,
    };
    assert.equal((await signedWebhook(url, phoneA, { statuses: [mediaReceipt] }, 'invalid')).status, 403);
    assert.equal((await signedWebhook(url, phoneB, { statuses: [mediaReceipt] })).status, 200);
    assert.deepEqual(await perform('attachment-key'), first);
    const delivered = await signedWebhook(url, phoneA, { statuses: [mediaReceipt] });
    assert.equal(delivered.status, 200, await delivered.text());
    assert.deepEqual(await sendAttachment(restarted, attachmentId, 'attachment-key', 1, accessA, attachment), {
      status: 202, body: { providerMessageId: mediaReceipt.id, accepted: true, rawStatus: 'delivered', deliveryState: 'delivered' },
    });
    const history = await fetch(`${url}/api/v1/conversations/${attachmentId}/messages?clientRequestId=attachment-key`, {
      headers: { authorization: `Bearer ${accessA}` },
    });
    const item = (await history.json()).items[0];
    assert.equal(item.deliveryState, 'delivered');
    assert.equal(item.attachments[0].filename, 'cotización.txt');
    assert.equal(item.attachments[0].mimeType, 'text/plain');
    assert.equal(graphRequests.length, 6);
    assert.equal(mediaRequests.length, uploadsAfterDispatch);
    for (let check = 0; check < 20 && (await readdir(uploadDir)).length > 0; check++) await delay(10);
    assert.deepEqual(await readdir(uploadDir), []);

    const inboundRecipient = '12025550113';
    const inboundId = `wamid.inbound-media-${tenantA}`;
    const inboundMediaId = `inbound-media-${tenantA}`;
    const inboundResponse = await signedWebhook(url, secondPhone, {
      messages: [{
        id: inboundId, from: inboundRecipient, timestamp: now(), type: 'image',
        image: { id: inboundMediaId, mime_type: 'image/png' },
      }],
    });
    assert.equal(inboundResponse.status, 200, await inboundResponse.text());
    const inboundConversationId = await conversation(tenantA, inboundRecipient);
    const inboundHistory = await fetch(`${url}/api/v1/conversations/${inboundConversationId}/messages`, {
      headers: { authorization: `Bearer ${accessA}` },
    });
    assert.equal(inboundHistory.status, 200);
    const inboundItem = (await inboundHistory.json()).items[0];
    assert.equal(inboundItem.direction, 'inbound');
    assert.equal(inboundItem.attachments[0].mimeType, 'image/png');
    const outboundMediaId = sendRequest.body.document.id as string;
    const downloads = new Map([
      [outboundMediaId, { phone: phoneA, token: 'fixture-rotated-token', body: 'Fixture attachment', mime: 'text/plain' }],
      [inboundMediaId, { phone: secondPhone, token: 'fixture-second-account-token', body: 'Fixture image bytes', mime: 'image/png' }],
    ]);
    const nativeFetch = globalThis.fetch;
    const downloadGraph = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(input));
      if (target.origin === 'https://graph.facebook.com') {
        const mediaId = target.pathname.split('/').at(-1)!;
        const fixture = downloads.get(mediaId);
        assert.ok(fixture);
        assert.equal(target.searchParams.get('phone_number_id'), fixture.phone);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fixture.token}`);
        return Response.json({ url: `https://lookaside.fbsbx.com/${mediaId}` });
      }
      if (target.origin === 'https://lookaside.fbsbx.com') {
        const fixture = downloads.get(target.pathname.slice(1));
        assert.ok(fixture);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fixture.token}`);
        return new Response(fixture.body, { headers: { 'Content-Type': fixture.mime } });
      }
      return nativeFetch(input, init);
    });
    const mediaPath = (conversationId: number, message: typeof item) =>
      `${url}/api/v1/conversations/${conversationId}/messages/${message.id}/attachments/${message.attachments[0].id}`;
    const authorized = { headers: { authorization: `Bearer ${accessA}` } };
    const outgoingPath = mediaPath(attachmentId, item);
    const incomingPath = mediaPath(inboundConversationId, inboundItem);
    const outgoing = await nativeFetch(outgoingPath, authorized);
    assert.equal(outgoing.status, 200);
    assert.match(outgoing.headers.get('content-type') ?? '', /^text\/plain\b/);
    assert.equal(await outgoing.text(), 'Fixture attachment');
    const foreign = await nativeFetch(incomingPath, { headers: { authorization: `Bearer ${accessB}` } });
    assert.equal(foreign.status, 404);
    assert.equal(downloadGraph.mock.callCount(), 2);

    await uow.run(tenantA, (sql) => sql.query(
      "UPDATE whatsapp_business_accounts SET status = 'disconnected' WHERE company_id = $1 AND phone_number_id = $2",
      [tenantA, secondPhone],
    ));
    assert.equal((await nativeFetch(incomingPath, authorized)).status, 503);
    assert.equal(downloadGraph.mock.callCount(), 2);
    await accounts.upsertConnection(tenantA, { phoneNumberId: secondPhone, accessToken: 'fixture-second-account-token' });
    const incoming = await nativeFetch(incomingPath, authorized);
    assert.equal(incoming.status, 200);
    assert.equal(incoming.headers.get('content-type'), 'image/png');
    assert.equal(await incoming.text(), 'Fixture image bytes');
    assert.equal(await (await nativeFetch(outgoingPath, authorized)).text(), 'Fixture attachment');
    assert.equal(downloadGraph.mock.callCount(), 4);
    downloadGraph.mock.restore();
  });
});
