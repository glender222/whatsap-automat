import { Pool } from 'pg';
import { TenantScopedUoW } from '../../../../db/TenantScopedUoW';
import type { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg, type Product } from '../../../inventory';
import { OrderError } from '../../domain/OrderError';
import type { CommercialOrder, CommercialOrderStatus, CreateDetectedOrderInput, ProductMatch } from '../../domain/order.types';

type Row = Record<string, any>;
type ConversationReference = { contactId: number | null; conversationId: number; chatId: string };
type Reservation = { productId: number; itemId: number | null; quantity: number };
const preorderStates = ['draft', 'quoted', 'pending_handoff', 'pending_approval', 'out_of_stock', 'unavailable'];
const committedStates = ['confirmed', 'reserved'];
const terminalStates = ['cancelled', 'completed'];
const quantityTypes = ['stock', 'capacity'];
const manualTypes = ['manual', 'schedule'];
const selectOrder = `SELECT orders.*, COALESCE((
  SELECT jsonb_agg(items ORDER BY items.id)
  FROM order_items items WHERE items.company_id = orders.company_id AND items.order_id = orders.id
), '[]'::jsonb) AS items_json FROM customer_orders orders`;

export class OrderRepositoryPg {
  private readonly tenantWork: TenantScopedUoW | null;

  constructor(private readonly db: Queryable) {
    this.tenantWork = db instanceof Pool ? new TenantScopedUoW(db) : null;
  }

  private inScope<T>(companyId: number, work: (repository: OrderRepositoryPg) => Promise<T>): Promise<T> {
    // Payment callers can supply an already tenant-scoped transaction client.
    return this.tenantWork ? this.tenantWork.run(companyId, (client) => work(new OrderRepositoryPg(client))) : work(this);
  }

  async list(companyId: number, limit = 50, offset = 0): Promise<{ rows: CommercialOrder[]; total: number }> {
    return this.inScope(companyId, async (repo) => {
      const count = await repo.db.query(
        "SELECT COUNT(*)::int AS count FROM customer_orders WHERE company_id = $1 AND order_type = 'commercial'",
        [companyId],
      );
      const orders = await repo.db.query(`
        ${selectOrder} WHERE company_id = $1 AND order_type = 'commercial'
        ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3
      `, [companyId, limit, offset]);
      return { rows: orders.rows.map((row) => repo.mapOrder(row, row.items_json)), total: Number(count.rows[0]?.count || 0) };
    });
  }

  async get(companyId: number, orderId: number): Promise<CommercialOrder | null> {
    return this.inScope(companyId, (repo) => repo.readOrder(companyId, orderId));
  }

  private async readOrder(companyId: number, orderId: number): Promise<CommercialOrder | null> {
    const { rows: [row] } = await this.db.query(
      `${selectOrder} WHERE company_id = $1 AND id = $2 AND order_type = 'commercial'`,
      [companyId, orderId],
    );
    return row ? this.mapOrder(row, row.items_json) : null;
  }

  async createDetected(input: CreateDetectedOrderInput): Promise<{ order: CommercialOrder; matches: ProductMatch[] }> {
    return this.inScope(input.companyId, (repo) => repo.writeDetectedOrder(input));
  }

  private async writeDetectedOrder(input: CreateDetectedOrderInput): Promise<{ order: CommercialOrder; matches: ProductMatch[] }> {
    const { companyId, userId, agentId, sourceMessageId } = input;
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
      throw new OrderError(400, 'VALIDATION_ERROR', 'El prepedido requiere entre 1 y 100 items');
    }
    const resolved = await this.resolveConversation(companyId, input.chatId);
    await this.requireActor(companyId, userId ?? null);
    if (agentId != null) {
      const { rows } = await this.db.query('SELECT id FROM ai_agents WHERE company_id = $1 AND id = $2 FOR SHARE', [companyId, agentId]);
      if (!rows.length) throw this.notFound('Agente no encontrado');
    }
    if (sourceMessageId != null) {
      const { rows } = await this.db.query(
        'SELECT id FROM messages WHERE company_id = $1 AND conversation_id = $2 AND id = $3 FOR SHARE',
        [companyId, resolved.conversationId, sourceMessageId],
      );
      if (!rows.length) throw this.notFound('Mensaje de origen no encontrado');
    }
    const matches = await this.matchProducts(input);
    const { rows: [existing] } = await this.db.query(`
      SELECT * FROM customer_orders WHERE company_id = $1 AND conversation_id = $2 AND order_type = 'commercial'
        AND status = ANY($3::text[]) ORDER BY updated_at DESC, id DESC LIMIT 1 FOR UPDATE
    `, [companyId, resolved.conversationId, preorderStates]);
    if (existing && (await this.reservations(companyId, Number(existing.id))).length) {
      throw this.conflict('ORDER_RESERVATION_CONFLICT', 'El prepedido conserva una reserva previa. Confirma o cancela antes de editar.');
    }

