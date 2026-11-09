import fs from 'fs/promises';
import path from 'path';
import pool from '../../config/database';
import { queryInTenantScope } from '../../db/TenantScopedUoW';
import config from '../../config/index';
import {
  AgentDecisionEngine,
  AgentHandoffService,
  AgentPauseService,
  AgentPaymentLinkService,
  AgentRepositoryPg,
  AgentRuntimeLogRepositoryPg,
  AgentToolLogger,
  AgentToolRegistry,
  AgentToolExecutor,
  AgentToolRuntimeLoop,
  AgentVoucherService,
  AiChatSessionService,
  AiAgent,
  AiDomainKey,
  AiDomainSummary,
  AgentAction,
  AgentRuntimeResult,
  AgentRuntimeLogInput,
  AgentRuntimeLogEntry,
  AgentConversationMessage,
  RunAgentInput,
  AutomatorMode,
  HandoffTicket,
  HandoffTicketSummary,
  IaPauseStatus,
  PaymentGatewayRepositoryPg,
  AiSessionEventService,
  AiSessionRepositoryPg,
  getAiProviderFactory,
  getDefaultToolRegistry,
} from '../../modules/ai';
import { PaymentRepositoryPg } from '../../modules/payments';
import { emitDashboard, emitToRoom } from '../../sockets/socketEmitter';

type UploadedAgentFile = {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
  filename: string;
};

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

async function readTextPreview(file: UploadedAgentFile): Promise<string> {
  const isTextLike = /^text\//i.test(file.mimetype)
    || /json|csv|xml|yaml|markdown|javascript|typescript|sql/i.test(file.mimetype)
    || /\.(txt|md|csv|json|xml|yml|yaml|html|css|js|ts|sql)$/i.test(file.originalname);
  if (!isTextLike) {
    return `Archivo cargado: ${file.originalname}\nTipo: ${file.mimetype || 'desconocido'}\nTamano: ${file.size} bytes.`;
  }
  const buffer = await fs.readFile(file.path);
  return buffer.toString('utf8').slice(0, 200000);
}

export class AgentService {
  private readonly agentRepo: AgentRepositoryPg;
  private readonly logRepo: AgentRuntimeLogRepositoryPg;
  private readonly handoffRepo: PaymentGatewayRepositoryPg | null;
  private readonly handoffService: AgentHandoffService;
  private readonly pauseService: AgentPauseService;
  private readonly voucherService: AgentVoucherService;
  private readonly paymentLinkService: AgentPaymentLinkService;
  private readonly decisionEngine: AgentDecisionEngine;
  private readonly gatewayRepo: PaymentGatewayRepositoryPg;
  private readonly aiSessionRepo: AiSessionRepositoryPg;
  private readonly aiSessionEventService: AiSessionEventService;
  private readonly aiChatSessionService: AiChatSessionService;

  constructor() {
    this.agentRepo = new AgentRepositoryPg(pool);
    this.logRepo = new AgentRuntimeLogRepositoryPg(pool);
    this.gatewayRepo = new PaymentGatewayRepositoryPg(pool);
    this.aiSessionRepo = new AiSessionRepositoryPg(pool);
    this.aiSessionEventService = new AiSessionEventService(this.aiSessionRepo);
    this.aiChatSessionService = new AiChatSessionService(this.aiSessionRepo, this.aiSessionEventService);
    this.handoffService = new AgentHandoffService(new (require('../../modules/ai').HandoffTicketRepositoryPg)(pool));
    this.pauseService = new AgentPauseService(new (require('../../modules/ai').IaPauseOverrideRepositoryPg)(pool));
    this.voucherService = new AgentVoucherService(new PaymentRepositoryPg(pool));
    this.paymentLinkService = new AgentPaymentLinkService(this.gatewayRepo);
    this.decisionEngine = new AgentDecisionEngine();
    this.handoffRepo = null;
  }

  getProviderStatus(): Record<string, unknown> {
    return getAiProviderFactory().getDefault().getStatus();
  }

  async listProviderModels(): Promise<Record<string, unknown>[]> {
    return getAiProviderFactory().getDefault().listModels();
  }

