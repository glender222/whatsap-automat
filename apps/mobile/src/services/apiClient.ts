import { authStorage, type AuthSession, type AuthSessionSnapshot } from './authStorage';
import {
  downloadMimeType, isAttachmentId, isMatchingImage, isPreviewImage, MAX_ATTACHMENT_BYTES, parseAttachments,
  type AttachmentBytes, type MobileAttachment,
} from './attachmentData';
import type { OutboundAttachment } from './outboundAttachment';
import { uploadBlob } from './uploadBlob';

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

interface LoginData {
  accessToken: string;
  refreshToken?: string;
  user: { id: string | number; companyId: string | number };
}

export interface MobileChatOwnership {
  conversationId?: number | string | null;
  stateVersion?: number | null;
  assignedUserId?: number | string | null;
  aiPaused?: boolean | null;
}

export interface MobileConversation extends MobileChatOwnership {
  id: string;
  name?: string | null;
  lastMessageTimestamp?: number;
  lastMessagePreview?: string | null;
  unreadCount?: number;
  serviceWindowExpiresAt?: string | null;
}

export interface MobileMessage {
  id: string;
  body: string | null;
  fromMe: boolean;
  timestamp: number;
  type?: string;
  status?: string;
  clientRequestId?: string | null;
  attachments?: MobileAttachment[];
}

interface ConversationMessagePage {
  items: {
    id: string;
    body: string | null;
    direction: 'inbound' | 'outbound';
    deliveryState: string;
    clientRequestId: string | null;
    channel?: string;
    causedBy: { type: string };
    attachments: unknown[];
    createdAt: string;
  }[];
  nextCursor: string | null;
}

export interface MobileTextCommand {
  conversationId: number | string;
  expectedVersion: number;
  key: string;
  text: string;
}

export interface MobileAttachmentCommand extends MobileTextCommand {
  attachment: OutboundAttachment;
}

export type MobileSendCommand = MobileTextCommand | MobileAttachmentCommand;

export type MobileSendOutcome = 'accepted' | 'failed' | 'unknown_delivery';

export interface MobileApproval {
  id: string;
  policyVersion: number;
  risk: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
  details?: {
    toolName: string;
    summary: string;
    parametersRedacted: Record<string, unknown>;
  };
}

export type MobileApprovalDecision = 'approved' | 'rejected';

export interface MobileApprovalCommand {
  approvalId: string;
  decision: MobileApprovalDecision;
  expectedVersion: number;
  key: string;
  reason?: string;
}

export const APPROVAL_PAGE_SIZE = 50;

interface TakeoverResult {
  conversationId: string;
  newVersion: number;
  ownerId: string | null;
  aiPaused: boolean;
}

interface ChatSessionStatus extends MobileChatOwnership {
  hasActiveSession: boolean;
  hasUnresolvedDelivery?: boolean;
}

export class MobileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly metadata?: { currentVersion?: unknown; ownerId?: unknown; ownerType?: unknown; reasonCode?: unknown; reason?: unknown },
    public readonly accessTokenExpired = false,
    public readonly code?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'MobileApiError';
  }
}

