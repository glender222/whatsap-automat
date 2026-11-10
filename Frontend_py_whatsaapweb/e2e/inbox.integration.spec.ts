import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';

const backend = process.env.PRODUCT_SMOKE_URL;
test.skip(!backend, 'Requires the local product smoke backend and isolated PostgreSQL database');

type Company = { phoneNumberId: string; outboundId?: string; auth: { accessToken: string } };

function provisionCompanies(...options: string[]): Company[] {
  const fixtures = execFileSync(process.execPath, ['--import', 'tsx', 'src/test/fixtures/browserInbox.ts', ...options], {
    cwd: fileURLToPath(new URL('../../WhatsaapWeb-JS/', import.meta.url)),
    encoding: 'utf8',
    timeout: 15000,
  }).trim().split('\n').at(-1)!;
  return JSON.parse(fixtures);
}

async function postWebhook(request: APIRequestContext, company: Company, change: object) {
  const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    ...change, metadata: { phone_number_id: company.phoneNumberId },
  } }] }] });
  const signature = createHmac('sha256', process.env.META_APP_SECRET!).update(payload).digest('hex');
  const receipt = await request.post(backend + '/api/webhooks/meta/whatsapp', {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + signature },
    data: payload,
  });
  expect(receipt.status()).toBe(200);
}

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
