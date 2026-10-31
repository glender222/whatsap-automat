import test from 'node:test';
import assert from 'node:assert';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import * as activities from '../activities/demo-activities.js';
import { retryDemoWorkflow } from '../workflows/demo-retry.workflow.js';

test('Retry Suite: Recuperación automática ante fallos transitorios con backoff', async () => {
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
      taskQueue: 'test-retry-queue',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      // Caso 1: 3 fallos transitorios antes de éxito (intento 4 tiene éxito)
      const handle = await testEnv.client.workflow.start(retryDemoWorkflow, {
        taskQueue: 'test-retry-queue',
        workflowId: `test-retry-transient-${Date.now()}`,
        args: [
          {
            operationId: 'op-transient-test',
            attemptFailureCount: 3,
          },
        ],
      });

      const result = await handle.result();
      assert.strictEqual(result.attemptsRequired, 4);
      assert.strictEqual(result.recovered, true);
      assert.strictEqual(result.result.success, true);
      console.log(`✔ Reintento exitoso: la actividad se reintentó ${result.attemptsRequired} veces hasta completar.`);
    });
  } finally {
    await testEnv.teardown();
  }
});

test('Retry Suite: Error permanente no reintentable (fail-fast)', async () => {
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
      taskQueue: 'test-retry-queue',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(retryDemoWorkflow, {
        taskQueue: 'test-retry-queue',
        workflowId: `test-retry-permanent-${Date.now()}`,
        args: [
          {
            operationId: 'op-permanent-test',
            attemptFailureCount: 3,
            nonRetryable: true,
          },
        ],
      });

      await assert.rejects(
        async () => {
          await handle.result();
        },
        (err: Error) => {
          assert.ok(err instanceof WorkflowFailedError);
          console.log(`✔ Error permanente abortó inmediatamente sin reintentos ciegos: ${err.message}`);
          return true;
        }
      );
    });
  } finally {
    await testEnv.teardown();
  }
});
