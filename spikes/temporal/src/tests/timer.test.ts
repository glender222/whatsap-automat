import test from 'node:test';
import assert from 'node:assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  timerDemoWorkflow,
  getTimerStatusQuery,
} from '../workflows/demo-timer.workflow.js';

test('Timer Suite: Temporizador duradero con avance de tiempo (Time Skipping)', async () => {
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
      taskQueue: 'test-timer-queue',
      workflowsPath,
    });

    await worker.runUntil(async () => {
      const workflowId = `test-timer-${Date.now()}`;
      const handle = await testEnv.client.workflow.start(timerDemoWorkflow, {
        taskQueue: 'test-timer-queue',
        workflowId,
        args: [{ durationMs: 60000, label: 'durable-timer-60s' }],
      });

      // El test environment time-skipping salta los 60 segundos automáticamente sin esperar tiempo real
      const result = await handle.result();

      assert.strictEqual(result.workflowId, workflowId);
      assert.strictEqual(result.durationMs, 60000);
      assert.strictEqual(result.label, 'durable-timer-60s');
      assert.ok(result.finishedAt >= result.startedAt);
      console.log('✔ Temporizador duradero completado exitosamente con time-skipping.');
    });
  } finally {
    await testEnv.teardown();
  }
});
