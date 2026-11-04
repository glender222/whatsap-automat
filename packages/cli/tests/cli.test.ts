import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { runCli } from '../src/index';
import { readTarGzEntries } from '../src/utils/tar';

describe('Developer CLI Tool (automat)', () => {
  let tmpRoot: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automat-cli-test-'));
  });

  after(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('1. Global Flags & Help', () => {
    it('shows help when --help flag is provided', async () => {
      const code = await runCli(['--help']);
      assert.equal(code, 0);
    });

    it('shows version when --version flag is provided', async () => {
      const code = await runCli(['--version']);
      assert.equal(code, 0);
    });

    it('returns error code 1 on unknown command', async () => {
      const code = await runCli(['unknown-command']);
      assert.equal(code, 1);
    });
  });

  describe('2. Command: automat init', () => {
    it('scaffolds a channel extension into a temporary directory', async () => {
      const targetDir = path.join(tmpRoot, 'my-channel');
      const code = await runCli(['init', 'my-channel', '--type=channel', `--dir=${targetDir}`]);
      assert.equal(code, 0);

      assert.ok(fs.existsSync(path.join(targetDir, 'manifest.json')));
      assert.ok(fs.existsSync(path.join(targetDir, 'package.json')));
      assert.ok(fs.existsSync(path.join(targetDir, 'tsconfig.json')));
      assert.ok(fs.existsSync(path.join(targetDir, 'src/index.ts')));
      assert.ok(fs.existsSync(path.join(targetDir, 'tests/index.test.ts')));
      assert.ok(fs.existsSync(path.join(targetDir, '.gitignore')));
      assert.ok(fs.existsSync(path.join(targetDir, 'README.md')));

      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.name, 'my-channel');
      assert.equal(manifest.type, 'channel');
      assert.deepEqual(manifest.permissions, ['channel:inbound', 'channel:send', 'webhook:receive']);
    });

    it('scaffolds a tool extension', async () => {
      const targetDir = path.join(tmpRoot, 'my-tool');
      const code = await runCli(['init', 'my-tool', '--type=tool', `--dir=${targetDir}`]);
      assert.equal(code, 0);

      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.name, 'my-tool');
      assert.equal(manifest.type, 'tool');
      assert.equal(manifest.tool.riskLevel, 'read');
    });

    it('scaffolds a ui extension', async () => {
      const targetDir = path.join(tmpRoot, 'my-ui');
      const code = await runCli(['init', 'my-ui', '--type=ui', `--dir=${targetDir}`]);
      assert.equal(code, 0);

      const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.type, 'ui');
      assert.deepEqual(manifest.ui.slots, ['inbox-sidebar']);
      assert.ok(fs.existsSync(path.join(targetDir, 'index.html')));
    });

    it('rejects invalid plugin names with spaces or illegal characters', async () => {
      const code = await runCli(['init', 'Invalid Name!@#', '--type=channel']);
      assert.equal(code, 1);
    });

    it('rejects invalid extension types', async () => {
      const code = await runCli(['init', 'valid-name', '--type=unsupported-type']);
      assert.equal(code, 1);
    });

    it('rejects when target directory already exists without --force', async () => {
      const targetDir = path.join(tmpRoot, 'my-channel');
      const code = await runCli(['init', 'my-channel', '--type=channel', `--dir=${targetDir}`]);
      assert.equal(code, 1);
    });

    it('overwrites existing directory when --force is specified', async () => {
      const targetDir = path.join(tmpRoot, 'my-channel');
      const code = await runCli(['init', 'my-channel', '--type=channel', `--dir=${targetDir}`, '--force']);
      assert.equal(code, 0);
    });
  });

  describe('3. Command: automat validate', () => {
    it('validates a freshly scaffolded manifest with exit code 0', async () => {
      const manifestPath = path.join(tmpRoot, 'my-channel', 'manifest.json');
      const code = await runCli(['validate', manifestPath]);
      assert.equal(code, 0);
    });

    it('outputs structured JSON when --json flag is supplied', async () => {
      const manifestPath = path.join(tmpRoot, 'my-channel', 'manifest.json');
      let stdoutContent = '';
      const originalLog = console.log;
      console.log = (msg: string) => { stdoutContent += msg; };

      try {
        const code = await runCli(['validate', manifestPath, '--json']);
        assert.equal(code, 0);
        const parsed = JSON.parse(stdoutContent);
        assert.equal(parsed.valid, true);
        assert.equal(parsed.manifest.name, 'my-channel');
      } finally {
        console.log = originalLog;
      }
    });

    it('fails when manifest file does not exist', async () => {
      const code = await runCli(['validate', path.join(tmpRoot, 'non-existent.json')]);
      assert.equal(code, 1);
    });

    it('fails when manifest contains invalid JSON syntax', async () => {
      const corruptPath = path.join(tmpRoot, 'corrupt.json');
      fs.writeFileSync(corruptPath, '{ broken: json');
      const code = await runCli(['validate', corruptPath]);
      assert.equal(code, 1);
    });

    it('fails when manifest violates required fields', async () => {
      const invalidPath = path.join(tmpRoot, 'missing-fields.json');
      fs.writeFileSync(invalidPath, JSON.stringify({ name: 'test' }));
      const code = await runCli(['validate', invalidPath]);
      assert.equal(code, 1);
    });

    it('rejects manifest requesting forbidden permission scopes (SEC-009)', async () => {
      const hostilePath = path.join(tmpRoot, 'hostile-manifest.json');
      fs.writeFileSync(
        hostilePath,
        JSON.stringify({
          name: 'hostile-plugin',
          version: '1.0.0',
          description: 'Hostile plugin trying to execute raw database queries',
          type: 'channel',
          entrypoint: './dist/index.js',
          permissions: ['channel:inbound', 'database.raw_query'],
        })
      );
      const code = await runCli(['validate', hostilePath]);
      assert.equal(code, 1);
    });
  });

  describe('4. Command: automat pack', () => {
    it('bundles extension folder into .tgz archive and generates .sha256 file', async () => {
      const pluginDir = path.join(tmpRoot, 'my-channel');
      const outTar = path.join(tmpRoot, 'bundles', 'my-channel-0.1.0.tgz');
      const code = await runCli(['pack', pluginDir, `--out=${outTar}`]);
      assert.equal(code, 0);

      assert.ok(fs.existsSync(outTar));
      const sha256File = `${outTar}.sha256`;
      assert.ok(fs.existsSync(sha256File));

      const tarBuffer = fs.readFileSync(outTar);
      const computedHash = crypto.createHash('sha256').update(tarBuffer).digest('hex');
      const writtenChecksum = fs.readFileSync(sha256File, 'utf8').trim();
      assert.equal(writtenChecksum, `${computedHash}  ${path.basename(outTar)}`);
    });

    it('strictly excludes node_modules and .env files from the packaged bundle', async () => {
      const pluginDir = path.join(tmpRoot, 'leak-test');
      await runCli(['init', 'leak-test', '--type=tool', `--dir=${pluginDir}`]);

      // Plant sensitive and unwanted files
      fs.writeFileSync(path.join(pluginDir, '.env'), 'DATABASE_PASSWORD=supersecret\n');
      fs.writeFileSync(path.join(pluginDir, '.env.production'), 'API_KEY=leak\n');
      const nodeModulesDir = path.join(pluginDir, 'node_modules', 'dep');
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'module.exports = {};\n');

      const outTar = path.join(tmpRoot, 'bundles', 'leak-test-0.1.0.tgz');
      const code = await runCli(['pack', pluginDir, `--out=${outTar}`]);
      assert.equal(code, 0);

      const tarBuffer = fs.readFileSync(outTar);
      const entries = readTarGzEntries(tarBuffer);
      const entryNames = entries.map((e) => e.name);

      assert.ok(entryNames.includes('manifest.json'));
      assert.ok(entryNames.includes('src/index.ts'));

      // Verify strict security exclusions
      assert.ok(!entryNames.some((n) => n.startsWith('.env')), 'Forbidden .env file was bundled');
      assert.ok(!entryNames.some((n) => n.includes('node_modules')), 'node_modules directory was bundled');
    });

    it('fails to pack if manifest.json is missing in directory', async () => {
      const emptyDir = path.join(tmpRoot, 'empty-dir');
      fs.mkdirSync(emptyDir, { recursive: true });
      const code = await runCli(['pack', emptyDir]);
      assert.equal(code, 1);
    });
  });

  describe('5. Command: automat doctor', () => {
    it('executes doctor and returns exit code 0 on healthy environment', async () => {
      const code = await runCli(['doctor']);
      assert.equal(code, 0);
    });

    it('supports --json flag outputting valid diagnostic structure', async () => {
      let stdoutContent = '';
      const originalLog = console.log;
      console.log = (msg: string) => { stdoutContent += msg; };

      try {
        const code = await runCli(['doctor', '--json']);
        assert.equal(code, 0);
        const report = JSON.parse(stdoutContent);
        assert.ok(['PASS', 'WARN'].includes(report.status));
        assert.ok(Array.isArray(report.checks));
        assert.ok(report.checks.some((c: any) => c.id === 'ENV-NODE-001' && c.status === 'PASS'));
      } finally {
        console.log = originalLog;
      }
    });
  });
});
