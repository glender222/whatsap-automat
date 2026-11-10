import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('automat verify accepts only independently authorized signed archive bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'automat-proof-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({
    id: '@test/catalog', name: '@test/catalog', version: '1.0.0', type: 'tool', entrypoint: 'never-run.js',
  }));
  writeFileSync(join(source, 'never-run.js'), "throw new Error('Package code must remain inert.');\n");
  const archive = join(root, 'fixture.tgz');
  const proofPath = join(root, 'proof.json');
  const trustPath = join(root, 'trust.json');
  const executable = join(__dirname, '..', 'bin', 'automat.js');
  const cli = (...args: string[]) => spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: 'utf8' });
  const packed = cli('pack', source, '--out', archive);
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  const artifact = {
    registryId: 'local-qa', publisherTenantId: 'tenant-23', listingId: 'ext_fixture-001', extensionId: '@test/catalog',
    version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(spki).digest('hex');
  const active = { keyId, publicKeySpki: spki.toString('base64'), status: 'active' };
  const trust = { format: 'automat-extension-trust-v1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    artifact, keys: [active] };
  const signed = (claims = artifact, fingerprint = keyId) => ({
    format: 'automat-extension-proof-v1', artifact: claims, keyId: fingerprint,
    signature: sign(null, Buffer.from('automat-extension-proof-v1\n' + JSON.stringify([
      claims.registryId, claims.publisherTenantId, claims.listingId, claims.extensionId, claims.version,
      claims.sha256, claims.sizeBytes, fingerprint,
    ])), privateKey).toString('base64'),
  });
  const proof = signed();
  const writeProof = (data: unknown) => writeFileSync(proofPath, JSON.stringify(data));
  const writeTrust = (data: unknown) => writeFileSync(trustPath, JSON.stringify(data));
  const runVerify = (...extra: string[]) => cli('verify', archive, '--proof', proofPath, '--trust', trustPath, '--json', ...extra);
  function expectFailure(code: string) {
    const result = runVerify();
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).code, code);
  }

  writeProof(proof);
  writeTrust(trust);
  const originalFiles = readdirSync(root);
  const accepted = runVerify();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { verified: true, artifact, keyId, trustExpiresAt: trust.expiresAt });
  assert.deepEqual(readdirSync(root), originalFiles);
  assert.equal(cli('verify', archive, '--proof', proofPath, '--trust', trustPath).status, 0);
  assert.equal(JSON.parse(runVerify('--force').stdout).code, 'VERIFY_USAGE');

  for (const modified of [
    { listingId: 'ext_other' }, { publisherTenantId: 'tenant-99' }, { registryId: 'different-registry' },
    { version: '1.0.1' }, { extensionId: '@test/other' }, { sha256: '0'.repeat(64) },
  ]) {
    writeProof(signed({ ...artifact, ...modified }));
    expectFailure('RELEASE_MISMATCH');
  }
  writeProof(signed(artifact, '1'.repeat(64)));
  expectFailure('PUBLISHER_KEY_UNKNOWN');
  writeProof({ ...proof, publicKeySpki: active.publicKeySpki });
  expectFailure('PROOF_FORMAT_INVALID');
  writeProof({ ...proof, signature: Buffer.alloc(64).toString('base64') });
  expectFailure('SIGNATURE_INVALID');
  writeProof(proof);
  writeTrust({ ...trust, keys: [{ ...active, status: 'revoked' }] });
  expectFailure('PUBLISHER_KEY_REVOKED');
  writeTrust({ ...trust, keys: [active, active] });
  expectFailure('TRUST_FORMAT_INVALID');
  writeTrust({ ...trust, keys: [{ ...active, publicKeySpki: generateKeyPairSync('ed25519').publicKey
    .export({ format: 'der', type: 'spki' }).toString('base64') }] });
  expectFailure('TRUST_KEY_INVALID');
  writeTrust({ ...trust, expiresAt: '2001-01-01T00:00:00.000Z' });
  expectFailure('TRUST_EXPIRED');
  writeTrust(trust);

  writeFileSync(proofPath, '{');
  expectFailure('PROOF_FORMAT_INVALID');
  truncateSync(proofPath, 8193);
  expectFailure('PROOF_TOO_LARGE');
  writeProof(proof);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 1;
  writeFileSync(archive, tampered);
  expectFailure('ARCHIVE_DIGEST_MISMATCH');
  truncateSync(archive, bytes.length - 1);
  expectFailure('ARCHIVE_SIZE_MISMATCH');
  truncateSync(archive, 64 * 1024 * 1024 + 1);
  expectFailure('ARCHIVE_TOO_LARGE');
});
