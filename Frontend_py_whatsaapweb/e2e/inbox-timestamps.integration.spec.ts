import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { provisionCompanies } from './fixtures/provisionCompanies';
import { postWebhook } from './fixtures/metaWebhook';

const backend = process.env.PRODUCT_SMOKE_URL;
test.skip(!backend, 'Requires the local product smoke backend and isolated PostgreSQL database');

type HistoryMessage = { id: string; body: string; timestamp: number };

async function expectMessageDate(page: Page, body: string, seconds: number) {
  const row = page.getByRole('region', { name: 'Historial de mensajes' })
    .locator('[data-history-message]').filter({ has: page.getByText(body, { exact: true }) });
  const displayed = await page.evaluate((value) => new Date(value * 1000).toLocaleString(), seconds);
  await expect(row).toHaveCount(1);
  await expect(row.getByText(displayed, { exact: true })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`message dates agree across live Socket, HTTP recovery and millisecond history at ${width}px`, async ({ browser, request }) => {
    const companies = provisionCompanies('--outbound');
    const contexts = await Promise.all(companies.map(() => browser.newContext({
      viewport: { width, height: 800 }, locale: 'es-PE', timezoneId: 'America/Lima',
    })));
    const contact = '12025550145';
    const historyUrl = backend + '/api/chats/' + contact + '/messages';
    const liveMessages = companies.map(() => [] as HistoryMessage[]);
    const fixtures = companies.map((company, index) => ({
      company, name: index ? 'Bravo' : 'Alfa', inboundId: 'wamid.' + randomUUID(),
      inbound: `Fecha en vivo de ${index ? 'Bravo' : 'Alfa'}`,
    }));

    try {
      const pages = await Promise.all(contexts.map(async (context, index) => {
        await context.addInitScript((auth) => localStorage.setItem('auth', JSON.stringify(auth)), companies[index].auth);
        const page = await context.newPage();
        const joined = new Promise<void>((resolve) => page.on('websocket', (socket) =>
          socket.on('framereceived', ({ payload }) => {
            if (typeof payload === 'string' && payload.startsWith('42["conversation_joined"')) resolve();
            if (typeof payload === 'string' && payload.startsWith('42["message",')) {
              liveMessages[index].push(JSON.parse(payload.slice(2))[1]);
            }
          })));
        await page.goto('/gestion-web/inicio?chat=' + contact);
        await expect(page.getByRole('region', { name: 'Historial de mensajes' })
          .getByText(`Envío de ${fixtures[index].name}`, { exact: true })).toBeVisible();
        await joined;
        return page;
      }));

      for (const [index, fixture] of fixtures.entries()) {
        const page = pages[index];
        const headers = { authorization: 'Bearer ' + fixture.company.auth.accessToken };
        const before = await request.get(historyUrl, { headers });
        expect(before.status()).toBe(200);
        const original = (await before.json()).data as HistoryMessage[];
        const outbound = original.find((message) => message.id === fixture.company.outboundId)!;
        expect(outbound).toBeDefined();
        await expectMessageDate(page, outbound.body, outbound.timestamp);

        const seconds = outbound.timestamp + 60;
        await postWebhook(request, fixture.company, { messages: [{
          id: fixture.inboundId, from: contact, type: 'text', timestamp: String(seconds), text: { body: fixture.inbound },
        }] });
        await expect.poll(() => liveMessages[index].find((message) => message.id === fixture.inboundId)?.timestamp).toBe(seconds);
        await expectMessageDate(page, fixture.inbound, seconds);
        await expect(page.locator('[data-history-message]')).toContainText([outbound.body, fixture.inbound]);
        await expect(pages[1 - index].getByText(fixture.inbound, { exact: true })).toHaveCount(0);

        const persisted = await request.get(historyUrl, { headers });
        expect(persisted.status()).toBe(200);
        const history = (await persisted.json()).data as HistoryMessage[];
        expect(history.find((message) => message.id === fixture.inboundId)?.timestamp).toBe(seconds);
        await page.reload();
        await expectMessageDate(page, fixture.inbound, seconds);
        await expectMessageDate(page, outbound.body, outbound.timestamp);
        await expect(page.locator('[data-history-message]')).toContainText([outbound.body, fixture.inbound]);

        // Compatibility: older clients/caches may already carry milliseconds.
        let convertedHistory = false;
        await page.route(historyUrl + '?*', async (route) => {
          const response = await route.fetch();
          const envelope = await response.json();
          await route.fulfill({ response, json: { ...envelope,
            data: envelope.data.map((message: HistoryMessage) => ({ ...message, timestamp: message.timestamp * 1000 })),
          } });
          convertedHistory = true;
        });
        await page.reload();
        await expectMessageDate(page, fixture.inbound, seconds);
        await expectMessageDate(page, outbound.body, outbound.timestamp);
        expect(convertedHistory).toBe(true);
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
