import type { HandoffTicket, HandoffTicketSummary } from '../domain/runtime.types';
import { HandoffTicketRepositoryPg } from '../infra/db/HandoffTicketRepositoryPg';
import { emitDashboard, emitToRoom } from '../../../sockets/socketEmitter';

export class AgentHandoffService {
  constructor(private readonly repository: HandoffTicketRepositoryPg) {}

  async createTicket(input: {
    companyId: number;
    conversationId: number;
    chatId?: string | null;
    agentId?: number | null;
    orderId?: number | null;
    reason: string;
    priority?: 'low' | 'medium' | 'high';
    metadata?: Record<string, unknown>;
  }): Promise<HandoffTicket> {
    const activeTicket = await this.repository.findActiveByConversation(input.companyId, input.conversationId);
    if (activeTicket) return activeTicket;

    const ticket = await this.repository.create({
      companyId: input.companyId,
      conversationId: input.conversationId,
      agentId: input.agentId ?? null,
      orderId: input.orderId ?? null,
      reason: input.reason,
      priority: input.priority || this.resolvePriority(input.reason, input.metadata),
      metadata: input.metadata,
    });
    await this.repository.assignHandoffTag(input.companyId, input.conversationId, input.chatId || null);
    emitDashboard('agent:handoff', {
      companyId: input.companyId,
      conversationId: input.conversationId,
      chatId: input.chatId || null,
      ticketId: ticket.id,
      agentId: ticket.agentId,
      reason: ticket.reason,
      priority: ticket.priority,
    });
    if (input.chatId) {
      emitToRoom(input.chatId, 'agent:handoff', { ticketId: ticket.id, reason: ticket.reason, priority: ticket.priority });
    }
    return ticket;
  }

  async list(
    companyId: number,
    filters: { status?: string; conversationId?: number; takenBy?: number; limit?: number; offset?: number }
  ): Promise<{ rows: HandoffTicketSummary[]; total: number }> {
    return this.repository.list(companyId, filters);
  }

  async take(companyId: number, ticketId: number, userId: number): Promise<HandoffTicket | null> {
    const ticket = await this.repository.take(companyId, ticketId, userId);
    if (ticket) emitDashboard('agent:handoff_taken', { ticketId, takenBy: userId });
    return ticket;
  }

  async close(companyId: number, ticketId: number, userId: number, input: { notes?: string | null; outcome: HandoffTicket['outcome'] }): Promise<HandoffTicket | null> {
    const ticket = await this.repository.close(companyId, ticketId, userId, input);
    if (ticket) emitDashboard('agent:handoff_closed', { ticketId, closedBy: userId, outcome: ticket.outcome });
    return ticket;
  }

  async countOpen(companyId: number): Promise<number> {
    return this.repository.countOpen(companyId);
  }

  private resolvePriority(reason: string, metadata?: Record<string, unknown>): 'low' | 'medium' | 'high' {
    const text = `${reason} ${JSON.stringify(metadata || {})}`.toLowerCase();
    if (/pago|payment|compr|confirm|urgente|cliente pide humano/.test(text)) return 'high';
    if (/stock|sin match|producto no encontrado|baja confianza/.test(text)) return 'medium';
    return 'medium';
  }
}
