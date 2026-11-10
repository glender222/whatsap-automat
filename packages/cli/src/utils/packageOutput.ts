import * as fs from 'node:fs';
import * as path from 'node:path';

export const PACKAGE_OUTPUT_STAGE = '.automat-pack.lock';

interface OutputFile {
  destination: string;
  prepared: string;
  backup: string;
  reverted: string;
  data: Buffer | string;
  original?: fs.BigIntStats;
  preparedStat?: fs.BigIntStats;
  moved: boolean;
  published: boolean;
}

function sameFile(current: fs.BigIntStats | undefined, expected: fs.BigIntStats): boolean {
  return Boolean(current?.isFile() && current.dev === expected.dev && current.ino === expected.ino);
}

function makeOutput(stage: string, name: string, destination: string, data: Buffer | string): OutputFile {
  return {
    destination, data,
    prepared: path.join(stage, `${name}.new`),
    backup: path.join(stage, `${name}.before`),
    reverted: path.join(stage, `${name}.reverted`),
    moved: false, published: false,
  };
}

function restore(output: OutputFile): boolean {
  try {
    if (output.published && output.preparedStat) {
      if (!sameFile(fs.lstatSync(output.destination, { bigint: true, throwIfNoEntry: false }), output.preparedStat)) return false;
      // Move first so an unexpected replacement cannot be unlinked during rollback.
      fs.renameSync(output.destination, output.reverted);
      if (!sameFile(fs.lstatSync(output.reverted, { bigint: true }), output.preparedStat)) return false;
    }
    if (output.moved && output.original) {
      if (!sameFile(fs.lstatSync(output.backup, { bigint: true }), output.original)) return false;
      fs.linkSync(output.backup, output.destination);
    }
    return true;
  } catch {
    return false;
  }
}

export function publishPackageFiles(archivePath: string, archive: Buffer, checksum: string): void {
  const parent = path.dirname(archivePath);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, PACKAGE_OUTPUT_STAGE);
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Package output directory is locked: "${stage}".`);
    }
    throw error;
  }

  const outputs = [
    makeOutput(stage, 'archive', archivePath, archive),
    makeOutput(stage, 'checksum', `${archivePath}.sha256`, checksum),
  ];
  let keepStage = false;
  try {
    for (const output of outputs) {
      output.original = fs.lstatSync(output.destination, { bigint: true, throwIfNoEntry: false });
      if (output.original) {
        if (!output.original.isFile()) throw new Error(`Output must be a regular file: "${output.destination}".`);
        fs.accessSync(output.destination, fs.constants.W_OK);
      }
    }

    for (const output of outputs) {
      fs.writeFileSync(output.prepared, output.data, { flag: 'wx' });
      if (output.original) fs.chmodSync(output.prepared, Number(output.original.mode & 0o777n));
      output.preparedStat = fs.lstatSync(output.prepared, { bigint: true });
    }
    fs.writeFileSync(path.join(stage, 'destinations.json'), JSON.stringify({
      archive: path.basename(archivePath), checksum: path.basename(outputs[1]!.destination),
    }), { flag: 'wx' });

    for (const output of outputs) {
      if (!output.original) continue;
      if (!sameFile(fs.lstatSync(output.destination, { bigint: true, throwIfNoEntry: false }), output.original)) {
        throw new Error(`Output changed before publication: "${output.destination}".`);
      }
      fs.renameSync(output.destination, output.backup);
      output.moved = true;
      if (!sameFile(fs.lstatSync(output.backup, { bigint: true }), output.original)) {
        throw new Error(`Output changed during publication: "${output.destination}".`);
      }
    }

    // Linking a complete same-filesystem file creates the destination exclusively.
    // A destination inserted by another writer is never replaced.
    for (const output of outputs) {
      fs.linkSync(output.prepared, output.destination);
      output.published = true;
    }
  } catch (error) {
    const restored = outputs.reverse().map(restore);
    if (restored.includes(false)) {
      keepStage = true;
      throw new Error(`Package publication could not be rolled back safely. Recovery files remain in "${stage}".`, { cause: error });
    }
    throw error;
  } finally {
    if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
  }
}
