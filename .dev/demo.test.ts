import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { createDemoCorsOrigin, prepareDemoEnvironment, verifyDemoDatabase } from './demo-guard';

function withDemoEnvironment(work: () => void, overrides: NodeJS.ProcessEnv = {}) {
  const previous = process.env;
  // Unit tests use no inherited credentials, external provider URLs or .env files.
  process.env = {
    NODE_ENV: 'development', DEV_PROFILE: 'demo', DOTENV_CONFIG_PATH: '/dev/null',
    DB_HOST: 'postgres', DB_NAME: 'whatsap_dev_demo', DB_USER: 'whatsap_dev',
    DB_PASSWORD: 'unit-test-database-only', JWT_SECRET: 'unit-test-jwt-secret-at-least-32-characters',
    MASTER_ENCRYPTION_KEY: 'unit-test-encryption-at-least-32-characters',
    META_WA_ACCESS_TOKEN: 'synthetic-local-token', ...overrides,
  };
  try { work(); } finally { process.env = previous; }
}

test('demo guard accepts only the isolated development environment', () => {
  withDemoEnvironment(() => {
    prepareDemoEnvironment();
    assert.equal(process.env.ALLOW_INSECURE_SANDBOX, 'false');
    assert.equal(process.env.WHATSAPP_API_REQUIRE_JWT, 'true');
    assert.equal(process.env.WHATSAPP_API_REQUIRE_COMPANY_CLAIM, 'true');
    assert.equal(process.env.MERCADOPAGO_RECONCILIATION_ENABLED, 'false');
    const encryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY;
    prepareDemoEnvironment();
    assert.equal(process.env.META_TOKEN_ENCRYPTION_KEY, encryptionKey);
  });
  for (const [key, value] of Object.entries({
    NODE_ENV: 'production', DEV_PROFILE: 'real', DOTENV_CONFIG_PATH: '.env',
    DB_NAME: 'production', DB_HOST: 'database.example.invalid', DB_USER: 'postgres',
    META_WA_ACCESS_TOKEN: 'not-the-synthetic-token', OPENAI_API_KEY: 'not-the-synthetic-token',
    OPENCODE_API_URL: 'https://provider.example.invalid', ALLOW_INSECURE_SANDBOX: 'true',
  })) {
    withDemoEnvironment(() => assert.throws(prepareDemoEnvironment, /DEMO_ENV_REJECTED/), { [key]: value });
  }
});

const expectedRole = {
  database: 'whatsap_dev_demo', username: 'whatsap_dev',
  rolsuper: false, rolbypassrls: false, row_security: 'on',
};
const protectedTables = ['usuarios', 'conversations', 'products'].map((relname) => ({ relname }));

function database(role = expectedRole, tables = protectedTables) {
  let queries = 0;
  return { query: async () => ({ rows: queries++ === 0 ? [role] : tables }) };
}

test('database guard rejects privileged roles and requires forced row security', async () => {
  await verifyDemoDatabase(database());
  for (const role of [
    { ...expectedRole, rolsuper: true }, { ...expectedRole, rolbypassrls: true },
    { ...expectedRole, username: 'postgres' }, { ...expectedRole, database: 'another_database' },
    { ...expectedRole, row_security: 'off' },
  ]) {
    await assert.rejects(verifyDemoDatabase(database(role)), /DEMO_DATABASE_ROLE_REJECTED/);
  }
  await assert.rejects(verifyDemoDatabase(database(expectedRole, protectedTables.slice(1))), /DEMO_DATABASE_RLS_REQUIRED/);
});

