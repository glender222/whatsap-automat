import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger';
import { publishPackageFiles } from '../utils/packageOutput';
import { validateManifestContents } from '../utils/validator';
import { packDirectoryToTarGz, calculateSha256, readRegularPackageFile } from '../utils/tar';

export interface PackOptions {
  pluginDir?: string;
  out?: string;
  dryRun?: boolean;
}

export async function handlePack(options: PackOptions): Promise<number> {
  const { pluginDir, out, dryRun } = options;
  const rootDir = path.resolve(process.cwd(), pluginDir || '.');

  if (!fs.existsSync(rootDir) || !fs.lstatSync(rootDir).isDirectory()) {
    logger.error(`Expected an existing package directory: ${rootDir}`);
    return 1;
  }

  const manifestPath = path.join(rootDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    logger.error(`manifest.json not found in ${rootDir}. Run "automat init" first.`);
    return 1;
  }

  let manifestContents: string;
  try {
    manifestContents = readRegularPackageFile(manifestPath).content.toString('utf8');
  } catch {
    logger.error('Cannot pack extension: expected a regular, readable manifest.json.');
    return 1;
  }
  const valResult = validateManifestContents(manifestContents);
  if (!valResult.valid) {
    logger.error(`Cannot pack extension: manifest validation failed.`);
    for (const err of valResult.errors) logger.error(`  - ${err}`);
    return 1;
  }

  const manifest = valResult.manifest!;
  const safeName = manifest.name.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+/, '');
  const defaultTarName = `${safeName}-${manifest.version}.tgz`;

  try {
    const { gzBuffer, includedFiles } = packDirectoryToTarGz(rootDir);

    if (dryRun) {
      logger.info(`[DRY RUN] Would package ${includedFiles.length} files:`);
      for (const f of includedFiles) {
        logger.info(`  + ${f}`);
      }
      return 0;
    }

    const destination = out ? path.resolve(process.cwd(), out) : rootDir;
    const outTarPath = !out || fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()
      ? path.join(destination, defaultTarName)
      : destination;
    const sha256 = calculateSha256(gzBuffer);
    const checksumPath = `${outTarPath}.sha256`;
    const checksumContent = `${sha256}  ${path.basename(outTarPath)}\n`;
    publishPackageFiles(outTarPath, gzBuffer, checksumContent);

    logger.success(`Extension packaged successfully:`);
    logger.info(`  Archive:  ${outTarPath} (${gzBuffer.length} bytes, ${includedFiles.length} files)`);
    logger.info(`  Checksum: ${checksumPath}`);
    logger.info(`  SHA-256:  ${sha256}`);
    return 0;
  } catch (err: any) {
    logger.error(`Packaging failed: ${err.message}`);
    return 1;
  }
}
