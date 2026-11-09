import { isAxiosError } from 'axios';
import { api } from '../../../shared/axios/http';

export const studioPath = '/dashboard/ia/estudio';
export const legacyAgentsPath = '/dashboard/ia/agentes';
export const graphPath = (id: string) => `${studioPath}/grafos/${encodeURIComponent(id)}`;
const base = '/v1/agent-graphs';
const pageSize = 12;
const graphEndpoint = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const graphIdPattern = String.raw`[A-Za-z0-9_\-]{1,128}`;
export const fixtureInputLimit = 2048;
export const fixtureStepLimit = 128;
export const nodeKinds = {
  agent: 'Agente', router: 'Enrutador', condition: 'Condición', tool: 'Herramienta', approval: 'Aprobación',
  subgraph: 'Subgrafo', parallel: 'Paralelo', join: 'Unión', handoff: 'Derivación', end: 'Fin',
} as const;
type NodeKind = keyof typeof nodeKinds;
interface GraphNode { id: string; kind: NodeKind; config: Record<string, unknown> }
interface GraphEdge { id: string; from: string; to: string; condition?: string; priority?: number }

export interface GraphSpec {
  entryNodeId: string;
  policyRef: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  limits: {
    maxSteps: number;
    maxDelegations: number;
    maxParallelNodes: number;
    maxDurationSeconds: number;
    maxModelTokens: number;
    maxCostMicroUsd: number;
  };
}

export interface GraphDraft extends GraphSpec {
  schemaVersion: 1;
  graphId: string;
  tenantId: string;
  version: number;
  status: 'draft';
  specHash: string;
}

interface GraphIssue { severity: 'error'; code: string; message: string; nodeId?: string }
export interface GraphValidation {
  graphId: string;
  version: number;
  specHash: string;
  scope: 'structural';
  publicationEvidence: false;
  valid: boolean;
  issues: GraphIssue[];
}

export interface GraphFixtureResult {
  graphId: string;
  graphVersion: number;
  specHash: string;
  mode: 'fixture';
  publicationEvidence: false;
  finalState: 'completed' | 'handed_off' | 'failed';
  totalSteps: number;
  executedNodes: { nodeId: string; kind: NodeKind; output: Record<string, unknown>; durationMs: number }[];
  simulatedMessages: { kind: 'text'; text: string }[];
  approvalsTriggered: { nodeId: string }[];
  failureReasons: string[];
}

export interface GraphProblem {
  message: string;
  fields: Array<{ name: string; reason: string }>;
}

export const exampleGraph: GraphSpec = {
  entryNodeId: 'inicio',
  policyRef: 'politica-interna',
  nodes: [
    { id: 'inicio', kind: 'agent', config: {} },
    { id: 'fin', kind: 'end', config: {} },
  ],
  edges: [{ id: 'finalizar', from: 'inicio', to: 'fin' }],
  limits: { maxSteps: 8, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 30, maxModelTokens: 1000, maxCostMicroUsd: 10000 },
};

export function draftSpec({ entryNodeId, policyRef, nodes, edges, limits }: GraphDraft): GraphSpec {
  return { entryNodeId, policyRef, nodes, edges, limits };
}

const comparisonSections = [
  ['entryNodeId', 'Nodo de entrada'], ['policyRef', 'Política'], ['nodes', 'Nodos'],
  ['edges', 'Conexiones'], ['limits', 'Límites'],
] as const;

function formatSpecSection(value: GraphSpec[keyof GraphSpec]) {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  }, 2);
}

export function compareGraphSpecs(previous: GraphSpec, current: GraphSpec) {
  return comparisonSections.map(([key, label]) => ({
    key, label, before: formatSpecSection(previous[key]), after: formatSpecSection(current[key]),
  })).filter(({ before, after }) => before !== after);
}

export function readVersion(raw: string | null): number | undefined {
  if (raw && /^[1-9][0-9]*$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value <= 2147483647) return value;
  }
  return undefined;
}

function draftConfirmed(draft: GraphDraft | undefined, id?: string, version?: number): draft is GraphDraft {
  return Boolean(draft && draft.schemaVersion === 1 && typeof draft.graphId === 'string' &&
    (id === undefined || draft.graphId === id) && Number.isSafeInteger(draft.version) && draft.version >= 1 &&
    (version === undefined || draft.version === version) && draft.status === 'draft' &&
    typeof draft.specHash === 'string' && /^[a-f0-9]{64}$/i.test(draft.specHash) &&
    typeof draft.entryNodeId === 'string' && typeof draft.policyRef === 'string' &&
    Array.isArray(draft.nodes) && Array.isArray(draft.edges) && draft.limits);
}

