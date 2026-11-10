import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';

const archiveLimit = 64 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const artifactSchema = z.strictObject({
  registryId: identifier,
  publisherTenantId: identifier,
  listingId: z.string().regex(/^ext_[A-Za-z0-9_-]{1,128}$/),
  extensionId: z.string().max(200).regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/),
  version: z.string().max(64).regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),
  sha256: digest,
  sizeBytes: z.number().int().positive().max(archiveLimit),
});
type Artifact = z.infer<typeof artifactSchema>;
const proofSchema = z.strictObject({
  format: z.literal('automat-extension-proof-v1'),
  artifact: artifactSchema,
  keyId: digest,
  signature: z.string().length(88),
});
const trustSchema = z.strictObject({
  format: z.literal('automat-extension-trust-v1'),
  artifact: artifactSchema,
  expiresAt: z.iso.datetime(),
  keys: z.array(z.strictObject({
    keyId: digest,
    publicKeySpki: z.string().length(60),
    status: z.enum(['active', 'revoked']),
  })).min(1).max(32),
});

export class PackageVerificationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function packageSigningBytes(artifact: Artifact, keyId: string): Buffer {
  return Buffer.from('automat-extension-proof-v1\n' + JSON.stringify([
    artifact.registryId, artifact.publisherTenantId, artifact.listingId, artifact.extensionId,
    artifact.version, artifact.sha256, artifact.sizeBytes, keyId,
  ]), 'utf8');
}

function decodeBase64(value: string, length: number, code: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== length || decoded.toString('base64') !== value) {
    throw new PackageVerificationError(code, 'Expected canonical base64 encoding.');
  }
  return decoded;
}

async function readLocalFile(
  path: string, limit: number, label: 'PROOF' | 'TRUST' | 'ARCHIVE', consume: (chunk: Buffer) => void,
  expectedBytes?: number,
): Promise<void> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new PackageVerificationError(`${label}_READ_ERROR`, 'Expected a regular local file.');
      if (stat.size > limit) throw new PackageVerificationError(`${label}_TOO_LARGE`, `Input exceeds the ${limit}-byte limit.`);
      const buffer = Buffer.alloc(Math.min(limit + 1, 64 * 1024));
      let bytes = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > limit) throw new PackageVerificationError(`${label}_TOO_LARGE`, `Input exceeds the ${limit}-byte limit.`);
        consume(buffer.subarray(0, bytesRead));
      }
      if (expectedBytes !== undefined && bytes !== expectedBytes) {
        throw new PackageVerificationError('ARCHIVE_SIZE_MISMATCH', 'Archive size differs from the authorized release.');
      }
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof PackageVerificationError) throw error;
    throw new PackageVerificationError(`${label}_READ_ERROR`, `Could not read the ${label.toLowerCase()} file.`);
  }
}

async function readJson<T>(path: string, limit: number, label: 'PROOF' | 'TRUST', schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  await readLocalFile(path, limit, label, (chunk) => chunks.push(Buffer.from(chunk)));
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new PackageVerificationError(`${label}_FORMAT_INVALID`, `Invalid ${label.toLowerCase()} document.`);
  }
}

async function verifyPackage(
  archivePath: string,
  proofPath: string,
  trustPath: string,
  capture?: (sizeBytes: number) => (chunk: Buffer) => void,
) {
  const trust = await readJson(trustPath, 64 * 1024, 'TRUST', trustSchema);
  const proof = await readJson(proofPath, 8 * 1024, 'PROOF', proofSchema);
  const expiresAt = Date.parse(trust.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new PackageVerificationError('TRUST_EXPIRED', 'The administrator’s release authorization has expired.');
  }
  if (new Set(trust.keys.map(({ keyId }) => keyId)).size !== trust.keys.length) {
    throw new PackageVerificationError('TRUST_FORMAT_INVALID', 'The authorization contains duplicate key identifiers.');
  }
  const signedBytes = packageSigningBytes(proof.artifact, proof.keyId);
  if (!signedBytes.equals(packageSigningBytes(trust.artifact, proof.keyId))) {
    throw new PackageVerificationError('RELEASE_MISMATCH', 'The proof does not identify the authorized release.');
  }
  const key = trust.keys.find(({ keyId }) => keyId === proof.keyId);
  if (!key) throw new PackageVerificationError('PUBLISHER_KEY_UNKNOWN', 'The publisher key is absent from the local authorization.');
  if (key.status === 'revoked') throw new PackageVerificationError('PUBLISHER_KEY_REVOKED', 'The local authorization revokes this publisher key.');

  const publicKeySpki = decodeBase64(key.publicKeySpki, 44, 'TRUST_KEY_INVALID');
  const keyId = createHash('sha256').update(publicKeySpki).digest('hex');
  if (keyId !== key.keyId) throw new PackageVerificationError('TRUST_KEY_INVALID', 'The publisher key fingerprint differs from its identifier.');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeySpki, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || !publicKey.export({ format: 'der', type: 'spki' }).equals(publicKeySpki)) {
      throw new Error('Invalid Ed25519 SPKI');
    }
  } catch {
    throw new PackageVerificationError('TRUST_KEY_INVALID', 'The publisher key must be a canonical Ed25519 public key.');
  }
  const signature = decodeBase64(proof.signature, 64, 'PROOF_FORMAT_INVALID');
  if (!verify(null, signedBytes, publicKey, signature)) {
    throw new PackageVerificationError('SIGNATURE_INVALID', 'The publisher signature could not be verified.');
  }
  const hash = createHash('sha256');
  const consume = capture?.(trust.artifact.sizeBytes);
  await readLocalFile(archivePath, archiveLimit, 'ARCHIVE', (chunk) => {
    hash.update(chunk);
    consume?.(chunk);
  }, trust.artifact.sizeBytes);
  if (hash.digest('hex') !== trust.artifact.sha256) {
    throw new PackageVerificationError('ARCHIVE_DIGEST_MISMATCH', 'Archive SHA-256 differs from the authorized release.');
  }
  const verified = { artifact: trust.artifact, keyId: key.keyId, trustExpiresAt: trust.expiresAt };
  return { verified, proof };
}

export async function verifyLocalPackage(archivePath: string, proofPath: string, trustPath: string) {
  return (await verifyPackage(archivePath, proofPath, trustPath)).verified;
}

export async function loadVerifiedArchive(archivePath: string, proofPath: string, trustPath: string) {
  let bytes = Buffer.alloc(0);
  let offset = 0;
  const { verified, proof } = await verifyPackage(archivePath, proofPath, trustPath, (sizeBytes) => {
    bytes = Buffer.alloc(sizeBytes);
    return (chunk) => {
      // The verifier checks the exact length before it returns this snapshot.
      if (offset < bytes.length) offset += chunk.copy(bytes, offset);
    };
  });
  return { verified, proof, bytes };
}
