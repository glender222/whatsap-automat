import { queryInTenantScope } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';
import config from '../../../../config/index';
import { ProductRepositoryPg } from '../../../inventory';
import {
  AgentCatalogScope,
  AiDomainKey,
  AiDomainStatus,
  AiDomainSummary,
  AgentKnowledgeSource,
  AgentMode,
  AgentModuleAccess,
  AgentProfile,
  AgentPurpose,
  AgentRules,
  AgentStatus,
  AgentToolAccess,
  AgentTriggerRules,
  AiAgent,
  BusinessHours,
  KnowledgeType,
} from '../../domain/agent.types';

type Row = Record<string, any>;

const DOMAIN_DEFINITIONS: Array<{
  domainKey: AiDomainKey;
  label: string;
  description: string;
  status: AiDomainStatus;
  available: boolean;
}> = [
  {
    domainKey: 'gestion_web',
    label: 'Gestión Web / Atención al cliente',
    description: 'Atiende conversaciones y genera respuestas para el equipo.',
    status: 'active',
    available: true,
  },
  {
    domainKey: 'inventory_stock',
    label: 'Inventario / Stock',
    description: 'Consulta disponibilidad, detecta agotados y sugiere alternativas.',
    status: 'active',
    available: true,
  },
  {
    domainKey: 'commercial_catalog',
    label: 'Comercial / Catálogo',
    description: 'Consulta ofertas, recomienda productos y prepara prepedidos.',
    status: 'prepared',
    available: false,
  },
  {
    domainKey: 'orders',
    label: 'Pedidos',
    description: 'Consulta estado de pedidos y ayuda a dar seguimiento.',
    status: 'prepared',
    available: false,
  },
  {
    domainKey: 'support',
    label: 'Soporte',
    description: 'Responde dudas frecuentes, políticas y reclamos iniciales.',
    status: 'prepared',
    available: false,
  },
  {
    domainKey: 'payments',
    label: 'Pagos',
    description: 'Preparado para futuros flujos de pago automatizado.',
    status: 'coming_soon',
    available: false,
  },
];

function normalizeDomainKey(value: unknown): AiDomainKey {
  const key = String(value || '').trim();
  const allowed = DOMAIN_DEFINITIONS.map((domain) => domain.domainKey);
  if (allowed.includes(key as AiDomainKey)) return key as AiDomainKey;
  const error = new Error('Dominio IA invalido') as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

function domainDefinition(domainKey: AiDomainKey) {
  return DOMAIN_DEFINITIONS.find((domain) => domain.domainKey === domainKey) || DOMAIN_DEFINITIONS[0];
}

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

function clampConfidence(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.5;
  return Math.max(0, Math.min(1, numberValue));
}

function clampContextMessages(value: unknown, fallback = 12): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(numberValue)));
}

function parseTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeBusinessHours(input: any): BusinessHours {
  const source = input || {};
  const days = Array.isArray(source.days)
    ? source.days.map(String).filter(Boolean)
    : ['mon', 'tue', 'wed', 'thu', 'fri'];
  return {
    enabled: Boolean(source.enabled),
    timezone: String(source.timezone || 'America/Lima'),
    start: String(source.start || '09:00'),
    end: String(source.end || '18:00'),
    days,
  };
}

