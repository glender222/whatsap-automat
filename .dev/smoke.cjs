// Local demo only. Run prepare, restart this Compose project, then run verify.
// The marker contains fixture IDs and a tag name; it never stores auth tokens.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || '../Frontend_py_whatsaapweb/node_modules/@playwright/test');

const phase = process.argv[2] || 'prepare';
assert.ok(['prepare', 'verify'].includes(phase), 'Usage: node .dev/smoke.cjs [prepare|verify]');
const apiOrigin = new URL(process.env.SMOKE_API_URL || 'http://api:3000').origin;
const webOrigin = new URL(process.env.SMOKE_WEB_URL || 'http://web:5173').origin;
const stateFile = process.env.SMOKE_STATE_FILE || '/tmp/automat-dev-smoke-state.json';
const outputDir = process.env.SMOKE_OUTPUT_DIR || path.dirname(stateFile);
const accounts = [
  { email: process.env.SMOKE_EMAIL || 'demo@automat.local', password: process.env.SMOKE_PASSWORD || 'Demo-local-2026!' },
  { email: process.env.SMOKE_SECOND_EMAIL || 'demo2@automat.local', password: process.env.SMOKE_SECOND_PASSWORD || 'Demo-local-2026!' },
];
const fixtureChatId = process.env.SMOKE_CHAT_ID || '12025550145';
let checks = 0;

