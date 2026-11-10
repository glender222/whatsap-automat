import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const backend = process.env.PRODUCT_SMOKE_URL;
const backendDirectory = fileURLToPath(new URL('../../WhatsaapWeb-JS/', import.meta.url));
test.skip(!backend, 'PRODUCT_SMOKE_URL points to the local approvals test application');

type Actor = { auth: { accessToken: string; user: { id: string } }; tenantId: string; password: string };
type Fixture = {
  admin: Actor; employee: Actor; other: Actor;
  ids: { queue: Array<{ id: string; toolName: string }>; pageTwo: string; responseLoss: string; sensitive: string; expiring: string; expired: string; foreign: string };
};

function provision(...args: string[]) {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/test/fixtures/browserApprovals.ts', ...args], {
    cwd: backendDirectory, encoding: 'utf8', timeout: 20_000,
  });
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

async function signIn(context: BrowserContext, actor: Actor) {
  await context.addInitScript((auth) => {
    localStorage.setItem('auth', JSON.stringify(auth));
    localStorage.setItem('app:theme', 'Oscuro');
  }, actor.auth);
}

async function openDecision(page: Page, id: string) {
  await page.goto(`/dashboard/aprobaciones/${id}`);
  await page.getByRole('button', { name: 'Aprobar solicitud', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Confirmar aprobación', exact: true });
  await expect(dialog.getByRole('button', { name: 'Volver', exact: true })).toBeFocused();
  return dialog;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 680 }]) {
  test(`the approval queue preserves filter page and return focus at ${viewport.width}px`, async ({ page, context }) => {
    const fixture = provision() as Fixture;
    await signIn(context, fixture.admin);
    await page.setViewportSize(viewport);
    await page.goto('/dashboard/aprobaciones');
    const risk = page.getByRole('combobox', { name: 'Nivel de riesgo' });
    await risk.selectOption('low');
    await page.getByRole('button', { name: 'Aplicar filtro', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Siguiente', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Página 2', exact: true })).toBeFocused();
    const item = fixture.ids.queue.find((candidate) => candidate.id === fixture.ids.pageTwo)!;
    const row = page.getByRole('link').filter({ hasText: item.toolName });
    await row.press('Enter');
    await expect(page.getByRole('heading', { name: item.toolName, exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'Volver a la cola', exact: true }).press('Enter');
    await expect(risk).toHaveValue('low');
    await expect(page.getByRole('heading', { name: 'Página 2', exact: true })).toBeVisible();
    await expect(row).toBeFocused();
    await page.reload();
    await expect(risk).toHaveValue('low');
    await expect(page.getByRole('heading', { name: 'Página 2', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('an approval expires while its mobile confirmation is open', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  await page.setViewportSize({ width: 390, height: 680 });
  let decisions = 0;
  page.on('request', (request) => { if (request.url().endsWith(`/${fixture.ids.expiring}/decision`)) decisions += 1; });
  const dialog = await openDecision(page, fixture.ids.expiring);
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('Vencida', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprobar solicitud', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
  expect(decisions).toBe(0);
});

test('expiry preserves focus and blocks decisions while the state query is unavailable', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  await page.setViewportSize({ width: 390, height: 680 });
  let reads = 0;
  let unavailable = true;
  await page.route(`${backend}/api/v1/approvals/${fixture.ids.expiring}`, (route) => {
    reads += 1;
    return unavailable && reads > 1 ? route.abort('failed') : route.continue();
  });
  const dialog = await openDecision(page, fixture.ids.expiring);
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText('No pudimos cargar el estado de esta solicitud.');
  await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Aprobar solicitud', exact: true })).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', { name: 'Actualizar estado', exact: true }).press('Enter');
  await expect(page.getByText('Vencida', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rejecting requires a reason and Escape returns focus without deciding', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  await page.setViewportSize({ width: 390, height: 680 });
  let decisions = 0;
  page.on('request', (request) => { if (request.url().endsWith(`/${fixture.ids.responseLoss}/decision`)) decisions += 1; });
  await page.goto(`/dashboard/aprobaciones/${fixture.ids.responseLoss}`);
  const reject = page.getByRole('button', { name: 'Rechazar solicitud', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Confirmar rechazo', exact: true });
  await reject.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Volver', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Confirmar rechazo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(reject).toBeFocused();
  expect(decisions).toBe(0);
  await reject.press('Enter');
  await dialog.getByRole('textbox', { name: 'Motivo de la decisión', exact: true }).fill('No corresponde ejecutar la operación sintética.');
  await dialog.getByRole('button', { name: 'Confirmar rechazo', exact: true }).press('Enter');
  await expect(page.getByText('Rechazada', { exact: true })).toBeVisible();
  expect(decisions).toBe(1);
});

test('a lost decision is retried with its exact key and reconciled after a committed response is lost', async ({ page, context, request }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  const keys: Array<string | undefined> = [];
  await page.route(`${backend}/api/v1/approvals/${fixture.ids.responseLoss}/decision`, async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length > 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
    }
    await route.abort('failed');
  });
  const dialog = await openDecision(page, fixture.ids.responseLoss);
  await dialog.getByRole('button', { name: 'Confirmar aprobación', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Reintentar la misma decisión', exact: true }).press('Enter');
  await expect(page.getByText('Aprobada', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reintentar la misma decisión', exact: true })).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  const persisted = await request.get(`${backend}/api/v1/approvals/${fixture.ids.responseLoss}`, {
    headers: { authorization: `Bearer ${fixture.admin.auth.accessToken}` },
  });
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toMatchObject({ status: 'approved', policyVersion: 2 });
});

test('sensitive decisions recover from an incorrect password without storing it', async ({ page, context }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  await page.setViewportSize({ width: 390, height: 680 });
  let dialog = await openDecision(page, fixture.ids.sensitive);
  await dialog.getByRole('textbox', { name: 'Motivo de la decisión', exact: true }).fill('Revisión de aprobación sintética.');
  await dialog.getByRole('checkbox').check();
  await dialog.getByLabel('Contraseña actual', { exact: true }).fill('incorrect-fixture-password');
  await dialog.getByRole('button', { name: 'Confirmar aprobación', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('No pudimos verificar tu contraseña.');
  await page.getByRole('button', { name: 'Aprobar solicitud', exact: true }).press('Enter');
  dialog = page.getByRole('dialog', { name: 'Confirmar aprobación', exact: true });
  await dialog.getByRole('textbox', { name: 'Motivo de la decisión', exact: true }).fill('Revisión de aprobación sintética.');
  await dialog.getByRole('checkbox').check();
  await dialog.getByLabel('Contraseña actual', { exact: true }).fill(fixture.admin.password);
  await dialog.getByRole('button', { name: 'Confirmar aprobación', exact: true }).press('Enter');
  await expect(page.getByText('Aprobada', { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(fixture.admin.password);
  expect(stored).not.toContain('incorrect-fixture-password');
});

test('employees and a different company cannot review the administrator approval', async ({ browser, request }) => {
  const fixture = provision() as Fixture;
  for (const [actor, status] of [[fixture.employee, 403], [fixture.other, 404]] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 680 } });
    try {
      await signIn(context, actor);
      const page = await context.newPage();
      await page.goto(`/dashboard/aprobaciones/${fixture.ids.responseLoss}`);
      if (status === 403) {
        await expect(page).toHaveURL('/gestion-web/inicio');
        await expect(page.getByRole('heading', { name: 'Bandeja de entrada', exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole('alert')).toContainText('La solicitud ya no está disponible en esta empresa.');
      }
      await expect(page.getByRole('button', { name: 'Aprobar solicitud', exact: true })).toHaveCount(0);
      const denied = await request.get(`${backend}/api/v1/approvals/${fixture.ids.responseLoss}`, {
        headers: { authorization: `Bearer ${actor.auth.accessToken}` },
      });
      expect(denied.status()).toBe(status);
    } finally {
      await context.close();
    }
  }
});

test('a revoked review permission is enforced at confirmation and can recover after access returns', async ({ page, context, request }) => {
  const fixture = provision() as Fixture;
  await signIn(context, fixture.admin);
  const dialog = await openDecision(page, fixture.ids.responseLoss);
  provision('--reviewer', fixture.admin.tenantId, fixture.admin.auth.user.id, 'disabled');
  try {
    await dialog.getByRole('button', { name: 'Confirmar aprobación', exact: true }).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Tu espacio de trabajo no tiene permiso' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aprobar solicitud', exact: true })).toHaveCount(0);
  } finally {
    provision('--reviewer', fixture.admin.tenantId, fixture.admin.auth.user.id, 'enabled');
  }
  await page.getByRole('button', { name: 'Actualizar estado', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Aprobar solicitud', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Tu espacio de trabajo no tiene permiso' })).toHaveCount(0);
  const persisted = await request.get(`${backend}/api/v1/approvals/${fixture.ids.responseLoss}`, {
    headers: { authorization: `Bearer ${fixture.admin.auth.accessToken}` },
  });
  expect(await persisted.json()).toMatchObject({ status: 'pending', policyVersion: 1 });
});
