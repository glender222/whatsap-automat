import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { PaymentCheckoutIntent } from '../modules/payments/domain/paymentCheckoutIntent.types';
import { MercadoPagoOrdersAdapter } from '../modules/payments/infra/mercadopago/MercadoPagoOrdersAdapter';

const now = Date.parse('2026-11-10T10:00:00Z');
const deadline = now + 90_000;
const companyId = 7;
const sellerId = '12345';
const fixtureToken = 'synthetic-orders-adapter-token';
const remoteId = 'ORDTST01KS5AJ6HTK2HRQ3XJ3C2JCKP9';
const pay1 = 'PAY01J67CQQH5904WDBVZEM4JMEP3';
const pay2 = 'PAY01KRH40QE51CE0XVFJ9S40W88P';
const checkoutUrl = `https://www.mercadopago.com.pe/checkout/v1/redirect?order_id=${remoteId}`;
const intent: PaymentCheckoutIntent = {
  id: '97560a16-fb96-452e-a00b-23e616e7aee3',
  externalReference: '4df3f631-1d72-49cf-aa4e-15ded2d27f39',
  orderId: '14', gatewayId: '24', amount: '0.72', currency: 'PEN', orderStatus: 'reserved',
  orderRevision: '2026-11-10T10:00:00.000000Z', gatewayRevision: '2026-11-10T09:00:00.000000Z',
  reservationExpiresAt: new Date(deadline).toISOString(), state: 'prepared', version: 1, voidReason: null,
  items: [
    { id: '101', catalogItemId: '1', title: 'Stock fixture', quantity: 3, unitAmount: '0.10' },
    { id: '102', catalogItemId: '2', title: 'Capacity fixture', quantity: 2, unitAmount: '0.21' },
  ],
};
const createInput = { companyId, intent, plannedAt: now, validUntil: deadline };
const lookupInput = { companyId, intent, orderId: remoteId, validUntil: deadline };

function responseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: remoteId, type: 'online', processing_mode: 'manual', country_code: 'PER', currency: 'PEN', user_id: sellerId,
    external_reference: intent.externalReference, total_amount: '0.72', total_paid_amount: '0.00', status: 'created',
    status_detail: 'created', created_date: new Date(now + 2_000).toISOString(), expiration_time: 'PT1M15S',
    checkout_url: checkoutUrl, client_token: 'fixture-client-token-discarded',
    ...overrides,
  };
}

function credited(id: string, amount: string) {
  return { id, status: 'processed', status_detail: 'accredited', amount, paid_amount: amount };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function loopback(t: TestContext) {
  const requests: { method: string; path: string; key: string | undefined; body: unknown }[] = [];
  let respond: (response: ServerResponse) => void = (response) => sendJson(response, 201, responseOrder());
  let credential = { companyId, gatewayId: intent.gatewayId, gatewayRevision: intent.gatewayRevision, sellerId, accessToken: fixtureToken };
  let currentTime = now;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${fixtureToken}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, path: req.url!, key: req.headers['x-idempotency-key'] as string | undefined, body: body ? JSON.parse(body) : null });
    respond(res);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = new MercadoPagoOrdersAdapter(async (url, request) => {
    assert.equal(url.origin, 'https://api.mercadopago.com');
    assert.ok(url.pathname === '/v1/orders' || url.pathname === `/v1/orders/${remoteId}`);
    assert.equal(url.search, '');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, request);
  }, async (scope) => {
    assert.deepEqual(scope, { companyId, gatewayId: intent.gatewayId, gatewayRevision: intent.gatewayRevision });
    return credential;
  }, () => currentTime);
  return {
    adapter, requests, respond: (reply: typeof respond) => { respond = reply; },
    setCredential: (overrides: Partial<typeof credential>) => { credential = { ...credential, ...overrides }; },
    setTime: (time: number) => { currentTime = time; },
    origin: `http://127.0.0.1:${address.port}`,
  };
}

test('creates one hosted checkout from exact snapshot decimals and verifies the Peru link and deadline', async (t) => {
  const { adapter, requests } = await loopback(t);
  const result = await adapter.create(createInput);
  assert.deepEqual(result, { kind: 'created', orderId: remoteId, checkoutUrl, expiresAt: new Date(now + 77_000).toISOString() });
  assert.deepEqual(requests, [{
    method: 'POST', path: '/v1/orders', key: intent.id,
    body: {
      type: 'online', processing_mode: 'manual', total_amount: '0.72', external_reference: intent.externalReference,
      expiration_time: 'PT75S', config: { payment_method: { not_allowed_types: ['ticket'] } },
      items: [
        { title: 'Stock fixture', quantity: 3, unit_price: '0.10' },
        { title: 'Capacity fixture', quantity: 2, unit_price: '0.21' },
      ],
    },
  }]);
  assert.equal(JSON.stringify(result).includes('client_token'), false);
});

