/**
 * Whatsap-Automat v0.4 — Automation Studio UI (PR-F4-03)
 * Public Barrel Exports
 */

export * from './types';
export * from './mockData';
export * from './AutomationStudio';

// Canvas Components
export { StudioCanvas } from './canvas/StudioCanvas';
export { CanvasViewport } from './canvas/CanvasViewport';
export { StudioNodeCard, NODE_WIDTH, NODE_HEIGHT } from './canvas/nodes/StudioNodeCard';
export { TriggerNode } from './canvas/nodes/TriggerNode';
export { ConditionNode } from './canvas/nodes/ConditionNode';
export { DelayNode } from './canvas/nodes/DelayNode';
export { ActivityNode } from './canvas/nodes/ActivityNode';
export { ApprovalNode } from './canvas/nodes/ApprovalNode';
export { EndNode } from './canvas/nodes/EndNode';
export { StudioEdge, computeBezierCurve } from './canvas/edges/StudioEdge';
export { EdgeDraft } from './canvas/edges/EdgeDraft';

// Outline Components
export { StudioOutline } from './outline/StudioOutline';
export { buildTreeFromDag } from './outline/dagToTree';

// Inspector Components
export { LiveRunInspector } from './inspector/LiveRunInspector';
export { JsonViewer } from './inspector/JsonViewer';
export { NodeConfigPanel } from './inspector/NodeConfigPanel';

// Toolbar
export { StudioToolbar } from './toolbar/StudioToolbar';