  async testProvider(input: { model?: string | null }): Promise<Record<string, unknown>> {
    return getAiProviderFactory().getDefault().testConnection(input?.model || null);
  }

  async logRuntimeEvent(input: AgentRuntimeLogInput): Promise<void> {
    return this.logRepo.log(input);
  }

  async listRuntimeLogs(companyId: number, input: { chatId?: string | null; limit?: number; status?: string; action?: string }): Promise<AgentRuntimeLogEntry[]> {
    return this.logRepo.list(companyId, input);
  }

  async listAgents(companyId: number): Promise<AiAgent[]> {
    return this.agentRepo.list(companyId);
  }

  async createAgent(companyId: number, userId: number | null, input: any): Promise<AiAgent> {
    const agent = await this.agentRepo.create(companyId, userId, input);
    if (input?.domainKey) {
      await this.agentRepo.assignDomainAgent(companyId, input.domainKey, agent.id);
    }
    return agent;
  }

  async getAgent(companyId: number, agentId: number): Promise<AiAgent> {
    return this.agentRepo.get(companyId, agentId);
  }

  async updateAgent(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    const agent = await this.agentRepo.update(companyId, agentId, input);
    if (input?.autoConfirmOrders !== undefined || input?.autoCreateVouchers !== undefined || input?.autoGeneratePaymentLinks !== undefined) {
      return this.agentRepo.updateFlags(companyId, agentId, {
        autoConfirmOrders: input.autoConfirmOrders,
        autoCreateVouchers: input.autoCreateVouchers,
        autoGeneratePaymentLinks: input.autoGeneratePaymentLinks,
      });
    }
    return agent;
  }

  async archiveAgent(companyId: number, agentId: number): Promise<void> {
    return this.agentRepo.archive(companyId, agentId);
  }

  async updateProfile(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    return this.agentRepo.updateProfile(companyId, agentId, input);
  }

  async updateRules(companyId: number, agentId: number, input: any): Promise<AiAgent> {
    return this.agentRepo.updateRules(companyId, agentId, input);
  }

  async createKnowledge(companyId: number, agentId: number, input: any): Promise<Record<string, unknown>> {
    return this.agentRepo.createKnowledge(companyId, agentId, input);
  }

