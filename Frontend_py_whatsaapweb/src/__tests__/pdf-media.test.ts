import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosError } from 'axios';
import { api } from '../shared/axios/http';
import { isPdfFile, loadPdfBlob } from '../shared/components/pdfMedia';

Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'https://app.example.test' } } });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'local-fixture-token' } });
api.defaults.baseURL = 'https://api.example.test/edge/api';
const pdf = new Blob(['%PDF-1.7\noriginal bytes'], { type: 'application/pdf' });

test('PDF detection supports the declared MIME or case-insensitive filename', () => {
  assert.equal(isPdfFile('APPLICATION/PDF; charset=binary'), true);
  assert.equal(isPdfFile('', 'Original.PDF'), true);
  assert.equal(isPdfFile(null, null), false);
  assert.equal(isPdfFile('application/pdf-malicious', 'Original.docx'), false);
});

test('tenant media uses the authenticated API and preserves the original bytes', async (context) => {
  const original = api.defaults.adapter;
  const signal = new AbortController().signal;
  let requests = 0;
  api.defaults.adapter = async (request) => {
    requests++;
    assert.equal(request.url, '/media/wamid.fixture?variant=original');
    assert.equal(request.headers.get('Authorization'), 'Bearer local-fixture-token');
    assert.equal(request.responseType, 'blob');
    assert.equal(request.signal, signal);
    return { data: pdf, status: 200, statusText: 'OK', headers: {}, config: request };
  };
  context.after(() => { api.defaults.adapter = original; });
  assert.equal(await loadPdfBlob('/api/media/wamid.fixture?variant=original', signal), pdf);
  assert.equal(await loadPdfBlob('https://api.example.test/edge/api/media/wamid.fixture?variant=original', signal), pdf);
  assert.equal(requests, 2);
});

test('an external lookalike media URL is fetched without cookies, headers or redirects', async (context) => {
  const signal = new AbortController().signal;
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://files.example.test/api/media/file.pdf');
    assert.deepEqual(options, { credentials: 'omit', redirect: 'error', signal });
    return new Response(pdf);
  });
  assert.equal(await (await loadPdfBlob('https://files.example.test/api/media/file.pdf', signal)).text(), await pdf.text());
  await assert.rejects(loadPdfBlob('javascript:alert(1)', signal), /no es válida/);
});

test('forbidden media and non-PDF content cannot produce a download blob', async (context) => {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => {
    throw new AxiosError('Denied', 'ERR_BAD_REQUEST', request, undefined, {
      status: 403, statusText: 'Forbidden', headers: {}, data: {}, config: request,
    });
  };
  context.after(() => { api.defaults.adapter = original; });
  const signal = new AbortController().signal;
  await assert.rejects(loadPdfBlob('/api/media/private', signal), /no tiene acceso/);
  context.mock.method(globalThis, 'fetch', async () => new Response('<!doctype html>'));
  await assert.rejects(loadPdfBlob('https://files.example.test/invalid.pdf', signal), /no devolvió un archivo PDF/);
});
