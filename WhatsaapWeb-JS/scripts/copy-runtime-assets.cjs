const { cpSync, readdirSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const backend = resolve(__dirname, '..');
const source = resolve(backend, 'src/db/migrations');
const output = resolve(backend, 'dist/db/migrations');
const migrationFiles = new Set(readdirSync(source));

cpSync(source, output, { recursive: true });
for (const filename of readdirSync(output)) {
  if (filename.endsWith('.sql') && !migrationFiles.has(filename)) {
    rmSync(resolve(output, filename), { force: true });
  }
}
