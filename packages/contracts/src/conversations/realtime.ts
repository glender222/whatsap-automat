import { AgentRunState } from '../agents/runs';

/**
 * Canonical Server Events for realtime Socket.IO / WebSockets
 * Blueprint Section 5.6
 */
export type ServerEventV1 =
  | {
      readonly type: 'conversation.updated';
      readonly tenantId: string;
      readonly conversationId: string;
      readonly version: number;
      readonly eventId: string;
    }
  | {
      readonly type: 'message.created';
      readonly tenantId: string;
      readonly conversationId: string;
      readonly messageId: string;
      readonly eventId: string;
    }
  | {
      readonly type: 'agent.run.updated';
      readonly tenantId: string;
      readonly runId: string;
      readonly state: AgentRunState;
      readonly eventId: string;
    }
  | {
      readonly type: 'approval.created';
      readonly tenantId: string;
      readonly approvalId: string;
      readonly eventId: string;
    };

/**
 * Server-authorized rooms
 * Only the server adds sockets to rooms after verifying authentication and membership.
 */
export type AuthorizedRoom =
  | `tenant:${string}`
  | `conversation:${string}:${string}`
  | `user:${string}:${string}`;

export function createTenantRoom(tenantId: string): AuthorizedRoom {
  return `tenant:${tenantId}`;
}

export function createConversationRoom(tenantId: string, conversationId: string): AuthorizedRoom {
  return `conversation:${tenantId}:${conversationId}`;
}

export function createUserRoom(tenantId: string, userId: string): AuthorizedRoom {
  return `user:${tenantId}:${userId}`;
}
