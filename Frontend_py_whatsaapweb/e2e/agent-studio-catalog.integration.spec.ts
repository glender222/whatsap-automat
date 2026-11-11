import { expect, test } from '@playwright/test';
import { provisionCompanies } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL;

if (process.env.STUDIO_PROVIDER_FIXTURE === '1') {
  test('provider mode evaluates catalog evidence from Studio for each company', async ({ browser, request }) => {
    test.setTimeout(60_000);
    test.skip(!backend || !process.env.STUDIO_FIXTURE_URL, 'Requires the local provider and isolated PostgreSQL');
    const companies = provisionCompanies('--studio', '--catalog-studio');
    const contexts = await Promise.all(companies.map(() => browser.newContext({ viewport: { width: 390, height: 720 } })));
    try {
      const evaluations = [];
      for (const [index, company] of companies.entries()) {
        const name = index === 0 ? 'Alfa' : 'Bravo';
        const context = contexts[index];
        await context.addInitScript((session) => localStorage.setItem('auth', JSON.stringify(session)), company.auth);
        const page = await context.newPage();
        await page.goto(`/dashboard/ia/estudio/grafos/${company.catalogGraphId}`);
        const panel = page.getByRole('region', { name: 'Evaluación y publicación' });
        await panel.getByText('Credencial de OpenAI', { exact: true }).press('Enter');
        await panel.getByLabel('Clave de API').fill('fixture-studio-provider');
        await panel.getByRole('button', { name: 'Guardar credencial' }).press('Enter');
        await expect(panel.getByText('Credencial guardada.')).toBeVisible();
        await panel.getByText('Crear suite de catálogo', { exact: true }).press('Enter');
        await panel.getByLabel('Nombre de la suite').fill(`Suite de catálogo ${name}`);
        const lookup = panel.getByRole('group', { name: 'Caso 1' });
        await lookup.getByLabel('Entrada de prueba').fill('Consultar el producto visible');
        await lookup.getByLabel('Patrón esperado').fill(`Visible ${name}$`);
        await expect(panel.getByRole('button', { name: 'Guardar suite' })).toBeDisabled();
        await lookup.getByLabel('Búsqueda de catálogo').selectOption('required');
        await panel.getByRole('button', { name: 'Agregar caso' }).press('Enter');
        const direct = panel.getByRole('group', { name: 'Caso 2' });
        await expect(direct.getByLabel('Entrada de prueba')).toBeFocused();
        await direct.getByLabel('Entrada de prueba').fill('Saludo de prueba');
        await direct.getByLabel('Patrón esperado').fill('Saludo de prueba$');
        await direct.getByLabel('Búsqueda de catálogo').selectOption('forbidden');
        await expect(panel.getByRole('button', { name: 'Agregar caso' })).toBeDisabled();
        await panel.getByRole('button', { name: 'Guardar suite' }).press('Enter');

        const evaluate = panel.getByRole('button', { name: 'Evaluar revisión' });
        await expect(evaluate).toBeEnabled();
        const evaluated = page.waitForResponse((response) => response.url().endsWith('/evaluations?version=1') &&
          response.request().method() === 'POST');
        await evaluate.press('Enter');
        const response = await evaluated;
        expect(response.status()).toBe(200);
        const evidence = await response.json();
        expect(evidence).toMatchObject({ profile: 'catalog-router-v1', mode: 'provider', status: 'completed', passed: true,
          publicationAllowed: false, publicationEvidence: false });
        expect(evidence.scenarios.map((scenario: { executedTools: string[] }) => scenario.executedTools)).toEqual([['catalog.search'], []]);
        expect(new Set(evidence.scenarios.flatMap((scenario: { ledgerIds: number[] }) => scenario.ledgerIds)).size).toBe(4);
        expect(JSON.stringify(evidence)).not.toContain(`Producto de catálogo: Visible ${name}`);
        await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
        await expect(panel.getByText('Usó la búsqueda de catálogo.', { exact: true })).toBeVisible();
        await expect(panel.getByText('Sin herramientas ejecutadas.', { exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Publicar para proveedor' })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Vincular a WhatsApp' })).toHaveCount(0);
        await page.reload();
        await panel.getByRole('button', { name: 'Consultar evaluación guardada' }).press('Enter');
        await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
        evaluations.push(evidence);
      }

      const [alpha, bravo] = companies;
      const graphUrl = `${backend}/api/v1/agent-graphs/${alpha.catalogGraphId}`;
      const denied = await request.post(`${graphUrl}/publish?version=1`, {
        headers: { authorization: `Bearer ${alpha.auth.accessToken}` }, data: { evaluationId: evaluations[0].runId },
      });
      expect(denied.status()).toBe(409);
      const foreign = await request.get(`${graphUrl}/evaluations/${evaluations[0].runId}?version=1`, {
        headers: { authorization: `Bearer ${bravo.auth.accessToken}` },
      });
      expect(foreign.status()).toBe(404);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
