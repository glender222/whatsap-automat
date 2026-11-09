import { isAxiosError } from 'axios';
import { api } from '../../shared/axios/http';

export const workflowPath = '/dashboard/workflows';
export const workflowPageSize = 20;

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  publishedRevisionId: string | null;
  updatedAt: string;
}

export interface RevisionSummary {
  id: string;
  revisionNumber: number;
  status: 'draft' | 'published' | 'archived';
  createdAt: string;
}

export interface WorkflowRunSummary {
  id: string;
  revisionId: string;
  revisionNumber: number;
  status: string;
  currentStep: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface WorkflowRun extends Omit<WorkflowRunSummary, 'revisionNumber'> {
  workflowId: string;
  temporalRunId: string | null;
  correlationId: string;
  stepCount: number;
  errorDetails?: { code?: string } | null;
}

export interface WorkflowWebhook {
  id: string;
  endpointKey: string;
  isActive: boolean;
  createdAt: string;
}

export interface WorkflowDetail {
  workflow: WorkflowSummary;
  revisions: RevisionSummary[];
  runs: WorkflowRunSummary[];
  webhooks?: WorkflowWebhook[];
}

export interface WorkflowSpec {
  dagGraph: unknown;
  limits?: unknown;
}

interface RevisionDefinition extends WorkflowSpec {
  id: string;
  revisionNumber: number;
  specHash: string;
}

interface ApiResponse<T> { success: boolean; data: T }

const endpoint = '/v1/workflows';
const workflowEndpoint = (id: string) => `${endpoint}/${encodeURIComponent(id)}`;
const stateLabels: Record<string, string> = {
  draft: 'Borrador', published: 'Publicada', archived: 'Archivada',
  queued: 'En cola', running: 'En ejecución', waiting_timer: 'Esperando temporizador',
  waiting_approval: 'Esperando aprobación', completed: 'Completada', failed: 'Fallida', cancelled: 'Cancelada',
};

function result<T>(response: ApiResponse<T>): T {
  if (response?.success !== true || response.data == null) throw new Error('El servidor devolvió una respuesta incompleta.');
  return response.data;
}

export function workflowStatus(status: string) {
  return stateLabels[status] ?? status;
}

export function workflowDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin fecha';
}

export function workflowError(cause: unknown, fallback: string) {
  if (isAxiosError(cause)) {
    const { status, data } = cause.response ?? {};
    if (status === 400 && typeof data?.detail === 'string' && data.detail.length <= 250) return data.detail;
    if (status === 403) return 'Tu sesión no tiene permisos para esta operación.';
    if (status === 404) return 'El recurso no está disponible en esta empresa.';
    if (status === 409) return 'El estado del workflow cambió. Actualiza la ficha antes de continuar.';
    return fallback;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export async function listWorkflows(offset: number, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<{ items: WorkflowSummary[]; hasMore: boolean }>>(
    endpoint, { params: { offset, limit: workflowPageSize }, signal },
  );
  const page = result(data);
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new Error('El listado de workflows está incompleto.');
  return page;
}

export async function getWorkflow(id: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<WorkflowDetail>>(workflowEndpoint(id), { signal });
  const detail = result(data);
  if (detail.workflow?.id !== id || !Array.isArray(detail.revisions) || !Array.isArray(detail.runs) ||
      (detail.webhooks !== undefined && !Array.isArray(detail.webhooks))) throw new Error('La ficha del workflow está incompleta.');
  return detail;
}

export async function getWorkflowRevision(id: string, revisionId: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<RevisionDefinition>>(
    `${workflowEndpoint(id)}/revisions/${encodeURIComponent(revisionId)}`, { signal },
  );
  const revision = result(data);
  if (revision.id !== revisionId || revision.dagGraph == null) throw new Error('El servidor no confirmó la revisión.');
  return revision;
}

export async function validateWorkflow(spec: WorkflowSpec) {
  const { data } = await api.post<ApiResponse<{ nodeCount: number; edgeCount: number }>>(`${endpoint}/validate`, spec);
  const validation = result(data);
  if (!Number.isSafeInteger(validation.nodeCount) || validation.nodeCount < 1 ||
      !Number.isSafeInteger(validation.edgeCount) || validation.edgeCount < 0) throw new Error('El servidor no confirmó la validación.');
  return validation;
}

export async function saveWorkflow(spec: WorkflowSpec, input: { name: string; description?: string } | { id: string }) {
  if ('id' in input) {
    const { data } = await api.post<ApiResponse<{ workflowId: string; id: string; status: string }>>(
      `${workflowEndpoint(input.id)}/revisions`, spec,
    );
    const draft = result(data);
    if (draft.workflowId !== input.id || !draft.id || draft.status !== 'draft') throw new Error('El servidor no confirmó el borrador.');
    return draft.workflowId;
  }
  const { data } = await api.post<ApiResponse<{ workflowId: string; status: string; revision: { id: string } }>>(
    endpoint, { ...input, ...spec },
  );
  const draft = result(data);
  if (!draft.workflowId || !draft.revision?.id || draft.status !== 'draft') throw new Error('El servidor no confirmó el borrador.');
  return draft.workflowId;
}

export async function publishWorkflow(id: string, revisionId: string) {
  const { data } = await api.post<ApiResponse<{ workflowId: string; publishedRevisionId: string; status: string }>>(
    `${workflowEndpoint(id)}/publish`, { revisionId },
  );
  const item = result(data);
  if (item.workflowId !== id || item.publishedRevisionId !== revisionId || item.status !== 'published') {
    throw new Error('El servidor no confirmó qué revisión se publicó.');
  }
}

export async function createWorkflowWebhook(id: string) {
  const { data } = await api.post<ApiResponse<{ id: string; workflowId: string; endpointKey: string; token: string }>>(
    `${workflowEndpoint(id)}/triggers/webhook`,
  );
  const item = result(data);
  if (item.workflowId !== id || !item.id || !item.endpointKey || !item.token) throw new Error('El servidor no confirmó el webhook.');
  return item;
}

export function webhookUrl(endpointKey: string) {
  const base = new URL(api.defaults.baseURL ?? '/api', window.location.origin);
  return new URL(`${base.pathname.replace(/\/$/, '')}${endpoint}/triggers/webhook/${encodeURIComponent(endpointKey)}`, base.origin).href;
}

export async function disableWorkflowWebhook(id: string, triggerId: string) {
  const { data } = await api.patch<ApiResponse<{ id: string; workflowId: string; isActive: boolean }>>(
    `${workflowEndpoint(id)}/triggers/${encodeURIComponent(triggerId)}`, { isActive: false },
  );
  const item = result(data);
  if (item.id !== triggerId || item.workflowId !== id || item.isActive !== false) throw new Error('El servidor no confirmó la desactivación.');
}

export async function getWorkflowRun(id: string, signal: AbortSignal) {
  const { data } = await api.get<ApiResponse<WorkflowRun>>(`${endpoint}/runs/${encodeURIComponent(id)}`, { signal });
  const run = result(data);
  if (run.id !== id || !run.revisionId || !run.status || !Number.isSafeInteger(run.stepCount)) {
    throw new Error('El servidor no confirmó la ejecución.');
  }
  return run;
}
