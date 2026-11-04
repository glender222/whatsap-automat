import { ConversationV1, ConversationMessageV1 } from '@whatsap-automat/contracts';
import { HttpClient } from '../http';
import { CursorPager } from '../pagination';

export interface ListConversationsParams {
  cursor?: string;
  limit?: number;
  status?: string;
  channel?: string;
}

export interface TakeoverParams {
  expectedVersion: number;
  userId: string;
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
