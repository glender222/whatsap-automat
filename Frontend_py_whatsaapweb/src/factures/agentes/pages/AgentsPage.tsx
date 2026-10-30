import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  Loader2,
  MessageSquare,
  Pause,
  PlugZap,
  Plus,
  Search,
  Settings2,
  RefreshCw,
  Save,
  ScrollText,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import RuntimeLogsViewer from '../components/RuntimeLogsViewer';
import {
  agentService,
  type AgentKnowledgeSource,
  type AgentMode,
  type AgentProviderModel,
  type AgentProviderStatus,
  type AgentProfile,
  type AgentPurpose,
  type AgentRules,
  type AiAgent,
  type AiDomainSummary,
  type KnowledgeType,
} from '../services/agentService';
import { listCatalogs, type Catalog } from '../../inventario/services/productService';

const emptyProfile: AgentProfile = {
  businessDescription: '',
  communicationStyle: '',
  sellingScope: '',
  forbiddenClaims: '',
  language: 'es',
  tone: 'amable, claro y profesional',
  style: '',
  welcomeMessage: '',
};

const emptyRules: AgentRules = {
  autoReplyWhen: 'Responder solo cuando la pregunta este cubierta por el conocimiento y no sea sensible.',
  suggestWhen: 'Sugerir cuando falte contexto, haya duda o la respuesta necesite confirmacion humana.',
  handoffWhen: 'Pasar a humano cuando el cliente pida asesor, haya reclamos, pagos, datos sensibles o el agente no sepa.',
  businessHours: {
    enabled: false,
    timezone: 'America/Lima',
    start: '09:00',
    end: '18:00',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  },
  confidenceThreshold: 0.75,
  blockedTopics: [],
  sensitiveTopics: ['pagos', 'reclamos', 'datos personales'],
  maxContextMessages: 12,
};

const knowledgeLabels: Record<KnowledgeType, string> = {
  faq: 'FAQ',
  product: 'Producto/servicio',
  pricing: 'Precios',
  policy: 'Politicas',
  document: 'Documento',
  url: 'URL',
  catalog: 'Catalogo Meta',
};

const modeLabels: Record<AgentMode, string> = {
  disabled: 'Desactivado',
  suggest: 'Sugerir',
  auto: 'Auto',
};

const statusLabels: Record<string, string> = {
  draft: 'Borrador',
  active: 'Activo',
  paused: 'Pausado',
  archived: 'Archivado',
};

const domainLabels: Record<string, string> = {
  gestion_web: 'Gestión Web',
  inventory_stock: 'Inventario / Stock',
  commercial_catalog: 'Comercial / Catálogo',
  orders: 'Pedidos',
  support: 'Soporte',
  payments: 'Pagos',
};

const defaultModuleAccess = (purpose: AgentPurpose): AiAgent['moduleAccess'] => (
  purpose === 'sales_assistant'
    ? { catalog: true, orders: true, customerHistory: true, tags: true, handoff: true, paymentsRead: true, reportsRead: false, commercialState: true }
    : { catalog: false, orders: false, customerHistory: true, tags: true, handoff: true, paymentsRead: false, reportsRead: false, commercialState: true }
);

const dayLabels = [
  ['mon', 'Lun'],
  ['tue', 'Mar'],
  ['wed', 'Mie'],
  ['thu', 'Jue'],
  ['fri', 'Vie'],
  ['sat', 'Sab'],
  ['sun', 'Dom'],
] as const;

type AgentChatMessage = {
  role: 'user' | 'agent';
  text: string;
  action?: string;
  confidence?: number;
  reason?: string;
};

function listToText(value?: string[]): string {
  return (value || []).join('\n');
}

