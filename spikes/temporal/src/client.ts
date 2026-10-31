import { Connection, Client } from '@temporalio/client';
import { fileURLToPath } from 'node:url';
import {
  durabilityDemoWorkflow,
  getStateQuery,
  approvalSignal,
} from './workflows/demo-durability.workflow.js';
import { retryDemoWorkflow } from './workflows/demo-retry.workflow.js';
import { timerDemoWorkflow } from './workflows/demo-timer.workflow.js';
import type { DemoEventInput } from './interfaces.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'spike-task-queue';

export async function getTemporalClient(options?: {
  address?: string;
  namespace?: string;
}) {
  const connection = await Connection.connect({
    address: options?.address || TEMPORAL_ADDRESS,
  });

  const client = new Client({
    connection,
    namespace: options?.namespace || TEMPORAL_NAMESPACE,
  });

  return client;
}

export async function runDurabilityDemo(client: Client, customInput?: Partial<DemoEventInput>) {
  const workflowId = `durability-spike-${Date.now()}`;
  const input: DemoEventInput = {
    tenantId: 'tenant-demo-acme',
    eventRef: `msg_${Math.floor(Date.now() / 1000)}`,
    externalId: 'wa_demo_12345',
    delaySeconds: 4,
    ...customInput,
  };

  console.log(`\n==> [DEMO DURABILIDAD] Iniciando Workflow: ${workflowId}`);
  console.log(`    TenantId: ${input.tenantId}, EventRef: ${input.eventRef}, Timer: ${input.delaySeconds}s`);

  const handle = await client.workflow.start(durabilityDemoWorkflow, {
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId,
    args: [input],
  });

  console.log(`    Workflow iniciado con RunId: ${handle.firstExecutionRunId}`);

  // Consultar estado inicial
  await new Promise((r) => setTimeout(r, 1000));
  const initialState = await handle.query(getStateQuery);
  console.log(`    Estado actual: [${initialState.status}] - ${initialState.currentStep}`);

  if (input.requireApproval) {
    console.log('    Simulando espera de 2 segundos antes de enviar señal de aprobación...');
    await new Promise((r) => setTimeout(r, 2000));
    console.log('    Enviando Señal external: approveOrReject -> { approved: true, actor: "supervisor-1" }');
    await handle.signal(approvalSignal, {
      approved: true,
      actor: 'supervisor-1',
      reason: 'Aprobado en spike de demo',
    });
  }

  console.log('    Aguardando finalización del Workflow...');
  const result = await handle.result();
  console.log('    Workflow completado exitosamente:');
  console.log(`    - EffectKey: ${result.effectResult.effectKey} (cached: ${result.effectResult.cached})`);
  console.log(`    - Notified:  ${result.completionResult.notified}`);
  console.log('    - Historial de estados:');
  result.stateHistory.forEach((h) => console.log(`        * ${h}`));

  return result;
}

export async function runRetryDemo(client: Client, attemptFailureCount = 3) {
  const workflowId = `retry-spike-${Date.now()}`;
  console.log(`\n==> [DEMO REINTENTOS] Iniciando Workflow: ${workflowId}`);
  console.log(`    Simulando ${attemptFailureCount} fallos transitorios con backoff exponencial`);

  const handle = await client.workflow.start(retryDemoWorkflow, {
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId,
    args: [
      {
        operationId: `op-${Date.now()}`,
        attemptFailureCount,
      },
    ],
  });

  const result = await handle.result();
  console.log('    Workflow completado exitosamente tras reintentos:');
  console.log(`    - Intentos totales ejecutados: ${result.attemptsRequired}`);
  console.log(`    - Recuperado automáticamente:   ${result.recovered}`);
  console.log(`    - Mensaje:                     ${result.result.message}`);

  return result;
}

export async function runTimerDemo(client: Client, durationMs = 3000) {
  const workflowId = `timer-spike-${Date.now()}`;
  console.log(`\n==> [DEMO TEMPORIZADOR] Iniciando Workflow: ${workflowId}`);
  console.log(`    Duración programada: ${durationMs}ms`);

  const handle = await client.workflow.start(timerDemoWorkflow, {
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId,
    args: [{ durationMs, label: 'spike-timer-test' }],
  });

  const result = await handle.result();
  console.log('    Temporizador completado:');
  console.log(`    - Duración solicitada: ${result.durationMs}ms`);
  console.log(`    - Tiempo transcurrido: ${result.elapsedMs}ms`);

  return result;
}

async function runCli() {
  const mode = process.argv[2] || 'all';
  console.log('=====================================================');
  console.log('   Temporal OSS TypeScript Client (PR-07 Spike)     ');
  console.log('=====================================================');
  console.log(`- Conectando a Temporal Server: ${TEMPORAL_ADDRESS}`);
  console.log(`- Modo de ejecución:            ${mode}`);
  console.log('-----------------------------------------------------');

  const client = await getTemporalClient();

  if (mode === 'durability' || mode === 'all') {
    await runDurabilityDemo(client, { delaySeconds: 2 });
  }

  if (mode === 'approval' || mode === 'all') {
    await runDurabilityDemo(client, { delaySeconds: 1, requireApproval: true });
  }

  if (mode === 'retry' || mode === 'all') {
    await runRetryDemo(client, 3);
  }

  if (mode === 'timer' || mode === 'all') {
    await runTimerDemo(client, 2000);
  }

  console.log('\n=====================================================');
  console.log('   Todas las demostraciones solicitadas finalizaron  ');
  console.log('=====================================================');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((err) => {
    console.error('Error ejecutando cliente de demostración:', err);
    process.exit(1);
  });
}
