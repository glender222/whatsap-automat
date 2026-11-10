import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { inspectLocalPackage } from '../src/utils/packageInspection';
import { packageSigningBytes } from '../src/utils/packageProof';
import { stageLocalPackage } from '../src/utils/packageStage';
import { createUStarHeader } from '../src/utils/tar';

const manifest = {
  id: '@example/signed-ui',
  name: 'signed-ui',
  version: '1.0.0',
  type: 'ui',
  slots: ['inbox-sidebar'],
  entrypoint: './dist/index.js',
  ui: { slots: ['inbox-sidebar'], entrypointHtml: './index.html' },
};

function entry(name: string, value: string | Buffer = '', type = '0'): Buffer {
  const data = Buffer.from(value);
  const header = createUStarHeader(name, data.length);
  if (type !== '0') {
    header[156] = type.charCodeAt(0);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  }
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'automat-inspect-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'fixture.tgz');
  const proof = join(root, 'proof.json');
  const trust = join(root, 'trust.json');
  const executable = join(__dirname, '..', 'bin', 'automat.js');
  const cli = (...args: string[]) => spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8' });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(spki).digest('hex');
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  function authorize(bytes: Buffer) {
    const artifact = {
      registryId: 'local-qa', publisherTenantId: 'tenant-1', listingId: 'ext_fixture',
      extensionId: manifest.id, version: manifest.version,
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
    };
    writeFileSync(archive, bytes);
    writeFileSync(proof, JSON.stringify({
      format: 'automat-extension-proof-v1', artifact, keyId,
      signature: sign(null, packageSigningBytes(artifact, keyId), privateKey).toString('base64'),
    }));
    writeFileSync(trust, JSON.stringify({
      format: 'automat-extension-trust-v1', artifact, expiresAt,
      keys: [{ keyId, publicKeySpki: spki.toString('base64'), status: 'active' }],
    }));
    return artifact;
  }
  const check = (command = 'inspect', ...args: string[]) => cli(command, archive, '--proof', proof, '--trust', trust, '--json', ...args);
  const inspect = () => inspectLocalPackage(archive, proof, trust);
  return { root, archive, proof, trust, cli, authorize, check, inspect, keyId, expiresAt };
}

test('automat inspect checks the signed snapshot emitted by automat pack and keeps it inert', (t) => {
  const { root, archive, proof, trust, cli, authorize, check, keyId, expiresAt } = fixture(t);
  const src = join(root, 'src');
  const longDirectory = `${'a'.repeat(56)}/${'é'.repeat(49)}`;
  const entrypoint = `${longDirectory}/${'ñ'.repeat(48)}.mjs`;
  assert.equal(Buffer.byteLength(longDirectory), 155);
  assert.equal(Buffer.byteLength(entrypoint), 256);
  mkdirSync(join(src, longDirectory), { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...manifest, entrypoint: `./${entrypoint}` }));
  writeFileSync(join(src, entrypoint), 'throw new Error("Package code must remain inert");');
  writeFileSync(join(src, 'index.html'), '<html></html>');
  mkdirSync(join(src, 'assets'));
  writeFileSync(join(src, 'assets', 'mañana.txt'), 'fixture');
  const packed = cli('pack', src, '--out', archive);
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  const artifact = authorize(bytes);
  const originalFiles = readdirSync(root);
  const inspected = check();
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), {
    inspected: true, artifact, keyId, trustExpiresAt: expiresAt,
    archive: { entries: 4, expandedBytes: 5120 },
    manifest: { type: 'ui', entrypoint, entrypointHtml: 'index.html' },
  });
  assert.deepEqual(readdirSync(root), originalFiles);

  if (process.getuid) {
    const out = join(root, 'staging');
    mkdirSync(out, { mode: 0o700 });
    const staged = check('stage', '--out', out);
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    const result = JSON.parse(staged.stdout);
    assert.equal(result.staged, true);
    assert.deepEqual(result.artifact, artifact);
    assert.equal(statSync(result.directory).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(result.directory).sort(), ['inspection.json', 'package.proof.json', 'package.tgz']);
    for (const name of readdirSync(result.directory)) {
      assert.equal(statSync(join(result.directory, name)).mode & 0o777, 0o600);
    }
    const stagedArchive = join(result.directory, 'package.tgz');
    const stagedProof = join(result.directory, 'package.proof.json');
    assert.deepEqual(readFileSync(stagedArchive), bytes);
    assert.deepEqual(JSON.parse(readFileSync(stagedProof, 'utf8')), JSON.parse(readFileSync(proof, 'utf8')));
    assert.deepEqual(JSON.parse(readFileSync(join(result.directory, 'inspection.json'), 'utf8')), {
      format: 'automat-extension-stage-v1', staged: true,
      artifact, keyId, trustExpiresAt: expiresAt,
      archive: { entries: 4, expandedBytes: 5120 },
      manifest: { type: 'ui', entrypoint, entrypointHtml: 'index.html' },
    });
    const verified = cli('verify', stagedArchive, '--proof', stagedProof, '--trust', trust, '--json');
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.deepEqual(JSON.parse(verified.stdout).artifact, artifact);
  }

  const tampered = Buffer.from(bytes);
  tampered[0] ^= 1;
  writeFileSync(archive, tampered);
  const badDigest = check();
  assert.equal(badDigest.status, 1);
  assert.equal(JSON.parse(badDigest.stdout).code, 'ARCHIVE_DIGEST_MISMATCH');
});

