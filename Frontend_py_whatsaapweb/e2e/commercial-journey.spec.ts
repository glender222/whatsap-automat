import { expect, test, type BrowserContext } from '@playwright/test';
import type { Order } from '../src/factures/dashboard/orders/ordersApi';
import type { CustomerHistory } from '../src/factures/mensajeria/types/customerHistoryTypes';
import type { PaymentProcessSummary } from '../src/factures/dashboard/services/paymentsService';

const chatId = '12025550145';
const order: Order = {
  id: 21, companyId: 1, title: 'Pedido recorrido', status: 'draft',
  occurredAt: '2026-01-01T12:00:00Z', confirmedAt: null, reservedAt: null, notes: null,
  metadata: { chatId },
  items: [{ id: 1, itemNameSnapshot: 'Producto recorrido', quantity: 1, unitPrice: 20, currency: 'PEN', availabilityStatus: 'available' }],
};
const customerHistory: CustomerHistory = {
  contact: {
    id: 1, externalContactId: chatId, phone: chatId, name: 'Cliente recorrido', displayName: 'Cliente recorrido',
    profileName: null, waId: chatId, firstSeenAt: null, lastSeenAt: null, createdAt: null, updatedAt: null,
  },
  conversations: [], recentMessages: [], tags: [], actions: [],
  orders: [{
    id: order.id, title: order.title, serviceType: 'Venta', orderType: 'commercial', status: order.status,
    notes: null, createdBy: null, conversationId: 42, occurredAt: order.occurredAt, createdAt: null, updatedAt: null,
    items: [{ id: 1, productId: 1, productName: 'Producto recorrido', sku: null, quantity: 1, unitPrice: 20, currency: 'PEN', status: 'pending' }],
  }],
  meta: { conversationLimit: 8, messageLimit: 30, generatedAt: '2026-01-01T12:00:00Z', pendingSources: [] },
};
const payment: PaymentProcessSummary = {
  rowId: 'order:21', rowType: 'payment_process', processStatus: 'collect_payment', orderId: 21,
  voucherId: null, orderStatus: 'draft', voucherStatus: null, paymentMethod: null, amount: null,
  orderTotal: 20, currency: 'PEN', customerName: 'Cliente recorrido', chatId,
  fileUrl: null, mimeType: null, uploadedAt: null, validatedAt: null, orderCreatedAt: order.occurredAt, items: [],
};

