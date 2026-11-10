import { parseArgs } from 'node:util';
import { logger } from '../utils/logger';
import { PackageVerificationError, verifyLocalPackage } from '../utils/packageProof';

export async function handlePackageCheck(mode: 'verify' | 'inspect' | 'stage', args: string[]): Promise<number> {
  let json = args.includes('--json');
  const resultField = mode === 'verify' ? 'verified' : mode === 'inspect' ? 'inspected' : 'staged';
  const outOption = mode === 'stage' ? ' --out <directory>' : '';
  const usage = new PackageVerificationError(
    `${mode.toUpperCase()}_USAGE`, `Usage: automat ${mode} <archive> --proof <proof.json> --trust <trust.json>${outOption} [--json]`,
  );
  let validArgs = false;
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
      proof: { type: 'string' }, trust: { type: 'string' }, json: { type: 'boolean' }, out: { type: 'string' },
    } });
    json = values.json ?? false;
    const outAllowed = mode === 'stage' ? Boolean(values.out) : values.out === undefined;
    if (positionals.length !== 1 || !values.proof || !values.trust || !outAllowed) throw usage;
    validArgs = true;
    const inputs = [positionals[0]!, values.proof, values.trust] as const;
    if (mode === 'stage') {
      const { stageLocalPackage } = require('../utils/packageStage') as typeof import('../utils/packageStage');
      const result = await stageLocalPackage(...inputs, values.out!);
      if (json) console.log(JSON.stringify({ staged: true, ...result }));
      else logger.success(`Staged signed package at "${result.directory}".`);
    } else {
      const check = mode === 'verify' ? verifyLocalPackage :
        (require('../utils/packageInspection') as typeof import('../utils/packageInspection')).inspectLocalPackage;
      const result = await check(...inputs);
      if (json) console.log(JSON.stringify({ [resultField]: true, ...result }));
      else if (mode === 'verify') logger.success(`Verified ${result.artifact.extensionId}@${result.artifact.version} against the local release authorization.`);
      else logger.success(`Inspected signed package ${result.artifact.extensionId}@${result.artifact.version}.`);
    }
    return 0;
  } catch (error) {
    const processingError = mode === 'inspect'
      ? new PackageVerificationError('INSPECTION_FAILED', 'Could not inspect the signed package.')
      : new PackageVerificationError('STAGING_FAILED', 'Could not stage the signed package.');
    const problem = error instanceof PackageVerificationError ? error :
      validArgs && mode !== 'verify' ? processingError : usage;
    if (json) console.log(JSON.stringify({ [resultField]: false, code: problem.code, message: problem.message }));
    else logger.error(`${problem.code}: ${problem.message}`);
    return 1;
  }
}
