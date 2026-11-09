import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import type WhatsAppService from '../services/whatsappService';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.LEGACY_META_TEST_DATABASE_URL;
const tenantA = randomInt(530_000_000, 630_000_000);
const tenantB = tenantA + 1;
const phone = '12025550145';
const graphPhoneId = String(tenantA) + '73';
const fixtureToken = 'test-only-legacy-graph-token';

function token(tenantId: number) {
  return jwt.sign({ companyId: tenantId, userId: tenantId + 2, rol: 'EMPLEADO' }, process.env.JWT_SECRET!);
}

async function listen(t: TestContext, server: Server) {
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function multipart(
  fields: Record<string, string>, mimeType = 'image/png', filename = 'fixture.png', content: BlobPart = 'fixture-file',
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([content], { type: mimeType }), filename);
  return form;
}

test('legacy HTTP routes never send or persist free-form Meta text and preserve authorized sends', {
  skip: !connectionString && 'LEGACY_META_TEST_DATABASE_URL is required',
}, async (t) => {
  // Use the same connection as the production route middleware, including forced RLS.
  const database = new URL(connectionString!);
  process.env.DB_HOST = database.hostname;
  process.env.DB_PORT = database.port || '5432';
  process.env.DB_NAME = database.pathname.slice(1);
  process.env.DB_USER = decodeURIComponent(database.username);
  process.env.DB_PASSWORD = decodeURIComponent(database.password);
  process.env.WHATSAPP_PROVIDER = 'webjs';
  process.env.CONVERSATIONS_PERSIST_WRITES = 'true';

  const config = (await import('../config/index')).default;
  const db = (await import('../config/database')).default;
  const { TenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { requireJwt } = await import('../middleware/jwtAuth');
  const { requireChatTenantAccess } = await import('../middleware/resourceAuth');
  const { default: createChatCompatRoutes } = await import('../routes/chatCompatRoutes');
  const { default: createWhatsAppRoutes } = await import('../routes/whatsappRoutes');
  const { default: WhatsApp } = await import('../services/whatsappService');
  const { cleanRejectedUpload } = require('../middleware/legacyHumanSend');
  const createChatRoutes = require('../routes/chatRoutes');
  const createMediaRoutes = require('../routes/mediaRoutes');
  const ChatController = require('../controllers/chatController');
  const multer = require('multer');
  const { errorHandler } = require('../middleware/errorHandler');

  const uploadDir = await mkdtemp(join(tmpdir(), 'whatsap-legacy-send-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  t.after(() => db.end());
  config.whatsapp.provider = 'meta-cloud';
  config.multer.dest = uploadDir;
  // tsx also executes the JS routes against the source CommonJS config.
  require('../config').multer.dest = uploadDir;
  const uow = new TenantScopedUoW(db);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, async (client) => {
      await client.query("INSERT INTO companies (id,name) VALUES ($1,'Legacy send fixture')", [tenantId]);
      await client.query(
        "INSERT INTO usuarios (id,company_id,nombre,email,password_hash) VALUES ($1,$2,'Fixture',$3,'unused')",
        [tenantId + 2, tenantId, `legacy-send-${tenantId}@invalid.test`],
      );
    });
  }
  const whatsapp = new WhatsApp();
  await whatsapp.metaAccountStore!.upsertConnection(tenantA, {
    phoneNumberId: graphPhoneId, accessToken: fixtureToken, graphVersion: 'v25.0',
  });
  const { rows: [conversation] } = await uow.run(tenantA, (client) => client.query(
    "INSERT INTO conversations (company_id,channel,external_conversation_id) VALUES ($1,'whatsapp',$2) RETURNING id",
    [tenantA, phone],
  ));

  const attempts: {
    path: string; type?: string; payload: string; media?: { mimeType: string; name: string; bytes: Buffer };
  }[] = [];
  let failUpload = false;
  let failVideoSend = false;
  const graph = await listen(t, createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const payload = bytes.toString();
    assert.equal(req.headers.authorization, `Bearer ${fixtureToken}`);
    assert.equal(req.method, 'POST');
    const path = req.url || '';
    const upload = path.endsWith('/media');
    const data = upload ? undefined : JSON.parse(payload);
    let media;
    if (upload && process.env.LEGACY_META_TEST_VIDEO === '1') {
      const parts = await new Response(bytes, { headers: { 'content-type': req.headers['content-type']! } }).formData();
      const file = parts.get('file');
      assert.ok(file instanceof File);
      assert.equal(parts.get('type'), file.type);
      media = { mimeType: file.type, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
    }
    attempts.push({ path, type: data?.type, payload, media });
    res.setHeader('content-type', 'application/json');
    if ((upload && failUpload) || (data?.type === 'video' && failVideoSend)) {
      res.writeHead(400).end(JSON.stringify({ error: { message: 'fixture rejection' } }));
      return;
    }
    res.end(JSON.stringify(upload ? { id: 'media-fixture-' + attempts.length }
      : { messages: [{ id: 'wamid.fixture-' + attempts.length }] }));
  }).listen(0, '127.0.0.1'));
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://graph.facebook.com');
    assert.equal(target.pathname.split('/')[2], graphPhoneId);
    return nativeFetch(`${graph}${target.pathname}${target.search}`, init);
  });

  const coreCalls: unknown[] = [];
  const conversationCore = { conversationService: {
    requestOutbound: async (dto: unknown) => { coreCalls.push(dto); return { providerMessageId: 'web-core-fixture' }; },
  } };
  const app = express();
  app.use(express.json());
  app.use('/api/chats', requireJwt, createChatCompatRoutes(whatsapp));
  // Exercise the JS controller independently as well as its production path.
  app.use('/api/js-chats', requireJwt, createChatRoutes(whatsapp, conversationCore));
  app.use('/api/whatsapp', requireJwt, createWhatsAppRoutes(whatsapp));
  app.use('/api/media', requireJwt, createMediaRoutes(whatsapp));
  const chatController = new ChatController(whatsapp, conversationCore);
  const upload = multer({ dest: uploadDir });
  app.post('/send-message', requireJwt, upload.single('file'),
    cleanRejectedUpload(requireChatTenantAccess), chatController.sendMessageLegacy);

  const webCalls: unknown[][] = [];
  const webjs = {
    provider: 'webjs',
    sendMessage: async (...args: unknown[]) => {
      webCalls.push(args);
      return { id: { _serialized: 'web-fixture' }, timestamp: 1 };
    },
  } as unknown as WhatsAppService;
  app.use('/webjs/chats', requireJwt, createChatRoutes(webjs, conversationCore));
  app.use('/webjs/whatsapp', requireJwt, createWhatsAppRoutes(webjs));
  app.use(errorHandler);

  const api = await listen(t, app.listen(0, '127.0.0.1'));
  async function send(path: string, body: FormData | Record<string, unknown>, bearer: string | null = token(tenantA)) {
    const isMultipart = body instanceof FormData;
    const response = await nativeFetch(api + path, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(!isMultipart ? { 'content-type': 'application/json' } : {}),
        'x-tenant-id': String(tenantB),
      },
      body: isMultipart ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function assertCleanUploadDir() {
    for (let check = 0; check < 50; check++) {
      if (!(await readdir(uploadDir)).length) return;
      await delay(10);
    }
    assert.deepEqual(await readdir(uploadDir), []);
  }

  const chat = `/api/chats/${phone}/messages`;
  const jsChat = `/api/js-chats/${phone}/messages`;
  const whatsappAlias = '/api/whatsapp/send-message';
  const counts = async (companyId = tenantA) => uow.run(companyId, async (client) => (await client.query(`
    SELECT (SELECT count(*)::int FROM messages) AS messages,
           (SELECT count(*)::int FROM conversation_send_claims) AS claims,
           (SELECT count(*)::int FROM operational_actions) AS actions
  `)).rows[0]);
  const before = await counts();
  for (const path of [chat, jsChat, whatsappAlias, '/api/media/send', '/send-message']) {
    const result = await send(path, { chatId: phone, message: 'do not send' });
    assert.equal(result.status, 409, path);
    assert.equal(result.body.error, 'CANONICAL_TEXT_SEND_REQUIRED');
    assert.equal(result.body.endpoint, '/api/v1/conversations/{id}/messages');
  }
  for (const templateName of [true, [], {}, '   ', 'approved_fixture']) {
    assert.equal((await send(chat, { message: 'do not send', templateName })).status, 409);
  }
  assert.equal((await send(chat, { message: ['do not send'], templateName: 'approved_fixture' })).status, 400);
  assert.deepEqual(await counts(), before);
  assert.deepEqual(coreCalls, []);
  assert.deepEqual(attempts, []);

  const rejectedUploads = await Promise.all([
    send(whatsappAlias, multipart({}), token(tenantA)),
    send('/api/media/send', multipart({ chatId: String(conversation.id) }), token(tenantB)),
    send('/api/media/send-document', multipart({ chatId: phone }), token(tenantA)),
    send('/send-message', multipart({ chatId: String(conversation.id) }), token(tenantB)),
    send(chat, multipart({ message: 'caption' }), null),
  ]);
  assert.deepEqual(rejectedUploads.map((result) => result.status), [400, 404, 400, 404, 401]);
  await assertCleanUploadDir();
  assert.deepEqual(attempts, []);

  const aborted = httpRequest(api + chat, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token(tenantA)}`,
      'content-type': 'multipart/form-data; boundary=aborted-legacy-send',
    },
  });
  aborted.on('error', () => {});
  try {
    aborted.write('--aborted-legacy-send\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\n' +
      'Content-Type: image/png\r\n\r\npartially uploaded fixture');
    for (let check = 0; check < 50 && !(await readdir(uploadDir)).length; check++) await delay(10);
    assert.equal((await readdir(uploadDir)).length, 1);
  } finally {
    aborted.destroy();
  }
  await assertCleanUploadDir();
  assert.deepEqual(attempts, []);

  const media = await send(chat, multipart({ message: 'caption retained' }));
  assert.equal(media.status, 200);
  assert.equal(media.body.sentType, 'media');
  assert.equal(media.body.messageId, 'wamid.fixture-2');
  assert.match(attempts[0].payload, /fixture-file/);
  assert.equal(JSON.parse(attempts[1].payload).image.caption, 'caption retained');
  await assertCleanUploadDir();

  for (const path of [chat, jsChat, whatsappAlias]) {
    const template = await send(path, { chatId: phone, template: 'approved_fixture', language: 'es' });
    assert.equal(template.status, 200);
    assert.equal(template.body.data.sentType, 'template');
    assert.equal(attempts[attempts.length - 1].type, 'template');
    assert.equal(JSON.parse(attempts[attempts.length - 1].payload).template.name, 'approved_fixture');
  }
  assert.deepEqual(coreCalls, []);
  assert.equal((await send('/api/media/send-media', multipart({ chatId: phone }))).status, 200);
  assert.equal((await send('/api/media/send-document', multipart({ chatId: phone }, 'application/pdf', 'doc.pdf'))).status, 200);
  const oldAlias = await send('/send-message', multipart({ chatId: phone }));
  assert.equal(oldAlias.status, 200);
  assert.match(oldAlias.body.messageId, /^wamid\.fixture-/);
  const whatsappMedia = await send(whatsappAlias, multipart({ chatId: phone }));
  assert.equal(whatsappMedia.status, 200);
  assert.equal(whatsappMedia.body.data.sentType, 'media');
  assert.match(whatsappMedia.body.data.messageId, /^wamid\.fixture-/);
  await assertCleanUploadDir();
  const afterApproved = await counts();
  assert.equal(afterApproved.messages - before.messages, 8);

  failUpload = true;
  assert.ok((await send(whatsappAlias, multipart({ chatId: phone }))).status >= 400);
  await assertCleanUploadDir();
  assert.deepEqual(await counts(), afterApproved);
  assert.equal(attempts.filter((attempt) => attempt.type === 'text').length, 0);

  assert.equal((await send('/webjs/whatsapp/send-message', { chatId: phone, message: 'development text' })).status, 200);
  assert.equal((await send(`/webjs/chats/${phone}/messages`, { message: 'development core text' })).status, 200);
  assert.equal(webCalls[0][1], 'development text');
  assert.equal((coreCalls[0] as { body: string }).body, 'development core text');

  await t.test('real WebM becomes H.264/AAC MP4 and video cleanup is tenant-safe', {
    skip: process.env.LEGACY_META_TEST_VIDEO !== '1' && 'Set LEGACY_META_TEST_VIDEO=1 with FFmpeg and ffprobe on PATH',
  }, async () => {
    const source = execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.5',
      '-c:v', 'libvpx', '-c:a', 'libopus', '-f', 'webm', 'pipe:1',
    ], { timeout: 10_000 });
    function probe(input: Buffer) {
      return JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=format_name:stream=codec_name,codec_type',
        '-of', 'json', 'pipe:0',
      ], { input, timeout: 10_000, encoding: 'utf8' })) as {
        format: { format_name: string }; streams: { codec_type: string; codec_name: string }[];
      };
    }
    assert.deepEqual(probe(source).streams.map((stream) => stream.codec_name), ['vp8', 'opus']);
    const video = (fields: Record<string, string>, bytes: Buffer = source) =>
      multipart(fields, 'video/webm', 'fixture.webm', new Uint8Array(bytes));
    failUpload = false;
    const mediaRoute = '/api/media/send-media';
    const beforeA = await counts();
    const beforeB = await counts(tenantB);
    const beforeAttempts = attempts.length;
    for (const route of [mediaRoute, `/api/chats/${conversation.id}/messages`]) {
      assert.equal((await send(route, video({ chatId: String(conversation.id) }), token(tenantB))).status, 404);
    }
    await assertCleanUploadDir();
    assert.equal(attempts.length, beforeAttempts);

    for (const route of [mediaRoute, chat]) {
      const start = attempts.length;
      const response = await send(route, video({ chatId: phone, message: 'Fixture video' }));
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const [uploadAttempt, sendAttempt] = attempts.slice(start);
      assert.equal(attempts.length - start, 2);
      assert.equal(uploadAttempt.media?.mimeType, 'video/mp4', route);
      assert.equal(uploadAttempt.media?.name, 'fixture.mp4');
      const encoded = probe(uploadAttempt.media!.bytes);
      assert.match(encoded.format.format_name, /mp4/);
      assert.deepEqual(encoded.streams.map((stream) => [stream.codec_type, stream.codec_name]), [
        ['video', 'h264'], ['audio', 'aac'],
      ]);
      assert.equal(sendAttempt.type, 'video');
      assert.deepEqual(JSON.parse(sendAttempt.payload).video, {
        id: 'media-fixture-' + (start + 1), caption: 'Fixture video',
      });
      const { rows: [attachment] } = await uow.run(tenantA, (client) => client.query(`
        SELECT a.mime_type, a.size_bytes::int, a.provider_media_id
        FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.provider_message_id = $1
      `, ['wamid.fixture-' + (start + 2)]));
      assert.deepEqual(attachment, {
        mime_type: 'video/mp4', size_bytes: uploadAttempt.media!.bytes.length, provider_media_id: 'media-fixture-' + (start + 1),
      });
      await assertCleanUploadDir();
    }
    const sourceDir = await mkdtemp(join(tmpdir(), 'whatsap-video-fixture-'));
    t.after(() => rm(sourceDir, { recursive: true, force: true }));
    async function makeMp4(encoder: string) {
      const output = join(sourceDir, encoder + '.mp4');
      execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=12',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.5',
        '-c:v', encoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output,
      ], { timeout: 10_000 });
      return readFile(output);
    }
    const compatibleMp4 = await makeMp4('libx264');
    const vp9Mp4 = await makeMp4('libvpx-vp9');
    assert.deepEqual(probe(vp9Mp4).streams.map((stream) => stream.codec_name), ['vp9', 'aac']);
    const declaredMp4 = (bytes: Buffer) =>
      multipart({ chatId: phone }, 'video/mp4', 'declared.mp4', new Uint8Array(bytes));
    for (const input of [compatibleMp4, vp9Mp4, source]) {
      const start = attempts.length;
      assert.equal((await send(chat, declaredMp4(input))).status, 200);
      const actual = attempts[start].media;
      assert.equal(actual?.mimeType, 'video/mp4');
      assert.deepEqual(probe(actual!.bytes).streams.map((stream) => stream.codec_name), ['h264', 'aac']);
      if (input === compatibleMp4) assert.deepEqual(actual!.bytes, input);
      else assert.notDeepEqual(actual!.bytes, input);
      await assertCleanUploadDir();
    }
    const after = await counts();
    assert.equal(after.messages, beforeA.messages + 5);

    const beforeBadInput = attempts.length;
    const corrupt = await send(chat, video({ chatId: phone }, Buffer.from('corrupt webm')));
    assert.equal(corrupt.status, 422);
    assert.equal(corrupt.body.error, 'VIDEO_CONVERSION_FAILED');
    for (const input of [Buffer.from('not an mp4'), compatibleMp4.subarray(0, -1000)]) {
      const damaged = await send(chat, declaredMp4(input));
      assert.equal(damaged.status, 422);
      assert.equal(damaged.body.error, 'INVALID_VIDEO');
    }
    const previousProbe = process.env.FFPROBE_PATH;
    try {
      process.env.FFPROBE_PATH = join(sourceDir, 'unavailable-ffprobe');
      const unavailable = await send(chat, declaredMp4(compatibleMp4));
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.error, 'VIDEO_INSPECTION_UNAVAILABLE');
    } finally {
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previousProbe;
    }
    assert.equal(attempts.length, beforeBadInput);
    await assertCleanUploadDir();

    failVideoSend = true;
    assert.ok((await send(mediaRoute, video({ chatId: phone }))).status >= 400);
    assert.equal(attempts.length - beforeBadInput, 2);
    assert.equal(attempts[beforeBadInput].media?.mimeType, 'video/mp4');
    await assertCleanUploadDir();
    assert.deepEqual(await counts(), after);
    assert.deepEqual(await counts(tenantB), beforeB);
  });
});
