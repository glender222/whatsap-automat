import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { provisionCompanies, type Company } from './fixtures/provisionCompanies';

const backend = process.env.PRODUCT_SMOKE_URL!;
test.skip(!backend || !process.env.STUDIO_FIXTURE_URL, 'Requires the local Studio verification backend and isolated PostgreSQL');
const studio = '/dashboard/ia/estudio';
const graph = {
  entryNodeId: 'agent', policyRef: 'independent-review', nodes: [
    { id: 'agent', kind: 'agent', config: { provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', prompt: 'Navegación QA', maxTokens: 40 } },
    { id: 'end', kind: 'end', config: {} },
  ], edges: [{ id: 'finish', from: 'agent', to: 'end' }],
  limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10, maxModelTokens: 900000, maxCostMicroUsd: 700000 },
};

async function focusedInView(page: Page, element: Locator) {
  await expect(element).toBeFocused();
  const position = await element.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const content = document.querySelector('main')!.getBoundingClientRect();
    const top = Math.max(content.top, 0);
    const bottom = Math.min(content.bottom, innerHeight);
    const atCenter = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return { inside: bounds.top >= top && bounds.bottom <= bottom,
      unobscured: node === atCenter || node.contains(atCenter), top: bounds.top, bottom: bounds.bottom, viewport: [top, bottom] };
  });
  expect(position).toMatchObject({ inside: true, unobscured: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, theme] of [[1280, 'Oscuro'], [390, 'Claro']] as const) {
  test(`Studio explicit return preserves origin, focus, theme and direct links at ${width}px ${theme}`, async ({ page, request }) => {
    test.setTimeout(45_000);
    const [company] = provisionCompanies('--studio');
    const headers = { authorization: `Bearer ${company.auth.accessToken}` };
    const api = `${backend}/api/v1/agent-graphs`;
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const response = await request.post(api, { headers, data: { ...graph, graphId: `review-${String(index).padStart(2, '0')}` } });
      expect(response.status()).toBe(201);
    }));
    const target = 'review-23';
    expect((await request.post(`${api}/${target}/revisions`, { headers, data: { ...graph, policyRef: 'second' } })).status()).toBe(201);
    await page.setViewportSize({ width, height: 680 });
    await page.emulateMedia({ colorScheme: theme === 'Claro' ? 'dark' : 'light' });
    await page.addInitScript(({ auth, theme }) => {
      if (!localStorage.getItem('auth')) localStorage.setItem('auth', JSON.stringify(auth));
      if (!localStorage.getItem('app:theme')) localStorage.setItem('app:theme', theme);
    }, { auth: company.auth, theme });
    const assertTheme = async () => expect(await page.locator('html').evaluate((html) => html.classList.contains('dark'))).toBe(theme === 'Oscuro');
    const pageTwo = `${studio}?after=review-11`;
    await page.goto(studio);
    await page.getByRole('button', { name: 'Siguiente página', exact: true }).press('Enter');
    await expect(page).toHaveURL(pageTwo);
    await focusedInView(page, page.getByRole('status', { name: '' }).filter({ hasText: '12 borradores en esta página' }));
    const card = page.getByRole('link', { name: new RegExp(target) });
    await card.press('Enter');
    const title = page.getByRole('heading', { name: target, exact: true });
    await focusedInView(page, title);
    await assertTheme();
    await page.getByRole('link', { name: 'Anterior', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}?version=1&after=review-11`);
    await focusedInView(page, title);
    await page.reload();
    await focusedInView(page, title);
    await assertTheme();
    await page.getByRole('link', { name: 'Siguiente', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}?version=2&after=review-11`);
    await page.getByRole('link', { name: 'Anterior', exact: true }).press('Enter');
    await page.getByRole('link', { name: 'Última revisión', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}?after=review-11`);
    await page.getByRole('link', { name: 'Crear revisión desde este borrador', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}/revisiones/nueva?from=2&after=review-11`);
    await expect(page.getByRole('button', { name: 'Guardar borrador' })).toBeEnabled();
    await focusedInView(page, page.getByRole('heading', { name: 'Nuevo borrador de revisión', exact: true }));
    await page.keyboard.press('Shift+Tab');
    await focusedInView(page, page.getByRole('link', { name: 'Volver al grafo', exact: true }));
    await page.getByRole('link', { name: 'Volver al grafo', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}?version=2&after=review-11`);
    await focusedInView(page, title);
    await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
    await expect(page).toHaveURL(pageTwo);
    await focusedInView(page, card);
    await assertTheme();
    await page.screenshot({ path: test.info().outputPath('returned-last-card.png') });
    await page.getByRole('link', { name: 'Nuevo grafo', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/nuevo?after=review-11`);
    await focusedInView(page, page.getByRole('heading', { name: 'Nuevo grafo de agente', exact: true }));
    await page.keyboard.press('Shift+Tab');
    await focusedInView(page, page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }));
    await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
    await focusedInView(page, page.getByRole('link', { name: 'Nuevo grafo', exact: true }));
    await page.goto(`${studio}/grafos/${target}?version=invalid&after=review-11`);
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('link', { name: 'Abrir última revisión', exact: true }).press('Enter');
    await expect(page).toHaveURL(`${studio}/grafos/${target}?after=review-11`);
    await focusedInView(page, title);
    await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
    await expect(page).toHaveURL(pageTwo);
    await focusedInView(page, card);
    await page.goto(`${studio}/grafos/${target}?version=1`);
    await focusedInView(page, title);
    await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
    await expect(page).toHaveURL(studio);
    await focusedInView(page, page.getByRole('status', { name: '' }).filter({ hasText: '12 borradores en esta página' }));
    await assertTheme();
  });
}

