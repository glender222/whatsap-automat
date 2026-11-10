import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { provisionCompanies } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL;
test.skip(!backend || !process.env.STUDIO_FIXTURE_URL, 'Requires the local Studio verification backend and isolated PostgreSQL');

const graph = {
  entryNodeId: 'agent', policyRef: 'qa', nodes: [
    { id: 'agent', kind: 'agent', config: { provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', prompt: 'Contexto QA', maxTokens: 40 } },
    { id: 'end', kind: 'end', config: {} },
  ], edges: [{ id: 'finish', from: 'agent', to: 'end' }],
  limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10, maxModelTokens: 900000, maxCostMicroUsd: 700000 },
};

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

    const checkpointId = randomUUID();
    const checkpointUrl = process.env.STUDIO_FIXTURE_URL + '/checkpoint/' + checkpointId;
    const bravoSuite = { id: randomUUID(), name: 'Suite para cancelar', scenarios: [
      { id: 'settled', name: 'Caso iniciado', mockInput: 'Pausa QA ' + checkpointId, expectedTextPatterns: [checkpointId + '$'] },
      { id: 'pending', name: 'Caso pendiente', mockInput: 'No debe ejecutarse', expectedTextPatterns: ['ejecutarse$'] },
    ] };
    const suiteResponse = await request.post(`${apiPath}/${graphId}/evaluation-suites?version=1`, {
      headers: headers[1], data: bravoSuite,
    });
    expect(suiteResponse.status()).toBe(200);
    await bravo.page.reload();
    await bravo.panel.getByRole('combobox', { name: 'Suite para evaluar' }).selectOption(bravoSuite.id);
    const finished = bravo.page.waitForResponse((response) => response.url().endsWith('/evaluations?version=1') &&
      response.request().method() === 'POST');
    try {
      await bravo.panel.getByRole('button', { name: 'Evaluar revisión' }).press('Enter');
      await expect.poll(async () => (await request.get(checkpointUrl)).status(), { timeout: 5000 }).toBe(200);
      const cancelled = bravo.page.waitForResponse((response) => response.url().endsWith('/cancel?version=1') &&
        response.request().method() === 'POST');
      await bravo.panel.getByRole('button', { name: 'Cancelar evaluación' }).press('Enter');
      const cancellation = await cancelled;
      expect(cancellation.status()).toBe(200);
      const { runId } = await cancellation.json();
      await expect(bravo.panel.getByText('Evaluación cancelada', { exact: true })).toBeVisible();
      await expect(bravo.panel.getByText('El último caso iniciado aún no tiene un resultado confirmado.')).toBeVisible();
      const crossTenant = await request.post(`${apiPath}/${graphId}/evaluations/${runId}/cancel?version=1`, {
        headers: headers[0], data: {},
      });
      expect(crossTenant.status()).toBe(404);
    } finally {
      await request.post(checkpointUrl);
      await finished;
    }
    await expect(bravo.panel.getByRole('listitem')).toHaveText(['Caso 1 · Aprobado']);
    await expect(bravo.panel.getByRole('button', { name: 'Publicar en verificación' })).toBeDisabled();
    await bravo.page.reload();
    await bravo.panel.getByRole('button', { name: 'Consultar evaluación guardada' }).press('Enter');
    await expect(bravo.panel.getByText('Evaluación cancelada', { exact: true })).toBeVisible();
    await expect(bravo.panel.getByRole('listitem')).toHaveText(['Caso 1 · Aprobado']);

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

if (process.env.STUDIO_PROVIDER_FIXTURE === '1') {
  test('provider mode requires a company credential and runs its published revision from Studio', async ({ browser, request }) => {
    test.setTimeout(60_000);
    const companies = provisionCompanies('--studio', '--published-whatsapp', '--outbound');
    const graphId = 'qa-provider-' + randomUUID();
    const apiPath = `${backend}/api/v1/agent-graphs`;
    const pagePath = `/dashboard/ia/estudio/grafos/${graphId}`;
    const contexts = await Promise.all(companies.map(() => browser.newContext({ viewport: { width: 390, height: 720 } })));
    try {
      const [alpha, bravo] = await Promise.all(companies.map(async ({ auth }, index) => {
        const headers = { authorization: `Bearer ${auth.accessToken}` };
        const context = contexts[index];
        await context.addInitScript((session) => localStorage.setItem('auth', JSON.stringify(session)), auth);
        const page = await context.newPage();
        await page.goto('/dashboard/ia/estudio');
        await page.getByRole('link', { name: 'Nuevo grafo' }).click();
        await page.getByLabel('Identificador del grafo').fill(graphId);
        const template = page.getByRole('button', { name: 'Usar plantilla de texto' });
        await expect(template).toBeEnabled();
        await template.press('Enter');
        await expect(page.getByRole('status').filter({ hasText: 'Plantilla de texto cargada.' })).toBeVisible();
        const saved = page.waitForResponse((response) => response.url() === apiPath &&
          response.request().method() === 'POST', { timeout: 8000 });
        await page.getByRole('button', { name: 'Guardar borrador' }).press('Enter');
        const response = await saved;
        expect(response.status()).toBe(201);
        const draft = await response.json();
        const legacyKey = `studio-verification/${draft.tenantId}/${graphId}/1/${draft.specHash}`;
        const attempt = { runId: randomUUID(), suiteId: randomUUID() };
        await page.addInitScript(({ legacyKey, attempt }) => {
          sessionStorage.setItem(legacyKey, JSON.stringify(attempt));
        }, { legacyKey, attempt });
        await page.goto(pagePath);
        const panel = page.getByRole('region', { name: 'Evaluación y publicación' });
        await expect(panel.getByText(/Proveedor OpenAI/)).toBeVisible();
        await expect(panel.getByText(/Configura una credencial de OpenAI/)).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Evaluar revisión' })).toBeDisabled();
        await expect(panel.getByRole('button', { name: 'Consultar evaluación guardada' })).toHaveCount(0);
        return { page, panel, headers };
      }));

      await alpha.panel.getByText('Credencial de OpenAI', { exact: true }).click();
      const key = alpha.panel.getByLabel('Clave de API');
      await key.fill('fixture-studio-provider');
      await alpha.panel.getByRole('button', { name: 'Guardar credencial' }).press('Enter');
      await expect(alpha.panel.getByText('Credencial guardada.')).toBeVisible();
      await expect(key).toHaveValue('');
      await expect(alpha.panel.getByText(/Configura una credencial de OpenAI/)).toHaveCount(0);
      await alpha.panel.getByText('Crear suite de texto', { exact: true }).click();
      await alpha.panel.getByRole('textbox', { name: 'Nombre de la suite' }).fill('Suite proveedor Alfa');
      await alpha.panel.getByRole('textbox', { name: 'Entrada de prueba' }).fill('Entrada proveedor Alfa');
      await alpha.panel.getByRole('textbox', { name: 'Patrón esperado' }).fill('Entrada proveedor Alfa$');
      await alpha.panel.getByRole('button', { name: 'Agregar caso' }).press('Enter');
      const second = alpha.panel.getByRole('group', { name: 'Caso 2' });
      await second.getByRole('textbox', { name: 'Entrada de prueba' }).fill('Segundo caso Alfa');
      await second.getByRole('textbox', { name: 'Patrón esperado' }).fill('Segundo caso Alfa$');
      await alpha.panel.getByRole('button', { name: 'Guardar suite' }).press('Enter');
      const evaluate = alpha.panel.getByRole('button', { name: 'Evaluar revisión' });
      await expect(evaluate).toBeEnabled();
      const receipt = alpha.page.waitForResponse((response) => response.url().endsWith('/evaluations?version=1') &&
        response.request().method() === 'POST', { timeout: 12000 });
      await evaluate.press('Enter');
      const evaluation = await receipt;
      expect(evaluation.status()).toBe(200);
      const { runId, mode } = await evaluation.json();
      expect(mode).toBe('provider');
      await alpha.page.reload();
      await alpha.panel.getByRole('button', { name: 'Consultar evaluación guardada' }).press('Enter');
      await expect(alpha.panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
      await expect(alpha.panel.getByText(/Caso \d · Aprobado/)).toHaveCount(2);
      await alpha.panel.getByRole('button', { name: 'Publicar para proveedor' }).press('Enter');
      await expect(alpha.panel.getByText('Revisión activa para proveedor · 1')).toBeVisible();
      const bindingUrl = `${backend}/api/v1/ai/whatsapp-binding`;
      const whatsapp = alpha.panel.getByRole('region', { name: 'Revisión para WhatsApp' });
      await expect(whatsapp.getByText('Sin revisión vinculada.', { exact: true })).toBeVisible();
      const contact = '12025550145';
      const notifications: Record<string, unknown>[][] = [[], []];
      const inboxes = await Promise.all(contexts.map(async (context, index) => {
        const page = await context.newPage();
        page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string' || !payload.startsWith('42["agent:suggestion",')) return;
          const [, notification] = JSON.parse(payload.slice(2));
          notifications[index].push(notification);
        }));
        const initial = page.waitForResponse((response) => response.url().includes('/whatsapp-suggestions?conversationId='));
        await page.goto('/gestion-web/inicio?chat=' + contact);
        await expect(page.getByRole('region', { name: 'Historial de mensajes' })).toBeVisible();
        expect(await (await initial).json()).toEqual({ suggestion: null });
        return page;
      }));
      const bind = whatsapp.getByRole('button', { name: 'Vincular a WhatsApp' });
      await expect(bind).toBeEnabled();
      await bind.press('Enter');
      await expect(whatsapp.getByRole('status').filter({ hasText: `${graphId} · 1 · Sugerencias` })).toBeVisible();
      const inboundId = 'wamid.' + randomUUID();
      const texts = ['Consulta publicada de Alfa', 'Consulta sin vinculación de Bravo'];
      for (const [index, company] of companies.entries()) {
        const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
          metadata: { phone_number_id: company.phoneNumberId },
          messages: [{ id: inboundId, from: contact, timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: texts[index] } }],
        } }] }] });
        const signature = createHmac('sha256', process.env.META_APP_SECRET!).update(payload).digest('hex');
        const accepted = await request.post(backend + '/api/webhooks/meta/whatsapp', {
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + signature },
          data: payload,
        });
        expect(accepted.status()).toBe(200);
      }
      const suggestion = 'Resultado de prueba: ' + texts[0];
      await expect(inboxes[0].getByText(suggestion, { exact: true })).toBeVisible();
      await expect(inboxes[0].getByText('Sugerencia de la revisión publicada 1', { exact: true })).toBeVisible();
      await expect.poll(() => notifications[0].length).toBe(1);
      expect(notifications[0][0]).toMatchObject({ origin: { kind: 'published_graph', graphId, version: 1 } });
      expect(notifications[0][0]).not.toHaveProperty('reply');
      await expect(inboxes[1].getByRole('region', { name: 'Historial de mensajes' }).getByText(texts[1], { exact: true })).toBeVisible();
      await expect(inboxes[1].getByText(suggestion, { exact: true })).toHaveCount(0);
      expect(notifications[1]).toHaveLength(0);
      await inboxes[0].reload();
      await expect(inboxes[0].getByText(suggestion, { exact: true })).toBeVisible();
      await inboxes[0].getByRole('button', { name: 'Aceptar y editar' }).press('Enter');
      await expect(inboxes[0].getByRole('textbox', { name: 'Mensaje', exact: true })).toHaveValue(suggestion);
      const attempts = await request.get(`${process.env.PRODUCT_GRAPH_FIXTURE_URL}/attempts?line=${companies[0].phoneNumberId}`);
      expect(await attempts.json()).toEqual([]);

      const observed = await request.get(bindingUrl, { headers: alpha.headers });
      expect(observed.status()).toBe(200);
      const { binding } = await observed.json();
      const externalUpdate = await request.put(bindingUrl, {
        headers: alpha.headers, data: { graphId, version: binding.version, specHash: binding.specHash,
          mode: 'auto', expectedRevision: binding.revision },
      });
      expect(externalUpdate.status()).toBe(200);
      await whatsapp.getByRole('button', { name: 'Desvincular de WhatsApp' }).press('Enter');
      await expect(whatsapp.getByRole('alert')).toContainText('La vinculación o la publicación cambió.');
      await whatsapp.getByRole('button', { name: 'Volver a intentar' }).press('Enter');
      await expect(whatsapp.getByRole('status').filter({ hasText: `${graphId} · 1 · Respuestas automáticas` })).toBeVisible();
      const bravoBinding = await request.get(bindingUrl, { headers: bravo.headers });
      expect(await bravoBinding.json()).toEqual({ binding: null });
      await whatsapp.getByRole('button', { name: 'Desvincular de WhatsApp' }).press('Enter');
      await expect(whatsapp.getByText('Sin revisión vinculada.', { exact: true })).toBeVisible();

      await alpha.panel.getByRole('textbox', { name: 'Entrada para la revisión publicada' }).fill('Publicación Alfa');
      await alpha.panel.getByRole('button', { name: 'Ejecutar revisión publicada' }).press('Enter');
      await expect(alpha.panel.getByText('Resultado de prueba: Publicación Alfa')).toBeVisible();

      const executeUrl = `${apiPath}/${graphId}/execute?version=1`;
      const executeInput = alpha.panel.getByRole('textbox', { name: 'Entrada para la revisión publicada' });
      const lostInput = 'Prueba con acuse perdido Alfa';
      let originalAttempt: string | undefined;
      await alpha.page.route(executeUrl, async (route) => {
        originalAttempt = route.request().postDataJSON().attemptId;
        const response = await route.fetch();
        expect((await response.json()).execution.status).toBe('completed');
        await route.abort();
      }, { times: 1 });
      await executeInput.fill(lostInput);
      await alpha.panel.getByRole('button', { name: 'Ejecutar revisión publicada' }).press('Enter');
      await expect(alpha.panel.getByRole('alert')).toContainText('No pudimos confirmar la operación.');
      expect(originalAttempt).toBeTruthy();
      expect(await alpha.page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(lostInput);
      await alpha.page.reload();
      await expect(executeInput).toHaveValue('');
      await expect(alpha.panel.getByText('Hay una ejecución sin confirmar.')).toBeVisible();
      await executeInput.fill(lostInput);
      const replayed = alpha.page.waitForResponse((response) => response.url() === executeUrl &&
        response.request().method() === 'POST', { timeout: 8000 });
      await alpha.panel.getByRole('button', { name: 'Reintentar la misma ejecución' }).press('Enter');
      const replay = await replayed;
      expect(replay.request().postDataJSON().attemptId).toBe(originalAttempt);
      expect((await replay.json()).execution.status).toBe('not_dispatched');
      await expect(alpha.panel.getByRole('alert')).toContainText('Esta solicitud no generó otro envío.');
      await alpha.panel.getByRole('button', { name: 'Preparar una ejecución nueva' }).press('Enter');
      await expect(executeInput).toBeFocused();
      await expect(executeInput).toHaveValue('');
      await expect(alpha.panel.getByText('Hay una ejecución sin confirmar.')).toHaveCount(0);

      const foreign = await request.get(`${apiPath}/${graphId}/evaluations/${runId}?version=1`, { headers: bravo.headers });
      expect(foreign.status()).toBe(404);
      await bravo.page.reload();
      await expect(bravo.panel.getByText(/Configura una credencial de OpenAI/)).toBeVisible();
      await expect(bravo.panel.getByRole('button', { name: 'Evaluar revisión' })).toBeDisabled();
      await expect(bravo.panel.getByText(/Revisión activa para proveedor/)).toHaveCount(0);
      await expect(bravo.panel.getByText('Hay una ejecución sin confirmar.')).toHaveCount(0);

      await alpha.panel.getByText('Credencial de OpenAI', { exact: true }).click();
      await key.fill('fixture-studio-provider');
      await key.evaluate((input, auth) => {
        localStorage.setItem('auth', JSON.stringify(auth));
        (input as HTMLInputElement).form?.requestSubmit();
      }, companies[1].auth);
      await expect(alpha.panel.getByRole('alert')).toHaveText(/No pudimos confirmar la operación/);
      const bravoStatus = await request.get(`${apiPath}/${graphId}/execution?version=1`, { headers: bravo.headers });
      expect((await bravoStatus.json()).availability).toBe('credential_required');
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
