import { parseArgs } from 'node:util';
import { handleInit } from './commands/init';
import { handleValidate } from './commands/validate';
import { handlePack } from './commands/pack';
import { handleDoctor } from './commands/doctor';
import { handleVerify } from './commands/verify';
import { logger } from './utils/logger';

export const VERSION = '0.4.0';

export function printHelp(): void {
  console.log(`
Automat Developer CLI — Extension Tooling (v${VERSION})

Usage:
  automat <command> [arguments] [options]

Commands:
  init <name>       Scaffold a new extension project directory
                    Options: --type=<channel|tool|ui>, --dir=<path>, --force
  validate [path]   Validate extension manifest against canonical schema
                    Options: --json, --strict
  pack [dir]        Bundle extension into .tgz archive with sha256 checksum
                    Options: --out=<path>, --dry-run
  verify <archive>  Verify an archive against a signed proof and local release authorization
                    Options: --proof=<file>, --trust=<file>, --json
  doctor            Inspect developer environment and system diagnostics
                    Options: --json, --verbose

Global Options:
  -h, --help        Show this help message
  -v, --version     Show version number
`);
}

export async function runCli(args: string[]): Promise<number> {
  if (args[0]?.toLowerCase() === 'verify') {
    if (args.length === 2 && ['--help', '-h'].includes(args[1]!)) {
      printHelp();
      return 0;
    }
    return handleVerify(args.slice(1));
  }
  const options = {
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const, short: 'v' },
    type: { type: 'string' as const, short: 't' },
    dir: { type: 'string' as const, short: 'd' },
    out: { type: 'string' as const, short: 'o' },
    force: { type: 'boolean' as const, short: 'f' },
    json: { type: 'boolean' as const },
    strict: { type: 'boolean' as const },
    verbose: { type: 'boolean' as const },
    'dry-run': { type: 'boolean' as const },
  };

  let parsed: { values: Record<string, any>; positionals: string[] };
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: false,
    }) as { values: Record<string, any>; positionals: string[] };
  } catch (err: any) {
    logger.error(`Argument error: ${err.message}`);
    printHelp();
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(`automat v${VERSION}`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    return 0;
  }

  const command = positionals[0]?.toLowerCase();

  switch (command) {
    case 'init': {
      const pluginName = positionals[1];
      return handleInit({
        name: pluginName,
        type: values.type,
        dir: values.dir,
        force: Boolean(values.force),
      });
    }

    case 'validate': {
      const manifestPath = positionals[1];
      return handleValidate({
        manifestPath,
        json: Boolean(values.json),
        strict: Boolean(values.strict),
      });
    }

    case 'pack': {
      const pluginDir = positionals[1];
      return handlePack({
        pluginDir,
        out: values.out,
        dryRun: Boolean(values['dry-run']),
      });
    }

    case 'doctor': {
      return handleDoctor({
        json: Boolean(values.json),
        verbose: Boolean(values.verbose),
      });
    }

    default: {
      logger.error(`Unknown command: "${command}"`);
      printHelp();
      return 1;
    }
  }
}
