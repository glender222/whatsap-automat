import { ConversationV1, ConversationMessageV1, SendMessageResultV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';
import { CursorPager } from '../pagination';

export interface ListConversationsParams {
  cursor?: string;
  limit?: number;
  status?: string;
  channel?: string;
  stage?: string;
}

export interface TakeoverParams {
  expectedVersion: number;
  /** @deprecated The server takes the operator identity from the session. */
  userId?: string;
  reason?: string;
}

export interface PauseAiParams {
  expectedVersion: number;
  durationSeconds?: number;
  reason?: string;
}

export class ConversationsResource {
  constructor(private readonly http: HttpClient) {}

  list(params: ListConversationsParams = {}): CursorPager<ConversationV1> {
    return new CursorPager(async (cursor) => {
      const res = await this.http.get<{ items: ConversationV1[]; nextCursor: string | null; hasMore: boolean }>(
        '/conversations',
        { query: { ...params, cursor } }
      );
      return res;
    }, params.cursor);
  }

  async get(id: string): Promise<ConversationV1> {
    return this.http.get<ConversationV1>(`/conversations/${id}`);
  }

  listMessages(conversationId: string, params: { cursor?: string; limit?: number } = {}): CursorPager<ConversationMessageV1> {
    return new CursorPager(async (cursor) => {
      const res = await this.http.get<{ items: ConversationMessageV1[]; nextCursor: string | null; hasMore: boolean }>(
        `/conversations/${conversationId}/messages`,
        { query: { ...params, cursor } }
      );
      return res;
    }, params.cursor);
  }

  async sendText(
    conversationId: string,
    text: string,
    expectedConversationVersion: number,
    idempotencyKey: string = globalThis.crypto.randomUUID(),
  ): Promise<SendMessageResultV1> {
    return this.http.post<SendMessageResultV1>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      message: { kind: 'text', text }, expectedConversationVersion,
    }, { headers: { 'Idempotency-Key': idempotencyKey } });
  }

  async takeover(conversationId: string, params: TakeoverParams): Promise<ConversationV1> {
    return this.http.post<ConversationV1>(`/conversations/${conversationId}/takeover`, params);
  }

  async pauseAi(conversationId: string, params: PauseAiParams): Promise<ConversationV1> {
    return this.http.post<ConversationV1>(`/conversations/${conversationId}/pause-ai`, params);
  }

  async resumeAi(conversationId: string, params: { expectedVersion: number; reason?: string }): Promise<ConversationV1> {
    return this.http.post<ConversationV1>(`/conversations/${conversationId}/resume-ai`, params);
  }
}
