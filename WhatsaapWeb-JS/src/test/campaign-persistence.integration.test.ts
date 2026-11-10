import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

test('campaign API persists scoped drafts, real counts, suppression and acknowledged delivery', {
  skip: process.env.CAMPAIGN_SMOKE !== '1' && 'Use a dedicated migrated *_smoke database and set CAMPAIGN_SMOKE=1',
  timeout: 120000,
}, async (context) => {
  const { default: config } = await import('../config');
  const { default: pool } = await import('../config/database');
  const { TenantScopedUoW, tenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { default: createRoutes } = await import('../routes/campaigns.routes');
  const { CampaignDispatcher } = await import('../services/campaigns/CampaignDispatcher');
  const { ConsentService } = await import('../services/campaigns/ConsentService');
  const { SegmentationService } = await import('../services/campaigns/SegmentationService');
  const { EmailAdapter } = await import('../services/channels/EmailAdapter');
  const { default: MetaAccountStore } = await import('../services/whatsapp/meta/MetaAccountStore');
  const { MetaInboxStore } = await import('../services/whatsapp/meta/MetaInboxStore');
  const { default: WhatsAppService } = await import('../services/whatsappService');
  const { default: createMetaWebhookRoutes } = await import('../routes/metaWebhookRoutes');

  assert.match(config.database.name, /_smoke$/);
  assert.equal(config.database.host, '127.0.0.1');
  context.after(() => pool.end());
  const role = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });

  const suffix = randomUUID();
  async function createTenant(name: string) {
    const company = await pool.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
    const id = Number(company.rows[0].id);
    await tenantScopedUoW.run(id, (client) => client.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
      [id, name, `${name}-${suffix}`],
    ));
    return id;
  }

  const tenant = await createTenant('Campaign QA');
  const other = await createTenant('Other campaign QA');
  const token = (companyId: number, role: string) => jwt.sign({ userId: 1, companyId, rol: role }, config.jwt.secret);
  const connectionId = `smtp-${suffix}`;
  const emails = [`opt-in-${suffix}@example.invalid`, `opt-out-${suffix}@example.invalid`];
  const contacts: number[] = [];
  await tenantScopedUoW.run(tenant, async (client) => {
    await client.query(
      "INSERT INTO channel_connections (id, tenant_id, channel, account_id) VALUES ($1, $2, 'email', $1)",
      [connectionId, tenant],
    );
    const tag = await client.query("INSERT INTO tags (company_id, name) VALUES ($1, 'Oferta') RETURNING id", [tenant]);
    for (let index = 0; index < 3; index++) {
      const externalId = `5198757${index}123`;
      const contact = await client.query(
        `INSERT INTO contacts (company_id, channel, external_contact_id, phone, metadata_json)
         VALUES ($1, 'whatsapp', $2, $2, $3::jsonb) RETURNING id`,
        [tenant, externalId, JSON.stringify({ email: emails[index] })],
      );
      const contactId = Number(contact.rows[0].id);
      contacts.push(contactId);
      await client.query(
        "INSERT INTO conversations (company_id, channel, external_conversation_id, contact_id) VALUES ($1, 'whatsapp', $2, $3)",
        [tenant, externalId, contactId],
      );
      await client.query(
        'INSERT INTO tag_chats (company_id, tag_id, chat_id) VALUES ($1, $2, $3)',
        [tenant, tag.rows[0].id, externalId],
      );
    }
  });

  let providerEntered!: () => void;
  const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
  let allowProvider!: () => void;
  const release = new Promise<void>((resolve) => { allowProvider = resolve; });
  const addressed: string[] = [];
  const adapter = new EmailAdapter({
    customSmtpSender: async (_mime, destination) => {
      addressed.push(destination);
      providerEntered();
      await release;
      return { providerMessageId: 'smoke-provider-ack', rawResponse: '250 SMTP fixture' };
    },
  });
  const consent = new ConsentService();
  const segments = new SegmentationService();
  const dispatcher = new CampaignDispatcher(tenantScopedUoW, consent, segments, {
    skipPacingDelay: true, channelAdapters: new Map([['email', adapter]]),
  });
  const app = express();
  const metaSecret = 'campaign-local-signed-receipt-fixture';
  const originalProvider = config.whatsapp.provider;
  const originalMetaSecret = config.meta.appSecret;
  config.whatsapp.provider = 'meta-cloud';
  config.meta.appSecret = metaSecret;
  context.after(() => { config.whatsapp.provider = originalProvider; config.meta.appSecret = originalMetaSecret; });
  app.use(express.json({ verify: (req, _res, buf) => { Object.assign(req, { rawBody: buf }); } }));
  app.use('/api/v1', createRoutes({ dispatcher, consent, segments }));
  app.use('/production', createRoutes());
  app.use('/api/webhooks/meta/whatsapp', createMetaWebhookRoutes(new WhatsAppService()));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => {
    allowProvider();
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function receipt(phone: string, status: Record<string, unknown>, secret = metaSecret, expected = 200) {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: phone }, statuses: [status],
    } }] }] });
    const response = await fetch(`${base}/api/webhooks/meta/whatsapp`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    }, body: raw });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  const now = () => String(Math.floor(Date.now() / 1000));

  function sendRequest(path: string, companyId: number, body?: unknown, role = 'ADMIN') {
    return fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token(companyId, role)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function request(path: string, companyId: number, status: number, body?: unknown) {
    const response = await sendRequest(path, companyId, body);
    const data = await response.json();
    assert.equal(response.status, status, `${path}: ${data.error ?? response.statusText}`);
    return data;
  }

  const segmentInput = { name: 'Oferta por correo', targetChannel: 'email', criteria: {
    combinator: 'AND', rules: [{ field: 'tag', operator: 'equals', value: 'Oferta' }],
  } };
  const { data: segment } = await request('/api/v1/segments', tenant, 201, segmentInput);
  await request('/api/v1/segments', tenant, 409, segmentInput);
  await request('/api/v1/segments', tenant, 400, { ...segmentInput, name: 'Mal formado', criteria: {
    combinator: 'OR', rules: [{ field: 'tag', operator: 'lt', value: 'Oferta' }],
  } });
  const calculated = await request(`/api/v1/segments/${segment.id}/calculate`, tenant, 200, {});
  assert.equal(calculated.data.count, 2);
  assert.equal((await new SegmentationService().getSegment(tenant, segment.id))?.calculatedCount, 2);
  assert.equal((await request(`/api/v1/segments/${segment.id}/recipients`, tenant, 200)).data.length, 2);
  await request(`/api/v1/segments/${segment.id}`, other, 404);

  const campaignInput = { name: 'Campaña de QA', channel: 'email', connectionId,
    segmentId: segment.id, contentBody: 'Contenido de QA', purpose: 'marketing' };
  const { data: campaign } = await request('/api/v1/campaigns', tenant, 201, campaignInput);
  assert.equal(campaign.status, 'draft');
  assert.equal((await new CampaignDispatcher().getCampaign(tenant, campaign.id))?.name, campaignInput.name);
  assert.deepEqual((await request('/api/v1/campaigns', other, 200)).data, []);
  await request('/api/v1/campaigns', other, 404, campaignInput);
  await request(`/production/campaigns/${campaign.id}/dispatch`, tenant, 409, {});

  for (let index = 0; index < emails.length; index++) {
    await request('/api/v1/consent', tenant, 201, {
      contactId: contacts[index], channelType: 'email', destination: emails[index],
      purpose: 'marketing', status: index === 0 ? 'opted_in' : 'opted_out', evidenceType: 'manual',
    });
  }

  const deliveryPath = `/api/v1/campaigns/${campaign.id}/dispatch`;
  const setConnectionStatus = (status: string) => tenantScopedUoW.run(tenant, (client) => client.query(
    'UPDATE channel_connections SET status = $1 WHERE id = $2',
    [status, connectionId],
  ));
  await setConnectionStatus('inactive');
  await request(deliveryPath, tenant, 409, {});
  assert.deepEqual(addressed, []);
  await setConnectionStatus('active');
  const run = request(deliveryPath, tenant, 200, {});
  await Promise.race([entered, run.then(() => { throw new Error('The adapter was never invoked'); })]);
  await request(deliveryPath, tenant, 409, {});
  allowProvider();
  const completed = (await run).data;
  assert.deepEqual(addressed, [emails[0]]);
  assert.equal(completed.statsDispatched, 1);
  assert.equal(completed.statsSuppressed, 1);
  assert.equal(completed.status, 'completed');
  const deliveries = await new CampaignDispatcher().getDeliveries(campaign.id, tenant);
  assert.equal(deliveries.find(({ destination }) => destination === emails[0])?.providerMessageId, 'smoke-provider-ack');
  assert.equal(deliveries.find(({ destination }) => destination === emails[1])?.status, 'suppressed');
  const hidden = await pool.query('SELECT id FROM campaign_deliveries WHERE campaign_id = $1', [campaign.id]);
  assert.equal(hidden.rows.length, 0);

  const metaPhoneId = String(10n ** 14n + BigInt(`0x${suffix.replaceAll('-', '').slice(0, 10)}`));
  const otherMetaPhoneId = String(BigInt(metaPhoneId) + 1n);
  const fixtureToken = 'campaign-smoke-local-meta-token';
  const orphanConnection = `wa-orphan-${suffix}`;
  await tenantScopedUoW.run(tenant, async (client) => {
    await client.query(
      `INSERT INTO channel_connections (id, tenant_id, channel, account_id, credentials_encrypted)
       VALUES ($1, $2, 'whatsapp-cloud', $3, '{"accessToken":"unsafe-legacy-fixture"}')`,
      [orphanConnection, tenant, otherMetaPhoneId],
    );
    await client.query(
      `INSERT INTO whatsapp_message_templates (company_id, waba_id, template_name, language_code, status)
       VALUES ($1, '5678', 'aviso', 'es_CO', 'APPROVED')`,
      [tenant],
    );
  });
  const metaRequests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  let releaseMeta!: () => void;
  const holdFirstProviderResponse = new Promise<void>((resolve) => { releaseMeta = resolve; });
  let enterMeta!: () => void;
  const firstProviderRequest = new Promise<void>((resolve) => { enterMeta = resolve; });
  let confirmMeta = true;
  let rejectMeta = false;
  let providerGate: { enter: () => void; release: Promise<void> } | undefined;
  function holdNextProvider() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    providerGate = { enter, release: new Promise<void>((resolve) => { release = resolve; }) };
    context.after(release);
    return { entered, release };
  }
  const realFetch = globalThis.fetch;
  const graphServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    metaRequests.push({
      url: `https://graph.facebook.com${req.url}`, authorization: req.headers.authorization ?? null,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    assert.equal(req.method, 'POST');
    const number = metaRequests.length;
    if (number === 1) { enterMeta(); await holdFirstProviderResponse; }
    const gate = providerGate;
    if (gate) {
      providerGate = undefined;
      gate.enter();
      await gate.release;
    }
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    if (rejectMeta) res.writeHead(400).end(JSON.stringify({ error: { code: 100, message: 'Fixture rejection' } }));
    else if (!confirmMeta) res.destroy();
    else res.end(JSON.stringify({ messages: [{ id: `wamid.smoke-${number}` }] }));
  }).listen(0, '127.0.0.1');
  await once(graphServer, 'listening');
  const graphAddress = graphServer.address();
  assert.ok(graphAddress && typeof graphAddress !== 'string');
  const graphBase = `http://127.0.0.1:${graphAddress.port}`;
  context.after(() => { graphServer.close(); });
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === base) return realFetch(input, init);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(init?.redirect, 'error');
    return realFetch(`${graphBase}${url.pathname}${url.search}`, init);
  };
  globalThis.fetch = fetchFixture;
  context.after(() => {
    releaseMeta();
    globalThis.fetch = realFetch;
  });
  await consent.recordOptIn(tenant, {
    contactId: contacts[0], channelType: 'whatsapp-cloud', destination: '+51987570123',
    purpose: 'marketing', evidenceType: 'manual', evidenceProof: {},
  });
  const { data: whatsappSegment } = await request('/production/segments', tenant, 201, {
    ...segmentInput, name: 'Oferta por WhatsApp', targetChannel: 'whatsapp-cloud',
    dynamic: false, staticContactIds: [contacts[0]],
  });
  const whatsappInput = { name: 'WhatsApp de QA', channel: 'whatsapp-cloud',
    segmentId: whatsappSegment.id, contentBody: 'Contenido de QA', purpose: 'marketing' };
  const { data: freeform } = await request('/production/campaigns', tenant, 201, whatsappInput);
  const freeformDispatch = `/production/campaigns/${freeform.id}/dispatch`;
  assert.equal((await sendRequest(freeformDispatch, tenant, {}, 'EMPLEADO')).status, 403);
  assert.equal((await sendRequest('/production/consent', tenant, {}, 'EMPLEADO')).status, 403);
  assert.equal((await request(freeformDispatch, tenant, 409, {})).error, 'CAMPAIGN_WHATSAPP_NOT_CONNECTED');
  const { data: orphan } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Sin credencial cifrada', connectionId: orphanConnection,
  });
  assert.equal((await request(`/production/campaigns/${orphan.id}/dispatch`, tenant, 409, {})).error,
    'CAMPAIGN_WHATSAPP_NOT_CONNECTED');
  await new MetaAccountStore().upsertConnection(tenant, {
    phoneNumberId: metaPhoneId, wabaId: '1234', accessToken: fixtureToken, graphVersion: 'v25.0',
  });
  const inbox = new MetaInboxStore({ companyId: tenant });
  const recordInbound = (phoneNumberId: string) => inbox.persistInboundMessage({
    message: { id: `inbound-${phoneNumberId}`, from: '51987570123', type: 'text', text: { body: 'Hola' } },
    metadata: { phone_number_id: phoneNumberId },
  });
  await recordInbound(otherMetaPhoneId);
  const { data: whatsappCampaign } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Con plantilla', templateId: 'aviso',
  });
  const whatsappDispatch = `/production/campaigns/${whatsappCampaign.id}/dispatch`;
  assert.equal((await request(whatsappDispatch, tenant, 409, {})).error, 'CAMPAIGN_TEMPLATE_UNAVAILABLE');
  assert.deepEqual(metaRequests, []);
  await tenantScopedUoW.run(tenant, (client) => client.query(
    "UPDATE whatsapp_message_templates SET waba_id = '1234' WHERE company_id = $1",
    [tenant],
  ));
  const reviewPath = `/production/campaigns/${whatsappCampaign.id}/dispatch-review`;
  assert.equal((await sendRequest(reviewPath, tenant, undefined, 'EMPLEADO')).status, 403);
  await request(reviewPath, other, 404);
  const { data: review } = await request(reviewPath, tenant, 200);
  assert.equal(review.segmentName, 'Oferta por WhatsApp');
  assert.equal(review.audienceCount, 1);
  assert.equal(review.unattemptedCount, 1);
  const setContacts = (ids: number[]) => tenantScopedUoW.run(tenant, (client) => client.query(
    'UPDATE segments SET static_contact_ids = $1 WHERE id = $2', [ids, whatsappSegment.id],
  ));
  await setContacts([]);
  assert.equal((await request(whatsappDispatch, tenant, 409, { reviewKey: review.reviewKey })).error, 'CAMPAIGN_AUDIENCE_CHANGED');
  assert.deepEqual(metaRequests, []);
  await setContacts([contacts[0]]);
  const requestBody = { reviewKey: review.reviewKey };
  const dispatches = [sendRequest(whatsappDispatch, tenant, requestBody), sendRequest(whatsappDispatch, tenant, requestBody)];
  const firstResponse = await Promise.race(dispatches);
  await Promise.race([firstProviderRequest, Promise.all(dispatches).then(() => { throw new Error('Graph did not receive the first send'); })]);
  const earlyCallback = metaRequests[0].body.biz_opaque_callback_data;
  assert.match(String(earlyCallback), /^automat-campaign:del_[a-f0-9-]{36}$/);
  const earlyReceipt = { id: 'wamid.smoke-1', status: 'delivered', timestamp: now(), recipient_id: '51987570123',
    biz_opaque_callback_data: earlyCallback };
  await receipt(metaPhoneId, earlyReceipt);
  releaseMeta();
  assert.equal(firstResponse.status, 409);
  const outcomes = await Promise.all(dispatches);
  const acceptedDispatch = outcomes.find(({ status }) => status === 200);
  assert.ok(acceptedDispatch);
  const { data: sentWhatsApp } = await acceptedDispatch.json();
  assert.equal(sentWhatsApp.statsDispatched, 1);
  assert.equal(sentWhatsApp.statsDelivered, 1);
  assert.equal(sentWhatsApp.connectionId, `wa-meta-${tenant}-${metaPhoneId}`);
  const scopedConnections = await tenantScopedUoW.run(tenant, (client) => client.query(
    'SELECT id FROM channel_connections WHERE account_id = $1', [metaPhoneId],
  ));
  assert.deepEqual(scopedConnections.rows, [{ id: sentWhatsApp.connectionId }]);
  assert.equal((await dispatcher.getDeliveries(whatsappCampaign.id, tenant))[0]?.providerMessageId, 'wamid.smoke-1');
  assert.equal((await dispatcher.getDeliveries(whatsappCampaign.id, tenant))[0]?.status, 'delivered');
  await request(whatsappDispatch, tenant, 200, {});
  await request(whatsappDispatch, other, 404, {});
  assert.deepEqual(metaRequests, [{
    url: `https://graph.facebook.com/v25.0/${metaPhoneId}/messages`,
    authorization: `Bearer ${fixtureToken}`,
    body: {
      messaging_product: 'whatsapp', to: '51987570123', type: 'template',
      biz_opaque_callback_data: earlyCallback,
      template: { name: 'aviso', language: { code: 'es_CO' } },
    },
  }]);
  const blocked = await request(freeformDispatch, tenant, 200, {});
  assert.equal(blocked.data.status, 'failed');
  assert.equal((await dispatcher.getDeliveries(freeform.id, tenant))[0]?.errorCode, 'CH_WA_WINDOW_CLOSED');
  await recordInbound(metaPhoneId);
  const { data: openWindow } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Ventana abierta', connectionId: sentWhatsApp.connectionId,
  });
  assert.equal((await request(`/production/campaigns/${openWindow.id}/dispatch`, tenant, 200, {})).data.statsDispatched, 1);
  assert.equal(metaRequests[1].body.type, 'text');
  await consent.recordOptIn(tenant, {
    contactId: contacts[1], channelType: 'whatsapp-cloud', destination: '+51987571123',
    purpose: 'marketing', evidenceType: 'manual', evidenceProof: {},
  });
  await setContacts([contacts[0], contacts[1]]);
  confirmMeta = false;
  const { data: missingAck } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Sin acuse de Meta', connectionId: sentWhatsApp.connectionId, templateId: 'aviso',
  });
  const attemptedBeforePause = metaRequests.length;
  const unconfirmed = await request(`/production/campaigns/${missingAck.id}/dispatch`, tenant, 200, {});
  assert.equal(unconfirmed.data.status, 'paused');
  assert.equal(unconfirmed.data.statsDispatched, 0);
  assert.equal(unconfirmed.data.statsFailed, 0);
  const [unconfirmedDelivery] = await dispatcher.getDeliveries(missingAck.id, tenant);
  assert.equal(unconfirmedDelivery.status, 'pending');
  assert.equal(unconfirmedDelivery.errorCode, 'CAMPAIGN_PROVIDER_OUTCOME_UNKNOWN');
  const pendingReview = await request(`/production/campaigns/${missingAck.id}/dispatch-review`, tenant, 200);
  assert.equal(pendingReview.data.blockedByUnconfirmedDelivery, true);
  assert.equal(pendingReview.data.unattemptedCount, 1);
  const attemptedBeforeReplay = metaRequests.length;
  assert.equal(attemptedBeforeReplay, attemptedBeforePause + 1);
  const replay = await request(`/production/campaigns/${missingAck.id}/dispatch`, tenant, 409, {});
  assert.equal(replay.error, 'CAMPAIGN_DELIVERY_UNCONFIRMED');
  assert.equal(metaRequests.length, attemptedBeforeReplay);

  const otherTenantPhone = String(BigInt(metaPhoneId) + 2n);
  const accounts = new MetaAccountStore();
  await accounts.upsertConnection(tenant, { phoneNumberId: otherMetaPhoneId, accessToken: 'test-other-line' });
  await accounts.upsertConnection(other, { phoneNumberId: otherTenantPhone, accessToken: 'test-other-tenant' });
  const uncertain = metaRequests[attemptedBeforePause].body;
  const confirmation = {
    id: 'wamid.campaign-recovered', status: 'delivered', timestamp: now(), recipient_id: uncertain.to,
    biz_opaque_callback_data: uncertain.biz_opaque_callback_data,
  };
  await receipt(metaPhoneId, confirmation, 'wrong-secret', 403);
  for (const [line, patch] of [
    [otherMetaPhoneId, {}], [otherTenantPhone, {}],
    [metaPhoneId, { recipient_id: '51987572123' }],
    [metaPhoneId, { timestamp: String(Number(now()) - 3600) }],
    [metaPhoneId, { timestamp: String(Number(now()) + 3600) }],
    [metaPhoneId, { biz_opaque_callback_data: undefined }],
    [metaPhoneId, { biz_opaque_callback_data: earlyCallback }],
  ] as const) await receipt(line, { ...confirmation, ...patch });
  assert.equal((await dispatcher.getDeliveries(missingAck.id, tenant))[0]?.status, 'pending');
  await receipt(metaPhoneId, confirmation);
  assert.equal((await receipt(metaPhoneId, confirmation)).results[0].duplicate, true);
  const recoveredReview = await request(`/production/campaigns/${missingAck.id}/dispatch-review`, tenant, 200);
  assert.equal(recoveredReview.data.campaignStatus, 'paused');
  assert.equal(recoveredReview.data.blockedByUnconfirmedDelivery, false);
  assert.match((await request(`/production/campaigns/${missingAck.id}`, tenant, 200)).data.pauseReason, /se concilió/);
  assert.equal(metaRequests.length, attemptedBeforeReplay);

  confirmMeta = true;
  const resumed = await request(`/production/campaigns/${missingAck.id}/dispatch`, tenant, 200, { reviewKey: recoveredReview.data.reviewKey });
  assert.equal(resumed.data.status, 'completed');
  assert.equal(resumed.data.statsDispatched, 2);
  assert.equal(resumed.data.statsDelivered, 1);
  assert.equal(metaRequests.length, attemptedBeforeReplay + 1);
  const continued = metaRequests.at(-1)!.body;
  assert.notEqual(continued.to, uncertain.to);
  const continuedReceipt = {
    id: `wamid.smoke-${metaRequests.length}`, status: 'read', timestamp: now(), recipient_id: continued.to,
    biz_opaque_callback_data: continued.biz_opaque_callback_data,
  };
  await receipt(metaPhoneId, continuedReceipt);
  await receipt(metaPhoneId, { ...continuedReceipt, status: 'failed' });
  await receipt(metaPhoneId, { ...confirmation, status: 'sent' });
  const closedCampaign = await request(`/production/campaigns/${missingAck.id}`, tenant, 200);
  assert.equal(closedCampaign.data.status, 'completed');
  assert.equal(closedCampaign.data.statsDelivered, 2);
  assert.equal(closedCampaign.data.statsFailed, 0);
  const settled = await dispatcher.getDeliveries(missingAck.id, tenant);
  assert.ok(settled.every(({ status }) => status === 'delivered'));
  assert.equal(settled.find(({ destination }) => destination === uncertain.to)?.providerMessageId, confirmation.id);

  const campaignPath = (id: string) => `/production/campaigns/${id}`;
  const newTemplate = (name: string) => request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name, connectionId: sentWhatsApp.connectionId, templateId: 'aviso',
  });
  const inspectLease = (id: string) => tenantScopedUoW.run(tenant, async (db) => (await db.query(`
    SELECT status, stats_total, dispatch_run_id, dispatch_lease_expires_at > clock_timestamp() AS lease_active
    FROM campaigns WHERE tenant_id = $1 AND id = $2
  `, [tenant, id])).rows[0]);
  // Advance just this fixture's persisted lease instead of waiting two minutes in CI.
  const expireLease = (id: string) => tenantScopedUoW.run(tenant, (db) => db.query(`
    UPDATE campaigns SET dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
    WHERE tenant_id = $1 AND id = $2 AND status = 'dispatching'
  `, [tenant, id]));

  await context.test('recovers a killed dispatcher without resending its uncertain recipient', async (subtest) => {
    const { data: crashed } = await newTemplate('Proceso interrumpido');
    const path = campaignPath(crashed.id);
    const beforeCrash = (await request(`${path}/dispatch-review`, tenant, 200)).data.reviewKey;
    const held = holdNextProvider();
    const graphStart = metaRequests.length;
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures/dispatch-campaign-child.ts'),
      String(tenant), crashed.id, graphBase, beforeCrash], { stdio: ['ignore', 'ignore', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk: Buffer) => { childError += chunk.toString(); });
    const childExit = once(child, 'exit');
    subtest.after(() => { child.kill('SIGKILL'); held.release(); });
    await Promise.race([held.entered, childExit.then(() => { throw new Error(`Dispatch child exited early: ${childError}`); })]);
    assert.equal((await request(path, tenant, 200)).data.status, 'dispatching');
    assert.equal((await request(`${path}/dispatch`, tenant, 409, {})).error, 'CAMPAIGN_NOT_DISPATCHABLE');
    const live = await inspectLease(crashed.id);
    assert.equal(live.lease_active, true);
    assert.equal(live.stats_total, 2);
    const [pending] = await dispatcher.getDeliveries(crashed.id, tenant);
    assert.equal(pending.status, 'pending');
    assert.equal(metaRequests.length, graphStart + 1);
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await childExit, [null, 'SIGKILL']);
    held.release();

    assert.equal((await expireLease(crashed.id)).rowCount, 1);
    await request(path, other, 404);
    assert.equal((await inspectLease(crashed.id)).status, 'dispatching');
    assert.equal((await request(`${path}/dispatch`, tenant, 409, { reviewKey: beforeCrash })).error,
      'CAMPAIGN_DISPATCH_INTERRUPTED');
    const recovered = await inspectLease(crashed.id);
    assert.equal(recovered.status, 'paused');
    assert.equal(recovered.lease_active, null);
    assert.equal(recovered.dispatch_run_id, live.dispatch_run_id);
    const blocked = (await request(`${path}/dispatch-review`, tenant, 200)).data;
    assert.equal(blocked.blockedByUnconfirmedDelivery, true);
    assert.equal((await request(`${path}/dispatch`, tenant, 409, { reviewKey: blocked.reviewKey })).error,
      'CAMPAIGN_DELIVERY_UNCONFIRMED');
    assert.equal(metaRequests.length, graphStart + 1);

    const sent = metaRequests[graphStart].body;
    const settledId = 'wamid.process-killed';
    await receipt(metaPhoneId, { id: settledId, status: 'delivered', timestamp: now(), recipient_id: sent.to,
      biz_opaque_callback_data: sent.biz_opaque_callback_data });
    assert.equal((await request(`${path}/dispatch`, tenant, 409, {})).error, 'CAMPAIGN_REVIEW_REQUIRED');
    assert.equal((await request(`${path}/dispatch`, tenant, 409, { reviewKey: beforeCrash })).error,
      'CAMPAIGN_AUDIENCE_CHANGED');
    const reviewed = (await request(`${path}/dispatch-review`, tenant, 200)).data;
    assert.equal(reviewed.unattemptedCount, 1);
    assert.equal(reviewed.blockedByUnconfirmedDelivery, false);
    const finished = (await request(`${path}/dispatch`, tenant, 200, { reviewKey: reviewed.reviewKey })).data;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.statsDispatched, 2);
    assert.equal(finished.statsDelivered, 1);
    assert.equal(metaRequests.length, graphStart + 2);
    assert.notEqual(metaRequests.at(-1)?.body.to, sent.to);
    assert.notEqual((await inspectLease(crashed.id)).dispatch_run_id, live.dispatch_run_id);
    assert.equal((await dispatcher.getDeliveries(crashed.id, tenant)).find(({ id }) => id === pending.id)?.providerMessageId, settledId);
  });

  await context.test('a stale live worker cannot overwrite a recovered run', async () => {
    const { data: stale } = await newTemplate('Ejecución con permiso vencido');
    const path = campaignPath(stale.id);
    const held = holdNextProvider();
    const graphStart = metaRequests.length;
    let oldRunFinished = false;
    const oldRun = sendRequest(`${path}/dispatch`, tenant, {}).then((result) => {
      oldRunFinished = true;
      return result;
    });
    await Promise.race([held.entered, oldRun.then((result) => { throw new Error(`Dispatch finished early: ${result.status}`); })]);
    assert.equal((await expireLease(stale.id)).rowCount, 1);
    const list = (await request('/production/campaigns', tenant, 200)).data;
    assert.equal(list.find(({ id }: { id: string }) => id === stale.id).status, 'paused');
    const sent = metaRequests[graphStart].body;
    await receipt(metaPhoneId, { id: 'wamid.stale-worker', status: 'sent', timestamp: now(), recipient_id: sent.to,
      biz_opaque_callback_data: sent.biz_opaque_callback_data });
    const review = (await request(`${path}/dispatch-review`, tenant, 200)).data;
    assert.equal((await request(`${path}/dispatch`, tenant, 200, { reviewKey: review.reviewKey })).data.status, 'completed');
    assert.equal(oldRunFinished, false);
    held.release();
    const lost = await oldRun;
    assert.equal(lost.status, 409);
    assert.equal((await lost.json()).error, 'CAMPAIGN_DISPATCH_LEASE_LOST');
    assert.equal((await request(path, tenant, 200)).data.statsDispatched, 2);
    assert.equal(metaRequests.length, graphStart + 2);
    assert.notEqual(metaRequests.at(-1)?.body.to, sent.to);
  });

  const { data: historical } = await newTemplate('Despacho anterior a migración');
  await tenantScopedUoW.run(tenant, (db) => db.query("UPDATE campaigns SET status = 'dispatching' WHERE id = $1", [historical.id]));
  const historicalPath = campaignPath(historical.id);
  assert.equal((await request(historicalPath, tenant, 200)).data.status, 'dispatching');
  assert.equal((await request(`${historicalPath}/dispatch`, tenant, 409, {})).error, 'CAMPAIGN_DISPATCH_LEGACY_UNFENCED');

  await setContacts([contacts[0]]);
  rejectMeta = true;
  const { data: rejectedCampaign } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Rechazo explícito de Meta', connectionId: sentWhatsApp.connectionId,
  });
  const rejected = await request(`/production/campaigns/${rejectedCampaign.id}/dispatch`, tenant, 200, {});
  assert.equal(rejected.data.status, 'failed');
  assert.equal(rejected.data.statsFailed, 1);
  assert.equal((await dispatcher.getDeliveries(rejectedCampaign.id, tenant))[0]?.errorCode, 'CAMPAIGN_PROVIDER_REJECTED');
  await consent.recordOptOut(tenant, {
    channelType: 'whatsapp-cloud', destination: '51987570123', purpose: 'all',
    evidenceType: 'manual', evidenceProof: {},
  });
  assert.equal((await consent.verifyConsent(tenant, 'whatsapp-cloud', '+51987570123')).permitted, false);

  const independentPool = new Pool({ ...config.database, database: config.database.name });
  let closed = false;
  context.after(async () => { if (!closed) await independentPool.end(); });
  const secondReader = new ConsentService(new TenantScopedUoW(independentPool));
  assert.equal((await secondReader.verifyConsent(tenant, 'email', emails[0])).permitted, true);
  await consent.recordOptOut(tenant, { channelType: 'email', destination: emails[0], purpose: 'all', evidenceType: 'manual', evidenceProof: {} });
  assert.equal((await secondReader.verifyConsent(tenant, 'email', emails[0])).permitted, false);
  await independentPool.end();
  closed = true;
  await assert.rejects(secondReader.verifyConsent(tenant, 'email', emails[0]));
});
