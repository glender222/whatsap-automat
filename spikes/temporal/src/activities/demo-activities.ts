import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/activity';
import type {
  DemoEventInput,
  ValidationResult,
  FlakyOperationInput,
  FlakyOperationResult,
  BusinessEffectResult,
  CompletionResult,
} from '../interfaces.js';

// Registro en memoria para verificar idempotencia de efectos de negocio (§7.3 del Blueprint)
const appliedEffectKeys = new Map<string, number>();

/**
 * Actividad 1: Validación de carga entrante.
 * Revalida tenantId y parámetros sin persistir tokens sensibles en historial.
 */
export async function validateInboundPayload(
  event: DemoEventInput
): Promise<ValidationResult> {
  const info = Context.current().info;
  console.log(
    `[Activity:validateInboundPayload] Tenant: ${event.tenantId}, EventRef: ${event.eventRef}, ActivityId: ${info.activityId}`
  );

  if (!event.tenantId || event.tenantId.trim() === '') {
    throw ApplicationFailure.nonRetryable(
      'tenantId es obligatorio para procesar eventos',
      'INVALID_ARGUMENT_ERROR'
    );
  }

  if (!event.eventRef || event.eventRef.trim() === '') {
    throw ApplicationFailure.nonRetryable(
      'eventRef es obligatorio para procesar eventos',
      'INVALID_ARGUMENT_ERROR'
    );
  }

  return {
    valid: true,
    tenantId: event.tenantId,
    normalizedId: `norm:${event.tenantId}:${event.externalId}`,
    validatedAt: Date.now(),
  };
}

/**
 * Actividad 2: Operación con fallos transitorios simulados.
 * Demuestra la política de reintentos exponencial y la recuperación automática.
 */
export async function executeFlakyOperation(
  input: FlakyOperationInput
): Promise<FlakyOperationResult> {
  const currentAttempt = Context.current().info.attempt;
  console.log(
    `[Activity:executeFlakyOperation] Op: ${input.operationId}, Intento actual: ${currentAttempt}, Fallos requeridos: ${input.attemptFailureCount}`
  );

  if (input.nonRetryable) {
    throw ApplicationFailure.nonRetryable(
      `Error permanente y no reintentable en operación ${input.operationId}`,
      'PERMANENT_ERROR'
    );
  }

  if (currentAttempt <= input.attemptFailureCount) {
    const errorMsg = `Fallo transitorio simulado en intento ${currentAttempt}/${input.attemptFailureCount} para ${input.operationId}`;
    console.warn(`[Activity:executeFlakyOperation] ${errorMsg}`);
    throw ApplicationFailure.retryable(errorMsg, 'TRANSIENT_SERVICE_ERROR');
  }

  console.log(
    `[Activity:executeFlakyOperation] Éxito en intento ${currentAttempt} tras superar ${input.attemptFailureCount} fallos previos.`
  );

  return {
    attempts: currentAttempt,
    success: true,
    message: `Operación completada con éxito tras ${currentAttempt} intentos.`,
  };
}

/**
 * Actividad 3: Aplicación de efecto de negocio con clave de idempotencia (effectKey).
 * Cumple con §7.3 del Blueprint v0.4: Actividades obligatoriamente idempotentes.
 */
export async function executeBusinessEffect(
  tenantId: string,
  effectKey: string
): Promise<BusinessEffectResult> {
  const info = Context.current().info;
  console.log(
    `[Activity:executeBusinessEffect] Tenant: ${tenantId}, EffectKey: ${effectKey}, Attempt: ${info.attempt}`
  );

  if (appliedEffectKeys.has(effectKey)) {
    const originalTimestamp = appliedEffectKeys.get(effectKey)!;
    console.log(
      `[Activity:executeBusinessEffect] Idempotencia detectada: efecto previo aplicado en timestamp ${originalTimestamp}`
    );
    return {
      applied: true,
      effectKey,
      tenantId,
      executionTimestamp: originalTimestamp,
      cached: true,
    };
  }

  const now = Date.now();
  appliedEffectKeys.set(effectKey, now);

  return {
    applied: true,
    effectKey,
    tenantId,
    executionTimestamp: now,
    cached: false,
  };
}

/**
 * Actividad 4: Notificación de finalización.
 */
export async function notifyCompletion(
  eventRef: string,
  workflowId: string
): Promise<CompletionResult> {
  console.log(
    `[Activity:notifyCompletion] Workflow: ${workflowId}, EventRef: ${eventRef}`
  );

  return {
    notified: true,
    workflowId,
    eventRef,
    completedAt: Date.now(),
  };
}

/**
 * Actividad 5: Registro de auditoría.
 */
export async function recordAuditLog(
  tenantId: string,
  action: string,
  details: Record<string, unknown>
): Promise<{ logged: boolean }> {
  console.log(
    `[Activity:recordAuditLog] Tenant: ${tenantId}, Action: ${action}, Details:`,
    JSON.stringify(details)
  );
  return { logged: true };
}
