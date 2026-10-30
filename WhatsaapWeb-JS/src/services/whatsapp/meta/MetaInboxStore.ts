import { Pool, PoolClient } from 'pg';
import pool from '../../../config/database';

function toUnixSeconds(value: unknown): number | null {
  if (!value) return null;
  return Math.floor(new Date(value as string | Date).getTime() / 1000);
}

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

export interface MetaInboxStoreOptions {
  db?: Pool;
  io?: any;
  companyId: number;
}

export interface ServiceWindowStatus {
  hasActiveSession: boolean;
  status: 'open' | 'closed';
  serviceWindowExpiresAt: Date | null;
  lastCustomerMessageAt: Date | null;
  conversationStatus: string | null;
  reason: 'service_window_open' | 'service_window_closed' | 'conversation_not_found';
}

export class MetaInboxStore {
  readonly pool: Pool;
  private io: any;
  private readonly companyId: number;

  constructor({ db = pool as Pool, io = null, companyId }: MetaInboxStoreOptions) {
    this.pool = db;
    this.io = io;
    this.companyId = companyId;
  }

  getCompanyId(): number {
    return this.companyId;
  }

  withCompany(companyId: number): MetaInboxStore {
    if (companyId === this.companyId) return this;
    return new MetaInboxStore({ db: this.pool, io: this.io, companyId });
  }

  setSocketIO(io: any): void {
    this.io = io;
  }

  normalizePhone(value: string): string {
    return String(value || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/[^\d]/g, '');
  }

  async ensureAccount(metaConfig: any): Promise<Record<string, unknown> | null> {
    if (!metaConfig.phoneNumberId) return null;
    const result = await this.pool.query(
      `INSERT INTO whatsapp_business_accounts (
         company_id, provider, waba_id, phone_number_id,
         display_phone_number, business_phone_number, graph_version,
         token_secret_ref, status, metadata_json, updated_at
       )
       VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6, 'META_WA_ACCESS_TOKEN', $7, $8, NOW())
       ON CONFLICT (company_id, provider, phone_number_id)
       DO UPDATE SET
         waba_id = COALESCE(EXCLUDED.waba_id, whatsapp_business_accounts.waba_id),
         display_phone_number = COALESCE(EXCLUDED.display_phone_number, whatsapp_business_accounts.display_phone_number),
         business_phone_number = COALESCE(EXCLUDED.business_phone_number, whatsapp_business_accounts.business_phone_number),
         graph_version = EXCLUDED.graph_version,
         status = EXCLUDED.status,
         metadata_json = whatsapp_business_accounts.metadata_json || EXCLUDED.metadata_json,
         updated_at = NOW()
       RETURNING *`,
      [
        this.companyId,
        metaConfig.wabaId || null,
        metaConfig.phoneNumberId,
        metaConfig.displayPhoneNumber || null,
        metaConfig.displayPhoneNumber || null,
        metaConfig.graphVersion || 'v25.0',
        metaConfig.accessToken ? 'configured' : 'missing_token',
        json({ source: 'env' }),
      ]
    );
    return result.rows[0] || null;
  }

