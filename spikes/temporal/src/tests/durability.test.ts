import test from 'node:test';
import assert from 'node:assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import * as activities from '../activities/demo-activities.js';
import {
  durabilityDemoWorkflow,
  getStateQuery,
} from '../workflows/demo-durability.workflow.js';

test('Durability Suite: Recuperación completa tras caída y reinicio de Worker', async () => {
  // Inicializar servidor de pruebas local sin saltos de tiempo artificiales
  // para verificar la durabilidad física en tiempo real frente a muerte de procesos
  const testEnv = await TestWorkflowEnvironment.createLocal();

  try {
    const tsWorkflowPath = fileURLToPath(
      new URL('../workflows/index.ts', import.meta.url)
    );
    const jsWorkflowPath = fileURLToPath(
      new URL('../workflows/index.js', import.meta.url)
    );
    const workflowsPath = fs.existsSync(tsWorkflowPath)
      ? tsWorkflowPath
      : jsWorkflowPath;

    const taskQueue = `test-durability-recovery-${Date.now()}`;
    const workflowId = `durability-kill-restart-${Date.now()}`;

    // 1. Iniciar TRABAJADOR 1
    console.log('\n--- PASO 1: Iniciando Trabajador 1 ---');
    const worker1 = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });

    const worker1Promise = worker1.run();
    console.log('Trabajador 1 en ejecución. Despachando workflow...');

    // 2. Iniciar el workflow con un temporizador duradero de 2 segundos
    const handle = await testEnv.client.workflow.start(durabilityDemoWorkflow, {
      taskQueue,
      workflowId,
      args: [
        {
          tenantId: 'tenant-durability-spike',
          eventRef: 'msg-restart-test-001',
          externalId: 'ext-wa-999',
          delaySeconds: 2,
        },
      ],
    });

    console.log(`Workflow iniciado: ${workflowId}, RunId: ${handle.firstExecutionRunId}`);

    // Esperar a que el workflow avance hasta el estado de temporizador duradero
    let state = await handle.query(getStateQuery);
    let attempts = 0;
    while (state.status !== 'WAITING_TIMER' && attempts < 20) {
      await new Promise((r) => setTimeout(r, 150));
      state = await handle.query(getStateQuery);
      attempts++;
    }

    console.log(`Estado antes de matar Trabajador 1: [${state.status}] - ${state.currentStep}`);
    assert.strictEqual(state.status, 'WAITING_TIMER');

    // 3. Simular caída abrupta del Trabajador 1
    console.log('\n--- PASO 2: Matando Trabajador 1 (Simulación de caída de pod/servidor) ---');
    worker1.shutdown();
    await worker1Promise;
    console.log('Trabajador 1 DETENIDO. 0 workers activos en taskQueue.');

    // 4. Verificar que el Workflow sigue RUNNING en el servidor de Temporal
    const description = await handle.describe();
    console.log(`Estado del workflow en Temporal Server sin workers: ${description.status.name}`);
    assert.strictEqual(description.status.name, 'RUNNING');

    // Simular periodo de inactividad mientras la infraestructura provisiona un nuevo trabajador
    console.log('Esperando 1 segundo con 0 workers activos...');
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Iniciar TRABAJADOR 2 en la misma taskQueue
    console.log('\n--- PASO 3: Iniciando Trabajador 2 (Worker de reemplazo / recuperación) ---');
    const worker2 = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });

    // 6. El Trabajador 2 debe recuperar la ejecución del workflow sin pérdida de estado
    await worker2.runUntil(async () => {
      console.log('Trabajador 2 conectado. Esperando resolución del workflow...');
      const result = await handle.result();

      console.log('\n--- PASO 4: Verificación de resultados tras reinicio de Trabajador ---');
      console.log(`✔ Workflow ID:           ${result.workflowId}`);
      console.log(`✔ Tenant ID:             ${result.tenantId}`);
      console.log(`✔ EffectKey aplicado:    ${result.effectResult.effectKey}`);
      console.log(`✔ Notificación emitida:  ${result.completionResult.notified}`);
      console.log('✔ Historial preservado a través de la muerte del worker:');
      result.stateHistory.forEach((h) => console.log(`    * ${h}`));

      assert.strictEqual(result.workflowId, workflowId);
      assert.strictEqual(result.tenantId, 'tenant-durability-spike');
      assert.strictEqual(result.effectResult.applied, true);
      assert.strictEqual(result.completionResult.notified, true);
      assert.ok(result.stateHistory.length >= 5);
    });

    console.log('\n✔ PRUEBA DE DURABILIDAD Y RECUPERACIÓN TRAS REINICIO DE TRABAJADOR SUPERADA CON ÉXITO.');
  } finally {
    await testEnv.teardown();
  }
});
