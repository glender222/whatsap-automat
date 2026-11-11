import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { provisionCompanies, type Company } from './fixtures/provisionCompanies';
import { postWebhook } from './fixtures/metaWebhook';

const backend = process.env.PRODUCT_SMOKE_URL;
test.skip(!backend, 'Requires the local product smoke backend and isolated PostgreSQL database');

test('the inbox shows new conversations and recovers missed messages within the same company', async ({ browser, request }) => {
  const companies = provisionCompanies();
  expect(companies).toHaveLength(2);
  const contexts = await Promise.all(companies.map(() => browser.newContext()));
  let online = true;
  let closeSocket: (() => Promise<void>) | undefined;

  try {
    const pages = await Promise.all(contexts.map(async (context, index) => {
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), companies[index].auth);
      const page = await context.newPage();
      if (index === 0) {
        await page.routeWebSocket(/\/socket\.io\//, async (socket) => {
          if (!online) {
            await socket.close({ code: 1001 });
            return;
          }
          socket.connectToServer();
          closeSocket = () => socket.close({ code: 1001 });
        });
      }
      const connected = new Promise<void>((resolve) => {
        page.on('websocket', (socket) => {
          socket.on('framereceived', ({ payload }) => {
            if (typeof payload === 'string' && payload.startsWith('40{')) resolve();
          });
        });
      });
      await page.goto('/gestion-web/inicio');
      await expect(page.getByText('No hay conversaciones para mostrar')).toBeVisible();
      await connected;
      return page;
    }));
    const messageId = 'wamid.' + randomUUID();
    const bodies = ['Nuevo mensaje de Alfa', 'Nuevo mensaje de Bravo'];
    const contact = '12025550145';
    async function receive(index: number, body: string, id: string) {
      await postWebhook(request, companies[index], {
        messages: [{ id, from: contact, type: 'text', text: { body } }],
      });
    }
    for (const [index, company] of companies.entries()) {
      await receive(index, bodies[index], messageId);
      const history = await request.get(backend + '/api/chats/' + contact + '/messages', {
        headers: { authorization: 'Bearer ' + company.auth.accessToken },
      });
      expect(history.status()).toBe(200);
      const envelope = await history.json();
      expect(envelope.data.map(({ body }: { body: string }) => body)).toEqual([bodies[index]]);
    }
    for (const [index, page] of pages.entries()) {
      await expect(page.getByText(bodies[index], { exact: true })).toBeVisible();
      await expect(page.getByText(bodies[1 - index], { exact: true })).toHaveCount(0);
    }

    const [alpha, bravo] = pages;
    await alpha.getByText(bodies[0], { exact: true }).click();
    await expect(alpha).toHaveURL(new RegExp('chat=' + contact));
    const openHistory = alpha.getByRole('region', { name: 'Historial de mensajes' });
    await expect(openHistory.getByText(bodies[0], { exact: true })).toBeVisible();
    expect(closeSocket).toBeDefined();
    online = false;
    await contexts[0].setOffline(true);
    await closeSocket!();
    const recovered = 'Alfa recibió este mensaje sin conexión';
    await receive(0, recovered, 'wamid.' + randomUUID());
    await expect(alpha.getByText(recovered, { exact: true })).toHaveCount(0);

    const refreshedHistory = alpha.waitForResponse((response) =>
      response.url().includes('/api/chats/' + contact + '/messages') && response.ok(),
    );
    online = true;
    await contexts[0].setOffline(false);
    const response = await refreshedHistory;
    const history = await response.json();
    expect(history.data.map(({ body }: { body: string }) => body)).toContain(recovered);
    await expect(alpha.getByText(recovered, { exact: true }).first()).toBeVisible();
    await expect(bravo.getByText(recovered, { exact: true })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('the message draft survives visiting Orders and clears when the company changes', async ({ page, context, request }) => {
  const [alpha, bravo] = provisionCompanies();
  const contact = '12025550145';
  const messageId = 'wamid.' + randomUUID();
  for (const [company, body] of [[alpha, 'Mensaje de Alfa'], [bravo, 'Mensaje de Bravo']] as const) {
    await postWebhook(request, company, { messages: [{ id: messageId, from: contact, type: 'text', text: { body } }] });
  }
  await page.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), alpha.auth);
  const threadUrl = '/gestion-web/inicio?chat=' + contact;
  const conversation = page.getByRole('region', { name: 'Conversación seleccionada' });
  const history = conversation.getByRole('region', { name: 'Historial de mensajes' });
  const draft = conversation.getByRole('textbox', { name: 'Mensaje', exact: true });
  const navigation = page.getByRole('navigation', { name: 'Espacio de trabajo' });

  await page.goto(threadUrl);
  await expect(history.getByText('Mensaje de Alfa', { exact: true })).toBeVisible();
  await draft.fill('Respuesta de Alfa en preparación');
  await navigation.getByRole('link', { name: 'Pedidos', exact: true }).press('Enter');
  await expect(page).toHaveURL('/dashboard/pedidos');
  await expect(page.getByRole('region', { name: 'Pedidos comerciales' })).toBeVisible();
  await expect(conversation).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(threadUrl);
  await expect(draft).toHaveValue('Respuesta de Alfa en preparación');

  const otherTab = await context.newPage();
  await otherTab.goto('/auth/login');
  await otherTab.evaluate((auth) => localStorage.setItem('auth', JSON.stringify(auth)), bravo.auth);
  await expect(history.getByText('Mensaje de Bravo', { exact: true })).toBeVisible();
  await expect(history.getByText('Mensaje de Alfa', { exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue('');
});

test('delivery receipts update an open conversation without affecting another company', async ({ browser, request }) => {
  const companies = provisionCompanies('--outbound');
  const contexts = await Promise.all(companies.map(() => browser.newContext()));
  const deliveryEvents = companies.map(() => 0);
  const contact = '12025550145';
  try {
    const [alpha, bravo] = await Promise.all(contexts.map(async (context, index) => {
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), companies[index].auth);
      const page = await context.newPage();
      const joined = new Promise<void>((resolve) => {
        page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return;
          if (payload.startsWith('42["conversation_joined"')) resolve();
          if (payload.startsWith('42["conversation.delivery_changed"')) deliveryEvents[index]++;
        }));
      });
      await page.goto('/gestion-web/inicio?chat=' + contact);
      await expect(page.getByText('Envío de ' + (index === 0 ? 'Alfa' : 'Bravo'), { exact: true }).first()).toBeVisible();
      await joined;
      await expect(page.getByTestId('message-delivery-status')).toHaveText('Enviado');
      return page;
    }));

    const company = companies[0];
    const timestamp = String(Math.floor(Date.now() / 1000));
    const status = (value: string) => postWebhook(request, company, {
      statuses: [{ id: company.outboundId, status: value, timestamp, recipient_id: contact }],
    });
    const historyUrl = backend + '/api/chats/' + contact + '/messages';
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await alpha.route(historyUrl + '?*', async (route) => {
      const snapshot = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response: snapshot });
    }, { times: 1 });
    const history = await request.get(historyUrl, {
      headers: { authorization: 'Bearer ' + company.auth.accessToken },
    });
    const sentAt = String((await history.json()).data[0].timestamp);
    const inboundText = 'Mensaje simultáneo con el historial pendiente';
    try {
      await status('delivered');
      await captured.promise;
      await postWebhook(request, company, {
        messages: [{ id: 'wamid.' + randomUUID(), from: contact, timestamp: sentAt, type: 'text', text: { body: inboundText } }],
      });
      await expect(alpha.getByText(inboundText, { exact: true })).toHaveCount(2);
      await expect(alpha.getByTestId('message-delivery-status')).toHaveText('Enviado');
    } finally {
      release.resolve();
    }
    await expect(alpha.getByTestId('message-delivery-status')).toHaveText('Entregado');
    // The same text also appears in the sidebar preview, so assert the history bubble.
    await expect(alpha.getByText(inboundText, { exact: true })).toHaveCount(2);
    await expect(bravo.getByTestId('message-delivery-status')).toHaveText('Enviado');

    await status('read');
    await expect(alpha.getByTestId('message-delivery-status')).toHaveText('Leído');
    await status('sent');
    await expect(alpha.getByTestId('message-delivery-status')).toHaveText('Leído');
    await expect(bravo.getByTestId('message-delivery-status')).toHaveText('Enviado');
    expect(deliveryEvents).toEqual([2, 0]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('an active tag preserves live previews across a delayed snapshot and reconnect', async ({ browser, request }) => {
  const companies = provisionCompanies();
  const contexts = await Promise.all(companies.map(() => browser.newContext()));
  const contact = '12025550145';
  const untagged = '12025550146';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const receive = (company: Company, from: string, body: string, id = 'wamid.' + randomUUID()) =>
    postWebhook(request, company, { messages: [{ id, from, timestamp, type: 'text', text: { body } }] });

  try {
    const originalId = 'wamid.' + randomUUID();
    const workspaces = await Promise.all(companies.map(async (company, index) => {
      const headers = { authorization: 'Bearer ' + company.auth.accessToken };
      await receive(company, contact, `Mensaje inicial ${index}`, originalId);
      const tag = await request.post(backend + '/api/tags', { headers, data: { name: 'Soporte' } });
      expect(tag.status()).toBe(200);
      const { data } = await tag.json();
      const assigned = await request.post(`${backend}/api/tags/${data.id}/chats`, { headers, data: { chatId: contact } });
      expect(assigned.status()).toBe(200);
      const context = contexts[index];
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), company.auth);
      const page = await context.newPage();
      let online = true;
      let closeSocket: (() => Promise<void>) | undefined;
      if (index === 0) {
        await page.routeWebSocket(/\/socket\.io\//, async (socket) => {
          if (!online) return socket.close({ code: 1001 });
          socket.connectToServer();
          closeSocket = () => socket.close({ code: 1001 });
        });
      }
      const connected = Promise.withResolvers<void>();
      page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string' && payload.startsWith('40{')) connected.resolve();
      }));
      await page.goto('/gestion-web/inicio');
      const filter = page.getByRole('combobox', { name: 'Etiqueta' });
      await filter.selectOption({ label: 'Soporte' });
      await expect(page.getByText(`Mensaje inicial ${index}`, { exact: true })).toBeVisible();
      await connected.promise;
      return {
        page, filter, headers, tagUrl: `${backend}/api/tags/${data.id}/chats/full`,
        async disconnect() { online = false; await context.setOffline(true); await closeSocket?.(); },
        async reconnect() { online = true; await context.setOffline(false); },
      };
    }));

    const [alpha, bravo] = workspaces;
    const foreignTag = await request.get(alpha.tagUrl, { headers: bravo.headers });
    expect(foreignTag.status()).toBe(404);
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await alpha.page.route(alpha.tagUrl, async (route) => {
      const snapshot = await route.fetch();
      const { data } = await snapshot.json();
      expect(data.map((chat: { lastMessagePreview: string }) => chat.lastMessagePreview)).toEqual(['Mensaje inicial 0']);
      captured.resolve();
      await release.promise;
      await route.fulfill({ response: snapshot });
    }, { times: 1 });
    const liveText = 'Mensaje de Alfa durante la consulta';
    const refresh = alpha.page.waitForResponse(alpha.tagUrl);
    try {
      await receive(companies[0], untagged, 'Conversación sin etiqueta');
      await captured.promise;
      await receive(companies[0], contact, liveText);
      await expect(alpha.page.getByText(liveText, { exact: true })).toBeVisible();
    } finally {
      release.resolve();
    }
    expect(await (await refresh).finished()).toBeNull();
    await alpha.page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(alpha.page.getByText(liveText, { exact: true })).toBeVisible();
    await expect(alpha.page.getByText('Mensaje inicial 0', { exact: true })).toHaveCount(0);
    await expect(alpha.page.getByText('Conversación sin etiqueta', { exact: true })).toHaveCount(0);
    await expect(bravo.page.getByText(liveText, { exact: true })).toHaveCount(0);
    await expect(bravo.page.getByText('Mensaje inicial 1', { exact: true })).toBeVisible();

    await alpha.disconnect();
    const missed = 'Mensaje de Alfa con la bandeja desconectada';
    await receive(companies[0], contact, missed);
    await expect(alpha.page.getByText(missed, { exact: true })).toHaveCount(0);
    await alpha.reconnect();
    await expect(alpha.page.getByText(missed, { exact: true })).toBeVisible();
    await expect(alpha.filter.locator('option:checked')).toHaveText('Soporte');
    await expect(alpha.page.getByText('Conversación sin etiqueta', { exact: true })).toHaveCount(0);
    await expect(bravo.page.getByText(missed, { exact: true })).toHaveCount(0);

    const late = {
      id: 'wamid.' + randomUUID(), from: contact, timestamp: String(Number(timestamp) - 25 * 60 * 60),
      type: 'text', text: { body: 'Mensaje recibido fuera de orden' },
    };
    await postWebhook(request, companies[0], { messages: [late] });
    await expect(alpha.page.getByLabel('4 sin leer', { exact: true })).toBeVisible();
    await expect(alpha.page.getByText(missed, { exact: true })).toBeVisible();
    await postWebhook(request, companies[0], { messages: [late] });
    const persisted = await request.get(alpha.tagUrl, { headers: alpha.headers });
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).data).toMatchObject([{ lastMessagePreview: missed, unreadCount: 4 }]);
    await expect(bravo.page.getByLabel('1 sin leer', { exact: true })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('history loads messages from the same second without losing position or crossing companies', async ({ browser, request }) => {
  const companies = provisionCompanies();
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 800 } }),
    browser.newContext({ viewport: { width: 390, height: 680 } }),
  ]);
  const contact = '12025550145';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const ids = Array.from({ length: 52 }, () => 'wamid.' + randomUUID());
  const historyPath = `/api/chats/${contact}/messages`;
  const headers = (company: Company) => ({ authorization: 'Bearer ' + company.auth.accessToken });
  let online = true;
  let pendingIdentity = true;
  let closeSocket: (() => Promise<void>) | undefined;
  try {
    const pages = await Promise.all(companies.map(async (company, index) => {
      const label = index === 0 ? 'Alfa' : 'Bravo';
      for (const start of [0, 26]) {
        await postWebhook(request, company, { messages: ids.slice(start, start + 26).map((id, i) => ({
          id, from: contact, timestamp, type: 'text', text: { body: `${label} historial ${start + i + 1}` },
        })) });
      }
      const context = contexts[index];
      await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), company.auth);
      const page = await context.newPage();
      if (index === 0) {
        // Simulate the identity transition of a stored outbound send when its provider ID is assigned.
        await page.route((url) => url.pathname === historyPath && !url.searchParams.has('cursor'), async (route) => {
          const response = await route.fetch();
          const envelope = await response.json();
          const data = envelope.data.map((message: { id: string; body: string; historyId?: string }) => {
            if (message.body !== 'Alfa historial 49') return message;
            expect(message.historyId).toMatch(/^\d+$/);
            return { ...message, id: pendingIdentity ? message.historyId : message.id };
          });
          await route.fulfill({ response, json: { ...envelope, data } });
        });
        await page.routeWebSocket(/\/socket\.io\//, async (socket) => {
          if (!online) return socket.close({ code: 1001 });
          socket.connectToServer();
          closeSocket = () => socket.close({ code: 1001 });
        });
      }
      await page.goto('/gestion-web/inicio?chat=' + contact);
      await expect(page.getByRole('region', { name: 'Historial de mensajes' }).locator('[data-history-message]')).toHaveCount(50);
      return page;
    }));
    const [alpha] = pages;
    const [alphaHistory, bravoHistory] = pages.map((page) => page.getByRole('region', { name: 'Historial de mensajes' }));
    const head = await request.get(backend + historyPath, { headers: headers(companies[0]) });
    expect(head.ok()).toBe(true);
    const { nextCursor } = await head.json();
    expect(typeof nextCursor).toBe('string');
    const foreign = await request.get(`${backend}${historyPath}?cursor=${nextCursor}`, { headers: headers(companies[1]) });
    expect(await foreign.json()).toMatchObject({ data: [], nextCursor: null });

    const anchor = alphaHistory.locator('[data-history-message]').filter({ has: alpha.getByText('Alfa historial 3', { exact: true }) });
    const load = alphaHistory.getByRole('button', { name: 'Cargar mensajes anteriores' });
    await alpha.route((url) => url.pathname === historyPath && url.searchParams.has('cursor'),
      (route) => route.fulfill({ status: 503 }), { times: 1 });
    await load.press('Enter');
    await expect(alphaHistory.getByRole('alert')).toContainText('Vuelve a intentarlo.');
    await expect(load).toBeFocused();
    await expect(alphaHistory.locator('[data-history-message]')).toHaveCount(50);
    await alphaHistory.evaluate((element) => { element.scrollTop = 0; });
    const top = (await anchor.boundingBox())?.y;
    await load.press('Enter');
    await expect(alphaHistory.getByText('Alfa historial 1', { exact: true })).toBeAttached();
    await expect(alphaHistory.locator('[data-history-message]')).toHaveCount(52);
    await expect(anchor).toBeFocused();
    expect(Math.abs((await anchor.boundingBox())!.y - top!)).toBeLessThan(4);
    await expect(alphaHistory.getByRole('button', { name: 'Inicio del historial' })).toBeDisabled();
    await expect(bravoHistory.getByText('Alfa historial 1', { exact: true })).toHaveCount(0);
    await expect(bravoHistory.locator('[data-history-message]')).toHaveCount(50);

    await bravoHistory.getByRole('button', { name: 'Cargar mensajes anteriores' }).press('Enter');
    await expect(bravoHistory.getByText('Bravo historial 1', { exact: true })).toBeAttached();
    await expect(bravoHistory.locator('[data-history-message]')).toHaveCount(52);
    await expect(alphaHistory.getByText('Bravo historial 1', { exact: true })).toHaveCount(0);

    const liveText = 'Alfa mensaje posterior a la paginación';
    await postWebhook(request, companies[0], { messages: [{
      id: 'wamid.' + randomUUID(), from: contact, timestamp, type: 'text', text: { body: liveText },
    }] });
    await expect(alphaHistory.getByText(liveText, { exact: true })).toBeAttached();
    await expect(alphaHistory.locator('[data-history-message]')).toHaveCount(53);
    await expect(alphaHistory.getByText('Alfa historial 1', { exact: true })).toBeAttached();
    await expect(bravoHistory.getByText(liveText, { exact: true })).toHaveCount(0);

    expect(closeSocket).toBeDefined();
    online = false;
    await contexts[0].setOffline(true);
    await closeSocket!();
    const missed = 'Alfa mensaje recibido sin conexión después de paginar';
    await postWebhook(request, companies[0], { messages: [{
      id: 'wamid.' + randomUUID(), from: contact, timestamp, type: 'text', text: { body: missed },
    }] });
    await expect(alphaHistory.getByText(missed, { exact: true })).toHaveCount(0);
    pendingIdentity = false;
    online = true;
    await contexts[0].setOffline(false);
    await expect(alphaHistory.getByText(missed, { exact: true })).toBeAttached();
    await expect(alphaHistory.locator('[data-history-message]')).toHaveCount(54);
    await expect(alphaHistory.getByText('Alfa historial 49', { exact: true })).toHaveCount(1);
    await expect(alphaHistory.getByText('Alfa historial 1', { exact: true })).toBeAttached();
    await expect(bravoHistory.getByText(missed, { exact: true })).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('the composer scopes ownership, retries, attachments and receipt recovery to the sending company', async ({ browser, request }) => {
  const graph = process.env.PRODUCT_GRAPH_FIXTURE_URL;
  test.skip(!graph, 'Requires the local Graph fixture preload');
  test.setTimeout(45000);
  const [companyA, companyB] = provisionCompanies('--send');
  const companies = [companyA, companyB];
  const contexts = await Promise.all(companies.map(() => browser.newContext()));
  const contact = '12025550145';
  const now = Math.floor(Date.now() / 1000);
  const inboundId = 'wamid.' + randomUUID();
  let online = true;
  let closeSocket: (() => Promise<void>) | undefined;
  const attempts = async (company: Company) => {
    const response = await request.get(`${graph}/attempts?line=${company.phoneNumberId}`);
    expect(response.ok()).toBe(true);
    return await response.json() as Array<{ operation: string; type?: string; id?: string; to?: string; callback?: string }>;
  };

  try {
    const [alpha, bravo] = await Promise.all(companies.map(async (company, index) => {
      await postWebhook(request, company, { messages: [{
        id: inboundId, from: contact, timestamp: String(now - (index ? 25 * 60 * 60 : 0)),
        type: 'text', text: { body: index ? 'Entrada Bravo vencida' : 'Entrada Alfa vigente' },
      }] });
      await contexts[index].addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), company.auth);
      const page = await contexts[index].newPage();
      if (index === 0) {
        await page.routeWebSocket(/\/socket\.io\//, async (socket) => {
          if (!online) return socket.close({ code: 1001 });
          socket.connectToServer();
          closeSocket = () => socket.close({ code: 1001 });
        });
      }
      await page.goto('/gestion-web/inicio?chat=' + contact);
      return page;
    }));

    const draft = alpha.getByRole('textbox', { name: 'Mensaje', exact: true });
    const send = alpha.getByRole('button', { name: 'Enviar mensaje' });
    const ownership = alpha.getByRole('button', { name: 'Tomar control' });
    await expect(bravo.getByText('Ventana de atención de 24 horas cerrada.', { exact: true })).toBeVisible();
    await bravo.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Borrador de Bravo');
    await expect(bravo.getByRole('button', { name: 'Enviar mensaje' })).toBeDisabled();
    await expect(bravo.getByRole('button', { name: 'Adjuntar' })).toBeDisabled();
    await draft.fill('Envío QA reintento exacto');
    await expect(send).toBeDisabled();
    await ownership.press('Enter');
    await expect(draft).toBeFocused();
    await expect(send).toBeEnabled();
    expect(await attempts(companyA)).toEqual([]);

    const keys: string[] = [];
    const isTextPost = (url: URL) => /^\/api\/v1\/conversations\/\d+\/messages$/.test(url.pathname);
    alpha.on('request', (outbound) => {
      if (outbound.method() === 'POST' && isTextPost(new URL(outbound.url()))) {
        keys.push(outbound.headers()['idempotency-key']);
      }
    });
    await alpha.route(isTextPost, (route) => route.request().method() === 'POST'
      ? route.abort('timedout') : route.fallback());
    await send.click();
    const retry = alpha.getByRole('button', { name: 'Reintentar el mismo envío' });
    await expect(retry).toBeVisible();
    expect(await attempts(companyA)).toEqual([]);
    await alpha.unroute(isTextPost);
    await retry.press('Enter');
    await expect(draft).toHaveValue('');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(await attempts(companyA)).toMatchObject([{ operation: 'messages', type: 'text', to: contact }]);

    await alpha.getByRole('button', { name: 'Adjuntar' }).click();
    const chooser = alpha.waitForEvent('filechooser');
    await alpha.getByRole('button', { name: 'Documento', exact: true }).click();
    await (await chooser).setFiles({ name: 'archivo-qa.txt', mimeType: 'text/plain', buffer: Buffer.from('Archivo QA') });
    await draft.fill('Adjunto QA');
    const sendFile = alpha.getByRole('button', { name: 'Enviar archivo' });
    await sendFile.click();
    await expect(alpha.getByText(/WhatsApp no admite este adjunto/)).toBeVisible();
    await expect(draft).toHaveValue('Adjunto QA');
    await expect(sendFile).toBeEnabled();
    expect((await attempts(companyA)).map(({ operation }) => operation)).toEqual(['messages', 'media']);
    await sendFile.click();
    await expect(draft).toHaveValue('');
    await expect(sendFile).toHaveCount(0);
    expect((await attempts(companyA)).map(({ operation, type }) => [operation, type])).toEqual([
      ['messages', 'text'], ['media', undefined], ['media', undefined], ['messages', 'document'],
    ]);
    const file = (await attempts(companyA)).at(-1)!;
    const fileUrl = `${backend}/api/media/${encodeURIComponent(file.id!)}`;
    const ownerHeaders = { authorization: `Bearer ${companyA.auth.accessToken}` };
    expect((await request.get(fileUrl)).status()).toBe(401);
    const download = await request.get(fileUrl, { headers: ownerHeaders });
    expect(await download.text()).toBe('Archivo QA');
    expect(download.status()).toBe(200);
    expect((await request.get(fileUrl + '/info', { headers: ownerHeaders })).status()).toBe(200);
    const legacyDownload = await request.get(`${backend}/api/media/media/${encodeURIComponent(file.id!)}`, { headers: ownerHeaders });
    expect(await legacyDownload.text()).toBe('Archivo QA');
    const foreignDownload = await request.get(fileUrl, { headers: { authorization: `Bearer ${companyB.auth.accessToken}` } });
    expect([403, 404]).toContain(foreignDownload.status());

    const pending = 'Envío QA sin confirmación';
    await draft.fill(pending);
    await send.click();
    await expect(alpha.getByText(/La entrega sigue sin confirmar/)).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(retry).toHaveCount(0);
    const requests = await attempts(companyA);
    expect(requests).toHaveLength(5);
    const last = requests.at(-1)!;
    expect(last.callback).toMatch(/^automat:/);

    const signedStatus = { id: last.id, status: 'delivered', recipient_id: contact,
      timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: last.callback };
    await postWebhook(request, companyB, { statuses: [signedStatus] });
    await expect(alpha.getByText(/La entrega sigue sin confirmar/)).toBeVisible();
    await postWebhook(request, companyA, { statuses: [signedStatus] });
    const history = alpha.getByRole('region', { name: 'Historial de mensajes' });
    await expect(history.getByText(pending, { exact: true })).toHaveCount(1);
    await expect(history.getByTestId('message-delivery-status').filter({ hasText: /^Entregado$/ })).toHaveCount(1);
    await expect(draft).toHaveValue('');
    await expect(alpha.getByText('Tienes el control de esta conversación.', { exact: true })).toBeVisible();
    expect(await attempts(companyA)).toEqual(requests);

    const pendingOffline = 'Envío QA sin confirmación al reconectar';
    await draft.fill(pendingOffline);
    await send.click();
    await expect(alpha.getByText(/La entrega sigue sin confirmar/)).toBeVisible();
    await draft.fill('Nuevo borrador de Alfa');
    await expect(send).toBeDisabled();
    const beforeReconnect = await attempts(companyA);
    expect(beforeReconnect).toHaveLength(6);
    const offlineAttempt = beforeReconnect.at(-1)!;
    expect(closeSocket).toBeDefined();
    online = false;
    await contexts[0].setOffline(true);
    await closeSocket!();
    await postWebhook(request, companyA, { statuses: [{ ...signedStatus, id: offlineAttempt.id,
      biz_opaque_callback_data: offlineAttempt.callback, timestamp: String(Math.floor(Date.now() / 1000)) }] });
    await expect(send).toBeDisabled();
    online = true;
    await contexts[0].setOffline(false);
    await expect(send).toBeEnabled();
    await expect(draft).toHaveValue('Nuevo borrador de Alfa');
    await expect(history.getByText(pendingOffline, { exact: true })).toHaveCount(1);
    expect(await attempts(companyA)).toEqual(beforeReconnect);
    expect(await attempts(companyB)).toEqual([]);
    await expect(bravo.getByRole('textbox', { name: 'Mensaje', exact: true })).toHaveValue('Borrador de Bravo');
    await expect(bravo.getByText(pending, { exact: true })).toHaveCount(0);

    const pendingDuringOrders = 'Envío QA sin confirmación al abrir Pedidos';
    await draft.fill(pendingDuringOrders);
    await send.click();
    await expect(alpha.getByText(/La entrega sigue sin confirmar/)).toBeVisible();
    const beforeOrders = await attempts(companyA);
    expect(beforeOrders).toHaveLength(beforeReconnect.length + 1);
    const orderVisitAttempt = beforeOrders.at(-1)!;
    await alpha.getByRole('navigation', { name: 'Espacio de trabajo' }).getByRole('link', { name: 'Pedidos', exact: true }).press('Enter');
    await expect(alpha.getByRole('region', { name: 'Pedidos comerciales' })).toBeVisible();
    await expect(draft).toHaveCount(0);
    await postWebhook(request, companyA, { statuses: [{ ...signedStatus, id: orderVisitAttempt.id,
      biz_opaque_callback_data: orderVisitAttempt.callback, timestamp: String(Math.floor(Date.now() / 1000)) }] });
    await alpha.goBack();
    await expect(history.getByText(pendingDuringOrders, { exact: true })).toHaveCount(1);
    await expect(draft).toHaveValue('');
    expect(await attempts(companyA)).toEqual(beforeOrders);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