test('automat inspect rejects incompatible tar or manifest metadata even with a valid release signature', async (t) => {
  const { authorize, check, inspect } = fixture(t);
  const expectedManifest = entry('manifest.json', JSON.stringify(manifest));
  const valid = [expectedManifest, entry('dist/index.js'), entry('index.html')];
  function pack(entries: Buffer[], end = Buffer.alloc(1024)): Buffer {
    return gzipSync(Buffer.concat([...entries, end]));
  }
  async function rejects(bytes: Buffer, code: string) {
    authorize(bytes);
    await assert.rejects(inspect(), { code });
  }
  const badHeader = entry('extra');
  badHeader[0] ^= 1;
  const variants: [string, () => Buffer, string][] = [
    ['unsupported archive', () => Buffer.from('signed opaque content'), 'ARCHIVE_FORMAT_INVALID'],
    ['bytes after gzip stream', () => Buffer.concat([pack(valid), Buffer.from([0, 1])]), 'ARCHIVE_FORMAT_INVALID'],
    ['header checksum', () => pack([...valid, badHeader]), 'ARCHIVE_FORMAT_INVALID'],
    ['symbolic link', () => pack([...valid, entry('link', '', '2')]), 'ARCHIVE_ENTRY_UNSUPPORTED'],
    ['hard link', () => pack([...valid, entry('link', '', '1')]), 'ARCHIVE_ENTRY_UNSUPPORTED'],
    ['PAX record', () => pack([...valid, entry('pax', '', 'x')]), 'ARCHIVE_ENTRY_UNSUPPORTED'],
    ['explicit directory', () => pack([...valid, entry('extra', '', '5')]), 'ARCHIVE_ENTRY_UNSUPPORTED'],
    ['relative traversal', () => pack([...valid, entry('nested/../file')]), 'ARCHIVE_PATH_INVALID'],
    ['absolute path', () => pack([...valid, entry('/file')]), 'ARCHIVE_PATH_INVALID'],
    ['Windows drive', () => pack([...valid, entry('C:/file')]), 'ARCHIVE_PATH_INVALID'],
    ['device name', () => pack([...valid, entry('NUL.txt')]), 'ARCHIVE_PATH_INVALID'],
    ['duplicate manifest', () => pack([...valid, expectedManifest]), 'ARCHIVE_PATH_COLLISION'],
    ['case collision', () => pack([...valid, entry('DIST/other.js')]), 'ARCHIVE_PATH_COLLISION'],
    ['file-directory collision', () => pack([...valid, entry('dist')]), 'ARCHIVE_PATH_COLLISION'],
    ['missing end block', () => pack(valid, Buffer.alloc(512)), 'ARCHIVE_FORMAT_INVALID'],
    ['hidden data after end', () => pack([...valid, Buffer.alloc(1024), entry('hidden')]), 'ARCHIVE_FORMAT_INVALID'],
    ['manifest missing', () => pack(valid.slice(1)), 'MANIFEST_MISSING'],
    ['manifest too large', () => pack([entry('manifest.json', Buffer.alloc(64 * 1024 + 1)), ...valid.slice(1)]), 'MANIFEST_TOO_LARGE'],
    ['manifest JSON invalid', () => pack([entry('manifest.json', '{'), ...valid.slice(1)]), 'MANIFEST_INVALID'],
    ['manifest schema invalid', () => pack([entry('manifest.json', JSON.stringify({ ...manifest, type: 'unknown' })), ...valid.slice(1)]), 'MANIFEST_INVALID'],
    ['manifest name mismatch', () => pack([entry('manifest.json', JSON.stringify({ ...manifest, id: 'other' })), ...valid.slice(1)]), 'MANIFEST_RELEASE_MISMATCH'],
    ['manifest version mismatch', () => pack([entry('manifest.json', JSON.stringify({ ...manifest, version: '1.0.1' })), ...valid.slice(1)]), 'MANIFEST_RELEASE_MISMATCH'],
    ['manifest permission denied', () => pack([entry('manifest.json', JSON.stringify({ ...manifest, permissions: [' SYSTEM.PROCESS '] })), ...valid.slice(1)]), 'MANIFEST_PERMISSION_DENIED'],
    ['entrypoint missing', () => pack(valid.slice(0, -1)), 'MANIFEST_ENTRYPOINT_MISSING'],
    ['entrypoint traversal', () => pack([entry('manifest.json', JSON.stringify({ ...manifest, entrypoint: '../script.js' })), ...valid.slice(1)]), 'ARCHIVE_PATH_INVALID'],
    ['entry count', () => pack([...valid, ...Array.from({ length: 4094 }, (_, i) => entry(`file-${i}`))]), 'ARCHIVE_ENTRY_LIMIT'],
    ['file size', () => pack([...valid, createUStarHeader('large.bin', 32 * 1024 * 1024 + 1)]), 'ARCHIVE_ENTRY_TOO_LARGE'],
    ['expanded size', () => gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)), 'ARCHIVE_EXPANSION_LIMIT'],
  ];
  for (const [name, bytes, code] of variants) {
    await t.test(name, () => rejects(bytes(), code));
  }

  // The established verify command still accepts signed opaque bytes.
  authorize(Buffer.from('signed opaque content'));
  const rejected = check();
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).code, 'ARCHIVE_FORMAT_INVALID');
  const verified = check('verify');
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verified, true);
});


