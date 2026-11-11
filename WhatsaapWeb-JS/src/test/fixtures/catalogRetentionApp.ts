import './testEnv';
import assert from 'node:assert/strict';
import type { Server as HttpServer } from 'node:http';
import type { Server as SocketServer } from 'socket.io';

async function main() {
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.WHATSAPP_PROVIDER, 'meta-cloud');
  globalThis.fetch = async () => { process.send?.({ unexpectedNetwork: true }); throw new Error('Network disabled for retention test'); };
  const { App } = await import('../../app');
  const { default: pool } = await import('../../config/database');
  const app = new App();
  const server = Reflect.get(app, 'server') as HttpServer;
  const io = Reflect.get(app, 'io') as SocketServer;
  server.once('listening', () => process.send?.({ ready: true }));
  process.once('message', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await pool.end();
    process.send?.({ closed: true }, () => process.exit(0));
  });
  await app.start();
}
void main().catch(() => { process.send?.({ failed: true }); process.exit(1); });
