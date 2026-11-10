import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import { changeOrderStatus, orderActions, orderError, savePreorder, type Order } from '../factures/dashboard/orders/ordersApi';

Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null } });
const order: Order = {
  id: 8, companyId: 4, title: 'Pedido QA', status: 'draft', occurredAt: '2026-11-08T00:00:00Z',
  confirmedAt: null, reservedAt: null, notes: null, metadata: { chatId: '15550109031' }, items: [],
};

function respond(context: TestContext, response: (request: InternalAxiosRequestConfig) => { status: number; data: unknown }) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (config) => ({ ...response(config), statusText: 'Fixture', headers: {}, config });
  context.after(() => { api.defaults.adapter = original; });
}

test('the web only offers operator transitions permitted for the observed order', () => {
  assert.deepEqual(orderActions(order), ['confirmed', 'cancelled']);
  assert.deepEqual(orderActions({ ...order, status: 'reserved', confirmedAt: order.occurredAt }), ['completed', 'cancelled']);
  assert.deepEqual(orderActions({ ...order, status: 'completed' }), []);
  assert.deepEqual(orderActions({ ...order, status: 'cancelled' }), []);
  assert.deepEqual(orderActions({ ...order, items: [{
    id: 1, itemNameSnapshot: 'Stock', quantity: 1, unitPrice: null, currency: 'PEN',
    availabilityStatus: 'available', metadata: { availabilityType: 'stock' },
  }] }), ['confirmed', 'reserved', 'cancelled']);
  assert.deepEqual(orderActions({ ...order, status: 'reserved', confirmedAt: order.occurredAt,
    reservationExpiresAt: '2026-11-08T00:30:00Z' }), ['confirmed', 'completed', 'cancelled']);
});

test('a preorder submits selected catalog IDs and requires the persisted order', async (context) => {
  let status = 201;
  respond(context, (request) => {
    assert.equal(request.url, '/orders/detected');
    assert.deepEqual(JSON.parse(request.data), {
      chatId: '15550109031', items: [{ commercialItemId: 12, quantity: 2 }],
      status: 'draft', metadata: { source: 'web_operator' },
    });
    return { status, data: { success: true, data: { order } } };
  });
  const items = [{ commercialItemId: 12, quantity: 2 }];
  assert.deepEqual(await savePreorder('15550109031', items), order);
  status = 200;
  await assert.rejects(savePreorder('15550109031', items), /no confirmó el pedido/);
});

test('the completed transition requires a matching tenant, order and resulting state', async (context) => {
  let returned = { ...order, status: 'completed' };
  respond(context, (request) => {
    assert.equal(request.url, '/orders/8/status');
    assert.equal(request.method, 'patch');
    assert.deepEqual(JSON.parse(request.data), { status: 'completed' });
    return { status: 200, data: { success: true, data: returned } };
  });
  const confirmed = { ...order, status: 'confirmed' };
  assert.deepEqual(await changeOrderStatus(confirmed, 'completed'), returned);
  returned = { ...returned, companyId: 9 };
  await assert.rejects(changeOrderStatus(confirmed, 'completed'), /no confirmó el cambio/);
});

test('stock conflicts state the constraint before another attempt', () => {
  const error = new AxiosError('Conflict');
  error.response = { status: 409, statusText: 'Conflict', data: { error: 'ORDER_STOCK_UNAVAILABLE' }, headers: {} } as typeof error.response;
  assert.match(orderError(error, 'Sin confirmar'), /disponibilidad es insuficiente.*inventario/);
});

test('a timed reservation sends the selected duration and verifies the deadline', async (context) => {
  let reservationExpiresAt: string | null = '2026-11-08T00:30:00Z';
  respond(context, (request) => {
    assert.equal(request.url, '/orders/8/status');
    assert.equal(request.method, 'patch');
    assert.deepEqual(JSON.parse(request.data), { status: 'reserved', reservationMinutes: 30 });
    return { status: 200, data: { success: true, data: { ...order, status: 'reserved', reservationExpiresAt } } };
  });
  assert.equal((await changeOrderStatus(order, 'reserved', 30)).reservationExpiresAt, reservationExpiresAt);
  reservationExpiresAt = null;
  await assert.rejects(changeOrderStatus(order, 'reserved', 30), /no confirmó el cambio/);
});