  async createKnowledgeFromFile(
    companyId: number,
    agentId: number,
    file: UploadedAgentFile,
    input: any
  ): Promise<Record<string, unknown>> {
    await this.agentRepo.get(companyId, agentId);
    const content = input?.content || await readTextPreview(file);
    const metadata = {
      ...(input?.metadata || {}),
      file: {
        originalName: file.originalname,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
        storagePath: path.resolve(file.path),
        storedName: file.filename,
      },
    };
    const created = await this.agentRepo.createKnowledge(companyId, agentId, {
      sourceType: 'document',
      title: String(input?.title || file.originalname || 'Documento').trim(),
      content,
      url: null,
      metadata,
      enabled: input?.enabled !== false,
    });
    const updateResult = await pool.query(
      `UPDATE agent_knowledge_sources SET url = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [`/api/agents/${agentId}/knowledge/${created.id}/file`, created.id]
    );
    return updateResult.rows[0];
  }

  async updateKnowledge(companyId: number, agentId: number, sourceId: number, input: any): Promise<Record<string, unknown>> {
    return this.agentRepo.updateKnowledge(companyId, agentId, sourceId, input);
  }

  async deleteKnowledge(companyId: number, agentId: number, sourceId: number): Promise<void> {
    return this.agentRepo.deleteKnowledge(companyId, agentId, sourceId);
  }

  async getKnowledgeFile(companyId: number, agentId: number, sourceId: number): Promise<{ filePath: string; filename: string; mimeType: string }> {
    await this.agentRepo.get(companyId, agentId);
    const result = await pool.query(
      'SELECT * FROM agent_knowledge_sources WHERE id = $1 AND agent_id = $2',
      [sourceId, agentId]
    );
    const source = result.rows[0];
    const file = source?.metadata_json?.file;
    if (!file?.storagePath) {
      const error = new Error('El conocimiento no tiene archivo asociado') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const uploadRoot = path.resolve(config.whatsapp.uploadDir);
    const filePath = path.resolve(String(file.storagePath));
    if (!filePath.startsWith(uploadRoot)) {
      const error = new Error('Ruta de archivo no valida') as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    await fs.access(filePath);
    return {
      filePath,
      filename: String(file.originalName || source.title || 'archivo'),
      mimeType: String(file.mimeType || 'application/octet-stream'),
    };
  }

  async getAutomatorMode(companyId: number): Promise<AutomatorMode> {
    return this.agentRepo.getAutomatorMode(companyId);
  }

  async setAutomatorMode(companyId: number, mode: AutomatorMode): Promise<void> {
    await this.agentRepo.setAutomatorMode(companyId, mode);
    emitDashboard('company-mode-changed', { companyId, mode });
  }

  async listDomains(companyId: number): Promise<AiDomainSummary[]> {
    return this.agentRepo.listDomains(companyId);
  }

  async activateDomain(companyId: number, domainKey: AiDomainKey | string): Promise<AiDomainSummary> {
    return this.agentRepo.activateDomain(companyId, domainKey);
  }

  async assignDomainAgent(companyId: number, domainKey: AiDomainKey | string, agentId: number | null): Promise<AiDomainSummary> {
    return this.agentRepo.assignDomainAgent(companyId, domainKey, agentId);
  }

  async deployDomainAgent(companyId: number, domainKey: AiDomainKey | string, agentId: number, patch?: Partial<AiAgent>): Promise<AiDomainSummary> {
    if (String(domainKey) !== 'gestion_web') {
      const error = new Error('En v1 solo gestion_web permite runtime Deploy AI') as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    let agent = await this.agentRepo.get(companyId, agentId);
    if (patch && Object.keys(patch).length > 0) {
      const safePatch: Partial<AiAgent> = {};
      for (const key of ['name', 'mode', 'model', 'provider', 'moduleAccess', 'toolAccess', 'catalogScope'] as const) {
        if (patch[key] !== undefined) (safePatch as any)[key] = patch[key];
      }
      if (Object.keys(safePatch).length > 0) {
        agent = await this.updateAgent(companyId, agentId, safePatch);
      }
      if (patch.profile) {
        agent = await this.updateProfile(companyId, agentId, patch.profile);
      }
      if (patch.rules) {
        agent = await this.updateRules(companyId, agentId, patch.rules);
      }
    }
    if (agent.mode === 'disabled' || patch?.mode === 'disabled') {
      const error = new Error('No se puede deployar un agente en modo Desactivado') as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    if (agent.status !== 'active' || patch?.status !== 'active') {
      await this.agentRepo.update(companyId, agentId, { status: 'active' });
    }
    const domain = await this.agentRepo.assignDomainAgent(companyId, domainKey, agentId);
    emitDashboard('agent:deployed', { companyId, domainKey, agentId });
    return domain;
  }

  async getDomainAgent(companyId: number, domainKey: AiDomainKey | string): Promise<AiAgent | null> {
    return this.agentRepo.getDomainAgent(companyId, domainKey);
  }

  async listDomainActivity(companyId: number, domainKey: AiDomainKey | string, filters: {
    agentId?: number | null;
    status?: string | null;
    tool?: string | null;
    chatId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    limit?: number;
  } = {}): Promise<any[]> {
    return this.aiSessionRepo.listActivityByDomain(companyId, String(domainKey), filters) as any;
  }

  async getDomainMetrics(companyId: number, domainKey: AiDomainKey | string): Promise<Record<string, unknown>> {
    return this.aiSessionRepo.getDomainMetrics(companyId, String(domainKey));
  }

  async listChatAgentActivity(companyId: number, chatId: string, limit = 50): Promise<any[]> {
    return this.aiSessionRepo.listActivityByChat(companyId, chatId, limit);
  }

  async getChatAiSession(companyId: number, chatId: string): Promise<any | null> {
    return this.aiSessionRepo.getSessionByChat(companyId, chatId, 'gestion_web');
  }

  async listDomainSessions(companyId: number, domainKey: AiDomainKey | string, limit = 100): Promise<any[]> {
    return this.aiSessionRepo.listSessionsByDomain(companyId, String(domainKey), limit);
  }

  async closeChatAiSessions(companyId: number, chatId: string): Promise<void> {
    const conversationId = await this.resolveConversationId(companyId, chatId);
    if (!conversationId) return;
    const sessions = await this.aiSessionRepo.updateSessionsByConversation(companyId, conversationId, 'closed');
    for (const session of sessions) {
      emitDashboard('agent:session_updated', {
        companyId,
        chatId: session.chatId,
        sessionId: session.id,
        status: 'closed',
        agentId: session.agentId,
        domainKey: session.domainKey,
      });
    }
  }

  async getDefaultActiveAgent(companyId: number, message = ''): Promise<AiAgent | null> {
    void message;
    const agent = await this.agentRepo.getDomainAgent(companyId, 'gestion_web');
    if (!agent || agent.status !== 'active' || agent.mode === 'disabled') return null;
    return agent;
  }

  async getConversationContext(
    companyId: number,
    chatId: string,
    options: { windowHours?: number; limit?: number; excludeProviderMessageId?: string | null } = {}
  ): Promise<AgentConversationMessage[]> {
    const normalizedChatId = String(chatId || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalizedChatId) return [];
    const limit = clampContextMessages(options.limit);
    const windowHours = options.windowHours ? Math.max(1, Math.min(Number(options.windowHours), 24 * 30)) : null;
    const result = await queryInTenantScope(pool, companyId,
      `SELECT m.direction, m.body, m.message_type, m.occurred_at
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.company_id = $1 AND c.channel = 'whatsapp' AND c.external_conversation_id = $2
         AND NULLIF(BTRIM(COALESCE(m.body, '')), '') IS NOT NULL
         AND ($3::varchar IS NULL OR m.provider_message_id <> $3)
         AND ($4::int IS NULL OR m.occurred_at >= NOW() - MAKE_INTERVAL(hours => $4))
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT $5`,
      [companyId, normalizedChatId, options.excludeProviderMessageId || null, windowHours, limit]
    );
    return result.rows.reverse().map((row) => ({
      fromMe: row.direction === 'outbound',
      body: row.body || '',
      timestamp: row.occurred_at,
      type: row.message_type || 'text',
    }));
  }

  async runAgent(companyId: number, agentId: number, input: RunAgentInput, userId: number | null): Promise<AgentRuntimeResult> {
    const agent = await this.agentRepo.get(companyId, agentId);
    const requestedMode = String(input.mode || agent.mode || 'suggest');
    const mode = (requestedMode === 'auto' || requestedMode === 'disabled' || requestedMode === 'suggest'
      ? requestedMode
      : agent.mode || 'suggest') as AiAgent['mode'];
    const companyMode = this.modeToAutomatorMode(mode);

    if (mode === 'disabled') {
      return {
        reply: '',
        confidence: 0,
        action: 'handoff',
        reason: 'Agente desactivado',
        usedKnowledgeIds: [],
        provider: String(agent.provider || 'opencode'),
      };
    }

    const rules = agent.rules;
    if (rules && !this.isWithinBusinessHours(rules.businessHours)) {
      return {
        reply: '',
        confidence: 1,
        action: 'handoff',
        reason: 'Agente fuera del horario operativo configurado',
        usedKnowledgeIds: [],
        provider: String(agent.provider || 'opencode'),
      };
    }

    const hasProvidedHistory = Array.isArray(input.history);
    const recentHistory = hasProvidedHistory
      ? input.history || []
      : input.chatId
        ? await this.getConversationContext(companyId, input.chatId, {
          windowHours: 24,
          limit: clampContextMessages(rules?.maxContextMessages),
          excludeProviderMessageId: input.inboundProviderMessageId,
        })
        : [];

    const conversationId = input.chatId ? await this.resolveConversationId(companyId, input.chatId) : null;
    const isTest = input.mode === 'test' || input.mode === 'sandbox' || !input.chatId;
    let sessionId: number | null = null;
    let turnId: number | null = null;
    if (input.chatId && conversationId) {
      const started = await this.aiChatSessionService.startTurn({
        companyId,
        domainKey: 'gestion_web',
        conversationId,
        chatId: input.chatId,
        agentId,
        inboundProviderMessageId: input.inboundProviderMessageId || null,
        mode: mode === 'auto' ? 'auto' : 'suggest',
        isTest,
      });
      sessionId = started.sessionId;
      turnId = started.turnId;
    }
    const ctx = {
      companyId,
      conversationId,
      chatId: input.chatId || null,
      domainKey: 'gestion_web',
      sessionId,
      turnId,
      agentId,
      agentPurpose: agent.purpose,
      companyMode,
      agentMode: mode,
      moduleAccess: agent.moduleAccess,
      toolAccess: agent.toolAccess || {},
      catalogScope: agent.catalogScope || { catalogIds: [], sectionIds: [] },
      inboundProviderMessageId: input.inboundProviderMessageId || null,
      actorUserId: userId,
      isTest,
    };

    const registry = getDefaultToolRegistry();
    const logger = new AgentToolLogger(this.logRepo, this.aiSessionEventService);
    const executor = new AgentToolExecutor(pool, registry, logger);
    const loop = new AgentToolRuntimeLoop(pool, registry, logger, executor);

    if (input.chatId) emitToRoom(input.chatId, 'agent:typing', { chatId: input.chatId, agentId });

    const loopResult = await loop.run({
      ctx,
      agent,
      message: String(input.message || ''),
      history: recentHistory.map((h) => ({ fromMe: h.fromMe, body: h.body })),
      companyMode,
    });

    const final = loopResult.final;
    const action: AgentAction = final?.action || 'handoff';
    const confidence = final?.confidence ?? 0;
    const threshold = Number(rules?.confidenceThreshold ?? 0.75);
    const blockedTopicHit = rules ? this.decisionEngine.detectBlockedTopic(final?.reply || '', rules.blockedTopics) : null;

    const decision = this.decisionEngine.resolve({
      rawAction: action,
      confidence,
      threshold,
      agentMode: mode,
      companyMode,
      agent,
      detectedOrder: null,
      productAvailability: [],
      blockedTopicHit,
    });

    const output: AgentRuntimeResult = {
      reply: String(final?.reply || '').trim(),
      confidence,
      action: decision.action,
      reason: decision.reason || String(final?.reason || loopResult.fallbackReason || ''),
      usedKnowledgeIds: [],
      detectedOrder: final?.detectedOrder
        ? {
            intent: final.detectedOrder.intent,
            confidence,
            items: final.detectedOrder.items.map((i) => ({
              commercialItemId: i.commercialItemId,
              detectedName: '',
              productName: '',
              quantity: i.quantity,
              confidence,
              ambiguous: false,
            })),
            customerConfirmed: final.detectedOrder.customerConfirmed,
            recommendedAction: final.detectedOrder.recommendedAction,
            notes: '',
            reason: final.reason || '',
          }
        : null,
      provider: String(agent.provider || 'opencode'),
      context: {
        source: hasProvidedHistory ? 'provided' : input.chatId ? 'recent_24h' : 'none',
        messages: recentHistory.length,
        expanded: false,
        expandedMessages: 0,
      },
      canAutoConfirmOrder: decision.canAutoConfirmOrder,
      canCreateVoucher: decision.canCreateVoucher,
      canGeneratePaymentLink: decision.canGeneratePaymentLink,
      commandCount: loopResult.toolResults.length,
      commands: loopResult.toolResults.map((result) => ({ toolName: result.toolName, status: result.status })),
      isTest,
    };

    if (sessionId && turnId && conversationId && input.chatId) {
      await this.aiChatSessionService.completeTurn({
        companyId,
        sessionId,
        turnId,
        domainKey: 'gestion_web',
        conversationId,
        chatId: input.chatId,
        agentId,
        status: 'ok',
        finalAction: output.action,
        finalReply: output.reply,
        commandCount: loopResult.toolResults.length,
        isTest,
      });
      if (output.action === 'handoff') {
        await this.aiChatSessionService.markSessionStatus({ companyId, sessionId, status: 'handoff', chatId: input.chatId, agentId, domainKey: 'gestion_web' });
      }
    }

    await pool.query(
      `INSERT INTO agent_test_runs (agent_id, company_id, input_message, output_json, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [agentId, companyId, input.message || '', JSON.stringify(output), userId]
    );

    if (decision.action === 'suggest' && input.chatId) {
      emitToRoom(input.chatId, 'agent:suggestion', {
        chatId: input.chatId,
        agentId,
        reply: output.reply,
        confidence: output.confidence,
        action: output.action,
        reason: output.reason,
        usedKnowledgeIds: output.usedKnowledgeIds,
      });
      emitDashboard('agent:suggestion', {
        companyId,
        chatId: input.chatId,
        agentId,
        reply: output.reply,
        confidence: output.confidence,
        action: output.action,
        reason: output.reason,
      });
    }

    if (decision.action === 'block' && input.chatId) {
      emitToRoom(input.chatId, 'agent:blocked', {
        chatId: input.chatId,
        agentId,
        reason: output.reason,
        topic: blockedTopicHit,
      });
      emitDashboard('agent:blocked', { companyId, chatId: input.chatId, agentId, reason: output.reason, topic: blockedTopicHit });
    }

    return output;
  }

  async runAgentTestSession(
    companyId: number,
    agentId: number,
    input: { message: string; history?: Array<{ fromMe: boolean; body: string }>; domainKey?: 'gestion_web' },
    userId: number | null
  ): Promise<AgentRuntimeResult & { turn: any | null }> {
    const chatId = await this.ensureSandboxConversation(companyId, agentId, userId);
    const result = await this.runAgent(
      companyId,
      agentId,
      {
        message: input.message || '',
        history: input.history || [],
        chatId,
        mode: 'sandbox',
        inboundProviderMessageId: `sandbox-${Date.now()}`,
      },
      userId
    );
    const activity = await this.listChatAgentActivity(companyId, chatId, 1);
    return { ...result, turn: activity[0] || null };
  }

  private async resolveConversationId(companyId: number, chatId: string): Promise<number | null> {
    const normalized = String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalized) return null;
    const result = await pool.query(
      `SELECT id FROM conversations
       WHERE company_id = $1 AND channel IN ('whatsapp', 'ai_sandbox')
         AND external_conversation_id = ANY($2::varchar[])
       ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  }

  private async ensureSandboxConversation(companyId: number, agentId: number, userId: number | null): Promise<string> {
    const chatId = `agent-test:${agentId}:${userId || 0}`;
    await pool.query(
      `INSERT INTO conversations (
         company_id, channel, external_conversation_id, type, title,
         last_message_at, metadata_json, created_at, updated_at
       )
       VALUES ($1, 'ai_sandbox', $2, 'agent_test', $3, NOW(), $4::jsonb, NOW(), NOW())
       ON CONFLICT (company_id, channel, external_conversation_id)
       DO UPDATE SET last_message_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [
        companyId,
        chatId,
        `Prueba agente ${agentId}`,
        JSON.stringify({ source: 'agent_test_session', agentId, userId }),
      ]
    );
    return chatId;
  }

