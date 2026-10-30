import React from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Layers3,
  Loader2,
  MessageSquareText,
  PackageSearch,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TestTube2,
  ToggleLeft,
  ToggleRight,
  X,
  Zap,
} from 'lucide-react';
import RuntimeLogsViewer from '../components/RuntimeLogsViewer';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MessageHeatmap from '../../dashboard/components/MessageHeatmap';
import { dashboardService, type HeatmapByDateMatrix } from '../../dashboard/services/dashboardService';
import {
  agentService,
  type AgentMode,
  type AgentPurpose,
  type AgentActivityTurn,
  type AgentRuntimeResult,
  type AiAgent,
  type AiDomainKey,
  type AiDomainMetrics,
  type AiDomainSummary,
  type AgentKnowledgeSource,
  type AgentProfile,
  type AgentRules,
} from '../services/agentService';

type PageView = 'domains' | 'flow' | 'metrics' | 'agent';
type AgentTab = 'general' | 'knowledge' | 'tools' | 'rules' | 'tests' | 'logs';
type WizardStep = 1 | 2 | 3;
type ToolAccess = NonNullable<AiAgent['toolAccess']>;
type FlowNodeId = 'entry' | 'agent' | 'reply' | 'handoff';

type FlowPosition = {
  x: number;
  y: number;
};

const FLOW_NODE_BOUNDS: Record<FlowNodeId, { width: number; height: number; portY: number }> = {
  entry: { width: 260, height: 76, portY: 38 },
  agent: { width: 300, height: 128, portY: 64 },
  reply: { width: 260, height: 76, portY: 38 },
  handoff: { width: 260, height: 76, portY: 38 },
};

const MODE_LABELS: Record<AgentMode, string> = {
  disabled: 'Manual',
  suggest: 'Asistido',
  auto: 'Automático',
};

const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  disabled: 'No responde ni genera sugerencias. El equipo atiende todo.',
  suggest: 'Prepara sugerencias privadas para que el equipo revise y envie.',
  auto: 'Responde y ejecuta herramientas autorizadas dentro del dominio.',
};

const DOMAIN_META: Record<AiDomainKey, {
  icon: React.ElementType;
  tone: string;
  flow: string[];
}> = {
  gestion_web: {
    icon: MessageSquareText,
    tone: 'bg-[#DDF4EF] text-[#0E766A]',
    flow: ['Mensaje recibido', 'Agente del dominio', 'Respuesta o sugerencia', 'Handoff si requiere humano'],
  },
  inventory_stock: {
    icon: PackageSearch,
    tone: 'bg-[#EEF4F1] text-[#10231C]',
    flow: ['Consulta de oferta', 'Busqueda en inventario', 'Disponibilidad', 'Derivar si falta decision humana'],
  },
  commercial_catalog: {
    icon: Layers3,
    tone: 'bg-[#EEF4F1] text-[#5B6F66]',
    flow: ['Catalogo', 'Secciones', 'Ofertas', 'Recomendacion'],
  },
  orders: {
    icon: FileText,
    tone: 'bg-[#EEF4F1] text-[#5B6F66]',
    flow: ['Prepedido', 'Revision', 'Confirmacion humana', 'Seguimiento'],
  },
  support: {
    icon: ShieldCheck,
    tone: 'bg-[#EEF4F1] text-[#5B6F66]',
    flow: ['Caso', 'Clasificacion', 'Respuesta guiada', 'Cierre'],
  },
  payments: {
    icon: BarChart3,
    tone: 'bg-[#EEF4F1] text-[#5B6F66]',
    flow: ['Pago', 'Validacion', 'Registro', 'Reporte'],
  },
};

const DOMAIN_AGENT_PURPOSE: Record<AiDomainKey, AgentPurpose> = {
  gestion_web: 'general',
  inventory_stock: 'operations',
  commercial_catalog: 'sales_assistant',
  orders: 'order_tracking',
  support: 'support',
  payments: 'operations',
};

const DEFAULT_PROFILE: AgentProfile = {
  businessDescription: '',
  communicationStyle: 'Claro, breve y cercano.',
  sellingScope: '',
  forbiddenClaims: '',
  language: 'es',
  tone: 'profesional',
  style: 'conciso',
  welcomeMessage: '',
};

const DEFAULT_RULES: AgentRules = {
  autoReplyWhen: 'Solo cuando la intencion sea clara y exista contexto suficiente del dominio.',
  suggestWhen: 'Cuando pueda ayudar al equipo con una respuesta o una accion recomendada.',
  handoffWhen: 'Cuando el cliente quiera cerrar una compra, haya baja confianza o falte autorizacion humana.',
  businessHours: {
    enabled: false,
    timezone: 'America/Lima',
    start: '09:00',
    end: '18:00',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  },
  confidenceThreshold: 0.72,
  blockedTopics: [],
  sensitiveTopics: [],
  maxContextMessages: 12,
};

const defaultModuleAccess = (domainKey: AiDomainKey): AiAgent['moduleAccess'] => ({
  catalog: domainKey === 'inventory_stock' || domainKey === 'commercial_catalog',
  orders: domainKey === 'gestion_web' || domainKey === 'orders',
  customerHistory: true,
  tags: true,
  handoff: true,
  paymentsRead: false,
  reportsRead: false,
  commercialState: true,
});

const defaultToolAccess = (domainKey: AiDomainKey): AiAgent['toolAccess'] => ({
  catalogSearch: domainKey === 'inventory_stock' || domainKey === 'commercial_catalog',
  catalogGetItem: domainKey === 'inventory_stock' || domainKey === 'commercial_catalog',
  catalogRecommendAlternatives: domainKey === 'inventory_stock' || domainKey === 'commercial_catalog',
  availabilityCheck: domainKey === 'inventory_stock',
  messageSendProductCard: domainKey === 'inventory_stock' || domainKey === 'commercial_catalog',
  orderUpsertPreorder: domainKey === 'gestion_web' || domainKey === 'orders',
  handoffCreate: true,
  conversationSetCommercialState: true,
  tagApplySystem: true,
  timelineRecord: true,
});

function normalizeAgent(agent: AiAgent): AiAgent {
  return {
    ...agent,
    profile: agent.profile || DEFAULT_PROFILE,
    rules: agent.rules || DEFAULT_RULES,
    moduleAccess: { ...defaultModuleAccess('gestion_web'), ...agent.moduleAccess },
    toolAccess: { ...defaultToolAccess('gestion_web'), ...agent.toolAccess },
    knowledge: agent.knowledge || [],
  };
}

function formatDomainLabel(domain?: AiDomainSummary | null) {
  if (!domain) return 'dominio';
  if (domain.domainKey === 'gestion_web') return 'Gestión Web';
  if (domain.domainKey === 'inventory_stock') return 'Inventario / Stock';
  return domain.label;
}

