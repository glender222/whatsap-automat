import { expect, test, type BrowserContext } from '@playwright/test';
import type { PaymentProcessStatus, PaymentProcessSummary } from '../src/factures/dashboard/services/paymentsService';

const payment = (id: number, processStatus: PaymentProcessStatus): PaymentProcessSummary => ({
  rowId: `order:${id}`, rowType: 'payment_process', processStatus, orderId: id,
  voucherId: processStatus === 'collect_payment' ? null : id,
  orderStatus: 'reserved', voucherStatus: processStatus === 'collect_payment' ? null
    : processStatus === 'voucher_pending' ? 'pending' : processStatus,
  paymentMethod: null, amount: 20, orderTotal: 20, currency: 'PEN',
  customerName: `Cliente ${id}`, chatId: null, fileUrl: null, mimeType: null,
  uploadedAt: null, validatedAt: null, orderCreatedAt: null, items: [],
});

async function authenticate(context: BrowserContext) {
  await context.addInitScript(() => localStorage.setItem('auth', JSON.stringify({
    browserSessionId: 'qa-payment-pages', accessToken: 'qa-token', refreshToken: 'qa-refresh',
    user: { id: 'qa-user', nombre: 'Persona QA', rol: 'ADMIN', idPadre: null },
  })));
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 680 }]) {
  test(`finds older unpaid orders and pages the complete filtered collection at ${viewport.width}px`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await authenticate(context);
    // The unpaid orders are beyond the first 100 rows in the unfiltered collection.
    const records = [
      ...Array.from({ length: 100 }, (_, index) => payment(index + 1, 'validated')),
      ...Array.from({ length: 101 }, (_, index) => payment(index + 101, 'collect_payment')),
    ];
    await context.route(/\/(api|socket\.io)\//, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/payments') return route.fulfill({ json: { success: true, data: [] } });
      const status = url.searchParams.get('status');
      const processStatus = url.searchParams.get('processStatus');
      const filtered = records.filter((row) => (!status || row.voucherStatus === status)
        && (!processStatus || row.processStatus === processStatus));
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      return route.fulfill({ json: { success: true, data: {
        rows: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset,
      } } });
    });

    await page.goto('/dashboard/pagos');
    await expect(page.getByText('Cobros y comprobantes manuales · 201 casos')).toBeVisible();
    await expect(page.getByText('Cliente 101', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Por cobrar', exact: true }).click();
    await expect(page.getByText('Cliente 101', { exact: true })).toBeVisible();
    await expect(page.getByText('Cobros y comprobantes manuales · 101 casos')).toBeVisible();
    const pages = page.getByRole('navigation', { name: 'Páginas de pagos' });
    await expect(pages.getByRole('button', { name: 'Anterior', exact: true })).toBeDisabled();
    await pages.getByRole('button', { name: 'Siguiente', exact: true }).press('Enter');
    await expect(page.getByText('Cliente 201', { exact: true })).toBeVisible();
    await expect(page.getByText('Cliente 101', { exact: true })).toHaveCount(0);
    await expect(pages).toContainText('Página 2 de 2');
    await expect(pages.getByRole('button', { name: 'Siguiente', exact: true })).toBeDisabled();
    await pages.getByRole('button', { name: 'Anterior', exact: true }).press('Enter');
    await expect(page.getByText('Cliente 101', { exact: true })).toBeVisible();
    await pages.getByRole('button', { name: 'Siguiente', exact: true }).press('Enter');
    await expect(page.getByText('Cliente 201', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Validados', exact: true }).click();
    await expect(page.getByText('Cliente 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Cobros y comprobantes manuales · 100 casos')).toBeVisible();
    await expect(pages).toContainText('Página 1 de 1');
  });
}

test('a late payment page cannot replace the active filter', async ({ page, context }) => {
  await authenticate(context);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await context.route(/\/(api|socket\.io)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/payments') return route.fulfill({ json: { success: true, data: [] } });
    const offset = Number(url.searchParams.get('offset') || 0);
    const validated = url.searchParams.get('status') === 'validated';
    if (offset === 100) {
      started.resolve();
      await release.promise;
    }
    return route.fulfill({ json: { success: true, data: {
      rows: [payment(validated ? 999 : offset + 1, validated ? 'validated' : 'collect_payment')],
      total: validated ? 1 : 101, limit: 100, offset,
    } } });
  });
  await page.goto('/dashboard/pagos');
  const pages = page.getByRole('navigation', { name: 'Páginas de pagos' });
  const finished = page.waitForEvent('requestfinished', { predicate: (request) => request.url().includes('offset=100') });
  const aborted = page.waitForEvent('requestfailed', { predicate: (request) => request.url().includes('offset=100') });
  try {
    await pages.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await started.promise;
    await page.getByRole('button', { name: 'Validados', exact: true }).click();
    await expect(page.getByText('Cliente 999', { exact: true })).toBeVisible();
    release.resolve();
    await Promise.race([finished, aborted]);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('Cliente 101', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Cobros y comprobantes manuales · 1 caso')).toBeVisible();
    await expect(pages).toContainText('Página 1 de 1');
  } finally {
    release.resolve();
  }
});

test('validating the final voucher returns to the last available filtered page', async ({ page, context }) => {
  await authenticate(context);
  let records = Array.from({ length: 101 }, (_, index) => payment(index + 1, 'voucher_pending'));
  const offsets: number[] = [];
  await context.route(/\/(api|socket\.io)\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/payments/101/validate' && route.request().method() === 'POST') {
      records = records.filter((row) => row.voucherId !== 101);
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname !== '/api/payments') return route.fulfill({ json: { success: true, data: [] } });
    const offset = Number(url.searchParams.get('offset') || 0);
    offsets.push(offset);
    return route.fulfill({ json: { success: true, data: {
      rows: records.slice(offset, offset + 100), total: records.length, limit: 100, offset,
    } } });
  });
  await page.goto('/dashboard/pagos');
  await page.getByRole('button', { name: 'Con voucher', exact: true }).click();
  const pages = page.getByRole('navigation', { name: 'Páginas de pagos' });
  await pages.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await expect(page.getByText('Cliente 101', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Validar', exact: true }).click();
  await expect(page.getByText('Cliente 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Cobros y comprobantes manuales · 100 casos')).toBeVisible();
  await expect(pages).toContainText('Página 1 de 1');
  await expect(pages.getByRole('button', { name: 'Siguiente', exact: true })).toBeDisabled();
  expect(offsets.slice(-2)).toEqual([100, 0]);
});