  async getChats({ limit = 50, offset = 0 } = {}): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT
         c.external_conversation_id AS id,
         COALESCE(c.title, ct.display_name, ct.name, ct.profile_name, ct.phone, c.external_conversation_id) AS name,
         c.last_message_at,
         c.unread_count,
         c.last_message_preview,
         c.status,
         c.service_window_expires_at
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.archived_at IS NULL
       ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
       LIMIT $2 OFFSET $3`,
      [this.companyId, limit, offset]
    );

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastMessageTimestamp: toUnixSeconds(row.last_message_at),
      unreadCount: row.unread_count || 0,
      isGroup: false,
      lastMessagePreview: row.last_message_preview || null,
      status: row.status,
      serviceWindowExpiresAt: row.service_window_expires_at,
    }));
  }

  async getMessages(chatId: string, limit = 50, before = 0): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [this.companyId, this.normalizePhone(chatId), limit];
    let beforeSql = '';
    if (before > 0) {
      params.push(new Date(before < 1e12 ? before * 1000 : before));
      beforeSql = `AND m.occurred_at < $${params.length}`;
    }

    const result = await this.pool.query(
      `SELECT m.*, a.provider_media_id, a.mime_type, a.filename, a.size_bytes
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       LEFT JOIN message_attachments a ON a.message_id = m.id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.external_conversation_id = $2
         ${beforeSql}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT $3`,
      params
    );

    return result.rows.reverse().map((row) => ({
      id: row.provider_message_id || String(row.id),
      body: row.body,
      fromMe: row.direction === 'outbound',
      timestamp: toUnixSeconds(row.occurred_at),
      sender: row.direction === 'outbound' ? 'me' : row.external_contact_id || chatId,
      type: row.message_type || 'text',
      mediaUrl: row.provider_media_id ? `/api/media/${encodeURIComponent(row.provider_message_id || String(row.id))}` : null,
      mimetype: row.mime_type || null,
      filename: row.filename || null,
      fileSize: row.size_bytes || null,
      chatId,
      status: row.status,
    }));
  }

  async canSendFreeForm(chatId: string): Promise<boolean> {
    const status = await this.getServiceWindowStatus(chatId);
    return status.hasActiveSession;
  }

  async getServiceWindowStatus(chatId: string): Promise<ServiceWindowStatus> {
    const result = await this.pool.query(
      `SELECT
         service_window_expires_at,
         last_customer_message_at,
         status
       FROM conversations
       WHERE company_id = $1 AND channel = 'whatsapp' AND external_conversation_id = $2`,
      [this.companyId, this.normalizePhone(chatId)]
    );
    const row = result.rows[0] || null;
    const expiresAt = row?.service_window_expires_at || null;
    const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;
    const hasActiveSession = Boolean(expiresAt && expiresAtMs > Date.now());

    return {
      hasActiveSession,
      status: hasActiveSession ? 'open' : 'closed',
      serviceWindowExpiresAt: expiresAt,
      lastCustomerMessageAt: row?.last_customer_message_at || null,
      conversationStatus: row?.status || null,
      reason: hasActiveSession
        ? 'service_window_open'
        : (row ? 'service_window_closed' : 'conversation_not_found'),
    };
  }

  async listTemplates({ approvedOnly = true } = {}): Promise<Record<string, unknown>[]> {
    const statusFilter = approvedOnly ? `AND UPPER(COALESCE(status, '')) = 'APPROVED'` : '';
    const result = await this.pool.query(
      `SELECT
         id,
         template_name,
         language_code,
         category,
         status,
         components_json,
         external_template_id,
         last_synced_at,
         updated_at
       FROM whatsapp_message_templates
       WHERE company_id = $1
         AND provider = 'meta-cloud'
         ${statusFilter}
       ORDER BY template_name ASC, language_code ASC`,
      [this.companyId]
    );

    const templates = result.rows.map((row) => ({
      id: row.external_template_id || String(row.id),
      name: row.template_name,
      languageCode: row.language_code,
      category: row.category || null,
      status: row.status || null,
      components: row.components_json || [],
      lastSyncedAt: row.last_synced_at,
      updatedAt: row.updated_at,
      source: 'database',
    }));

    if (templates.length > 0) return templates;

    return [{
      id: 'hello_world:en_US',
      name: 'hello_world',
      languageCode: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [],
      lastSyncedAt: null,
      updatedAt: null,
      source: 'development-default',
    }];
  }

  async upsertTemplates(templates: Array<{
    id?: string | null;
    name: string;
    language: string;
    status?: string | null;
    category?: string | null;
    components?: unknown[];
  }>, wabaId?: string | null): Promise<void> {
    for (const template of templates) {
      if (!template.name || !template.language) continue;
      await this.pool.query(
        `INSERT INTO whatsapp_message_templates (
           company_id, provider, waba_id, template_name, language_code,
           category, status, components_json, external_template_id,
           last_synced_at, updated_at
         )
         VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
         ON CONFLICT (company_id, provider, template_name, language_code)
         DO UPDATE SET
           waba_id = COALESCE(EXCLUDED.waba_id, whatsapp_message_templates.waba_id),
           category = EXCLUDED.category,
           status = EXCLUDED.status,
           components_json = EXCLUDED.components_json,
           external_template_id = COALESCE(EXCLUDED.external_template_id, whatsapp_message_templates.external_template_id),
           last_synced_at = NOW(),
           updated_at = NOW()`,
        [
          this.companyId,
          wabaId || null,
          template.name,
          template.language,
          template.category || null,
          template.status || null,
          json(template.components || []),
          template.id || null,
        ]
      );
    }
  }

  async findLatestInboundProviderMessageId(chatId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT m.provider_message_id
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.external_conversation_id = $2
         AND m.direction = 'inbound'
         AND m.provider_message_id IS NOT NULL
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT 1`,
      [this.companyId, this.normalizePhone(chatId)]
    );
    return result.rows[0]?.provider_message_id || null;
  }

  async markConversationRead(chatId: string): Promise<void> {
    const normalizedChatId = this.normalizePhone(chatId);
    await this.pool.query(
      `UPDATE conversations
       SET unread_count = 0, updated_at = NOW()
       WHERE company_id = $1 AND channel = 'whatsapp' AND external_conversation_id = $2`,
      [this.companyId, normalizedChatId]
    );

    await this.pool.query(
      `UPDATE messages m
       SET status = 'read', read_at = COALESCE(read_at, NOW())
       FROM conversations c
       WHERE m.conversation_id = c.id
         AND c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.external_conversation_id = $2
         AND m.direction = 'inbound'
         AND m.status IN ('received', 'delivered', 'sent')`,
      [this.companyId, normalizedChatId]
    );
  }

  private async upsertContact(client: PoolClient, input: { externalContactId: string; phone: string; name: string | null; rawProfile: unknown }): Promise<any> {
    const result = await client.query(
      `INSERT INTO contacts (
         company_id, channel, provider, external_contact_id,
         wa_id, phone, name, display_name, profile_name,
         raw_profile_json, first_seen_at, last_seen_at, metadata_json
       )
       VALUES ($1, 'whatsapp', 'meta-cloud', $2, $3, $4, $5, $5, $5, $6, NOW(), NOW(), '{}')
       ON CONFLICT (company_id, channel, external_contact_id)
       DO UPDATE SET
         wa_id = COALESCE(EXCLUDED.wa_id, contacts.wa_id),
         phone = COALESCE(EXCLUDED.phone, contacts.phone),
         name = COALESCE(EXCLUDED.name, contacts.name),
         display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
         profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
         raw_profile_json = COALESCE(EXCLUDED.raw_profile_json, contacts.raw_profile_json),
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [
        this.companyId,
        input.externalContactId,
        input.externalContactId,
        input.phone || input.externalContactId,
        input.name,
        input.rawProfile ? json(input.rawProfile) : null,
      ]
    );
    return result.rows[0];
  }

  private async upsertConversation(
    client: PoolClient,
    input: { externalConversationId: string; contactId: number; title: string; inboundAt: Date | null; preview: string | null; direction: 'inbound' | 'outbound' }
  ): Promise<any> {
    const serviceWindowExpiresAt = input.inboundAt
      ? new Date(input.inboundAt.getTime() + 24 * 60 * 60 * 1000)
      : null;

    const result = await client.query(
      `INSERT INTO conversations (
         company_id, channel, provider, external_conversation_id, contact_id,
         type, title, first_message_at, last_message_at,
         last_customer_message_at, service_window_expires_at,
         last_message_preview, last_message_direction, unread_count,
         metadata_json
       )
       VALUES (
         $1, 'whatsapp', 'meta-cloud', $2, $3,
         'whatsapp', $4, COALESCE($5, NOW()), COALESCE($5, NOW()),
         $5, $6, $7, $8::varchar, CASE WHEN $8::varchar = 'inbound' THEN 1 ELSE 0 END, '{}'
       )
       ON CONFLICT (company_id, channel, external_conversation_id)
       DO UPDATE SET
         contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id),
         title = COALESCE(EXCLUDED.title, conversations.title),
         last_message_at = GREATEST(COALESCE(conversations.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at),
         last_customer_message_at = COALESCE(EXCLUDED.last_customer_message_at, conversations.last_customer_message_at),
         service_window_expires_at = COALESCE(EXCLUDED.service_window_expires_at, conversations.service_window_expires_at),
         last_message_preview = COALESCE(EXCLUDED.last_message_preview, conversations.last_message_preview),
         last_message_direction = COALESCE(EXCLUDED.last_message_direction, conversations.last_message_direction),
         unread_count = conversations.unread_count + CASE WHEN EXCLUDED.last_message_direction = 'inbound' THEN 1 ELSE 0 END,
         status = 'open',
         updated_at = NOW()
       RETURNING *`,
      [
        this.companyId,
        input.externalConversationId,
        input.contactId,
        input.title,
        input.inboundAt,
        serviceWindowExpiresAt,
        input.preview,
        input.direction,
      ]
    );
    return result.rows[0];
  }

  private extractBody(message: any): string | null {
    return message?.text?.body || message?.button?.text || message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title || message?.image?.caption || message?.video?.caption ||
      message?.document?.caption || null;
  }

  private getProviderMediaId(message: any): string | null {
    return message?.image?.id || message?.audio?.id || message?.video?.id || message?.document?.id || message?.sticker?.id || null;
  }

  private getMimeType(message: any): string | null {
    return message?.image?.mime_type || message?.audio?.mime_type || message?.video?.mime_type || message?.document?.mime_type || message?.sticker?.mime_type || null;
  }

  private getMediaFilename(message: any): string | null {
    return message?.document?.filename || null;
  }

  private getMediaSha256(message: any): string | null {
    return message?.image?.sha256 || message?.audio?.sha256 || message?.video?.sha256 || message?.document?.sha256 || message?.sticker?.sha256 || null;
  }

  async persistInboundMessage({ message, contact, metadata, value }: any): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const providerMessageId = message.id;
      const event = await client.query(
        `INSERT INTO whatsapp_webhook_events (
           company_id, provider, phone_number_id, event_type, event_dedupe_key,
           provider_message_id, payload_json
         )
         VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, provider, event_dedupe_key) DO NOTHING
         RETURNING *`,
        [
          this.companyId,
          metadata?.phone_number_id || null,
          `message.${message.type || 'unknown'}`,
          `message:${providerMessageId}`,
          providerMessageId,
          json({ message, contact, metadata, value }),
        ]
      );

      if (!event.rows[0]) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }

      const externalContactId = this.normalizePhone(message.from);
      const occurredAt = new Date(Number(message.timestamp || Math.floor(Date.now() / 1000)) * 1000);
      const contactRow = await this.upsertContact(client, {
        externalContactId,
        phone: externalContactId,
        name: contact?.profile?.name || null,
        rawProfile: contact || null,
      });
      const body = this.extractBody(message);
      const conversation = await this.upsertConversation(client, {
        externalConversationId: externalContactId,
        contactId: contactRow.id,
        title: contact?.profile?.name || externalContactId,
        inboundAt: occurredAt,
        preview: body || (message?.type ? `[${message.type}]` : null),
        direction: 'inbound',
      });

      const inserted = await client.query(
        `INSERT INTO messages (
           company_id, conversation_id, direction, channel, provider,
           provider_message_id, external_contact_id, body, message_type,
           status, occurred_at, raw_payload_json, metadata_json
         )
         VALUES ($1, $2, 'inbound', 'whatsapp', 'meta-cloud', $3, $4, $5, $6, 'received', $7, $8, $9)
         ON CONFLICT (company_id, channel, provider_message_id) DO NOTHING
         RETURNING *`,
        [this.companyId, conversation.id, providerMessageId, externalContactId, body, message.type || 'unknown', occurredAt, json(message), json({ metadata })]
      );
      const messageRow = inserted.rows[0];

      if (messageRow && this.getProviderMediaId(message)) {
        await client.query(
          `INSERT INTO message_attachments (
             message_id, provider, provider_media_id, filename, mime_type,
             sha256, caption, metadata_json, storage_status
           )
           VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6, $7, 'remote')`,
          [
            messageRow.id,
            this.getProviderMediaId(message),
            this.getMediaFilename(message),
            this.getMimeType(message),
            this.getMediaSha256(message),
            body,
            json(message[message.type] || {}),
          ]
        );
      }

      if (messageRow) {
        await client.query(
          `INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json, provider, provider_message_id, raw_payload_json)
           VALUES ($1, 'received', 'meta-cloud', $2, $3, 'meta-cloud', $4, $5)
           ON CONFLICT DO NOTHING`,
          [messageRow.id, occurredAt, json({ event: 'message' }), providerMessageId, json(message)]
        );
      }

      await client.query(
        `UPDATE whatsapp_webhook_events SET processed_at = NOW(), processing_status = 'processed' WHERE id = $1`,
        [event.rows[0].id]
      );
      await client.query('COMMIT');

      const payload = {
        id: providerMessageId,
        body,
        fromMe: false,
        timestamp: toUnixSeconds(occurredAt),
        sender: externalContactId,
        type: message.type || 'unknown',
        mediaUrl: this.getProviderMediaId(message) ? `/api/media/${encodeURIComponent(providerMessageId)}` : null,
        mimetype: this.getMimeType(message),
        filename: message?.document?.filename || null,
        chatId: externalContactId,
      };
      this.emitMessage(externalContactId, payload);
      await this.emitChatsUpdated();
      return { duplicate: false, message: payload };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistStatus({ status, metadata, value }: any): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const providerMessageId = status.id;
      const occurredAt = new Date(Number(status.timestamp || Math.floor(Date.now() / 1000)) * 1000);
      const event = await client.query(
        `INSERT INTO whatsapp_webhook_events (
           company_id, provider, phone_number_id, event_type, event_dedupe_key,
           provider_message_id, payload_json
         )
         VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, provider, event_dedupe_key) DO NOTHING
         RETURNING *`,
        [
          this.companyId,
          metadata?.phone_number_id || null,
          `status.${status.status || 'unknown'}`,
          `status:${providerMessageId}:${status.status}:${status.timestamp || ''}`,
          providerMessageId,
          json({ status, metadata, value }),
        ]
      );
      if (!event.rows[0]) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }

      const messageResult = await client.query(
        `SELECT * FROM messages WHERE company_id = $1 AND channel = 'whatsapp' AND provider_message_id = $2 LIMIT 1`,
        [this.companyId, providerMessageId]
      );
      const messageRow = messageResult.rows[0];
      if (messageRow) {
        await client.query(
          `INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json, provider, provider_message_id, raw_payload_json)
           VALUES ($1, $2, 'meta-cloud', $3, $4, 'meta-cloud', $5, $6)
           ON CONFLICT DO NOTHING`,
          [messageRow.id, status.status || 'unknown', occurredAt, json(status), providerMessageId, json(status)]
        );
        await client.query(
          `UPDATE messages
           SET status = $1::varchar,
               delivered_at = CASE WHEN $1::varchar = 'delivered' THEN COALESCE(delivered_at, $2) ELSE delivered_at END,
               read_at = CASE WHEN $1::varchar = 'read' THEN COALESCE(read_at, $2) ELSE read_at END,
               failed_at = CASE WHEN $1::varchar = 'failed' THEN COALESCE(failed_at, $2) ELSE failed_at END,
               error_code = $3,
               error_message = $4
           WHERE id = $5`,
          [
            status.status || 'unknown',
            occurredAt,
            status.errors?.[0]?.code ? String(status.errors[0].code) : null,
            status.errors?.[0]?.title || status.errors?.[0]?.message || null,
            messageRow.id,
          ]
        );
      }
      await client.query(`UPDATE whatsapp_webhook_events SET processed_at = NOW(), processing_status = 'processed' WHERE id = $1`, [event.rows[0].id]);
      await client.query('COMMIT');
      return { duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistOutbound(input: {
    chatId: string;
    body: string | null;
    messageType: string;
    providerMessageId: string | null;
    raw: unknown;
    template?: { name: string; language: string } | null;
    media?: {
      providerMediaId: string;
      mimeType?: string | null;
      filename?: string | null;
      sizeBytes?: number | null;
      caption?: string | null;
      metadata?: unknown;
    } | null;
  }): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const externalContactId = this.normalizePhone(input.chatId);
      const contact = await this.upsertContact(client, { externalContactId, phone: externalContactId, name: null, rawProfile: null });
      const conversation = await this.upsertConversation(client, {
        externalConversationId: externalContactId,
        contactId: contact.id,
        title: externalContactId,
        inboundAt: null,
        preview: input.body || (input.template ? `[Template: ${input.template.name}]` : '[Mensaje]'),
        direction: 'outbound',
      });
      const result = await client.query(
        `INSERT INTO messages (
           company_id, conversation_id, direction, channel, provider,
           provider_message_id, external_contact_id, body, message_type,
           status, occurred_at, raw_payload_json,
           template_name, template_language, metadata_json
         )
         VALUES ($1, $2, 'outbound', 'whatsapp', 'meta-cloud', $3, $4, $5, $6, 'sent', NOW(), $7, $8, $9, $10)
         ON CONFLICT (company_id, channel, provider_message_id) DO UPDATE SET
           status = EXCLUDED.status,
           raw_payload_json = EXCLUDED.raw_payload_json
         RETURNING *`,
        [
          this.companyId,
          conversation.id,
          input.providerMessageId,
          externalContactId,
          input.body,
          input.messageType,
          json(input.raw),
          input.template?.name || null,
          input.template?.language || null,
          json({ raw: input.raw }),
        ]
      );
      if (input.media) {
        await client.query(
          `INSERT INTO message_attachments (
             message_id, provider, provider_media_id, filename, mime_type,
             size_bytes, caption, metadata_json, storage_status
           )
           VALUES ($1, 'meta-cloud', $2, $3, $4, $5, $6, $7, 'remote')
           ON CONFLICT DO NOTHING`,
          [
            result.rows[0].id,
            input.media.providerMediaId,
            input.media.filename || null,
            input.media.mimeType || null,
            input.media.sizeBytes || null,
            input.media.caption || null,
            json(input.media.metadata || {}),
          ]
        );
      }
      await client.query(
        `INSERT INTO message_statuses (message_id, status, source, occurred_at, metadata_json, provider, provider_message_id, raw_payload_json)
         VALUES ($1, 'sent', 'meta-cloud', NOW(), $2, 'meta-cloud', $3, $4)
         ON CONFLICT DO NOTHING`,
        [result.rows[0].id, json({ event: 'outbound_send' }), input.providerMessageId, json(input.raw)]
      );
      await client.query(
        `UPDATE conversations
         SET last_message_at = NOW(), last_outbound_message_at = NOW(),
             last_message_preview = $2, last_message_direction = 'outbound', updated_at = NOW()
         WHERE id = $1`,
        [conversation.id, input.body || (input.template ? `[Template: ${input.template.name}]` : '[Mensaje]')]
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      const payload = {
        id: input.providerMessageId || String(row.id),
        body: input.body || '',
        fromMe: true,
        timestamp: toUnixSeconds(row.occurred_at) || Math.floor(Date.now() / 1000),
        sender: externalContactId,
        type: input.messageType || 'text',
        mediaUrl: input.media ? `/api/media/${encodeURIComponent(String(input.providerMessageId || row.id))}` : null,
        mimetype: input.media?.mimeType || null,
        filename: input.media?.filename || null,
        chatId: externalContactId,
      };
      this.emitMessage(externalContactId, payload);
      await this.emitChatsUpdated();
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findMediaAttachment(messageId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT
         a.id AS attachment_id,
         a.message_id,
         a.provider_media_id,
         a.mime_type,
         a.filename,
         a.size_bytes,
         a.sha256,
         a.caption,
         a.internal_path,
         a.storage_status,
         a.metadata_json,
         m.provider_message_id,
         m.message_type,
         m.body
       FROM message_attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.company_id = $1
         AND m.channel = 'whatsapp'
         AND (
           m.provider_message_id = $2
           OR m.id::text = $2
           OR a.provider_media_id = $2
         )
       ORDER BY a.id DESC
       LIMIT 1`,
      [this.companyId, messageId]
    );
    return result.rows[0] || null;
  }

  async markMediaDownloaded(input: {
    attachmentId: number;
    internalPath: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
    metadata?: unknown;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE message_attachments
       SET internal_path = $2,
           mime_type = COALESCE($3, mime_type),
           size_bytes = COALESCE($4, size_bytes),
           sha256 = COALESCE($5, sha256),
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb,
           storage_status = 'downloaded',
           downloaded_at = NOW()
       WHERE id = $1`,
      [
        input.attachmentId,
        input.internalPath,
        input.mimeType || null,
        input.sizeBytes || null,
        input.sha256 || null,
        json(input.metadata || {}),
      ]
    );
  }

  private emitMessage(chatId: string, payload: unknown): void {
    if (!this.io) return;
    this.io.to(chatId).emit('message', payload);
    this.io.emit('message', payload);
  }

  private async emitChatsUpdated(): Promise<void> {
    if (!this.io) return;
    this.io.emit('chats-updated', await this.getChats());
  }
}
