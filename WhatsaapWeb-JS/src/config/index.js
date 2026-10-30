const path = require("path");
require('dotenv').config();

function requireEnvironmentValue(name, minimumLength = 1) {
  const value = String(process.env[name] || '').trim();
  if (value.length < minimumLength) {
    throw new Error(`Variable de entorno requerida: ${name}`);
  }
  return value;
}

const jwtSecret = requireEnvironmentValue('JWT_SECRET', 32);
const databasePassword = requireEnvironmentValue('DB_PASSWORD');

module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || "localhost"
  },
  
  whatsapp: {
    profileDir: path.join(__dirname, "../../profile-data"),
    sessionPath: path.join(__dirname, "../../.wwebjs_auth"),
    uploadDir: path.join(__dirname, "../../uploads"),
    pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '0', 10),
    pollLimit: parseInt(process.env.POLL_LIMIT || '20', 10)
  },
  
  cors: {
    origin: process.env.CORS_ORIGIN || "*"
  },
  
  multer: {
    dest: "uploads/",
    maxFileSize: 100 * 1024 * 1024 // 100MB
  },
  
  messages: {
    defaultLimit: 50,
    maxLimit: 100
  },

  jwt: {
    secret: jwtSecret,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '24h',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d'
  },

  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    name: process.env.DB_NAME || 'whatsapp_empresas',
    user: process.env.DB_USER || 'postgres',
    password: databasePassword
  },

  // Feature flags para rollout gradual de persistencia conversacional.
  // Default: false (comportamiento 100% legacy).
  // Activar solo tras verificar tablas creadas y smoke test exitoso.
  features: {
    persistReads: process.env.CONVERSATIONS_PERSIST_READS === 'true',
    persistWrites: process.env.CONVERSATIONS_PERSIST_WRITES === 'true',
  },

  // Tenant default para aislamiento multi-empresa hasta auth/roles formal.
  // Usar DEFAULT_COMPANY_ID env var; si no está definido, fallback a 1.
  // Nota: company_id=1 se inserta idempotentemente en coreModel.createTablesIfNotExists().
  defaultCompanyId: parseInt(process.env.DEFAULT_COMPANY_ID || '1', 10) || 1,
};
