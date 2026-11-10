import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canUseAttachmentCaption, outboundAttachmentDetails, readPickedAttachment } from '../src/services/outboundAttachment';

test('uses portable filenames and an allowlist of provider MIME types', async () => {
  const file = new Blob([new Uint8Array([0, 7, 42])]);
  const signal = new AbortController().signal;
  assert.deepEqual(await readPickedAttachment(file, { name: '..\\Fáctura 2026.PNG', mimeType: ' APPLICATION/PDF ', size: 3 }, signal), {
    bytes: new Uint8Array([0, 7, 42]), filename: 'Factura_2026.pdf', mimeType: 'application/pdf',
  });
  assert.throws(() => outboundAttachmentDetails('script.svg', 'image/svg+xml'), /compatible/);
  assert.equal(canUseAttachmentCaption('audio/mpeg'), false);
  assert.equal(canUseAttachmentCaption('application/pdf'), true);
});

test('checks the actual bytes and cancels an oversized stream with a misleading size', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5_000_000));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readPickedAttachment(
    { stream: () => stream }, { name: 'image.png', mimeType: 'image/png', size: 1 }, new AbortController().signal,
  ), /5 MB/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('cancelled reads release the stream and discard their bytes', async () => {
  const aborter = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([42])); },
    cancel() { cancelled = true; },
  });
  const pending = readPickedAttachment({ stream: () => stream }, { name: 'image.png', mimeType: 'image/png' }, aborter.signal);
  aborter.abort();
  assert.equal(await pending, null);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
