import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import * as activities from './activities/demo-activities.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'spike-task-queue';

export async function createSpikeWorker(options?: {
  taskQueue?: string;
  address?: string;
  namespace?: string;
  activitiesOverride?: Record<string, unknown>;
  connection?: NativeConnection;
}) {
  const address = options?.address || TEMPORAL_ADDRESS;
  const namespace = options?.namespace || TEMPORAL_NAMESPACE;
  const taskQueue = options?.taskQueue || TEMPORAL_TASK_QUEUE;

  const connection =
    options?.connection ||
    (await NativeConnection.connect({
      address,
    }));

  const tsWorkflowPath = fileURLToPath(
    new URL('./workflows/index.ts', import.meta.url)
  );
  const jsWorkflowPath = fileURLToPath(
    new URL('./workflows/index.js', import.meta.url)
  );
  const workflowsPath = fs.existsSync(tsWorkflowPath)
    ? tsWorkflowPath
    : jsWorkflowPath;

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    activities: options?.activitiesOverride || activities,
  });

  return worker;
}

async function runStandalone() {
  console.log('=====================================================');
  console.log('   Temporal OSS TypeScript Worker (PR-07 Spike)     ');
  console.log('=====================================================');
  console.log(`- Conectando a Temporal Server: ${TEMPORAL_ADDRESS}`);
  console.log(`- Namespace:                    ${TEMPORAL_NAMESPACE}`);
  console.log(`- Task Queue:                   ${TEMPORAL_TASK_QUEUE}`);
  console.log(`- PID:                          ${process.pid}`);
  console.log('-----------------------------------------------------');

  try {
    const worker = await createSpikeWorker();
    console.log('Worker inicializado correctamente. Escuchando tareas...');

    const shutdown = async (signal: string) => {
      console.log(`\nRecibida señal ${signal}. Iniciando apagado graceful del worker...`);
      worker.shutdown();
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    await worker.run();
    console.log('Worker detenido ordenadamente.');
  } catch (error) {
    console.error('Error fatal en ejecución del Worker:', error);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runStandalone();
}