test('demo CORS uses an explicit local allowlist for web, Expo and tools', () => {
  const callback = createDemoCorsOrigin('http://localhost:5012,http://127.0.0.1:5012,http://web:5173');
  const allowed = (origin: string | undefined) => {
    let result: boolean | undefined;
    callback(origin, (error, value) => { assert.equal(error, null); result = value; });
    return result;
  };
  for (const origin of [undefined, 'http://localhost:5012', 'http://127.0.0.1:5012',
    'http://web:5173', 'http://localhost:8081', 'http://127.0.0.1:8081']) assert.equal(allowed(origin), true);
  for (const origin of ['null', 'https://example.invalid', 'http://localhost.evil:5012',
    'http://localhost:5013', 'https://localhost:5012', 'http://web:8081']) assert.equal(allowed(origin), false);
  for (const origin of ['*', 'https://example.invalid', 'http://web:8081', 'http://localhost:5012/path']) {
    assert.throws(() => createDemoCorsOrigin(origin), /DEMO_CORS_ORIGIN_REJECTED/);
  }
});

test('synthetic Graph and AI work while fetch/http/https network escape is blocked', () => {
  // Mutating built-in transports must never affect the parent test runner.
  const result = spawnSync(process.execPath, ['--require', path.resolve(__dirname, 'no-dotenv.cjs'), '--import', 'tsx', '-e', `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const https = require('node:https');
    const { installDemoNetwork } = require('../.dev/demo-network.ts');
    async function run() {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { disableDemoDotenv } = require('../.dev/demo-guard.ts');
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'automat-demo-env-'));
      try {
        const envPath = path.join(temporary, '.env');
        fs.writeFileSync(envPath, 'AUTOMAT_DEMO_DOTENV_SENTINEL=must-not-load');
        const dotenv = require('dotenv');
        assert.deepEqual(dotenv.config({ path: envPath, override: true }), { parsed: {} });
        assert.equal(process.env.AUTOMAT_DEMO_DOTENV_SENTINEL, undefined);
        disableDemoDotenv();
        assert.deepEqual(dotenv.configDotenv({ path: envPath, override: true }), { parsed: {} });
        assert.equal(process.env.AUTOMAT_DEMO_DOTENV_SENTINEL, undefined);
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      installDemoNetwork();
      for (const url of ['https://example.invalid/', 'http://example.invalid/',
        'http://127.0.0.1:3000/ready', 'https://api.openai.com/v1/chat/completions']) {
        await assert.rejects(fetch(url), /DEMO_NETWORK_BLOCKED/);
      }
      await assert.rejects(fetch('https://graph.facebook.com/v25.0/200000000000001?fields=id', {
        headers: { authorization: 'Bearer not-the-synthetic-token' },
      }), /DEMO_NETWORK_BLOCKED/);
      const headers = { authorization: 'Bearer synthetic-local-token', 'content-type': 'application/json' };
      const connection = await fetch('https://graph.facebook.com/v25.0/200000000000001?fields=id', { headers });
      assert.equal((await connection.json()).id, '200000000000001');
      const sent = await fetch('https://graph.facebook.com/v25.0/200000000000001/messages', {
        method: 'POST', headers, body: JSON.stringify({ text: { body: 'Local demo' } }),
      });
      assert.match((await sent.json()).messages[0].id, /^wamid[.]demo[.]/);
      const models = await fetch('http://127.0.0.1:3999/v1/models', { headers });
      assert.equal((await models.json()).data[0].id, 'demo-local-model');
      const completion = await fetch('http://127.0.0.1:3999/v1/chat/completions', {
        method: 'POST', headers, body: JSON.stringify({ messages: [] }),
      });
      assert.match((await completion.json()).choices[0].message.content, /simulada local/);
      for (const transport of [http, https]) {
        assert.throws(() => transport.get('https://example.invalid/'), /DEMO_NETWORK_BLOCKED/);
        assert.throws(() => transport.request('https://example.invalid/'), /DEMO_NETWORK_BLOCKED/);
      }
    }
    run().catch(() => { console.error('Isolated network boundary test failed'); process.exitCode = 1; });
  `], {
    cwd: path.resolve(__dirname, '../WhatsaapWeb-JS'), timeout: 15_000,
    encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'Isolated child must validate every network boundary');
});
