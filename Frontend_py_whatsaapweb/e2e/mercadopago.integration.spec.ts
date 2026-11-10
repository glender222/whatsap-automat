import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const backend = process.env.PRODUCT_SMOKE_URL;
const provider = process.env.PRODUCT_MERCADOPAGO_FIXTURE_URL;
const backendDirectory = fileURLToPath(new URL('../../WhatsaapWeb-JS/', import.meta.url));
test.skip(!backend || !provider, 'Real App with local Mercado Pago provider is required');

type Actor = { auth: { accessToken: string; user: { companyId: number } } };
type Checkout = { orderId: number; companyId: number; intentId: string; providerOrderId: string; chatId: string };
type Fixture = { alpha: Actor; bravo: Actor; order: Checkout; unresolved: Checkout; foreign: Checkout };
type Snapshot = { order: { status: string }; reconciliation: null | {
  state: string; amount_paid: string; settled_at: string | null; review_code: string | null;
}; settlements: number };

function provision(...args: string[]) {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/test/fixtures/browserMercadoPago.ts', ...args], {
    cwd: backendDirectory, encoding: 'utf8', timeout: 25_000,
  });
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

function inspect(order: Checkout): Snapshot {
  return provision('--inspect', String(order.companyId), String(order.orderId));
}

async function remote(order: Checkout, patch: object) {
  const response = await fetch(`${provider}/fixtures/orders/${order.providerOrderId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

function credited(amount: string) {
  return { status: 'processed', status_detail: 'accredited', total_paid_amount: amount,
    transactions: { payments: [{ id: 'PAY01J49MMW3SSBK5PSV3DFR32957', status: 'processed', status_detail: 'accredited', amount, paid_amount: amount }] },
  };
}

async function signIn(context: BrowserContext, actor: Actor) {
  await context.addInitScript((auth) => {
    localStorage.setItem('auth', JSON.stringify(auth));
    localStorage.setItem('app:theme', 'Oscuro');
  }, actor.auth);
}

async function openLedger(page: Page, order: Checkout) {
  await page.goto(`/dashboard/pagos?pedido=${order.orderId}&paginaPedidos=2&chat=${order.chatId}`);
  await page.getByRole('button', { name: 'Ver registros', exact: true }).press('Enter');
  return page.getByRole('list', { name: 'Registros de conciliación' });
}

for (const width of [1280, 390]) {
  test(`partial settlement and refund persist with two isolated companies at ${width}px`, async ({ page, context, browser }) => {
    const fixture = provision() as Fixture;
    await signIn(context, fixture.alpha);
    await page.setViewportSize({ width, height: 800 });
    const ledger = await openLedger(page, fixture.order);
    const reconcile = ledger.getByRole('button', { name: `Consultar y conciliar el pedido #${fixture.order.orderId}` });
    await expect(ledger.getByText('Sin observación', { exact: true })).toBeVisible();
    await remote(fixture.order, { body: credited('5.25') });
    await reconcile.press('Enter');
    await expect(ledger.getByText('Pago parcial', { exact: true })).toBeVisible();
    expect(inspect(fixture.order)).toMatchObject({ order: { status: 'reserved' }, settlements: 0,
      reconciliation: { state: 'partial', amount_paid: '5.25', settled_at: null },
    });

    const otherContext = await browser.newContext();
    try {
      await signIn(otherContext, fixture.bravo);
      const other = await otherContext.newPage();
      await other.goto('/dashboard/pagos');
      await other.getByRole('button', { name: 'Ver registros', exact: true }).press('Enter');
      const otherLedger = other.getByRole('list', { name: 'Registros de conciliación' });
      await expect(otherLedger.getByText(`Pedido #${fixture.foreign.orderId}`, { exact: true })).toBeVisible();
      await expect(otherLedger.getByText(`Pedido #${fixture.order.orderId}`, { exact: true })).toHaveCount(0);
      const denied = await otherContext.request.post(`${backend}/api/payments/checkout-intents/${fixture.order.intentId}/reconcile`, {
        headers: { Authorization: `Bearer ${fixture.bravo.auth.accessToken}` }, data: {},
      });
      expect(denied.status()).toBe(404);
      expect(inspect(fixture.foreign)).toMatchObject({ order: { status: 'reserved' }, reconciliation: null, settlements: 0 });
    } finally { await otherContext.close(); }

    await remote(fixture.order, { body: credited('10.50') });
    await reconcile.press('Enter');
    await expect(ledger.getByText('Liquidado', { exact: true }).first()).toBeVisible();
    const settled = inspect(fixture.order);
    expect(settled).toMatchObject({ order: { status: 'confirmed' }, settlements: 1, reconciliation: { state: 'settled', amount_paid: '10.50' } });
    expect(settled.reconciliation?.settled_at).toBeTruthy();
    await reconcile.press('Enter');
    await expect(ledger.getByText('Consulta registrada. Liquidado.', { exact: true })).toBeVisible();
    expect(inspect(fixture.order).settlements).toBe(1);

    await remote(fixture.order, { body: { total_paid_amount: '0.00', status: 'refunded', status_detail: 'refunded',
      transactions: { refunds: [{ id: 'refund-fixture' }] },
    } });
    await reconcile.press('Enter');
    await expect(ledger.getByText('Requiere revisión', { exact: true })).toBeVisible();
    await expect(ledger.getByText('Cambió un pago que ya se había liquidado.', { exact: true })).toBeVisible();
    expect(inspect(fixture.order)).toMatchObject({ order: { status: 'confirmed' }, settlements: 1,
      reconciliation: { state: 'review_required', amount_paid: '0.00', settled_at: settled.reconciliation?.settled_at },
    });
    await page.reload();
    await page.getByRole('button', { name: 'Ver registros', exact: true }).press('Enter');
    await expect(ledger.getByText('Requiere revisión', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Volver al pedido', exact: true }).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/dashboard/pedidos\\?pedido=${fixture.order.orderId}&pagina=2&chat=${fixture.order.chatId}`));
  });
}

test('provider failure and a lost acknowledgement recover without a second settlement', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.alpha);
  const ledger = await openLedger(page, fixture.order);
  const reconcile = ledger.getByRole('button', { name: `Consultar y conciliar el pedido #${fixture.order.orderId}` });
  await remote(fixture.order, { unavailable: true, body: credited('10.50') });
  await reconcile.press('Enter');
  await expect(ledger.getByRole('alert')).toBeVisible();
  expect(inspect(fixture.order)).toMatchObject({ order: { status: 'reserved' }, settlements: 0 });
  await remote(fixture.order, { unavailable: false });
  let lost = false;
  await page.route(`${backend}/api/payments/checkout-intents/${fixture.order.intentId}/reconcile`, async (route) => {
    if (lost) return route.continue();
    lost = true;
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    await route.abort('failed');
  });
  await reconcile.press('Enter');
  await expect(ledger.getByRole('alert')).toBeVisible();
  expect(inspect(fixture.order)).toMatchObject({ settlements: 1, reconciliation: { state: 'settled' } });
  await page.getByRole('button', { name: 'Actualizar conciliación', exact: true }).press('Enter');
  await expect(ledger.getByText('Liquidado', { exact: true }).first()).toBeVisible();
  await expect(ledger.getByRole('alert')).toHaveCount(0);
  await reconcile.press('Enter');
  await expect(ledger.getByText('Consulta registrada. Liquidado.', { exact: true })).toBeVisible();
  expect(inspect(fixture.order).settlements).toBe(1);
});

