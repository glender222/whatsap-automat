import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import pool from '../../../config/database';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { Queryable } from '../../../shared/UnitOfWorkPort';
import { applyCanonicalMetaStatuses, correlateCanonicalMetaStatus, lockMetaReceipt } from './MetaCanonicalReceipt';
import { applyCampaignMetaReceipt, campaignCallbackPrefix } from '../../campaigns/CampaignMetaReceipt';

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

export interface MetaMediaAttachment {
  attachment_id: number;
  provider_media_id: string | null;
  mime_type: string | null;
  filename: string | null;
  internal_path: string | null;
  phone_number_id: string | null;
}

const attachmentPhoneNumber = `COALESCE(send.phone_number_id, m.metadata_json #>> '{metadata,phone_number_id}') AS phone_number_id`;
const attachmentSendClaim = `LEFT JOIN conversation_send_claims send
  ON send.message_id = m.id AND send.tenant_id = m.company_id AND send.conversation_id = m.conversation_id`;

export interface ServiceWindowStatus {
  hasActiveSession: boolean;
  status: 'open' | 'closed';
  serviceWindowExpiresAt: Date | null;
  lastCustomerMessageAt: Date | null;
  conversationStatus: string | null;
  reason: 'service_window_open' | 'service_window_closed' | 'conversation_not_found';
  conversationId?: string;
  stateVersion?: number;
  assignedUserId?: string | null;
  aiPaused?: boolean;
  hasUnresolvedDelivery?: boolean;
}

export class MetaInboxStore {
  readonly pool: Pool;
  private io: any;
  private readonly companyId: number;
  private readonly tenantWork: TenantScopedUoW;

