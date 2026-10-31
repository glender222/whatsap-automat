import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities/demo-activities.js';
import type {
  DemoEventInput,
  WorkflowState,
  ApprovalSignalInput,
  BusinessEffectResult,
  CompletionResult,
} from '../interfaces.js';

// Actividades con reintentos configurados y timeouts según Blueprint v0.4
const {
  validateInboundPayload,
  executeBusinessEffect,
  notifyCompletion,
  recordAuditLog,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['INVALID_ARGUMENT_ERROR', 'PERMANENT_ERROR'],
  },
});

// Definición de Señales y Consultas para inspección y control de estado en vivo
export const getStateQuery = defineQuery<WorkflowState>('getState');
export const approvalSignal = defineSignal<[ApprovalSignalInput]>('approveOrReject');

export interface DurabilityWorkflowOutput {
  workflowId: string;
  runId: string;
  tenantId: string;
  eventRef: string;
  effectResult: BusinessEffectResult;
  completionResult: CompletionResult;
  stateHistory: string[];
}

/**
 * Workflow de durabilidad:
 * 1. Valida carga entrante revalidando tenantId.
 * 2. Registra auditoría inicial.
 * 3. Ejecuta temporizador duradero (sleep).
 * 4. Si se requiere aprobación humana, espera señal con timeout.
 * 5. Aplica efecto de negocio con effectKey idempotente.
 * 6. Emite notificación de finalización.
 */
export async function durabilityDemoWorkflow(
  input: DemoEventInput
): Promise<DurabilityWorkflowOutput> {
  const info = workflowInfo();
  const stateHistory: string[] = [];

  let state: WorkflowState = {
    status: 'INITIALIZED',
    currentStep: 'Iniciando workflow',
    tenantId: input.tenantId,
    eventRef: input.eventRef,
    updatedAt: Date.now(),
  };

  const updateState = (status: WorkflowState['status'], step: string) => {
    state = {
      ...state,
      status,
      currentStep: step,
      updatedAt: Date.now(),
    };
    stateHistory.push(`${new Date().toISOString()} [${status}] ${step}`);
  };

  // Registro del handler de consulta
  setHandler(getStateQuery, () => state);

  // Registro del handler de señal
  let approvalReceived = false;
  let approvalData: ApprovalSignalInput | undefined;

  setHandler(approvalSignal, (sig: ApprovalSignalInput) => {
    approvalReceived = true;
    approvalData = sig;
    state.approvalReceived = true;
    state.approvedBy = sig.actor;
    updateState('WAITING_APPROVAL', `Señal recibida de ${sig.actor}: aprobado=${sig.approved}`);
  });

  // Paso 1: Validación de entrada
  updateState('INITIALIZED', 'Validando inbound payload');
  const validation = await validateInboundPayload(input);
  updateState('VALIDATED', `Payload validado exitosamente para tenant ${validation.tenantId}`);

  // Auditoría inicial
  await recordAuditLog(input.tenantId, 'WORKFLOW_STARTED', {
    workflowId: info.workflowId,
    eventRef: input.eventRef,
  });

  // Paso 2: Temporizador duradero (sleep)
  // Durante este temporizador, el trabajador puede morir y ser reiniciado sin perder el estado
  const delayMs = input.delaySeconds ? input.delaySeconds * 1000 : 3000;
  updateState('WAITING_TIMER', `Esperando temporizador duradero de ${delayMs}ms`);
  await sleep(delayMs);
  updateState('WAITING_TIMER', 'Temporizador duradero finalizado con éxito');

  // Paso 3: Espera condicional de aprobación si se solicita
  if (input.requireApproval) {
    updateState('WAITING_APPROVAL', 'Esperando señal externa de aprobación');
    const signalArrived = await condition(() => approvalReceived, '30s');
    if (!signalArrived || !approvalData?.approved) {
      updateState('FAILED', 'Workflow cancelado o tiempo de aprobación expirado');
      throw new Error('Aprobación no recibida o rechazada');
    }
  }

  // Paso 4: Efecto de negocio idempotente
  const effectKey = `effect:${input.tenantId}:${input.eventRef}`;
  state.effectKey = effectKey;
  updateState('APPLYING_EFFECT', `Aplicando efecto de negocio con effectKey: ${effectKey}`);
  const effectResult = await executeBusinessEffect(input.tenantId, effectKey);

  // Paso 5: Notificación y cierre
  updateState('COMPLETED', 'Completando workflow y notificando');
  const completionResult = await notifyCompletion(input.eventRef, info.workflowId);

  await recordAuditLog(input.tenantId, 'WORKFLOW_COMPLETED', {
    workflowId: info.workflowId,
    effectKey,
  });

  return {
    workflowId: info.workflowId,
    runId: info.runId,
    tenantId: input.tenantId,
    eventRef: input.eventRef,
    effectResult,
    completionResult,
    stateHistory,
  };
}
