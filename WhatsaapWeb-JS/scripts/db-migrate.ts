import { Migrator } from '../src/db/Migrator';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statusMode = args.includes('status');

  const migrator = new Migrator({ dryRun });

  try {
    if (!dryRun) {
      await migrator.init();
    }

    if (statusMode) {
      await migrator.printStatus();
    } else {
      const result = await migrator.migrate();
      console.log('\nMigrations completed:');
      console.log('  Applied:', result.applied.length ? result.applied.join(', ') : '(none)');
      console.log('  Skipped:', result.skipped.length ? result.skipped.join(', ') : '(none)');
    }
  } catch (err: any) {
    const isConnectionError =
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ETIMEDOUT' ||
      err?.message?.toLowerCase().includes('connection');

    if (isConnectionError) {
      console.warn('⚠️  PostgreSQL no disponible. Saltando migraciones (graceful exit).');
      process.exit(0);
    }

    console.error('❌ Error en migraciones:', err);
    process.exit(1);
  }
}

main();
