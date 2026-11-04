export function getToolTemplate(name: string): Record<string, string> {
  const manifest = {
    name,
    version: '0.1.0',
    description: `Agent tool extension: ${name}`,
    type: 'tool',
    entrypoint: './dist/index.js',
    permissions: ['tool:execute'],
    license: 'MIT',
    tool: {
      name,
      riskLevel: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term or argument' },
        },
        required: ['query'],
      },
    },
  };

  const packageJson = {
    name,
    version: '0.1.0',
    description: `Agent tool extension: ${name}`,
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc',
      test: 'node --test dist/**/*.test.js',
    },
    license: 'MIT',
    devDependencies: {
      '@types/node': '^22.8.1',
      typescript: '^5.6.3',
    },
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
      skipLibCheck: true,
    },
    include: ['src/**/*'],
  };

  const indexTs = `
export interface ToolParams {
  query: string;
}

export interface ToolResult {
  status: 'success' | 'error';
  data: Record<string, unknown>;
}

export async function execute(params: ToolParams): Promise<ToolResult> {
  if (!params.query) {
    throw new Error('Query parameter is required');
  }
  return {
    status: 'success',
    data: {
      query: params.query,
      result: 'Processed by ${name}',
      timestamp: Date.now(),
    },
  };
}
`;

  const indexTestTs = `
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/index';

describe('Tool ${name}', () => {
  it('executes query successfully', async () => {
    const res = await execute({ query: 'test' });
    assert.equal(res.status, 'success');
    assert.equal(res.data.query, 'test');
  });
});
`;

  const gitignore = `node_modules/\ndist/\n.env\n*.tgz\n*.sha256\n`;
  const readme = `# ${name}\n\nAgent tool extension for Whatsap-Automat.\n`;

  return {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'package.json': JSON.stringify(packageJson, null, 2) + '\n',
    'tsconfig.json': JSON.stringify(tsconfig, null, 2) + '\n',
    'src/index.ts': indexTs,
    'tests/index.test.ts': indexTestTs,
    '.gitignore': gitignore,
    'README.md': readme,
  };
}