  private modeToAutomatorMode(mode: AiAgent['mode']): AutomatorMode {
    if (mode === 'auto') return 'automator';
    if (mode === 'suggest') return 'mixed';
    return 'normal';
  }

  async isConversationPaused(companyId: number, chatId: string): Promise<boolean> {
    return this.pauseService.isPaused(companyId, chatId);
  }

  async pauseConversation(input: {
    companyId: number;
    conversationId: number;
    chatId?: string | null;
    pausedBy?: number | null;
    reason?: string | null;
    durationHours?: number;
  }) {
    const override = await this.pauseService.pause(input);
    const sessions = await this.aiSessionRepo.updateSessionsByConversation(input.companyId, input.conversationId, 'paused');
    for (const session of sessions) {
      emitDashboard('agent:session_updated', {
        companyId: input.companyId,
        chatId: input.chatId || session.chatId,
        sessionId: session.id,
        status: 'paused',
        agentId: session.agentId,
        domainKey: session.domainKey,
      });
    }
    return override;
  }

  async resumeConversation(companyId: number, conversationId: number, chatId?: string | null) {
    await this.pauseService.resume(companyId, conversationId, chatId);
    const sessions = await this.aiSessionRepo.updateSessionsByConversation(companyId, conversationId, 'active');
    for (const session of sessions) {
      emitDashboard('agent:session_updated', {
        companyId,
        chatId: chatId || session.chatId,
        sessionId: session.id,
        status: 'active',
        agentId: session.agentId,
        domainKey: session.domainKey,
      });
    }
  }

