import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type Company = { phoneNumberId: string; outboundId?: string; catalogGraphId?: string; auth: { accessToken: string } };

export function provisionCompanies(...options: string[]): Company[] {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/test/fixtures/browserInbox.ts', ...options], {
    cwd: fileURLToPath(new URL('../../../WhatsaapWeb-JS/', import.meta.url)),
    encoding: 'utf8', timeout: 15000,
  }).trim().split('\n').at(-1)!;
  return JSON.parse(output);
}
