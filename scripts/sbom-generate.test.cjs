const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const projects = [
  'Frontend_py_whatsaapweb', 'WhatsaapWeb-JS', 'apps/mobile', 'packages/cli', 'packages/contracts', 'packages/sdk',
];

test('lock-only SBOM is reproducible without installations and matches the tracked artifact', (t) => {
  const clean = mkdtempSync(path.join(tmpdir(), 'whatsap-sbom-'));
  t.after(() => rmSync(clean, { recursive: true, force: true }));
  mkdirSync(path.join(clean, 'scripts'));
  cpSync(path.join(root, 'scripts', 'sbom-generate.sh'), path.join(clean, 'scripts', 'sbom-generate.sh'));

  const locks = new Map();
  for (const project of projects) {
    const source = path.join(root, project, 'package-lock.json');
    const dest = path.join(clean, project);
    mkdirSync(dest, { recursive: true });
    cpSync(source, path.join(dest, 'package-lock.json'));
    locks.set(project, JSON.parse(readFileSync(source, 'utf8')).packages);
  }

  const result = ['first', 'second'].map((name) => {
    const output = path.join(clean, name + '.json');
    execFileSync('bash', [path.join(clean, 'scripts', 'sbom-generate.sh'), '--output', output]);
    return readFileSync(output);
  });
  assert.deepEqual(result[0], result[1]);
  assert.deepEqual(result[0], readFileSync(path.join(root, 'sbom.json')));
  assert.ok(projects.every(project => !existsSync(path.join(clean, project, 'node_modules'))));

  const bom = JSON.parse(result[0]);
  const components = new Map(bom.components.map(component => [component['bom-ref'], component]));
  const graph = new Map(bom.dependencies.map(node => [node.ref, node.dependsOn]));
  const rootRef = bom.metadata.component['bom-ref'];
  assert.equal(components.size, bom.components.length);
  assert.equal(graph.size, components.size + 1);
  assert.deepEqual(graph.get(rootRef), projects.map(project => 'whatsap:' + project));
  for (const [ref, targets] of graph) {
    assert.ok(ref === rootRef || components.has(ref));
    assert.ok(targets.every(target => components.has(target)));
  }

  for (const [project, pkg, scope] of [
    ['WhatsaapWeb-JS', 'express', 'required'],
    ['WhatsaapWeb-JS', 'multer', 'required'],
    ['WhatsaapWeb-JS', 'fluent-ffmpeg', 'excluded'],
    ['Frontend_py_whatsaapweb', 'axios', 'required'],
    ['Frontend_py_whatsaapweb', 'vite', 'excluded'],
    ['Frontend_py_whatsaapweb', '@napi-rs/canvas-linux-x64-gnu', 'optional'],
    ['apps/mobile', 'expo', 'required'],
    ['apps/mobile', 'react-native', 'required'],
    ['packages/contracts', 'zod', 'required'],
  ]) {
    const location = 'node_modules/' + pkg;
    const component = components.get(`whatsap:${project}#${location}`);
    assert.equal(component?.version, locks.get(project)[location].version, pkg);
    assert.equal(component?.scope, scope, pkg);
  }

  for (const project of ['WhatsaapWeb-JS', 'packages/sdk', 'packages/cli']) {
    const alias = `whatsap:${project}#node_modules/@whatsap-automat/contracts`;
    assert.deepEqual(graph.get(alias), ['whatsap:packages/contracts']);
    assert.ok(graph.get(`whatsap:${project}`).includes(alias));
  }
  assert.ok(graph.get('whatsap:packages/contracts').includes('whatsap:packages/contracts#node_modules/zod'));
  assert.ok(!components.has('whatsap:apps/mobile#../../packages/contracts'));
  assert.ok(!components.has('whatsap:apps/mobile#node_modules/@whatsap-automat/contracts'));

  const unknown = Object.entries(locks.get('WhatsaapWeb-JS')).find(([location, entry]) =>
    location.startsWith('node_modules/') && entry.version && !entry.license);
  assert.ok(unknown);
  assert.equal(components.get(`whatsap:WhatsaapWeb-JS#${unknown[0]}`).licenses, undefined);

  for (const project of projects) {
    const name = 'whatsap:lock-sha256:' + project;
    const actual = createHash('sha256').update(readFileSync(path.join(root, project, 'package-lock.json'))).digest('hex');
    assert.equal(bom.metadata.properties.find(property => property.name === name)?.value, actual);
  }
});
