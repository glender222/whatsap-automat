import {
  defineQuery,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

export const getTimerStatusQuery = defineQuery<{
  status: 'PENDING' | 'SLEEPING' | 'COMPLETED';
  elapsedSoFar: number;
}>('getTimerStatus');

export interface TimerWorkflowInput {
  durationMs: number;
  label?: string;
}

export interface TimerWorkflowOutput {
  workflowId: string;
  runId: string;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  label: string;
}

/**
 * Workflow de demostración de temporizador duradero.
 * Valida que Temporal mantiene los timers en el servidor, no en memoria del trabajador.
 */
export async function timerDemoWorkflow(
  input: TimerWorkflowInput
): Promise<TimerWorkflowOutput> {
  const info = workflowInfo();
  const startedAt = Date.now();
  let status: 'PENDING' | 'SLEEPING' | 'COMPLETED' = 'PENDING';

  setHandler(getTimerStatusQuery, () => ({
    status,
    elapsedSoFar: Date.now() - startedAt,
  }));

  status = 'SLEEPING';
  await sleep(input.durationMs);
  status = 'COMPLETED';

  const finishedAt = Date.now();

  return {
    workflowId: info.workflowId,
    runId: info.runId,
    durationMs: input.durationMs,
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    label: input.label || 'default-timer',
  };
}
