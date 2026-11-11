import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Queryable } from '../shared/UnitOfWorkPort';
import { startCatalogCheckpointRetention } from '../services/ai/runtime/CatalogCheckpointRetention';
import config from '../config/index';
import { CatalogRouterCheckpointStore } from '../services/ai/runtime/CatalogRouterCheckpointStore';

test('constructing the catalog retention store does not require a decryption key', () => {
  const key = config.security.tokenEncryptionKey;
  config.security.tokenEncryptionKey = '';
  try {
    assert.doesNotThrow(() => new CatalogRouterCheckpointStore());
  } finally {
    config.security.tokenEncryptionKey = key;
  }
});

const result = (rows: Array<{ id: number }>) => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5);
  assert.ok(condition(), 'Retention made no progress');
}

test('retention pages past 100 companies, bounds concurrency and revisits backlogs fairly', async (t) => {
  const cursors: number[] = [];
  const calls: number[] = [];
  let active = 0;
  let maximum = 0;
  const database: Queryable = { async query(sql, values) {
    assert.equal(sql, 'SELECT id FROM companies WHERE id > $1 ORDER BY id LIMIT 100');
    const after = Number(values![0]);
    cursors.push(after);
    return result(Array.from({ length: 205 }, (_, i) => ({ id: i + 1 })).filter(({ id }) => id > after).slice(0, 100));
  } };
  const stop = startCatalogCheckpointRetention(database, { async eraseExpired(id) {
    calls.push(id);
    maximum = Math.max(maximum, ++active);
    await delay(1);
    active--;
    return 100; // A full tenant batch must not monopolize the page.
  } }, 5);
  t.after(stop);
  await until(() => calls.length >= 206);
  await stop();
  assert.deepEqual(cursors.slice(0, 4), [0, 100, 200, 0]);
  assert.deepEqual(calls.slice(0, 205), Array.from({ length: 205 }, (_, i) => i + 1));
  assert.ok(maximum > 1 && maximum <= 4);
  assert.equal(active, 0);
});

test('a slow or failing company does not prevent its peers and stop drains admitted work only', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: number[] = [];
  let scans = 0;
  const database: Queryable = { async query() { scans++; return result(Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))); } };
  const stop = startCatalogCheckpointRetention(database, { async eraseExpired(id) {
    calls.push(id);
    if (id === 1) await blocked;
    if (id === 2) throw Object.assign(new Error('Do not log payload'), { code: '57014' });
    return 0;
  } }, 5);
  t.after(async () => { release(); await stop(); });
  await until(() => calls.includes(20));
  await delay(20);
  assert.equal(scans, 1, 'A pending sweep must not overlap with a timer tick');
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  release();
  await stopping;
  await delay(20);
  assert.equal(scans, 1);
  assert.equal(calls.length, 20);
});

test('stop cancels queued companies and tolerates a failing pre-migration scan', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  let scans = 0;
  const missing: Queryable = { async query() {
    scans++;
    throw Object.assign(new Error('Private database detail'), { code: '42P01' });
  } };
  const noWork = { async eraseExpired() { assert.fail('No tenant work without a company page'); return 0; } };
  const stopMissing = startCatalogCheckpointRetention(missing, noWork, 5);
  t.after(stopMissing);
  await until(() => scans >= 2);
  await stopMissing();
  const closedScans = scans;
  await delay(20);
  assert.equal(scans, closedScans);
  assert.deepEqual(warnings[0], ['Catalog checkpoint company scan failed', { code: '42P01' }]);

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const admitted: number[] = [];
  const stop = startCatalogCheckpointRetention({ async query() {
    return result(Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })));
  } }, { async eraseExpired(id) { admitted.push(id); await blocked; return 0; } }, 5);
  t.after(async () => { release(); await stop(); });
  await until(() => admitted.length === 4);
  const stopping = stop();
  release();
  await stopping;
  await delay(20);
  assert.deepEqual(admitted, [1, 2, 3, 4]);
});