function normalizeModuleAccess(value: any, purpose: AgentPurpose): AgentModuleAccess {
  const defaults = purpose === 'sales_assistant'
    ? { catalog: true, orders: true, customerHistory: true, tags: true, handoff: true, paymentsRead: true, reportsRead: false, commercialState: true }
    : { catalog: false, orders: false, customerHistory: true, tags: true, handoff: true, paymentsRead: false, reportsRead: false, commercialState: true };
  return { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
}

function normalizeToolAccess(value: any, moduleAccess: AgentModuleAccess): AgentToolAccess {
  const defaults: AgentToolAccess = {
    catalogSearch: moduleAccess.catalog !== false,
    catalogGetItem: moduleAccess.catalog !== false,
    catalogRecommendAlternatives: moduleAccess.catalog !== false,
    availabilityCheck: moduleAccess.catalog !== false,
    messageSendProductCard: moduleAccess.catalog !== false,
    orderUpsertPreorder: moduleAccess.orders !== false,
    handoffCreate: moduleAccess.handoff !== false,
    conversationSetCommercialState: moduleAccess.commercialState !== false,
    tagApplySystem: moduleAccess.tags !== false,
    timelineRecord: true,
  };
  return { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
}

function normalizeTriggerRules(value: any, purpose: AgentPurpose): AgentTriggerRules {
  const defaults = purpose === 'sales_assistant'
    ? { commercialIntent: 'always' as const, handoffForPayment: true }
    : { commercialIntent: 'never' as const, handoffForPayment: true };
  const merged = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  if (typeof merged.commercialIntent === 'boolean') {
    merged.commercialIntent = merged.commercialIntent ? 'always' : 'never';
  }
  return merged as AgentTriggerRules;
}

function normalizeCatalogScope(value: any): AgentCatalogScope {
  const source = value && typeof value === 'object' ? value : {};
  const normalizeIds = (items: unknown) => Array.isArray(items)
    ? Array.from(new Set(items.map(Number).filter((id) => Number.isInteger(id) && id > 0)))
    : [];
  return {
    catalogIds: normalizeIds(source.catalogIds),
    sectionIds: normalizeIds(source.sectionIds),
  };
}

function normalizePurpose(value: unknown): AgentPurpose {
  const purpose = String(value || 'support');
  return (['router', 'sales_assistant', 'support', 'order_tracking', 'booking', 'operations', 'general'].includes(purpose)
    ? purpose
    : 'support') as AgentPurpose;
}

function normalizeAgent(row: Row): AiAgent {
  const purpose = normalizePurpose(row.purpose);
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    name: row.name,
    status: row.status as AgentStatus,
    mode: row.mode as AgentMode,
    provider: row.provider,
    model: row.model ?? null,
    purpose,
    moduleAccess: normalizeModuleAccess(row.module_access_json, purpose),
    triggerRules: normalizeTriggerRules(row.trigger_rules_json, purpose),
    catalogScope: normalizeCatalogScope(row.catalog_scope_json),
    toolAccess: normalizeToolAccess(row.tool_access_json, normalizeModuleAccess(row.module_access_json, purpose)),
    autoConfirmOrders: Boolean(row.auto_confirm_orders),
    autoCreateVouchers: Boolean(row.auto_create_vouchers),
    autoGeneratePaymentLinks: Boolean(row.auto_generate_payment_links),
    isDefault: Boolean(row.is_default),
    createdBy: row.created_by ? Number(row.created_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeProfile(row: Row | null): AgentProfile {
  return {
    businessDescription: row?.business_description || '',
    communicationStyle: row?.communication_style || '',
    sellingScope: row?.selling_scope || '',
    forbiddenClaims: row?.forbidden_claims || '',
    language: row?.language || 'es',
    tone: row?.tone || 'amable, claro y profesional',
    style: row?.style || '',
    welcomeMessage: row?.welcome_message || '',
  };
}

function normalizeRules(row: Row | null): AgentRules {
  return {
    autoReplyWhen: row?.auto_reply_when || '',
    suggestWhen: row?.suggest_when || '',
    handoffWhen: row?.handoff_when || '',
    businessHours: normalizeBusinessHours(row?.business_hours_json || {}),
    confidenceThreshold: Number(row?.confidence_threshold ?? 0.75),
    blockedTopics: row?.blocked_topics || [],
    sensitiveTopics: row?.sensitive_topics || [],
    maxContextMessages: clampContextMessages(row?.max_context_messages),
  };
}

function normalizeKnowledge(row: Row): AgentKnowledgeSource {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    sourceType: row.source_type as KnowledgeType,
    title: row.title,
    content: row.content,
    url: row.url,
    metadata: row.metadata_json || {},
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  private async ensureDefaultDomains(companyId: number): Promise<void> {
    for (const domain of DOMAIN_DEFINITIONS.filter((item) => item.available)) {
      await this.pool.query(
        `INSERT INTO company_ai_domains (company_id, domain_key, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, domain_key) DO NOTHING`,
        [companyId, domain.domainKey, domain.status]
      );
    }
  }

  async listDomains(companyId: number): Promise<AiDomainSummary[]> {
    await this.ensureDefaultDomains(companyId);
    const result = await this.pool.query(
      `SELECT domain_key, status, agent_id, created_at, updated_at
       FROM company_ai_domains
       WHERE company_id = $1`,
      [companyId]
    );
    const rowsByKey = new Map<string, Row>();
    for (const row of result.rows) rowsByKey.set(String(row.domain_key), row);

    const domains: AiDomainSummary[] = [];
    for (const definition of DOMAIN_DEFINITIONS) {
      const row = rowsByKey.get(definition.domainKey);
      const agentId = row?.agent_id ? Number(row.agent_id) : null;
      let assignedAgent: AiAgent | null = null;
      if (agentId) {
        try {
          assignedAgent = await this.get(companyId, agentId);
        } catch {
          assignedAgent = null;
        }
      }
      domains.push({
        ...definition,
        status: (row?.status as AiDomainStatus) || definition.status,
        agentId,
        assignedAgent,
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      });
    }
    return domains;
  }

  async activateDomain(companyId: number, domainKeyInput: unknown): Promise<AiDomainSummary> {
    const domainKey = normalizeDomainKey(domainKeyInput);
    const definition = domainDefinition(domainKey);
    if (!definition.available) {
      const error = new Error('Dominio IA aun no disponible') as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    await this.pool.query(
      `INSERT INTO company_ai_domains (company_id, domain_key, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (company_id, domain_key)
       DO UPDATE SET status = 'active', updated_at = NOW()`,
      [companyId, domainKey]
    );
    const domains = await this.listDomains(companyId);
    return domains.find((domain) => domain.domainKey === domainKey)!;
  }

  async assignDomainAgent(companyId: number, domainKeyInput: unknown, agentIdInput: unknown): Promise<AiDomainSummary> {
    const domainKey = normalizeDomainKey(domainKeyInput);
    const definition = domainDefinition(domainKey);
    if (!definition.available) {
      const error = new Error('Dominio IA aun no disponible') as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    const agentId = agentIdInput === null ? null : Number(agentIdInput);
    if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) {
      const error = new Error('Agente requerido para asignar dominio') as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    if (agentId !== null) {
      await this.get(companyId, agentId);
    }
    await this.pool.query(
      `INSERT INTO company_ai_domains (company_id, domain_key, status, agent_id)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (company_id, domain_key)
       DO UPDATE SET status = 'active', agent_id = EXCLUDED.agent_id, updated_at = NOW()`,
      [companyId, domainKey, agentId]
    );
    const domains = await this.listDomains(companyId);
    return domains.find((domain) => domain.domainKey === domainKey)!;
  }

  async getDomainAgent(companyId: number, domainKeyInput: unknown): Promise<AiAgent | null> {
    const domainKey = normalizeDomainKey(domainKeyInput);
    await this.ensureDefaultDomains(companyId);
    const result = await this.pool.query(
      `SELECT agent_id FROM company_ai_domains
       WHERE company_id = $1 AND domain_key = $2 AND status = 'active'`,
      [companyId, domainKey]
    );
    const agentId = result.rows[0]?.agent_id ? Number(result.rows[0].agent_id) : null;
    if (!agentId) return null;
    try {
      return await this.get(companyId, agentId);
    } catch {
      return null;
    }
  }

  async list(companyId: number): Promise<AiAgent[]> {
    const result = await this.pool.query(
      `SELECT * FROM ai_agents
       WHERE company_id = $1 AND status <> 'archived'
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [companyId]
    );
    return result.rows.map(normalizeAgent);
  }

  async get(companyId: number, agentId: number): Promise<AiAgent> {
    const [agentResult, profileResult, rulesResult, knowledgeResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM ai_agents WHERE id = $1 AND company_id = $2 AND status <> 'archived'`,
        [agentId, companyId]
      ),
      this.pool.query('SELECT * FROM agent_prompt_profiles WHERE agent_id = $1', [agentId]),
      this.pool.query('SELECT * FROM agent_rules WHERE agent_id = $1', [agentId]),
      this.pool.query(
        `SELECT * FROM agent_knowledge_sources
         WHERE agent_id = $1
         ORDER BY enabled DESC, source_type ASC, updated_at DESC`,
        [agentId]
      ),
    ]);

    const agent = agentResult.rows[0];
    if (!agent) {
      const error = new Error('Agente no encontrado') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    return {
      ...normalizeAgent(agent),
      profile: normalizeProfile(profileResult.rows[0] || null),
      rules: normalizeRules(rulesResult.rows[0] || null),
      knowledge: knowledgeResult.rows.map(normalizeKnowledge),
    };
  }

  async create(companyId: number, userId: number | null, input: any): Promise<AiAgent> {
    const name = String(input?.name || 'Agente principal').trim();
    if (!name) throw new Error('Nombre de agente requerido');

    const purpose = normalizePurpose(input?.purpose);
    const moduleAccess = normalizeModuleAccess(input?.moduleAccess || input?.module_access_json, purpose);
    const toolAccess = normalizeToolAccess(input?.toolAccess || input?.tool_access_json, moduleAccess);
    const triggerRules = normalizeTriggerRules(input?.triggerRules || input?.trigger_rules_json, purpose);
    const catalogScope = normalizeCatalogScope(input?.catalogScope || input?.catalog_scope_json);
    const mode = (input?.mode || 'suggest') as AgentMode;
    const status = (input?.status || 'draft') as AgentStatus;
    const provider = input?.provider || config.ai.provider;
    const model = input?.model || null;

    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO ai_agents (
           company_id, name, status, mode, provider, model, purpose,
           module_access_json, trigger_rules_json, catalog_scope_json, tool_access_json,
           is_default, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, NOT EXISTS (
           SELECT 1 FROM ai_agents WHERE company_id = $1 AND status <> 'archived'
         ), $12)
         RETURNING *`,
        [companyId, name, status, mode, provider, model, purpose, json(moduleAccess), json(triggerRules), json(catalogScope), json(toolAccess), userId]
      );
      const agent = result.rows[0];
      await client.query(
        `INSERT INTO agent_prompt_profiles (
           agent_id, business_description, communication_style, selling_scope,
           forbidden_claims, language, tone, style, welcome_message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          agent.id,
          input?.profile?.businessDescription || '',
          input?.profile?.communicationStyle || '',
          input?.profile?.sellingScope || '',
          input?.profile?.forbiddenClaims || '',
          input?.profile?.language || 'es',
          input?.profile?.tone || 'amable, claro y profesional',
          input?.profile?.style || '',
          input?.profile?.welcomeMessage || '',
        ]
      );
      await client.query(
        `INSERT INTO agent_rules (
           agent_id, auto_reply_when, suggest_when, handoff_when,
           business_hours_json, confidence_threshold, blocked_topics,
           sensitive_topics, max_context_messages
         )
         VALUES ($1, '', '', '', $2::jsonb, 0.75, '{}'::text[], '{}'::text[], 12)`,
        [agent.id, json(normalizeBusinessHours({}))]
      );
      await client.query('COMMIT');
      return this.get(companyId, Number(agent.id));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    const current = await this.get(companyId, agentId);
    const hasDefaultInput = typeof input?.isDefault === 'boolean' || typeof input?.is_default === 'boolean';
    const nextIsDefault = input?.isDefault ?? input?.is_default;
    const purpose = normalizePurpose(input?.purpose ?? current.purpose);
    const moduleAccess = normalizeModuleAccess(input?.moduleAccess ?? current.moduleAccess, purpose);
    const toolAccess = normalizeToolAccess(input?.toolAccess ?? current.toolAccess, moduleAccess);
    const triggerRules = normalizeTriggerRules(input?.triggerRules ?? current.triggerRules, purpose);
    const catalogScope = normalizeCatalogScope(input?.catalogScope ?? current.catalogScope);

    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');
      if (hasDefaultInput && nextIsDefault === true) {
        await client.query(
          `UPDATE ai_agents SET is_default = false, updated_at = NOW()
           WHERE company_id = $1 AND id <> $2 AND status <> 'archived'`,
          [companyId, agentId]
        );
      }
      await client.query(
        `UPDATE ai_agents
         SET name = $1, status = $2, mode = $3, provider = $4, model = $5, purpose = $6,
             module_access_json = $7::jsonb, trigger_rules_json = $8::jsonb, catalog_scope_json = $9::jsonb,
             tool_access_json = $10::jsonb, is_default = $11, updated_at = NOW()
         WHERE id = $12 AND company_id = $13`,
        [
          input?.name ?? current.name,
          input?.status ?? current.status,
          input?.mode ?? current.mode,
          input?.provider ?? current.provider,
          input?.model ?? current.model ?? null,
          purpose,
          json(moduleAccess),
          json(triggerRules),
          json(catalogScope),
          json(toolAccess),
          hasDefaultInput ? Boolean(nextIsDefault) : Boolean(current.isDefault),
          agentId,
          companyId,
        ]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(companyId, agentId);
  }

  async updateFlags(
    companyId: number,
    agentId: number,
    flags: { autoConfirmOrders?: boolean; autoCreateVouchers?: boolean; autoGeneratePaymentLinks?: boolean }
  ): Promise<AiAgent> {
    await this.pool.query(
      `UPDATE ai_agents
       SET auto_confirm_orders = COALESCE($3, auto_confirm_orders),
           auto_create_vouchers = COALESCE($4, auto_create_vouchers),
           auto_generate_payment_links = COALESCE($5, auto_generate_payment_links),
           updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [agentId, companyId, flags.autoConfirmOrders ?? null, flags.autoCreateVouchers ?? null, flags.autoGeneratePaymentLinks ?? null]
    );
    return this.get(companyId, agentId);
  }

  async archive(companyId: number, agentId: number): Promise<void> {
    await this.pool.query(
      `UPDATE ai_agents SET status = 'archived', is_default = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [agentId, companyId]
    );
  }

  async updateProfile(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    await this.assertAgent(companyId, agentId);
    await this.pool.query(
      `INSERT INTO agent_prompt_profiles (
         agent_id, business_description, communication_style, selling_scope,
         forbidden_claims, language, tone, style, welcome_message, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (agent_id)
       DO UPDATE SET
         business_description = EXCLUDED.business_description,
         communication_style = EXCLUDED.communication_style,
         selling_scope = EXCLUDED.selling_scope,
         forbidden_claims = EXCLUDED.forbidden_claims,
         language = EXCLUDED.language,
         tone = EXCLUDED.tone,
         style = EXCLUDED.style,
         welcome_message = EXCLUDED.welcome_message,
         updated_at = NOW()`,
      [
        agentId,
        input?.businessDescription ?? input?.business_description ?? '',
        input?.communicationStyle ?? input?.communication_style ?? '',
        input?.sellingScope ?? input?.selling_scope ?? '',
        input?.forbiddenClaims ?? input?.forbidden_claims ?? '',
        input?.language || 'es',
        input?.tone || 'amable, claro y profesional',
        input?.style || '',
        input?.welcomeMessage ?? input?.welcome_message ?? '',
      ]
    );
    return this.get(companyId, agentId);
  }

  async updateRules(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    await this.assertAgent(companyId, agentId);
    await this.pool.query(
      `INSERT INTO agent_rules (
         agent_id, auto_reply_when, suggest_when, handoff_when,
         business_hours_json, confidence_threshold, blocked_topics,
         sensitive_topics, max_context_messages, updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::text[], $8::text[], $9, NOW())
       ON CONFLICT (agent_id)
       DO UPDATE SET
         auto_reply_when = EXCLUDED.auto_reply_when,
         suggest_when = EXCLUDED.suggest_when,
         handoff_when = EXCLUDED.handoff_when,
         business_hours_json = EXCLUDED.business_hours_json,
         confidence_threshold = EXCLUDED.confidence_threshold,
         blocked_topics = EXCLUDED.blocked_topics,
         sensitive_topics = EXCLUDED.sensitive_topics,
         max_context_messages = EXCLUDED.max_context_messages,
         updated_at = NOW()`,
      [
        agentId,
        input?.autoReplyWhen || input?.auto_reply_when || '',
        input?.suggestWhen || input?.suggest_when || '',
        input?.handoffWhen || input?.handoff_when || '',
        json(normalizeBusinessHours(input?.businessHours || {})),
        clampConfidence(input?.confidenceThreshold ?? 0.75),
        parseTextArray(input?.blockedTopics),
        parseTextArray(input?.sensitiveTopics),
        clampContextMessages(input?.maxContextMessages),
      ]
    );
    return this.get(companyId, agentId);
  }

  async createKnowledge(companyId: number, agentId: number, input: any): Promise<AgentKnowledgeSource> {
    await this.assertAgent(companyId, agentId);
    const result = await this.pool.query(
      `INSERT INTO agent_knowledge_sources (
         agent_id, source_type, title, content, url, metadata_json, enabled
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        agentId,
        input?.sourceType || 'faq',
        String(input?.title || 'Conocimiento').trim(),
        input?.content || '',
        input?.url || null,
        json(input?.metadata || {}),
        input?.enabled !== false,
      ]
    );
    return normalizeKnowledge(result.rows[0]);
  }

  async updateKnowledge(companyId: number, agentId: number, sourceId: number, input: any): Promise<AgentKnowledgeSource> {
    await this.assertAgent(companyId, agentId);
    const currentResult = await this.pool.query(
      'SELECT * FROM agent_knowledge_sources WHERE id = $1 AND agent_id = $2',
      [sourceId, agentId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error('Fuente de conocimiento no encontrada');

    const result = await this.pool.query(
      `UPDATE agent_knowledge_sources
       SET source_type = $1, title = $2, content = $3, url = $4, metadata_json = $5::jsonb, enabled = $6, updated_at = NOW()
       WHERE id = $7 AND agent_id = $8 RETURNING *`,
      [
        input?.sourceType || current.source_type,
        input?.title ?? current.title,
        input?.content ?? current.content,
        input?.url ?? current.url,
        json(input?.metadata || current.metadata_json || {}),
        input?.enabled ?? current.enabled,
        sourceId,
        agentId,
      ]
    );
    return normalizeKnowledge(result.rows[0]);
  }

  async deleteKnowledge(companyId: number, agentId: number, sourceId: number): Promise<void> {
    await this.assertAgent(companyId, agentId);
    await this.pool.query('DELETE FROM agent_knowledge_sources WHERE id = $1 AND agent_id = $2', [sourceId, agentId]);
  }

  async getDefaultActiveAgent(companyId: number, message: string): Promise<AiAgent | null> {
    const result = await this.pool.query(
      `SELECT id FROM ai_agents
       WHERE company_id = $1 AND status = 'active' AND mode <> 'disabled'
       ORDER BY is_default DESC, updated_at DESC`,
      [companyId]
    );
    const agents: AiAgent[] = [];
    for (const row of result.rows) {
      agents.push(await this.get(companyId, Number(row.id)));
    }
    if (agents.length === 0) return null;

    const evaluated = this.evaluateTriggerRules(message);
    if (evaluated.routeToSales) {
      const salesAgent = agents.find((agent) =>
        agent.purpose === 'sales_assistant' &&
        agent.moduleAccess?.catalog !== false &&
        this.canTriggerForCommercialIntent(agent, evaluated.routeToSales)
      );
      if (salesAgent) return salesAgent;
    }

    return agents.find((agent) => this.canTriggerForCommercialIntent(agent, evaluated.routeToSales)) || agents[0] || null;
  }

  evaluateTriggerRules(message: string): { routeToSales: boolean; mentionsPayment: boolean } {
    const text = String(message || '');
    const commercialRegex = /\b(compr|precio|cuanto|cuánto|cotiz|pedido|producto|stock|disponible|pagar|venta|quiero|reserv|curso|suscripcion|suscripción|servicio)\b/i;
    const paymentRegex = /\b(yape|plin|transferencia|deposito|comprobante|pago enviado|banco|bcp|interbank|bbva)\b/i;
    return {
      routeToSales: commercialRegex.test(text),
      mentionsPayment: paymentRegex.test(text),
    };
  }

  private canTriggerForCommercialIntent(agent: AiAgent, hasCommercialIntent: boolean): boolean {
    const rules = normalizeTriggerRules(agent.triggerRules, agent.purpose);
    const intent = rules.commercialIntent;
    if (intent === 'always') return true;
    if (intent === 'never') return !hasCommercialIntent;
    if (intent === 'regex') return hasCommercialIntent;
    return Boolean(intent) === true ? hasCommercialIntent : !hasCommercialIntent;
  }

  async getCatalogForAgent(companyId: number, agent: AiAgent): Promise<any[]> {
    const moduleAccess = agent.moduleAccess || {};
    const canUseCatalog = moduleAccess.catalog !== false && (agent.purpose === 'sales_assistant' || moduleAccess.catalog === true);
    if (!canUseCatalog) return [];
    const scope = agent.catalogScope || { catalogIds: [], sectionIds: [] };
    const catalogIds = Array.isArray(scope.catalogIds) ? scope.catalogIds.map(Number).filter(Boolean) : [];
    const sectionIds = Array.isArray(scope.sectionIds) ? scope.sectionIds.map(Number).filter(Boolean) : [];
    if (catalogIds.length === 0 && sectionIds.length === 0) return [];
    return new ProductRepositoryPg(this.pool).findActiveForAgent(companyId, { catalogIds, sectionIds });
  }

  async getAutomatorMode(companyId: number): Promise<'normal' | 'mixed' | 'automator'> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT automator_mode FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    const value = result.rows[0]?.automator_mode || 'normal';
    return ['normal', 'mixed', 'automator'].includes(value) ? value : 'normal';
  }

  async setAutomatorMode(companyId: number, mode: 'normal' | 'mixed' | 'automator'): Promise<void> {
    await this.pool.query(
      `WITH default_plan AS (
         INSERT INTO plans (code, name, description)
         VALUES ('default', 'Default', 'Plan base creado automaticamente para configuracion de empresa')
         ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
         RETURNING id
       )
       INSERT INTO company_settings (company_id, plan_id, automator_mode)
       SELECT $1, id, $2 FROM default_plan
       ON CONFLICT (company_id)
       DO UPDATE SET automator_mode = EXCLUDED.automator_mode, updated_at = NOW()`,
      [companyId, mode]
    );
  }

  private async assertAgent(companyId: number, agentId: number): Promise<void> {
    const result = await this.pool.query(
      `SELECT id FROM ai_agents WHERE id = $1 AND company_id = $2 AND status <> 'archived'`,
      [agentId, companyId]
    );
    if (!result.rows[0]) {
      const error = new Error('Agente no encontrado') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
  }
}