    const status = this.initialStatus(matches, input.status);
    const metadata = {
      ...(existing?.metadata_json || {}), ...(input.metadata || {}), chatId: resolved.chatId,
      ...(existing && { lastUpsertAt: new Date().toISOString() }),
      matches: matches.map((match) => ({
        requestedName: match.requestedName, quantity: match.quantity,
        productId: match.product?.id ?? null, commercialItemId: match.product?.id ?? null,
        itemType: match.product?.itemType ?? null, availabilityType: match.product?.availabilityType ?? null,
        availabilityStatus: match.availabilityStatus, available: match.available, requiresApproval: match.requiresApproval,
      })),
    };
    const orderId = existing ? Number(existing.id) : await this.insertOrder(input, resolved, status, metadata, matches);
    for (const match of matches) await this.writeItem(companyId, orderId, match, Boolean(existing), input.metadata?.source === 'agent_detected_order');

    const current = await this.readOrder(companyId, orderId);
    if (!current) throw this.notFound('Pedido no encontrado');
    const nextStatus = existing?.status === 'pending_handoff' ? 'pending_handoff'
      : current.items.some((item) => item.status === 'unavailable' || item.status === 'out_of_stock') ? 'unavailable'
      : current.items.some((item) => item.status === 'pending_approval') ? 'pending_approval' : status;
    const title = Array.from(`Pedido: ${current.items.slice(0, 3).map((item) => `${item.quantity} ${item.productName}`).join(', ')}`).slice(0, 255).join('');
    await this.db.query(`
      UPDATE customer_orders SET status = $3, title = $4, notes = COALESCE($5, notes),
        metadata_json = $6::jsonb, updated_at = NOW()
      WHERE company_id = $1 AND id = $2
    `, [companyId, orderId, nextStatus, title, input.notes ?? null, JSON.stringify(metadata)]);

