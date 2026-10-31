/**
 * Concurrency-safe CAS Commands for Conversations
 * Blueprint Section 5.5
 */

export interface TakeoverCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly expectedVersion: number;
  readonly userId: string;
  readonly reason?: string;
}

export interface PauseAiCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly expectedVersion: number;
  readonly durationSeconds?: number;
  readonly reason?: string;
}

export interface ResumeAiCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
}
