import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

test('campaign API persists scoped drafts, real counts, suppression and acknowledged delivery', {
  skip: process.env.CAMPAIGN_SMOKE !== '1' && 'Use a dedicated migrated *_smoke database and set CAMPAIGN_SMOKE=1',
  timeout: 15000,
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
  app.use(express.json());
  app.use('/api/v1', createRoutes({ dispatcher, consent, segments }));
  app.use('/production', createRoutes());
  const server = app.listen(0, '127.0.0.1');
  context.after(() => {
    allowProvider();
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

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
  let confirmMeta = true;
  const realFetch = globalThis.fetch;
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === base) return realFetch(input, init);
    assert.equal(url.origin, 'https://graph.facebook.com');
    metaRequests.push({
      url: url.href,
      authorization: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(String(init?.body)),
    });
    const number = metaRequests.length;
    if (number === 1) await holdFirstProviderResponse;
    return Response.json(confirmMeta ? { messages: [{ id: `wamid.smoke.${number}` }] } : {});
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
  const dispatches = [sendRequest(whatsappDispatch, tenant, {}), sendRequest(whatsappDispatch, tenant, {})];
  const firstResponse = await Promise.race(dispatches);
  releaseMeta();
  assert.equal(firstResponse.status, 409);
  const outcomes = await Promise.all(dispatches);
  const acceptedDispatch = outcomes.find(({ status }) => status === 200);
  assert.ok(acceptedDispatch);
  const { data: sentWhatsApp } = await acceptedDispatch.json();
  assert.equal(sentWhatsApp.statsDispatched, 1);
  assert.equal(sentWhatsApp.connectionId, `wa-meta-${tenant}-${metaPhoneId}`);
  const scopedConnections = await tenantScopedUoW.run(tenant, (client) => client.query(
    'SELECT id FROM channel_connections WHERE account_id = $1', [metaPhoneId],
  ));
  assert.deepEqual(scopedConnections.rows, [{ id: sentWhatsApp.connectionId }]);
  assert.equal((await dispatcher.getDeliveries(whatsappCampaign.id, tenant))[0]?.providerMessageId, 'wamid.smoke.1');
  await request(whatsappDispatch, tenant, 200, {});
  await request(whatsappDispatch, other, 404, {});
  assert.deepEqual(metaRequests, [{
    url: `https://graph.facebook.com/v25.0/${metaPhoneId}/messages`,
    authorization: `Bearer ${fixtureToken}`,
    body: {
      messaging_product: 'whatsapp', to: '51987570123', type: 'template',
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
  confirmMeta = false;
  const { data: missingAck } = await request('/production/campaigns', tenant, 201, {
    ...whatsappInput, name: 'Sin acuse de Meta', connectionId: sentWhatsApp.connectionId,
  });
  const unconfirmed = await request(`/production/campaigns/${missingAck.id}/dispatch`, tenant, 200, {});
  assert.equal(unconfirmed.data.status, 'failed');
  assert.equal(unconfirmed.data.statsDispatched, 0);
  assert.equal((await dispatcher.getDeliveries(missingAck.id, tenant))[0]?.errorCode, 'CAMPAIGN_PROVIDER_ACK_MISSING');
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
