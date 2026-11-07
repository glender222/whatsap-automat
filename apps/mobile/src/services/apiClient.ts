/**
 * Mobile HTTP API Client consuming OpenAPI v1 endpoints
 * Injects JWT Bearer tokens and parses RFC 7807 ProblemDetails into typed errors.
 */

import {
  ConversationV1,
  ConversationMessageV1,
  ProblemDetailsV1,
  StandardErrorCode,
} from '@whatsap-automat/contracts';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ProblemDetailsError,
  UnauthorizedError,
  ValidationError,
} from '@whatsap-automat/sdk';
import { authStorage } from './authStorage';

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  prevCursor?: string | null;
  hasMore: boolean;
}

export interface SendMessagePayload {
  text: string;
  expectedConversationVersion: number;
  idempotencyKey?: string;
  mediaRef?: string;
}

export interface TakeoverPayload {
  expectedVersion: number;
  userId: string;
  reason?: string;
}

export interface PauseAiPayload {
  expectedVersion: number;
  durationSeconds?: number;
  reason?: string;
}

export interface SendMessageResult {
  providerMessageId: string | null;
  accepted: boolean;
  rawStatus: string;
  deliveryState: string;
}

export interface TakeoverResult {
  success: boolean;
  conversationId: string;
  previousVersion: number;
  newVersion: number;
  epoch: number;
  ownerType: 'human' | 'ai_agent';
  ownerId: string | null;
  aiPaused: boolean;
}

export class MobileApiClient {
  private static instance: MobileApiClient;

  private constructor() {}

  public static getInstance(): MobileApiClient {
    if (!MobileApiClient.instance) {
      MobileApiClient.instance = new MobileApiClient();
    }
    return MobileApiClient.instance;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit & { idempotencyKey?: string } = {}
  ): Promise<T> {
    const baseUrl = await authStorage.getApiUrl();
    const token = await authStorage.getAccessToken();
    const tenantId = await authStorage.getTenantId();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, application/problem+json',
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (tenantId) {
      headers['X-Tenant-Id'] = tenantId;
    }

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${cleanBase}${cleanEndpoint}`;

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.ok) {
      // 204 No Content
      if (response.status === 204) {
        return undefined as unknown as T;
      }
      return (await response.json()) as T;
    }

    // Parse Error Payload (RFC 7807 ProblemDetails)
    let errorBody: any = null;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = {
        title: response.statusText,
        detail: `Request failed with HTTP status ${response.status}`,
        status: response.status,
      };
    }

    // Map HTTP Status to Typed Errors
    const problemPayload: Partial<ProblemDetailsV1> = {
      status: response.status,
      title: errorBody.title || response.statusText,
      detail: errorBody.detail || errorBody.message || 'Unknown error',
      instance: errorBody.instance || cleanEndpoint,
      code: errorBody.code || (response.status === 409 ? StandardErrorCode.CONFLICT : StandardErrorCode.INTERNAL_ERROR),
      correlationId: errorBody.correlationId || response.headers.get('x-correlation-id') || 'unknown',
      metadata: errorBody.metadata,
      invalidParams: errorBody.invalidParams,
    };

    switch (response.status) {
      case 401:
        throw new UnauthorizedError(problemPayload);
      case 403:
        throw new PolicyDeniedError(problemPayload);
      case 404:
        throw new NotFoundError(problemPayload);
      case 409:
        // Critical CAS Conflict Error
        throw new ConflictError(problemPayload);
      case 422:
        throw new ValidationError(problemPayload);
      default:
        throw new ProblemDetailsError(problemPayload);
    }
  }

  // --- Conversations API ---

  public async listConversations(params?: {
    status?: string;
    stage?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResponse<ConversationV1>> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.stage) query.set('stage', params.stage);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);

    const queryString = query.toString() ? `?${query.toString()}` : '';
    return this.request<PaginatedResponse<ConversationV1>>(`/conversations${queryString}`, {
      method: 'GET',
    });
  }

  public async getConversation(conversationId: string): Promise<ConversationV1> {
    return this.request<ConversationV1>(`/conversations/${conversationId}`, {
      method: 'GET',
    });
  }

  public async listMessages(
    conversationId: string,
    params?: { limit?: number; cursor?: string }
  ): Promise<PaginatedResponse<ConversationMessageV1>> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);

    const queryString = query.toString() ? `?${query.toString()}` : '';
    return this.request<PaginatedResponse<ConversationMessageV1>>(
      `/conversations/${conversationId}/messages${queryString}`,
      { method: 'GET' }
    );
  }

  public async sendMessage(
    conversationId: string,
    payload: SendMessagePayload
  ): Promise<SendMessageResult> {
    const idempotencyKey =
      payload.idempotencyKey ||
      `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    return this.request<SendMessageResult>(
      `/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        idempotencyKey,
        body: JSON.stringify({
          message: {
            kind: payload.mediaRef ? 'media' : 'text',
            text: payload.text,
            mediaRef: payload.mediaRef,
          },
          expectedConversationVersion: payload.expectedConversationVersion,
        }),
      }
    );
  }

  public async takeoverConversation(
    conversationId: string,
    payload: TakeoverPayload
  ): Promise<TakeoverResult | ConversationV1> {
    return this.request<TakeoverResult | ConversationV1>(
      `/conversations/${conversationId}/takeover`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: payload.expectedVersion,
          userId: payload.userId,
          reason: payload.reason || 'Human supervisor mobile takeover',
        }),
      }
    );
  }

  public async pauseAi(
    conversationId: string,
    payload: PauseAiPayload
  ): Promise<ConversationV1> {
    return this.request<ConversationV1>(`/conversations/${conversationId}/pause-ai`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async resumeAi(
    conversationId: string,
    payload: { expectedVersion: number; reason?: string }
  ): Promise<ConversationV1> {
    return this.request<ConversationV1>(`/conversations/${conversationId}/resume-ai`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}

export const apiClient = MobileApiClient.getInstance();
