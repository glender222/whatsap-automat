import './testEnv';

// This fixture deliberately replaces any inherited provider credentials. Database
// settings are supplied separately for an explicitly opted-in, local smoke DB.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: '/dev/null',
  WHATSAPP_PROVIDER: 'meta-cloud',
  AI_PROVIDER: 'opencode',
  JWT_SECRET: 'meta-inbound-crash-fixture-jwt-secret-00000000',
  META_TOKEN_ENCRYPTION_KEY: 'meta-inbound-crash-fixture-key-000000000000',
  META_APP_SECRET: 'meta-inbound-crash-fixture-signature',
  META_GRAPH_VERSION: 'v25.0',
  META_WA_PHONE_NUMBER_ID: process.env.META_INBOUND_CRASH_FIXTURE_PHONE_ID || '178000000000001',
  META_WABA_ID: '178000000000002',
  META_WA_ACCESS_TOKEN: 'meta-inbound-crash-fixture-token',
  META_WEBHOOK_VERIFY_TOKEN: 'meta-inbound-crash-fixture-verify',
  OPENAI_API_KEY: '',
  OPENCODE_API_KEY: '',
  OPENCODE_API_URL: '',
});

export const crashFixture = {
  appSecret: process.env.META_APP_SECRET!,
  token: process.env.META_WA_ACCESS_TOKEN!,
  graphVersion: process.env.META_GRAPH_VERSION!,
  phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID!,
  recipient: '12025550123',
};
