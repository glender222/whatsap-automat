import { Pool } from 'pg';
import config from './index';

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err: any) => {
  console.error('❌ Error inesperado en el pool de conexion', {
    code: String(err?.code || 'DB_POOL_ERROR'),
    severity: err?.severity || null,
  });
});

pool.on('connect', () => {
  console.log('✅ Conexion exitosa a PostgreSQL');
});

export default pool;
module.exports = pool;