test('sends nothing for a corrupt snapshot, expired dispatch window, or credential outside the binding', async (t) => {
  const fixture = await loopback(t);
  for (const invalid of [
    { ...intent, amount: '0.71' }, { ...intent, amount: '0.720' }, { ...intent, state: 'voided' as const },
    { ...intent, items: [{ ...intent.items[0], quantity: 0 }] },
  ]) assert.deepEqual(await fixture.adapter.create({ ...createInput, intent: invalid }), { kind: 'not_sent', reason: 'invalid_snapshot' });
  assert.deepEqual(await fixture.adapter.create({ ...createInput, validUntil: deadline + 1 }), { kind: 'not_sent', reason: 'invalid_window' });
  assert.deepEqual(await fixture.adapter.create({ ...createInput, validUntil: now + 10_000 }), { kind: 'not_sent', reason: 'invalid_window' });
  fixture.setTime(now + 5_001);
  assert.deepEqual(await fixture.adapter.create(createInput), { kind: 'not_sent', reason: 'invalid_window' });
  fixture.setTime(now);
  for (const invalid of [{ companyId: 8 }, { gatewayId: '25' }, { gatewayRevision: 'changed' }, { accessToken: 'bad\nheader' }]) {
    fixture.setCredential(invalid);
    assert.deepEqual(await fixture.adapter.create(createInput), { kind: 'not_sent', reason: 'credential_unavailable' });
    fixture.setCredential({ companyId, gatewayId: intent.gatewayId, gatewayRevision: intent.gatewayRevision, accessToken: fixtureToken });
  }
  assert.equal(fixture.requests.length, 0);
});

test('suppresses off-origin links, wrong order IDs, and expiry beyond the reservation', async (t) => {
  const fixture = await loopback(t);
  for (const invalid of [
    { checkout_url: checkoutUrl.replace('www.mercadopago.com.pe', 'mercadopago.com.pe.evil.invalid') },
    { checkout_url: checkoutUrl.replace('www.', 'user@www.') },
    { checkout_url: checkoutUrl.replace('https:', 'http:') },
    { checkout_url: checkoutUrl.replace('www.mercadopago.com.pe', 'www.mercadopago.com.pe:444') },
    { checkout_url: checkoutUrl + '#redirect' }, { checkout_url: checkoutUrl + '&next=https://evil.invalid' },
    { checkout_url: checkoutUrl.replace(remoteId, pay1) }, { checkout_url: checkoutUrl.replace('/redirect?', '/other?') },
    { expiration_time: 'PT2M' }, { expiration_time: 'P1M' }, { status_detail: 'accredited' },
  ]) {
    fixture.respond((response) => sendJson(response, 201, responseOrder(invalid)));
    assert.deepEqual(await fixture.adapter.create({ ...createInput, intent: { ...intent, id: randomUUID() } }), {
      kind: 'uncertain', reason: 'checkout_unverified', orderId: remoteId,
    });
  }
  for (const invalid of [{ user_id: '23456' }, { external_reference: randomUUID() }, { currency: 'USD' }, { country_code: 'ARG' }]) {
    fixture.respond((response) => sendJson(response, 201, responseOrder(invalid)));
    assert.deepEqual(await fixture.adapter.create({ ...createInput, intent: { ...intent, id: randomUUID() } }), {
      kind: 'uncertain', reason: 'response', status: 201,
    });
  }
});

test('classifies documented rejection and keeps uncertain creates single-shot without following redirects', async (t) => {
  const fixture = await loopback(t);
  fixture.respond((response) => sendJson(response, 400, { errors: [{ code: 'order_items_total_amount_mismatch', message: 'ignored' }] }));
  assert.deepEqual(await fixture.adapter.create(createInput), {
    kind: 'rejected', status: 400, code: 'order_items_total_amount_mismatch',
  });
  for (const [status, code] of [
    [400, 'idempotency_validation_failed'], [409, 'idempotency_key_already_used'], [423, 'resource_locked'],
    [429, 'too_many_requests'], [500, 'internal_error'], [200, 'unexpected_success'],
  ] as const) {
    const before = fixture.requests.length;
    fixture.respond((response) => sendJson(response, status, { code }));
    assert.deepEqual(await fixture.adapter.create({ ...createInput, intent: { ...intent, id: randomUUID() } }), {
      kind: 'uncertain', reason: 'response', status,
    });
    assert.equal(fixture.requests.length, before + 1);
  }
  for (const reply of [
    (response: ServerResponse) => response.destroy(),
    (response: ServerResponse) => { response.writeHead(302, { location: fixture.origin + '/unexpected' }); response.end(); },
  ]) {
    const before = fixture.requests.length;
    fixture.respond(reply);
    assert.deepEqual(await fixture.adapter.create({ ...createInput, intent: { ...intent, id: randomUUID() } }), {
      kind: 'uncertain', reason: 'transport',
    });
    assert.equal(fixture.requests.length, before + 1);
  }
  const before = fixture.requests.length;
  fixture.respond((response) => {
    response.writeHead(201, { 'content-type': 'application/json' });
    response.write('x'.repeat(130 * 1024));
    response.end();
  });
  assert.equal((await fixture.adapter.create({ ...createInput, intent: { ...intent, id: randomUUID() } })).kind, 'uncertain');
  assert.equal(fixture.requests.length, before + 1);
  assert.ok(fixture.requests.every(({ method, path }) => method === 'POST' && path === '/v1/orders'));
});

