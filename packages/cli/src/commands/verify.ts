import { parseArgs } from 'node:util';
import { logger } from '../utils/logger';
import { PackageVerificationError, verifyLocalPackage } from '../utils/packageProof';

export async function handlePackageCheck(mode: 'verify' | 'inspect', args: string[]): Promise<number> {
  let json = args.includes('--json');
  const resultField = mode === 'verify' ? 'verified' : 'inspected';
  const usage = new PackageVerificationError(
    `${mode.toUpperCase()}_USAGE`, `Usage: automat ${mode} <archive> --proof <proof.json> --trust <trust.json> [--json]`,
  );
  let validArgs = false;
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
      proof: { type: 'string' }, trust: { type: 'string' }, json: { type: 'boolean' },
    } });
    json = values.json ?? false;
    if (positionals.length !== 1 || !values.proof || !values.trust) throw usage;
    validArgs = true;
    const check = mode === 'verify' ? verifyLocalPackage :
      (require('../utils/packageInspection') as typeof import('../utils/packageInspection')).inspectLocalPackage;
    const result = await check(positionals[0]!, values.proof, values.trust);
    if (json) console.log(JSON.stringify({ [resultField]: true, ...result }));
    else if (mode === 'verify') logger.success(`Verified ${result.artifact.extensionId}@${result.artifact.version} against the local release authorization.`);
    else logger.success(`Inspected signed package ${result.artifact.extensionId}@${result.artifact.version}.`);
    return 0;
  } catch (error) {
    const problem = error instanceof PackageVerificationError ? error :
      mode === 'inspect' && validArgs ? new PackageVerificationError('INSPECTION_FAILED', 'Could not inspect the signed package.') : usage;
    if (json) console.log(JSON.stringify({ [resultField]: false, code: problem.code, message: problem.message }));
    else logger.error(`${problem.code}: ${problem.message}`);
    return 1;
  }
}
