import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { provisionCompanies } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL;
test.skip(!backend || !process.env.STUDIO_FIXTURE_URL, 'Requires the local Studio verification backend and isolated PostgreSQL');

test('two workspaces evaluate, publish and execute only their verified revision', async ({ browser, request }) => {
  const companies = provisionCompanies('--studio');
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 800 } }),
    browser.newContext({ viewport: { width: 390, height: 680 } }),
  ]);
  const graphId = 'qa-' + randomUUID();
  const apiPath = `${backend}/api/v1/agent-graphs`;
  const pagePath = `/dashboard/ia/estudio/grafos/${graphId}`;
  const headers = companies.map((company) => ({ authorization: `Bearer ${company.auth.accessToken}` }));
  const graph = {
    entryNodeId: 'agent', policyRef: 'qa', nodes: [
      { id: 'agent', kind: 'agent', config: { provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', prompt: 'Contexto QA', maxTokens: 40 } },
      { id: 'end', kind: 'end', config: {} },
    ], edges: [{ id: 'finish', from: 'agent', to: 'end' }],
    limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10, maxModelTokens: 900000, maxCostMicroUsd: 700000 },
  };
  try {
    const [alpha, bravo] = await Promise.all(contexts.map(async (context, index) => {
      const response = await request.post(apiPath, { headers: headers[index], data: { ...graph, graphId } });
      expect(response.status()).toBe(201);
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), companies[index].auth);
      const page = await context.newPage();
      await page.goto(pagePath);
      const panel = page.getByRole('region', { name: 'Evaluación y publicación' });
      await expect(panel.getByText(/Entorno de verificación/)).toBeVisible();
      await panel.getByText('Crear suite de texto', { exact: true }).click();
      await panel.getByRole('textbox', { name: 'Nombre de la suite' }).fill(index === 0 ? 'Suite Alfa' : 'Suite Bravo');
      await panel.getByRole('textbox', { name: 'Entrada de prueba' }).fill(index === 0 ? 'Entrada Alfa' : 'Entrada Bravo');
      await panel.getByRole('textbox', { name: 'Patrón esperado' }).fill(index === 0 ? 'Entrada Alfa$' : '^No coincide$');
      if (index === 0) {
        await panel.getByRole('button', { name: 'Agregar caso' }).click();
        await panel.getByRole('group', { name: 'Caso 2' }).getByRole('textbox', { name: 'Entrada de prueba' }).fill('Segundo caso');
        await panel.getByRole('group', { name: 'Caso 2' }).getByRole('textbox', { name: 'Patrón esperado' }).fill('Segundo caso$');
      }
      await panel.getByRole('button', { name: 'Guardar suite' }).click();
      const evaluate = panel.getByRole('button', { name: 'Evaluar revisión' });
      await expect(evaluate).toBeEnabled();
      const receipt = page.waitForResponse((result) => result.url().includes('/evaluations?version=1') && result.request().method() === 'POST');
      await evaluate.press('Enter');
      const evaluation = await receipt;
      expect(evaluation.status()).toBe(200);
      return { page, panel, runId: (await evaluation.json()).runId };
    }));

    await expect(bravo.panel.getByText('Evaluación sin aprobación', { exact: true })).toBeVisible();
    await expect(bravo.panel.getByRole('button', { name: 'Publicar en verificación' })).toBeDisabled();
    await expect(bravo.panel.getByRole('option', { name: /Suite Alfa/ })).toHaveCount(0);
    await expect(alpha.panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
    await expect(alpha.panel.getByText(/Caso \d · Aprobado/)).toHaveCount(2);
    const foreign = await request.get(`${apiPath}/${graphId}/evaluations/${alpha.runId}?version=1`, { headers: headers[1] });
    expect(foreign.status()).toBe(404);

    await alpha.page.reload();
    await alpha.panel.getByRole('button', { name: 'Consultar evaluación guardada' }).click();
    await expect(alpha.panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
    await alpha.panel.getByRole('button', { name: 'Publicar en verificación' }).press('Enter');
    await expect(alpha.panel.getByText('Revisión activa en verificación · 1', { exact: true })).toBeVisible();
    await alpha.panel.getByRole('textbox', { name: 'Entrada para la revisión publicada' }).fill('Ejecución Alfa');
    await alpha.panel.getByRole('button', { name: 'Ejecutar revisión publicada' }).press('Enter');
    await expect(alpha.panel.getByText('Resultado de prueba: Ejecución Alfa', { exact: true })).toBeVisible();
    await expect(bravo.panel.getByRole('button', { name: 'Ejecutar revisión publicada' })).toHaveCount(0);

    const revision = await request.post(`${apiPath}/${graphId}/revisions`, { headers: headers[0], data: {
      ...graph, policyRef: 'qa-v2', nodes: [{ ...graph.nodes[0], config: { ...graph.nodes[0].config, model: 'gpt-4o-mini' } }, graph.nodes[1]],
    } });
    expect(revision.status()).toBe(201);
    await alpha.page.goto(`${pagePath}?version=2`);
    await expect(alpha.panel.getByText('Revisión activa en verificación · 1', { exact: true })).toBeVisible();
    await expect(alpha.panel.getByRole('button', { name: 'Ejecutar revisión publicada' })).toHaveCount(0);
    await expect(alpha.panel.getByRole('button', { name: 'Evaluar revisión' })).toBeDisabled();
    await expect(alpha.panel.getByText(/Esta revisión requiere un grafo de texto compatible/)).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