export function graphProblem(cause: unknown, fallback: string): GraphProblem {
  const fields: GraphProblem['fields'] = [];
  if (!isAxiosError(cause)) return { message: cause instanceof Error ? cause.message : fallback, fields };
  const { status, data } = cause.response ?? {};
  if ((status === 400 || status === 422) && Array.isArray(data?.invalidParams)) {
    for (const field of data.invalidParams) {
      if (typeof field?.name === 'string' && typeof field.reason === 'string') fields.push({ name: field.name, reason: field.reason });
    }
    return { message: 'El servidor rechazó campos del borrador.', fields };
  }
  if (status === 400 || status === 422) return { message: 'Los datos de esta solicitud no son válidos.', fields };
  if (status === 403) return { message: 'Agent Studio requiere una cuenta administradora de esta empresa.', fields };
  if (status === 404) return { message: 'No encontramos este grafo o revisión en tu empresa.', fields };
  if (status === 409) return { message: 'Ya existe un grafo con este identificador. Abre el existente o elige otro.', fields };
  return { message: fallback, fields };
}

export async function listGraphDrafts(after: string | null, signal: AbortSignal) {
  const { data } = await api.get<{ items: GraphDraft[]; nextAfter: string | null }>(
    base, { params: { after: after || undefined, limit: pageSize }, signal },
  );
  if (!Array.isArray(data?.items) || !data.items.every((item) => draftConfirmed(item)) ||
      (data.nextAfter !== null && (typeof data.nextAfter !== 'string' || data.nextAfter === after))) {
    throw new Error('El servidor devolvió un listado de borradores incompleto.');
  }
  return data;
}

export async function getGraphDraft(id: string, version: number | undefined, signal: AbortSignal) {
  const { data } = await api.get<GraphDraft>(graphEndpoint(id), { params: { version }, signal });
  if (!draftConfirmed(data, id, version)) throw new Error('El servidor no confirmó la revisión solicitada.');
  return data;
}

export async function saveGraphDraft(id: string, spec: Record<string, unknown>, mode: 'create' | 'revision') {
  const { data } = mode === 'create'
    ? await api.post<GraphDraft>(base, { ...spec, graphId: id })
    : await api.post<GraphDraft>(graphEndpoint(id) + '/revisions', spec);
  if (!draftConfirmed(data, id, mode === 'create' ? 1 : undefined)) throw new Error('El servidor no confirmó el borrador guardado.');
  return data;
}

export async function validateGraphDraft(draft: GraphDraft, signal: AbortSignal) {
  const { data } = await api.post<GraphValidation>(
    graphEndpoint(draft.graphId) + '/validate', undefined, { params: { version: draft.version }, signal },
  );
  if (data?.graphId !== draft.graphId || data.version !== draft.version || data.specHash !== draft.specHash ||
      data.scope !== 'structural' || data.publicationEvidence !== false || typeof data.valid !== 'boolean' ||
      !Array.isArray(data.issues) || data.valid !== (data.issues.length === 0) ||
      !data.issues.every((issue) => issue?.severity === 'error' && typeof issue.code === 'string' &&
        typeof issue.message === 'string' && (issue.nodeId === undefined || typeof issue.nodeId === 'string'))) {
    throw new Error('El servidor no confirmó una validación estructural para esta revisión.');
  }
  return data;
}

export async function simulateGraphDraft(draft: GraphDraft, mockInput: string, signal: AbortSignal) {
  const { data } = await api.post<GraphFixtureResult>(
    graphEndpoint(draft.graphId) + '/simulate', { graphVersion: draft.version, mockInput }, { signal },
  );
  if (data?.graphId !== draft.graphId || data.graphVersion !== draft.version || data.specHash !== draft.specHash ||
      data.mode !== 'fixture' || data.publicationEvidence !== false ||
      !['completed', 'handed_off', 'failed'].includes(data.finalState) ||
      !Array.isArray(data.executedNodes) || data.totalSteps !== data.executedNodes.length ||
      data.totalSteps > Math.min(draft.limits.maxSteps, fixtureStepLimit) ||
      !data.executedNodes.every((step) => step && draft.nodes.some((node) => node.id === step.nodeId && node.kind === step.kind) &&
        step.output && typeof step.output === 'object' && !Array.isArray(step.output)) ||
      !Array.isArray(data.simulatedMessages) || !data.simulatedMessages.every((message) => message?.kind === 'text' && typeof message.text === 'string') ||
      !Array.isArray(data.approvalsTriggered) || !data.approvalsTriggered.every((approval) => approval &&
        data.executedNodes.some((step) => step.nodeId === approval.nodeId && step.kind === 'approval')) ||
      !Array.isArray(data.failureReasons) || !data.failureReasons.every((reason) => typeof reason === 'string')) {
    throw new Error('El servidor no confirmó una simulación de prueba para esta revisión.');
  }
  return data;
}

export function graphFixtureProblem(cause: unknown): GraphProblem {
  if (isAxiosError(cause) && cause.response?.status === 422 &&
      cause.response.data?.detail === 'The stored revision has structural errors. Use the validate endpoint for details.') {
    return { message: 'La revisión tiene errores estructurales. Usa Validar esta revisión para verlos.', fields: [] };
  }
  return graphProblem(cause, 'No pudimos ejecutar la simulación de esta revisión.');
}
