const { cpSync } = require('node:fs');
const { resolve } = require('node:path');

const backend = resolve(__dirname, '..');
cpSync(resolve(backend, 'src/db/migrations'), resolve(backend, 'dist/db/migrations'), {
  recursive: true,
});
