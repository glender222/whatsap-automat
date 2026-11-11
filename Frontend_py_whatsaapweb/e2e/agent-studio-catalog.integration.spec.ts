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
        const graphUrl = `${backend}/api/v1/agent-graphs/${company.catalogGraphId}`;
        if (index === 0) {
          const lookupOnly = await request.post(`${graphUrl}/evaluation-suites?version=1`, {
            headers: { authorization: `Bearer ${company.auth.accessToken}` }, data: { id: crypto.randomUUID(), name: 'Solo búsqueda',
              profile: 'catalog-router-v1', scenarios: [{ id: 'lookup', name: 'Búsqueda', mockInput: 'Consultar el producto visible',
                expectedTextPatterns: ['Visible Alfa$'], expectedTools: ['catalog.search'] }] },
          });
          expect(lookupOnly.status()).toBe(200);
        }
        await context.addInitScript((session) => localStorage.setItem('auth', JSON.stringify(session)), company.auth);
        const page = await context.newPage();
        await page.goto(`/dashboard/ia/estudio/grafos/${company.catalogGraphId}`);
        const panel = page.getByRole('region', { name: 'Evaluación y publicación' });
        await panel.getByText('Credencial de OpenAI', { exact: true }).press('Enter');
        await panel.getByLabel('Clave de API').fill('fixture-studio-provider');
        await panel.getByRole('button', { name: 'Guardar credencial' }).press('Enter');
        await expect(panel.getByText('Credencial guardada.')).toBeVisible();
        const evaluate = panel.getByRole('button', { name: 'Evaluar revisión' });
        const publish = panel.getByRole('button', { name: 'Publicar para proveedor' });
        if (index === 0) {
          await expect(evaluate).toBeEnabled();
          await evaluate.press('Enter');
          await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
          await expect(publish).toBeDisabled();
          await expect(publish).toHaveAccessibleDescription(/La suite debe aprobar un caso/);
        }
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

        await expect(evaluate).toBeEnabled();
        const evaluated = page.waitForResponse((response) => response.url().endsWith('/evaluations?version=1') &&
          response.request().method() === 'POST');
        await evaluate.press('Enter');
        const response = await evaluated;
        expect(response.status()).toBe(200);
        const evidence = await response.json();
        expect(evidence).toMatchObject({ profile: 'catalog-router-v1', mode: 'provider', status: 'completed', passed: true,
          evidenceVersion: 'catalog-evaluation-v1', publicationAllowed: true, publicationEvidence: true });
        expect(evidence.scenarios.map((scenario: { executedTools: string[] }) => scenario.executedTools)).toEqual([['catalog.search'], []]);
        expect(new Set(evidence.scenarios.flatMap((scenario: { ledgerIds: number[] }) => scenario.ledgerIds)).size).toBe(4);
        expect(JSON.stringify(evidence)).not.toContain(`Producto de catálogo: Visible ${name}`);
        await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
        await expect(panel.getByText('Usó la búsqueda de catálogo.', { exact: true })).toBeVisible();
        await expect(panel.getByText('Sin herramientas ejecutadas.', { exact: true })).toBeVisible();
        await expect(publish).toBeEnabled();
        const published = page.waitForResponse((reply) => reply.url().endsWith('/publish?version=1') && reply.request().method() === 'POST');
        await publish.press('Enter');
        const publication = await published;
        expect(publication.status()).toBe(200);
        expect(await publication.json()).toMatchObject({ profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1',
          evaluationId: evidence.runId, executionAllowed: false, whatsappBindingAllowed: false });
        await expect(panel.getByRole('button', { name: 'Vincular a WhatsApp' })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Ejecutar revisión publicada' })).toHaveCount(0);
        await page.reload();
        await expect(panel.getByText('Revisión activa para proveedor · 1 · Catálogo', { exact: true })).toBeVisible();
        await panel.getByRole('button', { name: 'Consultar evaluación guardada' }).press('Enter');
        await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
        evaluations.push(evidence);
      }

      const [alpha, bravo] = companies;
      const graphUrl = `${backend}/api/v1/agent-graphs/${alpha.catalogGraphId}`;
      const headers = { authorization: `Bearer ${alpha.auth.accessToken}` };
      const denied = await request.post(`${graphUrl}/execute?version=1`, {
        headers, data: { attemptId: crypto.randomUUID(), input: 'Consulta de catálogo', timeoutMs: 4000 },
      });
      expect(denied.status()).toBe(409);
      const binding = await request.put(`${backend}/api/v1/ai/whatsapp-binding`, { headers, data: {
        graphId: alpha.catalogGraphId, version: 1, specHash: evaluations[0].specHash, mode: 'suggest', expectedRevision: null,
      } });
      expect(binding.status()).toBe(409);
      const foreign = await request.get(`${graphUrl}/evaluations/${evaluations[0].runId}?version=1`, {
        headers: { authorization: `Bearer ${bravo.auth.accessToken}` },
      });
      expect(foreign.status()).toBe(404);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
