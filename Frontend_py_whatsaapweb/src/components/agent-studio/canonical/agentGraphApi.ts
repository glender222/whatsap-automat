import { isAxiosError } from 'axios';
import { api, type AuthRequestConfig } from '../../../shared/axios/http';

export const studioPath = '/dashboard/ia/estudio';
export const legacyAgentsPath = '/dashboard/ia/agentes';
export const graphPath = (id: string) => `${studioPath}/grafos/${encodeURIComponent(id)}`;

export function studioLocation(path: string, { after, version, from }: {
  after: string | null;
  version?: number;
  from?: number;
}) {
  const params = new URLSearchParams();
  if (version !== undefined) params.set('version', String(version));
  if (from !== undefined) params.set('from', String(from));
  if (after) params.set('after', after);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

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
  if (data?.code === 'STUDIO_PROVIDER_PAUSED') return { message: 'La ejecución con proveedor está pausada para esta empresa.', fields };
  if (data?.code === 'STUDIO_PROVIDER_CREDENTIAL_REQUIRED') return { message: 'Configura una credencial de OpenAI para esta empresa y vuelve a intentarlo.', fields };
  if (data?.code === 'AI_QUOTA_EXHAUSTED') return { message: 'La empresa no tiene cuota disponible para esta ejecución.', fields };
  if (status === 409 && cause.config?.url?.endsWith('/publish')) {
    return { message: 'Actualiza la revisión y comprueba que su evaluación aprobada sigue vigente.', fields };
  }
  if (status === 409 && cause.config?.url?.endsWith('/execute')) {
    return { message: 'La ejecución entró en conflicto con un intento anterior o con un cambio de revisión activa. Actualiza el estado de Studio.', fields };
  }
  if (status === 409 && cause.config?.url?.endsWith('/whatsapp-binding')) {
    return { message: 'La vinculación o la publicación cambió. Vuelve a consultar el estado.', fields };
  }
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

export async function loadStudioTextTemplate(signal: AbortSignal) {
  const { data } = await api.get<GraphSpec>(base + '/templates/linear-text', { signal });
  if (!data || typeof data.entryNodeId !== 'string' || typeof data.policyRef !== 'string' ||
      !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.limits) {
    throw new Error('El servidor no devolvió una plantilla de texto válida.');
  }
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

export type StudioExecutionProfileName = 'linear-text-v1' | 'catalog-router-v1';
export interface ExecutionSuite { id: string; name: string; scenarioCount: number; profile?: StudioExecutionProfileName }
export type StudioExecutionMode = 'verification' | 'provider';
export interface CatalogExecutionProfile {
  name: 'catalog-router-v1'; compatible: boolean; issue: string | null; model: string;
  publicationAllowed: false; minScenarioTimeoutMs: number; maxScenarioTimeoutMs: number;
  maxScenarios: number; maxInputLength: number; maxSerializedInputLength: number;
}
type ExecutionProfile = CatalogExecutionProfile | {
  name?: 'linear-text-v1'; compatible: boolean; issue: string | null; model: string; publicationAllowed?: boolean;
};
export interface StudioPublication {
  graphId: string; version: number; specHash: string; evaluationId: string; mode: StudioExecutionMode;
}
export interface ExecutionEvaluation {
  runId: string; suiteId: string; graphId: string; version: number; specHash: string;
  mode: StudioExecutionMode; status: 'running' | 'completed' | 'failed' | 'cancelled'; passed: boolean;
  admittedScenarioId: string | null;
  profile?: StudioExecutionProfileName; publicationAllowed?: boolean; publicationEvidence?: boolean;
  totalTokensUsed?: number; totalCostMicroUsd?: number; failureCode?: string;
  scenarios: {
    scenarioId: string; outcome: 'passed' | 'assertion_failed' | 'uncertain' | 'blocked'; executedTools?: string[];
  }[];
}

type StudioRequest = { signal: AbortSignal; sessionGeneration: number };

function executionConfig(draft: GraphDraft, request: StudioRequest): AuthRequestConfig {
  return { params: { version: draft.version }, ...request };
}

function verifiedPublication(publication: StudioPublication | undefined, draft: GraphDraft, mode: StudioExecutionMode | null) {
  return publication?.graphId === draft.graphId && publication.mode === mode &&
    Number.isSafeInteger(publication.version) && publication.version > 0 && /^[a-f0-9]{64}$/.test(publication.specHash) &&
    (publication.version !== draft.version || publication.specHash === draft.specHash);
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function verifiedCatalogProfile(profile: CatalogExecutionProfile) {
  return profile.publicationAllowed === false && Number.isSafeInteger(profile.maxScenarios) &&
    profile.maxScenarios >= 0 && profile.maxScenarios <= 20 && positiveInteger(profile.maxInputLength) &&
    positiveInteger(profile.maxSerializedInputLength) && positiveInteger(profile.minScenarioTimeoutMs) &&
    positiveInteger(profile.maxScenarioTimeoutMs) && (!profile.compatible || (profile.maxScenarios > 0 &&
      profile.minScenarioTimeoutMs <= profile.maxScenarioTimeoutMs));
}

export async function readStudioExecution(draft: GraphDraft, request: StudioRequest) {
  const { data } = await api.get<{
    mode: StudioExecutionMode | null; suites: ExecutionSuite[]; active: StudioPublication | null;
    availability?: 'ready' | 'paused' | 'credential_required';
    profile?: ExecutionProfile;
  }>(
    graphEndpoint(draft.graphId) + '/execution', executionConfig(draft, request),
  );
  const profile = data?.profile;
  const profileName = profile?.name ?? 'linear-text-v1';
  if ((data?.mode !== 'verification' && data?.mode !== 'provider' && data?.mode !== null) || !Array.isArray(data.suites) ||
      !data.suites.every((suite) => typeof suite.id === 'string' && typeof suite.name === 'string' &&
        positiveInteger(suite.scenarioCount) && (suite.profile ?? 'linear-text-v1') === profileName) ||
      (data.active !== null && !verifiedPublication(data.active, draft, data.mode)) ||
      (data.mode !== null && (typeof profile?.compatible !== 'boolean' || typeof profile.model !== 'string')) ||
      (profileName !== 'linear-text-v1' && profileName !== 'catalog-router-v1') ||
      (profile?.name === 'catalog-router-v1' && !verifiedCatalogProfile(profile)) ||
      (data.mode === 'provider' && !['ready', 'paused', 'credential_required'].some((state) => state === data.availability))) {
    throw new Error('El servidor no confirmó la disponibilidad de ejecución.');
  }
  return data;
}

export async function saveStudioOpenAiCredential(apiKey: string, request: StudioRequest) {
  const config: AuthRequestConfig = request;
  const { data } = await api.post<{ success: boolean }>('/v1/ai/providers', { provider: 'openai', apiKey }, config);
  if (data?.success !== true) throw new Error('El servidor no confirmó el guardado de la credencial.');
}

export async function saveStudioSuite(draft: GraphDraft, suite: {
  id: string; name: string; profile?: StudioExecutionProfileName;
  scenarios: {
    id: string; name: string; mockInput: string; expectedTextPatterns: string[]; expectedTools?: string[]; forbiddenTools?: string[];
  }[];
}, request: StudioRequest) {
  const { data } = await api.post<ExecutionSuite>(graphEndpoint(draft.graphId) + '/evaluation-suites', suite, executionConfig(draft, request));
  if (data?.id !== suite.id || data.name !== suite.name || data.scenarioCount !== suite.scenarios.length ||
      (data.profile ?? 'linear-text-v1') !== (suite.profile ?? 'linear-text-v1')) {
    throw new Error('El servidor no confirmó la suite guardada.');
  }
  return data;
}

export async function studioEvaluation(draft: GraphDraft, attempt: { runId: string; suiteId: string },
  mode: StudioExecutionMode, request: StudioRequest, timeoutMs?: number, profile: StudioExecutionProfileName = 'linear-text-v1') {
  const endpoint = graphEndpoint(draft.graphId) + '/evaluations';
  const config = executionConfig(draft, request);
  const { data } = timeoutMs === undefined
    ? await api.get<ExecutionEvaluation>(endpoint + '/' + encodeURIComponent(attempt.runId), config)
    : await api.post<ExecutionEvaluation>(endpoint, { ...attempt, timeoutMs }, { ...config, timeout: 65000 });
  return confirmEvaluation(data, draft, attempt, mode, profile);
}

export async function cancelStudioEvaluation(draft: GraphDraft, attempt: { runId: string; suiteId: string },
  mode: StudioExecutionMode, request: StudioRequest, profile: StudioExecutionProfileName = 'linear-text-v1') {
  const endpoint = graphEndpoint(draft.graphId) + '/evaluations/' + encodeURIComponent(attempt.runId) + '/cancel';
  const { data } = await api.post<ExecutionEvaluation>(endpoint, {}, executionConfig(draft, request));
  return confirmEvaluation(data, draft, attempt, mode, profile);
}

function confirmEvaluation(data: ExecutionEvaluation, draft: GraphDraft, attempt: { runId: string; suiteId: string },
  mode: StudioExecutionMode, profile: StudioExecutionProfileName) {
  if (data?.runId !== attempt.runId || data.suiteId !== attempt.suiteId || data.graphId !== draft.graphId ||
      data.version !== draft.version || data.specHash !== draft.specHash || data.mode !== mode ||
      (data.profile ?? 'linear-text-v1') !== profile ||
      (data.admittedScenarioId != null && typeof data.admittedScenarioId !== 'string') ||
      typeof data.passed !== 'boolean' || !['running', 'completed', 'failed', 'cancelled'].includes(data.status) || !Array.isArray(data.scenarios)) {
    throw new Error('El servidor no confirmó una evaluación para esta revisión.');
  }
  if (profile === 'catalog-router-v1' && (data.publicationAllowed !== false || data.publicationEvidence !== false ||
      !data.scenarios.every((scenario) => typeof scenario?.scenarioId === 'string' &&
        ['passed', 'assertion_failed', 'uncertain', 'blocked'].includes(scenario.outcome) &&
        (scenario.executedTools === undefined || (Array.isArray(scenario.executedTools) &&
          scenario.executedTools.every((tool) => tool === 'catalog.search')))))) {
    throw new Error('El servidor no confirmó la evidencia de la evaluación de catálogo.');
  }
  return data;
}

export async function publishStudioRevision(draft: GraphDraft, evaluationId: string, mode: StudioExecutionMode, request: StudioRequest) {
  const { data } = await api.post<StudioPublication>(
    graphEndpoint(draft.graphId) + '/publish', { evaluationId }, executionConfig(draft, request),
  );
  if (!verifiedPublication(data, draft, mode) || data.version !== draft.version || data.evaluationId !== evaluationId) {
    throw new Error('El servidor no confirmó la publicación de esta revisión.');
  }
  return data;
}

export async function executeStudioRevision(draft: GraphDraft, attempt: { attemptId: string; input: string; timeoutMs: number },
  mode: StudioExecutionMode, request: StudioRequest) {
  const { data } = await api.post<{ publication: StudioPublication; execution: { status: string; output?: { text: string } } }>(
    graphEndpoint(draft.graphId) + '/execute', attempt, { ...executionConfig(draft, request), timeout: attempt.timeoutMs + 5000 },
  );
  if (!verifiedPublication(data?.publication, draft, mode) || data.publication.version !== draft.version || typeof data.execution?.status !== 'string') {
    throw new Error('El servidor no confirmó la ejecución de esta revisión.');
  }
  if (data.execution.status !== 'completed' || typeof data.execution.output?.text !== 'string') {
    const messages: Record<string, string> = {
      not_dispatched: 'El intento ya estaba registrado o venció antes del envío. Esta solicitud no generó otro envío.',
      uncertain: 'El resultado quedó sin confirmar. Conservamos el intento para evitar un segundo envío.',
      budget_exhausted: 'La ejecución agotó el presupuesto de la revisión.',
      provider_unavailable: 'La credencial o la política de esta empresa impidieron la ejecución.',
    };
    throw new Error(messages[data.execution.status] ?? 'La ejecución no devolvió texto utilizable.');
  }
  return data.execution.output.text;
}

export type StudioWhatsappBindingMode = 'suggest' | 'auto';

interface StudioWhatsappBinding {
  graphId: string;
  version: number;
  specHash: string;
  mode: StudioWhatsappBindingMode;
  revision: string;
  boundBy: number;
  boundAt: string;
}

export interface StudioWhatsappBindingSnapshot {
  binding: StudioWhatsappBinding | null;
}

const whatsappBindingEndpoint = '/v1/ai/whatsapp-binding';

function confirmBinding(snapshot: StudioWhatsappBindingSnapshot | undefined): StudioWhatsappBindingSnapshot {
  const binding = snapshot?.binding;
  if (binding === null) return { binding };
  if (!binding || typeof binding.graphId !== 'string' || !new RegExp('^' + graphIdPattern + '$').test(binding.graphId) ||
      !Number.isSafeInteger(binding.version) || binding.version < 1 || !/^[0-9a-f]{64}$/.test(binding.specHash) ||
      !['suggest', 'auto'].includes(binding.mode) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(binding.revision) ||
      !Number.isSafeInteger(binding.boundBy) || binding.boundBy < 1 || !Number.isFinite(Date.parse(binding.boundAt))) {
    throw new Error('El servidor no confirmó la revisión vinculada a WhatsApp.');
  }
  return { binding };
}

export async function readStudioWhatsappBinding(request: StudioRequest) {
  const config: AuthRequestConfig = request;
  const { data } = await api.get<StudioWhatsappBindingSnapshot>(whatsappBindingEndpoint, config);
  return confirmBinding(data);
}

export async function bindStudioWhatsapp(draft: GraphDraft, mode: StudioWhatsappBindingMode,
  current: StudioWhatsappBindingSnapshot, request: StudioRequest) {
  const config: AuthRequestConfig = request;
  const { graphId, version, specHash } = draft;
  const { data } = await api.put<StudioWhatsappBindingSnapshot>(whatsappBindingEndpoint, {
    graphId, version, specHash, mode, expectedRevision: current.binding?.revision ?? null,
  }, config);
  const snapshot = confirmBinding(data);
  if (snapshot.binding?.graphId !== graphId || snapshot.binding.version !== version ||
      snapshot.binding.specHash !== specHash || snapshot.binding.mode !== mode) {
    throw new Error('El servidor no confirmó la vinculación seleccionada.');
  }
  return snapshot;
}

export async function unbindStudioWhatsapp(current: StudioWhatsappBindingSnapshot, request: StudioRequest): Promise<StudioWhatsappBindingSnapshot> {
  const config: AuthRequestConfig = { ...request, data: { expectedRevision: current.binding?.revision ?? null } };
  const { status } = await api.delete(whatsappBindingEndpoint, config);
  if (status !== 204) throw new Error('El servidor no confirmó la desvinculación de WhatsApp.');
  return { binding: null };
}
