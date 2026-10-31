import { execSync } from 'node:child_process';

interface TestSummary {
  name: string;
  command: string;
  status: 'PASSED' | 'FAILED';
  durationMs: number;
  output?: string;
}

const suites = [
  {
    name: 'Temporizadores duraderos (Time Skipping)',
    command: 'node --import tsx --test src/tests/timer.test.ts',
  },
  {
    name: 'Reintentos exponenciales y fallos transitorios / permanentes',
    command: 'node --import tsx --test src/tests/retry-backoff.test.ts',
  },
  {
    name: 'Replay de historial de eventos y determinismo',
    command: 'node --import tsx --test src/tests/replay.test.ts',
  },
  {
    name: 'Durabilidad y recuperación ante muerte y reinicio de Worker',
    command: 'node --import tsx --test src/tests/durability.test.ts',
  },
];

async function main() {
  console.log('================================================================');
  console.log('   PR-07: TEMPORAL SPIKE — EJECUCIÓN AUTOMATIZADA DE PRUEBAS   ');
  console.log('================================================================');
  console.log(`Fecha/Hora: ${new Date().toISOString()}`);
  console.log('Entorno: Node.js / TypeScript / Temporal OSS SDK');
  console.log('----------------------------------------------------------------\n');

  const results: TestSummary[] = [];

  for (const suite of suites) {
    console.log(`▶ Ejecutando: ${suite.name}...`);
    const start = Date.now();
    try {
      execSync(suite.command, {
        cwd: process.cwd(),
        stdio: 'inherit',
      });
      const duration = Date.now() - start;
      results.push({
        name: suite.name,
        command: suite.command,
        status: 'PASSED',
        durationMs: duration,
      });
      console.log(`✔ [PASSED] en ${duration}ms\n`);
    } catch (err: unknown) {
      const duration = Date.now() - start;
      results.push({
        name: suite.name,
        command: suite.command,
        status: 'FAILED',
        durationMs: duration,
        output: String(err),
      });
      console.error(`✖ [FAILED] en ${duration}ms\n`);
    }
  }

  console.log('================================================================');
  console.log('                      RESUMEN DE PRUEBAS                        ');
  console.log('================================================================');
  let allPassed = true;
  for (const r of results) {
    const icon = r.status === 'PASSED' ? '✔' : '✖';
    console.log(`${icon} [${r.status}] ${r.name} (${r.durationMs}ms)`);
    if (r.status === 'FAILED') allPassed = false;
  }
  console.log('----------------------------------------------------------------');

  if (allPassed) {
    console.log('RESULTADO FINAL: TODAS LAS PRUEBAS DE PR-07 PASARON EXITOSAMENTE.');
    process.exit(0);
  } else {
    console.error('RESULTADO FINAL: SE ENCONTRARON FALLOS EN LA SUITE.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error fatal en runner de pruebas:', err);
  process.exit(1);
});