    const needsReview = nextStatus === 'pending_handoff' || nextStatus === 'pending_approval';
    await this.createAction(companyId, orderId, nextStatus === 'unavailable' ? 'out_of_stock_detected' : 'order_detected',
      nextStatus, userId ?? null, existing ? 'Prepedido actualizado desde conversacion' : 'Pedido detectado');
    if (needsReview) {
      await this.createAction(companyId, orderId, 'handoff_required', nextStatus, userId ?? null, 'Pedido requiere cierre humano');
    } else if (!existing && nextStatus === 'quoted') {
      await this.createAction(companyId, orderId, 'order_quoted', 'completed', userId ?? null, 'Pedido cotizado');
    }
    await this.setCommercialStateForOrder(companyId, orderId, nextStatus, userId ?? null);
    const order = await this.readOrder(companyId, orderId);
    if (!order) throw this.notFound('Pedido no encontrado');
    return { order, matches };
  }

  private async insertOrder(
    input: CreateDetectedOrderInput, resolved: ConversationReference, status: CommercialOrderStatus,
    metadata: Record<string, unknown>, matches: ProductMatch[],
  ): Promise<number> {
    const title = Array.from(`Pedido: ${matches.slice(0, 3).map((match) => match.requestedName).join(', ')}`).slice(0, 255).join('');
    const { rows: [row] } = await this.db.query(`
      INSERT INTO customer_orders (company_id, contact_id, conversation_id, source_message_id, created_by, agent_id,
        title, service_type, order_type, status, notes, metadata_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'commercial_order','commercial',$8,$9,$10::jsonb) RETURNING id
    `, [input.companyId, resolved.contactId, resolved.conversationId, input.sourceMessageId ?? null,
      input.userId ?? null, input.agentId ?? null, title, status, input.notes ?? null, JSON.stringify(metadata)]);
    return Number(row.id);
  }

  private async writeItem(companyId: number, orderId: number, match: ProductMatch, merge: boolean, aiDetected: boolean): Promise<void> {
    const productId = match.product?.id ?? null;
    const name = match.product?.name ?? match.requestedName;
    const metadata = JSON.stringify({ requestedName: match.requestedName, availabilityType: match.product?.availabilityType ?? null, aiDetected });
    const values = [companyId, orderId, productId, name, match.product?.sku ?? null, match.quantity,
      match.product?.price ?? null, match.product?.currency ?? 'PEN', match.status,
      match.product?.itemType ?? 'physical_product', match.availabilityStatus, metadata];
    if (merge) {
      const { rows } = await this.db.query(`
        UPDATE order_items SET product_id = $3, commercial_item_id = $3, product_name = $4, sku = $5,
          quantity = $6, unit_price = $7, currency = $8, status = $9, item_type_snapshot = $10,
          availability_status = $11, metadata_json = $12::jsonb, updated_at = NOW()
        WHERE company_id = $1 AND order_id = $2 AND id = (
          SELECT id FROM order_items WHERE company_id = $1 AND order_id = $2 AND (
            ($3::bigint IS NOT NULL AND COALESCE(commercial_item_id, product_id) = $3)
            OR (COALESCE(commercial_item_id, product_id) IS NULL
              AND lower(COALESCE(metadata_json->>'requestedName', product_name)) = lower($13::text))
          ) ORDER BY (COALESCE(commercial_item_id, product_id) IS NOT NULL) DESC, id LIMIT 1
        ) RETURNING id
      `, [...values, match.requestedName]);
      if (rows.length) return;
    }
    await this.db.query(`
      INSERT INTO order_items (company_id, order_id, product_id, commercial_item_id, product_name, sku,
        quantity, unit_price, currency, status, item_type_snapshot, availability_status, metadata_json)
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    `, values);
  }

  private async matchProducts(input: CreateDetectedOrderInput): Promise<ProductMatch[]> {
    const explicitIds = [...new Set(input.items.flatMap((item) => item.commercialItemId == null ? [] : [item.commercialItemId]))];
    if (explicitIds.length) {
      const { rows } = await this.db.query(
        'SELECT id FROM products WHERE company_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR SHARE',
        [input.companyId, explicitIds],
      );
      if (rows.length !== explicitIds.length) throw this.notFound('Item de catalogo no encontrado');
    }
    const inventory = new ProductRepositoryPg(this.db);
    const products = await inventory.findActiveByIdsOrNames(
      input.companyId, explicitIds, input.items.flatMap((item) => [item.productName, item.detectedName || '']).filter(Boolean),
    );
    for (const productId of explicitIds) {
      if (products.some((product) => product.id === productId)) continue;
      const product = await inventory.get(input.companyId, productId);
      if (product) products.push(product);
    }
    const matched = new Map<string, { requestedName: string; product: Product | null; quantity: number }>();
    for (const item of input.items) {
      const requestedName = (item.detectedName || item.productName || '').trim();
      const name = requestedName.toLowerCase();
      const names = [name, (item.productName || '').trim().toLowerCase()].filter(Boolean);
      const candidates = products.filter((product) => item.commercialItemId != null ? product.id === item.commercialItemId
        : product.status === 'active' && !item.ambiguous &&
          (names.includes(product.name.toLowerCase()) || names.includes(product.sku?.toLowerCase() ?? '')));
      const product = candidates.length === 1 ? candidates[0] : null;
      const key = product ? `product:${product.id}` : item.commercialItemId ? `unavailable:${item.commercialItemId}` : `name:${name}`;
      const quantity = (matched.get(key)?.quantity ?? 0) + (item.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
        throw new OrderError(400, 'VALIDATION_ERROR', 'Cantidad de pedido invalida');
      }
      matched.set(key, { requestedName: requestedName || product?.name || 'Item solicitado', product, quantity });
    }
    return [...matched.values()].map((match) => ({ ...match, ...this.evaluateAvailability(match.product, match.quantity, input.agentId != null) }));
  }

  async updateStatus(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null): Promise<CommercialOrder | null> {
    return this.inScope(companyId, (repo) => repo.transition(companyId, orderId, status, actorUserId));
  }

  private async transition(companyId: number, orderId: number, status: CommercialOrderStatus, actorUserId: number | null) {
    const row = await this.lockOrder(companyId, orderId);
    if (!row) return null;
    const reserves = committedStates.includes(status);
    const previousCommitted = committedStates.includes(row.status);
    if (row.status === status && (!reserves || row.confirmed_at)) return this.withItems(row);
    if (terminalStates.includes(row.status) || (previousCommitted && preorderStates.includes(status))) {
      throw this.conflict('ORDER_STATUS_CONFLICT', 'El pedido no admite el cambio de estado solicitado');
    }

    if ((reserves || terminalStates.includes(status)) && actorUserId == null) {
      throw new OrderError(403, 'ORDER_OPERATOR_REQUIRED', 'La operacion requiere un operador autenticado');
    }
    await this.requireActor(companyId, actorUserId);
    const order = await this.withItems(row);
    let reserved = false;
    if (reserves) {
      if (previousCommitted && row.confirmed_at) {
        await this.db.query('UPDATE order_items SET status = $3, updated_at = NOW() WHERE company_id = $1 AND order_id = $2',
          [companyId, orderId, status]);
      } else {
        reserved = await this.reserveInventory(order, status, actorUserId!);
      }
    } else if (terminalStates.includes(status)) {
      if (status === 'completed' && (!previousCommitted || !row.confirmed_at)) {
        throw this.conflict('ORDER_CONFIRMATION_REQUIRED', 'Confirma el pedido y sus reservas antes de completarlo');
      }
      await this.finalizeInventory(order, status === 'completed', actorUserId!);
      await this.db.query(`
        UPDATE order_items SET status = $3,
          availability_status = CASE WHEN availability_status = 'reserved' THEN 'available' ELSE availability_status END,
          updated_at = NOW()
        WHERE company_id = $1 AND order_id = $2
      `, [companyId, orderId, status]);
    }

    const { rows: [updated] } = await this.db.query(`
      UPDATE customer_orders SET status = $3, updated_at = NOW(),
        confirmed_at = CASE WHEN $4 THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
        reserved_at = CASE WHEN $5 THEN COALESCE(reserved_at, NOW()) ELSE reserved_at END
      WHERE company_id = $1 AND id = $2 AND order_type = 'commercial' RETURNING *
    `, [companyId, orderId, status, reserves, reserved]);
    await this.createAction(companyId, orderId, `order_${status}`, 'completed', actorUserId, `Pedido actualizado a ${status}`);
    if (reserved) {
      await this.createAction(companyId, orderId, 'availability_reserved', 'completed', actorUserId, 'Disponibilidad reservada');
    }
    await this.setCommercialStateForOrder(companyId, orderId, status, actorUserId);
    return this.withItems(updated);
  }

  private async lockOrder(companyId: number, orderId: number): Promise<Row | undefined> {
    const { rows: [prior] } = await this.db.query(
      "SELECT conversation_id FROM customer_orders WHERE company_id = $1 AND id = $2 AND order_type = 'commercial'",
      [companyId, orderId],
    );
    if (!prior) return undefined;
    if (prior.conversation_id != null) {
      const { rows } = await this.db.query('SELECT id FROM conversations WHERE company_id = $1 AND id = $2 FOR UPDATE',
        [companyId, prior.conversation_id]);
      if (!rows.length) throw this.notFound('Conversacion no encontrada');
    }
    const { rows: [order] } = await this.db.query(
      "SELECT * FROM customer_orders WHERE company_id = $1 AND id = $2 AND order_type = 'commercial' FOR UPDATE",
      [companyId, orderId],
    );
    if (order && order.conversation_id !== prior.conversation_id) {
      throw this.conflict('ORDER_REFERENCE_CHANGED', 'La conversacion del pedido cambio');
    }
    if (order?.contact_id != null) await this.requireContact(companyId, order.contact_id);
    return order;
  }

  private async reserveInventory(order: CommercialOrder, status: CommercialOrderStatus, actorId: number): Promise<boolean> {
    if (!order.items.length) throw this.conflict('ORDER_ITEMS_REQUIRED', 'El pedido requiere al menos un item antes de confirmarse');
    if (order.items.some((item) => !item.commercialItemId)) {
      throw this.conflict('ORDER_ITEM_UNAVAILABLE', 'El pedido contiene un item sin referencia de catalogo disponible');
    }
    const products = await this.lockProducts(order.companyId, order.items.map((item) => item.commercialItemId!));
    const reservations = await this.reservations(order.companyId, order.id);
    const remaining = new Map(reservations.map((row) => [row.itemId, row]));
    if (remaining.size !== reservations.length || remaining.has(null)) throw this.reservationConflict();
    let usesStock = false;
    for (const item of order.items) {
      const product = products.get(item.commercialItemId!);
      if (!product || product.status !== 'active') throw this.conflict('ORDER_ITEM_UNAVAILABLE', 'El pedido contiene un item inactivo');
      const kind = product.availability_type;
      const previous = remaining.get(item.id);
      remaining.delete(item.id);
      const tracked = quantityTypes.includes(kind);
      if (previous && (!tracked || previous.productId !== item.commercialItemId || previous.quantity > item.quantity)) {
        throw this.reservationConflict();
      }
      if (tracked) {
        usesStock = true;
        const delta = item.quantity - (previous?.quantity ?? 0);
        if (delta) {
          await this.moveStock(order, item.commercialItemId!, item.id, actorId,
            kind === 'capacity' ? 'capacity_reserved' : 'reservation', -delta, delta);
        }
      }
      const availability = tracked ? 'reserved'
        : manualTypes.includes(kind) || product.requires_human_approval ? 'manual_required' : 'unlimited';
      await this.db.query(`
        UPDATE order_items SET status = $4, availability_status = $5,
          metadata_json = jsonb_set(metadata_json, '{availabilityType}', to_jsonb($6::text)), updated_at = NOW()
        WHERE company_id = $1 AND order_id = $2 AND id = $3
      `, [order.companyId, order.id, item.id, status, availability, kind]);
    }
    if (remaining.size) throw this.reservationConflict();
    return usesStock;
  }

  private async finalizeInventory(order: CommercialOrder, complete: boolean, actorId: number): Promise<void> {
    const balances = await this.reservations(order.companyId, order.id);
    const items = new Map(order.items.map((item) => [item.id, item]));
    const expected = new Set(complete
      ? order.items.filter((item) => quantityTypes.includes(String(item.metadata.availabilityType))).map((item) => item.id)
      : []);
    for (const balance of balances) {
      const item = balance.itemId == null ? undefined : items.get(balance.itemId);
      if (balance.itemId != null && (!item || item.commercialItemId !== balance.productId)) throw this.reservationConflict();
      if (complete && (!item || item.quantity !== balance.quantity)) throw this.reservationConflict();
      if (item) expected.delete(item.id);
    }
    if (expected.size) throw this.reservationConflict();
    const products = await this.lockProducts(order.companyId, balances.map((row) => row.productId));
    for (const balance of balances) {
      if (!products.has(balance.productId)) throw this.reservationConflict();
      await this.moveStock(order, balance.productId, balance.itemId, actorId, complete ? 'completion' : 'release',
        complete ? 0 : balance.quantity, -balance.quantity);
    }
  }

  private async reservations(companyId: number, orderId: number): Promise<Reservation[]> {
    const { rows } = await this.db.query(`
      SELECT product_id, order_item_id, SUM(COALESCE(delta_reserved,
        CASE WHEN movement_type IN ('reservation', 'reserved', 'capacity_reserved') THEN ABS(quantity::bigint)
             WHEN movement_type IN ('release', 'completion', 'reservation_released', 'confirmed_consumed', 'cancelled_restored')
               THEN -ABS(quantity::bigint)
             ELSE 0 END)) AS quantity
      FROM stock_movements WHERE company_id = $1 AND order_id = $2
      GROUP BY product_id, order_item_id ORDER BY product_id, order_item_id
    `, [companyId, orderId]);
    return rows.flatMap((row) => {
      const quantity = Number(row.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2_147_483_647) throw this.reservationConflict();
      return quantity === 0 ? [] : [{ productId: Number(row.product_id), itemId: row.order_item_id == null ? null : Number(row.order_item_id), quantity }];
    });
  }

  private async lockProducts(companyId: number, ids: number[]): Promise<Map<number, Row>> {
    if (!ids.length) return new Map();
    const { rows } = await this.db.query(`
      SELECT id, status, availability_type, requires_human_approval FROM products
      WHERE company_id = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE
    `, [companyId, ids]);
    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  private async moveStock(
    order: CommercialOrder, productId: number, itemId: number | null, actorId: number, movement: string,
    availableDelta: number, reservedDelta: number,
  ): Promise<void> {
    const { rows: [product] } = await this.db.query(`
      UPDATE products SET stock_available = stock_available + $3::integer,
        stock_reserved = stock_reserved + $4::integer, updated_at = NOW()
      WHERE company_id = $1 AND id = $2
        AND stock_available::bigint + $3::integer BETWEEN 0 AND 2147483647
        AND stock_reserved::bigint + $4::integer BETWEEN 0 AND 2147483647
      RETURNING stock_available, stock_reserved
    `, [order.companyId, productId, availableDelta, reservedDelta]);
    if (!product) {
      if (reservedDelta < 0) throw this.reservationConflict();
      throw this.conflict('ORDER_STOCK_UNAVAILABLE', 'Disponibilidad insuficiente para reservar el pedido');
    }
    await this.db.query(`
      INSERT INTO stock_movements (company_id, product_id, commercial_item_id, order_id, order_item_id, actor_user_id,
        movement_type, quantity, delta_available, delta_reserved, stock_available_after, stock_reserved_after)
      VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [order.companyId, productId, order.id, itemId, actorId, movement, Math.abs(reservedDelta),
      availableDelta, reservedDelta, product.stock_available, product.stock_reserved]);
  }

  private async resolveConversation(companyId: number, chatId: string): Promise<ConversationReference> {
    const raw = chatId.trim();
    const phone = /^\+?\d{7,15}(?:@(?:c\.us|s\.whatsapp\.net))?$/.test(raw) ? raw.replace(/@.*$/, '').replace(/^\+/, '') : null;
    const aliases = phone ? [phone, `+${phone}`, `${phone}@c.us`, `${phone}@s.whatsapp.net`] : [];
    const { rows: [first, second] } = await this.db.query(`
      SELECT id, external_conversation_id FROM conversations
      WHERE company_id = $1 AND (external_conversation_id = $2 OR
        (channel IN ('whatsapp', 'whatsapp-cloud', 'whatsapp-web') AND external_conversation_id = ANY($3::text[])))
      ORDER BY (external_conversation_id = $2) DESC, id LIMIT 2
    `, [companyId, raw, aliases]);
    if (!first) throw this.notFound('Conversacion no encontrada');
    if (second && (first.external_conversation_id !== raw || second.external_conversation_id === raw)) {
      throw this.conflict('ORDER_CHAT_AMBIGUOUS', 'La referencia corresponde a mas de una conversacion');
    }
    const { rows: [conversation] } = await this.db.query(`
      SELECT id, contact_id, external_conversation_id FROM conversations
      WHERE company_id = $1 AND id = $2 AND external_conversation_id = $3 FOR UPDATE
    `, [companyId, first.id, first.external_conversation_id]);
    if (!conversation) throw this.notFound('Conversacion no encontrada');
    if (conversation.contact_id != null) await this.requireContact(companyId, conversation.contact_id);
    return { contactId: conversation.contact_id, conversationId: conversation.id, chatId: conversation.external_conversation_id };
  }

  private async requireContact(companyId: number, contactId: number): Promise<void> {
    const { rows } = await this.db.query('SELECT id FROM contacts WHERE company_id = $1 AND id = $2 FOR SHARE', [companyId, contactId]);
    if (!rows.length) throw this.notFound('Contacto no encontrado');
  }

  private async requireActor(companyId: number, actorId: number | null): Promise<void> {
    if (actorId == null) return;
    const { rows } = await this.db.query('SELECT id FROM usuarios WHERE company_id = $1 AND id = $2 AND activo FOR SHARE',
      [companyId, actorId]);
    if (!rows.length) throw new OrderError(403, 'ORDER_OPERATOR_REQUIRED', 'El operador no esta activo en esta empresa');
  }

  private initialStatus(matches: ProductMatch[], requested?: CommercialOrderStatus): CommercialOrderStatus {
    if (matches.some((match) => !match.available)) return 'unavailable';
    if (matches.some((match) => match.requiresApproval)) return 'pending_approval';
    return requested && ['draft', 'quoted', 'pending_handoff'].includes(requested) ? requested : 'quoted';
  }

  private evaluateAvailability(product: Product | null, quantity: number, ai: boolean): Omit<ProductMatch, 'requestedName' | 'quantity' | 'product'> {
    if (!product || product.status !== 'active' || (ai && !product.aiEnabled)) {
      return { available: false, requiresApproval: false, availabilityStatus: 'unavailable', status: 'unavailable' };
    }
    const insufficient = quantityTypes.includes(product.availabilityType) && product.stockAvailable < quantity;
    if (insufficient && !product.allowBackorder) {
      return { available: false, requiresApproval: false, availabilityStatus: 'unavailable', status: 'unavailable' };
    }
    if (insufficient || product.requiresHumanApproval || manualTypes.includes(product.availabilityType)) {
      return { available: true, requiresApproval: true, availabilityStatus: 'manual_required', status: 'pending_approval' };
    }
    return { available: true, requiresApproval: false,
      availabilityStatus: product.availabilityType === 'unlimited' ? 'unlimited' : 'available', status: 'quoted' };
  }

  private notFound(message: string) { return new OrderError(404, 'ORDER_REFERENCE_NOT_FOUND', message); }
  private conflict(code: string, message: string) { return new OrderError(409, code, message); }
  private reservationConflict() { return this.conflict('ORDER_RESERVATION_CONFLICT', 'La reserva registrada requiere conciliacion'); }

  private async withItems(row: Row): Promise<CommercialOrder> {
    const items = await this.db.query(
      `SELECT * FROM order_items WHERE company_id = $1 AND order_id = $2 ORDER BY id ASC`,
      [Number(row.company_id), Number(row.id)]
    );
    return this.mapOrder(row, items.rows);
  }

  private mapOrder(row: Row, items: Row[]): CommercialOrder {
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
      items: items.map((item) => ({
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
        createdAt: new Date(item.created_at),
        updatedAt: new Date(item.updated_at),
      })),
    };
  }

  private async createAction(companyId: number, orderId: number, actionType: string, status: string, actorUserId: number | null, description: string): Promise<void> {
    const context = await this.db.query(
      `SELECT contact_id, conversation_id FROM customer_orders WHERE company_id = $1 AND id = $2`,
      [companyId, orderId]
    );
    await this.db.query(
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
    const context = await this.db.query(
      `SELECT conversation_id FROM customer_orders WHERE company_id = $1 AND id = $2`,
      [companyId, orderId]
    );
    const conversationId = context.rows[0]?.conversation_id ? Number(context.rows[0].conversation_id) : null;
    if (!conversationId) return;
    const state = this.mapOrderStatusToCommercialState(status);
    await this.db.query(
      `UPDATE conversations
       SET commercial_stage = $3,
           commercial_substatus = $4,
           commercial_state_updated_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [companyId, conversationId, state.stage, state.substatus]
    );
    await this.db.query(
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

}
