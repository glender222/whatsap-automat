import { workflowDagGraphV1Schema, workflowExecutionLimitsV1Schema } from '@whatsap-automat/contracts';
import { isWorkflowCondition } from '../temporal/workflows/evaluateCondition';
import { WorkflowInputError } from './types';

export function validateWorkflowRevision(graphInput: unknown, limitsInput: unknown) {
  const graph = workflowDagGraphV1Schema.safeParse(graphInput);
  if (!graph.success) throw new WorkflowInputError('Invalid workflow graph.');
  const parsedLimits = workflowExecutionLimitsV1Schema.safeParse(limitsInput ?? {});
  if (!parsedLimits.success) throw new WorkflowInputError('Invalid workflow execution limits.');
  const limits = parsedLimits.data;
  const dagGraph = graph.data;
  const { nodes, edges } = dagGraph;

  if (nodes.length > 100 || edges.length > 200 || limits.maxStepCount > 100 ||
      limits.maxDurationSeconds > 86400 || limits.timeoutSeconds > 86400) {
    throw new WorkflowInputError('Workflow exceeds supported graph or execution limits.');
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const validId = (id: string) => /^[a-zA-Z0-9_.:-]{1,128}$/.test(id);
  const triggers = nodes.filter((node) => node.kind === 'trigger');
  if (![...nodeIds, ...edgeIds].every(validId) || nodeIds.size !== nodes.length || edgeIds.size !== edges.length || triggers.length !== 1 ||
      !nodes.some((node) => node.kind === 'end')) {
    throw new WorkflowInputError('Workflow needs unique IDs, exactly one trigger and at least one end.');
  }

  const outgoing = new Map(nodes.map((node) => [node.id, edges.filter((edge) => edge.source === node.id)]));
  let totalDelayMs = 0;
  for (const node of nodes) {
    const branches = outgoing.get(node.id)!;
    if (node.kind === 'condition') {
      const handles = new Set(branches.map((edge) => edge.sourceHandle));
      if (!isWorkflowCondition(node.config.expression) || branches.length !== 2 ||
          !handles.has('true') || !handles.has('false')) {
        throw new WorkflowInputError('A condition needs a supported expression and true and false branches.');
      }
      continue;
    }
    if (node.kind !== 'trigger' && node.kind !== 'delay' && node.kind !== 'end') {
      throw new WorkflowInputError(`Workflow node kind '${node.kind}' is unavailable for webhook runs.`);
    }
    if (branches.length !== (node.kind === 'end' ? 0 : 1)) {
      throw new WorkflowInputError('Each trigger and delay needs one outgoing edge, and an end needs none.');
    }
    if (node.kind === 'delay') {
      const duration = node.config.durationMs ?? (typeof node.config.seconds === 'number' ? node.config.seconds * 1000 : undefined);
      if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1) {
        throw new WorkflowInputError('A delay must specify a positive duration in milliseconds or seconds.');
      }
      totalDelayMs += duration;
    }
  }
  if (totalDelayMs > Math.min(limits.maxDurationSeconds, limits.timeoutSeconds) * 1000) {
    throw new WorkflowInputError('Workflow delays exceed its execution budget.');
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new WorkflowInputError('Webhook workflows cannot contain cycles.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of outgoing.get(id)!) visit(edge.target);
    visiting.delete(id);
    visited.add(id);
  }
  visit(triggers[0].id);
  if (visited.size !== nodes.length || nodes.length - 1 > limits.maxStepCount) {
    throw new WorkflowInputError('Every node must be reachable and fit the workflow step budget.');
  }
  return { dagGraph, limits };
}