  async getPauseStatus(companyId: number, conversationId: number): Promise<IaPauseStatus> {
    return this.pauseService.getStatus(companyId, conversationId);
  }

  async listHandoffTickets(
    companyId: number,
    filters: { status?: string; conversationId?: number; takenBy?: number; limit?: number; offset?: number }
  ): Promise<{ rows: HandoffTicketSummary[]; total: number }> {
    return this.handoffService.list(companyId, filters);
  }

  async takeHandoffTicket(companyId: number, ticketId: number, userId: number): Promise<HandoffTicket | null> {
    return this.handoffService.take(companyId, ticketId, userId);
  }

  async closeHandoffTicket(companyId: number, ticketId: number, userId: number, input: { notes?: string | null; outcome: HandoffTicket['outcome'] }): Promise<HandoffTicket | null> {
    return this.handoffService.close(companyId, ticketId, userId, input);
  }

  async countOpenHandoffTickets(companyId: number): Promise<number> {
    return this.handoffService.countOpen(companyId);
  }

  async createHandoffTicket(input: {
    companyId: number;
    chatId: string;
    agentId?: number | null;
    orderId?: number | null;
    reason: string;
    priority?: 'low' | 'medium' | 'high';
    metadata?: Record<string, unknown>;
  }): Promise<{ ticketId: number; conversationId: number | null } | null> {
    const conversationId = await this.resolveConversationId(input.companyId, input.chatId);
    if (!conversationId) return null;
    const ticket = await this.handoffService.createTicket({
      companyId: input.companyId,
      conversationId,
      chatId: input.chatId,
      agentId: input.agentId ?? null,
      orderId: input.orderId ?? null,
      reason: input.reason,
      priority: input.priority,
      metadata: input.metadata,
    });
    return { ticketId: ticket.id, conversationId };
  }