function formatDate(value?: string | null) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function AiDomainsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [view, setView] = React.useState<PageView>('domains');
  const [domains, setDomains] = React.useState<AiDomainSummary[]>([]);
  const [selectedDomainKey, setSelectedDomainKey] = React.useState<AiDomainKey>('gestion_web');
  const [selectedAgent, setSelectedAgent] = React.useState<AiAgent | null>(null);
  const [activeTab, setActiveTab] = React.useState<AgentTab>('general');
  const [activity, setActivity] = React.useState<AgentActivityTurn[]>([]);
  const [metrics, setMetrics] = React.useState<AiDomainMetrics | null>(null);
  const [heatmap, setHeatmap] = React.useState<HeatmapByDateMatrix | null>(null);
  const [heatmapState, setHeatmapState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showDomainDrawer, setShowDomainDrawer] = React.useState(false);
  const [showCreateAgent, setShowCreateAgent] = React.useState(false);
  const [wizardStep, setWizardStep] = React.useState<WizardStep>(1);
  const [newAgentName, setNewAgentName] = React.useState('');
  const [newAgentMode, setNewAgentMode] = React.useState<AgentMode>('suggest');
  const [newAgentModel, setNewAgentModel] = React.useState('');
  const [knowledgeDraft, setKnowledgeDraft] = React.useState({ title: '', content: '' });
  const [testMessage, setTestMessage] = React.useState('');
  const [testResult, setTestResult] = React.useState<AgentRuntimeResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [operationFilters, setOperationFilters] = React.useState({
    agentId: '',
    status: '',
    tool: '',
    chatId: '',
    dateFrom: '',
    dateTo: '',
  });

  const selectedDomain = React.useMemo(
    () => domains.find((domain) => domain.domainKey === selectedDomainKey) || null,
    [domains, selectedDomainKey]
  );
  const initialDomainKey = searchParams.get('domain') as AiDomainKey | null;
  const initialView = searchParams.get('view');

  const loadDomains = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await agentService.listDomains();
      setDomains(response);
      if (!response.some((domain) => domain.domainKey === selectedDomainKey)) {
        setSelectedDomainKey((response[0]?.domainKey || 'gestion_web') as AiDomainKey);
      }
    } catch (err: unknown) {
      setError(readError(err, 'No se pudieron cargar los dominios.'));
    } finally {
      setLoading(false);
    }
  }, [selectedDomainKey]);

  React.useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  React.useEffect(() => {
    if (!domains.length || initialView !== 'flow' || !initialDomainKey) return;
    if (!domains.some((domain) => domain.domainKey === initialDomainKey)) return;
    setSelectedDomainKey(initialDomainKey);
    setView('flow');
    loadActivity(initialDomainKey);
  }, [domains, initialDomainKey, initialView]);

  const loadActivity = async (domainKey = selectedDomainKey) => {
    try {
      const response = await agentService.listDomainOperations(domainKey, {
        agentId: operationFilters.agentId ? Number(operationFilters.agentId) : null,
        status: operationFilters.status || undefined,
        tool: operationFilters.tool || undefined,
        chatId: operationFilters.chatId || undefined,
        dateFrom: operationFilters.dateFrom || undefined,
        dateTo: operationFilters.dateTo || undefined,
        limit: 100,
      });
      setActivity(response);
    } catch {
      setActivity([]);
    }
  };

  const openFlow = async (domainKey: AiDomainKey) => {
    setSelectedDomainKey(domainKey);
    setSelectedAgent(null);
    setMetrics(null);
    setView('flow');
    await loadActivity(domainKey);
  };

  const openMetrics = async () => {
    setView('metrics');
    setMetrics(null);
    setHeatmap(null);
    setHeatmapState('loading');
    setLoading(true);
    try {
      const heatmapRequest = dashboardService
        .getHeatmap(7)
        .then((response) => {
          setHeatmap(response);
          setHeatmapState('ready');
        })
        .catch(() => {
          setHeatmapState('error');
        });
      const [metricResponse, activityResponse] = await Promise.all([
        agentService.getDomainMetrics(selectedDomainKey),
        agentService.listDomainOperations(selectedDomainKey, {
          agentId: operationFilters.agentId ? Number(operationFilters.agentId) : null,
          status: operationFilters.status || undefined,
          tool: operationFilters.tool || undefined,
          chatId: operationFilters.chatId || undefined,
          dateFrom: operationFilters.dateFrom || undefined,
          dateTo: operationFilters.dateTo || undefined,
          limit: 100,
        }),
        heatmapRequest,
      ]);
      setMetrics(metricResponse);
      setActivity(activityResponse);
    } catch (err: unknown) {
      setError(readError(err, 'No se pudieron cargar las métricas.'));
    } finally {
      setLoading(false);
    }
  };

  const openAgentConfig = async () => {
    navigate(`/dashboard/ia/agentes?domain=${selectedDomainKey}`);
  };

  const activateDomain = async (domainKey: AiDomainKey) => {
    setSaving(true);
    setError(null);
    try {
      await agentService.activateDomain(domainKey);
      await loadDomains();
      setMessage('Dominio activado.');
      setShowDomainDrawer(false);
      await openFlow(domainKey);
    } catch (err: unknown) {
      setError(readError(err, 'No se pudo activar el dominio.'));
    } finally {
      setSaving(false);
    }
  };

  const createAndAssignAgent = async () => {
    if (!newAgentName.trim()) {
      setError('Escribe un nombre para el agente.');
      setWizardStep(2);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await agentService.create({
        name: newAgentName.trim(),
        status: 'active',
        mode: newAgentMode,
        model: newAgentModel.trim() || undefined,
        purpose: DOMAIN_AGENT_PURPOSE[selectedDomainKey],
        domainKey: selectedDomainKey,
        moduleAccess: defaultModuleAccess(selectedDomainKey),
        toolAccess: defaultToolAccess(selectedDomainKey),
        catalogScope: { catalogIds: [], sectionIds: [] },
        triggerRules: {},
        autoConfirmOrders: false,
        autoCreateVouchers: false,
        autoGeneratePaymentLinks: false,
        profile: DEFAULT_PROFILE,
        rules: DEFAULT_RULES,
      });

      await loadDomains();
      setSelectedAgent(normalizeAgent(await agentService.get(created.id)));
      setShowCreateAgent(false);
      setActiveTab('general');
      setView('agent');
      setMessage('Agente creado y asignado al dominio.');
    } catch (err: unknown) {
      setError(readError(err, 'No se pudo crear el agente.'));
    } finally {
      setSaving(false);
    }
  };

  const saveAgent = async () => {
    if (!selectedAgent) return;

    setSaving(true);
    setError(null);
    try {
      const updated = await agentService.update(selectedAgent.id, {
        name: selectedAgent.name,
        status: selectedAgent.status,
        mode: selectedAgent.mode,
        provider: selectedAgent.provider,
        model: selectedAgent.model,
        moduleAccess: selectedAgent.moduleAccess,
        toolAccess: selectedAgent.toolAccess,
        catalogScope: selectedAgent.catalogScope,
        triggerRules: selectedAgent.triggerRules,
        autoConfirmOrders: false,
        autoCreateVouchers: false,
        autoGeneratePaymentLinks: false,
      });

      if (selectedAgent.profile) await agentService.updateProfile(selectedAgent.id, selectedAgent.profile);
      if (selectedAgent.rules) await agentService.updateRules(selectedAgent.id, selectedAgent.rules);

      setSelectedAgent(normalizeAgent(await agentService.get(updated.id)));
      await loadDomains();
      setMessage('Configuración guardada.');
    } catch (err: unknown) {
      setError(readError(err, 'No se pudo guardar el agente.'));
    } finally {
      setSaving(false);
    }
  };

  const addKnowledge = async () => {
    if (!selectedAgent || !knowledgeDraft.title.trim() || !knowledgeDraft.content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await agentService.createKnowledge(selectedAgent.id, {
        title: knowledgeDraft.title.trim(),
        content: knowledgeDraft.content.trim(),
        sourceType: 'document',
        enabled: true,
      });
      setSelectedAgent(normalizeAgent(await agentService.get(selectedAgent.id)));
      setKnowledgeDraft({ title: '', content: '' });
      setMessage('Conocimiento agregado.');
    } catch (err: unknown) {
      setError(readError(err, 'No se pudo agregar el conocimiento.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleKnowledge = async (source: AgentKnowledgeSource) => {
    if (!selectedAgent) return;
    await agentService.updateKnowledge(selectedAgent.id, source.id, { enabled: !source.enabled });
    setSelectedAgent(normalizeAgent(await agentService.get(selectedAgent.id)));
  };

  const deleteKnowledge = async (source: AgentKnowledgeSource) => {
    if (!selectedAgent) return;
    await agentService.deleteKnowledge(selectedAgent.id, source.id);
    setSelectedAgent(normalizeAgent(await agentService.get(selectedAgent.id)));
  };

  const runTest = async () => {
    if (!selectedAgent || !testMessage.trim()) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const response = await agentService.test(selectedAgent.id, testMessage.trim());
      setTestResult(response);
    } catch (err: unknown) {
      setError(readError(err, 'No se pudo ejecutar la prueba.'));
    } finally {
      setTesting(false);
    }
  };

  const patchAgent = (patch: Partial<AiAgent>) => {
    setSelectedAgent((current) => current ? { ...current, ...patch } : current);
  };

  const patchProfile = (patch: Partial<AgentProfile>) => {
    setSelectedAgent((current) => current ? {
      ...current,
      profile: { ...(current.profile || DEFAULT_PROFILE), ...patch },
    } : current);
  };

  const patchRules = (patch: Partial<AgentRules>) => {
    setSelectedAgent((current) => current ? {
      ...current,
      rules: { ...(current.rules || DEFAULT_RULES), ...patch },
    } : current);
  };

  const toggleModule = (key: keyof AiAgent['moduleAccess']) => {
    setSelectedAgent((current) => current ? {
      ...current,
      moduleAccess: {
        ...current.moduleAccess,
        [key]: !current.moduleAccess?.[key],
      },
    } : current);
  };

  const toggleTool = (key: keyof ToolAccess) => {
    setSelectedAgent((current) => current ? {
      ...current,
      toolAccess: {
        ...current.toolAccess,
        [key]: !current.toolAccess?.[key],
      },
    } : current);
  };

  return (
    <div className="min-h-full bg-[#F7FAF8] text-[#10231C] dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 md:p-6">
        <StatusMessages message={message} error={error} onClear={() => { setMessage(null); setError(null); }} />
        {view === 'domains' && (
          <DomainsHome
            domains={domains}
            loading={loading}
            onOpenFlow={openFlow}
            onOpenDrawer={() => setShowDomainDrawer(true)}
            onReload={loadDomains}
          />
        )}
        {view === 'flow' && selectedDomain && (
          <DomainFlow
            domain={selectedDomain}
            activity={activity}
            onBack={() => setView('domains')}
            onMetrics={openMetrics}
            onConfig={openAgentConfig}
            onReload={() => loadActivity(selectedDomainKey)}
          />
        )}
        {view === 'metrics' && selectedDomain && (
          <DomainMetrics
            domain={selectedDomain}
            metrics={metrics}
            heatmap={heatmap}
            heatmapState={heatmapState}
            activity={activity}
            operationFilters={operationFilters}
            onOperationFilters={setOperationFilters}
            loading={loading}
            onBack={() => setView('flow')}
            onDomains={() => setView('domains')}
            onReload={openMetrics}
          />
        )}
        {view === 'agent' && selectedDomain && selectedAgent && (
          <AgentConfig
            domain={selectedDomain}
            agent={selectedAgent}
            activeTab={activeTab}
            saving={saving}
            testing={testing}
            knowledgeDraft={knowledgeDraft}
            testMessage={testMessage}
            testResult={testResult}
            onBack={() => setView('flow')}
            onSave={saveAgent}
            onTab={setActiveTab}
            onPatchAgent={patchAgent}
            onPatchProfile={patchProfile}
            onPatchRules={patchRules}
            onToggleModule={toggleModule}
            onToggleTool={toggleTool}
            onKnowledgeDraft={setKnowledgeDraft}
            onAddKnowledge={addKnowledge}
            onToggleKnowledge={toggleKnowledge}
            onDeleteKnowledge={deleteKnowledge}
            onTestMessage={setTestMessage}
            onRunTest={runTest}
          />
        )}
      </div>

      {showDomainDrawer && (
        <DomainDrawer
          domains={domains}
          saving={saving}
          onClose={() => setShowDomainDrawer(false)}
          onActivate={activateDomain}
        />
      )}

      {showCreateAgent && selectedDomain && (
        <CreateAgentModal
          domain={selectedDomain}
          step={wizardStep}
          saving={saving}
          name={newAgentName}
          mode={newAgentMode}
          model={newAgentModel}
          onClose={() => setShowCreateAgent(false)}
          onStep={setWizardStep}
          onName={setNewAgentName}
          onMode={setNewAgentMode}
          onModel={setNewAgentModel}
          onCreate={createAndAssignAgent}
        />
      )}
    </div>
  );
}

function DomainsHome({
  domains,
  loading,
  onOpenFlow,
  onOpenDrawer,
  onReload,
}: {
  domains: AiDomainSummary[];
  loading: boolean;
  onOpenFlow: (domainKey: AiDomainKey) => void;
  onOpenDrawer: () => void;
  onReload: () => void;
}) {
  const visibleDomains = domains.filter((domain) => ['gestion_web', 'inventory_stock'].includes(domain.domainKey));

  return (
    <>
      <PageHeader
        eyebrow="IA"
        title="Dominios IA"
        description="Gestiona donde operan tus agentes y que flujo atienden dentro del sistema."
        actions={(
          <>
            <GhostButton onClick={onReload} icon={RefreshCw}>Actualizar</GhostButton>
            <PrimaryButton onClick={onOpenDrawer} icon={Plus}>Añadir dominio</PrimaryButton>
          </>
        )}
      />

      {loading ? (
        <LoadingPanel label="Cargando dominios..." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {visibleDomains.map((domain) => (
            <DomainCard key={domain.domainKey} domain={domain} onOpen={() => onOpenFlow(domain.domainKey)} />
          ))}

          <button
            type="button"
            onClick={onOpenDrawer}
            className="flex min-h-[250px] flex-col items-center justify-center rounded-xl border border-dashed border-[#9DB7AE] bg-white p-6 text-center transition hover:border-[#128C7E] hover:bg-[#F7FAF8] dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-500"
          >
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#EEF4F1] text-[#128C7E] dark:bg-emerald-950/40 dark:text-emerald-300">
              <Plus className="h-6 w-6" />
            </span>
            <span className="text-base font-bold text-[#10231C] dark:text-slate-100">Añadir dominio</span>
            <span className="mt-2 max-w-xs text-sm text-[#5B6F66] dark:text-slate-400">
              Activa dominios predefinidos cuando el sistema ya tenga soporte para ese flujo.
            </span>
          </button>
        </div>
      )}
    </>
  );
}

function DomainCard({ domain, onOpen }: { domain: AiDomainSummary; onOpen: () => void }) {
  const meta = DOMAIN_META[domain.domainKey];
  const Icon = meta.icon;
  const assignedAgent = domain.assignedAgent;

  return (
    <section className="flex min-h-[250px] flex-col rounded-xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${meta.tone}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#10231C] dark:text-slate-100">{domain.label}</h2>
            <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">{domain.description}</p>
          </div>
        </div>
        <StatusBadge status={domain.status} />
      </div>

      <div className="mt-5 rounded-xl bg-[#F7FAF8] p-4 dark:bg-slate-950">
        <p className="text-xs font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-400">Agente asignado</p>
        {assignedAgent ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-[#10231C] dark:text-slate-100">{assignedAgent.name}</p>
              <p className="text-sm text-[#5B6F66] dark:text-slate-400">
                {MODE_LABELS[assignedAgent.mode]} · {assignedAgent.status === 'active' ? 'Activo' : 'No activo'}
              </p>
            </div>
            <span className="rounded-full bg-[#DDF4EF] px-3 py-1 text-xs font-bold text-[#0E766A] dark:bg-emerald-950/50 dark:text-emerald-300">
              Asignado
            </span>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[#5B6F66] dark:text-slate-400">
            Todavia no hay agente en este dominio.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-auto inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#128C7E] px-4 text-sm font-bold text-white transition hover:bg-[#0E766A]"
      >
        Configurar dominio
        <ChevronRight className="h-4 w-4" />
      </button>
    </section>
  );
}

function DomainFlow({
  domain,
  activity,
  onBack,
  onMetrics,
  onConfig,
  onReload,
}: {
  domain: AiDomainSummary;
  activity: AgentActivityTurn[];
  onBack: () => void;
  onMetrics: () => void;
  onConfig: () => void;
  onReload: () => void;
}) {
  const agentName = domain.assignedAgent?.name || 'Agente sin asignar';
  const domainLabel = formatDomainLabel(domain);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{ id: FlowNodeId; offsetX: number; offsetY: number } | null>(null);
  const [nodePositions, setNodePositions] = React.useState<Record<FlowNodeId, FlowPosition>>({
    entry: { x: 60, y: 235 },
    agent: { x: 420, y: 215 },
    reply: { x: 820, y: 135 },
    handoff: { x: 820, y: 335 },
  });

  React.useEffect(() => {
    const moveNode = (event: PointerEvent) => {
      const activeDrag = dragRef.current;
      const canvas = canvasRef.current;
      if (!activeDrag || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const bounds = FLOW_NODE_BOUNDS[activeDrag.id];
      const nextX = event.clientX - rect.left - activeDrag.offsetX;
      const nextY = event.clientY - rect.top - activeDrag.offsetY;

      setNodePositions((current) => ({
        ...current,
        [activeDrag.id]: {
          x: Math.max(24, Math.min(rect.width - bounds.width - 24, nextX)),
          y: Math.max(96, Math.min(rect.height - bounds.height - 140, nextY)),
        },
      }));
    };

    const stopDrag = () => {
      dragRef.current = null;
    };

    window.addEventListener('pointermove', moveNode);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    return () => {
      window.removeEventListener('pointermove', moveNode);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };
  }, []);

  const startDrag = (id: FlowNodeId, event: React.PointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const position = nodePositions[id];
    dragRef.current = {
      id,
      offsetX: event.clientX - rect.left - position.x,
      offsetY: event.clientY - rect.top - position.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const portPoint = (id: FlowNodeId, side: 'left' | 'right') => {
    const position = nodePositions[id];
    const bounds = FLOW_NODE_BOUNDS[id];
    return {
      x: side === 'right' ? position.x + bounds.width : position.x,
      y: position.y + bounds.portY,
    };
  };

  const entryOut = portPoint('entry', 'right');
  const agentIn = portPoint('agent', 'left');
  const agentOut = portPoint('agent', 'right');
  const replyIn = portPoint('reply', 'left');
  const handoffIn = portPoint('handoff', 'left');
  const connectorPath = (from: FlowPosition, to: FlowPosition) => {
    const distance = Math.max(80, Math.abs(to.x - from.x) * 0.45);
    return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#5B6F66] dark:text-slate-400">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg px-2 py-1 text-[#128C7E] transition hover:bg-[#DDF4EF] dark:text-emerald-300 dark:hover:bg-emerald-950/30"
          >
            Dominio
          </button>
          <ChevronRight className="h-4 w-4 text-[#9DB7AE]" />
          <span className="rounded-lg bg-[#EEF4F1] px-2 py-1 text-[#10231C] dark:bg-slate-800 dark:text-slate-100">{domainLabel}</span>
        </div>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <p className="max-w-3xl text-base leading-7 text-[#5B6F66] dark:text-slate-400">{domain.description}</p>
          <div className="flex shrink-0 items-center gap-2">
            <GhostButton onClick={onMetrics} icon={BarChart3}>Métricas</GhostButton>
            <PrimaryButton onClick={onConfig} icon={Settings2}>Configurar</PrimaryButton>
          </div>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-[#D9E5DF] bg-[#EEF4F1] shadow-inner dark:border-slate-800 dark:bg-slate-950">
        <div
          ref={canvasRef}
          className="relative h-[600px] min-w-[1120px]"
          style={{
            backgroundImage: 'radial-gradient(#bdc9c5 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            backgroundPosition: '-12px -12px',
          }}
        >
          <svg className="absolute inset-0 h-full w-full">
            {[connectorPath(entryOut, agentIn), connectorPath(agentOut, replyIn), connectorPath(agentOut, handoffIn)].map((path, index) => (
              <path
                key={index}
                d={path}
                fill="none"
                stroke="#128C7E"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.25"
              />
            ))}
            {[entryOut, agentIn, agentOut, replyIn, handoffIn].map((point, index) => (
              <React.Fragment key={`${point.x}-${point.y}-${index}`}>
                <circle className="animate-ping" cx={point.x} cy={point.y} fill="#128C7E" r="3" />
                <circle cx={point.x} cy={point.y} fill="#128C7E" r="4" />
              </React.Fragment>
            ))}
          </svg>

          <FlowNode
            x={nodePositions.entry.x}
            y={nodePositions.entry.y}
            title="Entrada de Usuario"
            subtitle="WhatsApp / Web"
            icon={MessageSquareText}
            portSide="right"
            onPointerDown={(event) => startDrag('entry', event)}
          >
            <div className="absolute -bottom-[118px] left-0 z-30 w-[280px] rounded-lg border border-[#D9E5DF] bg-white p-3 shadow-md dark:border-slate-700 dark:bg-slate-900">
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold">
                <span className="text-[#10231C] dark:text-slate-100">Cliente Web</span>
                <span className="text-[#5B6F66] dark:text-slate-400">10:42 AM</span>
              </div>
              <p className="text-xs leading-5 text-[#10231C] dark:text-slate-200">
                Hola, necesito saber si tienen disponibilidad y si me pueden ayudar ahora.
              </p>
            </div>
          </FlowNode>

          <div
            onPointerDown={(event) => startDrag('agent', event)}
            className="absolute z-20 w-[300px] cursor-move select-none rounded-lg border-2 border-[#128C7E] bg-white shadow-md dark:bg-slate-900"
            style={{ left: nodePositions.agent.x, top: nodePositions.agent.y }}
          >
            <span className="absolute -left-2 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-[#128C7E]" />
            <span className="absolute -right-2 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#128C7E] bg-white dark:bg-slate-900" />
            <div className="flex items-center gap-3 rounded-t-md border-b border-[#D9E5DF] bg-[#DDF4EF] p-3 dark:border-slate-700 dark:bg-emerald-950/30">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#128C7E] text-white">
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="truncate text-sm font-bold text-[#10231C] dark:text-slate-100">{agentName}</h4>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#128C7E]/20 bg-white px-2 py-0.5 text-[10px] font-bold text-[#128C7E] dark:bg-slate-950">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#128C7E]" />
                    Procesando
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[#5B6F66] dark:text-slate-400">Dominio {domainLabel}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <MiniSignal label="Intención" value={domain.domainKey === 'inventory_stock' ? 'Consulta stock' : 'Atención cliente'} />
              <MiniSignal label="Contexto" value="Historial + reglas" />
            </div>
            <div className="absolute -top-[96px] left-1/2 z-30 w-[320px] -translate-x-1/2 rounded-lg border border-[#D9E5DF] bg-white/95 p-3 shadow-md backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
              <div className="mb-2 flex items-center gap-2 border-b border-[#D9E5DF] pb-2 text-xs font-bold text-[#10231C] dark:border-slate-700 dark:text-slate-100">
                <CheckCircle2 className="h-4 w-4 text-[#128C7E]" />
                Resolución asistida
              </div>
              <ul className="space-y-1 text-[11px] leading-4 text-[#5B6F66] dark:text-slate-400">
                <li><span className="font-bold text-[#128C7E]">•</span> Contexto del dominio detectado.</li>
                <li><span className="font-bold text-[#128C7E]">•</span> Herramientas y reglas listas para auditar.</li>
              </ul>
            </div>
          </div>

          <FlowNode
            x={nodePositions.reply.x}
            y={nodePositions.reply.y}
            title="Respuesta / sugerencia"
            subtitle="Resolución directa"
            icon={CheckCircle2}
            portSide="left"
            onPointerDown={(event) => startDrag('reply', event)}
          >
            <div className="absolute -right-[280px] top-0 z-30 hidden w-[260px] rounded-lg rounded-tl-none border border-[#128C7E]/20 bg-[#DDF4EF] p-3 shadow-sm group-hover:block dark:bg-emerald-950/40">
              <div className="mb-1 flex justify-end gap-1 text-[10px] font-semibold text-[#128C7E]">
                <span>{agentName}</span>
                <span>10:42 AM</span>
              </div>
              <p className="text-right text-xs leading-5 text-[#10231C] dark:text-slate-100">
                Claro, puedo ayudarte con esa información y dejar la acción registrada.
              </p>
            </div>
          </FlowNode>

          <FlowNode
            x={nodePositions.handoff.x}
            y={nodePositions.handoff.y}
            title="Handoff humano"
            subtitle="Derivación operativa"
            icon={ShieldCheck}
            portSide="left"
            onPointerDown={(event) => startDrag('handoff', event)}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <section className="rounded-xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-bold text-[#10231C] dark:text-slate-100">
              <Activity className="h-5 w-5 text-[#128C7E]" />
              Actividad en tiempo real
            </h3>
            <span className="text-xs font-semibold text-[#5B6F66] dark:text-slate-400">Última actualización reciente</span>
          </div>
          <div className="space-y-3">
            {(activity.length ? activity.slice(0, 3) : defaultActivity(domainLabel, agentName)).map((item, index) => (
              <LiveFeedItem key={`${item.id || index}-${item.startedAt || index}`} item={item} agentName={agentName} />
            ))}
          </div>
        </section>
        <ActivityPanel activity={activity} onReload={onReload} />
      </div>
    </>
  );
}

function DomainMetrics({
  domain,
  metrics,
  heatmap,
  heatmapState,
  activity,
  operationFilters,
  onOperationFilters,
  loading,
  onBack,
  onDomains,
  onReload,
}: {
  domain: AiDomainSummary;
  metrics: AiDomainMetrics | null;
  heatmap: HeatmapByDateMatrix | null;
  heatmapState: 'loading' | 'ready' | 'error';
  activity: AgentActivityTurn[];
  operationFilters: {
    agentId: string;
    status: string;
    tool: string;
    chatId: string;
    dateFrom: string;
    dateTo: string;
  };
  onOperationFilters: React.Dispatch<React.SetStateAction<{
    agentId: string;
    status: string;
    tool: string;
    chatId: string;
    dateFrom: string;
    dateTo: string;
  }>>;
  loading: boolean;
  onBack: () => void;
  onDomains: () => void;
  onReload: () => void;
}) {
  const activeSessions = metrics?.activeSessions || 0;
  const turns = metrics?.turns || 0;
  const commands = metrics?.commands || 0;
  const assists = (metrics?.suggestions || 0) + (metrics?.autoReplies || 0);

  return (
    <>
      <header className="flex flex-col gap-3">
        <nav className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#5B6F66] dark:text-slate-400">
          <button
            type="button"
            onClick={onDomains}
            className="rounded-lg px-2 py-1 text-[#128C7E] transition hover:bg-[#DDF4EF] dark:text-emerald-300 dark:hover:bg-emerald-950/30"
          >
            Dominio
          </button>
          <ChevronRight className="h-4 w-4 text-[#9DB7AE]" />
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg px-2 py-1 text-[#128C7E] transition hover:bg-[#DDF4EF] dark:text-emerald-300 dark:hover:bg-emerald-950/30"
          >
            {formatDomainLabel(domain)}
          </button>
          <ChevronRight className="h-4 w-4 text-[#9DB7AE]" />
          <span className="rounded-lg bg-[#EEF4F1] px-2 py-1 text-[#10231C] dark:bg-slate-800 dark:text-slate-100">
            Métricas
          </span>
        </nav>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <p className="max-w-3xl text-base leading-7 text-[#5B6F66] dark:text-slate-400">
            Monitorea rendimiento, señales operativas y estado del agente asignado en este dominio.
          </p>
          <div className="flex items-center gap-2">
            <GhostButton onClick={onBack} icon={ArrowLeft}>Volver al flujo</GhostButton>
            <GhostButton onClick={onReload} icon={RefreshCw}>Actualizar</GhostButton>
          </div>
        </div>
      </header>

      {loading && !metrics ? (
        <LoadingPanel label="Cargando métricas..." />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid items-start gap-5 lg:grid-cols-[380px_1fr]">
            <section className="flex flex-col gap-4 rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b border-[#D9E5DF] pb-4 dark:border-slate-800">
                <h2 className="flex items-center gap-2 text-lg font-bold text-[#10231C] dark:text-slate-100">
                  <Activity className="h-5 w-5 animate-pulse text-[#128C7E]" />
                  Registro de operaciones
                </h2>
                <span className="inline-flex items-center gap-2 rounded-full bg-[#E4FBEF] px-3 py-1 text-xs font-bold text-[#128C7E] dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="h-2 w-2 animate-ping rounded-full bg-[#128C7E]" />
                  En vivo
                </span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  value={operationFilters.agentId}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, agentId: event.target.value }))}
                  className="input"
                  placeholder="Agente ID"
                />
                <select
                  value={operationFilters.status}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, status: event.target.value }))}
                  className="input"
                >
                  <option value="">Todos los status</option>
                  <option value="running">running</option>
                  <option value="ok">ok</option>
                  <option value="skipped">skipped</option>
                  <option value="failed">failed</option>
                </select>
                <input
                  value={operationFilters.tool}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, tool: event.target.value }))}
                  className="input"
                  placeholder="Tool"
                />
                <input
                  value={operationFilters.chatId}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, chatId: event.target.value }))}
                  className="input"
                  placeholder="Chat"
                />
                <input
                  type="date"
                  value={operationFilters.dateFrom}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, dateFrom: event.target.value }))}
                  className="input"
                />
                <input
                  type="date"
                  value={operationFilters.dateTo}
                  onChange={(event) => onOperationFilters((current) => ({ ...current, dateTo: event.target.value }))}
                  className="input"
                />
              </div>
              <div className="max-h-[315px] space-y-3 overflow-y-auto pr-1">
                {(activity.length ? activity : defaultActivity(formatDomainLabel(domain), domain.assignedAgent?.name || 'Agente')).map((item, index) => (
                  <LiveFeedItem key={`${item.id || index}-${item.startedAt || index}`} item={item} agentName={domain.assignedAgent?.name || 'Agente'} />
                ))}
              </div>
            </section>

            <MessageHeatmap
              data={heatmap}
              loadState={heatmapState}
              footer={(
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricPill label="Turnos ejecutados" value={turns} />
                  <MetricPill label="Dry-run pruebas" value={metrics?.dryRuns || 0} />
                  <MetricPill label="Auto-respuestas" value={metrics?.autoReplies || 0} />
                  <MetricPill label="Errores" value={metrics?.errors || 0} />
                </div>
              )}
            />
          </div>

          <section className="rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-[#D9E5DF] pb-4 dark:border-slate-800">
              <h2 className="flex items-center gap-2 text-lg font-bold text-[#10231C] dark:text-slate-100">
                <BarChart3 className="h-5 w-5 text-[#128C7E]" />
                Impacto del dominio
              </h2>
              <span className="text-sm font-semibold text-[#5B6F66] dark:text-slate-400">Últimos 7 días</span>
            </div>
            <div className="mt-5 grid gap-6 md:grid-cols-3">
              <ImpactMetric label="Sesiones activas" value={activeSessions} color="#128C7E" bars={[30, 50, 40, 70, 60, 90, 100]} />
              <ImpactMetric label="Asistencias exitosas" value={assists} color="#006d2f" bars={[20, 40, 50, 45, 70, 65, 85]} />
              <ImpactMetric label="Comandos auditados" value={commands} color="#ba1a1a" bars={[40, 30, 50, 20, 30, 10, 15]} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ImpactMetric({ label, value, color, bars }: { label: string; value: string | number; color: string; bars: number[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-[#5B6F66] dark:text-slate-400">{label}</span>
      <span className="text-3xl font-bold text-[#10231C] dark:text-slate-100">{value}</span>
      <div className="mt-2 flex h-16 items-end gap-1">
        {bars.map((height, index) => (
          <div
            key={`${label}-${index}`}
            className="w-full rounded-t-sm"
            style={{ height: `${height}%`, backgroundColor: color, opacity: 0.25 + (index / bars.length) * 0.75 }}
          />
        ))}
      </div>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-800 dark:bg-slate-950">
      <p className="text-xs font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-bold text-[#10231C] dark:text-slate-100">{value}</p>
    </div>
  );
}

function FlowNode({
  x,
  y,
  title,
  subtitle,
  icon: Icon,
  portSide,
  onPointerDown,
  children,
}: {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  portSide: 'left' | 'right';
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="group absolute z-10 w-[260px] cursor-move select-none rounded-lg border border-[#D9E5DF] bg-white shadow-sm transition hover:border-[#128C7E] dark:border-slate-700 dark:bg-slate-900"
      style={{ left: x, top: y }}
    >
      <span
        className={`absolute top-1/2 z-20 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-[#128C7E] bg-white dark:bg-slate-900 ${
          portSide === 'right' ? '-right-2' : '-left-2'
        }`}
      />
      <div className="flex items-center gap-3 rounded-t-lg border-b border-[#D9E5DF] bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EEF4F1] text-[#128C7E] dark:bg-slate-800 dark:text-emerald-300">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h4 className="text-sm font-bold text-[#10231C] dark:text-slate-100">{title}</h4>
          <p className="text-[11px] font-semibold text-[#5B6F66] dark:text-slate-400">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function MiniSignal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#D9E5DF] bg-[#F7FAF8] p-2 dark:border-slate-700 dark:bg-slate-950">
      <span className="block text-[10px] font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-500">{label}</span>
      <span className="mt-1 flex items-center gap-1 text-xs font-bold text-[#10231C] dark:text-slate-100">
        <SearchIcon />
        {value}
      </span>
    </div>
  );
}

function SearchIcon() {
  return <span className="h-1.5 w-1.5 rounded-full bg-[#128C7E]" />;
}

function defaultActivity(domainLabel: string, agentName: string): AgentActivityTurn[] {
  return [
    {
      id: -1,
      sessionId: -1,
      agentId: null,
      agentName,
      inboundProviderMessageId: null,
      status: 'ok',
      finalAction: 'suggest',
      finalReplyPreview: `${agentName} formuló un borrador para ${domainLabel}.`,
      commandCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      commands: [],
    },
    {
      id: -2,
      sessionId: -2,
      agentId: null,
      agentName,
      inboundProviderMessageId: null,
      status: 'ok',
      finalAction: 'none',
      finalReplyPreview: 'La conversación fue clasificada y quedó registrada en trazabilidad.',
      commandCount: 0,
      startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      commands: [],
    },
    {
      id: -3,
      sessionId: -3,
      agentId: null,
      agentName,
      inboundProviderMessageId: null,
      status: 'ok',
      finalAction: 'handoff',
      finalReplyPreview: 'El sistema revisó si correspondía derivar a una persona.',
      commandCount: 0,
      startedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      commands: [],
    },
  ];
}

function LiveFeedItem({ item, agentName }: { item: AgentActivityTurn; agentName: string }) {
  const title = item.finalAction !== 'none' ? `Turno ${item.finalAction}` : `Turno ${item.status}`;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-transparent p-3 transition hover:border-[#D9E5DF] hover:bg-[#EEF4F1] dark:hover:border-slate-700 dark:hover:bg-slate-800/70">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#DDF4EF] text-[#128C7E] dark:bg-emerald-950/40 dark:text-emerald-300">
        <Activity className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <h4 className="truncate text-sm font-bold text-[#10231C] dark:text-slate-100">{title}</h4>
          <span className="shrink-0 text-xs text-[#5B6F66] dark:text-slate-500">{formatDate(item.startedAt)}</span>
        </div>
        <p className="mt-1 text-sm leading-5 text-[#5B6F66] dark:text-slate-400">
          {item.finalReplyPreview || `Procesado por ${item.agentName || agentName}.`} · {item.commandCount} comandos
        </p>
      </div>
    </div>
  );
}

function AgentConfig({
  domain,
  agent,
  activeTab,
  saving,
  testing,
  knowledgeDraft,
  testMessage,
  testResult,
  onBack,
  onSave,
  onTab,
  onPatchAgent,
  onPatchProfile,
  onPatchRules,
  onToggleModule,
  onToggleTool,
  onKnowledgeDraft,
  onAddKnowledge,
  onToggleKnowledge,
  onDeleteKnowledge,
  onTestMessage,
  onRunTest,
}: {
  domain: AiDomainSummary;
  agent: AiAgent;
  activeTab: AgentTab;
  saving: boolean;
  testing: boolean;
  knowledgeDraft: { title: string; content: string };
  testMessage: string;
  testResult: AgentRuntimeResult | null;
  onBack: () => void;
  onSave: () => void;
  onTab: (tab: AgentTab) => void;
  onPatchAgent: (patch: Partial<AiAgent>) => void;
  onPatchProfile: (patch: Partial<AgentProfile>) => void;
  onPatchRules: (patch: Partial<AgentRules>) => void;
  onToggleModule: (key: keyof AiAgent['moduleAccess']) => void;
  onToggleTool: (key: keyof ToolAccess) => void;
  onKnowledgeDraft: (value: { title: string; content: string }) => void;
  onAddKnowledge: () => void;
  onToggleKnowledge: (source: AgentKnowledgeSource) => void;
  onDeleteKnowledge: (source: AgentKnowledgeSource) => void;
  onTestMessage: (value: string) => void;
  onRunTest: () => void;
}) {
  const tabs: Array<{ key: AgentTab; label: string; icon: React.ElementType }> = [
    { key: 'general', label: 'General', icon: Settings2 },
    { key: 'knowledge', label: 'Conocimiento', icon: BookOpen },
    { key: 'tools', label: 'Herramientas', icon: SlidersHorizontal },
    { key: 'rules', label: 'Reglas', icon: ShieldCheck },
    { key: 'tests', label: 'Pruebas', icon: TestTube2 },
    { key: 'logs', label: 'Logs', icon: Activity },
  ];

  return (
    <>
      <BackButton onClick={onBack}>Volver al flujo</BackButton>
      <PageHeader
        eyebrow={`IA / ${formatDomainLabel(domain)} / Configuración`}
        title={agent.name}
        description={`Asignado a ${formatDomainLabel(domain)}. El agente solo opera dentro de este dominio.`}
        actions={<PrimaryButton onClick={onSave} icon={saving ? Loader2 : Save} disabled={saving}>{saving ? 'Guardando...' : 'Guardar cambios'}</PrimaryButton>}
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <section className="rounded-xl border border-[#D9E5DF] bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap gap-2 border-b border-[#D9E5DF] px-4 pt-4 dark:border-slate-800">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => onTab(tab.key)}
                  className={`inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-bold transition ${
                    active
                      ? 'border-[#128C7E] text-[#128C7E]'
                      : 'border-transparent text-[#5B6F66] hover:text-[#10231C] dark:text-slate-400 dark:hover:text-slate-100'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="p-5">
            {activeTab === 'general' && (
              <GeneralTab
                domain={domain}
                agent={agent}
                onPatchAgent={onPatchAgent}
                onPatchProfile={onPatchProfile}
              />
            )}
            {activeTab === 'knowledge' && (
              <KnowledgeTab
                agent={agent}
                draft={knowledgeDraft}
                onDraft={onKnowledgeDraft}
                onAdd={onAddKnowledge}
                onToggle={onToggleKnowledge}
                onDelete={onDeleteKnowledge}
              />
            )}
            {activeTab === 'tools' && (
              <ToolsTab agent={agent} onToggleModule={onToggleModule} onToggleTool={onToggleTool} />
            )}
            {activeTab === 'rules' && (
              <RulesTab agent={agent} onPatchRules={onPatchRules} />
            )}
            {activeTab === 'tests' && (
              <TestsTab
                message={testMessage}
                result={testResult}
                testing={testing}
                onMessage={onTestMessage}
                onRun={onRunTest}
              />
            )}
            {activeTab === 'logs' && <RuntimeLogsViewer />}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-400">Estado del agente</p>
            <div className="mt-4 flex items-center gap-3">
              <span className={`h-3 w-3 rounded-full ${agent.status === 'active' ? 'bg-[#25D366]' : 'bg-[#9DB7AE]'}`} />
              <span className="font-bold text-[#10231C] dark:text-slate-100">
                {agent.status === 'active' ? 'Activo' : 'No activo'}
              </span>
            </div>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-[#5B6F66] dark:text-slate-400">Ubicación</dt>
                <dd className="font-semibold text-[#10231C] dark:text-slate-100">{formatDomainLabel(domain)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#5B6F66] dark:text-slate-400">Operación</dt>
                <dd className="font-semibold text-[#10231C] dark:text-slate-100">{MODE_LABELS[agent.mode]}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#5B6F66] dark:text-slate-400">Modelo</dt>
                <dd className="max-w-[150px] truncate font-semibold text-[#10231C] dark:text-slate-100">{agent.model || 'Por defecto'}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-[#D9E5DF] bg-[#EEF4F1] p-5 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2 text-sm font-bold text-[#0E766A] dark:text-emerald-300">
              <ShieldCheck className="h-4 w-4" />
              Alcance controlado
            </div>
            <p className="mt-3 text-sm leading-6 text-[#5B6F66] dark:text-slate-400">
              Este agente no es global. Sus permisos, herramientas y respuestas se evalúan para el dominio asignado.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

function GeneralTab({
  domain,
  agent,
  onPatchAgent,
  onPatchProfile,
}: {
  domain: AiDomainSummary;
  agent: AiAgent;
  onPatchAgent: (patch: Partial<AiAgent>) => void;
  onPatchProfile: (patch: Partial<AgentProfile>) => void;
}) {
  return (
    <div className="space-y-6">
      <PanelTitle title="Información básica" description="Nombre, ubicación y comportamiento visible del agente." />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nombre del agente">
          <input
            value={agent.name}
            onChange={(event) => onPatchAgent({ name: event.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Modelo">
          <input
            value={agent.model || ''}
            onChange={(event) => onPatchAgent({ model: event.target.value })}
            placeholder="Ej: gpt-4o-mini"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-800 dark:bg-slate-950">
        <p className="text-xs font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-400">Asignado a</p>
        <p className="mt-2 text-base font-bold text-[#10231C] dark:text-slate-100">{formatDomainLabel(domain)}</p>
        <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">La ubicación se cambia desde Dominios IA.</p>
      </div>

      <PanelTitle title="Modo de operación" description="Define que tanto puede intervenir el agente dentro del dominio." />
      <div className="grid gap-3 md:grid-cols-3">
        {(['disabled', 'suggest', 'auto'] as AgentMode[]).map((mode) => (
          <ModeCard
            key={mode}
            mode={mode}
            active={agent.mode === mode}
            onClick={() => onPatchAgent({ mode })}
          />
        ))}
      </div>

      <PanelTitle title="Tono y limites" description="Instrucciones simples para mantener respuestas consistentes." />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Estilo de comunicación">
          <textarea
            value={agent.profile?.communicationStyle || ''}
            onChange={(event) => onPatchProfile({ communicationStyle: event.target.value })}
            rows={4}
            className={inputClass}
          />
        </Field>
        <Field label="Cosas que no debe prometer">
          <textarea
            value={agent.profile?.forbiddenClaims || ''}
            onChange={(event) => onPatchProfile({ forbiddenClaims: event.target.value })}
            rows={4}
            className={inputClass}
          />
        </Field>
      </div>
    </div>
  );
}

function KnowledgeTab({
  agent,
  draft,
  onDraft,
  onAdd,
  onToggle,
  onDelete,
}: {
  agent: AiAgent;
  draft: { title: string; content: string };
  onDraft: (value: { title: string; content: string }) => void;
  onAdd: () => void;
  onToggle: (source: AgentKnowledgeSource) => void;
  onDelete: (source: AgentKnowledgeSource) => void;
}) {
  return (
    <div className="space-y-6">
      <PanelTitle title="Conocimiento del dominio" description="Agrega instrucciones o documentos cortos que el agente puede usar." />
      <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-800 dark:bg-slate-950">
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <Field label="Título">
            <input
              value={draft.title}
              onChange={(event) => onDraft({ ...draft, title: event.target.value })}
              className={inputClass}
              placeholder="Ej: Politica de atención"
            />
          </Field>
          <Field label="Contenido">
            <textarea
              value={draft.content}
              onChange={(event) => onDraft({ ...draft, content: event.target.value })}
              rows={4}
              className={inputClass}
              placeholder="Reglas, preguntas frecuentes o contexto del dominio..."
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <PrimaryButton onClick={onAdd} icon={Plus} disabled={!draft.title.trim() || !draft.content.trim()}>
            Agregar conocimiento
          </PrimaryButton>
        </div>
      </div>

      <div className="space-y-3">
        {(agent.knowledge || []).length === 0 ? (
          <EmptyState icon={BookOpen} title="Sin conocimiento cargado" text="El agente funcionará con las reglas generales y los datos del dominio." />
        ) : (
          (agent.knowledge || []).map((source) => (
            <div key={source.id} className="flex items-start justify-between gap-4 rounded-xl border border-[#D9E5DF] bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
              <div>
                <p className="font-bold text-[#10231C] dark:text-slate-100">{source.title}</p>
                <p className="mt-1 line-clamp-2 text-sm text-[#5B6F66] dark:text-slate-400">{source.content}</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => onToggle(source)} className={iconButtonClass} aria-label="Activar o desactivar">
                  {source.enabled ? <ToggleRight className="h-5 w-5 text-[#128C7E]" /> : <ToggleLeft className="h-5 w-5" />}
                </button>
                <button type="button" onClick={() => onDelete(source)} className={iconButtonClass} aria-label="Eliminar">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ToolsTab({
  agent,
  onToggleModule,
  onToggleTool,
}: {
  agent: AiAgent;
  onToggleModule: (key: keyof AiAgent['moduleAccess']) => void;
  onToggleTool: (key: keyof ToolAccess) => void;
}) {
  const modules: Array<{ key: keyof AiAgent['moduleAccess']; label: string; text: string }> = [
    { key: 'catalog', label: 'Catálogo', text: 'Consultar ofertas, secciones y disponibilidad.' },
    { key: 'orders', label: 'Pedidos y prepedidos', text: 'Preparar intención comercial sin confirmar venta.' },
    { key: 'customerHistory', label: 'Historial', text: 'Leer contexto operativo del cliente.' },
    { key: 'tags', label: 'Etiquetas y estados', text: 'Marcar la conversación con estado trazable.' },
    { key: 'handoff', label: 'Handoff', text: 'Derivar a una persona cuando corresponda.' },
    { key: 'paymentsRead', label: 'Pagos solo lectura', text: 'Leer estado, sin validar ni cerrar pago.' },
    { key: 'reportsRead', label: 'Reportes solo lectura', text: 'Consultar resumenes existentes.' },
    { key: 'commercialState', label: 'Estado comercial', text: 'Actualizar etapa comercial de la conversación.' },
  ];

  const tools: Array<{ key: keyof ToolAccess; label: string }> = [
    { key: 'catalogSearch', label: 'catalog.search' },
    { key: 'catalogGetItem', label: 'catalog.getItem' },
    { key: 'catalogRecommendAlternatives', label: 'catalog.recommendAlternatives' },
    { key: 'availabilityCheck', label: 'availability.check' },
    { key: 'messageSendProductCard', label: 'message.sendProductCard' },
    { key: 'orderUpsertPreorder', label: 'order.upsertPreorder' },
    { key: 'handoffCreate', label: 'handoff.create' },
    { key: 'conversationSetCommercialState', label: 'conversation.setCommercialState' },
    { key: 'tagApplySystem', label: 'tag.applySystem' },
    { key: 'timelineRecord', label: 'timeline.record' },
  ];

  return (
    <div className="space-y-6">
      <PanelTitle title="Módulos disponibles" description="Activa o desactiva capacidades por dominio. Estos controles no son decorativos." />
      <div className="grid gap-3 md:grid-cols-2">
        {modules.map((item) => (
          <ToggleRow
            key={item.key}
            label={item.label}
            text={item.text}
            active={Boolean(agent.moduleAccess?.[item.key])}
            onClick={() => onToggleModule(item.key)}
          />
        ))}
      </div>

      <PanelTitle title="Herramientas autorizadas" description="Cada llamada queda auditada en logs y timeline cuando el runtime la ejecuta." />
      <div className="grid gap-2 md:grid-cols-2">
        {tools.map((tool) => (
          <ToggleRow
            key={String(tool.key)}
            label={tool.label}
            active={Boolean(agent.toolAccess?.[tool.key])}
            onClick={() => onToggleTool(tool.key)}
            compact
          />
        ))}
      </div>
    </div>
  );
}

function RulesTab({
  agent,
  onPatchRules,
}: {
  agent: AiAgent;
  onPatchRules: (patch: Partial<AgentRules>) => void;
}) {
  const rules = agent.rules || DEFAULT_RULES;
  return (
    <div className="space-y-6">
      <PanelTitle title="Reglas del flujo" description="Define cuando sugiere, cuando responde y cuando deriva a una persona." />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Sugerir cuando">
          <textarea value={rules.suggestWhen} onChange={(event) => onPatchRules({ suggestWhen: event.target.value })} rows={5} className={inputClass} />
        </Field>
        <Field label="Responder cuando">
          <textarea value={rules.autoReplyWhen} onChange={(event) => onPatchRules({ autoReplyWhen: event.target.value })} rows={5} className={inputClass} />
        </Field>
        <Field label="Derivar cuando">
          <textarea value={rules.handoffWhen} onChange={(event) => onPatchRules({ handoffWhen: event.target.value })} rows={5} className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={`Confianza mínima: ${Math.round(rules.confidenceThreshold * 100)}%`}>
          <input
            type="range"
            min={0.4}
            max={0.95}
            step={0.01}
            value={rules.confidenceThreshold}
            onChange={(event) => onPatchRules({ confidenceThreshold: Number(event.target.value) })}
            className="w-full accent-[#128C7E]"
          />
        </Field>
        <Field label="Mensajes de contexto">
          <input
            type="number"
            min={4}
            max={30}
            value={rules.maxContextMessages}
            onChange={(event) => onPatchRules({ maxContextMessages: Number(event.target.value) })}
            className={inputClass}
          />
        </Field>
      </div>
    </div>
  );
}

function TestsTab({
  message,
  result,
  testing,
  onMessage,
  onRun,
}: {
  message: string;
  result: AgentRuntimeResult | null;
  testing: boolean;
  onMessage: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="space-y-5">
      <PanelTitle title="Prueba del agente" description="Evalua una respuesta sin enviarla al cliente." />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <textarea
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            rows={7}
            className={inputClass}
            placeholder="Escribe un mensaje de cliente para probar..."
          />
          <PrimaryButton onClick={onRun} icon={testing ? Loader2 : TestTube2} disabled={testing || !message.trim()}>
            {testing ? 'Probando...' : 'Probar respuesta'}
          </PrimaryButton>
        </div>
        <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-800 dark:bg-slate-950">
          {result ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#5B6F66] dark:text-slate-400">
                {result.action} · {Math.round(result.confidence * 100)}%
              </p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#10231C] dark:text-slate-100">{result.reply || 'Sin respuesta'}</p>
              <p className="mt-3 text-xs text-[#5B6F66] dark:text-slate-400">{result.reason}</p>
            </div>
          ) : (
            <EmptyState icon={TestTube2} title="Sin prueba ejecutada" text="El resultado aparecerá en este panel." />
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityPanel({ activity, onReload }: { activity: AgentActivityTurn[]; onReload: () => void }) {
  return (
    <aside className="rounded-xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#10231C] dark:text-slate-100">Actividad reciente</h2>
          <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">Eventos trazables del agente asignado.</p>
        </div>
        <button type="button" onClick={onReload} className={iconButtonClass} aria-label="Actualizar actividad">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-5 space-y-3">
        {activity.length === 0 ? (
          <EmptyState icon={Clock3} title="Sin actividad" text="Cuando el dominio opere, los eventos aparecerán aquí." />
        ) : (
          activity.slice(0, 8).map((item) => (
            <div key={`${item.id}-${item.startedAt}`} className="rounded-lg border border-[#D9E5DF] bg-[#F7FAF8] p-3 dark:border-slate-800 dark:bg-slate-950">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-bold text-[#10231C] dark:text-slate-100">
                  Turno {item.finalAction || item.status}
                </p>
                <span className="shrink-0 text-xs text-[#5B6F66] dark:text-slate-500">{formatDate(item.startedAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-[#5B6F66] dark:text-slate-400">
                {item.commandCount} comandos · {item.status} · {item.finalReplyPreview || 'Sin respuesta final registrada'}
              </p>
              {item.commands.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-[#D9E5DF] pt-2 dark:border-slate-800">
                  {item.commands.slice(0, 3).map((command) => (
                    <div key={command.id} className="flex items-center justify-between gap-2 text-[11px] text-[#5B6F66] dark:text-slate-400">
                      <span className="truncate">{command.toolName || command.title}</span>
                      <span className="shrink-0">{command.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function DomainDrawer({
  domains,
  saving,
  onClose,
  onActivate,
}: {
  domains: AiDomainSummary[];
  saving: boolean;
  onClose: () => void;
  onActivate: (domainKey: AiDomainKey) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 p-4">
      <div className="flex h-full w-full max-w-md flex-col rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-start justify-between border-b border-[#D9E5DF] p-5 dark:border-slate-800">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-[#128C7E]">Dominios predefinidos</p>
            <h2 className="mt-1 text-xl font-bold text-[#10231C] dark:text-slate-100">Añadir dominio</h2>
            <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">No se crean dominios libres; se activan flujos soportados por el sistema.</p>
          </div>
          <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {domains.map((domain) => {
            const Icon = DOMAIN_META[domain.domainKey].icon;
            const canActivate = domain.available && domain.status !== 'active';
            return (
              <div key={domain.domainKey} className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-800 dark:bg-slate-950">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-[#128C7E] dark:bg-slate-900">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-bold text-[#10231C] dark:text-slate-100">{domain.label}</p>
                      <StatusBadge status={domain.status} />
                    </div>
                    <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">{domain.description}</p>
                    <div className="mt-3">
                      {domain.status === 'active' ? (
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-[#0E766A] dark:text-emerald-300">
                          <CheckCircle2 className="h-4 w-4" />
                          Activo
                        </span>
                      ) : canActivate ? (
                        <button
                          type="button"
                          onClick={() => onActivate(domain.domainKey)}
                          disabled={saving}
                          className="inline-flex h-9 items-center justify-center rounded-lg bg-[#128C7E] px-3 text-sm font-bold text-white hover:bg-[#0E766A] disabled:opacity-60"
                        >
                          Activar dominio
                        </button>
                      ) : (
                        <span className="text-sm font-semibold text-[#5B6F66] dark:text-slate-400">Próximamente</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CreateAgentModal({
  domain,
  step,
  saving,
  name,
  mode,
  model,
  onClose,
  onStep,
  onName,
  onMode,
  onModel,
  onCreate,
}: {
  domain: AiDomainSummary;
  step: WizardStep;
  saving: boolean;
  name: string;
  mode: AgentMode;
  model: string;
  onClose: () => void;
  onStep: (step: WizardStep) => void;
  onName: (value: string) => void;
  onMode: (mode: AgentMode) => void;
  onModel: (value: string) => void;
  onCreate: () => void;
}) {
  const next = () => onStep(Math.min(3, step + 1) as WizardStep);
  const prev = () => onStep(Math.max(1, step - 1) as WizardStep);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-start justify-between border-b border-[#D9E5DF] p-5 dark:border-slate-800">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-[#128C7E]">Crear y asignar</p>
            <h2 className="mt-1 text-xl font-bold text-[#10231C] dark:text-slate-100">Nuevo agente</h2>
          </div>
          <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              { n: 1, label: 'Ubicación' },
              { n: 2, label: 'Datos' },
              { n: 3, label: 'Modo' },
            ].map((item) => (
              <button
                key={item.n}
                type="button"
                onClick={() => onStep(item.n as WizardStep)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-bold ${
                  step === item.n
                    ? 'border-[#128C7E] bg-[#DDF4EF] text-[#0E766A] dark:border-emerald-500 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'border-[#D9E5DF] text-[#5B6F66] dark:border-slate-800 dark:text-slate-400'
                }`}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs dark:bg-slate-900">{item.n}</span>
                {item.label}
              </button>
            ))}
          </div>

          {step === 1 && (
            <div className="space-y-4">
              <PanelTitle title="Ubicación bloqueada" description="El agente se crea desde este dominio y queda asignado automaticamente." />
              <div className="rounded-xl border border-[#128C7E] bg-[#DDF4EF] p-4 dark:border-emerald-500 dark:bg-emerald-950/30">
                <p className="text-sm font-bold text-[#10231C] dark:text-slate-100">{formatDomainLabel(domain)}</p>
                <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">{domain.description}</p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <PanelTitle title="Datos del agente" description="Nombre operativo y modelo opcional." />
              <Field label="Nombre">
                <input value={name} onChange={(event) => onName(event.target.value)} className={inputClass} placeholder="Ej: Asistente Gestión Web" />
              </Field>
              <Field label="Modelo">
                <input value={model} onChange={(event) => onModel(event.target.value)} className={inputClass} placeholder="Usar predeterminado si queda vacio" />
              </Field>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <PanelTitle title="Modo inicial" description="Puedes cambiarlo despues desde la configuración del agente." />
              <div className="grid gap-3 md:grid-cols-3">
                {(['disabled', 'suggest', 'auto'] as AgentMode[]).map((item) => (
                  <ModeCard key={item} mode={item} active={mode === item} onClick={() => onMode(item)} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between border-t border-[#D9E5DF] p-5 dark:border-slate-800">
          <GhostButton onClick={step === 1 ? onClose : prev}>{step === 1 ? 'Cancelar' : 'Anterior'}</GhostButton>
          {step < 3 ? (
            <PrimaryButton onClick={next} icon={ChevronRight}>Continuar</PrimaryButton>
          ) : (
            <PrimaryButton onClick={onCreate} icon={saving ? Loader2 : Check} disabled={saving}>
              {saving ? 'Creando...' : 'Crear y asignar'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 rounded-xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-[#128C7E] dark:text-emerald-300">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold text-[#10231C] dark:text-slate-100">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-[#5B6F66] dark:text-slate-400">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

function StatusMessages({ message, error, onClear }: { message: string | null; error: string | null; onClear: () => void }) {
  if (!message && !error) return null;
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${
      error
        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
        : 'border-[#BEE8DC] bg-[#DDF4EF] text-[#0E766A] dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
    }`}>
      <span>{error || message}</span>
      <button type="button" onClick={onClear} aria-label="Cerrar">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function BackButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-fit items-center gap-2 text-sm font-bold text-[#128C7E] hover:text-[#0E766A] dark:text-emerald-300"
    >
      <ArrowLeft className="h-4 w-4" />
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  icon: Icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  icon?: React.ElementType;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#128C7E] px-4 text-sm font-bold text-white transition hover:bg-[#0E766A] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {Icon && <Icon className={`h-4 w-4 ${Icon === Loader2 ? 'animate-spin' : ''}`} />}
      {children}
    </button>
  );
}

function GhostButton({
  children,
  icon: Icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  icon?: React.ElementType;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#D9E5DF] bg-white px-4 text-sm font-bold text-[#10231C] transition hover:bg-[#F7FAF8] disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
    >
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </button>
  );
}

function ModeCard({ mode, active, onClick }: { mode: AgentMode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[150px] rounded-xl border p-4 text-left transition ${
        active
          ? 'border-[#128C7E] bg-[#DDF4EF] shadow-sm dark:border-emerald-500 dark:bg-emerald-950/30'
          : 'border-[#D9E5DF] bg-white hover:border-[#9DB7AE] dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-600'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${active ? 'bg-[#128C7E] text-white' : 'bg-[#EEF4F1] text-[#5B6F66] dark:bg-slate-800 dark:text-slate-300'}`}>
          {mode === 'disabled' ? <ToggleLeft className="h-5 w-5" /> : mode === 'suggest' ? <Sparkles className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
        </span>
        <span className={`h-4 w-4 rounded-full border ${active ? 'border-[#128C7E] bg-[#128C7E]' : 'border-[#9DB7AE]'}`}>
          {active && <Check className="h-4 w-4 text-white" />}
        </span>
      </div>
      <p className="mt-4 font-bold text-[#10231C] dark:text-slate-100">{MODE_LABELS[mode]}</p>
      <p className="mt-2 text-sm leading-5 text-[#5B6F66] dark:text-slate-400">{MODE_DESCRIPTIONS[mode]}</p>
    </button>
  );
}

function ToggleRow({
  label,
  text,
  active,
  onClick,
  compact,
}: {
  label: string;
  text?: string;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition ${
        active
          ? 'border-[#128C7E] bg-[#DDF4EF] dark:border-emerald-500 dark:bg-emerald-950/30'
          : 'border-[#D9E5DF] bg-white hover:bg-[#F7FAF8] dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900'
      } ${compact ? 'py-3' : ''}`}
    >
      <span>
        <span className="block text-sm font-bold text-[#10231C] dark:text-slate-100">{label}</span>
        {text && <span className="mt-1 block text-xs text-[#5B6F66] dark:text-slate-400">{text}</span>}
      </span>
      {active ? <ToggleRight className="h-6 w-6 shrink-0 text-[#128C7E]" /> : <ToggleLeft className="h-6 w-6 shrink-0 text-[#9DB7AE]" />}
    </button>
  );
}

function StatusBadge({ status }: { status: AiDomainSummary['status'] }) {
  const label = status === 'active' ? 'Activo' : status === 'prepared' ? 'Preparado' : status === 'inactive' ? 'Inactivo' : 'Próximamente';
  const cls = status === 'active'
    ? 'bg-[#DDF4EF] text-[#0E766A] dark:bg-emerald-950/50 dark:text-emerald-300'
    : 'bg-[#EEF4F1] text-[#5B6F66] dark:bg-slate-800 dark:text-slate-300';
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${cls}`}>{label}</span>;
}

function PanelTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-base font-bold text-[#10231C] dark:text-slate-100">{title}</h2>
      <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">{description}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-bold text-[#10231C] dark:text-slate-100">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({ icon: Icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] p-6 text-center dark:border-slate-800 dark:bg-slate-950">
      <Icon className="mx-auto h-6 w-6 text-[#9DB7AE]" />
      <p className="mt-3 font-bold text-[#10231C] dark:text-slate-100">{title}</p>
      <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">{text}</p>
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-[#D9E5DF] bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3 text-sm font-bold text-[#5B6F66] dark:text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin text-[#128C7E]" />
        {label}
      </div>
    </div>
  );
}

function readError(err: unknown, fallback: string) {
  const error = err as Error & { response?: { data?: { message?: string; error?: string } } };
  return error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;
}

const inputClass = 'min-h-11 w-full rounded-lg border border-[#D9E5DF] bg-white px-3 py-2 text-sm text-[#10231C] outline-none transition placeholder:text-[#9DB7AE] focus:border-[#128C7E] focus:ring-2 focus:ring-[#DDF4EF] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-emerald-950';
const iconButtonClass = 'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#D9E5DF] bg-white text-[#5B6F66] transition hover:bg-[#F7FAF8] hover:text-[#10231C] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800';
