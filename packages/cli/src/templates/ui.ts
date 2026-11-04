export function getUiTemplate(name: string): Record<string, string> {
  const manifest = {
    name,
    version: '0.1.0',
    description: `UI extension slot: ${name}`,
    type: 'ui',
    entrypoint: './dist/index.js',
    permissions: ['ui:slot:inbox', 'ui:rpc'],
    license: 'MIT',
    slots: ['inbox-sidebar'],
    ui: {
      slots: ['inbox-sidebar'],
      entrypointHtml: './index.html',
    },
  };

  const packageJson = {
    name,
    version: '0.1.0',
    description: `UI extension slot: ${name}`,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
    },
    license: 'MIT',
  };

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      declaration: true,
      outDir: './dist',
      rootDir: './src',
      strict: true,
    },
    include: ['src/**/*'],
  };

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${name} Extension</title>
  <style>
    body { font-family: sans-serif; margin: 12px; color: #1e293b; }
    .card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h4>${name} Slot</h4>
    <p>Sandboxed UI extension loaded successfully.</p>
  </div>
  <script src="./dist/index.js"></script>
</body>
</html>
`;

  const indexTs = `
export function initUiBridge() {
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'AUTOMAT_INIT') {
      window.parent.postMessage({ type: 'AUTOMAT_READY', name: '${name}' }, '*');
    }
  });
}
if (typeof window !== 'undefined') {
  initUiBridge();
}
`;

  const indexTestTs = `
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initUiBridge } from '../src/index';

describe('UI ${name}', () => {
  it('exports initUiBridge function', () => {
    assert.equal(typeof initUiBridge, 'function');
  });
});
`;

  const gitignore = `node_modules/\ndist/\n.env\n*.tgz\n*.sha256\n`;
  const readme = `# ${name}\n\nUI slot extension for Whatsap-Automat.\n`;

  return {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'package.json': JSON.stringify(packageJson, null, 2) + '\n',
    'tsconfig.json': JSON.stringify(tsconfig, null, 2) + '\n',
    'index.html': indexHtml,
    'src/index.ts': indexTs,
    'tests/index.test.ts': indexTestTs,
    '.gitignore': gitignore,
    'README.md': readme,
  };
}