  constructor({ db = pool as Pool, io = null, companyId }: MetaInboxStoreOptions) {
    this.pool = db;
    this.tenantWork = new TenantScopedUoW(db);
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

  private query(sql: string, parameters?: unknown[]) {
    return this.tenantWork.run(this.companyId, (client) => client.query(sql, parameters));
  }

  normalizePhone(value: string): string {
    return String(value || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/[^\d]/g, '');
  }

  async getChats({ limit = 50, offset = 0 } = {}): Promise<Record<string, unknown>[]> {
    const result = await this.query(
      `SELECT
         c.external_conversation_id AS id,
         c.id AS conversation_id,
         c.version AS state_version,
         c.assigned_user_id,
         c.ia_paused AND (c.ia_resume_at IS NULL OR c.ia_resume_at > NOW()) AS ia_paused,
         COALESCE(c.title, ct.display_name, ct.name, ct.profile_name, ct.phone, c.external_conversation_id) AS name,
         c.last_message_at,
         c.unread_count,
         c.last_message_preview,
         c.status,
         c.service_window_expires_at
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.archived_at IS NULL
       ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
       LIMIT $2 OFFSET $3`,
      [this.companyId, limit, offset]
    );

    return result.rows.map((row) => ({
      id: row.id,
      conversationId: String(row.conversation_id),
      stateVersion: row.state_version,
      assignedUserId: row.assigned_user_id == null ? null : String(row.assigned_user_id),
      aiPaused: Boolean(row.ia_paused),
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

    const result = await this.query(
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
    const result = await this.query(
      `SELECT
         id,
         version,
         assigned_user_id,
         ia_paused AND (ia_resume_at IS NULL OR ia_resume_at > NOW()) AS ia_paused,
         service_window_expires_at,
         last_customer_message_at,
         status,
         EXISTS (SELECT 1 FROM conversation_send_claims s WHERE s.tenant_id = conversations.company_id
           AND s.conversation_id = conversations.id AND s.state = 'unknown_delivery') AS has_unresolved_delivery
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
      ...(row && {
        conversationId: String(row.id),
        stateVersion: row.version,
        assignedUserId: row.assigned_user_id == null ? null : String(row.assigned_user_id),
        aiPaused: Boolean(row.ia_paused),
        hasUnresolvedDelivery: row.has_unresolved_delivery,
      }),
      reason: hasActiveSession
        ? 'service_window_open'
        : (row ? 'service_window_closed' : 'conversation_not_found'),
    };
  }

  async listTemplates({ approvedOnly = true } = {}): Promise<Record<string, unknown>[]> {
    const statusFilter = approvedOnly ? `AND UPPER(COALESCE(status, '')) = 'APPROVED'` : '';
    const result = await this.query(
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
      await this.query(
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
    const result = await this.query(
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
    await this.query(
      `UPDATE conversations
       SET unread_count = 0, updated_at = NOW()
       WHERE company_id = $1 AND channel = 'whatsapp' AND external_conversation_id = $2`,
      [this.companyId, normalizedChatId]
    );

    await this.query(
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

  private async upsertContact(client: Queryable, input: { externalContactId: string; phone: string; name: string | null; rawProfile: unknown }): Promise<any> {
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
    client: Queryable,
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
    const result = await this.tenantWork.run(this.companyId, async (client) => {
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
      return { duplicate: false, message: payload };
    });

    if (result.message) await this.emitUpdate(result.message);
    return result;
  }

  async persistStatus({ status, metadata, value }: any): Promise<Record<string, unknown>> {
    return this.tenantWork.run(this.companyId, async (client) => {
      const providerMessageId = status.id;
      const occurredAt = new Date(Number(status.timestamp || Math.floor(Date.now() / 1000)) * 1000);
      if (typeof providerMessageId === 'string') {
        await lockMetaReceipt(client, this.companyId, providerMessageId);
      }
      const legacyKey = `status:${providerMessageId}:${status.status}:${status.timestamp || ''}`;
      const opaque = status.biz_opaque_callback_data;
      const campaignCallback = typeof opaque === 'string' && opaque.startsWith(campaignCallbackPrefix);
      const canonicalCallback = typeof opaque === 'string' && opaque.startsWith('automat:');
      const callbackData = campaignCallback || canonicalCallback ? opaque : null;
      const receiptIdentity = [
        providerMessageId, status.status, status.timestamp ?? null, metadata?.phone_number_id ?? null, status.recipient_id ?? null,
      ];
      if (callbackData) receiptIdentity.push(callbackData);
      const receiptKey = 'status:' + createHash('sha256').update(JSON.stringify(receiptIdentity)).digest('hex');
      const event = await client.query(
        `INSERT INTO whatsapp_webhook_events (
           company_id, provider, phone_number_id, event_type, event_dedupe_key,
           provider_message_id, payload_json
         )
         SELECT $1::integer, 'meta-cloud', $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM whatsapp_webhook_events
           WHERE company_id = $1::integer AND provider = 'meta-cloud' AND event_dedupe_key = $7::varchar
             AND phone_number_id IS NOT DISTINCT FROM $2::varchar
             AND payload_json #>> '{status,recipient_id}' IS NOT DISTINCT FROM $8::text
             AND ($9::text IS NULL OR payload_json #>> '{status,biz_opaque_callback_data}' = $9::text)
         )
         ON CONFLICT (company_id, provider, event_dedupe_key) DO NOTHING
         RETURNING *`,
        [
          this.companyId,
          metadata?.phone_number_id || null,
          `status.${status.status || 'unknown'}`,
          receiptKey,
          providerMessageId,
          json({ status, metadata, value }),
          legacyKey,
          status.recipient_id ?? null,
          callbackData,
        ]
      );
      if (!event.rows[0]) {
        return { duplicate: true };
      }

      const eventId = String(event.rows[0].id);
      if (typeof providerMessageId === 'string' && canonicalCallback) {
        await correlateCanonicalMetaStatus(client, this.companyId, providerMessageId, eventId);
      }
      if (typeof providerMessageId === 'string' && campaignCallback) {
        await applyCampaignMetaReceipt(client, this.companyId, providerMessageId, eventId);
      }
      const canonical = !campaignCallback && typeof providerMessageId === 'string' &&
        await applyCanonicalMetaStatuses(client, this.companyId, providerMessageId, eventId);
      if (!canonical && !campaignCallback) {
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
      }
      await client.query(`UPDATE whatsapp_webhook_events SET processed_at = NOW(), processing_status = 'processed' WHERE id = $1`, [event.rows[0].id]);
      return { duplicate: false };
    });
  }

  async persistOutbound(input: {
    chatId: string;
    body: string | null;
    messageType: string;
    providerMessageId: string | null;
    phoneNumberId?: string;
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
    const { row, payload } = await this.tenantWork.run(this.companyId, async (client) => {
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
          json({ raw: input.raw, metadata: input.phoneNumberId ? { phone_number_id: input.phoneNumberId } : undefined }),
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
      return { row, payload };
    });

    await this.emitUpdate(payload);
    return row;
  }

  async findMediaAttachment(messageId: string): Promise<(MetaMediaAttachment & Record<string, unknown>) | null> {
    const result = await this.query(
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
         m.body,
         ${attachmentPhoneNumber}
       FROM message_attachments a
       JOIN messages m ON m.id = a.message_id
       ${attachmentSendClaim}
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

  async findConversationAttachment(conversationId: number, messageId: number, attachmentId: number): Promise<MetaMediaAttachment | null> {
    const result = await this.query(
      `SELECT a.id AS attachment_id, a.provider_media_id, a.mime_type, a.filename, a.internal_path,
              ${attachmentPhoneNumber}
       FROM message_attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
       ${attachmentSendClaim}
       WHERE c.company_id = $1 AND c.id = $2 AND m.id = $3 AND a.id = $4
         AND m.channel = 'whatsapp' AND m.provider = 'meta-cloud' AND a.provider = 'meta-cloud'`,
      [this.companyId, conversationId, messageId, attachmentId],
    );
    return result.rows[0] ?? null;
  }

  async markMediaDownloaded(input: {
    attachmentId: number;
    internalPath: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
    metadata?: unknown;
  }): Promise<void> {
    await this.query(
      `UPDATE message_attachments a
       SET internal_path = $2,
           mime_type = COALESCE($3, mime_type),
           size_bytes = COALESCE($4, size_bytes),
           sha256 = COALESCE($5, sha256),
           metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb,
           storage_status = 'downloaded',
           downloaded_at = NOW()
       WHERE a.id = $1 AND EXISTS (
         SELECT 1 FROM messages m WHERE m.id = a.message_id AND m.company_id = $7
       )`,
      [
        input.attachmentId,
        input.internalPath,
        input.mimeType || null,
        input.sizeBytes || null,
        input.sha256 || null,
        json(input.metadata || {}),
        this.companyId,
      ]
    );
  }

  private async emitUpdate(payload: unknown): Promise<void> {
    if (!this.io) return;
    try {
      const room = this.io.to(`tenant:${this.companyId}`);
      room.emit('message', payload);
      room.emit('chats-updated', await this.getChats());
    } catch (error) {
      // Persistence already committed. A refresh failure must not trigger a resend.
      console.warn('No se pudo actualizar la bandeja tras persistir el mensaje', {
        code: error instanceof Error ? error.name : 'CHAT_REFRESH_FAILED',
      });
    }
  }
}
