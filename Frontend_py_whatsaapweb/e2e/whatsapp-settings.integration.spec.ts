import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { provisionCompanies } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL;
const graph = process.env.PRODUCT_GRAPH_FIXTURE_URL;
test.skip(!backend || !graph, 'Requires the local product backend, Graph fixture and isolated PostgreSQL database');

async function openSettings(page: Page, mobile: boolean) {
  await page.goto('/gestion-web/inicio');
  if (mobile) await page.getByRole('button', { name: 'Abrir navegación', exact: true }).press('Enter');
  await page.getByRole('navigation', { name: 'Espacio de trabajo' }).getByRole('link', { name: 'Configuración', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'WhatsApp Business', exact: true })).toBeVisible();
}

test('WhatsApp setup, diagnostics, revocation and recovery remain scoped to each company', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const [alpha, bravo] = provisionCompanies();
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 390, height: 844 } }),
    browser.newContext({ viewport: { width: 1280, height: 800 } }),
  ]);
  const headers = (company: typeof alpha) => ({ authorization: 'Bearer ' + company.auth.accessToken });
  const control = async (state: 'authorized' | 'unauthorized' | 'unavailable') => {
    const response = await request.post(`${graph}/connection-fixture/${alpha.phoneNumberId}`, { data: { state } });
    expect(response.status()).toBe(200);
  };
  try {
    const [a, b] = await Promise.all(contexts.map(async (context, index) => {
      const company = index === 0 ? alpha : bravo;
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), company.auth);
      const page = await context.newPage();
      await openSettings(page, index === 0);
      await expect(page.getByRole('textbox', { name: 'Id. número de teléfono', exact: true })).toHaveValue(company.phoneNumberId);
      await page.getByLabel('Token permanente', { exact: true }).fill('synthetic-local-token');
      await page.getByRole('button', { name: 'Guardar conexión', exact: true }).press('Enter');
      await expect(page.getByRole('status').filter({ hasText: 'Datos de conexión guardados para esta empresa.' })).toBeVisible();
      await expect(page.getByLabel('Token permanente', { exact: true })).toHaveValue('');
      return page;
    }));

    const checkA = a.getByRole('button', { name: 'Comprobar conexión', exact: true });
    await expect(checkA).toBeVisible();
    await checkA.press('Enter');
    await expect(a.getByRole('status').filter({ hasText: 'Acceso a la línea confirmado por Meta.' })).toBeVisible();
    await b.getByRole('button', { name: 'Comprobar conexión', exact: true }).press('Enter');
    await expect(b.getByRole('status').filter({ hasText: 'Acceso a la línea confirmado por Meta.' })).toBeVisible();

    const connections = await request.get(`${backend}/api/v1/channel-connections`, { headers: headers(alpha) });
    expect(connections.status()).toBe(200);
    const connection = (await connections.json()).find((entry: { externalAccountId: string }) => entry.externalAccountId === alpha.phoneNumberId);
    expect(connection).toBeDefined();
    const foreignCheck = await request.post(`${backend}/api/v1/channel-connections/${encodeURIComponent(connection.id)}/validate`, {
      headers: { ...headers(bravo), 'x-tenant-id': connection.tenantId }, data: { tenantId: connection.tenantId },
    });
    expect(foreignCheck.status()).toBe(404);

    await control('unauthorized');
    await checkA.press('Enter');
    await expect(a.getByRole('alert')).toContainText('La credencial de Meta venció o fue revocada. Guarda un token autorizado y vuelve a comprobar.');
    await expect(b.getByRole('status').filter({ hasText: 'Acceso a la línea confirmado por Meta.' })).toBeVisible();
    await expect(b.getByRole('textbox', { name: 'Id. número de teléfono', exact: true })).toHaveValue(bravo.phoneNumberId);

    await a.getByLabel('Token permanente', { exact: true }).fill('synthetic-local-token');
    await a.getByRole('button', { name: 'Guardar conexión', exact: true }).press('Enter');
    await expect(a.getByRole('form', { name: 'Meta Cloud API', exact: true }).getByRole('alert'))
      .toContainText('La credencial no acredita acceso a esta línea. Revisa el ID, el token y sus permisos.');

    let disconnectAttempts = 0;
    await a.route(`${backend}/api/company/whatsapp/connection`, (route) => {
      if (route.request().method() === 'DELETE' && ++disconnectAttempts === 1) return route.fulfill({ status: 503, json: { success: false } });
      return route.continue();
    });

    const disconnect = a.getByRole('button', { name: 'Desconectar WhatsApp', exact: true });
    await disconnect.press('Enter');
    const dialog = a.getByRole('dialog', { name: 'Desconectar WhatsApp de esta empresa', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
    await a.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(disconnect).toBeFocused();
    await disconnect.press('Enter');
    await dialog.getByRole('button', { name: 'Desconectar', exact: true }).press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('No pudimos confirmar la desconexión. Actualiza la conexión antes de volver a intentar.');
    expect(disconnectAttempts).toBe(1);
    expect((await (await request.get(`${backend}/api/company/whatsapp/connection`, { headers: headers(alpha) })).json()).data.connection).not.toBeNull();
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).press('Enter');
    await a.getByRole('button', { name: 'Actualizar diagnóstico', exact: true }).press('Enter');
    await expect(disconnect).toBeEnabled();
    await disconnect.press('Enter');
    await dialog.getByRole('button', { name: 'Desconectar', exact: true }).press('Enter');
    await expect(a.getByRole('status').filter({ hasText: 'Conexión desconectada para esta empresa.' })).toBeVisible();
    expect(disconnectAttempts).toBe(2);
    await expect(a.getByText('Desconectado', { exact: true })).toBeVisible();
    await expect(a.getByLabel('Token permanente', { exact: true })).toHaveValue('');
    const afterDisconnect = await request.get(`${backend}/api/company/whatsapp/connection`, { headers: headers(alpha) });
    expect((await afterDisconnect.json()).data.connection).toBeNull();
    const untouched = await request.get(`${backend}/api/company/whatsapp/connection`, { headers: headers(bravo) });
    expect((await untouched.json()).data.connection.phoneNumberId).toBe(bravo.phoneNumberId);

    await control('authorized');
    await a.getByRole('textbox', { name: 'Id. número de teléfono', exact: true }).fill(alpha.phoneNumberId);
    await a.getByLabel('Token permanente', { exact: true }).fill('synthetic-local-token');
    await a.getByRole('button', { name: 'Guardar conexión', exact: true }).press('Enter');
    await expect(a.getByRole('status').filter({ hasText: 'Datos de conexión guardados para esta empresa.' })).toBeVisible();
    await checkA.press('Enter');
    await expect(a.getByRole('status').filter({ hasText: 'Acceso a la línea confirmado por Meta.' })).toBeVisible();

    await control('unavailable');
    await checkA.press('Enter');
    await expect(a.getByRole('alert')).toContainText('Meta no está disponible. Vuelve a comprobar la conexión.');
    await control('authorized');
    await checkA.press('Enter');
    await expect(a.getByRole('status').filter({ hasText: 'Acceso a la línea confirmado por Meta.' })).toBeVisible();
    for (const company of [alpha, bravo]) {
      const sent = await request.get(`${graph}/attempts?line=${company.phoneNumberId}`);
      expect(await sent.json()).toEqual([]);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('employees can inspect their company connection but cannot manage credentials or revoke it', async ({ browser, request }) => {
  const [alpha] = provisionCompanies();
  const credentials = { email: randomUUID() + '@example.invalid', password: randomUUID() };
  const created = await request.post(`${backend}/api/auth/create-station`, {
    headers: { authorization: 'Bearer ' + alpha.auth.accessToken }, data: { nombre: 'Operador de conexión', ...credentials },
  });
  expect(created.status()).toBe(200);
  const login = await request.post(`${backend}/api/auth/login`, { data: credentials });
  expect(login.status()).toBe(200);
  const auth = { ...(await login.json()).data, browserSessionId: randomUUID() };
  expect(auth.user.rol).toBe('EMPLEADO');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript((session) => localStorage.setItem('auth', JSON.stringify(session)), auth);
    const page = await context.newPage();
    await openSettings(page, true);
    await expect(page.getByText('Solo un administrador puede gestionar esta conexión.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Token permanente', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Guardar conexión', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Comprobar conexión', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Desconectar WhatsApp', exact: true })).toHaveCount(0);
    const headers = { authorization: 'Bearer ' + auth.accessToken };
    expect((await request.post(`${backend}/api/company/whatsapp/connection`, { headers,
      data: { phoneNumberId: alpha.phoneNumberId, accessToken: 'synthetic-local-token' },
    })).status()).toBe(403);
    expect((await request.delete(`${backend}/api/company/whatsapp/connection`, { headers })).status()).toBe(403);
    const list = await request.get(`${backend}/api/v1/channel-connections`, { headers });
    expect(list.status()).toBe(200);
    const connection = (await list.json()).find((entry: { externalAccountId: string }) => entry.externalAccountId === alpha.phoneNumberId);
    expect((await request.post(`${backend}/api/v1/channel-connections/${encodeURIComponent(connection.id)}/validate`, { headers, data: {} })).status()).toBe(403);
  } finally {
    await context.close();
  }
});

test('switching companies discards credential drafts and ignores the previous overview response', async ({ browser }) => {
  const [alpha, bravo] = provisionCompanies();
  const context = await browser.newContext();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), alpha.auth);
    const page = await context.newPage();
    await openSettings(page, false);
    await expect(page.getByRole('textbox', { name: 'Id. número de teléfono', exact: true })).toHaveValue(alpha.phoneNumberId);
    await page.getByLabel('Token permanente', { exact: true }).fill('synthetic-draft-alpha');
    await page.route(`${backend}/api/company/me`, async (route) => {
      if (route.request().headers().authorization !== 'Bearer ' + alpha.auth.accessToken) return route.continue();
      const response = await route.fetch();
      started.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Actualizar diagnóstico', exact: true }).click();
    await started.promise;
    const otherTab = await context.newPage();
    await otherTab.goto('/auth/login');
    await otherTab.evaluate((auth) => localStorage.setItem('auth', JSON.stringify(auth)), bravo.auth);
    await expect(page.getByRole('textbox', { name: 'Id. número de teléfono', exact: true })).toHaveValue(bravo.phoneNumberId);
    release.resolve();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('textbox', { name: 'Id. número de teléfono', exact: true })).toHaveValue(bravo.phoneNumberId);
    await expect(page.getByLabel('Token permanente', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-draft-alpha');
  } finally {
    release.resolve();
    await context.close();
  }
});
