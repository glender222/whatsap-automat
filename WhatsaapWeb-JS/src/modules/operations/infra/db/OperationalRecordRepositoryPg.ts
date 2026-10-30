import { Queryable } from '../../../../shared/UnitOfWorkPort';
import {
  CompleteServiceSessionResult,
  CustomerOrder,
  OperationalAction,
  OperationalContext,
  ResolvedConversationContext,
} from '../../domain/operationalRecord.types';
import {
  CreateActionInput,
  CreateOrderInput,
  OperationalRecordRepositoryPort,
} from '../../application/ports/OperationalRecordRepositoryPort';

type Row = Record<string, any>;
type TransactionClient = Queryable & {
  release?: () => void;
};
type TransactionPool = Queryable & {
  connect?: () => Promise<TransactionClient>;
};

export class OperationalRecordRepositoryPg implements OperationalRecordRepositoryPort {
  constructor(private readonly pool: TransactionPool) {}

  async resolveConversationContext(context: OperationalContext): Promise<ResolvedConversationContext> {
    const values = this.buildChatLookupValues(context.chatId);
    const result = await this.pool.query(
      `SELECT c.id AS conversation_id,
              c.contact_id,
              c.external_conversation_id AS chat_id
       FROM conversations c
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.external_conversation_id = ANY($2::varchar[])
       ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
       LIMIT 1`,
      [context.companyId, values]
    );

    const row = result.rows[0];
    return {
      contactId: row?.contact_id ? Number(row.contact_id) : null,
      conversationId: row?.conversation_id ? Number(row.conversation_id) : null,
      chatId: row?.chat_id || context.chatId,
    };
  }

  async createOrder(input: CreateOrderInput): Promise<CustomerOrder> {
    const result = await this.pool.query(
      `INSERT INTO customer_orders (
         company_id, contact_id, conversation_id, source_message_id, created_by,
         title, service_type, status, notes, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.companyId,
        input.contactId,
        input.conversationId,
        input.sourceMessageId ?? null,
        input.createdBy,
        input.title,
        input.serviceType,
        input.status,
        input.notes ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return this.mapOrder(result.rows[0]);
  }

  async createAction(input: CreateActionInput): Promise<OperationalAction> {
    const result = await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, order_id, contact_id, conversation_id, message_id, actor_user_id,
         action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.companyId,
        input.orderId ?? null,
        input.contactId,
        input.conversationId,
        input.messageId ?? null,
        input.actorUserId,
        input.actionType,
        input.status,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return this.mapAction(result.rows[0]);
  }

  async completeServiceSession(context: OperationalContext): Promise<CompleteServiceSessionResult> {
    if (typeof this.pool.connect === 'function') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await new OperationalRecordRepositoryPg(client).createCompletedServiceRecords(context);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release?.();
      }
    }

    return this.createCompletedServiceRecords(context);
  }

  private async createCompletedServiceRecords(context: OperationalContext): Promise<CompleteServiceSessionResult> {
    const resolved = await this.resolveConversationContext(context);
    const order = await this.createOrder({
      companyId: context.companyId,
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
      createdBy: context.userId,
      title: 'Servicio de WhatsApp completado',
      serviceType: 'whatsapp_service',
      status: 'completed',
      metadata: {
        chatId: resolved.chatId,
        completedFrom: 'chat_session',
      },
    });

    const action = await this.createAction({
      companyId: context.companyId,
      orderId: order.id,
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
      actorUserId: context.userId,
      actionType: 'service_completed',
      status: 'completed',
      description: 'Atencion marcada como servicio realizado',
      metadata: {
        chatId: resolved.chatId,
      },
    });

    return { order, action };
  }

  private buildChatLookupValues(value: string): string[] {
    const raw = String(value || '').trim();
    const normalized = raw
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/[^\d]/g, '');

    return Array.from(new Set([
      raw,
      normalized,
      normalized ? `${normalized}@c.us` : '',
      normalized ? `${normalized}@s.whatsapp.net` : '',
    ].filter(Boolean)));
  }

  private mapOrder(row: Row): CustomerOrder {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      contactId: row.contact_id ? Number(row.contact_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      sourceMessageId: row.source_message_id ? Number(row.source_message_id) : null,
      createdBy: row.created_by ? Number(row.created_by) : null,
      title: row.title,
      serviceType: row.service_type,
      status: row.status,
      notes: row.notes || null,
      metadata: row.metadata_json || {},
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAction(row: Row): OperationalAction {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      orderId: row.order_id ? Number(row.order_id) : null,
      contactId: row.contact_id ? Number(row.contact_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      messageId: row.message_id ? Number(row.message_id) : null,
      actorUserId: row.actor_user_id ? Number(row.actor_user_id) : null,
      actionType: row.action_type,
      status: row.status,
      description: row.description || null,
      metadata: row.metadata_json || {},
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    };
  }
}
