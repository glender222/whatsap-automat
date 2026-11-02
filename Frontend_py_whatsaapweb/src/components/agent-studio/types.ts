export type AgentStudioViewMode = 'guided' | 'canvas' | 'declarative' | 'split';

export type CanonicalNodeKind =
  | 'trigger'
  | 'policy_guard'
  | 'memory_retrieval'
  | 'llm_reasoner'
  | 'tool_call'
  | 'gate'
  | 'dispatch'
  | 'handoff';

export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

export interface AgentStudioNode {
  readonly id: string;
  readonly kind: CanonicalNodeKind;
  readonly label: string;
  readonly position: NodePosition;
  readonly config: Record<string, unknown>;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly isDraftModified?: boolean;
}

export interface AgentStudioEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly sourceHandle: string;
  readonly targetNodeId: string;
  readonly targetHandle: string;
  readonly conditionLabel?: string;
  readonly priority?: number;
}

export interface AgentGuidedConfig {
  readonly identity: {
    readonly name: string;
    readonly description: string;
    readonly purpose: 'sales' | 'support' | 'router' | 'operations' | 'general';
  };
  readonly reasoning: {
    readonly provider: 'openai' | 'anthropic' | 'local_vllm' | 'gemini';
    readonly model: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly systemPrompt: string;
  };
  readonly ragMemory: {
    readonly collectionId: string;
    readonly topK: number;
    readonly minSimilarity: number;
    readonly includeChatHistory: boolean;
    readonly maxContextMessages: number;
  };
  readonly toolsGranted: readonly string[];
  readonly policies: {
    readonly businessHoursEnabled: boolean;
    readonly timezone: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly blockedKeywords: readonly string[];
    readonly fallbackAction: 'handoff' | 'canned_reply';
    readonly fallbackCannedText: string;
  };
  readonly approvalGates: readonly {
    readonly actionType: string;
    readonly riskThreshold: 'financial' | 'destructive' | 'high';
    readonly ttlMinutes: number;
    readonly requiredRoles: readonly string[];
  }[];
  readonly evalSuiteRef?: string;
}

export interface AgentStudioDocument {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly status: 'draft' | 'published' | 'archived';
  readonly entryNodeId: string;
  readonly nodes: readonly AgentStudioNode[];
  readonly edges: readonly AgentStudioEdge[];
  readonly guidedConfig: AgentGuidedConfig;
  readonly limits: {
    readonly maxSteps: number;
    readonly maxDelegations: number;
    readonly maxParallelNodes: number;
    readonly maxDurationSeconds: number;
    readonly maxModelTokens: number;
    readonly maxCostMicroUsd: number;
  };
  readonly policyRef: string;
  readonly specHash: string;
  readonly updatedAt: string;
  readonly isDirty: boolean;
}

export interface ViewportTransform {
  zoom: number;
  pan: { x: number; y: number };
}

export interface SimulationStepTrace {
  step: number;
  nodeId: string;
  nodeKind: string;
  status: 'completed' | 'failed' | 'skipped';
  durationMs: number;
  tokensUsed: number;
  costMicroUsd: number;
  outputPayload?: Record<string, unknown>;
  toolCallsProposed?: string[];
}

export interface EvaluationScenario {
  id: string;
  name: string;
  mockInput: string;
  expectedTools?: string[];
  forbiddenTools?: string[];
  expectedTextPatterns?: string[];
  forbiddenTextPatterns?: string[];
  passed?: boolean;
}

export interface RegressionScorecard {
  suiteId: string;
  suiteName: string;
  agentGraphId: string;
  graphVersion: number;
  passRatePercent: number;
  totalScenarios: number;
  passedCount: number;
  failedCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCostMicroUsd: number;
  totalTokensUsed: number;
  regressionDetected: boolean;
  securityToolLeaks: string[];
  baselineVersion?: number;
  baselineComparison?: {
    passRateDelta: number;
    p95LatencyDeltaMs: number;
    costDeltaMicroUsd: number;
    newFailures: string[];
    resolvedFailures: string[];
  };
}

export interface PublicationBlocker {
  code: string;
  message: string;
  remediation: string;
}

export interface PublicationGateResult {
  allowed: boolean;
  blockers: PublicationBlocker[];
  computedSpecHash: string;
  declaredSpecHash: string;
  passRatePercent?: number;
  securityToolLeaksCount: number;
  cycleDetected: boolean;
  evaluatedAt: string;
}
