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

  security: {
    whatsappApiRequireJwt: (process.env.NODE_ENV || 'development') === 'production'
      ? true
      : (process.env.ALLOW_INSECURE_SANDBOX === 'true' && process.env.WHATSAPP_API_REQUIRE_JWT === 'false' ? false : true),
    whatsappApiRequireCompanyClaim: (process.env.NODE_ENV || 'development') === 'production'
      ? true
      : (process.env.ALLOW_INSECURE_SANDBOX === 'true' && process.env.WHATSAPP_API_REQUIRE_COMPANY_CLAIM === 'false' ? false : true),
    allowInsecureSandbox: (process.env.NODE_ENV || 'development') !== 'production' && process.env.ALLOW_INSECURE_SANDBOX === 'true',
    sandboxCompanyId: parseInt(process.env.SANDBOX_COMPANY_ID || '9999', 10),
  },

  // Feature flags para rollout gradual de persistencia conversacional.
  // Default: false (comportamiento 100% legacy).
  // Activar solo tras verificar tablas creadas y smoke test exitoso.
  features: {
    persistReads: process.env.CONVERSATIONS_PERSIST_READS === 'true',
    persistWrites: process.env.CONVERSATIONS_PERSIST_WRITES === 'true',
  },

  // defaultCompanyId es EXCLUSIVAMENTE para inicialización de esquema y seed de base de datos.
  // Queda estrictamente PROHIBIDO su uso como fallback en autenticación o autorización operativa.
  defaultCompanyId: parseInt(process.env.DEFAULT_COMPANY_ID || '1', 10) || 1,
};
