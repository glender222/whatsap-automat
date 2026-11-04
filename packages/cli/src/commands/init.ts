import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger';
import { getChannelTemplate } from '../templates/channel';
import { getToolTemplate } from '../templates/tool';
import { getUiTemplate } from '../templates/ui';

export interface InitOptions {
  name?: string;
  type?: string;
  dir?: string;
  force?: boolean;
}

const VALID_TYPES = ['channel', 'tool', 'ui'] as const;
type ExtensionType = (typeof VALID_TYPES)[number];

const NAME_REGEX = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;

export async function handleInit(options: InitOptions): Promise<number> {
  const { name, type, dir, force } = options;

  if (!name || name.trim().length === 0) {
    logger.error('Missing required argument: <plugin-name>');
    logger.info('Usage: automat init <plugin-name> --type=<channel|tool|ui>');
    return 1;
  }

  if (!NAME_REGEX.test(name)) {
    logger.error(`Invalid plugin name: "${name}". Name must be lowercase alphanumeric with hyphens, underscores, dots, or npm scope.`);
    return 1;
  }

  if (!type || !VALID_TYPES.includes(type.toLowerCase() as ExtensionType)) {
    logger.error(`Missing or invalid --type="${type}". Allowed types: ${VALID_TYPES.join(', ')}`);
    return 1;
  }

  const extType = type.toLowerCase() as ExtensionType;
  const targetDir = dir ? path.resolve(process.cwd(), dir) : path.resolve(process.cwd(), name.replace(/^@[^/]+\//, ''));

  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir);
    if (files.length > 0 && !force) {
      logger.error(`Directory "${targetDir}" already exists and is not empty. Use --force to overwrite.`);
      return 1;
    }
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    let templateFiles: Record<string, string>;
    switch (extType) {
      case 'channel':
        templateFiles = getChannelTemplate(name);
        break;
      case 'tool':
        templateFiles = getToolTemplate(name);
        break;
      case 'ui':
        templateFiles = getUiTemplate(name);
        break;
    }

    for (const [relPath, content] of Object.entries(templateFiles)) {
      const fullPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content.trimStart(), 'utf8');
    }

    logger.success(`Scaffolded ${extType} extension "${name}" in ${targetDir}`);
    logger.info(`Next steps:`);
    logger.info(`  cd ${path.relative(process.cwd(), targetDir) || '.'}`);
    logger.info(`  automat validate manifest.json`);
    logger.info(`  automat pack .`);
    return 0;
  } catch (err: any) {
    logger.error(`Failed to scaffold extension: ${err.message}`);
    return 1;
  }
}