test('an unresolved provider order is recoverable with keyboard on mobile', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.alpha);
  await page.setViewportSize({ width: 390, height: 740 });
  const ledger = await openLedger(page, fixture.unresolved);
  const reconcile = ledger.getByRole('button', { name: `Consultar y conciliar el pedido #${fixture.unresolved.orderId}` });
  await reconcile.press('Enter');
  const input = ledger.getByRole('textbox', { name: 'ID de la orden de Mercado Pago' });
  await expect(input).toBeFocused();
  await ledger.getByRole('button', { name: 'Cancelar', exact: true }).press('Enter');
  await expect(reconcile).toBeFocused();
  expect(inspect(fixture.unresolved)).toMatchObject({ settlements: 0, reconciliation: { state: 'awaiting_observation' } });
  await reconcile.press('Enter');
  await expect(input).toBeFocused();
  await input.fill(fixture.unresolved.providerOrderId);
  await input.press('Enter');
  await expect(ledger.getByText('Sin pago', { exact: true })).toBeVisible();
  await expect(reconcile).toBeFocused();
  await expect(ledger.getByText(fixture.unresolved.providerOrderId, { exact: true })).toBeVisible();
  expect(inspect(fixture.unresolved)).toMatchObject({ settlements: 0, reconciliation: { state: 'unpaid' } });
});