async function seedPage(request: APIRequestContext, company: Company, policyRef = 'history-fixture') {
  await Promise.all(Array.from({ length: 25 }, async (_, index) => {
    const response = await request.post(`${backend}/api/v1/agent-graphs`, {
      headers: { authorization: `Bearer ${company.auth.accessToken}` },
      data: { ...graph, policyRef, graphId: `back-${String(index).padStart(2, '0')}` },
    });
    expect(response.status()).toBe(201);
  }));
}

const pageTwo = `${studio}?after=back-11`;
const scrollTop = (page: Page) => page.locator('main').evaluate((node) => node.scrollTop);

async function start(page: Page, company: Company, width = 390) {
  await page.setViewportSize({ width, height: 680 });
  await page.addInitScript((auth) => {
    if (!localStorage.getItem('auth')) localStorage.setItem('auth', JSON.stringify(auth));
  }, company.auth);
  await page.goto(pageTwo);
  await expect(page.getByRole('link', { name: /back-23/ })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`Studio browser Back restores its entry after reload and explicit returns at ${width}px`, async ({ page, request }) => {
    const [company] = provisionCompanies('--studio');
    await seedPage(request, company);
    await start(page, company, width);
    const card = page.getByRole('link', { name: /back-23/ });
    await card.focus();
    const originScroll = await scrollTop(page);
    expect(originScroll).toBeGreaterThan(0);
    const listKey = await page.evaluate(() => history.state.key);
    expect(listKey).not.toBe('default');
    await card.press('Enter');
    const title = page.getByRole('heading', { name: 'back-23', exact: true });
    await focusedInView(page, title);
    const detailKey = await page.evaluate(() => history.state.key);
    await page.reload();
    await focusedInView(page, title);
    expect(await page.evaluate(() => history.state.key)).toBe(detailKey);
    await page.goBack();
    await expect(page).toHaveURL(pageTwo);
    expect(await page.evaluate(() => history.state.key)).toBe(listKey);
    await focusedInView(page, card);
    expect(await scrollTop(page)).toBeCloseTo(originScroll, 0);
    await page.goForward();
    await focusedInView(page, title);
    await page.goBack();
    await focusedInView(page, card);
    await page.screenshot({ path: test.info().outputPath('browser-back-restored.png') });

    // A graph loading in the background must not take focus from an already usable return link.
    let releaseDraft!: () => void;
    const heldDraft = new Promise<void>((resolve) => { releaseDraft = resolve; });
    await page.route(`${backend}/api/v1/agent-graphs/back-23`, async (route) => {
      await heldDraft;
      await route.continue();
    }, { times: 1 });
    await card.press('Enter');
    const returnLink = page.getByRole('link', { name: 'Volver a Agent Studio', exact: true });
    try {
      await expect(page.getByRole('status').filter({ hasText: 'Cargando revisión…' })).toBeVisible();
      await returnLink.focus();
      await focusedInView(page, returnLink);
    } finally { releaseDraft(); }
    await expect(title).toBeVisible();
    await focusedInView(page, returnLink);
    await page.keyboard.press('Enter');
    await focusedInView(page, card);

    // Explicit return leaves location.state behind; the next POP must restore the most recent card.
    const secondCard = page.getByRole('link', { name: /back-12/ });
    await secondCard.press('Enter');
    await focusedInView(page, page.getByRole('heading', { name: 'back-12', exact: true }));
    await page.goBack();
    await focusedInView(page, secondCard);
    await page.reload();
    await focusedInView(page, secondCard);

    const newGraph = page.getByRole('link', { name: 'Nuevo grafo', exact: true });
    await newGraph.press('Enter');
    await expect(page.getByRole('heading', { name: 'Nuevo grafo de agente', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nuevo grafo de agente', exact: true })).toBeVisible();
    await page.goBack();
    await focusedInView(page, newGraph);

    // A fresh direct URL is a different history entry, even when its cursor matches.
    const previousKey = await page.evaluate(() => history.state.key);
    await page.goto(`${studio}/grafos/back-23`);
    await focusedInView(page, title);
    await page.goto(pageTwo);
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => history.state.key)).not.toBe(previousKey);
    await expect(card).not.toBeFocused();
    await expect(newGraph).not.toBeFocused();
    expect(await scrollTop(page)).toBe(0);
  });
}

test('Studio history ignores another company and a new login, even with matching graph IDs and stale return state', async ({ page, request }) => {
  const [companyA, companyB] = provisionCompanies('--studio');
  await Promise.all([seedPage(request, companyA, 'company-a'), seedPage(request, companyB, 'company-b')]);
  await start(page, companyA);
  const card = page.getByRole('link', { name: /back-23/ });
  await card.press('Enter');
  await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
  await focusedInView(page, card);
  await page.getByRole('link', { name: /back-12/ }).press('Enter');
  await focusedInView(page, page.getByRole('heading', { name: 'back-12', exact: true }));
  await page.evaluate((auth) => {
    localStorage.setItem('auth', JSON.stringify(auth));
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth' }));
  }, companyB.auth);
  await expect(page.getByText('Política company-b', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(pageTwo);
  await expect(card).toContainText('company-b');
  await expect(card).not.toBeFocused();
  await expect(page.getByRole('link', { name: /back-12/ })).not.toBeFocused();
  expect(await scrollTop(page)).toBe(0);

  // The new company can remember its own position; no old graph contents or credentials are cached.
  await card.press('Enter');
  await focusedInView(page, page.getByRole('heading', { name: 'back-23', exact: true }));
  await page.goBack();
  await focusedInView(page, card);
  const safeCache = await page.evaluate(() => {
    const auth = JSON.parse(localStorage.getItem('auth')!);
    const raw = sessionStorage.getItem('studio:list-history')!;
    return !raw.includes(auth.accessToken) && !raw.includes(auth.refreshToken) &&
      !raw.includes('company-a') && !raw.includes('company-b');
  });
  expect(safeCache).toBe(true);
  await card.press('Enter');
  await focusedInView(page, page.getByRole('heading', { name: 'back-23', exact: true }));
  await page.evaluate(() => {
    const auth = JSON.parse(localStorage.getItem('auth')!);
    localStorage.setItem('auth', JSON.stringify({ ...auth, browserSessionId: crypto.randomUUID() }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth' }));
  });
  await expect(page.getByText('Política company-b', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(card).toContainText('company-b');
  await expect(card).not.toBeFocused();
  expect(await scrollTop(page)).toBe(0);

  await card.press('Enter');
  await page.getByRole('link', { name: 'Volver a Agent Studio', exact: true }).press('Enter');
  await focusedInView(page, card);
  await page.evaluate((auth) => {
    localStorage.setItem('auth', JSON.stringify({ ...auth, browserSessionId: crypto.randomUUID() }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth' }));
  }, companyA.auth);
  await expect(card).toContainText('company-a');
  await expect(card).not.toBeFocused();
  expect(await scrollTop(page)).toBe(0);
});
