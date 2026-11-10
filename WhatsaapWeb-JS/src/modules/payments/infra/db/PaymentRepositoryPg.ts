import { Pool } from 'pg';
import { queryInTenantScope, withTenantTransaction } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { OrderError, OrderRepositoryPg } from '../../../orders';
import {
  CreatePaymentVoucherInput,
  MarkFromMessageInput,
  PaymentFilters,
  PaymentProcessSummary,
  PaymentVoucher,
  PaymentVoucherPage,
  PaymentVoucherStatus,
} from '../../domain/payment.types';

type Row = Record<string, any>;

export class PaymentRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  private inTenant<T>(companyId: number, work: (client: Queryable) => Promise<T>): Promise<T> {
    return this.pool instanceof Pool ? withTenantTransaction(companyId, work, this.pool) : work(this.pool);
  }

  async list(companyId: number, filters: PaymentFilters): Promise<PaymentVoucherPage> {
    const params: unknown[] = [companyId];
    const orderClauses: string[] = [
      'o.company_id = $1',
      "o.order_type = 'commercial'",
      `(o.status IN ('draft','quoted','pending_handoff','pending_approval','confirmed')
        OR o.reservation_expires_at IS NOT NULL OR (o.reservation_expired_at IS NOT NULL AND last_voucher.id IS NOT NULL))`,
      `EXISTS (
         SELECT 1 FROM order_items oi
         WHERE oi.company_id = o.company_id AND oi.order_id = o.id
       )`,
    ];
    const voucherClauses: string[] = ['pv.company_id = $1', 'pv.order_id IS NULL'];

    if (filters.status) {
      params.push(filters.status);
      const statusParam = `$${params.length}`;
      if (filters.status === 'pending') {
        orderClauses.push(`COALESCE(last_voucher.status, 'pending') = 'pending'`);
      } else {
        orderClauses.push(`last_voucher.status = ${statusParam}`);
      }
      voucherClauses.push(`pv.status = ${statusParam}`);
    }
    if (filters.paymentMethod) {
      params.push(filters.paymentMethod);
      orderClauses.push(`last_voucher.payment_method = $${params.length}`);
      voucherClauses.push(`pv.payment_method = $${params.length}`);
    }
    if (filters.orderId) {
      params.push(filters.orderId);
      orderClauses.push(`o.id = $${params.length}`);
      voucherClauses.push('FALSE');
    }
    if (filters.chatId) {
      params.push(filters.chatId);
      orderClauses.push(`COALESCE(c.external_conversation_id, o.metadata_json->>'chatId') = $${params.length}`);
      voucherClauses.push(`pv.chat_id = $${params.length}`);
    }
    if (filters.startDate && filters.endDate) {
      params.push(filters.startDate, filters.endDate);
      orderClauses.push(`COALESCE(last_voucher.uploaded_at, o.occurred_at) >= $${params.length - 1}::timestamp`);
      orderClauses.push(`COALESCE(last_voucher.uploaded_at, o.occurred_at) < ($${params.length}::date + 1)::timestamp`);
      voucherClauses.push(`pv.uploaded_at >= $${params.length - 1}::timestamp`);
      voucherClauses.push(`pv.uploaded_at < ($${params.length}::date + 1)::timestamp`);
    }

    const orderWhere = orderClauses.join(' AND ');
    const voucherWhere = voucherClauses.join(' AND ');
    const baseQuery = `
      WITH order_rows AS (
        SELECT
          CONCAT('order:', o.id)::varchar AS row_id,
          'payment_process'::varchar AS row_type,
          o.id AS order_id,
          last_voucher.id AS voucher_id,
          o.status AS order_status,
          last_voucher.status AS voucher_status,
          last_voucher.order_reconciliation_required,
          last_voucher.payment_method,
          last_voucher.amount,
          COALESCE(items.order_total, 0)::numeric AS order_total,
          COALESCE(last_voucher.currency, items.currency, 'PEN') AS currency,
          COALESCE(ct.display_name, ct.name, ct.profile_name, ct.phone, c.title, c.external_conversation_id, o.metadata_json->>'chatId', 'Sin contacto') AS customer_name,
          COALESCE(c.external_conversation_id, o.metadata_json->>'chatId') AS chat_id,
          last_voucher.file_url,
          last_voucher.mime_type,
          last_voucher.uploaded_at,
          last_voucher.validated_at,
          o.occurred_at AS order_created_at,
          items.items_json AS items,
          COALESCE(last_voucher.uploaded_at, o.occurred_at, o.created_at) AS sort_at
        FROM customer_orders o
        LEFT JOIN conversations c ON c.id = o.conversation_id
        LEFT JOIN contacts ct ON ct.id = o.contact_id
        LEFT JOIN LATERAL (
          SELECT pv.*
          FROM payment_vouchers pv
          WHERE pv.company_id = o.company_id AND pv.order_id = o.id
          ORDER BY pv.uploaded_at DESC, pv.id DESC
          LIMIT 1
        ) last_voucher ON TRUE
        JOIN LATERAL (
          SELECT
            COALESCE(SUM(COALESCE(oi.unit_price, 0) * oi.quantity), 0)::numeric AS order_total,
            COALESCE(MAX(oi.currency), 'PEN') AS currency,
            jsonb_agg(jsonb_build_object(
              'id', oi.id,
              'productName', oi.product_name,
              'quantity', oi.quantity,
              'unitPrice', oi.unit_price,
              'currency', oi.currency,
              'status', oi.status
            ) ORDER BY oi.id ASC) AS items_json
          FROM order_items oi
          WHERE oi.company_id = o.company_id AND oi.order_id = o.id
        ) items ON TRUE
        WHERE ${orderWhere}
      ),
      orphan_voucher_rows AS (
        SELECT
          CONCAT('voucher:', pv.id)::varchar AS row_id,
          'voucher'::varchar AS row_type,
          pv.order_id,
          pv.id AS voucher_id,
          NULL::varchar AS order_status,
          pv.status AS voucher_status,
          pv.order_reconciliation_required,
          pv.payment_method,
          pv.amount,
          NULL::numeric AS order_total,
          pv.currency,
          COALESCE(ct.display_name, ct.name, ct.profile_name, ct.phone, c.title, pv.chat_id, 'Sin contacto') AS customer_name,
          pv.chat_id,
          pv.file_url,
          pv.mime_type,
          pv.uploaded_at,
          pv.validated_at,
          NULL::timestamp AS order_created_at,
          '[]'::jsonb AS items,
          pv.uploaded_at AS sort_at
        FROM payment_vouchers pv
        LEFT JOIN contacts ct ON ct.id = pv.contact_id
        LEFT JOIN conversations c ON c.id = pv.conversation_id
        WHERE ${voucherWhere}
      ),
      unified AS (
        SELECT * FROM order_rows
        UNION ALL
        SELECT * FROM orphan_voucher_rows
      )
    `;
    const countResult = await queryInTenantScope(this.pool, companyId,
      `${baseQuery}
       SELECT COUNT(*)::int AS count FROM unified`,
      params
    );

    const listParams = [...params, filters.limit, filters.offset];
    const rowsResult = await queryInTenantScope(this.pool, companyId,
      `${baseQuery}
       SELECT *
       FROM unified
       ORDER BY sort_at DESC NULLS LAST, row_id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    return {
      rows: rowsResult.rows.map((row) => this.mapProcessSummary(row)),
      total: Number(countResult.rows[0]?.count || 0),
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async countPending(companyId: number): Promise<number> {
    const result = await queryInTenantScope(this.pool, companyId,
      `WITH payable_orders AS (
         SELECT o.id
         FROM customer_orders o
         WHERE o.company_id = $1
           AND o.order_type = 'commercial'
           AND (o.status IN ('draft','quoted','pending_handoff','pending_approval','confirmed')
             OR o.reservation_expires_at IS NOT NULL
             OR (o.reservation_expired_at IS NOT NULL AND EXISTS (
               SELECT 1 FROM payment_vouchers pv
               WHERE pv.company_id = o.company_id AND pv.order_id = o.id AND pv.status = 'pending'
             )))
           AND EXISTS (
             SELECT 1 FROM order_items oi
             WHERE oi.company_id = o.company_id AND oi.order_id = o.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM payment_vouchers pv
             WHERE pv.company_id = o.company_id
               AND pv.order_id = o.id
               AND pv.status = 'validated'
           )
       ),
       orphan_pending_vouchers AS (
         SELECT pv.id
         FROM payment_vouchers pv
         WHERE pv.company_id = $1
           AND pv.order_id IS NULL
           AND pv.status = 'pending'
       )
       SELECT (
         (SELECT COUNT(*) FROM payable_orders) +
         (SELECT COUNT(*) FROM orphan_pending_vouchers)
       )::int AS count`,
      [companyId]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async get(companyId: number, voucherId: number): Promise<PaymentVoucher | null> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT * FROM payment_vouchers WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, voucherId]
    );
    return result.rows[0] ? this.mapVoucher(result.rows[0]) : null;
  }

  async create(input: CreatePaymentVoucherInput): Promise<PaymentVoucher> {
    const result = await queryInTenantScope(this.pool, input.companyId,
      `INSERT INTO payment_vouchers (
         company_id, order_id, chat_id, contact_id, conversation_id, source_message_id,
         file_url, mime_type, file_size, payment_method, amount, currency, sender_reference,
         status, uploaded_by, notes, metadata_json
       )
       SELECT $1::integer, $2::bigint, $3::varchar, $4::integer, $5::integer, $6::integer, $7::text,
              $8::varchar, $9::bigint, $10::varchar, $11::numeric, $12::varchar, $13::varchar,
              'pending', $14::bigint, $15::text, $16::jsonb
       WHERE ($2::bigint IS NULL OR EXISTS (
         SELECT 1 FROM customer_orders o WHERE o.company_id = $1 AND o.id = $2 AND o.order_type = 'commercial'
           AND ($4::integer IS NULL OR o.contact_id IS NULL OR o.contact_id = $4)
           AND ($5::integer IS NULL OR o.conversation_id IS NULL OR o.conversation_id = $5)
       ))
       AND ($4::integer IS NULL OR EXISTS (SELECT 1 FROM contacts WHERE company_id = $1 AND id = $4))
       AND ($5::integer IS NULL OR EXISTS (
         SELECT 1 FROM conversations WHERE company_id = $1 AND id = $5
           AND ($4::integer IS NULL OR contact_id IS NULL OR contact_id = $4)
       ))
       AND ($6::integer IS NULL OR EXISTS (
         SELECT 1 FROM messages WHERE company_id = $1 AND id = $6
           AND ($5::integer IS NULL OR conversation_id = $5)
       ))
       AND ($14::bigint IS NULL OR EXISTS (SELECT 1 FROM usuarios WHERE company_id = $1 AND id = $14 AND activo))
       RETURNING *`,
      [
        input.companyId,
        input.orderId ?? null,
        input.chatId ?? null,
        input.contactId ?? null,
        input.conversationId ?? null,
        input.sourceMessageId ?? null,
        input.fileUrl,
        input.mimeType ?? null,
        input.fileSize ?? null,
        input.paymentMethod,
        input.amount ?? null,
        input.currency || 'PEN',
        input.senderReference ?? null,
        input.uploadedBy ?? null,
        input.notes ?? null,
        JSON.stringify(input.metadata || {}),
      ]
    );
    const voucher = result.rows[0];
    if (!voucher) throw Object.assign(new Error('Referencia de comprobante no encontrada'), { statusCode: 404 });
    return this.mapVoucher(voucher);
  }

  async markFromMessage(input: MarkFromMessageInput): Promise<PaymentVoucher> {
    return this.inTenant(input.companyId, async (client) => {
      const { rows: [message] } = await client.query(
        `SELECT m.id, m.conversation_id, m.provider, m.provider_message_id, c.external_conversation_id, c.contact_id,
                attachment.file_url, attachment.provider_media_id, attachment.mime_type, attachment.size_bytes
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(external_url, internal_path) AS file_url, provider_media_id, mime_type, size_bytes
           FROM message_attachments
           WHERE message_id = m.id AND (
             COALESCE(external_url, internal_path) IS NOT NULL OR
             (m.provider = 'meta-cloud' AND m.provider_message_id IS NOT NULL AND provider_media_id IS NOT NULL)
           )
           ORDER BY id LIMIT 1
         ) attachment ON true
         WHERE m.company_id = $1 AND m.id = $2`,
        [input.companyId, input.messageId]
      );
      if (!message) throw Object.assign(new Error('Mensaje no encontrado'), { statusCode: 404 });
      const fileUrl = message.provider === 'meta-cloud' && message.provider_media_id && message.provider_message_id
        ? `/api/media/${encodeURIComponent(message.provider_message_id)}` : message.file_url;
      if (!fileUrl) {
        throw Object.assign(new Error('El mensaje no tiene adjunto válido para comprobante'), { statusCode: 400 });
      }
      return new PaymentRepositoryPg(client).create({
        ...input,
        chatId: message.external_conversation_id || input.chatId || null,
        contactId: message.contact_id ?? null,
        conversationId: message.conversation_id ?? null,
        sourceMessageId: Number(message.id),
        fileUrl,
        mimeType: message.mime_type,
        fileSize: message.size_bytes ? Number(message.size_bytes) : null,
        metadata: { origin: 'chat_message', messageId: Number(message.id) },
      });
    });
  }

  async updateStatus(
    companyId: number,
    voucherId: number,
    status: Exclude<PaymentVoucherStatus, 'pending'>,
    actorUserId: number | null,
    rejectionReason?: string | null
  ): Promise<PaymentVoucher | null> {
    return this.inTenant(companyId, async (client) => {
      const actor = await client.query(
        `SELECT id FROM usuarios WHERE company_id = $1 AND id = $2 AND rol = 'ADMIN' AND activo FOR SHARE`,
        [companyId, actorUserId],
      );
      if (!actor.rowCount) {
        throw Object.assign(new Error('La decisión requiere un administrador activo'), { statusCode: 403, code: 'ADMIN_REQUIRED' });
      }
      const { rows: [voucher] } = await client.query(
        `UPDATE payment_vouchers
         SET status = $3, validated_by = $4, validated_at = NOW(), rejection_reason = $5, updated_at = NOW()
         WHERE company_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
        [companyId, voucherId, status, actorUserId, rejectionReason ?? null]
      );
      if (!voucher) {
        const existing = await new PaymentRepositoryPg(client).get(companyId, voucherId);
        if (!existing || (existing.status === status &&
            (status === 'validated' || existing.rejectionReason === rejectionReason))) return existing;
        throw Object.assign(new Error('El comprobante ya tiene una decisión'), { statusCode: 409, code: 'PAYMENT_ALREADY_DECIDED' });
      }

      let orderConfirmed = false;
      if (status === 'validated' && voucher.order_id) {
        try {
          const order = await new OrderRepositoryPg(client).updateStatus(
            companyId, Number(voucher.order_id), 'confirmed', actorUserId,
          );
          if (!order) throw Object.assign(new Error('Pedido comercial no encontrado'), { statusCode: 404 });
          orderConfirmed = true;
        } catch (error) {
          if (!(error instanceof OrderError) || error.code !== 'ORDER_RESERVATION_EXPIRED') throw error;
          await client.query(`
            UPDATE payment_vouchers SET order_reconciliation_required = true WHERE company_id = $1 AND id = $2
          `, [companyId, voucherId]);
          voucher.order_reconciliation_required = true;
        }
      }
      await client.query(
        `INSERT INTO operational_actions (
           company_id, order_id, contact_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
         ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $8::jsonb)`,
        [companyId, voucher.order_id, voucher.contact_id, voucher.conversation_id, actorUserId,
          status === 'validated' ? 'payment_validated' : 'payment_rejected',
          status === 'validated' ? 'Comprobante validado' : 'Comprobante rechazado',
          JSON.stringify({ voucherId, orderConfirmed, orderReconciliationRequired: voucher.order_reconciliation_required === true, source: 'payments' })]
      );
      return this.mapVoucher(voucher);
    });
  }

  private mapVoucher(row: Row): PaymentVoucher {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      orderId: row.order_id ? Number(row.order_id) : null,
      chatId: row.chat_id || null,
      contactId: row.contact_id ? Number(row.contact_id) : null,
      conversationId: row.conversation_id ? Number(row.conversation_id) : null,
      sourceMessageId: row.source_message_id ? Number(row.source_message_id) : null,
      fileUrl: row.file_url,
      mimeType: row.mime_type || null,
      fileSize: row.file_size ? Number(row.file_size) : null,
      paymentMethod: row.payment_method,
      amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
      currency: row.currency || 'PEN',
      senderReference: row.sender_reference || null,
      status: row.status,
      rejectionReason: row.rejection_reason || null,
      orderReconciliationRequired: row.order_reconciliation_required === true,
      uploadedBy: row.uploaded_by ? Number(row.uploaded_by) : null,
      validatedBy: row.validated_by ? Number(row.validated_by) : null,
      validatedAt: row.validated_at || null,
      notes: row.notes || null,
      metadata: row.metadata_json || {},
      uploadedAt: row.uploaded_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProcessSummary(row: Row): PaymentProcessSummary {
    const voucherStatus = row.voucher_status || null;
    const processStatus = voucherStatus === 'validated'
      ? 'validated'
      : voucherStatus === 'rejected'
        ? 'rejected'
        : voucherStatus === 'pending'
          ? 'voucher_pending'
          : 'collect_payment';
    return {
      rowId: row.row_id,
      rowType: row.row_type,
      processStatus,
      orderId: row.order_id ? Number(row.order_id) : null,
      voucherId: row.voucher_id ? Number(row.voucher_id) : null,
      orderStatus: row.order_status || null,
      voucherStatus,
      orderReconciliationRequired: row.order_reconciliation_required === true,
      paymentMethod: row.payment_method || null,
      amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
      orderTotal: row.order_total === null || row.order_total === undefined ? null : Number(row.order_total),
      currency: row.currency || 'PEN',
      customerName: row.customer_name || 'Sin contacto',
      chatId: row.chat_id || null,
      fileUrl: row.file_url || null,
      mimeType: row.mime_type || null,
      uploadedAt: row.uploaded_at || null,
      validatedAt: row.validated_at || null,
      orderCreatedAt: row.order_created_at || null,
      items: Array.isArray(row.items)
        ? row.items.map((item: Row) => ({
            id: Number(item.id),
            productName: item.productName || item.product_name || 'Item',
            quantity: Number(item.quantity || 0),
            unitPrice: item.unitPrice === null || item.unitPrice === undefined ? null : Number(item.unitPrice),
            currency: item.currency || row.currency || 'PEN',
            status: item.status || 'pending',
          }))
        : [],
    };
  }
}