async function commercialFixture(context: BrowserContext, role: 'ADMIN' | 'EMPLEADO') {
  await context.addInitScript((rol) => {
    localStorage.setItem('auth', JSON.stringify({
      browserSessionId: 'qa-commercial-journey', accessToken: 'qa-token', refreshToken: 'qa-refresh',
      user: { id: '11', companyId: 1, nombre: 'Persona QA', rol, idPadre: null },
    }));
    localStorage.setItem('app:theme', 'Oscuro');
  }, role);
  const paymentFilters: Array<string | null> = [];
  const reconciliationFilters: Array<string | null> = [];
  const orderOffsets: number[] = [];
  const businessMutations: string[] = [];
  await context.route(/\/(api|socket\.io)\//, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (data: unknown) => route.fulfill({ json: { success: true, data } });
    if (route.request().method() !== 'GET' && /^\/api\/(orders|payments|v1\/conversations)\//.test(path)) {
      businessMutations.push(path);
      return route.fulfill({ status: 405 });
    }
    if (path === '/api/chats') return json([{
      id: chatId, conversationId: '42', name: 'Cliente recorrido', profilePhotoUrl: null,
      lastMessageTimestamp: Date.now(), lastMessagePreview: 'Quiero revisar mi pedido', unreadCount: 1, isGroup: false,
    }]);
    if (path === `/api/chats/${chatId}/messages`) return route.fulfill({ json: { success: true, nextCursor: null, data: [{
      id: 'wamid.commercial-fixture', chatId, body: 'Quiero revisar mi pedido', timestamp: Math.floor(Date.now() / 1000),
      fromMe: false, type: 'text', hasMedia: false,
    }] } });
    if (path === `/api/chats/${chatId}/session/status`) return route.fulfill({ json: {
      success: true, conversationId: '42', status: 'active', hasActiveSession: true,
    } });
    if (path === '/api/v1/conversations/42') return route.fulfill({ json: {
      id: '42', tenantId: '1', externalConversationId: chatId, channel: 'whatsapp-cloud', status: 'open', stateVersion: 1,
      assignedUserId: '11', assignedAgentId: null, aiPaused: true,
      serviceWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    if (path === '/api/v1/conversations/42/messages') return route.fulfill({ json: { items: [] } });
    if (path === `/api/customer-history/chats/${chatId}`) return json(customerHistory);
    if (path === '/api/orders/21') return json(order);
    if (path === '/api/orders') {
      const offset = Number(url.searchParams.get('offset') || 0);
      orderOffsets.push(offset);
      return json({ rows: offset === 20 ? [order] : Array.from({ length: 20 }, (_, index) => ({
        ...order, id: index + 1, title: `Pedido anterior ${index + 1}`,
      })), total: 21 });
    }
    if (path === '/api/payments') {
      const requestedOrder = url.searchParams.get('orderId');
      paymentFilters.push(requestedOrder);
      const rows = requestedOrder === '21' ? [payment] : [payment, {
        ...payment, rowId: 'order:99', orderId: 99, customerName: 'Cliente de otro pedido',
      }];
      return json({ rows, total: rows.length, limit: 100, offset: 0 });
    }
    if (path === '/api/payments/mercadopago-reconciliations') {
      reconciliationFilters.push(url.searchParams.get('orderId'));
      return json({ rows: [], nextBeforeOrderId: null, canReconcile: false });
    }
    return json([]);
  });
  return { paymentFilters, reconciliationFilters, orderOffsets, businessMutations };
}

for (const role of ['ADMIN', 'EMPLEADO'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 680 }]) {
    test(`conversation and its order keep the draft and return focus as ${role} at ${viewport.width}px`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      const fixture = await commercialFixture(context, role);
      await page.goto('/gestion-web/inicio');
      await page.getByRole('button', { name: /^Cliente recorrido/ }).press('Enter');
      const draft = page.getByRole('textbox', { name: 'Mensaje', exact: true });
      await expect(draft).toBeEditable();
      await draft.fill('Estoy revisando tu pedido y vuelvo enseguida.');
      if (viewport.width < 1280) {
        const historyButton = page.getByRole('button', { name: 'Historial', exact: true });
        const historyDialog = page.getByRole('dialog', { name: 'Historial del cliente', exact: true });
        await historyButton.press('Enter');
        await expect(historyDialog).toBeVisible();
        await expect(historyDialog.getByRole('button', { name: 'Cerrar historial', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(historyDialog).toBeHidden();
        await expect(historyButton).toBeFocused();
        await historyButton.press('Enter');
        await expect(historyDialog).toBeVisible();
      }
      const historyPanel = page.getByRole('complementary').filter({
        has: page.getByRole('heading', { name: 'Historial', exact: true }),
      });
      await expect(historyPanel.getByText('1 x Producto recorrido', { exact: true })).toBeVisible();
      const openOrder = historyPanel.getByRole('link', { name: 'Abrir pedido #21', exact: true });
      await expect(openOrder).toBeVisible();
      await openOrder.press('Enter');
      await expect(page.getByRole('heading', { name: '#21 · Pedido recorrido', exact: true })).toBeFocused();

      if (role === 'ADMIN') {
        await page.getByRole('link', { name: 'Ver pagos del pedido', exact: true }).press('Enter');
        await expect(page.getByRole('heading', { name: 'Validar Pagos', exact: true })).toBeFocused();
        await expect(page.getByText('Pedido #21', { exact: true })).toBeVisible();
        await expect(page.getByText('Cliente de otro pedido', { exact: true })).toHaveCount(0);
        await expect.poll(() => fixture.paymentFilters.length).toBeGreaterThan(0);
        await page.getByRole('button', { name: 'Por cobrar', exact: true }).press('Enter');
        await expect(page.getByText('Cobros y comprobantes manuales · 1 caso', { exact: true })).toBeVisible();
        expect(fixture.paymentFilters.every((value) => value === '21')).toBe(true);
        const reconciliation = page.getByRole('region', { name: 'Conciliación Mercado Pago' });
        await reconciliation.getByRole('button', { name: 'Ver registros', exact: true }).press('Enter');
        await expect.poll(() => fixture.reconciliationFilters.length).toBeGreaterThan(0);
        expect(fixture.reconciliationFilters.every((value) => value === '21')).toBe(true);
        await expect(reconciliation.getByRole('textbox', { name: 'Número de pedido', exact: true })).toHaveCount(0);
        await page.getByRole('link', { name: 'Volver al pedido', exact: true }).press('Enter');
        await expect(page.getByRole('heading', { name: '#21 · Pedido recorrido', exact: true })).toBeFocused();
      } else {
        await expect(page.getByRole('link', { name: 'Ver pagos del pedido', exact: true })).toHaveCount(0);
        await expect(page.getByText('La validación de pagos requiere un administrador.', { exact: true })).toBeVisible();
        expect(fixture.paymentFilters).toEqual([]);
      }

      await page.getByRole('link', { name: 'Volver a conversación', exact: true }).press('Enter');
      await expect(page).toHaveURL(new RegExp(`/gestion-web/inicio\\?chat=${chatId}`));
      await expect(draft).toHaveValue('Estoy revisando tu pedido y vuelvo enseguida.');
      await expect(draft).toBeFocused();
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      expect(fixture.businessMutations).toEqual([]);
    });
  }
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 680 }]) {
  test(`returning from order payments preserves the second list page at ${viewport.width}px`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const fixture = await commercialFixture(context, 'ADMIN');
    await page.goto('/dashboard/pedidos?pagina=2');
    await page.getByRole('link', { name: /#21 · Pedido recorrido/ }).press('Enter');
    await page.getByRole('link', { name: 'Ver pagos del pedido', exact: true }).press('Enter');
    await expect(page.getByText('Pedido #21', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Pedido #21', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Volver al pedido', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: '#21 · Pedido recorrido', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'Volver a pedidos', exact: true }).press('Enter');
    await expect(page).toHaveURL('/dashboard/pedidos?pagina=2');
    await expect(page.getByRole('link', { name: /#21 · Pedido recorrido/ })).toBeFocused();
    expect(fixture.orderOffsets.at(-1)).toBe(20);
    expect(fixture.paymentFilters.length).toBeGreaterThan(0);
    expect(fixture.paymentFilters.every((value) => value === '21')).toBe(true);
    expect(fixture.businessMutations).toEqual([]);
  });
}

test('an invalid payment order never falls back to the company-wide collection', async ({ page, context }) => {
  const fixture = await commercialFixture(context, 'ADMIN');
  await page.goto('/dashboard/pagos?pedido=basura');
  await expect(page.getByRole('alert')).toContainText('El identificador de pedido no es válido.');
  await expect(page.getByRole('link', { name: 'Volver a pedidos', exact: true })).toBeVisible();
  expect(fixture.paymentFilters).toEqual([]);
  expect(fixture.reconciliationFilters).toEqual([]);
});
