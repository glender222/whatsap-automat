/**
 * Agent Run states and tool invocation contracts
 * Blueprint Section 5.3 & Section 5.4
 */

export const AGENT_RUN_STATES = [
  'queued',
  'running',
  'awaiting_approval',
  'waiting',
  'handed_off',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export interface ToolInvocationV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly agentRunId: string;
  readonly graphVersion: number;
  readonly toolName: string;
  readonly schemaVersion: number;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effectKey: string;
  readonly expectedConversationVersion: number;
  readonly requestedByNodeId: string;
}

export interface AgentTimelineStepV1 {
  readonly timestamp: string;
  readonly step: number;
  readonly nodeId: string;
  readonly event: string;
  readonly detailsRedacted?: Readonly<Record<string, unknown>>;
}

export interface AgentRunTraceV1 {
  readonly runId: string;
  readonly tenantId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly state: AgentRunState;
  readonly timeline: readonly AgentTimelineStepV1[];
  readonly totalSteps: number;
  readonly totalTokensUsed?: number;
  readonly totalCostMicroUsd?: number;
}

export interface AgentSimulationRequestV1 {
  readonly graphId: string;
  readonly graphVersion?: number;
  readonly mockInput: string;
  readonly mockConversationState?: Readonly<Record<string, unknown>>;
}

export interface SimulatedNodeExecutionV1 {
  readonly nodeId: string;
  readonly kind: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
}

export interface AgentSimulationResultV1 {
  readonly executedNodes: readonly SimulatedNodeExecutionV1[];
  readonly simulatedMessages: ReadonlyArray<{
    readonly kind: string;
    readonly text?: string;
  }>;
  readonly approvalsTriggered: ReadonlyArray<{
    readonly nodeId: string;
    readonly risk: string;
    readonly action: string;
  }>;
  readonly finalState: AgentRunState;
  readonly totalSteps: number;
}
