import { parseArgs } from 'node:util';
import { logger } from '../utils/logger';
import { PackageVerificationError, verifyLocalPackage } from '../utils/packageProof';

export async function handleVerify(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
      proof: { type: 'string' }, trust: { type: 'string' }, json: { type: 'boolean' },
    } });
    json = values.json ?? false;
    if (positionals.length !== 1 || !values.proof || !values.trust) throw new Error('Missing verify input');
    const result = await verifyLocalPackage(positionals[0]!, values.proof, values.trust);
    if (json) console.log(JSON.stringify({ verified: true, ...result }));
    else logger.success(`Verified ${result.artifact.extensionId}@${result.artifact.version} against the local release authorization.`);
    return 0;
  } catch (error) {
    const problem = error instanceof PackageVerificationError ? error :
      new PackageVerificationError('VERIFY_USAGE', 'Usage: automat verify <archive> --proof <proof.json> --trust <trust.json> [--json]');
    if (json) console.log(JSON.stringify({ verified: false, code: problem.code, message: problem.message }));
    else logger.error(`${problem.code}: ${problem.message}`);
    return 1;
  }
}
