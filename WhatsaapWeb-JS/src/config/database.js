const { Pool } = require('pg');
require('dotenv').config();

const databasePassword = String(process.env.DB_PASSWORD || '').trim();
if (!databasePassword) {
  throw new Error('Variable de entorno requerida: DB_PASSWORD');
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'whatsapp_empresas',
  user: process.env.DB_USER || 'postgres',
  password: databasePassword,
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de conexión:', err);
});

pool.on('connect', () => {
  console.log('✅ Conexión exitosa a PostgreSQL');
});

module.exports = pool;
