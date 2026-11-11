import { readSession } from '../../../shared/auth/session';
import { isAxiosError } from 'axios';
import { api, type AuthRequestConfig } from '../../../shared/axios/http';

export const approvalsPath = '/dashboard/aprobaciones';
export const approvalPageSize = 20;
const endpoint = '/v1/approvals';
export const approvalIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export const riskLabels = {
  low: 'Bajo', medium: 'Medio', high: 'Alto', read: 'Lectura', write: 'Cambio interno',
  send: 'Envío', financial: 'Financiero', destructive: 'Irreversible',
} as const;
export const approvalStatuses = {
  pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada', expired: 'Vencida', revoked: 'Revocada',
} as const;
export type Risk = keyof typeof riskLabels;
export type Decision = 'approved' | 'rejected';

export interface Approval {
  id: string;
  tenantId: string;
  runId: string;
  nodeId: string;
  policyVersion: number;
  risk: Risk;
  status: keyof typeof approvalStatuses;
  expiresAt: string;
  createdAt: string;
  decidedAt?: string;
  executionBlocker?: 'APPROVAL_EFFECT_CONFLICT';
  details?: { toolName: string; summary: string; parametersRedacted: Record<string, unknown> };
}

export interface ApprovalWorkspace {
  tenantId: string;
  workspaceName: string;
  capabilities: string[];
}

export interface DecisionIntent {
  approvalId: string;
  decision: Decision;
  expectedVersion: number;
  key: string;
  reason?: string;
}

export function isSensitiveApproval(risk: Risk) {
  return ['high', 'send', 'financial', 'destructive'].includes(risk);
}

export function currentApprovalSession() {
  const session = readSession();
  return session.accessToken || session.refreshToken ? String(session.generation) : null;
}

export function approvalDate(date: string) {
  return new Date(date).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isApproval(value: Approval, tenantId: string) {
  return value && typeof value.id === 'string' && approvalIdPattern.test(value.id) && value.tenantId === tenantId &&
    typeof value.runId === 'string' && typeof value.nodeId === 'string' &&
    Number.isSafeInteger(value.policyVersion) && value.policyVersion > 0 &&
    Object.hasOwn(riskLabels, value.risk) && Object.hasOwn(approvalStatuses, value.status) &&
    (value.executionBlocker === undefined || value.executionBlocker === 'APPROVAL_EFFECT_CONFLICT') &&
    isDate(value.createdAt) && isDate(value.expiresAt) && (value.decidedAt === undefined || isDate(value.decidedAt)) &&
    (!value.details || (typeof value.details.toolName === 'string' && typeof value.details.summary === 'string' &&
      value.details.parametersRedacted && typeof value.details.parametersRedacted === 'object' &&
      !Array.isArray(value.details.parametersRedacted)));
}

export function approvalHttpStatus(error: unknown) {
  return isAxiosError(error) ? error.response?.status : undefined;
}

export function approvalProblem(error: unknown, fallback: string) {
  const reason = isAxiosError(error) ? error.response?.data?.metadata?.reason : undefined;
  if (reason === 'APPROVAL_EFFECT_CONFLICT') return 'Revisa las solicitudes duplicadas y el resultado de la acción antes de crear otra propuesta. Puedes rechazar esta solicitud para cerrar su revisión.';
  if (reason === 'APPROVAL_REAUTH_REQUIRED') return 'Ingresa tu contraseña actual para registrar la decisión.';
  if (reason === 'APPROVAL_REAUTH_INVALID') return 'No pudimos verificar tu contraseña. Revísala e inténtalo de nuevo.';
  if (reason === 'APPROVAL_REAUTH_LIMITED') return 'Se alcanzó el límite de intentos. Espera unos minutos antes de continuar.';
  switch (approvalHttpStatus(error)) {
    case 401: return 'Vuelve a introducir tu contraseña si la sesión sigue activa.';
    case 403: return 'Tu espacio de trabajo no tiene permiso para revisar aprobaciones.';
    case 404: return 'La solicitud ya no está disponible en esta empresa.';
    case 409: return 'La solicitud cambió o ya fue decidida. Revisa el estado actualizado antes de continuar.';
    case 410: return 'La solicitud venció antes de registrar la decisión.';
    default: return fallback;
  }
}

export async function readApprovalWorkspace(signal: AbortSignal) {
  const { data } = await api.get<ApprovalWorkspace>('/v1/workspaces/current', { signal });
  if (typeof data?.tenantId !== 'string' || typeof data.workspaceName !== 'string' ||
      !Array.isArray(data.capabilities)) throw new Error('El servidor no confirmó tu espacio de trabajo.');
  return data;
}

export async function listApprovals(tenantId: string, offset: number, risk: Risk | '', signal: AbortSignal) {
  const { data } = await api.get<Approval[]>(endpoint, {
    params: { status: 'pending', offset, limit: approvalPageSize, risk: risk || undefined }, signal,
  });
  if (!Array.isArray(data) || !data.every((item) => isApproval(item, tenantId) && item.status === 'pending')) {
    throw new Error('El servidor no confirmó la cola de aprobaciones.');
  }
  return data;
}

export async function readApproval(id: string, tenantId: string, signal: AbortSignal) {
  const { data } = await api.get<Approval>(`${endpoint}/${encodeURIComponent(id)}`, { signal });
  if (!isApproval(data, tenantId) || data.id !== id) throw new Error('El servidor no confirmó esta solicitud.');
  return data;
}

export async function decideApproval(intent: DecisionIntent, session: string, password?: string) {
  if (currentApprovalSession() !== session) throw new Error('La sesión cambió. Vuelve a abrir esta solicitud.');
  if (password !== undefined) {
    const origin = typeof window === 'undefined' ? undefined : window.location.href;
    const target = new URL(api.defaults.baseURL || '/', origin);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
      throw new Error('La verificación de contraseña requiere una conexión HTTPS.');
    }
  }
  const config: AuthRequestConfig = {
    headers: { 'Idempotency-Key': intent.key },
    replayOnAuthRenewal: password === undefined,
    sessionGeneration: Number(session),
  };
  const { data } = await api.post<{ approvalId: string; status: Decision; decidedAt: string }>(
    `${endpoint}/${encodeURIComponent(intent.approvalId)}/decision`,
    { decision: intent.decision, expectedVersion: intent.expectedVersion, reason: intent.reason, password },
    config,
  );
  if (data?.approvalId !== intent.approvalId || data.status !== intent.decision || !isDate(data.decidedAt)) {
    throw new Error('El servidor no confirmó la decisión solicitada.');
  }
  return data;
}
