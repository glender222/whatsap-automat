import { emitDashboard, emitConversation } from '../../../sockets/socketEmitter';
import { AiSessionRepositoryPg } from '../infra/db/AiSessionRepositoryPg';
import { AiSessionEventService } from './AiSessionEventService';

export class AiChatSessionService {
  constructor(
    private readonly repo: AiSessionRepositoryPg,
    private readonly eventService: AiSessionEventService
  ) {}

  async startTurn(input: {
    companyId: number;
    domainKey: string;
    conversationId: number;
    chatId: string;
    agentId: number | null;
    inboundProviderMessageId?: string | null;
    mode: 'suggest' | 'auto';
    isTest?: boolean;
  }): Promise<{ sessionId: number; turnId: number }> {
    const session = await this.repo.resolveOrCreateSession({
      companyId: input.companyId,
      domainKey: input.domainKey,
      conversationId: input.conversationId,
      chatId: input.chatId,
      agentId: input.agentId,
      inboundProviderMessageId: input.inboundProviderMessageId,
      metadata: { source: input.isTest ? 'sandbox' : 'runtime' },
    });
    const turn = await this.repo.createTurn({
      companyId: input.companyId,
      sessionId: session.id,
      domainKey: input.domainKey,
      conversationId: input.conversationId,
      chatId: input.chatId,
      agentId: input.agentId,
      inboundProviderMessageId: input.inboundProviderMessageId,
      mode: input.mode,
      isTest: input.isTest,
    });
    await this.eventService.record({
      companyId: input.companyId,
      sessionId: session.id,
      turnId: turn.id,
      domainKey: input.domainKey,
      conversationId: input.conversationId,
      chatId: input.chatId,
      agentId: input.agentId,
      kind: 'session',
      title: input.isTest ? 'Prueba de agente iniciada' : 'Turno IA iniciado',
      summary: input.isTest ? 'Sandbox sin mutaciones reales.' : 'La IA empezo a procesar un mensaje inbound.',
      status: 'running',
      isTest: Boolean(input.isTest),
      input: { mode: input.mode, inboundProviderMessageId: input.inboundProviderMessageId || null, isTest: Boolean(input.isTest) },
    });
    const turnPayload = {
      companyId: input.companyId,
      chatId: input.chatId || null,
      sessionId: session.id,
      turnId: turn.id,
      agentId: input.agentId,
      domainKey: input.domainKey,
      inboundProviderMessageId: input.inboundProviderMessageId || null,
      isTest: Boolean(input.isTest),
      status: 'running' as const,
    };
    emitDashboard('agent:activity_turn', turnPayload);
    emitConversation(input.companyId, input.chatId, 'agent:activity_turn', turnPayload);
    const sessionPayload = {
      companyId: input.companyId,
      chatId: input.chatId,
      sessionId: session.id,
      status: session.status,
      agentId: input.agentId,
      domainKey: input.domainKey,
    };
    emitDashboard('agent:session_updated', sessionPayload);
    emitConversation(input.companyId, input.chatId, 'agent:session_updated', sessionPayload);
    return { sessionId: session.id, turnId: turn.id };
  }

  async completeTurn(input: {
    companyId: number;
    sessionId: number;
    turnId: number;
    domainKey: string;
    conversationId: number;
    chatId: string;
    agentId: number | null;
    status: 'ok' | 'skipped' | 'failed';
    finalAction?: string | null;
    finalReply?: string | null;
    commandCount?: number;
    isTest?: boolean;
  }): Promise<void> {
    await this.repo.completeTurn({
      companyId: input.companyId,
      turnId: input.turnId,
      status: input.status,
      finalAction: input.finalAction || null,
      finalReplyPreview: input.finalReply ? input.finalReply.slice(0, 500) : '',
      commandCount: input.commandCount ?? 0,
    });
    await this.eventService.record({
      companyId: input.companyId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      domainKey: input.domainKey,
      conversationId: input.conversationId,
      chatId: input.chatId,
      agentId: input.agentId,
      kind: input.finalAction === 'auto_reply' ? 'delivery' : input.finalAction === 'suggest' ? 'suggestion' : input.finalAction === 'handoff' ? 'handoff' : 'session',
      title: 'Turno IA finalizado',
      summary: input.finalAction || input.status,
      status: input.status,
      isTest: Boolean(input.isTest),
      output: {
        finalAction: input.finalAction || null,
        finalReplyPreview: input.finalReply ? input.finalReply.slice(0, 500) : '',
        commandCount: input.commandCount ?? 0,
      },
    });
    const event = {
      companyId: input.companyId,
      chatId: input.chatId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      domainKey: input.domainKey,
      inboundProviderMessageId: null,
      isTest: Boolean(input.isTest),
      status: input.status,
      finalAction: input.finalAction || 'none',
      finalReplyPreview: input.finalReply ? input.finalReply.slice(0, 500) : '',
      commandCount: input.commandCount ?? 0,
    };
    emitDashboard('agent:activity_turn', event);
    emitConversation(input.companyId, input.chatId, 'agent:activity_turn', event);
  }

  async markSessionStatus(input: {
    companyId: number;
    sessionId: number;
    status: 'active' | 'paused' | 'handoff' | 'closed';
    chatId?: string | null;
    agentId?: number | null;
    domainKey?: string;
  }): Promise<void> {
    await this.repo.updateSessionStatus(input.companyId, input.sessionId, input.status);
    if (input.chatId) {
      const payload = {
        companyId: input.companyId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        status: input.status,
        agentId: input.agentId ?? null,
        domainKey: input.domainKey || 'gestion_web',
      };
      emitDashboard('agent:session_updated', payload);
      emitConversation(input.companyId, input.chatId, 'agent:session_updated', payload);
    }
  }
}
