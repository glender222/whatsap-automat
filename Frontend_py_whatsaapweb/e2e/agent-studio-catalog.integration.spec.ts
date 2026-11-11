import { expect, test } from '@playwright/test';
import { postWebhook } from './fixtures/metaWebhook';
import { provisionCompanies, type Company } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL;

if (process.env.STUDIO_PROVIDER_FIXTURE === '1') {
  test('provider mode publishes and links catalog revisions for each company', async ({ browser, request }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(!backend || !process.env.STUDIO_FIXTURE_URL || !process.env.PRODUCT_GRAPH_FIXTURE_URL,
      'Requires the local provider, Graph and isolated PostgreSQL');
    const companies = provisionCompanies('--studio', '--catalog-studio', '--published-whatsapp', '--outbound');
    const contexts = await Promise.all(companies.map(() => browser.newContext({ viewport: { width: 390, height: 720 } })));
    try {
      const evaluations = [];
      const studioPages = [];
      const publications = [];
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

        async function evaluateSelectedSuite() {
          await expect(evaluate).toBeEnabled();
          const evaluated = page.waitForResponse((response) => response.url().endsWith('/evaluations?version=1') &&
            response.request().method() === 'POST');
          await evaluate.press('Enter');
          const response = await evaluated;
          expect(response.status()).toBe(200);
          const evidence = await response.json();
          expect(evidence).toMatchObject({ profile: 'catalog-router-v1', mode: 'provider', status: 'completed', passed: true,
            evidenceVersion: 'catalog-evaluation-v1', publicationAllowed: true, publicationEvidence: true });
          return evidence;
        }
        let evidence = await evaluateSelectedSuite();
        if (index === 0) {
          const companyMode = (mode: string) => request.put(`${backend}/api/agents/company-mode`, {
            headers: { authorization: `Bearer ${company.auth.accessToken}` }, data: { mode },
          });
          await expect(publish).toBeEnabled();
          expect((await companyMode('normal')).status()).toBe(200);
          const rejected = page.waitForResponse((reply) => reply.url().endsWith('/publish?version=1') && reply.request().method() === 'POST');
          await publish.press('Enter');
          expect((await rejected).status()).toBe(409);
          await expect(publish).toBeDisabled();
          await expect(publish).toHaveAccessibleDescription(/Cambió la autorización de la empresa/);
          await expect(panel.getByText(/Cambió la autorización de la empresa/)).toBeFocused();
          expect((await companyMode('mixed')).status()).toBe(200);
          const revokedRunId = evidence.runId;
          evidence = await evaluateSelectedSuite();
          expect(evidence.runId).not.toBe(revokedRunId);
        }
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
        const receipt = await publication.json();
        expect(receipt).toMatchObject({ profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1',
          evaluationId: evidence.runId, executionAllowed: false, whatsappBindingAllowed: true });
        const binding = panel.getByRole('region', { name: 'Revisión para WhatsApp' });
        const bind = binding.getByRole('button', { name: 'Vincular a WhatsApp' });
        await expect(bind).toBeEnabled();
        await bind.press('Enter');
        await expect(binding.getByRole('status').filter({ hasText: `${company.catalogGraphId} · 1 · Sugerencias · Catálogo` })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Ejecutar revisión publicada' })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (index === 0) await testInfo.attach('Catálogo publicado y vinculado en móvil', {
          body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
        });
        await page.reload();
        await expect(panel.getByText('Revisión activa para proveedor · 1 · Catálogo', { exact: true })).toBeVisible();
        await panel.getByRole('button', { name: 'Consultar evaluación guardada' }).press('Enter');
        await expect(panel.getByText('Evaluación aprobada', { exact: true })).toBeVisible();
        evaluations.push(evidence);
        studioPages.push(page);
        publications.push(receipt);
      }

      const [alpha, bravo] = companies;
      const graphUrl = `${backend}/api/v1/agent-graphs/${alpha.catalogGraphId}`;
      const headers = { authorization: `Bearer ${alpha.auth.accessToken}` };
      const denied = await request.post(`${graphUrl}/execute?version=1`, {
        headers, data: { attemptId: crypto.randomUUID(), input: 'Consulta de catálogo', timeoutMs: 4000 },
      });
      expect(denied.status()).toBe(409);
      const foreign = await request.get(`${graphUrl}/evaluations/${evaluations[0].runId}?version=1`, {
        headers: { authorization: `Bearer ${bravo.auth.accessToken}` },
      });
      expect(foreign.status()).toBe(404);

      const contact = '12025550145';
      const notifications: Record<string, unknown>[][] = [[], []];
      const inboxes = await Promise.all(contexts.map(async (context, index) => {
        const page = await context.newPage();
        let joined = false;
        page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return;
          if (payload.startsWith('42["conversation_joined",')) {
            const [, reply] = JSON.parse(payload.slice(2));
            if (reply.success && reply.room.endsWith(`:${contact}`)) joined = true;
          }
          if (payload.startsWith('42["agent:suggestion",')) {
            const [, notification] = JSON.parse(payload.slice(2));
            notifications[index].push(notification);
          }
        }));
        await page.goto('/gestion-web/inicio?chat=' + contact);
        await expect(page.getByRole('region', { name: 'Historial de mensajes' })).toBeVisible();
        await expect.poll(() => joined).toBe(true);
        return page;
      }));
      const inbound = (id: string, body: string) => ({ messages: [{ id, from: contact, type: 'text',
        timestamp: String(Math.floor(Date.now() / 1000)), text: { body } }] });
      const sharedId = 'wamid.' + crypto.randomUUID();
      for (const [index, company] of companies.entries()) {
        await postWebhook(request, company, inbound(sharedId, `Consultar catálogo ${index === 0 ? 'Alfa' : 'Bravo'}`));
      }
      const expected = ['Producto de catálogo: Visible Alfa', 'Producto de catálogo: Visible Bravo'];
      async function graphAttempts(company: Company): Promise<{ id: string; callback: string; to: string; type: string }[]> {
        const response = await request.get(`${process.env.PRODUCT_GRAPH_FIXTURE_URL}/attempts?line=${company.phoneNumberId}`);
        expect(response.status()).toBe(200);
        return response.json();
      }
      for (const [index, inbox] of inboxes.entries()) {
        await expect(inbox.getByText('Sugerencia de catálogo · revisión 1', { exact: true })).toBeVisible();
        await expect(inbox.getByText(expected[index], { exact: true })).toBeVisible();
        await expect(inbox.getByText(expected[1 - index], { exact: true })).toHaveCount(0);
        await expect.poll(() => notifications[index].length).toBe(1);
        expect(notifications[index][0]).toMatchObject({ origin: { kind: 'published_graph', graphId: companies[index].catalogGraphId,
          profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1', evidenceHash: publications[index].evidenceHash } });
        expect(notifications[index][0]).not.toHaveProperty('reply');
        expect(await graphAttempts(companies[index])).toEqual([]);
      }

      expect(await inboxes[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await testInfo.attach('Sugerencia del catálogo en Bandeja móvil', {
        body: await inboxes[0].screenshot({ fullPage: true }), contentType: 'image/png',
      });
      await inboxes[0].reload();
      await expect(inboxes[0].getByText(expected[0], { exact: true })).toBeVisible();
      const pause = inboxes[0].getByRole('button', { name: 'Pausar IA', exact: true });
      await pause.press('Enter');
      const resume = inboxes[0].getByRole('button', { name: 'Reanudar IA', exact: true });
      await expect(resume).toBeEnabled();
      await expect(inboxes[0].getByText(expected[0], { exact: true })).toHaveCount(0);
      const afterResume = inboxes[0].waitForResponse((response) =>
        response.url().includes('/whatsapp-suggestions?conversationId=') && response.ok());
      await resume.press('Enter');
      await expect(pause).toBeEnabled();
      expect(await (await afterResume).json()).toEqual({ suggestion: null });

      const alphaBinding = studioPages[0].getByRole('region', { name: 'Revisión para WhatsApp' });
      await alphaBinding.getByRole('combobox', { name: 'Modo de respuesta en WhatsApp' }).selectOption('auto');
      await alphaBinding.getByRole('button', { name: 'Actualizar modo de WhatsApp' }).press('Enter');
      await expect(alphaBinding.getByRole('status').filter({ hasText: 'Respuestas automáticas · Catálogo' })).toBeVisible();
      expect((await request.put(`${backend}/api/agents/company-mode`, { headers, data: { mode: 'automator' } })).status()).toBe(200);
      const automatic = inbound('wamid.' + crypto.randomUUID(), 'Consultar catálogo en modo automático');
      await postWebhook(request, alpha, automatic);
      await postWebhook(request, alpha, automatic);
      const history = inboxes[0].getByRole('region', { name: 'Historial de mensajes' });
      const reply = history.locator('[data-history-message]').filter({ hasText: expected[0] });
      await expect(reply).toHaveCount(1);
      const delivery = reply.getByTestId('message-delivery-status');
      await expect(delivery).toHaveText('Aceptado por WhatsApp');
      const sent = await graphAttempts(alpha);
      expect(sent).toEqual([expect.objectContaining({ to: contact, type: 'text', callback: expect.stringMatching(/^automat:/) })]);
      expect(await graphAttempts(bravo)).toEqual([]);
      await postWebhook(request, alpha, { statuses: [{ id: sent[0].id, status: 'read', recipient_id: contact,
        timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: sent[0].callback }] });
      await expect(delivery).toHaveText('Leído');
      await inboxes[0].reload();
      await expect(delivery).toHaveText('Leído');
      expect(await graphAttempts(alpha)).toEqual(sent);

      // Simulate provider unavailability without replacing the real stored binding.
      let providerMode = true;
      await studioPages[0].route('**/execution?version=1', async (route) => {
        const response = await route.fetch();
        const status = await response.json();
        const unavailable = { ...status.profile, whatsappBindingAllowed: false };
        await route.fulfill({ response, json: providerMode
          ? { ...status, profile: unavailable }
          : { mode: null, suites: [], active: null, profile: { ...unavailable, compatible: false, issue: 'CATALOG_PROVIDER_REQUIRED' } },
        });
      });
      const unbind = alphaBinding.getByRole('button', { name: 'Desvincular de WhatsApp' });
      for (const mode of [true, false]) {
        providerMode = mode;
        await studioPages[0].reload();
        await expect(unbind).toBeEnabled();
        await expect(alphaBinding.getByRole('combobox', { name: 'Modo de respuesta en WhatsApp' })).toHaveCount(0);
      }
      const removed = studioPages[0].waitForResponse((response) =>
        response.url().endsWith('/whatsapp-binding') && response.request().method() === 'DELETE');
      await unbind.press('Enter');
      expect((await removed).status()).toBe(204);
      await expect(alphaBinding.getByRole('status').filter({ hasText: 'Sin revisión vinculada.' })).toBeVisible();
      await expect(alphaBinding.getByRole('heading', { name: 'Revisión para WhatsApp' })).toBeFocused();
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test('provider mode keeps evaluation suites scoped to each revision profile', async ({ browser, request }) => {
    test.skip(!backend || !process.env.STUDIO_FIXTURE_URL, 'Requires the local provider and isolated PostgreSQL');
    const [company] = provisionCompanies('--studio', '--catalog-studio');
    const graphUrl = `${backend}/api/v1/agent-graphs/${company.catalogGraphId}`;
    const headers = { authorization: `Bearer ${company.auth.accessToken}` };
    const revisions = await request.post(graphUrl + '/revisions', { headers, data: {
      entryNodeId: 'answer', policyRef: 'qa-text', nodes: [
        { id: 'answer', kind: 'agent', config: { provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', prompt: 'Contexto QA', maxTokens: 40 } },
        { id: 'end', kind: 'end', config: {} },
      ], edges: [{ id: 'finish', from: 'answer', to: 'end' }],
      limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10, maxModelTokens: 900000, maxCostMicroUsd: 700000 },
    } });
    expect(revisions.status()).toBe(201);
    expect((await revisions.json()).version).toBe(2);

    const context = await browser.newContext({ viewport: { width: 390, height: 720 } });
    try {
      await context.addInitScript((session) => localStorage.setItem('auth', JSON.stringify(session)), company.auth);
      const page = await context.newPage();
      await page.goto(`/dashboard/ia/estudio/grafos/${company.catalogGraphId}?version=1`);
      const panel = page.getByRole('region', { name: 'Evaluación y publicación' });
      await panel.getByText('Credencial de OpenAI', { exact: true }).press('Enter');
      await panel.getByLabel('Clave de API').fill('fixture-studio-provider');
      await panel.getByRole('button', { name: 'Guardar credencial' }).press('Enter');
      await expect(panel.getByText('Credencial guardada.')).toBeVisible();
      const scenario = { id: 'lookup', name: 'Búsqueda', mockInput: 'Consultar catálogo', expectedTextPatterns: ['Visible Alfa'] };
      const catalogSuite = await request.post(graphUrl + '/evaluation-suites?version=1', { headers, data: {
        id: crypto.randomUUID(), name: 'Suite de catálogo', profile: 'catalog-router-v1',
        scenarios: [{ ...scenario, expectedTools: ['catalog.search'] }],
      } });
      expect(catalogSuite.status()).toBe(200);
      const textSuite = await request.post(graphUrl + '/evaluation-suites?version=2', { headers, data: {
        id: crypto.randomUUID(), name: 'Suite de texto', scenarios: [scenario],
      } });
      expect(textSuite.status()).toBe(200);

      for (const [version, expected, absent] of [[1, 'Suite de catálogo', 'Suite de texto'], [2, 'Suite de texto', 'Suite de catálogo']] as const) {
        await page.goto(`/dashboard/ia/estudio/grafos/${company.catalogGraphId}?version=${version}`);
        await expect(panel.getByRole('option', { name: new RegExp(expected) })).toHaveCount(1);
        await expect(panel.getByRole('option', { name: new RegExp(absent) })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Evaluar revisión' })).toBeEnabled();
      }
    } finally {
      await context.close();
    }
  });

}