function textToList(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

const AgentsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const domainKey = searchParams.get('domain') || '';
  const domainLabel = domainLabels[domainKey] || '';
  const domainFlowPath = domainKey
    ? `/dashboard/ia/dominios?domain=${encodeURIComponent(domainKey)}&view=flow`
    : '/dashboard/ia/dominios';
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AiAgent | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'tools' | 'prompt' | 'knowledge' | 'rules' | 'test' | 'logs'>('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [agentSearch, setAgentSearch] = useState('');
  const [domains, setDomains] = useState<AiDomainSummary[]>([]);
  const [createName, setCreateName] = useState('Agente de atencion');
  const [createMode, setCreateMode] = useState<AgentMode>('disabled');
  const [createModel, setCreateModel] = useState('');
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<AgentProviderStatus | null>(null);
  const [providerModels, setProviderModels] = useState<AgentProviderModel[]>([]);
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile>(emptyProfile);
  const [rules, setRules] = useState<AgentRules>(emptyRules);
  const [blockedText, setBlockedText] = useState('');
  const [sensitiveText, setSensitiveText] = useState('');
  const [knowledgeDraft, setKnowledgeDraft] = useState<Partial<AgentKnowledgeSource>>({
    sourceType: 'faq',
    title: '',
    content: '',
    enabled: true,
  });
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [testChatInput, setTestChatInput] = useState('');
  const [testChatMessages, setTestChatMessages] = useState<AgentChatMessage[]>([]);
  const [testing, setTesting] = useState(false);

  const selectedKnowledge = selectedAgent?.knowledge || [];
  const apiBaseUrl = String(import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api').replace(/\/api\/?$/, '');
  const filteredAgents = useMemo(() => {
    const query = agentSearch.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((agent) => (
      agent.name.toLowerCase().includes(query)
      || agent.mode.toLowerCase().includes(query)
      || agent.provider.toLowerCase().includes(query)
    ));
  }, [agentSearch, agents]);
  const activeKnowledgeCount = useMemo(
    () => selectedKnowledge.filter((item) => item.enabled).length,
    [selectedKnowledge]
  );
  const selectedCatalogCount = selectedAgent?.catalogScope?.catalogIds?.length || 0;
  const selectedSectionCount = selectedAgent?.catalogScope?.sectionIds?.length || 0;
  const deployedGestionWebAgentId = useMemo(
    () => domains.find((domain) => domain.domainKey === 'gestion_web')?.agentId || null,
    [domains]
  );
  const selectedIsDeployed = Boolean(selectedAgent?.id && deployedGestionWebAgentId === selectedAgent.id);

  const loadAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, domainList] = await Promise.all([
        agentService.list(),
        agentService.listDomains(),
      ]);
      setAgents(list);
      setDomains(domainList);

      if (list.length > 0) {
        const full = await agentService.get(list[0].id);
        applySelectedAgent(full);
      } else {
        setSelectedAgent(null);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudieron cargar los agentes');
    } finally {
      setLoading(false);
    }
  };

  const loadCatalogScope = async () => {
    try {
      setCatalogs(await listCatalogs());
    } catch {
      setCatalogs([]);
    }
  };

  const loadProviderConfig = async () => {
    setLoadingProvider(true);
    setProviderTestResult(null);
    try {
      const status = await agentService.getProviderStatus();
      setProviderStatus(status);

      let models: AgentProviderModel[] = [];
      try {
        models = await agentService.listProviderModels();
        setProviderModels(models);
      } catch {
        setProviderModels([]);
      }

      setCreateModel((current) => current || status.defaultModel || models[0]?.id || '');
    } catch (err: any) {
      setProviderStatus(null);
      setProviderModels([]);
      setProviderTestResult(err?.response?.data?.error || err?.message || 'No se pudo leer el proveedor IA');
    } finally {
      setLoadingProvider(false);
    }
  };

  const applySelectedAgent = (agent: AiAgent) => {
    if (selectedAgent?.id !== agent.id) {
      setTestChatMessages([]);
      setTestChatInput('');
    }
    setSelectedAgent(agent);
    setProfile({ ...emptyProfile, ...(agent.profile || {}) });
    const nextRules = { ...emptyRules, ...(agent.rules || {}) };
    setRules(nextRules);
    setBlockedText(listToText(nextRules.blockedTopics));
    setSensitiveText(listToText(nextRules.sensitiveTopics));
  };

  useEffect(() => {
    loadAgents();
    loadProviderConfig();
    loadCatalogScope();
  }, []);

  const refreshSelected = async (agentId = selectedAgent?.id) => {
    if (!agentId) return;
    const full = await agentService.get(agentId);
    setAgents((prev) => prev.map((agent) => (agent.id === full.id ? { ...agent, ...full } : agent)));
    applySelectedAgent(full);
  };

  const createAgent = async () => {
    if (!createName.trim()) {
      setError('El nombre del agente es requerido');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await agentService.create({
        name: createName.trim(),
        status: 'draft',
        mode: createMode,
        purpose: 'sales_assistant',
        moduleAccess: defaultModuleAccess('sales_assistant'),
        model: createModel.trim() || undefined,
      });
      await refreshSelected(created.id);
      setActiveTab('prompt');
      setShowCreateModal(false);
      setCreateName('Agente de atencion');
      setCreateMode('disabled');
      setCreateModel(providerStatus?.defaultModel || providerModels[0]?.id || '');
      setMessage('Agente creado');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudo crear el agente');
    } finally {
      setSaving(false);
    }
  };

  const saveGeneral = async (patch: Partial<AiAgent>) => {
    if (!selectedAgent) return;
    setSaving(true);
    try {
      const updated = await agentService.update(selectedAgent.id, patch);
      await refreshSelected(updated.id);
      setMessage('Configuracion general guardada');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const deploySelectedAgent = async () => {
    if (!selectedAgent || selectedAgent.mode === 'disabled') return;
    setSaving(true);
    setError(null);
    try {
      const domain = await agentService.deployDomainAgent('gestion_web', selectedAgent.id, selectedAgent);
      setDomains((prev) => prev.map((item) => (item.domainKey === 'gestion_web' ? domain : item)));
      await refreshSelected(selectedAgent.id);
      setMessage('Agente deployado en Gestion Web');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.response?.data?.error || err?.message || 'No se pudo deployar el agente');
    } finally {
      setSaving(false);
    }
  };

  const updateSelectedAgentDraft = (patch: Partial<AiAgent>) => {
    if (!selectedAgent) return;
    setSelectedAgent({ ...selectedAgent, ...patch });
  };

  const toggleModuleAccess = (key: keyof AiAgent['moduleAccess']) => {
    if (!selectedAgent) return;
    updateSelectedAgentDraft({
      moduleAccess: {
        ...(selectedAgent.moduleAccess || {}),
        [key]: selectedAgent.moduleAccess?.[key] === false,
      },
    });
  };

  const toggleToolAccess = (key: keyof NonNullable<AiAgent['toolAccess']>) => {
    if (!selectedAgent) return;
    updateSelectedAgentDraft({
      toolAccess: {
        ...(selectedAgent.toolAccess || {}),
        [key]: selectedAgent.toolAccess?.[key] === false,
      },
    });
  };

  const toggleCatalogScope = (catalogId: number) => {
    if (!selectedAgent) return;
    const current = selectedAgent.catalogScope?.catalogIds || [];
    const exists = current.includes(catalogId);
    updateSelectedAgentDraft({
      catalogScope: {
        ...(selectedAgent.catalogScope || {}),
        catalogIds: exists ? current.filter((id) => id !== catalogId) : [...current, catalogId],
      },
    });
  };

  const toggleSectionScope = (sectionId: number) => {
    if (!selectedAgent) return;
    const current = selectedAgent.catalogScope?.sectionIds || [];
    const exists = current.includes(sectionId);
    updateSelectedAgentDraft({
      catalogScope: {
        ...(selectedAgent.catalogScope || {}),
        sectionIds: exists ? current.filter((id) => id !== sectionId) : [...current, sectionId],
      },
    });
  };

  const saveProfile = async () => {
    if (!selectedAgent) return;
    setSaving(true);
    try {
      const updated = await agentService.updateProfile(selectedAgent.id, profile);
      applySelectedAgent(updated);
      setMessage('Prompt de empresa guardado');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudo guardar el prompt');
    } finally {
      setSaving(false);
    }
  };

  const saveRules = async () => {
    if (!selectedAgent) return;
    setSaving(true);
    try {
      const updated = await agentService.updateRules(selectedAgent.id, {
        ...rules,
        blockedTopics: textToList(blockedText),
        sensitiveTopics: textToList(sensitiveText),
      });
      applySelectedAgent(updated);
      setMessage('Reglas guardadas');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudieron guardar las reglas');
    } finally {
      setSaving(false);
    }
  };

  const addKnowledge = async () => {
    if (!selectedAgent || (!knowledgeFile && (!knowledgeDraft.title || !knowledgeDraft.content))) return;
    setSaving(true);
    try {
      if (knowledgeFile) {
        await agentService.uploadKnowledgeFile(selectedAgent.id, {
          file: knowledgeFile,
          title: knowledgeDraft.title || knowledgeFile.name,
          content: knowledgeDraft.content || '',
          enabled: knowledgeDraft.enabled !== false,
        });
      } else {
        await agentService.createKnowledge(selectedAgent.id, knowledgeDraft);
      }
      setKnowledgeDraft({ sourceType: 'faq', title: '', content: '', enabled: true });
      setKnowledgeFile(null);
      await refreshSelected();
      setMessage('Conocimiento agregado');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudo agregar conocimiento');
    } finally {
      setSaving(false);
    }
  };

  const toggleKnowledge = async (source: AgentKnowledgeSource) => {
    if (!selectedAgent) return;
    await agentService.updateKnowledge(selectedAgent.id, source.id, { ...source, enabled: !source.enabled });
    await refreshSelected();
  };

  const deleteKnowledge = async (source: AgentKnowledgeSource) => {
    if (!selectedAgent || !window.confirm(`Eliminar "${source.title}"?`)) return;
    await agentService.deleteKnowledge(selectedAgent.id, source.id);
    await refreshSelected();
  };

  const runProviderTest = async (model = createModel || selectedAgent?.model || providerStatus?.defaultModel || '') => {
    setTestingProvider(true);
    setProviderTestResult(null);
    try {
      const result = await agentService.testProvider(model || null);
      setProviderTestResult(`Conexion OK${result.model ? ` · ${result.model}` : ''}`);
    } catch (err: any) {
      setProviderTestResult(err?.response?.data?.error || err?.message || 'No se pudo probar el proveedor IA');
    } finally {
      setTestingProvider(false);
    }
  };

  const runTest = async () => {
    if (!selectedAgent || !testChatInput.trim()) return;
    const messageText = testChatInput.trim();
    const history = testChatMessages.map((item) => ({
      fromMe: item.role === 'agent',
      body: item.text,
    }));

    setTesting(true);
    setTestChatInput('');
    setTestChatMessages((prev) => [...prev, { role: 'user', text: messageText }]);
    try {
      const result = await agentService.test(selectedAgent.id, messageText, history);
      setTestChatMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          text: result.reply || '(sin respuesta)',
          action: result.action,
          confidence: result.confidence,
          reason: result.reason,
        },
      ]);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'No se pudo probar el agente');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-300">Cargando agentes...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#F7FAF8] text-[#10231C] dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 md:p-6">
        {domainLabel && (
          <header className="flex flex-col gap-3">
            <nav className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#5B6F66] dark:text-slate-400">
              <Link
                to="/dashboard/ia/dominios"
                className="rounded-lg px-2 py-1 text-[#128C7E] transition hover:bg-[#DDF4EF] dark:text-[#25D366] dark:hover:bg-[#25D366]/10"
              >
                Dominio
              </Link>
              <ChevronRight className="h-4 w-4 text-[#9DB7AE]" />
              <Link
                to={domainFlowPath}
                className="rounded-lg px-2 py-1 text-[#128C7E] transition hover:bg-[#DDF4EF] dark:text-[#25D366] dark:hover:bg-[#25D366]/10"
              >
                {domainLabel}
              </Link>
              <ChevronRight className="h-4 w-4 text-[#9DB7AE]" />
              <span className="rounded-lg bg-[#EEF4F1] px-2 py-1 text-[#10231C] dark:bg-slate-800 dark:text-slate-100">
                Configuración
              </span>
            </nav>
            <p className="max-w-3xl text-base leading-7 text-[#5B6F66] dark:text-slate-400">
              Atiende conversaciones y genera respuestas para el equipo.
            </p>
          </header>
        )}

        <div className="grid min-h-[calc(100vh-170px)] grid-cols-1 overflow-hidden rounded-xl border border-[#D9E5DF] bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:grid-cols-[320px_1fr]">
        <aside className="border-r border-[#D9E5DF] bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#128C7E] dark:text-[#25D366]">IA</p>
              <h1 className="text-lg font-bold text-[#10231C] dark:text-slate-100">Agentes</h1>
            </div>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMessage(null);
                loadProviderConfig();
                setShowCreateModal(true);
              }}
              disabled={saving}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#128C7E] text-white shadow-sm transition hover:bg-[#0E766A] disabled:opacity-60"
              aria-label="Nuevo agente"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <label className="relative mb-4 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5B6F66] dark:text-slate-400" />
            <input
              value={agentSearch}
              onChange={(event) => setAgentSearch(event.target.value)}
              placeholder="Buscar agente"
              className="h-11 w-full rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] pl-10 pr-3 text-sm font-medium text-[#10231C] outline-none transition placeholder:text-[#5B6F66] focus:border-[#128C7E] focus:ring-2 focus:ring-[#128C7E]/15 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </label>

          {agents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] p-5 text-sm text-[#5B6F66] dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
              Aun no hay agentes. Crea el primero para empezar.
            </div>
          ) : (
            <div className="space-y-2">
              {filteredAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={async () => applySelectedAgent(await agentService.get(agent.id))}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selectedAgent?.id === agent.id
                      ? 'border-[#128C7E] bg-[#DDF4EF] shadow-sm dark:border-[#25D366] dark:bg-[#25D366]/10'
                      : 'border-[#D9E5DF] bg-white hover:border-[#128C7E]/60 hover:bg-[#F7FAF8] dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-[#25D366]/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-[#10231C] dark:text-slate-100">{agent.name}</span>
                      <span className="mt-1 block text-xs text-[#5B6F66] dark:text-slate-400">
                        {agent.provider}
                      </span>
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      agent.mode === 'auto'
                        ? 'bg-[#128C7E] text-white dark:bg-[#25D366] dark:text-[#10231C]'
                        : agent.mode === 'suggest'
                          ? 'bg-[#EEF4F1] text-[#0E766A] dark:bg-slate-800 dark:text-[#25D366]'
                          : 'bg-[#EEF4F1] text-[#5B6F66] dark:bg-slate-800 dark:text-slate-400'
                    }`}>
                      {modeLabels[agent.mode]}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 text-xs text-[#5B6F66] dark:text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${agent.status === 'active' ? 'bg-[#25D366]' : agent.status === 'paused' ? 'bg-slate-400' : 'bg-[#D9E5DF]'}`} />
                      {statusLabels[agent.status] || agent.status}
                    </span>
                    {deployedGestionWebAgentId === agent.id && (
                      <span className="inline-flex items-center gap-1 text-[#128C7E] dark:text-[#25D366]">
                        Deployado en Gestion Web
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {filteredAgents.length === 0 && (
                <div className="rounded-xl border border-dashed border-[#D9E5DF] bg-[#F7FAF8] p-4 text-sm text-[#5B6F66] dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
                  No hay agentes que coincidan con la busqueda.
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="p-5 lg:p-6">
          {message && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {message}
            </div>
          )}
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!selectedAgent ? (
            <div className="rounded-2xl border border-[#D9E5DF] bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <Bot className="mx-auto mb-3 h-10 w-10 text-[#128C7E] dark:text-[#25D366]" />
              <p className="font-semibold">Crea tu primer agente</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#EEF4F1] px-2.5 py-1 text-xs font-bold text-[#128C7E] dark:bg-[#25D366]/10 dark:text-[#25D366]">
                        <Sparkles className="h-3.5 w-3.5" />
                        Agente IA
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F7FAF8] px-2.5 py-1 text-xs font-bold text-[#5B6F66] ring-1 ring-[#D9E5DF] dark:bg-slate-950 dark:text-slate-400 dark:ring-slate-800">
                        <span className={`h-2 w-2 rounded-full ${selectedAgent.status === 'active' ? 'bg-[#25D366]' : selectedAgent.status === 'paused' ? 'bg-slate-400' : 'bg-[#D9E5DF]'}`} />
                        {statusLabels[selectedAgent.status] || selectedAgent.status}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F7FAF8] px-2.5 py-1 text-xs font-bold text-[#5B6F66] ring-1 ring-[#D9E5DF] dark:bg-slate-950 dark:text-slate-400 dark:ring-slate-800">
                        <Settings2 className="h-3.5 w-3.5" />
                        Modo agente: {modeLabels[selectedAgent.mode]}
                      </span>
                    </div>
                    <input
                      value={selectedAgent.name}
                      onChange={(event) => setSelectedAgent({ ...selectedAgent, name: event.target.value })}
                      className="w-full bg-transparent text-2xl font-bold text-[#10231C] outline-none dark:text-slate-100"
                    />
                    <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">
                      {activeKnowledgeCount} fuentes activas · confianza minima {rules.confidenceThreshold} · {selectedCatalogCount} catalogos / {selectedSectionCount} secciones
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => saveGeneral({ ...selectedAgent, status: selectedAgent.status === 'active' ? 'paused' : 'active' })}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#128C7E] px-3 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-[#0E766A]"
                    >
                      {selectedAgent.status === 'active' ? <Pause className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                      {selectedAgent.status === 'active' ? 'Pausar' : 'Activar'}
                    </button>
                    <button
                      type="button"
                      onClick={deploySelectedAgent}
                      disabled={saving || selectedAgent.mode === 'disabled'}
                      className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition disabled:opacity-60 ${
                        selectedIsDeployed
                          ? 'bg-[#DDF4EF] text-[#128C7E] dark:bg-[#25D366]/10 dark:text-[#25D366]'
                          : 'bg-[#128C7E] text-white hover:bg-[#0E766A]'
                      }`}
                    >
                      <Sparkles className="h-4 w-4" />
                      {selectedIsDeployed ? 'Deployado en Gestion Web' : 'Deploy AI'}
                    </button>
                    <Link
                      to={`/dashboard/ia/agentes/test?domain=gestion_web&agentId=${selectedAgent.id}`}
                      className="inline-flex items-center gap-2 rounded-xl border border-[#D9E5DF] bg-white px-3 py-2 text-sm font-bold text-[#128C7E] transition hover:bg-[#F7FAF8] dark:border-slate-700 dark:bg-slate-900 dark:text-[#25D366] dark:hover:bg-slate-800"
                    >
                      <MessageSquare className="h-4 w-4" />
                      Probar agente
                    </Link>
                  </div>
                </div>
              </div>

              {selectedAgent.purpose === 'sales_assistant' && selectedAgent.moduleAccess?.catalog !== false && selectedCatalogCount + selectedSectionCount === 0 && (
                <div className="rounded-2xl border border-[#D9E5DF] bg-white p-4 text-sm text-[#5B6F66] shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#128C7E] dark:text-[#25D366]" />
                    <div>
                      <p className="font-bold text-[#10231C] dark:text-slate-100">Alcance comercial vacio</p>
                      <p className="mt-1">Este agente de ventas no vera productos hasta asignarle catalogos o secciones.</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2 rounded-2xl border border-[#D9E5DF] bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                {[
                  ['general', 'General', Bot],
                  ['tools', 'Herramientas y permisos', PlugZap],
                  ['prompt', 'Perfil IA', MessageSquare],
                  ['knowledge', 'Conocimiento', FileText],
                  ['rules', 'Reglas y control', ShieldAlert],
                  ['test', 'Pruebas', Brain],
                  ['logs', 'Logs IA', ScrollText],
                ].map(([id, label, Icon]: any) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition ${
                      activeTab === id
                        ? 'bg-[#128C7E] text-white dark:bg-[#25D366] dark:text-[#10231C]'
                        : 'text-[#5B6F66] hover:bg-[#F7FAF8] dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>

              {activeTab === 'general' && (
                <section className="rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Nombre">
                      <input
                        value={selectedAgent.name}
                        onChange={(event) => setSelectedAgent({ ...selectedAgent, name: event.target.value })}
                        className="input"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    {(['disabled', 'suggest', 'auto'] as AgentMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSelectedAgent({ ...selectedAgent, mode })}
                        className={`rounded-2xl border p-4 text-left transition ${
                          selectedAgent.mode === mode
                            ? 'border-[#128C7E] bg-[#DDF4EF] dark:border-[#25D366] dark:bg-[#25D366]/10'
                            : 'border-[#D9E5DF] bg-[#F7FAF8] hover:border-[#128C7E]/50 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-[#25D366]/50'
                        }`}
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="font-bold text-[#10231C] dark:text-slate-100">{modeLabels[mode]}</span>
                          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${
                            selectedAgent.mode === mode ? 'bg-[#128C7E] text-white dark:bg-[#25D366] dark:text-[#10231C]' : 'bg-white text-[#5B6F66] ring-1 ring-[#D9E5DF] dark:bg-slate-900 dark:text-slate-500 dark:ring-slate-700'
                          }`}>
                            {selectedAgent.mode === mode ? <Check className="h-3.5 w-3.5" /> : null}
                          </span>
                        </span>
                        <span className="mt-2 block text-xs leading-relaxed text-[#5B6F66] dark:text-slate-400">
                          {mode === 'disabled' && 'No participa en la conversacion.'}
                          {mode === 'suggest' && 'Prepara sugerencias para que una persona las revise.'}
                          {mode === 'auto' && 'Puede responder o usar tools seguras si el modo global lo permite.'}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Proveedor IA">
                      <input value={selectedAgent.provider} disabled className="input opacity-70" />
                    </Field>
                    <Field label="Modelo">
                      <div className="flex gap-2">
                        {providerModels.length > 0 ? (
                          <select
                            value={selectedAgent.model || providerStatus?.defaultModel || ''}
                            onChange={(event) => setSelectedAgent({ ...selectedAgent, model: event.target.value })}
                            className="input"
                          >
                            <option value="">Usar modelo del .env</option>
                            {providerModels.map((model) => (
                              <option key={model.id} value={model.id}>{model.name}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={selectedAgent.model || ''}
                            onChange={(event) => setSelectedAgent({ ...selectedAgent, model: event.target.value })}
                            placeholder="Usa OPENCODE_MODEL si lo dejas vacio"
                            className="input"
                          />
                        )}
                        <button
                          type="button"
                          onClick={loadProviderConfig}
                          className="rounded-xl border border-[#D9E5DF] px-3 text-[#5B6F66] transition hover:bg-[#F7FAF8] dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          aria-label="Actualizar modelos"
                        >
                          <RefreshCw className={`h-4 w-4 ${loadingProvider ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    </Field>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => runProviderTest(selectedAgent.model || providerStatus?.defaultModel || '')}
                      disabled={testingProvider}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#D9E5DF] bg-white px-4 py-2.5 text-sm font-bold text-[#5B6F66] transition hover:bg-[#F7FAF8] disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      {testingProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                      Test API
                    </button>
                    {providerTestResult && (
                      <div className={`rounded-xl border px-3 py-2 text-sm ${
                        providerTestResult.includes('OK')
                          ? 'border-[#128C7E]/30 bg-[#DDF4EF] text-[#128C7E] dark:border-[#25D366]/30 dark:bg-[#25D366]/10 dark:text-[#25D366]'
                          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200'
                      }`}>
                        {providerTestResult}
                      </div>
                    )}
                  </div>

                  <SaveButton onClick={() => saveGeneral(selectedAgent)} saving={saving} />
                </section>
              )}

              {activeTab === 'tools' && (
                <section className="rounded-2xl border border-[#D9E5DF] bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-[#10231C] dark:text-slate-100">Herramientas y permisos</h2>
                      <p className="mt-1 text-sm text-[#5B6F66] dark:text-slate-400">
                        Define que modulos puede consultar este agente y que tools reales puede ejecutar.
                      </p>
                    </div>
                    <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] px-3 py-2 text-xs font-bold text-[#5B6F66] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
                      Modo agente: {modeLabels[selectedAgent.mode]}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-700 dark:bg-slate-900/60">
                    <div className="mb-3">
                      <p className="text-sm font-bold text-[#10231C] dark:text-slate-100">Modulos disponibles</p>
                      <p className="text-xs text-[#5B6F66] dark:text-slate-400">El acceso es estricto: si un modulo esta apagado, el agente no lo usa ni ejecuta sus acciones.</p>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {[
                        ['catalog', 'Catalogo', 'Permite consultar items, secciones y disponibilidad.'],
                        ['orders', 'Prepedidos', 'Permite detectar y preparar pedidos trazables.'],
                        ['customerHistory', 'Historial', 'Permite usar pedidos y conversaciones previas.'],
                        ['tags', 'Etiquetas', 'Permite sugerir o usar etiquetas operativas.'],
                        ['handoff', 'Handoff', 'Permite derivar a una cola humana con motivo y prioridad.'],
                        ['commercialState', 'Estados', 'Permite actualizar el estado comercial de la conversacion.'],
                        ['paymentsRead', 'Pagos lectura', 'Permite leer contexto de pagos sin validar ni cerrar.'],
                        ['reportsRead', 'Reportes lectura', 'Permite consultar metricas resumidas si el rol lo permite.'],
                      ].map(([key, label, description]) => {
                        const enabled = selectedAgent.moduleAccess?.[key as keyof AiAgent['moduleAccess']] !== false;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleModuleAccess(key as keyof AiAgent['moduleAccess'])}
                            role="switch"
                            aria-checked={enabled}
                            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition ${
                              enabled
                                ? 'border-[#128C7E] bg-white shadow-sm dark:border-[#25D366]/70 dark:bg-slate-800'
                                : 'border-[#D9E5DF] bg-white/70 dark:border-slate-700 dark:bg-slate-900/70'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-bold text-[#10231C] dark:text-slate-100">{label}</span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-[#5B6F66] dark:text-slate-400">{description}</span>
                            </span>
                            <span
                              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                                enabled ? 'bg-[#128C7E] dark:bg-[#25D366]' : 'bg-[#D9E5DF] dark:bg-slate-700'
                              }`}
                            >
                              <span
                                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition dark:bg-slate-100 ${
                                  enabled ? 'translate-x-5' : 'translate-x-1'
                                }`}
                              />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-700 dark:bg-slate-900/60">
                    <div className="mb-3">
                      <p className="text-sm font-bold text-[#10231C] dark:text-slate-100">Automatizacion avanzada</p>
                      <p className="text-xs text-[#5B6F66] dark:text-slate-400">
                        Solo aplica si la empresa esta en modo Automatizador y el agente esta en Automatico.
                      </p>
                    </div>
                    <div className="grid gap-3">
                      {[
                        ['autoConfirmOrders', 'Prepedido y handoff', 'La IA prepara contexto y deriva; no confirma ni reserva stock.'],
                        ['autoCreateVouchers', 'Detectar comprobantes', 'Solo registra deteccion para revision humana.'],
                        ['autoGeneratePaymentLinks', 'Preparar pago', 'Solo deja contexto para que un humano cierre el pago.'],
                      ].map(([key, label, description]) => {
                        const enabled = Boolean(selectedAgent[key as keyof AiAgent]);
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => updateSelectedAgentDraft({ [key]: !enabled } as Partial<AiAgent>)}
                            role="switch"
                            aria-checked={enabled}
                            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition ${
                              enabled
                                ? 'border-[#128C7E] bg-white shadow-sm dark:border-[#25D366]/70 dark:bg-slate-800'
                                : 'border-[#D9E5DF] bg-white/70 dark:border-slate-700 dark:bg-slate-900/70'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-bold text-[#10231C] dark:text-slate-100">{label}</span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-[#5B6F66] dark:text-slate-400">{description}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              <span className={`text-xs font-bold ${enabled ? 'text-[#128C7E] dark:text-[#25D366]' : 'text-[#5B6F66] dark:text-slate-400'}`}>
                                {enabled ? 'ON' : 'OFF'}
                              </span>
                              <span
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                                  enabled ? 'bg-[#128C7E] dark:bg-[#25D366]' : 'bg-[#D9E5DF] dark:bg-slate-700'
                                }`}
                              >
                                <span
                                  className={`inline-block h-5 w-5 rounded-full bg-white shadow transition dark:bg-slate-100 ${
                                    enabled ? 'translate-x-5' : 'translate-x-1'
                                  }`}
                                />
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#128C7E]/40 bg-[#DDF4EF] p-3 text-xs text-[#0E766A] dark:border-[#25D366]/40 dark:bg-[#25D366]/10 dark:text-[#25D366]">
                    Este agente asiste ventas y deriva a humano para pago/cierre. No confirma ventas.
                  </div>
                  <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-700 dark:bg-slate-900/60">
                    <div className="mb-3">
                      <p className="text-sm font-bold text-[#10231C] dark:text-slate-100">Capacidades y tools</p>
                      <p className="text-xs text-[#5B6F66] dark:text-slate-400">Tools reales auditadas. Las tools write/send solo aplican en modo Automatizador + agente Automatico.</p>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {([
                        ['catalogSearch', 'catalog.search', 'Lectura', 'Buscar items en scope.'],
                        ['catalogGetItem', 'catalog.getItem', 'Lectura', 'Obtener item por ID.'],
                        ['catalogRecommendAlternatives', 'catalog.recommendAlternatives', 'Lectura', 'Sugerir alternativas.'],
                        ['availabilityCheck', 'availability.check', 'Lectura', 'Verificar disponibilidad sin reservar.'],
                        ['messageSendProductCard', 'message.sendProductCard', 'Sistema', 'Entrega final system-only; el modelo no la llama.'],
                        ['orderUpsertPreorder', 'order.upsertPreorder', 'Escritura', 'Crear/actualizar prepedido (solo Automatico).'],
                        ['handoffCreate', 'handoff.create', 'Escritura', 'Derivar a humano con ticket.'],
                        ['conversationSetCommercialState', 'conversation.setCommercialState', 'Escritura', 'Cambiar estado comercial.'],
                        ['tagApplySystem', 'tag.applySystem', 'Escritura', 'Aplicar etiqueta sistema.'],
                        ['timelineRecord', 'timeline.record', 'Sistema', 'System-only. El modelo no la llama.'],
                      ] as const).map(([key, name, kind, description]) => {
                        const enabled = selectedAgent.toolAccess?.[key] !== false;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleToolAccess(key)}
                            role="switch"
                            aria-checked={enabled}
                            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                              enabled
                                ? 'border-[#128C7E] bg-white shadow-sm dark:border-[#25D366]/70 dark:bg-slate-800'
                                : 'border-[#D9E5DF] bg-white/70 dark:border-slate-700 dark:bg-slate-900/70'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block text-xs font-bold text-[#10231C] dark:text-slate-100">{name}</span>
                              <span className="mt-0.5 block text-[11px] leading-relaxed text-[#5B6F66] dark:text-slate-400">
                                <span className="font-semibold text-[#0E766A] dark:text-[#25D366]">{kind}.</span> {description}
                              </span>
                            </span>
                            <span
                              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
                                enabled ? 'bg-[#128C7E] dark:bg-[#25D366]' : 'bg-[#D9E5DF] dark:bg-slate-700'
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 rounded-full bg-white shadow transition dark:bg-slate-100 ${
                                  enabled ? 'translate-x-4' : 'translate-x-1'
                                }`}
                              />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-3 rounded-md border border-dashed border-[#D9E5DF] bg-white/60 px-3 py-2 text-[11px] text-[#5B6F66] dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
                      Tools futuras desactivadas: payment.createLink, payment.validateVoucher, payment.getStatus. Si el modelo las intenta, se loguea y deriva a humano.
                    </div>
                  </div>
                  {selectedAgent.moduleAccess?.catalog !== false && (
                    <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 dark:border-slate-700 dark:bg-slate-900/60">
                      <div className="mb-3">
                        <p className="text-sm font-bold text-[#10231C] dark:text-slate-100">Alcance comercial</p>
                        <p className="text-xs text-[#5B6F66] dark:text-slate-400">Sin seleccionar catalogos ni secciones, el agente no puede ver productos (scope vacio).</p>
                      </div>
                      <div className="space-y-3">
                        {catalogs.map((catalog) => {
                          const catalogSelected = (selectedAgent.catalogScope?.catalogIds || []).includes(catalog.id);
                          return (
                            <div key={catalog.id} className="rounded-lg border border-[#D9E5DF] bg-white p-3 dark:border-slate-700 dark:bg-slate-900/70">
                              <button
                                type="button"
                                onClick={() => toggleCatalogScope(catalog.id)}
                                className={`mb-2 rounded-full border px-3 py-1 text-xs font-bold transition ${
                                  catalogSelected
                                    ? 'border-[#128C7E] bg-[#128C7E] text-white dark:border-[#25D366] dark:bg-[#25D366] dark:text-[#10231C]'
                                    : 'border-[#D9E5DF] bg-[#F7FAF8] text-[#5B6F66] hover:border-[#128C7E]/50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-[#25D366]/60'
                                }`}
                              >
                                {catalog.name}
                              </button>
                              <div className="flex flex-wrap gap-2">
                                {(catalog.sections || []).map((section) => {
                                  const selected = (selectedAgent.catalogScope?.sectionIds || []).includes(section.id);
                                  return (
                                    <button
                                      key={section.id}
                                      type="button"
                                      onClick={() => toggleSectionScope(section.id)}
                                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                        selected
                                          ? 'border-[#128C7E] bg-[#DDF4EF] text-[#128C7E] dark:border-[#25D366] dark:bg-[#25D366]/15 dark:text-[#25D366]'
                                          : 'border-[#D9E5DF] bg-white text-[#5B6F66] hover:border-[#128C7E]/50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-[#25D366]/60'
                                      }`}
                                    >
                                      {section.name}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <SaveButton onClick={() => saveGeneral(selectedAgent)} saving={saving} />
                </section>
              )}

              {activeTab === 'prompt' && (
                <section className="rounded-2xl border-2 border-gray-200 bg-white p-5 shadow-sm dark:border-gray-600 dark:bg-gray-800 space-y-4">
                  <TextArea label="Que es la empresa" value={profile.businessDescription} onChange={(value) => setProfile({ ...profile, businessDescription: value })} />
                  <TextArea label="Como debe hablar" value={profile.communicationStyle} onChange={(value) => setProfile({ ...profile, communicationStyle: value })} />
                  <TextArea label="Que debe vender/explicar" value={profile.sellingScope} onChange={(value) => setProfile({ ...profile, sellingScope: value })} />
                  <TextArea label="Que no debe decir" value={profile.forbiddenClaims} onChange={(value) => setProfile({ ...profile, forbiddenClaims: value })} />
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Field label="Idioma"><input className="input" value={profile.language} onChange={(event) => setProfile({ ...profile, language: event.target.value })} /></Field>
                    <Field label="Tono"><input className="input" value={profile.tone} onChange={(event) => setProfile({ ...profile, tone: event.target.value })} /></Field>
                    <Field label="Estilo"><input className="input" value={profile.style} onChange={(event) => setProfile({ ...profile, style: event.target.value })} /></Field>
                  </div>
                  <SaveButton onClick={saveProfile} saving={saving} />
                </section>
              )}

              {activeTab === 'knowledge' && (
                <section className="rounded-2xl border-2 border-gray-200 bg-white p-5 shadow-sm dark:border-gray-600 dark:bg-gray-800 space-y-5">
                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
                    Sube FAQs, productos, politicas, documentos o URLs. Los horarios de atencion se configuran en Reglas y Control.
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
                    <Field label="Tipo">
                      <select className="input" value={knowledgeFile ? 'document' : knowledgeDraft.sourceType} disabled={Boolean(knowledgeFile)} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, sourceType: event.target.value as KnowledgeType })}>
                        {Object.entries(knowledgeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                    </Field>
                    <Field label="Titulo">
                      <input className="input" value={knowledgeDraft.title || ''} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })} />
                    </Field>
                  </div>
                  <Field label="Archivo opcional">
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center transition hover:border-blue-400 hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-900/30 dark:hover:border-blue-500 dark:hover:bg-blue-900/20">
                      <Upload className="mb-2 h-6 w-6 text-gray-500 dark:text-gray-300" />
                      <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {knowledgeFile ? knowledgeFile.name : 'Subir archivo de cualquier tipo'}
                      </span>
                      <span className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        PDF, Word, Excel, imagenes, texto, JSON, CSV u otros formatos.
                      </span>
                      <input
                        type="file"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0] || null;
                          setKnowledgeFile(file);
                          if (file) {
                            setKnowledgeDraft((prev) => ({ ...prev, sourceType: 'document', title: prev.title || file.name }));
                          }
                        }}
                      />
                    </label>
                    {knowledgeFile && (
                      <button
                        type="button"
                        onClick={() => setKnowledgeFile(null)}
                        className="mt-2 text-sm font-semibold text-red-600 hover:text-red-700"
                      >
                        Quitar archivo
                      </button>
                    )}
                  </Field>
                  <TextArea label={knowledgeFile ? 'Nota o texto extra opcional' : 'Contenido'} value={knowledgeDraft.content || ''} onChange={(value) => setKnowledgeDraft({ ...knowledgeDraft, content: value })} />
                  <Field label="URL opcional">
                    <input className="input" value={knowledgeDraft.url || ''} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, url: event.target.value })} />
                  </Field>
                  <button type="button" onClick={addKnowledge} disabled={saving || (!knowledgeFile && (!knowledgeDraft.title || !knowledgeDraft.content))} className="btn-primary">
                    <Plus className="w-4 h-4" /> Agregar conocimiento
                  </button>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    {selectedKnowledge.map((item) => (
                      <div key={item.id} className="rounded-xl border-2 border-gray-200 p-4 transition hover:border-emerald-300 dark:border-gray-600 dark:hover:border-emerald-500">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <span className="text-xs font-semibold uppercase text-emerald-600 dark:text-emerald-400">{knowledgeLabels[item.sourceType] || item.sourceType}</span>
                            <h3 className="font-semibold">{item.title}</h3>
                          </div>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => toggleKnowledge(item)} className="rounded-md p-2 hover:bg-gray-100 dark:hover:bg-gray-700">
                              <CheckCircle2 className={`w-4 h-4 ${item.enabled ? 'text-emerald-500' : 'text-gray-400'}`} />
                            </button>
                            <button type="button" onClick={() => deleteKnowledge(item)} className="rounded-md p-2 hover:bg-red-50 text-red-500">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        <p className="mt-3 line-clamp-4 text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{item.content}</p>
                        {item.url && item.sourceType === 'document' && (
                          <a href={`${apiBaseUrl}${item.url}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-semibold text-blue-600 hover:text-blue-700">
                            Descargar archivo
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === 'rules' && (
                <section className="rounded-2xl border-2 border-gray-200 bg-white p-5 shadow-sm dark:border-gray-600 dark:bg-gray-800 space-y-4">
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                    <div className="mb-4 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
                          <Clock3 className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="font-semibold">Horario operativo</h3>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            Define cuando el agente puede estar prendido para responder o sugerir.
                          </p>
                        </div>
                      </div>
                      <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={rules.businessHours?.enabled || false}
                          onChange={(event) => setRules({
                            ...rules,
                            businessHours: { ...emptyRules.businessHours, ...(rules.businessHours || emptyRules.businessHours), enabled: event.target.checked },
                          })}
                        />
                        Activar horario
                      </label>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <Field label="Desde">
                        <input
                          type="time"
                          className="input"
                          value={rules.businessHours?.start || '09:00'}
                          onChange={(event) => setRules({
                            ...rules,
                            businessHours: { ...emptyRules.businessHours, ...(rules.businessHours || emptyRules.businessHours), start: event.target.value },
                          })}
                        />
                      </Field>
                      <Field label="Hasta">
                        <input
                          type="time"
                          className="input"
                          value={rules.businessHours?.end || '18:00'}
                          onChange={(event) => setRules({
                            ...rules,
                            businessHours: { ...emptyRules.businessHours, ...(rules.businessHours || emptyRules.businessHours), end: event.target.value },
                          })}
                        />
                      </Field>
                      <Field label="Zona horaria">
                        <input
                          className="input"
                          value={rules.businessHours?.timezone || 'America/Lima'}
                          onChange={(event) => setRules({
                            ...rules,
                            businessHours: { ...emptyRules.businessHours, ...(rules.businessHours || emptyRules.businessHours), timezone: event.target.value },
                          })}
                        />
                      </Field>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {dayLabels.map(([day, label]) => {
                        const selected = (rules.businessHours?.days || []).includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => {
                              const currentDays = rules.businessHours?.days || [];
                              const days = selected
                                ? currentDays.filter((item) => item !== day)
                                : [...currentDays, day];
                              setRules({
                                ...rules,
                                businessHours: { ...emptyRules.businessHours, ...(rules.businessHours || emptyRules.businessHours), days },
                              });
                            }}
                            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                              selected
                                ? 'bg-blue-600 text-white'
                                : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <TextArea label="Cuando responde solo" value={rules.autoReplyWhen} onChange={(value) => setRules({ ...rules, autoReplyWhen: value })} />
                  <TextArea label="Cuando solo sugiere respuesta" value={rules.suggestWhen} onChange={(value) => setRules({ ...rules, suggestWhen: value })} />
                  <TextArea label="Cuando pasa a humano" value={rules.handoffWhen} onChange={(value) => setRules({ ...rules, handoffWhen: value })} />
                  <Field label="Limite de confianza">
                    <input type="number" min="0" max="1" step="0.05" className="input" value={rules.confidenceThreshold} onChange={(event) => setRules({ ...rules, confidenceThreshold: Number(event.target.value) })} />
                  </Field>
                  <Field label="Mensajes recientes de contexto">
                    <input type="number" min="1" max="200" step="1" className="input" value={rules.maxContextMessages} onChange={(event) => setRules({ ...rules, maxContextMessages: Number(event.target.value) })} />
                  </Field>
                  <TextArea label="Temas bloqueados" value={blockedText} onChange={setBlockedText} placeholder="Uno por linea" />
                  <TextArea label="Mensajes sensibles / temas que requieren humano" value={sensitiveText} onChange={setSensitiveText} placeholder="Uno por linea" />
                  <SaveButton onClick={saveRules} saving={saving} />
                </section>
              )}

              {activeTab === 'test' && (
                <section className="overflow-hidden rounded-2xl border-2 border-gray-200 bg-white shadow-sm dark:border-gray-600 dark:bg-gray-800">
                  <div className="border-b border-gray-200 px-5 py-4 dark:border-gray-700">
                    <h2 className="font-semibold text-gray-900 dark:text-gray-100">Chat de prueba</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Prueba el prompt, conocimiento y reglas antes de usarlo en conversaciones reales.
                    </p>
                  </div>
                  <div className="flex min-h-[420px] flex-col">
                    <div className="flex-1 space-y-4 overflow-y-auto bg-gray-50 p-5 dark:bg-gray-900/30">
                      {testChatMessages.length === 0 ? (
                        <div className="flex h-full min-h-[280px] items-center justify-center text-center text-sm text-gray-500 dark:text-gray-400">
                          Escribe como si fueras un cliente de WhatsApp para validar la respuesta del agente.
                        </div>
                      ) : (
                        testChatMessages.map((item, index) => (
                          <div key={`${item.role}-${index}`} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                              item.role === 'user'
                                ? 'bg-blue-600 text-white'
                                : 'border border-gray-200 bg-white text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100'
                            }`}>
                              <p className="whitespace-pre-wrap">{item.text}</p>
                              {item.role === 'agent' && (
                                <div className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                                  {item.action || 'suggest'} · {Math.round((item.confidence || 0) * 100)}%
                                  {item.reason ? ` · ${item.reason}` : ''}
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                      {testing && (
                        <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-300">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Probando agente...
                        </div>
                      )}
                    </div>
                    <div className="border-t border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                      <div className="flex gap-2">
                        <input
                          value={testChatInput}
                          onChange={(event) => setTestChatInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              runTest();
                            }
                          }}
                          placeholder="Mensaje de prueba del cliente"
                          className="input"
                        />
                        <button type="button" onClick={runTest} disabled={testing || !testChatInput.trim()} className="btn-primary">
                          <Send className="h-4 w-4" />
                          Enviar
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === 'logs' && (
                <section className="rounded-2xl border-2 border-gray-200 bg-white p-5 shadow-sm dark:border-gray-600 dark:bg-gray-800">
                  <RuntimeLogsViewer />
                </section>
              )}
            </div>
          )}
        </main>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl animate-scale-in rounded-2xl bg-white shadow-2xl dark:bg-gray-800">
            <div className="flex items-center justify-between border-b border-gray-200 p-5 dark:border-gray-700">
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Crear agente</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  Configura la conexion IA y confirma para guardar el agente.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded-xl p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                aria-label="Cerrar"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <PlugZap className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        Proveedor IA: {providerStatus?.provider || 'opencode'}
                      </span>
                      <span className={`h-2.5 w-2.5 rounded-full ${providerStatus?.configured ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    </div>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      La clave se lee solo desde el `.env`; aqui detectas modelos, eliges uno y pruebas que responda.
                    </p>
                    {!providerStatus?.apiUrlConfigured && (
                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        Configura `OPENCODE_API_KEY` y reinicia el backend.
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={loadProviderConfig}
                    disabled={loadingProvider}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
                  >
                    <RefreshCw className={`h-4 w-4 ${loadingProvider ? 'animate-spin' : ''}`} />
                    Detectar
                  </button>
                </div>
              </div>

              <Field label="Nombre del agente">
                <input
                  className="input"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="Ej: Agente de ventas"
                  autoFocus
                />
              </Field>

              <Field label="Modelo IA">
                <div className="flex gap-2">
                  {providerModels.length > 0 ? (
                    <select
                      className="input"
                      value={createModel}
                      onChange={(event) => setCreateModel(event.target.value)}
                    >
                      <option value="">Usar modelo del .env</option>
                      {providerModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      value={createModel}
                      onChange={(event) => setCreateModel(event.target.value)}
                      placeholder={providerStatus?.defaultModel || 'Modelo opcional'}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => runProviderTest(createModel)}
                    disabled={testingProvider || !providerStatus?.configured}
                    className="inline-flex min-w-[110px] items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
                  >
                    {testingProvider ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                    Test
                  </button>
                </div>
                {providerTestResult && (
                  <div className={`mt-2 rounded-lg border px-3 py-2 text-sm ${
                    providerTestResult.includes('OK')
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-200'
                      : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200'
                  }`}>
                    {providerTestResult}
                  </div>
                )}
              </Field>

              <Field label="Modo inicial">
                <select
                  className="input"
                  value={createMode}
                  onChange={(event) => setCreateMode(event.target.value as AgentMode)}
                >
                  <option value="disabled">Desactivado</option>
                  <option value="suggest">Sugerencias</option>
                  <option value="auto">Automatico</option>
                </select>
              </Field>

              <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-4 text-sm text-[#5B6F66]">
                En ventas asistidas, el agente puede entender productos y preparar prepedido, pero siempre deriva a una persona para pago y cierre.
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-xl bg-gray-100 px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={createAgent}
                  disabled={saving || !createName.trim()}
                  className="btn-primary"
                >
                  <Plus className="h-4 w-4" />
                  {saving ? 'Creando...' : 'Crear agente'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block space-y-2">
      <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{label}</span>
      {children}
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={4}
        className="input min-h-[110px] resize-y"
      />
    </Field>
  );
}

function SaveButton({ onClick, saving }: { onClick: () => void; saving: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={saving} className="btn-primary">
      <Save className="w-4 h-4" />
      {saving ? 'Guardando...' : 'Guardar'}
    </button>
  );
}

export default AgentsPage;
