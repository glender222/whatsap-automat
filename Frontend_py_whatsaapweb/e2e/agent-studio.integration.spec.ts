import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { provisionCompanies, type Company } from './fixtures/provisionCompanies';
import { postWebhook } from './fixtures/metaWebhook';

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

test('Studio restores the draft list page and focus after reviewing a graph on mobile', async ({ page, request }) => {
  const [company] = provisionCompanies('--studio');
  const headers = { authorization: `Bearer ${company.auth.accessToken}` };
  const apiPath = `${backend}/api/v1/agent-graphs`;
  const studio = '/dashboard/ia/estudio';
  const target = 'qa-navigation-12';
  await Promise.all(Array.from({ length: 13 }, async (_, index) => {
    const graphId = `qa-navigation-${String(index).padStart(2, '0')}`;
    const created = await request.post(apiPath, { headers, data: { ...graph, graphId } });
    expect(created.status()).toBe(201);
  }));
  const revised = await request.post(`${apiPath}/${target}/revisions`, { headers, data: { ...graph, policyRef: 'qa-v2' } });
  expect(revised.status()).toBe(201);

  await page.setViewportSize({ width: 390, height: 680 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript((auth) => {
    localStorage.setItem('auth', JSON.stringify(auth));
    if (!localStorage.getItem('app:theme')) localStorage.setItem('app:theme', 'Oscuro');
  }, company.auth);
  await page.goto('/gestion-web/inicio');
  const theme = page.locator('html');
  await expect(theme).toHaveClass(/\bdark\b/);
  await page.getByRole('button', { name: 'Abrir navegación' }).press('Enter');
  await page.getByRole('navigation', { name: 'Espacio de trabajo' }).getByRole('link', { name: 'Agent Studio' }).press('Enter');
  await page.getByRole('button', { name: 'Siguiente página' }).press('Enter');
  await expect(theme).toHaveClass(/\bdark\b/);
  const pageTwo = `${studio}?after=qa-navigation-11`;
  await expect(page).toHaveURL(pageTwo);
  const card = page.getByRole('link', { name: new RegExp(target) });
  await card.press('Enter');
  const title = page.getByRole('heading', { name: target, exact: true });
  await expect(title).toBeFocused();
  await page.reload();
  await expect(title).toBeFocused();
  await expect(theme).toHaveClass(/\bdark\b/);
  await page.getByRole('link', { name: 'Anterior', exact: true }).press('Enter');
  await expect(page.getByText('Revisión 1 de 2', { exact: true })).toBeVisible();
  const edit = page.getByRole('link', { name: 'Crear revisión desde este borrador' });
  await edit.press('Enter');
  await page.getByRole('link', { name: 'Volver al grafo' }).press('Enter');
  await expect(page.getByText('Revisión 1 de 2', { exact: true })).toBeVisible();
  await edit.press('Enter');
  await page.getByRole('button', { name: 'Guardar borrador' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'El servidor guardó esta revisión.' })).toBeVisible();
  await page.getByRole('link', { name: 'Volver a Agent Studio' }).press('Enter');
  await expect(page).toHaveURL(pageTwo);
  await expect(card).toBeFocused();
  await expect(theme).toHaveClass(/\bdark\b/);
  const create = page.getByRole('link', { name: 'Nuevo grafo' });
  await create.press('Enter');
  await page.getByRole('link', { name: 'Volver a Agent Studio' }).press('Enter');
  await expect(page).toHaveURL(pageTwo);
  await expect(card).toBeVisible();
  await expect(create).toBeFocused();
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
      const inboundText = (id: string, body: string) => ({
        messages: [{ id, from: contact, timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text', text: { body } }],
      });
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
      const responseMode = whatsapp.getByRole('combobox', { name: 'Modo de respuesta en WhatsApp' });
      await expect(responseMode).toBeFocused();
      const revisions = [(await (await request.get(bindingUrl, { headers: alpha.headers })).json()).binding.revision];
      for (const [key, mode, label] of [['ArrowDown', 'auto', 'Respuestas automáticas'], ['ArrowUp', 'suggest', 'Sugerencias']]) {
        await responseMode.press(key);
        await expect(responseMode).toHaveValue(mode);
        await whatsapp.getByRole('button', { name: 'Actualizar modo de WhatsApp' }).press('Enter');
        await expect(whatsapp.getByRole('status').filter({ hasText: `${graphId} · 1 · ${label}` })).toBeVisible();
        await expect(responseMode).toBeFocused();
        revisions.push((await (await request.get(bindingUrl, { headers: alpha.headers })).json()).binding.revision);
      }
      expect(new Set(revisions).size).toBe(3);
      const pause = inboxes[0].getByRole('button', { name: 'Pausar IA', exact: true });
      await expect(pause).toBeEnabled();
      await pause.press('Enter');
      await expect(inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true })).toBeEnabled();
      await expect(inboxes[0].getByText('IA pausada en este chat.', { exact: true })).toBeVisible();
      await inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true }).press('Enter');
      await expect(pause).toBeEnabled();
      const inboundId = 'wamid.' + randomUUID();
      const texts = ['Consulta publicada de Alfa', 'Consulta sin vinculación de Bravo'];
      for (const [index, company] of companies.entries()) {
        await postWebhook(request, company, inboundText(inboundId, texts[index]));
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
      const composer = inboxes[0].getByRole('textbox', { name: 'Mensaje', exact: true });
      await composer.fill('Borrador manual que todavía no se envió');
      await pause.press('Enter');
      await expect(inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true })).toBeEnabled();
      await expect(inboxes[0].getByText('Sugerencia de la revisión publicada 1', { exact: true })).toHaveCount(0);
      await expect(composer).toHaveValue('Borrador manual que todavía no se envió');
      const suggestionAfterResume = inboxes[0].waitForResponse((response) =>
        response.url().includes('/whatsapp-suggestions?conversationId=') && response.ok());
      await inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true }).press('Enter');
      await expect(pause).toBeEnabled();
      expect(await (await suggestionAfterResume).json()).toEqual({ suggestion: null });
      await expect(inboxes[0].getByText('Sugerencia de la revisión publicada 1', { exact: true })).toHaveCount(0);
      const freshText = 'Consulta después de reanudar Alfa';
      await postWebhook(request, companies[0], inboundText('wamid.' + randomUUID(), freshText));
      const freshSuggestion = 'Resultado de prueba: ' + freshText;
      await expect(inboxes[0].getByText(freshSuggestion, { exact: true })).toBeVisible();
      await expect(inboxes[0].getByRole('button', { name: 'Aceptar y editar', exact: true })).toHaveCount(0);
      await inboxes[0].getByRole('button', { name: 'Reemplazar borrador', exact: true }).press('Enter');
      await expect(composer).toHaveValue(freshSuggestion);
      await expect(composer).toBeFocused();
      await expect(pause).toBeEnabled();
      await pause.press('Enter');
      await expect(inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true })).toBeEnabled();
      await expect(composer).toHaveValue(freshSuggestion);
      await inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true }).press('Enter');
      await expect(pause).toBeEnabled();
      await expect(inboxes[0].getByText('Sugerencia de la revisión publicada 1', { exact: true })).toHaveCount(0);
      expect(await inboxes[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      async function graphAttempts(company: Company): Promise<{ id: string; callback: string; to: string; type: string }[]> {
        const response = await request.get(`${process.env.PRODUCT_GRAPH_FIXTURE_URL}/attempts?line=${company.phoneNumberId}`);
        expect(response.status()).toBe(200);
        return response.json();
      }
      expect(await graphAttempts(companies[0])).toEqual([]);

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

      const automaticMode = await request.put(`${backend}/api/agents/company-mode`, {
        headers: alpha.headers, data: { mode: 'automator' },
      });
      expect(automaticMode.status()).toBe(200);
      const automaticText = 'Consulta para respuesta automática Alfa';
      const autoInboundId = 'wamid.' + randomUUID();
      const automaticInbound = inboundText(autoInboundId, automaticText);
      await postWebhook(request, companies[0], automaticInbound);
      await postWebhook(request, companies[0], automaticInbound);
      await postWebhook(request, companies[1], inboundText(autoInboundId, 'Consulta paralela Bravo'));
      const history = inboxes[0].getByRole('region', { name: 'Historial de mensajes' });
      const automaticReply = 'Resultado de prueba: ' + automaticText;
      const automaticMessage = history.locator('[data-history-message]').filter({ hasText: automaticReply });
      const delivery = automaticMessage.getByTestId('message-delivery-status');
      await expect(history.getByText(automaticText, { exact: true })).toHaveCount(1);
      await expect(automaticMessage).toHaveCount(1);
      await expect(delivery).toHaveText('Aceptado por WhatsApp');
      await expect(inboxes[1].getByRole('region', { name: 'Historial de mensajes' })
        .getByText('Consulta paralela Bravo', { exact: true })).toBeVisible();
      await expect(inboxes[1].getByText(automaticReply, { exact: true })).toHaveCount(0);
      const outbound = await graphAttempts(companies[0]);
      expect(outbound).toEqual([expect.objectContaining({ to: contact, type: 'text', callback: expect.stringMatching(/^automat:/) })]);
      expect(await graphAttempts(companies[1])).toEqual([]);

      const signedStatus = { id: outbound[0].id, recipient_id: contact,
        timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: outbound[0].callback };
      await postWebhook(request, companies[1], { statuses: [{ ...signedStatus, status: 'read' }] });
      await expect(delivery).toHaveText('Aceptado por WhatsApp');
      await postWebhook(request, companies[0], { statuses: [{ ...signedStatus, status: 'sent' }] });
      await expect(delivery).toHaveText('Enviado');
      await postWebhook(request, companies[0], { statuses: [{ ...signedStatus, status: 'read' }] });
      await expect(delivery).toHaveText('Leído');
      await postWebhook(request, companies[0], { statuses: [{ ...signedStatus, status: 'delivered' }] });
      await inboxes[0].reload();
      await expect(delivery).toHaveText('Leído');
      await expect(automaticMessage).toHaveCount(1);
      expect(await graphAttempts(companies[0])).toEqual(outbound);

      await whatsapp.getByRole('button', { name: 'Desvincular de WhatsApp' }).press('Enter');
      await expect(whatsapp.getByText('Sin revisión vinculada.', { exact: true })).toBeVisible();
      await expect(responseMode).toBeFocused();

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
