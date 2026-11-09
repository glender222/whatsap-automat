import { api } from '../../shared/axios/http';
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from '../../components/studio/types';

export const executionStatuses = WORKFLOW_RUN_STATUSES.filter((status) => status !== 'timed_out');
type ExecutionStatus = Exclude<WorkflowRunStatus, 'timed_out'>;
type DispatchStatus = 'pending' | 'processing' | 'dispatched' | 'completed' | 'failed' | 'delivery_unknown' | 'dead_letter';
type FailureCode = 'TEMPORAL_DISPATCH_UNCONFIRMED' | 'LOOP_LIMIT_EXCEEDED' | 'WORKFLOW_FAILED';

export interface ExecutionFilters {
  workflowId: string;
  status: ExecutionStatus | '';
}

interface Dispatch {
  status: DispatchStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowRunId: string;
  revisionId: string;
  triggerType: string;
  status: ExecutionStatus;
  recordedAt: string;
  completedAt: string | null;
  stepCount: number;
  failureCode: FailureCode | null;
  dispatchEvidence: 'recorded' | 'ambiguous' | 'missing';
  dispatch: Dispatch | null;
}

export interface ExecutionPage {
  items: ExecutionRecord[];
  nextCursor: string | null;
  pageSummary: { retryCount: number; deliveryUnknownCount: number };
}

const dispatchLabels: Record<DispatchStatus, string> = {
  pending: 'Pendiente de despacho',
  processing: 'Despacho en curso',
  dispatched: 'Despachado',
  completed: 'Despacho completado',
  failed: 'Despacho fallido',
  delivery_unknown: 'Despacho sin confirmar',
  dead_letter: 'Despacho cerrado con fallo',
};

export const failureLabels: Record<FailureCode, string> = {
  TEMPORAL_DISPATCH_UNCONFIRMED: 'El inicio en Temporal no se confirmó.',
  LOOP_LIMIT_EXCEEDED: 'El workflow alcanzó el límite de iteraciones.',
  WORKFLOW_FAILED: 'El workflow registró un fallo.',
};

export function dispatchLabel(item: ExecutionRecord) {
  if (item.dispatchEvidence === 'ambiguous') return 'Registros de despacho en conflicto';
  if (!item.dispatch) return 'Sin registro de despacho';
  return dispatchLabels[item.dispatch.status] ?? item.dispatch.status;
}

export function validWorkflowFilter(value: string) {
  return value === '' || /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

export async function listExecutions(filters: ExecutionFilters, cursor: string | null, signal: AbortSignal) {
  const { data } = await api.get<ExecutionPage>('/v1/operations/executions', {
    params: {
      limit: 20,
      workflowId: filters.workflowId || undefined,
      status: filters.status || undefined,
      cursor: cursor ?? undefined,
    },
    signal,
  });
  if (!Array.isArray(data?.items) || !(data.nextCursor === null ||
      (typeof data.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(data.nextCursor))) ||
      !data.pageSummary || !Number.isSafeInteger(data.pageSummary.retryCount) || data.pageSummary.retryCount < 0 ||
      !Number.isSafeInteger(data.pageSummary.deliveryUnknownCount) || data.pageSummary.deliveryUnknownCount < 0 ||
      data.pageSummary.deliveryUnknownCount > data.items.length ||
      data.items.some((item) => !item?.id || !item.workflowId || item.workflowRunId !== item.id ||
        !executionStatuses.includes(item.status) || (item.dispatchEvidence === 'recorded'
          ? !item.dispatch || !Object.hasOwn(dispatchLabels, item.dispatch.status)
          : item.dispatch !== null || !['ambiguous', 'missing'].includes(item.dispatchEvidence)))) {
    throw new Error('El servidor devolvió un listado de ejecuciones incompleto.');
  }
  return data;
}
