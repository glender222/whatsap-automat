import {
  ToolDefinitionV1,
  ToolExecutionRequestV1,
  ToolExecutionResultV1,
  ToolRiskLevel,
  ToolExecutionStatus,
} from '@whatsap-automat/contracts';

export interface ToolExecutionContext {
  tenantId: number;
  agentGraphId?: string;
  runId?: string;
  actorId?: string;
  actorRoles: string[];
  conversationId?: string | number;
  expectedConversationVersion?: number;
}

export interface ToolValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface IToolImplementation {
  readonly definition: ToolDefinitionV1;
  validateInput(input: Record<string, unknown>): ToolValidationResult;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
}

export interface CachedEffectRecord {
  runId: string;
  toolName: string;
  status: string;
  output: unknown;
}

export interface ToolAuthorizationResult {
  granted: boolean;
  code?: string;
  message?: string;
}
