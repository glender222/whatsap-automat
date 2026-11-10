import { expect, test } from '@playwright/test';

test('only the active payment filter can display a response', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('auth', JSON.stringify({
    browserSessionId: 'qa-payments', accessToken: 'qa-token', refreshToken: 'qa-refresh',
    user: { id: 'qa-user', nombre: 'Persona QA', rol: 'ADMIN', idPadre: null },
  })));
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rejectedAttempts = 0;
  const payment = (status: string, customerName: string) => ({
    rowId: status, rowType: 'voucher', processStatus: status, orderId: 21, voucherId: 44,
    orderStatus: 'reserved', voucherStatus: status === 'voucher_pending' ? 'pending' : status,
    paymentMethod: null, amount: 20, orderTotal: 20,
    currency: 'PEN', customerName, chatId: null, fileUrl: null, mimeType: null, uploadedAt: null,
    validatedAt: null, orderCreatedAt: null, items: [],
  });
  await context.route(/\/(api|socket\.io)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/payments') return route.fulfill({ json: { success: true, data: [] } });
    const status = url.searchParams.get('status');
    if (status === 'pending') {
      pending.resolve();
      await release.promise;
    }
    if (status === 'rejected' && ++rejectedAttempts === 1) return route.fulfill({ status: 503 });
    const rows = status === 'pending' ? [payment('voucher_pending', 'Voucher pendiente anterior')]
      : status === 'validated' ? [payment('validated', 'Voucher ya validado')]
      : status === 'rejected' ? [payment('rejected', 'Voucher rechazado')] : [];
    await route.fulfill({ json: { success: true, data: { rows, total: rows.length, limit: 100, offset: 0 } } });
  });

  await page.goto('/dashboard/pagos');
  await expect(page.getByText('No hay casos para este filtro.')).toBeVisible();
  const finished = page.waitForEvent('requestfinished', {
    predicate: (request) => request.url().includes('status=pending'),
  });
  const aborted = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().includes('status=pending'),
  });
  try {
    await page.getByRole('button', { name: 'Con voucher' }).click();
    await pending.promise;
    const validated = page.getByRole('button', { name: 'Validados', exact: true });
    await validated.click();
    await expect(page.getByText('Voucher ya validado')).toBeVisible();
    release.resolve();
    await Promise.race([finished, aborted]);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(validated).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Voucher pendiente anterior')).toHaveCount(0);
    await expect(page.getByText('Voucher ya validado')).toBeVisible();
  } finally {
    release.resolve();
  }

  await page.getByRole('button', { name: 'Rechazados', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('No se pudo cargar el proceso de pagos.');
  await expect(page.getByText('Voucher ya validado')).toHaveCount(0);
  await page.getByRole('button', { name: 'Volver a cargar pagos' }).click();
  await expect(page.getByText('Voucher rechazado')).toBeVisible();
  expect(rejectedAttempts).toBe(2);
});
