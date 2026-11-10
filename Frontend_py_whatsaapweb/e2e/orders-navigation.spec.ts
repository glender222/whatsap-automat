import { expect, test } from '@playwright/test';

const ordersPath = '/dashboard/pedidos';
const secondPageOrder = {
  id: 21, companyId: 1, title: 'Pedido de la segunda página', status: 'draft',
  occurredAt: '2026-01-01T12:00:00Z', confirmedAt: null, reservedAt: null, notes: null, metadata: null, items: [],
};

for (const { role, viewport } of [
  { role: 'ADMIN', viewport: { width: 1280, height: 800 } },
  { role: 'EMPLEADO', viewport: { width: 390, height: 680 } },
]) {
  test(`regresa a la página del listado de pedidos como ${role}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await context.addInitScript((userRole) => {
      localStorage.setItem('auth', JSON.stringify({
        browserSessionId: 'qa-orders', accessToken: 'qa-token', refreshToken: 'qa-refresh',
        user: { id: 'qa-user', nombre: 'Persona QA', rol: userRole, idPadre: null },
      }));
      localStorage.setItem('app:theme', 'Oscuro');
    }, role);

    const offsets: number[] = [];
    const mutations: string[] = [];
    await context.route(/\/(api|socket\.io)\//, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/orders') && route.request().method() !== 'GET') {
        mutations.push(url.pathname);
        return route.fulfill({ status: 500 });
      }
      if (url.pathname === '/api/orders') {
        const offset = Number(url.searchParams.get('offset'));
        offsets.push(offset);
        const rows = offset === 20 ? [secondPageOrder] : Array.from({ length: 20 }, (_, index) => ({
          ...secondPageOrder, id: index + 1, title: `Pedido ${index + 1}`,
        }));
        return route.fulfill({ json: { success: true, data: { rows, total: 21 } } });
      }
      if (url.pathname === '/api/orders/21') {
        return route.fulfill({ json: { success: true, data: secondPageOrder } });
      }
      return route.fulfill({ json: { success: true, data: [] } });
    });

    await page.goto('/gestion-web/inicio');
    const navigation = page.getByRole('navigation', { name: 'Espacio de trabajo' });
    if (role === 'EMPLEADO') await page.getByRole('button', { name: 'Abrir navegación' }).press('Enter');
    await navigation.getByRole('link', { name: 'Pedidos', exact: true }).press('Enter');
    if (role === 'EMPLEADO') {
      await expect(navigation).toBeHidden();
      await expect(page.getByRole('heading', { level: 1, name: 'Pedidos' })).toBeFocused();
    }
    await page.getByRole('link', { name: 'Siguiente' }).press('Enter');
    await page.getByRole('link', { name: /Pedido de la segunda página/ }).press('Enter');
    await expect(page.getByRole('heading', { name: /Pedido de la segunda página/ })).toBeFocused();
    const confirm = page.getByRole('button', { name: 'Confirmar pedido', exact: true });
    await confirm.press('Enter');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Volver', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeFocused();
    expect(mutations).toEqual([]);
    await page.reload();

    await page.getByRole('link', { name: 'Volver a pedidos' }).press('Enter');
    await expect(page).toHaveURL(`${ordersPath}?pagina=2`);
    await expect(page.getByRole('link', { name: /Pedido de la segunda página/ })).toBeVisible();
    expect(offsets.at(-1)).toBe(20);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });
}