test('looks up exact credited transaction evidence and classifies partial, late, refunded, and inconsistent funds', async (t) => {
  const fixture = await loopback(t);
  const payments = [credited(pay1, '0.30'), credited(pay2, '0.42')];
  const fullyPaid = { status: 'processed', status_detail: 'accredited', total_paid_amount: '0.72', transactions: { payments } };
  const examples: Array<[Record<string, unknown>, string]> = [
    [{}, 'unpaid'],
    [{ status: 'action_required', status_detail: 'waiting_capture' }, 'pending'],
    [{ status: 'canceled', status_detail: 'canceled' }, 'failed'],
    [{ ...fullyPaid, total_paid_amount: '0.30', transactions: { payments: [payments[0]] } }, 'partial'],
    [{ ...fullyPaid, status: 'charged_back', total_paid_amount: '0.30', transactions: { payments: [payments[0]] } }, 'reconciliation_required'],
    [fullyPaid, 'paid_candidate'],
    [{ ...fullyPaid, total_paid_amount: '0.73' }, 'reconciliation_required'],
    [{ ...fullyPaid, transactions: { payments: [credited(pay1, '0.36'), credited(pay1, '0.36')] } }, 'reconciliation_required'],
    [{ ...fullyPaid, transactions: { payments: [...payments, { id: 'PAY01J49MMW3SSBK5PSV3DFR32959', status: 'processing' }] } }, 'reconciliation_required'],
    [{ ...fullyPaid, transactions: { payments, refunds: [{ id: 'fixture-refund' }] } }, 'reconciliation_required'],
    [{ ...fullyPaid, transactions: { payments, chargebacks: [{ id: 'fixture-chargeback' }] } }, 'reconciliation_required'],
    [{ ...fullyPaid, status_detail: 'partially_refunded' }, 'reconciliation_required'],
    [{ ...fullyPaid, expiration_time: 'PT2M' }, 'reconciliation_required'],
    [{ ...fullyPaid, status: 'created' }, 'reconciliation_required'],
  ];
  for (const [payload, payment] of examples) {
    fixture.respond((response) => sendJson(response, 200, responseOrder(payload)));
    const result = await fixture.adapter.lookup(lookupInput);
    assert.equal(result.kind, 'observed');
    assert.equal(result.payment, payment);
    assert.ok(!JSON.stringify(result).includes('fixture-client-token'));
  }
  fixture.respond((response) => sendJson(response, 200, responseOrder(fullyPaid)));
  const voided = await fixture.adapter.lookup({ ...lookupInput, intent: { ...intent, state: 'voided' } });
  assert.equal(voided.kind, 'observed');
  assert.equal(voided.payment, 'reconciliation_required');
  fixture.setTime(deadline);
  const late = await fixture.adapter.lookup(lookupInput);
  assert.equal(late.kind, 'observed');
  assert.equal(late.payment, 'reconciliation_required');
  fixture.respond((response) => sendJson(response, 404, { code: 'order_not_found' }));
  assert.deepEqual(await fixture.adapter.lookup(lookupInput), { kind: 'uncertain', reason: 'response', status: 404 });
  assert.deepEqual(await fixture.adapter.lookup({ ...lookupInput, orderId: '../orders' }), { kind: 'not_sent', reason: 'invalid_snapshot' });
  assert.ok(fixture.requests.every(({ method, path, key }) => method === 'GET' && path === `/v1/orders/${remoteId}` && key === undefined));
});

test('ends a timed-out loopback create with one uncertain POST', { timeout: 8000 }, async (t) => {
  const fixture = await loopback(t);
  fixture.respond(() => {});
  assert.deepEqual(await fixture.adapter.create(createInput), { kind: 'uncertain', reason: 'transport' });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].key, intent.id);
});
