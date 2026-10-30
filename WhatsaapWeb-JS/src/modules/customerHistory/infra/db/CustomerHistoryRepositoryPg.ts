import { Queryable } from '../../../../shared/UnitOfWorkPort';
import {
  CustomerHistory,
  CustomerHistoryAction,
  CustomerHistoryContact,
  CustomerHistoryConversation,
  CustomerHistoryLimits,
  CustomerHistoryMessage,
  CustomerHistoryOrder,
  CustomerHistoryTag,
} from '../../domain/customerHistory.types';
import { CustomerHistoryRepositoryPort } from '../../application/ports/CustomerHistoryRepositoryPort';

type Row = Record<string, any>;

export class CustomerHistoryRepositoryPg implements CustomerHistoryRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async findByContactId(companyId: number, contactId: number, limits: CustomerHistoryLimits): Promise<CustomerHistory | null> {
    const contact = await this.findContactById(companyId, contactId);
    if (!contact) return null;
    return this.buildHistory(companyId, contact, limits);
  }

  async findByChatId(companyId: number, chatId: string, limits: CustomerHistoryLimits): Promise<CustomerHistory | null> {
    const contact = await this.findContactByChatId(companyId, this.buildChatLookupValues(chatId));
    if (!contact) return null;
    return this.buildHistory(companyId, contact, limits);
  }

  private async buildHistory(companyId: number, contact: CustomerHistoryContact, limits: CustomerHistoryLimits): Promise<CustomerHistory> {
    const conversations = await this.listConversations(companyId, contact.id, limits.conversationLimit);
    const [recentMessages, tags, orders, actions] = await Promise.all([
      this.listRecentMessages(companyId, contact.id, limits.messageLimit),
      this.listTags(companyId, conversations),
      this.listOrders(companyId, contact.id, limits.conversationLimit),
      this.listActions(companyId, contact.id, limits.messageLimit),
    ]);

    return {
      contact,
      conversations,
      recentMessages,
      tags,
      orders,
      actions,
      meta: {
        conversationLimit: limits.conversationLimit,
        messageLimit: limits.messageLimit,
        generatedAt: new Date().toISOString(),
        pendingSources: [],
      },
    };
  }

  private async findContactById(companyId: number, contactId: number): Promise<CustomerHistoryContact | null> {
    const result = await this.pool.query(
      `SELECT id, external_contact_id, phone, name, display_name, profile_name, wa_id,
              first_seen_at, last_seen_at, created_at, updated_at
       FROM contacts
       WHERE company_id = $1 AND id = $2
       LIMIT 1`,
      [companyId, contactId]
    );
    return result.rows[0] ? this.mapContact(result.rows[0]) : null;
  }

  private async findContactByChatId(companyId: number, chatLookupValues: string[]): Promise<CustomerHistoryContact | null> {
    const result = await this.pool.query(
      `SELECT ct.id, ct.external_contact_id, ct.phone, ct.name, ct.display_name, ct.profile_name, ct.wa_id,
              ct.first_seen_at, ct.last_seen_at, ct.created_at, ct.updated_at
       FROM contacts ct
       LEFT JOIN conversations c
              ON c.company_id = ct.company_id
             AND c.contact_id = ct.id
             AND c.channel = ct.channel
       WHERE ct.company_id = $1
         AND ct.channel = 'whatsapp'
         AND (
           c.external_conversation_id = ANY($2::varchar[])
           OR ct.external_contact_id = ANY($2::varchar[])
           OR ct.wa_id = ANY($2::varchar[])
           OR ct.phone = ANY($2::varchar[])
         )
       ORDER BY c.last_message_at DESC NULLS LAST, ct.updated_at DESC, ct.id DESC
       LIMIT 1`,
      [companyId, chatLookupValues]
    );
    return result.rows[0] ? this.mapContact(result.rows[0]) : null;
  }

  private async listConversations(companyId: number, contactId: number, limit: number): Promise<CustomerHistoryConversation[]> {
    const result = await this.pool.query(
      `SELECT id, external_conversation_id, title, status, unread_count,
              last_message_at, last_message_preview, last_message_direction,
              service_window_expires_at, archived_at, closed_at
       FROM conversations
       WHERE company_id = $1 AND contact_id = $2
       ORDER BY last_message_at DESC NULLS LAST, updated_at DESC, id DESC
       LIMIT $3`,
      [companyId, contactId, limit]
    );
    return result.rows.map((row) => this.mapConversation(row));
  }

  private async listRecentMessages(companyId: number, contactId: number, limit: number): Promise<CustomerHistoryMessage[]> {
    const result = await this.pool.query(
      `SELECT m.id, m.provider_message_id, m.conversation_id, c.external_conversation_id AS chat_id,
              m.direction, m.body, m.message_type, m.status, m.occurred_at,
              EXISTS (
                SELECT 1 FROM message_attachments a WHERE a.message_id = m.id
              ) AS has_attachments
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.company_id = $1
         AND c.contact_id = $2
         AND m.company_id = $1
       ORDER BY m.occurred_at DESC NULLS LAST, m.id DESC
       LIMIT $3`,
      [companyId, contactId, limit]
    );
    return result.rows.map((row) => this.mapMessage(row));
  }

  private async listTags(companyId: number, conversations: CustomerHistoryConversation[]): Promise<CustomerHistoryTag[]> {
    if (conversations.length === 0) return [];

    const conversationIds = conversations.map((conversation) => conversation.id);
    const chatIds = conversations.map((conversation) => conversation.chatId);
    const result = await this.pool.query(
      `SELECT t.id, t.name, t.color, t.is_default,
              COALESCE(array_agg(DISTINCT tc.chat_id) FILTER (WHERE tc.chat_id IS NOT NULL), ARRAY[]::varchar[]) AS chat_ids
       FROM tags t
       JOIN tag_chats tc ON tc.company_id = t.company_id AND tc.tag_id = t.id
       WHERE t.company_id = $1
         AND (
           tc.conversation_id = ANY($2::int[])
           OR tc.chat_id = ANY($3::varchar[])
         )
       GROUP BY t.id
       ORDER BY t.is_default DESC, LOWER(t.name) ASC`,
      [companyId, conversationIds, chatIds]
    );
    return result.rows.map((row) => this.mapTag(row));
  }

  private async listOrders(companyId: number, contactId: number, limit: number): Promise<CustomerHistoryOrder[]> {
    const result = await this.pool.query(
      `SELECT id, title, service_type, COALESCE(order_type, 'service') AS order_type,
              status, notes, created_by, agent_id, conversation_id,
              occurred_at, confirmed_at, reserved_at, created_at, updated_at
       FROM customer_orders
       WHERE company_id = $1
         AND contact_id = $2
         AND COALESCE(order_type, 'service') = 'commercial'
         AND EXISTS (
           SELECT 1
           FROM order_items oi
           WHERE oi.company_id = customer_orders.company_id
             AND oi.order_id = customer_orders.id
         )
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
      [companyId, contactId, limit]
    );
    const orders = result.rows.map((row) => this.mapOrder(row));
    if (orders.length === 0) return orders;

    const orderIds = orders.map((order) => order.id);
    const [itemsResult, movementsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, order_id, product_id, commercial_item_id, product_name, sku, quantity,
                unit_price, currency, status, item_type_snapshot, availability_status
         FROM order_items
         WHERE company_id = $1 AND order_id = ANY($2::bigint[])
         ORDER BY id ASC`,
        [companyId, orderIds]
      ),
      this.pool.query(
        `SELECT id, order_id, product_id, commercial_item_id, movement_type, quantity, occurred_at
         FROM stock_movements
         WHERE company_id = $1 AND order_id = ANY($2::bigint[])
         ORDER BY occurred_at DESC, id DESC`,
        [companyId, orderIds]
      ),
    ]);

    const itemsByOrder = new Map<number, Row[]>();
    for (const row of itemsResult.rows) {
      const orderId = Number(row.order_id);
      itemsByOrder.set(orderId, [...(itemsByOrder.get(orderId) || []), row]);
    }
    const movementsByOrder = new Map<number, Row[]>();
    for (const row of movementsResult.rows) {
      const orderId = Number(row.order_id);
      movementsByOrder.set(orderId, [...(movementsByOrder.get(orderId) || []), row]);
    }

    return orders.map((order) => ({
      ...order,
      items: (itemsByOrder.get(order.id) || []).map((row) => ({
        id: Number(row.id),
        productId: row.product_id ? Number(row.product_id) : null,
        commercialItemId: row.commercial_item_id ? Number(row.commercial_item_id) : row.product_id ? Number(row.product_id) : null,
        productName: row.product_name,
        itemTypeSnapshot: row.item_type_snapshot || 'physical_product',
        sku: row.sku || null,
        quantity: Number(row.quantity),
        unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
        currency: row.currency || 'PEN',
        status: row.status,
        availabilityStatus: row.availability_status || 'available',
      })),
      stockMovements: (movementsByOrder.get(order.id) || []).map((row) => ({
        id: Number(row.id),
        productId: row.product_id ? Number(row.product_id) : null,
        commercialItemId: row.commercial_item_id ? Number(row.commercial_item_id) : row.product_id ? Number(row.product_id) : null,
        movementType: row.movement_type,
        quantity: Number(row.quantity),
        occurredAt: row.occurred_at || null,
      })),
    }));
  }

  private async listActions(companyId: number, contactId: number, limit: number): Promise<CustomerHistoryAction[]> {
    const result = await this.pool.query(
      `SELECT id, order_id, action_type, status, description, actor_user_id,
              conversation_id, message_id, occurred_at, created_at
       FROM operational_actions
       WHERE company_id = $1
         AND contact_id = $2
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
      [companyId, contactId, limit]
    );
    return result.rows.map((row) => this.mapAction(row));
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

  private mapContact(row: Row): CustomerHistoryContact {
    return {
      id: Number(row.id),
      externalContactId: row.external_contact_id,
      phone: row.phone || null,
      name: row.name || null,
      displayName: row.display_name || null,
      profileName: row.profile_name || null,
      waId: row.wa_id || null,
      firstSeenAt: row.first_seen_at || null,
      lastSeenAt: row.last_seen_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  private mapConversation(row: Row): CustomerHistoryConversation {
    return {
      id: Number(row.id),
      chatId: row.external_conversation_id,
      title: row.title || null,
      status: row.status || null,
      unreadCount: Number(row.unread_count || 0),
      lastMessageAt: row.last_message_at || null,
      lastMessagePreview: row.last_message_preview || null,
      lastMessageDirection: row.last_message_direction || null,
      serviceWindowExpiresAt: row.service_window_expires_at || null,
      archivedAt: row.archived_at || null,
      closedAt: row.closed_at || null,
    };
  }

  private mapMessage(row: Row): CustomerHistoryMessage {
    return {
      id: Number(row.id),
      providerMessageId: row.provider_message_id || null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      chatId: row.chat_id || null,
      direction: row.direction,
      body: row.body || null,
      messageType: row.message_type || null,
      status: row.status || null,
      occurredAt: row.occurred_at || null,
      hasAttachments: Boolean(row.has_attachments),
    };
  }

  private mapTag(row: Row): CustomerHistoryTag {
    return {
      id: String(row.id),
      name: row.name,
      color: row.color || null,
      isDefault: Boolean(row.is_default),
      chatIds: Array.isArray(row.chat_ids) ? row.chat_ids : [],
    };
  }

  private mapOrder(row: Row): CustomerHistoryOrder {
    return {
      id: Number(row.id),
      title: row.title,
      serviceType: row.service_type,
      orderType: row.order_type || 'service',
      status: row.status,
      notes: row.notes || null,
      createdBy: row.created_by ? Number(row.created_by) : null,
      agentId: row.agent_id ? Number(row.agent_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      occurredAt: row.occurred_at || null,
      confirmedAt: row.confirmed_at || null,
      reservedAt: row.reserved_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      items: [],
      stockMovements: [],
    };
  }

  private mapAction(row: Row): CustomerHistoryAction {
    return {
      id: Number(row.id),
      orderId: row.order_id ? Number(row.order_id) : null,
      actionType: row.action_type,
      status: row.status,
      description: row.description || null,
      actorUserId: row.actor_user_id ? Number(row.actor_user_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      messageId: row.message_id ? Number(row.message_id) : null,
      occurredAt: row.occurred_at || null,
      createdAt: row.created_at || null,
    };
  }
}
