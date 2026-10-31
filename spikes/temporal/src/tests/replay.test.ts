import test from 'node:test';
import assert from 'node:assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import * as activities from '../activities/demo-activities.js';
import { durabilityDemoWorkflow } from '../workflows/demo-durability.workflow.js';

test('Replay Suite: Determinismo e inmutabilidad de historia de ejecución', async () => {
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping();

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

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-replay-queue',
      workflowsPath,
      activities,
    });

    const workflowId = `test-replay-${Date.now()}`;

    // 1. Ejecutar workflow hasta su finalización
    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(durabilityDemoWorkflow, {
        taskQueue: 'test-replay-queue',
        workflowId,
        args: [
          {
            tenantId: 'replay-tenant-01',
            eventRef: 'evt-replay-test-123',
            externalId: 'ext-replay-456',
            delaySeconds: 1,
          },
        ],
      });

      const result = await handle.result();
      assert.strictEqual(result.tenantId, 'replay-tenant-01');
      assert.strictEqual(result.completionResult.notified, true);
    });

    // 2. Extraer historial completo de eventos del workflow
    console.log(`Descargando historial de eventos del workflow ${workflowId}...`);
    const handle = testEnv.client.workflow.getHandle(workflowId);
    const history = await handle.fetchHistory();
    assert.ok(history, 'El historial debe existir');
    assert.ok(history.events && history.events.length > 0, 'El historial debe contener eventos registrados');

    console.log(`Historial obtenido con ${history.events?.length} eventos.`);

    // 3. Ejecutar Replay contra la definición del workflow
    // Demuestra que el código es 100% determinista y respeta las reglas de Temporal
    console.log('Ejecutando Replay contra la definición del workflow...');
    await Worker.runReplayHistory(
      {
        workflowsPath,
      },
      history,
      workflowId
    );

    console.log('✔ Replay validado exitosamente: no se detectaron violaciones de determinismo.');
  } finally {
    await testEnv.teardown();
  }
});
