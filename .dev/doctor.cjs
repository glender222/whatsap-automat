const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const requireBackend = createRequire('/workspace/WhatsaapWeb-JS/package.json');
const { Pool } = requireBackend('pg');

(async () => {
  assert.equal(process.version, 'v' + process.env.DEV_NODE_VERSION, 'Node differs from .dev/versions.env');
  assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), process.env.DEV_NPM_VERSION);
  assert.equal(execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(), 'Python ' + process.env.DEV_PYTHON_VERSION);
  for (const tool of ['ffmpeg', 'ffprobe']) execFileSync(tool, ['-version'], { stdio: 'ignore' });
  const pool = new Pool({ host: process.env.DB_HOST, port: 5432, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  try {
    const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.equal(role.rolsuper, false, 'Development application must not use a superuser');
    assert.equal(role.rolbypassrls, false, 'Development application must respect RLS');
    const version = await pool.query("SHOW server_version_num");
    assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), Number(process.env.DEV_POSTGRES_MAJOR));
  } finally { await pool.end(); }
  for (const url of ['http://api:3000/ready', 'http://web:5173/']) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.ok, true, 'Service unavailable: ' + url);
  }
  console.log('PASS: runtime versions, FFmpeg, PostgreSQL 16, RLS role, API and web.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
