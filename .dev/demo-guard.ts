import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

export const demoToken = 'synthetic-local-token';
export const demoCompanies = [
  { name: 'Casa Oliva Demo', email: 'demo@automat.local', line: '200000000000001' },
  { name: 'Taller Nube Demo', email: 'demo2@automat.local', line: '200000000000002' },
] as const;

function requireEqual(name: string, expected: string) {
  if (process.env[name] !== expected) throw new Error(`DEMO_ENV_REJECTED: ${name}`);
}

/** Run before importing any backend module: no existing .env may be loaded. */
export function prepareDemoEnvironment() {
  requireEqual('NODE_ENV', 'development');
  requireEqual('DEV_PROFILE', 'demo');
  requireEqual('DOTENV_CONFIG_PATH', '/dev/null');
  requireEqual('DB_NAME', 'whatsap_dev_demo');
  requireEqual('DB_USER', 'whatsap_dev');
  requireEqual('META_WA_ACCESS_TOKEN', demoToken);
  if (!['postgres', '127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
    throw new Error('DEMO_ENV_REJECTED: DB_HOST');
  }
  for (const name of ['DB_PASSWORD', 'JWT_SECRET', 'MASTER_ENCRYPTION_KEY']) {
    if ((process.env[name]?.length ?? 0) < (name === 'DB_PASSWORD' ? 1 : 32)) {
      throw new Error(`DEMO_ENV_REJECTED: ${name}`);
    }
  }
  // Reject supplied provider credentials instead of silently hiding real tokens.
  const synthetic = {
    WHATSAPP_PROVIDER: 'meta-cloud',
    META_GRAPH_VERSION: 'v25.0',
    META_WA_PHONE_NUMBER_ID: '200000000000000',
    META_WABA_ID: '300000000000000',
    META_WEBHOOK_VERIFY_TOKEN: 'demo-local-verification-only',
    META_APP_SECRET: 'demo-local-app-secret-only',
    AI_PROVIDER: 'opencode',
    OPENCODE_API_URL: 'http://127.0.0.1:3999',
    OPENCODE_API_KEY: demoToken,
    OPENCODE_MODEL: 'demo-local-model',
    OPENAI_API_KEY: demoToken,
    ALLOW_INSECURE_SANDBOX: 'false',
    WHATSAPP_API_REQUIRE_JWT: 'true',
    WHATSAPP_API_REQUIRE_COMPANY_CLAIM: 'true',
    MERCADOPAGO_RECONCILIATION_ENABLED: 'false',
  };
  for (const [name, value] of Object.entries(synthetic)) {
    if (process.env[name] !== undefined && process.env[name] !== value) {
      throw new Error(`DEMO_ENV_REJECTED: ${name}`);
    }
    process.env[name] = value;
  }
  // Only synthetic tokens are encrypted. Derivation stays stable across restarts.
  process.env.META_TOKEN_ENCRYPTION_KEY ||= createHash('sha256')
    .update('whatsap-local-demo:')
    .update(process.env.MASTER_ENCRYPTION_KEY!)
    .digest('hex');
  if (process.env.META_TOKEN_ENCRYPTION_KEY.length < 32) {
    throw new Error('DEMO_ENV_REJECTED: META_TOKEN_ENCRYPTION_KEY');
  }
}

/** Legacy database.js calls dotenv.config() directly, ignoring DOTENV_CONFIG_PATH. */
export function disableDemoDotenv() {
  const requireBackend = createRequire(path.resolve(__dirname, '../WhatsaapWeb-JS/package.json'));
  const dotenv = requireBackend('dotenv');
  const ignoreLocalFiles = () => ({ parsed: {} });
  dotenv.config = ignoreLocalFiles;
  dotenv.configDotenv = ignoreLocalFiles;
}

export async function verifyDemoDatabase(db: { query: (sql: string) => Promise<any> }) {
  const { rows: [role] } = await db.query(`
    SELECT current_database() AS database, current_user AS username,
      rolsuper, rolbypassrls, current_setting('row_security') AS row_security
    FROM pg_roles WHERE rolname = current_user
  `);
  if (!role || role.database !== 'whatsap_dev_demo' || role.username !== 'whatsap_dev' ||
      role.rolsuper || role.rolbypassrls || role.row_security !== 'on') {
    throw new Error('DEMO_DATABASE_ROLE_REJECTED');
  }
  const { rows } = await db.query(`
    SELECT relname FROM pg_class
    WHERE oid IN ('usuarios'::regclass, 'conversations'::regclass, 'products'::regclass)
      AND relrowsecurity AND relforcerowsecurity
  `);
  if (rows.length !== 3) throw new Error('DEMO_DATABASE_RLS_REQUIRED');
}

/** cors and Socket.IO both accept this callback; a comma-separated string does not work. */
export function createDemoCorsOrigin(configured: string) {
  const origins = new Set([
    ...configured.split(',').map((origin) => origin.trim()).filter(Boolean),
    'http://localhost:8081', 'http://127.0.0.1:8081',
  ]);
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('DEMO_CORS_ORIGIN_REJECTED'); }
    if (url.origin !== origin || url.protocol !== 'http:' ||
        !((['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) > 0) || origin === 'http://web:5173')) {
      throw new Error('DEMO_CORS_ORIGIN_REJECTED');
    }
  }
  return (origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void) => {
    callback(null, origin === undefined || origins.has(origin));
  };
}

export function reportDemoFailure(area: string, error: unknown) {
  // Driver errors may contain supplied data: emit only a fixed area and safe code.
  const code = (error as { code?: unknown })?.code;
  const reason = error instanceof Error && /^DEMO_[A-Z_]+(?:: [A-Z_]+)?$/.test(error.message) ? error.message : null;
  console.error(`${area} failed${reason ? ` (${reason})` : typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? ` (${code})` : ''}`);
  process.exitCode = 1;
}
