export * from './client';
export * from './http';
export * from './pagination';
export * from './errors';
export * from './resources/conversations';
export * from './resources/channels';
export * from './resources/agents';
export * from './resources/workflows';
export * from './resources/approvals';

// Re-export common contracts for convenience
export type {
  ConversationV1,
  ConversationMessageV1,
  TakeoverCommandV1,
  PauseAiCommandV1,
  ChannelConnectionV1,
  ChannelConnectionHealthV1,
  AgentGraphVersionV1,
  AgentRunTraceV1,
  WorkflowRevisionV1,
  ApprovalRequestV1,
  ApprovalDecisionCommandV1,
  ExtensionManifest,
} from '@whatsap-automat/contracts';
