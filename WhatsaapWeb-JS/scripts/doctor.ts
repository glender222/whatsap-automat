/**
 * Standalone SRE Diagnostic Doctor CLI Runner (Phase F8)
 *
 * Usage:
 *   npx tsx scripts/doctor.ts [options]
 *
 * Exit code:
 *   0: If overallStatus is PASS or WARN
 *   1: If overallStatus is FAIL
 */

import { DiagnosticDoctor } from '../src/services/diagnostics/DiagnosticDoctor';
import pool from '../src/config/database';

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const verbose = args.includes('--verbose');
  const skipDb = args.includes('--skip-db');
  const skipNetwork = args.includes('--skip-network');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Whatsap-Automat SRE Diagnostic Doctor (Phase F8)

Usage:
  npx tsx scripts/doctor.ts [options]

Options:
  --json          Output raw machine-readable JSON report
  --verbose       Print remediation guides and extended details
  --skip-db       Skip live PostgreSQL database and migration checks
  --skip-network  Skip external DNS resolution probes
  -h, --help      Show this help message
`);
    process.exit(0);
  }

  const doctor = new DiagnosticDoctor({
    pool: skipDb ? undefined : pool,
    skipDatabase: skipDb,
    skipNetwork,
  });

  try {
    const report = await doctor.runAll();

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.overallStatus === 'FAIL' ? 1 : 0);
    }

    console.log(`\n======================================================`);
    console.log(`🩺 Whatsap-Automat SRE Diagnostic Doctor Report`);
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`Duration:  ${report.executionDurationMs}ms`);
    console.log(`======================================================\n`);

    for (const check of report.checks) {
      const sym = check.status === 'PASS' ? '✔' : check.status === 'WARN' ? '⚠' : '✖';
      const color =
        check.status === 'PASS'
          ? '\x1b[32m'
          : check.status === 'WARN'
          ? '\x1b[33m'
          : '\x1b[31m';
      const reset = '\x1b[0m';

      console.log(
        `${color}${sym} [${check.status}] [${check.code}] ${check.name} (${check.latencyMs}ms)${reset}`
      );
      console.log(`   ${check.details}`);
      if (check.remediationGuide && (verbose || check.status !== 'PASS')) {
        console.log(`   \x1b[36mRemediation:\x1b[0m ${check.remediationGuide}`);
      }
      console.log('');
    }

    console.log(`------------------------------------------------------`);
    console.log(
      `Summary: Total: ${report.total} | Passed: ${report.passed} | Warnings: ${report.warnings} | Failed: ${report.failed}`
    );
    console.log(
      `Overall Health: ${
        report.overallStatus === 'PASS'
          ? '✅ HEALTHY'
          : report.overallStatus === 'WARN'
          ? '⚠️ WARNINGS'
          : '❌ CRITICAL_FAILURES'
      }`
    );
    console.log(`======================================================\n`);

    process.exit(report.overallStatus === 'FAIL' ? 1 : 0);
  } catch (err: any) {
    console.error('Fatal doctor execution error:', err);
    process.exit(1);
  } finally {
    if (!skipDb && pool) {
      await pool.end().catch(() => {});
    }
  }
}

main();
