import { expect, test } from '@playwright/test';

const inbox = '/gestion-web/inicio';

test.beforeEach(async ({ context }) => {
  await context.route(/\/(api|socket\.io)\//, (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await context.addInitScript(() => {
    if (!localStorage.getItem('auth')) {
      localStorage.setItem('auth', JSON.stringify({
        browserSessionId: 'qa-first',
        accessToken: 'qa-token',
        refreshToken: 'qa-refresh',
        user: { id: 'qa-user', nombre: 'Operador QA', rol: 'ADMIN', idPadre: null },
      }));
    }
    if (!localStorage.getItem('app:theme')) localStorage.setItem('app:theme', 'Oscuro');
  });
});

test('applies the theme before the React bundle loads', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto(inbox);
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('#root')).toBeEmpty();
});

test('applies the saved theme at startup and preserves changes across navigation and session changes', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(inbox);
  const root = page.locator('html');
  const navigation = page.getByRole('navigation', { name: 'Espacio de trabajo' });
  await expect(navigation).toBeVisible();
  await expect(root).toHaveClass(/\bdark\b/);

  await navigation.getByRole('link', { name: 'Configuración' }).click();
  const theme = page.getByRole('combobox', { name: 'Tema' });
  await expect(theme).toHaveValue('Oscuro');
  await theme.selectOption('Claro');
  await expect(root).not.toHaveClass(/\bdark\b/);
  await navigation.locator(`a[href="${inbox}"]`).click();
  await expect(page).toHaveURL(inbox);
  const originalNavigation = await navigation.elementHandle();

  const otherTab = await context.newPage();
  await otherTab.goto('/auth/login');
  await otherTab.evaluate(() => {
    const record = JSON.parse(localStorage.getItem('auth')!);
    localStorage.setItem('auth', JSON.stringify({ ...record, browserSessionId: 'qa-second' }));
  });
  await expect.poll(() => originalNavigation!.evaluate((element) => element.isConnected)).toBe(false);
  await navigation.getByRole('link', { name: 'Configuración' }).click();
  await expect(theme).toHaveValue('Claro');
  await expect(root).not.toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(theme).toHaveValue('Claro');
  await expect(root).not.toHaveClass(/\bdark\b/);
});

test('follows system color only in Sistema and synchronizes preferences between tabs', async ({ page, context }) => {
  await page.goto('/gestion-web/settings/general');
  const theme = page.getByRole('combobox', { name: 'Tema' });
  await theme.selectOption('Sistema');
  const root = page.locator('html');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveClass(/\bdark\b/);

  const otherTab = await context.newPage();
  await otherTab.goto('/gestion-web/settings/general');
  await otherTab.getByRole('combobox', { name: 'Tema' }).selectOption('Claro');
  await expect(theme).toHaveValue('Claro');
  await expect(root).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).not.toHaveClass(/\bdark\b/);
});

test('payment and reconciliation surfaces follow the workspace theme', async ({ page }) => {
  await page.route(/\/api\/payments(?:\?|$)/, (route) => route.fulfill({ json: {
    success: true, data: { rows: [], total: 0, limit: 50, offset: 0 },
  } }));
  await page.route(/\/api\/payments\/mercadopago-reconciliations(?:\?|$)/, (route) => route.fulfill({ json: {
    success: true, data: { rows: [], nextBeforeOrderId: null, canReconcile: false },
  } }));
  const navigation = page.getByRole('navigation', { name: 'Espacio de trabajo' });
  const payments = page.getByRole('region', { name: 'Comprobantes manuales' });
  const reconciliation = page.getByRole('region', { name: 'Conciliación Mercado Pago' });
  const paymentLink = navigation.getByRole('link', { name: 'Validación de pagos' });
  const configLink = navigation.getByRole('link', { name: 'Configuración' });

  await page.goto(inbox);
  await paymentLink.click();
  await reconciliation.getByRole('button', { name: 'Ver registros' }).click();
  const orderFilter = reconciliation.getByRole('textbox', { name: /pedido/i });
  await expect(orderFilter).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  for (const surface of [payments, reconciliation, orderFilter]) {
    await expect(surface).toHaveCSS('background-color', 'rgb(19, 27, 46)');
  }
  await expect(reconciliation.getByRole('heading')).toHaveCSS('color', 'rgb(248, 250, 252)');

  await configLink.click();
  await page.getByRole('combobox', { name: 'Tema' }).selectOption('Claro');
  await paymentLink.click();
  await reconciliation.getByRole('button', { name: 'Ver registros' }).click();
  for (const surface of [payments, reconciliation, orderFilter]) {
    await expect(surface).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  }
  await expect(reconciliation.getByRole('heading')).toHaveCSS('color', 'rgb(15, 23, 42)');
});
