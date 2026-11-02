/**
 * Whatsap-Automat v0.4 — Automation Studio Types & Contracts
 * Phase F4: PR-F4-03 (Synchronized Visual Canvas & Outline Views, Live Run Inspector)
 *
 * Strict 1-to-1 alignment with @whatsap-automat/contracts/src/workflows
 */

// =============================================================================
// 1. Canonical Statuses & Enums
// =============================================================================

export const WORKFLOW_DEFINITION_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowDefinitionStatus = (typeof WORKFLOW_DEFINITION_STATUSES)[number];

export const WORKFLOW_REVISION_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowRevisionStatus = (typeof WORKFLOW_REVISION_STATUSES)[number];

export const WORKFLOW_NODE_KINDS = [
  'trigger',
  'condition',
  'delay',
  'activity',
  'approval',
  'end',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const WORKFLOW_TRIGGER_TYPES = [
  'webhook',
  'schedule',
  'event',
  'manual',
  'channel.message',
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_timer',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// =============================================================================
// 2. DAG Graph Definition & Versioning
// =============================================================================

export interface WorkflowNodePosition {
  readonly x: number;
  readonly y: number;
}

export interface WorkflowNodeDefinitionV1 {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly label?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly position?: WorkflowNodePosition;
}

export interface WorkflowEdgeDefinitionV1 {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string;
  readonly targetHandle?: string;
  readonly label?: string;
  readonly condition?: string;
}

export interface WorkflowDagGraphV1 {
  readonly nodes: readonly WorkflowNodeDefinitionV1[];
  readonly edges: readonly WorkflowEdgeDefinitionV1[];
}

export interface WorkflowExecutionLimitsV1 {
  readonly maxDurationSeconds: number;
  readonly maxStepCount: number;
  readonly timeoutSeconds: number;
  /** Optional legacy alias for maxStepCount */
  readonly maxSteps?: number;
}

export interface WorkflowDefinitionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly status: WorkflowDefinitionStatus;
  readonly publishedRevisionId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowRevisionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly revisionNumber: number;
  readonly status: WorkflowRevisionStatus;
  readonly dagGraph: WorkflowDagGraphV1;
  readonly specHash: string;
  readonly limits: WorkflowExecutionLimitsV1;
  readonly publishedAt?: string | null;
  readonly createdAt: string;
}

export interface WorkflowErrorDetailsV1 {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly timestamp?: string;
  readonly retryable?: boolean;
  readonly stack?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface WorkflowRunV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string | null;
  readonly workflowId: string;
  readonly revisionId: string;
  readonly temporalWorkflowId: string;
  readonly temporalRunId?: string | null;
  readonly triggerType: WorkflowTriggerType;
  readonly status: WorkflowRunStatus;
  readonly correlationId: string;
  readonly inputPayload: Readonly<Record<string, unknown>>;
  readonly outputPayload: Readonly<Record<string, unknown>>;
  readonly currentStep?: string | null;
  readonly stepCount: number;
  readonly errorDetails?: WorkflowErrorDetailsV1 | null;
  readonly startedAt: string;
  readonly completedAt?: string | null;
}

export interface WorkflowTriggerV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly type: 'webhook' | 'schedule' | 'event';
  readonly endpointKey?: string | null;
  readonly authTokenHash?: string | null;
  readonly cronExpression?: string | null;
  readonly isActive: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RollbackWorkflowCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly targetRevisionNumber?: number;
  readonly targetRevisionId?: string;
  readonly userId: string;
  readonly reason?: string;
}

export interface PublishWorkflowRevisionCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly revisionId: string;
  readonly userId: string;
  readonly comment?: string;
}

// =============================================================================
// 3. Temporal Execution, Signals & Real-Time Query State
// =============================================================================