async function check(label, operation) {
  await operation();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

async function waitUntilReady() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(apiOrigin + '/ready', { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return;
    } catch { /* The API may still be starting after restart. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('API readiness did not return 200 within 60 seconds');
}

async function apiRequest(auth, route, options = {}) {
  const response = await fetch(apiOrigin + route, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      ...(auth && { authorization: `Bearer ${auth.accessToken}` }),
      ...options.headers,
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  return { status: response.status, body };
}

async function list(auth, route) {
  const response = await apiRequest(auth, route);
  assert.equal(response.status, 200, `${route} should return 200`);
  assert.ok(Array.isArray(response.body?.data), `${route} should return an array envelope`);
  return response.body.data;
}

async function loginInBrowser(browser, account, index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const allowedOrigins = new Set([apiOrigin, webOrigin]);
  const externalRequests = [];
  const runtimeErrors = [];
  const realtime = { connected: false };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || allowedOrigins.has(url.origin)) return route.continue();
    externalRequests.push(url.origin);
    await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('websocket', (socket) => {
    const address = new URL(socket.url());
    const equivalentOrigin = `${address.protocol === 'wss:' ? 'https:' : 'http:'}//${address.host}`;
    if (!allowedOrigins.has(equivalentOrigin)) externalRequests.push(equivalentOrigin);
    if (address.pathname !== '/socket.io/') return;
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && payload.startsWith('40{')) realtime.connected = true;
    });
  });
  try {
    await page.goto(webOrigin + '/auth/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Correo electrónico', { exact: true }).fill(account.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
    const responsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, `Tenant ${index + 1} browser login failed`);
    const envelope = await response.json();
    const auth = envelope.data;
    assert.ok(auth?.accessToken && auth.user?.companyId, 'Real login did not return a scoped session');
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/'));
    return { context, page, auth, externalRequests, runtimeErrors, realtime };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function fixtureSnapshot(auth) {
  const chats = await list(auth, '/api/chats');
  const catalogs = await list(auth, '/api/catalogs');
  const products = await list(auth, '/api/products');
  const chat = chats.find((item) => item.id === fixtureChatId);
  const catalog = catalogs.find((item) => item.name === 'Colección local');
  assert.ok(chat, 'Seed conversation is missing');
  assert.ok(catalog, 'Seed catalog Colección local is missing');
  assert.ok(products.some((item) => item.sku === 'DEMO-LAMPARA'), 'Seed lamp product is missing');
  assert.ok(products.some((item) => item.sku === 'DEMO-MESA'), 'Seed table product is missing');
  assert.ok(catalog.itemCount >= 2, 'Seed catalog should contain both demo products');
  const messages = await list(auth, `/api/chats/${fixtureChatId}/messages`);
  assert.ok(messages.length > 0, 'Seed history is empty');
  return {
    companyId: String(auth.user.companyId), chatId: chat.id,
    conversationId: String(chat.conversationId), catalogId: String(catalog.id),
    productIds: products.map((item) => String(item.id)).sort(),
    messageIds: messages.map((item) => String(item.historyId || item.id)).sort(),
    messageBodies: messages.map((item) => item.body).filter(Boolean),
    imagePaths: [...new Set(products.map((item) => item.primaryImage?.url || item.imageUrl).filter(Boolean))].sort(),
  };
}

async function checkBindings() {
  const bindingFile = process.env.SMOKE_BINDINGS_FILE;
  if (!bindingFile) {
    console.log('# Host port bindings not checked here; pass SMOKE_BINDINGS_FILE with project-only docker inspect Ports JSON.');
    return;
  }
  await check('all published project ports bind to loopback', async () => {
    const services = JSON.parse(await readFile(bindingFile, 'utf8'));
    assert.ok(services && typeof services === 'object', 'Invalid bindings document');
    let published = 0;
    for (const [service, ports] of Object.entries(services)) {
      for (const bindings of Object.values(ports || {})) {
        if (bindings === null) continue;
        assert.ok(Array.isArray(bindings), `Invalid port map for ${service}`);
        for (const binding of bindings) {
          published += 1;
          assert.ok(['127.0.0.1', '::1'].includes(binding.HostIp), `${service} publishes a non-loopback port`);
        }
      }
    }
    assert.ok(published >= 2, 'Expected published API and web bindings');
  });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const saved = phase === 'verify' ? JSON.parse(await readFile(stateFile, 'utf8')) : undefined;
  if (saved) assert.equal(saved.version, 1, 'Unsupported smoke marker version');
  await check('API is ready after migrations or restart', waitUntilReady);
  await check('protected endpoints reject unauthenticated requests', async () => {
    assert.equal((await apiRequest(null, '/api/products')).status, 401);
  });
  await checkBindings();
  const browser = await chromium.launch({ headless: true });
  const sessions = [];
  try {
    for (const [index, account] of accounts.entries()) {
      await check(`tenant ${index + 1} logs in through the real browser form`, async () => {
        sessions.push(await loginInBrowser(browser, account, index));
      });
    }
    assert.notEqual(String(sessions[0].auth.user.companyId), String(sessions[1].auth.user.companyId), 'Demo accounts must belong to different tenants');
    const snapshots = [];
    for (const [index, session] of sessions.entries()) {
      await check(`tenant ${index + 1} has seeded catalog, products and inbox history`, async () => {
        snapshots[index] = await fixtureSnapshot(session.auth);
      });
      await check(`tenant ${index + 1} renders its inbox and catalog`, async () => {
        await session.page.goto(webOrigin + '/gestion-web/inicio?chat=' + fixtureChatId);
        const history = session.page.getByRole('region', { name: 'Historial de mensajes' });
        await history.waitFor();
        await history.getByText(snapshots[index].messageBodies[0], { exact: true }).first().waitFor();
        const realtimeDeadline = Date.now() + 10000;
        while (!session.realtime.connected && Date.now() < realtimeDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(session.realtime.connected, true, 'Authenticated Socket.IO handshake did not complete through the web proxy');
        await session.page.getByRole('button', { name: 'Actualizar estado', exact: true }).waitFor();
        const conversation = session.page.getByRole('region', { name: 'Conversación seleccionada' });
        assert.equal(await conversation.getByRole('alert').count(), 0, 'Conversation readiness returned an operational error');
        assert.equal((await apiRequest(session.auth, `/api/v1/conversations/${snapshots[index].conversationId}`)).status, 200, 'Own canonical conversation should be readable');
        await session.page.screenshot({ path: path.join(outputDir, `${phase}-inbox-${index + 1}.png`) });
        await session.page.getByRole('navigation', { name: 'Espacio de trabajo' }).getByRole('link', { name: 'Catálogos', exact: true }).click();
        await session.page.getByRole('heading', { name: 'Gestionar catalogos', exact: true }).waitFor();
        await session.page.getByRole('heading', { name: 'Colección local', exact: true }).waitFor();
        await session.page.screenshot({ path: path.join(outputDir, `${phase}-catalog-${index + 1}.png`) });
        assert.ok(snapshots[index].imagePaths.length > 0, 'Seed product image is missing');
        for (const imagePath of snapshots[index].imagePaths) {
          const imageUrl = new URL(imagePath, webOrigin);
          assert.equal(imageUrl.origin, webOrigin, 'Demo product media must stay local');
          const image = await session.context.request.get(imageUrl.href);
          assert.equal(image.status(), 200, 'Product image is not served through the web origin');
          assert.match(image.headers()['content-type'] || '', /^image\//, 'Product image route returned a non-image response');
        }
      });
    }
    await check('tenant APIs keep shared chat identifiers and catalog data isolated', async () => {
      assert.notEqual(snapshots[0].conversationId, snapshots[1].conversationId, 'Conversation identifiers leaked across tenants');
      assert.notEqual(snapshots[0].catalogId, snapshots[1].catalogId, 'Catalog identifiers leaked across tenants');
      for (const [index, session] of sessions.entries()) {
        const other = snapshots[1 - index];
        assert.ok(snapshots[index].messageBodies.some((body) => !other.messageBodies.includes(body)), 'Seed histories need a tenant-specific message');
        const names = ['Casa Oliva Demo', 'Taller Nube Demo'];
        assert.ok(snapshots[index].messageBodies.some((body) => body.includes(`Consulta de ${names[index]}:`)), 'Own tenant-specific seed message is missing');
        assert.ok(!snapshots[index].messageBodies.some((body) => body.includes(`Consulta de ${names[1 - index]}:`)), 'Foreign tenant-specific message leaked into history');
        for (const productId of other.productIds) {
          assert.ok(!snapshots[index].productIds.includes(productId), 'Product identifiers leaked across tenants');
          assert.equal((await apiRequest(session.auth, `/api/products/${productId}`)).status, 404, 'Foreign product should be hidden');
        }
        const foreignChats = await apiRequest(session.auth, `/api/v1/conversations/${other.conversationId}`);
        assert.equal(foreignChats.status, 404, 'Foreign conversation should be hidden');
      }
    });

    let marker;
    if (phase === 'prepare') {
      await check('create and assign a durable smoke tag through the API', async () => {
        const tagName = 'Smoke local ' + randomUUID().slice(0, 8);
        const created = await apiRequest(sessions[0].auth, '/api/tags', { method: 'POST', body: { name: tagName } });
        assert.equal(created.status, 200, 'Tag creation failed');
        assert.ok(created.body?.data?.id, 'Created tag has no ID');
        marker = { version: 1, createdAt: new Date().toISOString(), snapshots, tagId: String(created.body.data.id), tagName };
        assert.equal((await apiRequest(sessions[0].auth, `/api/tags/${marker.tagId}/chats`, { method: 'POST', body: { chatId: fixtureChatId } })).status, 200, 'Tag assignment failed');
        await mkdir(path.dirname(stateFile), { recursive: true });
        await writeFile(stateFile, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 });
      });
    } else {
      marker = saved;
      await check('seed identities and history persist across the real stack restart', async () => {
        assert.deepEqual(snapshots, marker.snapshots, 'Persistent seed data changed across restart');
      });
    }
    await check(`${phase}: durable tag and assignment are present`, async () => {
      const tags = await list(sessions[0].auth, '/api/tags');
      assert.ok(tags.some((tag) => String(tag.id) === marker.tagId && tag.name === marker.tagName), 'Smoke tag is missing');
      const chats = await list(sessions[0].auth, `/api/tags/${marker.tagId}/chats`);
      assert.ok(chats.includes(fixtureChatId), 'Smoke tag assignment is missing');
      await sessions[0].page.goto(webOrigin + '/gestion-web/inicio');
      await sessions[0].page.getByRole('combobox', { name: 'Etiqueta', exact: true }).selectOption({ label: marker.tagName });
      await sessions[0].page.getByText('Lucía Demo', { exact: true }).first().waitFor();
    });
    await check('foreign tenant cannot read or modify the durable tag', async () => {
      assert.equal((await apiRequest(sessions[1].auth, `/api/tags/${marker.tagId}/chats`)).status, 404);
      assert.equal((await apiRequest(sessions[1].auth, `/api/tags/${marker.tagId}/chats`, { method: 'POST', body: { chatId: fixtureChatId } })).status, 404);
      assert.ok(!(await list(sessions[1].auth, '/api/tags')).some((tag) => String(tag.id) === marker.tagId), 'Foreign tag appeared in list');
    });
    await check('browser execution uses local services without runtime errors', async () => {
      for (const session of sessions) {
        assert.deepEqual(session.externalRequests, [], 'Browser attempted an external request');
        assert.deepEqual(session.runtimeErrors, [], 'Browser runtime error');
      }
    });
    console.log(`# ${phase}: ${checks} checks passed. Marker: ${stateFile}`);
    if (phase === 'prepare') console.log('# Restart this Compose project, then run verify with the same SMOKE_STATE_FILE.');
  } finally {
    await Promise.all(sessions.map((session) => session.context.close()));
    await browser.close();
  }
}

main().catch((error) => {
  // Keep tokens, response payloads and browser storage out of logs.
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
});
