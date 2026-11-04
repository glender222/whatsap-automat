export function getChannelTemplate(name: string): Record<string, string> {
  const manifest = {
    name,
    version: '0.1.0',
    description: `Custom channel extension: ${name}`,
    type: 'channel',
    entrypoint: './dist/index.js',
    permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
    license: 'MIT',
    channel: {
      kind: name,
      capabilities: ['text', 'image'],
      webhookPath: `/webhooks/${name}`,
    },
  };

  const packageJson = {
    name,
    version: '0.1.0',
    description: `Custom channel extension: ${name}`,
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
export interface ChannelMessage {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
}

export class CustomChannelAdapter {
  readonly kind = '${name}';

  async handleInbound(rawPayload: Record<string, unknown>): Promise<ChannelMessage> {
    return {
      id: String(rawPayload.id || Date.now()),
      senderId: String(rawPayload.from || 'unknown'),
      recipientId: String(rawPayload.to || 'system'),
      content: String(rawPayload.text || ''),
    };
  }

  async sendMessage(recipientId: string, text: string): Promise<{ delivered: boolean; messageId: string }> {
    return {
      delivered: true,
      messageId: 'msg_' + Date.now(),
    };
  }
}
`;

  const indexTestTs = `
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CustomChannelAdapter } from '../src/index';

describe('CustomChannelAdapter', () => {
  it('instantiates and handles messages', async () => {
    const adapter = new CustomChannelAdapter();
    assert.equal(adapter.kind, '${name}');
    const res = await adapter.sendMessage('+1234567890', 'Hello');
    assert.equal(res.delivered, true);
  });
});
`;

  const gitignore = `node_modules/\ndist/\n.env\n*.tgz\n*.sha256\n`;
  const readme = `# ${name}\n\nCustom channel extension for Whatsap-Automat.\n\n## Usage\n\`\`\`bash\nautomat validate manifest.json\nautomat pack .\n\`\`\`\n`;

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
