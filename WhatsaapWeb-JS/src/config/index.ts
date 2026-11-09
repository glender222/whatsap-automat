import path from 'path';
import 'dotenv/config';

type WhatsappProvider = 'webjs' | 'meta-cloud';
type AiProvider = 'opencode' | 'openai';

function envValue(name: string): string {
  return String(process.env[name] || '').trim();
}

function parseInteger(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Variable de entorno invalida: ${name} debe ser un entero`);
  }
  return value;
}

function requireEnvironmentValue(name: string, minimumLength = 1): string {
  const value = envValue(name);
  if (value.length < minimumLength) {
    const suffix = minimumLength > 1 ? ` (minimo ${minimumLength} caracteres)` : '';
    throw new Error(`Variable de entorno requerida: ${name}${suffix}`);
  }
  return value;
}

const providerValue = envValue('WHATSAPP_PROVIDER') || 'webjs';
if (providerValue !== 'webjs' && providerValue !== 'meta-cloud') {
  throw new Error('WHATSAPP_PROVIDER debe ser webjs o meta-cloud');
}
const whatsappProvider = providerValue as WhatsappProvider;

const aiProviderValue = envValue('AI_PROVIDER') || 'opencode';
if (aiProviderValue !== 'opencode' && aiProviderValue !== 'openai') {
  throw new Error('AI_PROVIDER debe ser opencode o openai');
}
const aiProvider = aiProviderValue as AiProvider;
const nodeEnvironment = envValue('NODE_ENV') || 'development';
const metaTokenEncryptionKey = envValue('META_TOKEN_ENCRYPTION_KEY');

if (metaTokenEncryptionKey && metaTokenEncryptionKey.length < 32) {
  throw new Error('META_TOKEN_ENCRYPTION_KEY debe tener al menos 32 caracteres cuando se configura');
}

const jwtSecret = requireEnvironmentValue('JWT_SECRET', 32);
const databasePassword = requireEnvironmentValue('DB_PASSWORD');

if (whatsappProvider === 'meta-cloud') {
  requireEnvironmentValue('META_GRAPH_VERSION');
  requireEnvironmentValue('META_WA_PHONE_NUMBER_ID');
  requireEnvironmentValue('META_WABA_ID');
  requireEnvironmentValue('META_WEBHOOK_VERIFY_TOKEN', 16);
  requireEnvironmentValue('META_WA_ACCESS_TOKEN');
  requireEnvironmentValue('META_APP_SECRET');
  if (nodeEnvironment === 'production') {
    requireEnvironmentValue('META_TOKEN_ENCRYPTION_KEY', 32);
  }
}

if (aiProvider === 'openai') {
  requireEnvironmentValue('OPENAI_API_KEY');
  requireEnvironmentValue('OPENAI_MODEL');
}

const config = {
  server: {
    port: parseInteger('PORT', 3000),
    host: envValue('HOST') || '0.0.0.0',
  },

  whatsapp: {
    provider: whatsappProvider,
    profileDir: path.join(__dirname, '../../profile-data'),
    sessionPath: path.join(__dirname, '../../.wwebjs_auth'),
    uploadDir: path.join(__dirname, '../../uploads'),
    pollIntervalSeconds: parseInteger('POLL_INTERVAL_SECONDS', 0),
    pollLimit: parseInteger('POLL_LIMIT', 20),
  },

  meta: {
    graphVersion: envValue('META_GRAPH_VERSION'),
    accessToken: envValue('META_WA_ACCESS_TOKEN'),
    phoneNumberId: envValue('META_WA_PHONE_NUMBER_ID'),
    wabaId: envValue('META_WABA_ID'),
    displayPhoneNumber: envValue('META_WA_DISPLAY_PHONE_NUMBER'),
    webhookVerifyToken: envValue('META_WEBHOOK_VERIFY_TOKEN'),
    appSecret: envValue('META_APP_SECRET'),
    requestTimeoutMs: parseInteger('META_REQUEST_TIMEOUT_MS', 20000),
  },

  ai: {
    provider: aiProvider,
    defaultMode: envValue('AI_DEFAULT_MODE') || 'suggest',
    openai: {
      apiKey: envValue('OPENAI_API_KEY'),
      model: envValue('OPENAI_MODEL'),
      requestTimeoutMs: parseInteger('OPENAI_REQUEST_TIMEOUT_MS', 30000),
    },
    opencode: {
      apiUrl: envValue('OPENCODE_API_URL') || (envValue('OPENCODE_API_KEY') ? 'https://opencode.ai/zen/go' : ''),
      apiKey: envValue('OPENCODE_API_KEY'),
      model: envValue('OPENCODE_MODEL'),
      chatPath: envValue('OPENCODE_CHAT_PATH') || '/v1/chat/completions',
      modelsPath: envValue('OPENCODE_MODELS_PATH') || '/v1/models',
      requestTimeoutMs: parseInteger('OPENCODE_REQUEST_TIMEOUT_MS', 30000),
    },
  },

  cors: {
    origin: envValue('CORS_ORIGIN') || '*',
  },

  multer: {
    dest: 'uploads/',
    maxFileSize: 100 * 1024 * 1024,
  },

  messages: {
    defaultLimit: 50,
    maxLimit: 100,
  },

  jwt: {
    secret: jwtSecret,
    accessExpiry: envValue('JWT_ACCESS_EXPIRY') || '24h',
    refreshExpiry: envValue('JWT_REFRESH_EXPIRY') || '30d',
  },

  security: {
    // Fail-closed por defecto: en producción siempre true.
    // Solo puede desactivarse en modo sandbox aislado no productivo.
    whatsappApiRequireJwt: nodeEnvironment === 'production'
      ? true
      : (process.env.ALLOW_INSECURE_SANDBOX === 'true' && process.env.WHATSAPP_API_REQUIRE_JWT === 'false' ? false : true),
    whatsappApiRequireCompanyClaim: nodeEnvironment === 'production'
      ? true
      : (process.env.ALLOW_INSECURE_SANDBOX === 'true' && process.env.WHATSAPP_API_REQUIRE_COMPANY_CLAIM === 'false' ? false : true),
    allowInsecureSandbox: nodeEnvironment !== 'production' && process.env.ALLOW_INSECURE_SANDBOX === 'true',
    sandboxCompanyId: parseInteger('SANDBOX_COMPANY_ID', 9999),
    tokenEncryptionKey: metaTokenEncryptionKey,
  },

  database: {
    host: envValue('DB_HOST') || 'localhost',
    port: parseInteger('DB_PORT', 5432),
    name: envValue('DB_NAME') || 'whatsapp_empresas',
    user: envValue('DB_USER') || 'postgres',
    password: databasePassword,
  },

  features: {
    persistReads: process.env.CONVERSATIONS_PERSIST_READS === 'true',
    persistWrites: process.env.CONVERSATIONS_PERSIST_WRITES === 'true',
  },

  // defaultCompanyId es EXCLUSIVAMENTE para inicialización de esquema y seed de base de datos.
  // Queda estrictamente PROHIBIDO su uso como fallback en autenticación o autorización operativa.
  defaultCompanyId: parseInteger('DEFAULT_COMPANY_ID', 1) || 1,
};

export default config;
module.exports = config;
