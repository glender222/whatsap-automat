import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { apiClient } from '../src/services/apiClient';
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from '../src/services/attachmentData';
import { authStorage, MemoryStorageBackend } from '../src/services/authStorage';

const originalFetch = globalThis.fetch;
const session = {
  apiUrl: 'https://fixture.invalid', accessToken: 'access-original', refreshToken: 'refresh-original', userId: '8', tenantId: '9',
};
const attachmentPath = '/api/v1/conversations/10/messages/20/attachments/30';
const document = new TextEncoder().encode('%PDF-1.4\nfixture');
const download = (signal = new AbortController().signal) => apiClient.getConversationAttachment('10', '20', '30', signal);

beforeEach(async () => {
  authStorage.setBackendForTest(new MemoryStorageBackend());
  await authStorage.saveAuthSession(session);
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('maps every canonical WhatsApp attachment and ignores external URLs and aliases', async () => {
  globalThis.fetch = async () => Response.json({ items: [{
    id: '20', direction: 'inbound', body: null, createdAt: '2026-11-09T10:00:00Z', deliveryState: 'delivered',
    channel: 'whatsapp-cloud', causedBy: { type: 'customer' }, attachments: [
      { id: '30', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 400, url: 'https://foreign.invalid/token' },
      { id: '31', filename: 'b.png', mimeType: 'image/png', sizeBytes: 500 },
      { id: 'wamid.legacy', mimeType: 'image/png' },
    ],
  }], nextCursor: null });
  const page = await apiClient.listConversationMessages('10');
  assert.deepEqual(page.messages[0].attachments, [
    { id: '30', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 400 },
    { id: '31', filename: 'b.png', mimeType: 'image/png', sizeBytes: 500 },
  ]);
});

test('downloads bytes from the signed origin with bearer, redirect denial and no cache', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, session.apiUrl + attachmentPath);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${session.accessToken}`);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    return new Response(document, { headers: { 'Content-Type': 'application/pdf' } });
  };
  assert.deepEqual(await download(), { bytes: document, mimeType: 'application/pdf' });
  await assert.rejects(apiClient.getConversationAttachment('10', 'wamid.alias', '30', new AbortController().signal), { status: 404 });
});

test('cancels oversized attachments announced in headers or discovered while reading bytes', async () => {
  for (const withLength of [false, true]) {
    let cancelled = false;
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = async () => new Response(bytes, {
      headers: withLength ? { 'Content-Length': String(MAX_ATTACHMENT_BYTES + 1) } : undefined,
    });
    await assert.rejects(download(), { status: 413 });
    assert.equal(cancelled, true);
  }
});

test('treats mislabeled images and active MIME as binary and sanitizes filenames', async () => {
  for (const mimeType of ['image/png', 'application/pdf', 'text/html', 'image/svg+xml']) {
    globalThis.fetch = async () => new Response('fixture body', { headers: { 'Content-Type': mimeType } });
    assert.equal((await download()).mimeType, 'application/octet-stream');
  }
  assert.equal(safeAttachmentName('../../recibo.html', 'application/pdf'), 'recibo.pdf');
  assert.equal(safeAttachmentName('a\\b\r\n.png', 'application/octet-stream'), 'b__.bin');
});

test('does not return cancelled or late bytes after switching the authenticated account', async () => {
  for (const cancel of [true, false]) {
    await authStorage.saveAuthSession(session);
    const controller = new AbortController();
    let complete!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = async (_url, init) => new Promise((resolve) => {
      complete = resolve;
      init?.signal?.addEventListener('abort', () => assert.equal(init.signal?.aborted, true), { once: true });
      started();
    });
    const pending = assert.rejects(download(controller.signal), cancel ? /cancelada/ : { status: 401 });
    await fetching;
    if (cancel) controller.abort();
    else await authStorage.saveAuthSession({ ...session, accessToken: 'other-access', tenantId: '11' });
    complete(new Response(document, { headers: { 'Content-Type': 'application/pdf' } }));
    await pending;
  }
});
