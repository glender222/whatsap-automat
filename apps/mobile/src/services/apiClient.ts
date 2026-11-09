import { authStorage, type AuthSession } from './authStorage';

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
}

interface ConversationMessagePage {
  items: {
    id: string;
    body: string | null;
    direction: 'inbound' | 'outbound';
    deliveryState: string;
    clientRequestId: string | null;
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

export type MobileSendOutcome = 'accepted' | 'failed' | 'unknown_delivery';

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
    public readonly metadata?: { currentVersion?: unknown; ownerId?: unknown; ownerType?: unknown; reasonCode?: unknown },
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

let onUnauthorized: ((accessToken: string) => void) | undefined;

export function handleUnauthorized(callback: (accessToken: string) => void): () => void {
  onUnauthorized = callback;
  return () => { if (onUnauthorized === callback) onUnauthorized = undefined; };
}

type ResponseFormat = 'envelope' | 'legacy-status' | 'canonical';

async function request<T>(
  origin: string, path: string, init: RequestInit = {}, accessToken?: string, format: ResponseFormat = 'envelope',
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json, application/problem+json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${origin}/api${path}`, { ...init, headers, signal: controller.signal });
    if (response.status === 401 && accessToken) onUnauthorized?.(accessToken);

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || (format !== 'canonical' && body.success !== true)) {
      const message = body?.userMessage ?? body?.detail ?? body?.message ?? body?.error;
      throw new MobileApiError(
        response.status,
        typeof message === 'string' ? message : `El servidor no pudo completar la solicitud (${response.status}).`,
        body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      );
    }
    return format === 'envelope' ? (body as ApiEnvelope<T>).data : body as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticated<T>(path: string, init?: RequestInit, format?: ResponseFormat): Promise<T> {
  const session = await authStorage.getAuthSession();
  if (!session) throw new MobileApiError(401, 'Tu sesión terminó. Inicia sesión nuevamente.');
  const origin = normalizeServerUrl(session.apiUrl, typeof __DEV__ !== 'undefined' && __DEV__);
  return request<T>(origin, path, init, session.accessToken, format);
}

export const apiClient = {
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
    if (!session.refreshToken) return;
    const origin = normalizeServerUrl(session.apiUrl, typeof __DEV__ !== 'undefined' && __DEV__);
    await request(origin, '/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    }, session.accessToken);
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
      messages: page.items.map((message): MobileMessage => ({
        id: message.id,
        body: message.body,
        fromMe: message.direction === 'outbound',
        timestamp: Date.parse(message.createdAt),
        type: message.attachments.length ? 'attachment' : 'text',
        status: message.deliveryState,
        clientRequestId: message.causedBy.type === 'human' ? message.clientRequestId : null,
      })),
      nextCursor: page.nextCursor,
    };
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

  async sendMessage(command: MobileTextCommand): Promise<MobileSendOutcome> {
    const { conversationId, expectedVersion, key, text } = command;
    const result = await authenticated<{ accepted?: unknown; deliveryState?: unknown; providerMessageId?: unknown }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expectedConversationVersion: expectedVersion, message: { kind: 'text', text } }),
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