export interface WorkflowRunHistoryItem {
  readonly nodeId: string;
  readonly status: string;
  readonly timestamp: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PendingApprovalState {
  readonly approvalId: string;
  readonly nodeId: string;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly timeoutMs?: number;
}

export interface ApprovalActor {
  readonly userId: string;
  readonly roles?: readonly string[];
}

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly actor: ApprovalActor;
  readonly reason?: string;
  readonly timestamp?: string;
}

export interface ApprovalDecisionPayload {
  readonly approvalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly actor: {
    readonly userId: string;
    readonly roles?: readonly string[];
  };
  readonly reason?: string;
  readonly timestamp?: string;
}

export interface CancelWorkflowInput {
  readonly reason?: string;
  readonly userId?: string;
}

export interface WorkflowRunState {
  readonly workflowId: string;
  readonly runId: string;
  readonly tenantId: number;
  readonly revisionId?: string;
  readonly status: 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  readonly currentNodeId: string;
  readonly stepCount: number;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly historyTrace: readonly WorkflowRunHistoryItem[];
  readonly pendingApproval?: PendingApprovalState | null;
  readonly approvalDecision?: ApprovalDecisionInput | null;
  readonly lastUpdated: string;
}

// =============================================================================
// 4. Per-Node Strongly-Typed Config Definitions
// =============================================================================

export interface TriggerNodeConfig {
  readonly triggerType: WorkflowTriggerType;
  readonly endpointKey?: string;
  readonly cronExpression?: string;
  readonly eventName?: string;
  readonly samplePayload?: Readonly<Record<string, unknown>>;
  readonly authScheme?: 'token' | 'none';
}

export interface ConditionNodeConfig {
  readonly expression: string; // e.g. "amount > 5000"
  readonly description?: string;
}

export interface DelayNodeConfig {
  readonly durationMs?: number;
  readonly seconds?: number;
  readonly minutes?: number;
  readonly hours?: number;
  readonly description?: string;
}

