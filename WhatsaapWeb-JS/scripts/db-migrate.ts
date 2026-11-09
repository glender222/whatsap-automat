import { Migrator } from '../src/db/Migrator';
import pool from '../src/config/database';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statusMode = args.includes('status');

  const migrator = new Migrator({ dryRun });

  try {
    if (statusMode) {
      await migrator.printStatus();
    } else {
      const result = await migrator.migrate();
      if (!dryRun) {
        console.log('\nMigrations completed:');
        console.log('  Applied:', result.applied.length ? result.applied.join(', ') : '(none)');
        console.log('  Skipped:', result.skipped.length ? result.skipped.join(', ') : '(none)');
      }
    }
  } catch (error) {
    console.error('❌ Error en migraciones:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
