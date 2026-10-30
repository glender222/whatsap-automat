import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg } from '../../../inventory';
import { CommercialOrder, CommercialOrderStatus, CreateDetectedOrderInput, ProductMatch } from '../../domain/order.types';

type Row = Record<string, any>;
type TransactionClient = Queryable & { release?: () => void };
type TransactionPool = Queryable & { connect?: () => Promise<TransactionClient> };

export class OrderRepositoryPg {
  constructor(private readonly pool: TransactionPool) {}

  async list(companyId: number, limit = 50, offset = 0): Promise<{ rows: CommercialOrder[]; total: number }> {
    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM customer_orders WHERE company_id = $1 AND order_type = 'commercial'`,
      [companyId]
    );
    const orders = await this.pool.query(
      `SELECT * FROM customer_orders
       WHERE company_id = $1 AND order_type = 'commercial'
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [companyId, limit, offset]
    );
    const rows = await Promise.all(orders.rows.map((row) => this.withItems(row)));
    return { rows, total: Number(count.rows[0]?.count || 0) };
  }

  async get(companyId: number, orderId: number): Promise<CommercialOrder | null> {
    const result = await this.pool.query(
      `SELECT * FROM customer_orders WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, orderId]
    );
    return result.rows[0] ? this.withItems(result.rows[0]) : null;
  }

  async createDetected(input: CreateDetectedOrderInput): Promise<{ order: CommercialOrder; matches: ProductMatch[] }> {
    const productRepo = new ProductRepositoryPg(this.pool);
    const products = await productRepo.findActiveByIdsOrNames(
      input.companyId,
      input.items.map((item) => Number(item.commercialItemId || 0)).filter(Boolean),
      input.items.map((item) => item.productName || item.detectedName || '').filter(Boolean)
    );
    const productsById = new Map(products.map((product) => [product.id, product]));
    const productsByName = new Map(products.flatMap((product) => [
      [product.name.toLowerCase(), product],
      product.sku ? [product.sku.toLowerCase(), product] as const : null,
    ].filter(Boolean) as Array<readonly [string, typeof product]>));
    const matches = input.items.map((item) => {
      const quantity = Math.max(1, Math.trunc(Number(item.quantity || 1)));
      const requestedName = String(item.detectedName || item.productName || '').trim();
      const product = item.commercialItemId
        ? productsById.get(Number(item.commercialItemId)) || null
        : productsByName.get(requestedName.toLowerCase()) || null;
      const availability = this.evaluateAvailability(product, quantity);
      return {
        requestedName: requestedName || product?.name || 'Item solicitado',
        quantity,
        product,
        ...availability,
      };
    });

    const status = this.resolveInitialStatus(matches, input.status);
    const resolved = await this.resolveConversation(input.companyId, input.chatId);
    const openOrder = resolved.conversationId
      ? await this.findOpenOrderForConversation(input.companyId, resolved.conversationId)
      : null;
    if (openOrder) {
      const order = await this.updateOpenOrderWithItems(input, resolved, openOrder, matches, status);
      return { order, matches };
    }

    const order = await this.createOrderWithItems(input, matches, status, resolved);
    return { order, matches };
  }

  async updateStatus(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null): Promise<CommercialOrder | null> {
    if (status === 'confirmed') return this.confirmAndReserve(companyId, orderId, actorUserId);

    const result = await this.pool.query(
      `UPDATE customer_orders
       SET status = $3, updated_at = NOW()
       WHERE company_id = $1 AND id = $2
       RETURNING *`,
      [companyId, orderId, status]
    );
    if (!result.rows[0]) return null;
    await this.createAction(companyId, orderId, `order_${status}`, status, actorUserId, `Pedido actualizado a ${status}`);
    return this.withItems(result.rows[0]);
  }

  private async createOrderWithItems(
    input: CreateDetectedOrderInput,
    matches: ProductMatch[],
    status: CommercialOrderStatus,
    resolved: { contactId: number | null; conversationId: number | null; chatId: string }
  ): Promise<CommercialOrder> {
    const orderResult = await this.pool.query(
      `INSERT INTO customer_orders (
         company_id, contact_id, conversation_id, source_message_id, created_by, agent_id,
         title, service_type, order_type, status, notes, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'commercial_order', 'commercial', $8, $9, $10)
       RETURNING *`,
      [
        input.companyId,
        resolved.contactId,
        resolved.conversationId,
        input.sourceMessageId || null,
        input.userId || null,
        input.agentId || null,
        this.buildOrderTitle(matches),
        status,
        input.notes || null,
        JSON.stringify({ ...(input.metadata || {}), chatId: resolved.chatId, matches: matches.map((match) => ({
          requestedName: match.requestedName,
          quantity: match.quantity,
          productId: match.product?.id || null,
          commercialItemId: match.product?.id || null,
          itemType: match.product?.itemType || null,
          availabilityType: match.product?.availabilityType || null,
          availabilityStatus: match.availabilityStatus,
          available: match.available,
          requiresApproval: match.requiresApproval,
        })) }),
      ]
    );
    const orderId = Number(orderResult.rows[0].id);

    for (const match of matches) {
      await this.pool.query(
        `INSERT INTO order_items (
           order_id, company_id, product_id, commercial_item_id, product_name, sku, quantity,
           unit_price, currency, status, item_type_snapshot, availability_status, metadata_json
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          orderId,
          input.companyId,
          match.product?.id || null,
          match.product?.id || null,
          match.product?.name || match.requestedName,
          match.product?.sku || null,
          match.quantity,
          match.product?.price ?? null,
          match.product?.currency || 'PEN',
          match.status,
          match.product?.itemType || 'physical_product',
          match.availabilityStatus,
          JSON.stringify({
            requestedName: match.requestedName,
            availabilityType: match.product?.availabilityType || null,
            aiDetected: input.metadata?.source === 'agent_detected_order',
          }),
        ]
      );
    }

    await this.createAction(
      input.companyId,
      orderId,
      status === 'unavailable' || status === 'out_of_stock' ? 'out_of_stock_detected' : 'order_detected',
      status,
      input.userId || null,
      status === 'unavailable' || status === 'out_of_stock'
        ? 'Item no disponible o no registrado detectado por el agente'
        : 'Pedido detectado automaticamente por el agente'
    );

    if (!['out_of_stock', 'unavailable', 'pending_approval', 'pending_handoff'].includes(status)) {
      await this.createAction(input.companyId, orderId, 'order_quoted', 'completed', input.userId || null, 'Pedido cotizado automaticamente');
    } else if (status === 'pending_approval' || status === 'pending_handoff') {
      await this.createAction(input.companyId, orderId, 'handoff_required', status, input.userId || null, 'Pedido requiere cierre humano');
    }
    await this.setCommercialStateForOrder(input.companyId, orderId, status, input.userId || null);

    const order = await this.get(input.companyId, orderId);
    if (!order) throw new Error('No se pudo crear el pedido comercial');
    return order;
  }

  private async findOpenOrderForConversation(companyId: number, conversationId: number): Promise<Row | null> {
    const result = await this.pool.query(
      `SELECT *
       FROM customer_orders
       WHERE company_id = $1
         AND conversation_id = $2
         AND order_type = 'commercial'
         AND status IN ('draft', 'quoted', 'pending_handoff', 'pending_approval')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [companyId, conversationId]
    );
    return result.rows[0] || null;
  }

  private async updateOpenOrderWithItems(
    input: CreateDetectedOrderInput,
    resolved: { contactId: number | null; conversationId: number | null; chatId: string },
    current: Row,
    matches: ProductMatch[],
    status: CommercialOrderStatus
  ): Promise<CommercialOrder> {
    const orderId = Number(current.id);
    const nextStatus = current.status === 'pending_handoff' ? current.status : status;
    const metadata = {
      ...(current.metadata_json || {}),
      ...(input.metadata || {}),
      chatId: resolved.chatId,
      lastUpsertAt: new Date().toISOString(),
      matches: matches.map((match) => ({
        requestedName: match.requestedName,
        quantity: match.quantity,
        productId: match.product?.id || null,
        commercialItemId: match.product?.id || null,
        itemType: match.product?.itemType || null,
        availabilityType: match.product?.availabilityType || null,
        availabilityStatus: match.availabilityStatus,
        available: match.available,
        requiresApproval: match.requiresApproval,
      })),
    };

    await this.pool.query(
      `UPDATE customer_orders
       SET title = $3,
           status = $4,
           notes = COALESCE($5, notes),
           metadata_json = $6::jsonb,
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [
        input.companyId,
        orderId,
        this.buildOrderTitle(matches),
        nextStatus,
        input.notes || null,
        JSON.stringify(metadata),
      ]
    );

    for (const match of matches) {
      const existing = await this.pool.query(
        `SELECT id
         FROM order_items
         WHERE company_id = $1
           AND order_id = $2
           AND (
             ($3::bigint IS NOT NULL AND commercial_item_id = $3)
             OR ($3::bigint IS NULL AND LOWER(product_name) = LOWER($4))
           )
         LIMIT 1`,
        [input.companyId, orderId, match.product?.id || null, match.product?.name || match.requestedName]
      );
      if (existing.rows[0]) {
        await this.pool.query(
          `UPDATE order_items
           SET product_id = $4,
               commercial_item_id = $4,
               product_name = $5,
               sku = $6,
               quantity = $7,
               unit_price = $8,
               currency = $9,
               status = $10,
               item_type_snapshot = $11,
               availability_status = $12,
               metadata_json = $13::jsonb,
               updated_at = NOW()
           WHERE company_id = $1 AND order_id = $2 AND id = $3`,
          [
            input.companyId,
            orderId,
            Number(existing.rows[0].id),
            match.product?.id || null,
            match.product?.name || match.requestedName,
            match.product?.sku || null,
            match.quantity,
            match.product?.price ?? null,
            match.product?.currency || 'PEN',
            match.status,
            match.product?.itemType || 'physical_product',
            match.availabilityStatus,
            JSON.stringify({
              requestedName: match.requestedName,
              availabilityType: match.product?.availabilityType || null,
              aiDetected: input.metadata?.source === 'agent_detected_order',
            }),
          ]
        );
      } else {
        await this.pool.query(
          `INSERT INTO order_items (
             order_id, company_id, product_id, commercial_item_id, product_name, sku, quantity,
             unit_price, currency, status, item_type_snapshot, availability_status, metadata_json
           )
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            orderId,
            input.companyId,
            match.product?.id || null,
            match.product?.name || match.requestedName,
            match.product?.sku || null,
            match.quantity,
            match.product?.price ?? null,
            match.product?.currency || 'PEN',
            match.status,
            match.product?.itemType || 'physical_product',
            match.availabilityStatus,
            JSON.stringify({
              requestedName: match.requestedName,
              availabilityType: match.product?.availabilityType || null,
              aiDetected: input.metadata?.source === 'agent_detected_order',
            }),
          ]
        );
      }
    }

    await this.createAction(
      input.companyId,
      orderId,
      nextStatus === 'pending_handoff' ? 'handoff_required' : 'order_detected',
      nextStatus,
      input.userId || null,
      nextStatus === 'pending_handoff'
        ? 'Prepedido actualizado y requiere cierre humano'
        : 'Prepedido actualizado desde conversacion'
    );
    await this.setCommercialStateForOrder(input.companyId, orderId, nextStatus, input.userId || null);
    const order = await this.get(input.companyId, orderId);
    if (!order) throw new Error('No se pudo actualizar el pedido comercial');
    return order;
  }

  private async confirmAndReserve(companyId: number, orderId: number, actorUserId: number | null): Promise<CommercialOrder | null> {
    if (typeof this.pool.connect === 'function' && typeof (this.pool as TransactionClient).release !== 'function') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await new OrderRepositoryPg(client).confirmAndReserve(companyId, orderId, actorUserId);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release?.();
      }
    }

    const order = await this.get(companyId, orderId);
    if (!order) return null;
    for (const item of order.items) {
      if (!item.commercialItemId || ['out_of_stock', 'unavailable'].includes(item.status)) {
        throw this.validationError('No se puede confirmar un pedido con items no disponibles o no registrados');
      }
      const catalogItemResult = await this.pool.query(
        `SELECT * FROM products WHERE company_id = $1 AND id = $2 AND status = 'active' LIMIT 1`,
        [companyId, item.commercialItemId]
      );
      const catalogItem = catalogItemResult.rows[0];
      if (!catalogItem) throw this.validationError(`Item no disponible: ${item.productName}`);
      if (catalogItem.requires_human_approval && !actorUserId) {
        throw this.validationError(`El item requiere aprobacion humana: ${item.productName}`);
      }
      const availabilityType = String(catalogItem.availability_type || 'stock');
      if (availabilityType === 'manual' && !actorUserId) {
        throw this.validationError(`El item requiere aprobacion humana: ${item.productName}`);
      }
      if (['stock', 'capacity'].includes(availabilityType)) {
        const updated = await this.pool.query(
          `UPDATE products
           SET stock_available = stock_available - $3,
               stock_reserved = stock_reserved + $3,
               updated_at = NOW()
           WHERE company_id = $1
             AND id = $2
             AND (allow_backorder = true OR stock_available >= $3)
           RETURNING *`,
          [companyId, item.commercialItemId, item.quantity]
        );
        const product = updated.rows[0];
        if (!product) throw this.validationError(`Disponibilidad insuficiente para ${item.productName}`);
        await this.pool.query(
          `INSERT INTO stock_movements (
             company_id, product_id, commercial_item_id, order_id, order_item_id, actor_user_id,
             movement_type, quantity, delta_available, delta_reserved,
             stock_available_after, stock_reserved_after, notes
           )
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            companyId,
            item.commercialItemId,
            orderId,
            item.id,
            actorUserId,
            availabilityType === 'capacity' ? 'capacity_reserved' : 'reservation',
            item.quantity,
            -item.quantity,
            item.quantity,
            product.stock_available,
            product.stock_reserved,
            availabilityType === 'capacity' ? 'Cupo reservado por confirmacion de pedido' : 'Stock reservado por confirmacion de pedido',
          ]
        );
      }
    }

    await this.pool.query(
      `UPDATE order_items
       SET status = 'confirmed',
           availability_status = CASE WHEN availability_status IN ('available', 'unlimited') THEN 'reserved' ELSE availability_status END,
           updated_at = NOW()
       WHERE company_id = $1 AND order_id = $2`,
      [companyId, orderId]
    );
    const result = await this.pool.query(
      `UPDATE customer_orders
       SET status = 'confirmed', confirmed_at = NOW(), reserved_at = NOW(), updated_at = NOW()
       WHERE company_id = $1 AND id = $2
       RETURNING *`,
      [companyId, orderId]
    );
    await this.createAction(companyId, orderId, 'order_confirmed', 'completed', actorUserId, 'Pedido confirmado por el cliente');
    await this.createAction(companyId, orderId, 'availability_reserved', 'completed', actorUserId, 'Disponibilidad reservada automaticamente');
    await this.setCommercialStateForOrder(companyId, orderId, 'confirmed', actorUserId);
    return this.withItems(result.rows[0]);
  }

  private async resolveConversation(companyId: number, chatId: string): Promise<{ contactId: number | null; conversationId: number | null; chatId: string }> {
    const values = this.buildChatLookupValues(chatId);
    const result = await this.pool.query(
      `SELECT id, contact_id, external_conversation_id
       FROM conversations
       WHERE company_id = $1 AND external_conversation_id = ANY($2::varchar[])
       ORDER BY last_message_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [companyId, values]
    );
    return {
      contactId: result.rows[0]?.contact_id ? Number(result.rows[0].contact_id) : null,
      conversationId: result.rows[0]?.id ? Number(result.rows[0].id) : null,
      chatId: result.rows[0]?.external_conversation_id || chatId,
    };
  }

  private async withItems(row: Row): Promise<CommercialOrder> {
    const items = await this.pool.query(
      `SELECT * FROM order_items WHERE company_id = $1 AND order_id = $2 ORDER BY id ASC`,
      [Number(row.company_id), Number(row.id)]
    );
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      contactId: row.contact_id ? Number(row.contact_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      sourceMessageId: row.source_message_id ? Number(row.source_message_id) : null,
      createdBy: row.created_by ? Number(row.created_by) : null,
      agentId: row.agent_id ? Number(row.agent_id) : null,
      title: row.title,
      serviceType: row.service_type,
      orderType: row.order_type || 'service',
      status: row.status,
      notes: row.notes || null,
      metadata: row.metadata_json || {},
      occurredAt: row.occurred_at,
      confirmedAt: row.confirmed_at || null,
      reservedAt: row.reserved_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: items.rows.map((item) => ({
        id: Number(item.id),
        orderId: Number(item.order_id),
        companyId: Number(item.company_id),
        productId: item.product_id ? Number(item.product_id) : null,
        commercialItemId: item.commercial_item_id ? Number(item.commercial_item_id) : item.product_id ? Number(item.product_id) : null,
        productName: item.product_name,
        itemNameSnapshot: item.product_name,
        itemTypeSnapshot: item.item_type_snapshot || 'physical_product',
        sku: item.sku || null,
        quantity: Number(item.quantity),
        unitPrice: item.unit_price === null || item.unit_price === undefined ? null : Number(item.unit_price),
        currency: item.currency || 'PEN',
        status: item.status,
        availabilityStatus: item.availability_status || 'available',
        metadata: item.metadata_json || {},
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
    };
  }

  private async createAction(companyId: number, orderId: number, actionType: string, status: string, actorUserId: number | null, description: string): Promise<void> {
    const context = await this.pool.query(
      `SELECT contact_id, conversation_id FROM customer_orders WHERE company_id = $1 AND id = $2`,
      [companyId, orderId]
    );
    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, order_id, contact_id, conversation_id, actor_user_id, action_type, status, description
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        companyId,
        orderId,
        context.rows[0]?.contact_id || null,
        context.rows[0]?.conversation_id || null,
        actorUserId,
        actionType,
        status,
        description,
      ]
    );
  }

  private async setCommercialStateForOrder(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null): Promise<void> {
    const context = await this.pool.query(
      `SELECT conversation_id FROM customer_orders WHERE company_id = $1 AND id = $2`,
      [companyId, orderId]
    );
    const conversationId = context.rows[0]?.conversation_id ? Number(context.rows[0].conversation_id) : null;
    if (!conversationId) return;
    const state = this.mapOrderStatusToCommercialState(status);
    await this.pool.query(
      `UPDATE conversations
       SET commercial_stage = $3,
           commercial_substatus = $4,
           commercial_state_updated_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [companyId, conversationId, state.stage, state.substatus]
    );
    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, order_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, $4, 'conversation_state_changed', 'completed', $5, $6::jsonb)`,
      [
        companyId,
        orderId,
        conversationId,
        actorUserId,
        `Estado comercial actualizado a ${state.stage}/${state.substatus}`,
        JSON.stringify({ stage: state.stage, substatus: state.substatus, source: 'order', orderStatus: status }),
      ]
    );
  }

  private mapOrderStatusToCommercialState(status: CommercialOrderStatus): { stage: string; substatus: string } {
    if (status === 'pending_handoff' || status === 'pending_approval') return { stage: 'handoff', substatus: 'handoff_pending' };
    if (status === 'confirmed' || status === 'reserved') return { stage: 'payment', substatus: 'sale_confirmed' };
    if (status === 'completed') return { stage: 'closed', substatus: 'completed' };
    if (status === 'cancelled') return { stage: 'closed', substatus: 'lost_cancelled' };
    if (status === 'out_of_stock' || status === 'unavailable') return { stage: 'catalog', substatus: 'out_of_stock' };
    if (status === 'quoted') return { stage: 'preorder', substatus: 'quoted' };
    return { stage: 'preorder', substatus: 'preorder_open' };
  }

  private buildOrderTitle(matches: ProductMatch[]): string {
    const names = matches.map((match) => `${match.quantity} ${match.product?.name || match.requestedName}`);
    return `Pedido: ${names.slice(0, 3).join(', ')}`;
  }

  private evaluateAvailability(product: any | null, quantity: number): Omit<ProductMatch, 'requestedName' | 'quantity' | 'product'> {
    if (!product || product.aiEnabled === false) {
      return {
        available: false,
        requiresApproval: false,
        availabilityStatus: 'unavailable',
        status: 'unavailable',
      };
    }

    if (product.requiresHumanApproval || product.availabilityType === 'manual') {
      return {
        available: true,
        requiresApproval: true,
        availabilityStatus: 'manual_required',
        status: 'pending_approval',
      };
    }

    if (product.availabilityType === 'unlimited') {
      return {
        available: true,
        requiresApproval: false,
        availabilityStatus: 'unlimited',
        status: 'quoted',
      };
    }

    const hasAvailability = product.allowBackorder || product.stockAvailable >= quantity;
    return {
      available: hasAvailability,
      requiresApproval: false,
      availabilityStatus: hasAvailability ? 'available' : 'unavailable',
      status: hasAvailability ? 'quoted' : 'unavailable',
    };
  }

  private resolveInitialStatus(matches: ProductMatch[], requestedStatus?: CommercialOrderStatus): CommercialOrderStatus {
    if (matches.some((match) => !match.product || !match.available || match.status === 'unavailable')) return 'unavailable';
    if (matches.some((match) => match.requiresApproval || match.status === 'pending_approval')) return 'pending_approval';
    if (requestedStatus && ['draft', 'quoted', 'pending_handoff'].includes(requestedStatus)) return requestedStatus;
    return 'quoted';
  }

  private buildChatLookupValues(value: string): string[] {
    const raw = String(value || '').trim();
    const normalized = raw.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    return Array.from(new Set([raw, normalized, normalized ? `${normalized}@c.us` : '', normalized ? `${normalized}@s.whatsapp.net` : ''].filter(Boolean)));
  }

  private validationError(message: string): Error & { statusCode?: number; code?: string } {
    const error = new Error(message) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return error;
  }
}
