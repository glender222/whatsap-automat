const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

test('rebuilding removes SQL migrations from a previous checkout', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'whatsap-migration-assets-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const scripts = join(workspace, 'scripts');
  const source = join(workspace, 'src/db/migrations');
  const output = join(workspace, 'dist/db/migrations');
  for (const directory of [scripts, source, output]) mkdirSync(directory, { recursive: true });

  const copier = join(scripts, 'copy-runtime-assets.cjs');
  copyFileSync(join(__dirname, 'copy-runtime-assets.cjs'), copier);
  writeFileSync(join(output, '063_discarded.sql'), 'SELECT 0;');
  writeFileSync(join(source, '063_current.sql'), 'SELECT 1;');

  execFileSync(process.execPath, [copier]);

  assert.deepEqual(readdirSync(output), ['063_current.sql']);
  assert.equal(readFileSync(join(output, '063_current.sql'), 'utf8'), 'SELECT 1;');
});