export interface ActivityHttpRequestConfig {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface ActivityBusinessEffectConfig {
  readonly effectType: string; // e.g. "order.approve"
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly ledgerKey?: string;
}

export type ActivityNodeConfig = ActivityHttpRequestConfig | ActivityBusinessEffectConfig;

export interface ApprovalNodeConfig {
  readonly timeoutMs?: number;
  readonly requiredRoles?: readonly string[];
  readonly description?: string;
  readonly approvalType?: string;
}

export interface EndNodeConfig {
  readonly status?: 'completed' | 'rejected' | 'failed';
  readonly summary?: string;
  readonly outputTransform?: Readonly<Record<string, unknown>>;
}

// =============================================================================
// 5. Studio UI State, Canvas & Accessibility (WCAG 2.2 AA)
// =============================================================================

export type StudioViewMode = 'canvas' | 'outline' | 'split';
export type StudioActiveTab = 'design' | 'simulate' | 'history' | 'settings';

export interface ViewportTransform {
  pan: { x: number; y: number };
  zoom: number;
}

export interface StudioValidationIssue {
  readonly level: 'error' | 'warning';
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly message: string;
}

export interface StudioValidationResult {
  readonly isValid: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly issues: readonly StudioValidationIssue[];
  readonly orphanNodeIds: readonly string[];
  readonly hasCycle: boolean;
  readonly rootTriggerId?: string;
}

export interface OutlineTreeItem {
  readonly id: string; // Tree item ID: e.g. "tree-item-node-1"
  readonly nodeId: string; // References WorkflowNodeDefinitionV1.id
  readonly kind: WorkflowNodeKind;
  readonly label: string;
  readonly level: number; // 1-indexed hierarchy level (WAI-ARIA aria-level)
  readonly edgeLabel?: string; // e.g. "Si / True", "No / False", "Aprobado", "Rechazado"
  readonly children: readonly OutlineTreeItem[];
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly isSelected: boolean;
  readonly isReconvergence: boolean; // True if node is reached via an alternate converging branch
  readonly status?: WorkflowRunStatus;
}

export interface OutlineTreeNode {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly label: string;
  readonly depth: number;
  readonly parentId?: string | null;
  readonly childrenIds: readonly string[];
  readonly isExpanded?: boolean;
  readonly isSelected?: boolean;
  readonly executionStatus?: 'idle' | 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed';
}

export interface StudioNodeUI extends WorkflowNodeDefinitionV1 {
  runStatus?: WorkflowRunStatus;
  isCurrentStep?: boolean;
  stepExecutionMs?: number;
}

export interface WorkflowNodeData {
  readonly label: string;
  readonly kind: WorkflowNodeKind;
  readonly config: Readonly<Record<string, unknown>>;
  readonly isSelected?: boolean;
  readonly executionStatus?: 'idle' | 'queued' | 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed';
  readonly stepLatencyMs?: number;
  readonly error?: string;
}

export interface WorkflowEdgeData {
  readonly label?: string;
  readonly condition?: string;
  readonly sourceHandle?: string;
  readonly targetHandle?: string;
  readonly isTraversed?: boolean;
}

export interface StudioSimulationStep {
  readonly stepIndex: number;
  readonly nodeId: string;
  readonly nodeKind: WorkflowNodeKind;
  readonly nodeLabel: string;
  readonly status: 'simulated_success' | 'simulated_warning' | 'simulated_failure' | 'waiting_gate';
  readonly latencyMs: number;
  readonly outputVariables: Readonly<Record<string, unknown>>;
}

export interface StudioSimulationResult {
  readonly success: boolean;
  readonly durationMs: number;
  readonly steps: readonly StudioSimulationStep[];
  readonly finalPayload: Readonly<Record<string, unknown>>;
}

// =============================================================================
// 6. Component Props Contracts
// =============================================================================

export interface StudioOutlineProps {
  dagGraph: WorkflowDagGraphV1;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  activeRun?: WorkflowRunV1 | null;
  validationErrors?: Record<string, string[]>;
  className?: string;
}

export interface LiveRunInspectorProps {
  run: WorkflowRunV1 | null;
  nodes: readonly WorkflowNodeDefinitionV1[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onApprovalDecision?: (decision: ApprovalDecisionPayload) => Promise<void> | void;
  isApprovalSubmitting?: boolean;
  onClose?: () => void;
  className?: string;
}

export interface StudioCanvasProps {
  dagGraph: WorkflowDagGraphV1;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  activeRun?: WorkflowRunV1 | null;
  validationResult?: StudioValidationResult;
  onUpdateNodePosition?: (nodeId: string, position: WorkflowNodePosition) => void;
  onConnect?: (sourceId: string, targetId: string, sourceHandle?: string) => void;
  className?: string;
  viewportTransform?: ViewportTransform;
  onViewportChange?: (viewport: ViewportTransform) => void;
}

export interface StudioToolbarProps {
  workflowName: string;
  status: WorkflowDefinitionStatus;
  revisions: readonly WorkflowRevisionV1[];
  activeRevisionNumber: number;
  onSelectRevision: (revisionNumber: number) => void;
  viewMode: StudioViewMode;
  onChangeViewMode: (mode: StudioViewMode) => void;
  onValidate: () => void;
  onSimulate: () => void;
  onPublish: () => void;
  onRollback: (targetRevisionNumber: number, reason: string) => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoomLevel: number;
  isSimulating?: boolean;
  isValidating?: boolean;
}

export interface AutomationStudioProps {
  initialWorkflow?: WorkflowDefinitionV1;
  initialRevision?: WorkflowRevisionV1;
  availableRevisions?: readonly WorkflowRevisionV1[];
  initialActiveRun?: WorkflowRunV1 | null;
  onSaveDraft?: (dag: WorkflowDagGraphV1) => Promise<void> | void;
  onPublishRevision?: (revisionId: string, comment?: string) => Promise<void> | void;
  onRollbackRevision?: (command: RollbackWorkflowCommandV1) => Promise<void> | void;
  onApprovalDecision?: (decision: ApprovalDecisionPayload) => Promise<void> | void;
  className?: string;
}
