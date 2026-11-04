import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger';
import { validateManifestFile } from '../utils/validator';

export interface ValidateOptions {
  manifestPath?: string;
  json?: boolean;
  strict?: boolean;
}

export async function handleValidate(options: ValidateOptions): Promise<number> {
  const { manifestPath, json, strict } = options;
  const resolvedPath = path.resolve(process.cwd(), manifestPath || 'manifest.json');

  if (!fs.existsSync(resolvedPath)) {
    if (json) {
      console.log(JSON.stringify({ valid: false, errors: [`Manifest file not found: ${resolvedPath}`], warnings: [] }));
    } else {
      logger.error(`Manifest file not found: ${resolvedPath}`);
    }
    return 1;
  }

  const result = validateManifestFile(resolvedPath, { strict });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  if (result.valid) {
    logger.success(`Manifest validation PASSED: ${resolvedPath}`);
    logger.info(`  Name: ${result.manifest?.name}`);
    logger.info(`  Version: ${result.manifest?.version}`);
    logger.info(`  Type: ${result.manifest?.type}`);
    logger.info(`  Permissions: ${result.manifest?.permissions?.join(', ') || '(none)'}`);
    if (result.warnings.length > 0) {
      for (const w of result.warnings) logger.warn(`  Warning: ${w}`);
    }
    return 0;
  } else {
    logger.error(`Manifest validation FAILED: ${resolvedPath}`);
    for (const e of result.errors) {
      logger.error(`  - ${e}`);
    }
    return 1;
  }
}