function stageFixtureArchive(manifestContent = manifest): Buffer {
  return gzipSync(Buffer.concat([
    entry('manifest.json', JSON.stringify(manifestContent)),
    entry('dist/index.js', 'throw new Error("Package code must remain inert.");'),
    entry('index.html', '<html></html>'),
    Buffer.alloc(1024),
  ]));
}

test('automat stage rejects unsupported destinations and invalid releases before writing', { skip: !process.getuid }, (t) => {
  const { root, archive, proof, trust, authorize, check } = fixture(t);
  const bytes = stageFixtureArchive();
  authorize(bytes);
  const out = join(root, 'staging');
  mkdirSync(out, { mode: 0o700 });
  function rejects(code: string, ...args: string[]) {
    const result = check('stage', ...args);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.staged, false);
    assert.equal(body.code, code);
    assert.deepEqual(readdirSync(out), []);
  }

  rejects('STAGE_USAGE');
  rejects('STAGE_ROOT_INVALID', '--out', join(root, 'missing-directory'));
  const outputLink = join(root, 'staging-link');
  symlinkSync(out, outputLink);
  rejects('STAGE_ROOT_INVALID', '--out', outputLink);
  chmodSync(out, 0o777);
  rejects('STAGE_ROOT_INVALID', '--out', out);
  chmodSync(out, 0o700);

  const invalidProof = JSON.parse(readFileSync(proof, 'utf8'));
  invalidProof.signature = Buffer.alloc(64).toString('base64');
  writeFileSync(proof, JSON.stringify(invalidProof));
  rejects('SIGNATURE_INVALID', '--out', out);
  authorize(bytes);
  const revokedTrust = JSON.parse(readFileSync(trust, 'utf8'));
  revokedTrust.keys[0].status = 'revoked';
  writeFileSync(trust, JSON.stringify(revokedTrust));
  rejects('PUBLISHER_KEY_REVOKED', '--out', out);
  authorize(bytes);
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  writeFileSync(archive, altered);
  rejects('ARCHIVE_DIGEST_MISMATCH', '--out', out);
  authorize(stageFixtureArchive({ ...manifest, version: '2.0.0' }));
  rejects('MANIFEST_RELEASE_MISMATCH', '--out', out);
});

test('local staging retains the inspected snapshot if the source archive and proof paths change', { skip: !process.getuid }, async (t) => {
  const { root, archive, proof, trust, authorize, cli } = fixture(t);
  const original = stageFixtureArchive();
  const artifact = authorize(original);
  const originalProof = JSON.parse(readFileSync(proof, 'utf8'));
  const out = join(root, 'staging');
  mkdirSync(out, { mode: 0o700 });

  const fileOps = require('node:fs') as typeof import('node:fs');
  const mkdirTemp = fileOps.mkdtempSync;
  let replaced = false;
  t.mock.method(fileOps, 'mkdtempSync', (prefix: string) => {
    if (prefix.startsWith(out)) {
      writeFileSync(archive, 'Different local bytes');
      writeFileSync(proof, 'Different proof');
      replaced = true;
    }
    return mkdirTemp(prefix);
  });
  const staged = await stageLocalPackage(archive, proof, trust, out);
  assert.equal(replaced, true);
  assert.deepEqual(staged.artifact, artifact);
  assert.deepEqual(readFileSync(join(staged.directory, 'package.tgz')), original);
  assert.deepEqual(JSON.parse(readFileSync(join(staged.directory, 'package.proof.json'), 'utf8')), originalProof);
  const reverified = cli('verify', join(staged.directory, 'package.tgz'), '--proof',
    join(staged.directory, 'package.proof.json'), '--trust', trust, '--json');
  assert.equal(reverified.status, 0, reverified.stderr || reverified.stdout);
});

test('local staging removes incomplete output after an ordinary write failure', { skip: !process.getuid }, async (t) => {
  const { root, archive, proof, trust, authorize } = fixture(t);
  authorize(stageFixtureArchive());
  const out = join(root, 'staging');
  mkdirSync(out, { mode: 0o700 });
  const fileOps = require('node:fs') as typeof import('node:fs');
  const sync = fileOps.fsyncSync;
  let calls = 0;
  t.mock.method(fileOps, 'fsyncSync', (fd: number) => {
    if (++calls === 2) throw new Error('Fixture write failure');
    return sync(fd);
  });
  await assert.rejects(stageLocalPackage(archive, proof, trust, out), { code: 'STAGE_WRITE_FAILED' });
  assert.equal(calls, 2);
  assert.deepEqual(readdirSync(out), []);
});
