import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadInspectedArchive } from './packageInspection';
import { PackageVerificationError } from './packageProof';

function resolveStageRoot(directory: string) {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new PackageVerificationError('STAGE_PLATFORM_UNSUPPORTED', 'Local staging requires POSIX file permissions.');
  }
  try {
    const expected = fs.lstatSync(directory, { bigint: true });
    const root = fs.realpathSync(directory);
    const actual = fs.lstatSync(root, { bigint: true });
    if (expected.isDirectory() && actual.isDirectory() &&
        expected.dev === actual.dev && expected.ino === actual.ino &&
        actual.uid === BigInt(uid) && (actual.mode & 0o022n) === 0n) {
      return { path: root, device: actual.dev, inode: actual.ino };
    }
  } catch {
    // The same error covers missing and unreadable destinations.
  }
  throw new PackageVerificationError(
    'STAGE_ROOT_INVALID', 'Expected an existing output directory owned by the current user, without group or world write access.',
  );
}

function writePrivateFile(filePath: string, data: Buffer | string): void {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(filePath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requireCurrentAuthorization(expiresAt: string): void {
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new PackageVerificationError('TRUST_EXPIRED', 'The administrator’s release authorization has expired.');
  }
}

export async function stageLocalPackage(archivePath: string, proofPath: string, trustPath: string, out: string) {
  const requestedRoot = path.resolve(out);
  const root = resolveStageRoot(requestedRoot);
  const { inspection, proof, bytes } = await loadInspectedArchive(archivePath, proofPath, trustPath);
  requireCurrentAuthorization(inspection.trustExpiresAt);

  let directory: string | undefined;
  try {
    const current = resolveStageRoot(requestedRoot);
    if (current.path !== root.path || current.device !== root.device || current.inode !== root.inode) {
      throw new PackageVerificationError('STAGE_ROOT_INVALID', 'The output directory changed during verification.');
    }
    directory = fs.mkdtempSync(path.join(root.path, 'stage-'));
    fs.chmodSync(directory, 0o700);
    writePrivateFile(path.join(directory, 'package.tgz'), bytes);
    writePrivateFile(path.join(directory, 'package.proof.json'), JSON.stringify(proof) + '\n');
    const receipt = { format: 'automat-extension-stage-v1', staged: true, ...inspection };
    const pending = path.join(directory, '.inspection.pending');
    writePrivateFile(pending, JSON.stringify(receipt) + '\n');
    requireCurrentAuthorization(inspection.trustExpiresAt);

    // The receipt appears only after the staged files are complete.
    fs.renameSync(pending, path.join(directory, 'inspection.json'));
    return { directory, ...inspection };
  } catch (error) {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {
        throw new PackageVerificationError('STAGE_CLEANUP_FAILED', 'Could not remove an incomplete staging directory.');
      }
    }
    if (error instanceof PackageVerificationError) throw error;
    throw new PackageVerificationError('STAGE_WRITE_FAILED', 'Could not write the inspected package to the output directory.');
  }
}