export function normalizeServerUrl(input: string, allowLocalHttp = false): string {
  const match = /^(https?):\/\/([a-z\d.-]+|\[[a-f\d:]+\])(?::(\d{1,5}))?(?:\/api(?:\/v1)?)?\/*$/i.exec(input.trim());
  if (!match) throw new Error('Ingresa la dirección del servidor, por ejemplo https://automat.ejemplo.com.');
  const [, rawProtocol, rawHost, port] = match;
  const protocol = rawProtocol.toLowerCase();
  const host = rawHost.toLowerCase();
  const localHost = host === 'localhost' || host === '[::1]'
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+(?:\.\d+)*$/.test(host);
  if (protocol === 'http' && !(allowLocalHttp && localHost)) {
    throw new Error('Usa HTTPS para proteger tu inicio de sesión.');
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('El puerto del servidor debe estar entre 1 y 65535.');
  }
  return `${protocol}://${host}${port ? `:${port}` : ''}`;
}

let onUnauthorized: (() => void) | undefined;

export function handleUnauthorized(callback: () => void): () => void {
  onUnauthorized = callback;
  return () => { if (onUnauthorized === callback) onUnauthorized = undefined; };
}

type ResponseFormat = 'envelope' | 'legacy-status' | 'canonical';

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

async function request<T>(
  origin: string, path: string, init: RequestInit = {}, accessToken?: string, format: ResponseFormat = 'envelope',
  read?: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json, application/problem+json');
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, init.body instanceof FormData ? 120_000 : read ? 30_000 : 15_000);
  try {
    const response = await fetch(`${origin}/api${path}`, { ...init, headers, signal: controller.signal });
    if (response.ok && read) return await read(response);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || (format !== 'canonical' && body.success !== true)) {
      const message = body?.userMessage ?? body?.detail ?? body?.message ?? body?.error;
      throw new MobileApiError(
        response.status,
        typeof message === 'string' ? message : `El servidor no pudo completar la solicitud (${response.status}).`,
        body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
        response.status === 401 && (body?.code === 'ACCESS_TOKEN_EXPIRED' ||
          (body?.success === false && body?.error === 'Token invalido o expirado' && body?.details === 'jwt expired')),
        typeof body?.code === 'string' ? body.code : undefined,
        response.status === 429 ? retryAfterSeconds(response.headers.get('Retry-After')) : undefined,
      );
    }
    return format === 'envelope' ? (body as ApiEnvelope<T>).data : body as T;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

async function readAttachment(response: Response): Promise<AttachmentBytes> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new MobileApiError(502, 'El servidor no devolvió el archivo completo.');
  }
  const length = response.headers.get('Content-Length');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (length !== null && Number(length) > MAX_ATTACHMENT_BYTES) throw new MobileApiError(413, 'El archivo supera el límite de 10 MB.');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw new MobileApiError(413, 'El archivo supera el límite de 10 MB.');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new MobileApiError(502, 'El archivo está vacío.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mimeType = downloadMimeType(response.headers.get('Content-Type'));
  const imageMismatch = isPreviewImage(mimeType) && !isMatchingImage({ bytes, mimeType });
  const pdfMismatch = mimeType === 'application/pdf' && String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-';
  return { bytes, mimeType: imageMismatch || pdfMismatch ? 'application/octet-stream' : mimeType };
}

function sessionEnded() {
  return new MobileApiError(401, 'Tu sesión terminó. Inicia sesión nuevamente.');
}

async function requestAccessToken(origin: string, refreshToken: string): Promise<string> {
  const data = await request<{ accessToken?: unknown }>(origin, '/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken }),
  });
  if (typeof data?.accessToken !== 'string' || !data.accessToken) {
    throw new MobileApiError(502, 'El servidor no devolvió una renovación válida.');
  }
  return data.accessToken;
}

function invalidate(snapshot: AuthSessionSnapshot) {
  if (authStorage.isCurrent(snapshot.revision)) onUnauthorized?.();
}

async function refreshSession(original: AuthSessionSnapshot, origin: string): Promise<AuthSessionSnapshot> {
  const { session } = original;
  if (typeof session.refreshToken !== 'string' || !session.refreshToken) {
    invalidate(original);
    throw sessionEnded();
  }

  let accessToken: string;
  try {
    accessToken = await requestAccessToken(origin, session.refreshToken);
  } catch (error) {
    if (error instanceof MobileApiError && error.status === 401) invalidate(original);
    throw error;
  }
  if (!authStorage.isCurrent(original.revision)) throw sessionEnded();

  // Refresh returns only a token. Verify its account and tenant before replaying an operation.
  const user = await request<{ id?: unknown; companyId?: unknown }>(origin, '/auth/me', undefined, accessToken);
  if (String(user?.id) !== session.userId || String(user?.companyId) !== session.tenantId) {
    invalidate(original);
    throw sessionEnded();
  }
  const refreshed = await authStorage.rotateAccessToken(original, accessToken);
  if (!refreshed) throw sessionEnded();
  return refreshed;
}

let pendingRefresh: { revision: number; promise: Promise<AuthSessionSnapshot> } | undefined;

async function refreshAfterExpiry(original: AuthSessionSnapshot, origin: string): Promise<AuthSessionSnapshot> {
  const latest = await authStorage.getSnapshot();
  if (!latest || latest.revision !== original.revision || !authStorage.isCurrent(original.revision)) throw sessionEnded();
  if (latest.session.accessToken !== original.session.accessToken) return latest;
  if (pendingRefresh?.revision === original.revision) return pendingRefresh.promise;

  const promise = refreshSession(original, origin).finally(() => {
    if (pendingRefresh?.promise === promise) pendingRefresh = undefined;
  });
  pendingRefresh = { revision: original.revision, promise };
  return promise;
}

async function authenticated<T>(
  path: string, init?: RequestInit, format?: ResponseFormat, read?: (response: Response) => Promise<T>,
  containsPassword = false,
): Promise<T> {
  const original = await authStorage.getSnapshot();
  if (!original || !authStorage.isCurrent(original.revision)) throw sessionEnded();
  const origin = normalizeServerUrl(original.session.apiUrl, !containsPassword && typeof __DEV__ !== 'undefined' && __DEV__);
  const execute = async (snapshot: AuthSessionSnapshot) => {
    if (!authStorage.isCurrent(snapshot.revision)) throw sessionEnded();
    if (init?.signal?.aborted) throw new Error('Solicitud cancelada.');
    try {
      return await request<T>(origin, path, init, snapshot.session.accessToken, format, read);
    } finally {
      if (!authStorage.isCurrent(snapshot.revision)) throw sessionEnded();
      if (init?.signal?.aborted) throw new Error('Solicitud cancelada.');
    }
  };

  try {
    return await execute(original);
  } catch (error) {
    if (error instanceof MobileApiError && error.status === 401 && error.code === 'SESSION_REVOKED') {
      invalidate(original);
      throw sessionEnded();
    }
    if (init?.signal?.aborted || !(error instanceof MobileApiError && error.accessTokenExpired)) throw error;
    if (containsPassword && error.code !== 'ACCESS_TOKEN_EXPIRED') throw error;
    const refreshed = await refreshAfterExpiry(original, origin);
    // A renewed session is ready for a fresh confirmation with a newly entered password.
    if (containsPassword) throw error;
    return execute(refreshed);
  }
}

function isMobileApproval(value: unknown): value is MobileApproval {
  if (!value || typeof value !== 'object') return false;
  const approval = value as Partial<MobileApproval>;
  return typeof approval.id === 'string' && !!approval.id &&
    typeof approval.risk === 'string' && typeof approval.expiresAt === 'string' &&
    Number.isSafeInteger(approval.policyVersion) &&
    ['pending', 'approved', 'rejected', 'expired', 'revoked'].includes(approval.status ?? '');
}

export const apiClient = {
  getCurrentWorkspace(): Promise<{ capabilities: string[] }> {
    return authenticated('/v1/workspaces/current', undefined, 'canonical');
  },

  async listApprovals(offset = 0): Promise<MobileApproval[]> {
    const items = await authenticated<unknown>(
      `/v1/approvals?status=pending&limit=${APPROVAL_PAGE_SIZE}&offset=${offset}`,
      undefined,
      'canonical',
    );
    if (!Array.isArray(items) || !items.every(isMobileApproval)) {
      throw new MobileApiError(502, 'El servidor no devolvió una lista de aprobaciones válida.');
    }
    return items;
  },

  async getApproval(approvalId: string): Promise<MobileApproval> {
    const approval = await authenticated<unknown>(`/v1/approvals/${encodeURIComponent(approvalId)}`, undefined, 'canonical');
    if (!isMobileApproval(approval) || approval.id !== approvalId) {
      throw new MobileApiError(502, 'El servidor no devolvió la aprobación solicitada.');
    }
    return approval;
  },

  async decideApproval(command: MobileApprovalCommand, password?: string): Promise<{ approvalId: string; status: MobileApprovalDecision }> {
    const { approvalId, decision, expectedVersion, key, reason } = command;
    const result = await authenticated<{ approvalId: string; status: MobileApprovalDecision }>(
      `/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ decision, expectedVersion, reason, password }) },
      'canonical',
      undefined,
      password !== undefined,
    );
    if (result.approvalId !== approvalId || result.status !== decision) {
      throw new MobileApiError(502, 'El servidor no confirmó la decisión solicitada.');
    }
    return result;
  },

  async signIn(server: string, email: string, password: string, allowLocalHttp = false): Promise<AuthSession> {
    const apiUrl = normalizeServerUrl(server, allowLocalHttp);
    const data = await request<LoginData>(apiUrl, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const userId = String(data?.user?.id ?? '');
    const tenantId = String(data?.user?.companyId ?? '');
    if (!/^[1-9]\d*$/.test(userId) || !/^[1-9]\d*$/.test(tenantId)
      || typeof data?.accessToken !== 'string' || !data.accessToken) {
      throw new MobileApiError(502, 'El servidor no devolvió una sesión válida.');
    }
    return { apiUrl, accessToken: data.accessToken, refreshToken: data.refreshToken, userId, tenantId };
  },

  async signOut(session: AuthSession): Promise<void> {
    if (typeof session.refreshToken !== 'string' || !session.refreshToken) return;
    const origin = normalizeServerUrl(session.apiUrl, typeof __DEV__ !== 'undefined' && __DEV__);
    const init = {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    };
    try {
      await request(origin, '/auth/logout', init, session.accessToken);
    } catch (error) {
      if (!(error instanceof MobileApiError && error.accessTokenExpired)) throw error;
      const accessToken = await requestAccessToken(origin, session.refreshToken);
      await request(origin, '/auth/logout', init, accessToken);
    }
  },

  listConversations(offset = 0): Promise<MobileConversation[]> {
    return authenticated<MobileConversation[]>(`/chats?limit=50&offset=${offset}`);
  },

  listMessages(chatId: string, before?: number): Promise<MobileMessage[]> {
    return authenticated<MobileMessage[]>(
      `/chats/${encodeURIComponent(chatId)}/messages?limit=50${before ? `&before=${before}` : ''}`,
    );
  },

  async listConversationMessages(conversationId: number | string, cursor?: string, clientRequestId?: string) {
    const params = new URLSearchParams({ limit: clientRequestId ? '1' : '50' });
    if (cursor) params.set('cursor', cursor);
    if (clientRequestId) params.set('clientRequestId', clientRequestId);
    const page = await authenticated<ConversationMessagePage>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
      undefined,
      'canonical',
    );
    return {
      messages: page.items.map((message): MobileMessage => {
        const attachments = message.channel === 'whatsapp-cloud' ? parseAttachments(message.attachments) : [];
        return {
          id: message.id,
          body: message.body,
          fromMe: message.direction === 'outbound',
          timestamp: Date.parse(message.createdAt),
          type: message.attachments.length ? 'attachment' : 'text',
          status: message.deliveryState,
          clientRequestId: message.causedBy.type === 'human' ? message.clientRequestId : null,
          ...(attachments.length ? { attachments } : {}),
        };
      }),
      nextCursor: page.nextCursor,
    };
  },

  async getConversationAttachment(conversationId: string, messageId: string, attachmentId: string, signal: AbortSignal) {
    if (![conversationId, messageId, attachmentId].every(isAttachmentId)) throw new MobileApiError(404, 'El adjunto no está disponible.');
    return authenticated(`/v1/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}`, {
      headers: { Accept: '*/*' }, cache: 'no-store', redirect: 'error', credentials: 'omit', signal,
    }, 'canonical', readAttachment);
  },

  getChatSessionStatus(chatId: string): Promise<ChatSessionStatus> {
    return authenticated<ChatSessionStatus>(
      `/chats/${encodeURIComponent(chatId)}/session/status`,
      undefined,
      'legacy-status',
    );
  },

  markAsRead(chatId: string): Promise<void> {
    return authenticated<void>(`/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST' });
  },

  async sendMessage(command: MobileSendCommand): Promise<MobileSendOutcome> {
    const { conversationId, expectedVersion, key, text } = command;
    let path = `/v1/conversations/${encodeURIComponent(conversationId)}/messages`;
    let body: string | FormData;
    if ('attachment' in command) {
      const { attachment } = command;
      path += '/attachments';
      body = new FormData();
      body.append('expectedConversationVersion', String(expectedVersion));
      if (text) body.append('message', text);
      body.append('file', uploadBlob(attachment), attachment.filename);
    } else {
      body = JSON.stringify({ expectedConversationVersion: expectedVersion, message: { kind: 'text', text } });
    }
    const result = await authenticated<{ accepted?: unknown; deliveryState?: unknown; providerMessageId?: unknown }>(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body,
    }, 'canonical');
    if (result.deliveryState === 'failed' || result.deliveryState === 'cancelled') return 'failed';
    if (result.deliveryState === 'unknown_delivery') return 'unknown_delivery';
    if (result.accepted === true && typeof result.providerMessageId === 'string' && result.providerMessageId &&
        ['dispatched', 'provider_accepted', 'delivered', 'read'].includes(String(result.deliveryState))) return 'accepted';
    return 'unknown_delivery';
  },

  takeoverConversation(conversationId: number | string, expectedVersion: number): Promise<TakeoverResult> {
    return authenticated<TakeoverResult>(`/conversations/${encodeURIComponent(conversationId)}/takeover`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    });
  },
};