  async listGateways(companyId: number) {
    return this.gatewayRepo.list(companyId);
  }

  async createGateway(companyId: number, input: any) {
    return this.gatewayRepo.create(companyId, input);
  }

  async updateGateway(companyId: number, gatewayId: number, input: any) {
    return this.gatewayRepo.update(companyId, gatewayId, input);
  }

  async archiveGateway(companyId: number, gatewayId: number): Promise<void> {
    return this.gatewayRepo.archive(companyId, gatewayId);
  }

  async getDefaultGateway(companyId: number) {
    return this.gatewayRepo.getDefault(companyId);
  }

  detectVoucher(input: { messageBody: string; attachments: Array<{ fileUrl: string; mimeType: string | null; fileSize: number | null }> }) {
    return this.voucherService.detect(input);
  }

  async createVoucherFromMessage(input: {
    companyId: number;
    chatId: string;
    conversationId: number | null;
    contactId: number | null;
    sourceMessageId: number | null;
    detection: ReturnType<AgentVoucherService['detect']>;
    agentId: number | null;
    notes?: string | null;
  }) {
    return this.voucherService.createFromMessage(input);
  }

  private isWithinBusinessHours(input: any): boolean {
    const hours = input || {};
    if (!hours.enabled) return true;
    const timezone = String(hours.timezone || 'America/Lima');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
    const dayMap: Record<string, string> = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
    const currentDay = dayMap[part('weekday')] || '';
    const days = Array.isArray(hours.days) ? hours.days.map(String) : [];
    if (days.length > 0 && !days.includes(currentDay)) return false;
    const toMinutes = (value: unknown): number => {
      const [hour, minute] = String(value || '00:00').split(':').map(Number);
      return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
    };
    const current = toMinutes(`${part('hour')}:${part('minute')}`);
    const start = toMinutes(hours.start);
    const end = toMinutes(hours.end);
    if (start === end) return true;
    if (start < end) return current >= start && current <= end;
    return current >= start || current <= end;
  }
}

export default AgentService;
