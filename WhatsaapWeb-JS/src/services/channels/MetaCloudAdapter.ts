import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ChannelAdapterV1,
  InboundConnectionResolutionRequest,
  InboundConnectionResolutionResult,
  ChannelCapability,
  ChannelKind,
  ChannelEventV1,
  SendMessageCommandV1,
  SendMessageResultV1,
  ChannelConnectionHealthV1,
  DeliveryState,
  PublishIntent,
  TechnicalFeatures,
} from '@whatsap-automat/contracts';

import { CapabilityRegistry, PublishGateError } from './CapabilityRegistry';
import { verifyWebhookHmac, verifyAntiReplayTimestamp } from '../../middleware/webhookIdempotency';
import config from '../../config/index';
import pool from '../../config/database';

export interface MetaCloudAdapterOptions {
  readonly kind?: ChannelKind; // Defaults to 'whatsapp-cloud'
  readonly pool?: Pool | { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly appSecret?: string;
  readonly webhookVerifyToken?: string;
  readonly graphVersion?: string;
  readonly fetchFn?: typeof fetch;
  readonly defaultTenantId?: string | number;
}

/**
 * Safely parses any arbitrary input into an ISO 8601 UTC timestamp string.
 * Never throws exceptions (no RangeError or TypeError), guaranteeing fail-safe operation.
 *
 * @param ts - Raw timestamp value (unix epoch in seconds or milliseconds, ISO date string, Date object, or malformed input)
 * @param scale - Scale multiplier applied to numeric timestamps (1000 for seconds -> ms, 1 for milliseconds)
 * @param fallback - Optional fallback ISO string to return on invalid/missing input (defaults to current UTC ISO timestamp)
 * @returns RFC 3339 / ISO 8601 UTC string (e.g. "2026-11-02T02:00:00.000Z")
 */
export function safeIsoTimestamp(
  ts: unknown,
  scale: number = 1000,
  fallback?: string
): string {
  const fallbackIso = typeof fallback === 'string' && fallback.length > 0
    ? fallback
    : new Date().toISOString();

  if (ts === undefined || ts === null || ts === '') {
    return fallbackIso;
  }

  // Guard against non-timestamp primitive types (booleans, symbols, functions)
  if (typeof ts === 'boolean' || typeof ts === 'symbol' || typeof ts === 'function') {
    return fallbackIso;
  }

  // Guard against objects and arrays
  if (typeof ts === 'object') {
    if (ts instanceof Date) {
      return Number.isNaN(ts.getTime()) ? fallbackIso : ts.toISOString();
    }
    return fallbackIso;
  }

  let ms: number;

  if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts <= 0) {
      return fallbackIso;
    }
    // Prevent double scaling if already in epoch milliseconds (>= 1e11 ms corresponds to post-1973; 1e11 s is year 5138)
    if (scale === 1000 && ts >= 1e11) {
      ms = ts;
    } else {
      ms = ts * scale;
    }
  } else if (typeof ts === 'string') {
    const trimmed = ts.trim();
    if (!trimmed) {
      return fallbackIso;
    }
    const num = Number(trimmed);
    if (!Number.isNaN(num)) {
      if (!Number.isFinite(num) || num <= 0) {
        return fallbackIso;
      }
      if (scale === 1000 && num >= 1e11) {
        ms = num;
      } else {
        ms = num * scale;
      }
    } else {
      // Attempt ISO 8601 / RFC 2822 date string parsing
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        ms = parsed;
      } else {
        return fallbackIso;
      }
    }
  } else {
    return fallbackIso;
  }

  // Guard against JavaScript Date integer overflow (max allowable date is +/- 8.64e15 ms)
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    return fallbackIso;
  }

  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString();
  } catch {
    return fallbackIso;
  }
}

export class MetaCloudAdapter implements ChannelAdapterV1 {
  public readonly kind: ChannelKind;
  private readonly db: { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  private readonly capabilityRegistry: CapabilityRegistry | null;
  private readonly appSecret: string;
  private readonly webhookVerifyToken: string;
  private readonly graphVersion: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultTenantId: string;

  constructor(options: MetaCloudAdapterOptions = {}) {
    this.kind = options.kind || 'whatsapp-cloud';
    this.db = options.pool || (pool as unknown as Pool);
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.appSecret = options.appSecret ?? config.meta?.appSecret ?? '';
    this.webhookVerifyToken = options.webhookVerifyToken ?? config.meta?.webhookVerifyToken ?? '';
    this.graphVersion = options.graphVersion ?? config.meta?.graphVersion ?? 'v21.0';
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.defaultTenantId = String(options.defaultTenantId || '1');
  }

  /**
   * 1. Resolves internal connectionId and tenantId from incoming request headers or payload.
   * Enforces Invariant MSG-05: Strict fail-closed resolution. Never defaults to company 1.
   */
  async resolveInboundConnection(
    req: InboundConnectionResolutionRequest,
    queryClient?: { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> }
  ): Promise<InboundConnectionResolutionResult | null> {
    if (!req || typeof req !== 'object') {
      return null;
    }

    const dbClient = queryClient || this.db;
    const headers = (req.headers && typeof req.headers === 'object') ? req.headers : {};

    // Header short-circuit (trusted internal forwarders or test fixtures)
    const headerConnId = headers['x-connection-id'] || headers['X-Connection-Id'];
    const headerTenantId = headers['x-tenant-id'] || headers['X-Tenant-Id'];
    if (headerConnId && headerTenantId) {
      return {
        connectionId: String(headerConnId),
        tenantId: String(headerTenantId),
      };
    }

    // Path key resolution
    if (req.pathKey) {
      try {
        const sql = `
          SELECT id, tenant_id, channel, account_id, status
          FROM channel_connections
          WHERE id = $1 AND status <> 'inactive'
          LIMIT 1;
        `;
        const res = await dbClient.query(sql, [req.pathKey]);
        if (res.rows && res.rows.length > 0) {
          return {
            connectionId: String(res.rows[0].id),
            tenantId: String(res.rows[0].tenant_id),
          };
        }
      } catch {
        // Fall through to body resolution
      }
    }

    if (!req.rawBody || req.rawBody.length === 0) {
      return null;
    }

    let payload: any;
    try {
      const text = Buffer.from(req.rawBody).toString('utf8');
      payload = JSON.parse(text);
    } catch {
      return null;
    }

    if (!payload || typeof payload !== 'object') {
      return null;
    }

    // WhatsApp Cloud API payload detection
    if (payload.object === 'whatsapp_business_account') {
      const phoneNumberId = payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      if (!phoneNumberId) {
        return null;
      }

      try {
        const sql = `
          SELECT id, tenant_id, channel, account_id, status
          FROM channel_connections
          WHERE account_id = $1 AND status <> 'inactive'
          LIMIT 1;
        `;
        const res = await dbClient.query(sql, [String(phoneNumberId)]);
        if (res.rows && res.rows.length > 0) {
          return {
            connectionId: String(res.rows[0].id),
            tenantId: String(res.rows[0].tenant_id),
          };
        }
      } catch {
        // Fall through
      }

      // Invariant MSG-05: Strict fail-closed rejection when account is unmapped
      return null;
    }

    // Instagram Graph API payload detection
    if (payload.object === 'instagram') {
      const igAccountId =
        payload.entry?.[0]?.id ||
        payload.entry?.[0]?.messaging?.[0]?.recipient?.id;
      if (!igAccountId) {
        return null;
      }

      try {
        const sql = `
          SELECT id, tenant_id, channel, account_id, status
          FROM channel_connections
          WHERE account_id = $1 AND status <> 'inactive'
          LIMIT 1;
        `;
        const res = await dbClient.query(sql, [String(igAccountId)]);
        if (res.rows && res.rows.length > 0) {
          return {
            connectionId: String(res.rows[0].id),
            tenantId: String(res.rows[0].tenant_id),
          };
        }
      } catch {
        // Fall through
      }

      // Invariant MSG-05: Strict fail-closed rejection
      return null;
    }

    return null;
  }

  /**
   * 2. Cryptographic HMAC-SHA256 signature and anti-replay verification.
   * Constant-time comparison via crypto.timingSafeEqual and +/- 300s anti-replay window.
   */
  async verifyInbound(
    connectionId: string,
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean> {
    if (!headers || typeof headers !== 'object') {
      return false;
    }

    if (!rawBody || !(rawBody instanceof Uint8Array || Buffer.isBuffer(rawBody))) {
      return false;
    }

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    } catch {
      return false;
    }

    // 2.1 Anti-replay timestamp verification (+/- 300s tolerance)
    const timestampHeader =
      headers['x-timestamp'] ||
      headers['x-hub-timestamp'] ||
      headers['X-Timestamp'] ||
      headers['X-Hub-Timestamp'];
    if (timestampHeader !== undefined && timestampHeader !== '') {
      const replayResult = verifyAntiReplayTimestamp(timestampHeader, 300);
      if (!replayResult.valid) {
        return false;
      }
    }

    // 2.2 HMAC-SHA256 signature verification
    const signatureHeader =
      headers['x-hub-signature-256'] ||
      headers['X-Hub-Signature-256'] ||
      headers['x-hub-signature'] ||
      headers['X-Hub-Signature'];
    if (!signatureHeader) {
      return false;
    }

    // Resolve appSecret from connection or adapter configuration
    let secret = this.appSecret;
    if (!secret && connectionId) {
      try {
        const sql = `
          SELECT credentials_encrypted
          FROM channel_connections
          WHERE id = $1
          LIMIT 1;
        `;
        const res = await this.db.query(sql, [connectionId]);
        if (res.rows && res.rows.length > 0) {
          const creds = res.rows[0].credentials_encrypted;
          if (creds && typeof creds === 'object') {
            secret = creds.appSecret || creds.secret || '';
          }
        }
      } catch {
        // ignore
      }
    }

    if (!secret) {
      secret = config.meta?.appSecret || '';
    }

    if (!secret) {
      return false;
    }

    return verifyWebhookHmac(secret, bodyBuffer, signatureHeader);
  }

  /**
   * 2.3 Webhook challenge verification for GET handshake requests.
   */
  verifyChallenge(
    query: Readonly<Record<string, string | undefined>>,
    connectionVerifyToken?: string
  ): string | null {
    const mode = query['hub.mode'] || query['mode'];
    const token = query['hub.verify_token'] || query['verify_token'];
    const challenge = query['hub.challenge'] || query['challenge'];

    if (mode !== 'subscribe') {
      return null;
    }

    const expectedToken =
      connectionVerifyToken ||
      this.webhookVerifyToken ||
      config.meta?.webhookVerifyToken;

    if (!expectedToken || token !== expectedToken) {
      return null;
    }

    return challenge !== undefined ? String(challenge) : null;
  }

  /**
   * 3. Normalizes incoming WhatsApp and Instagram payloads into canonical ChannelEventV1[].
   */
  async normalizeInbound(connectionId: string, raw: unknown): Promise<ChannelEventV1[]> {
    let body: any = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        return [];
      }
    } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      try {
        body = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        return [];
      }
    }

    if (!body || typeof body !== 'object') {
      return [];
    }

    // Resolve tenantId for this connectionId
    let tenantId = this.defaultTenantId;
    try {
      const sql = `
        SELECT tenant_id
        FROM channel_connections
        WHERE id = $1
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0 && res.rows[0].tenant_id) {
        tenantId = String(res.rows[0].tenant_id);
      }
    } catch {
      // Keep defaultTenantId
    }

    const events: ChannelEventV1[] = [];
    const nowIso = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Case A: WhatsApp Cloud API Payload
    // -------------------------------------------------------------------------
    if (body.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.changes)) continue;
        for (const change of entry.changes) {
          if (!change || typeof change !== 'object' || change.field !== 'messages') continue;
          const value = change.value;
          if (!value || typeof value !== 'object') continue;

          // Inbound messages
          if (Array.isArray(value.messages)) {
            for (const msg of value.messages) {
              if (!msg || typeof msg !== 'object') continue;
              const occurredAt = safeIsoTimestamp(msg.timestamp, 1000, nowIso);
              const msgId = msg.id ? String(msg.id) : crypto.randomUUID();
              const from = msg.from ? String(msg.from) : '';
              const msgType = msg.type || 'text';
              const isInteractive = msgType === 'interactive';

              let payloadData: any;
              if (msgType === 'text') {
                payloadData = {
                  messageId: msgId,
                  kind: 'text',
                  text: (msg.text && typeof msg.text === 'object' && msg.text.body) ? String(msg.text.body) : '',
                };
              } else if (['image', 'audio', 'video', 'document', 'sticker'].includes(msgType)) {
                const mediaObj = (msg[msgType] && typeof msg[msgType] === 'object') ? msg[msgType] : {};
                payloadData = {
                  messageId: msgId,
                  kind: 'media',
                  media: {
                    mimeType: mediaObj.mime_type || (msgType === 'image' ? 'image/jpeg' : 'application/octet-stream'),
                    providerMediaId: mediaObj.id ? String(mediaObj.id) : undefined,
                    sizeBytes: mediaObj.file_size ? Number(mediaObj.file_size) : undefined,
                    filename: mediaObj.filename,
                    url: mediaObj.url,
                  },
                };
              } else if (msgType === 'interactive') {
                const interactive = (msg.interactive && typeof msg.interactive === 'object') ? msg.interactive : {};
                const intType = interactive.type;
                const replyObj = (interactive.button_reply && typeof interactive.button_reply === 'object')
                  ? interactive.button_reply
                  : (interactive.list_reply && typeof interactive.list_reply === 'object')
                  ? interactive.list_reply
                  : {};
                payloadData = {
                  messageId: msgId,
                  kind: 'interactive',
                  interactive: {
                    type: intType === 'list_reply' ? 'list_reply' : 'button_reply',
                    id: replyObj.id || 'unknown_id',
                    title: replyObj.title || 'unknown_title',
                  },
                };
              } else {
                payloadData = {
                  messageId: msgId,
                  kind: 'text',
                  text: '',
                };
              }

              events.push({
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                tenantId,
                connectionId,
                channel: 'whatsapp-cloud',
                externalEventId: msgId,
                externalConversationId: from,
                externalIdentityId: from ? `${from}@s.whatsapp.net` : null,
                eventType: isInteractive ? 'interaction.received' : 'message.received',
                occurredAt,
                receivedAt: nowIso,
                correlationId: `corr_wa_${msgId}`,
                payloadRef: `ref:payload:wa:${msgType}:${msgId}`,
                payload: {
                  kind: 'message',
                  data: payloadData,
                },
              });
            }
          }

          // Inbound delivery status receipts
          if (Array.isArray(value.statuses)) {
            for (const st of value.statuses) {
              if (!st || typeof st !== 'object') continue;
              const occurredAt = safeIsoTimestamp(st.timestamp, 1000, nowIso);
              const statusMap: Record<string, DeliveryState> = {
                sent: 'dispatched',
                delivered: 'delivered',
                read: 'read',
                failed: 'failed',
              };
              const rawStatus = st.status ? String(st.status) : 'dispatched';
              const deliveryState: DeliveryState = statusMap[rawStatus] || 'dispatched';
              const recipientId = st.recipient_id ? String(st.recipient_id) : '';
              const stId = st.id ? String(st.id) : crypto.randomUUID();

              const firstError = Array.isArray(st.errors) && st.errors[0] && typeof st.errors[0] === 'object' ? st.errors[0] : null;
              const errorCode = firstError?.code !== undefined ? String(firstError.code) : undefined;
              const errorMessage = firstError?.title || firstError?.message || undefined;

              events.push({
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                tenantId,
                connectionId,
                channel: 'whatsapp-cloud',
                externalEventId: `status:${stId}:${rawStatus}:${st.timestamp}`,
                externalConversationId: recipientId,
                externalIdentityId: recipientId ? `${recipientId}@s.whatsapp.net` : null,
                eventType: 'message.status',
                occurredAt,
                receivedAt: nowIso,
                correlationId: `corr_status_${stId}`,
                payloadRef: `ref:payload:wa:status:${stId}`,
                payload: {
                  kind: 'status',
                  data: {
                    providerMessageId: stId,
                    status: deliveryState,
                    rawStatus,
                    errorCode,
                    errorMessage,
                    occurredAt,
                  },
                },
              });
            }
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Case B: Instagram Graph API Payload
    // -------------------------------------------------------------------------
    if (body.object === 'instagram' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        if (!entry || typeof entry !== 'object') continue;

        // Direct messages
        if (Array.isArray(entry.messaging)) {
          for (const m of entry.messaging) {
            if (!m || typeof m !== 'object') continue;

            const occurredAt = safeIsoTimestamp(m.timestamp, 1, nowIso);
            const senderId = (m.sender && typeof m.sender === 'object' && m.sender.id) ? String(m.sender.id) : null;
            const recipientId = (m.recipient && typeof m.recipient === 'object' && m.recipient.id) ? String(m.recipient.id) : '';
            const conversationId = senderId || recipientId;

            // Direct message text / media / quick reply
            if (m.message && typeof m.message === 'object') {
              const mid = m.message.mid || crypto.randomUUID();
              if (m.message.quick_reply && typeof m.message.quick_reply === 'object') {
                events.push({
                  schemaVersion: 1,
                  eventId: crypto.randomUUID(),
                  tenantId,
                  connectionId,
                  channel: 'instagram',
                  externalEventId: mid,
                  externalConversationId: conversationId,
                  externalIdentityId: senderId,
                  eventType: 'interaction.received',
                  occurredAt,
                  receivedAt: nowIso,
                  correlationId: `corr_ig_${mid}`,
                  payloadRef: `ref:payload:ig:interactive:${mid}`,
                  payload: {
                    kind: 'message',
                    data: {
                      messageId: mid,
                      kind: 'interactive',
                      interactive: {
                        type: 'quick_reply',
                        id: m.message.quick_reply.payload || 'quick_reply_id',
                        title: m.message.quick_reply.payload || m.message.text || 'quick_reply_title',
                      },
                    },
                  },
                });
              } else if (Array.isArray(m.message.attachments) && m.message.attachments.length > 0) {
                const att = m.message.attachments.find((a: any) => a && typeof a === 'object');
                if (att) {
                  const attType = att.type || '';
                  const mime = attType === 'image' ? 'image/jpeg'
                    : attType === 'video' ? 'video/mp4'
                    : attType === 'audio' ? 'audio/mpeg'
                    : 'application/octet-stream';
                  const attUrl = (att.payload && typeof att.payload === 'object') ? att.payload.url : undefined;
                  events.push({
                    schemaVersion: 1,
                    eventId: crypto.randomUUID(),
                    tenantId,
                    connectionId,
                    channel: 'instagram',
                    externalEventId: mid,
                    externalConversationId: conversationId,
                    externalIdentityId: senderId,
                    eventType: 'message.received',
                    occurredAt,
                    receivedAt: nowIso,
                    correlationId: `corr_ig_${mid}`,
                    payloadRef: `ref:payload:ig:media:${mid}`,
                    payload: {
                      kind: 'message',
                      data: {
                        messageId: mid,
                        kind: 'media',
                        media: {
                          mimeType: mime,
                          url: attUrl,
                        },
                      },
                    },
                  });
                } else {
                  events.push({
                    schemaVersion: 1,
                    eventId: crypto.randomUUID(),
                    tenantId,
                    connectionId,
                    channel: 'instagram',
                    externalEventId: mid,
                    externalConversationId: conversationId,
                    externalIdentityId: senderId,
                    eventType: 'message.received',
                    occurredAt,
                    receivedAt: nowIso,
                    correlationId: `corr_ig_${mid}`,
                    payloadRef: `ref:payload:ig:text:${mid}`,
                    payload: {
                      kind: 'message',
                      data: {
                        messageId: mid,
                        kind: 'text',
                        text: m.message.text || '',
                      },
                    },
                  });
                }
              } else {
                events.push({
                  schemaVersion: 1,
                  eventId: crypto.randomUUID(),
                  tenantId,
                  connectionId,
                  channel: 'instagram',
                  externalEventId: mid,
                  externalConversationId: conversationId,
                  externalIdentityId: senderId,
                  eventType: 'message.received',
                  occurredAt,
                  receivedAt: nowIso,
                  correlationId: `corr_ig_${mid}`,
                  payloadRef: `ref:payload:ig:text:${mid}`,
                  payload: {
                    kind: 'message',
                    data: {
                      messageId: mid,
                      kind: 'text',
                      text: m.message.text || '',
                    },
                  },
                });
              }
            }

            // Delivery receipts
            if (m.delivery && typeof m.delivery === 'object') {
              const rawMids = Array.isArray(m.delivery.mids) ? m.delivery.mids : [crypto.randomUUID()];
              const mids = rawMids.filter((item: any) => item !== null && item !== undefined).map(String);
              if (mids.length === 0) {
                mids.push(crypto.randomUUID());
              }
              const watermarkIso = safeIsoTimestamp(m.delivery.watermark, 1, occurredAt);
              for (const mid of mids) {
                events.push({
                  schemaVersion: 1,
                  eventId: crypto.randomUUID(),
                  tenantId,
                  connectionId,
                  channel: 'instagram',
                  externalEventId: `delivery:${mid}`,
                  externalConversationId: conversationId,
                  externalIdentityId: senderId,
                  eventType: 'message.status',
                  occurredAt: watermarkIso,
                  receivedAt: nowIso,
                  correlationId: `corr_ig_del_${mid}`,
                  payloadRef: `ref:payload:ig:delivery:${mid}`,
                  payload: {
                    kind: 'status',
                    data: {
                      providerMessageId: mid,
                      status: 'delivered',
                      rawStatus: 'delivered',
                      occurredAt: watermarkIso,
                    },
                  },
                });
              }
            }

            // Read receipts
            if (m.read && typeof m.read === 'object') {
              const mid = m.read.mid || 'read_watermark';
              const watermarkIso = safeIsoTimestamp(m.read.watermark, 1, occurredAt);
              events.push({
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                tenantId,
                connectionId,
                channel: 'instagram',
                externalEventId: `read:${mid}:${m.read.watermark}`,
                externalConversationId: conversationId,
                externalIdentityId: senderId,
                eventType: 'message.status',
                occurredAt: watermarkIso,
                receivedAt: nowIso,
                correlationId: `corr_ig_read_${mid}`,
                payloadRef: `ref:payload:ig:read:${mid}`,
                payload: {
                  kind: 'status',
                  data: {
                    providerMessageId: mid,
                    status: 'read',
                    rawStatus: 'read',
                    occurredAt: watermarkIso,
                  },
                },
              });
            }
          }
        }

        // Social Triggers (field: 'comments' and field: 'mentions')
        if (Array.isArray(entry.changes)) {
          for (const ch of entry.changes) {
            if (!ch || typeof ch !== 'object') continue;
            if (ch.field === 'comments') {
              const val = (ch.value && typeof ch.value === 'object') ? ch.value : {};
              const commentId = String(val.id || '');
              const commentOccurredAt = safeIsoTimestamp(val.created_time, 1000, nowIso);
              events.push({
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                tenantId,
                connectionId,
                channel: 'instagram',
                externalEventId: commentId,
                externalConversationId: val.media?.id || commentId,
                externalIdentityId: val.from?.id ? String(val.from.id) : null,
                eventType: 'interaction.received',
                occurredAt: commentOccurredAt,
                receivedAt: nowIso,
                correlationId: `corr_ig_comment_${commentId}`,
                payloadRef: `ref:payload:ig:comment:${commentId}`,
                payload: {
                  kind: 'raw',
                  data: {
                    commentId,
                    text: val.text,
                    from: val.from,
                    mediaId: val.media?.id,
                    parentId: val.parent_id,
                    createdTime: val.created_time,
                  },
                },
              });
            } else if (ch.field === 'mentions') {
              const val = (ch.value && typeof ch.value === 'object') ? ch.value : {};
              const mentionId = String(val.comment_id || val.media_id || crypto.randomUUID());
              events.push({
                schemaVersion: 1,
                eventId: crypto.randomUUID(),
                tenantId,
                connectionId,
                channel: 'instagram',
                externalEventId: mentionId,
                externalConversationId: String(val.media_id || mentionId),
                externalIdentityId: null,
                eventType: 'interaction.received',
                occurredAt: nowIso,
                receivedAt: nowIso,
                correlationId: `corr_ig_mention_${mentionId}`,
                payloadRef: `ref:payload:ig:mention:${mentionId}`,
                payload: {
                  kind: 'raw',
                  data: {
                    mediaId: val.media_id,
                    commentId: val.comment_id,
                  },
                },
              });
            }
          }
        }
      }
    }

    return events;
  }

  /**
   * 4. Returns technical capability set for this adapter kind.
   */
  async getCapabilities(_connectionId: string): Promise<Set<ChannelCapability>> {
    if (this.kind === 'whatsapp-cloud') {
      return new Set<ChannelCapability>([
        'text',
        'image',
        'audio',
        'video',
        'document',
        'template',
        'interactive',
        'read-receipt',
        'typing',
      ]);
    }

    if (this.kind === 'instagram') {
      return new Set<ChannelCapability>([
        'text',
        'image',
        'audio',
        'video',
        'interactive',
        'read-receipt',
      ]);
    }

    return new Set<ChannelCapability>(['text']);
  }

  /**
   * 5. Sends outbound message, gating through CapabilityRegistry and dispatching via Meta Graph API.
   */
  async send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1> {
    // 5.0 Fail-fast parameter validation
    if (cmd.message.kind === 'template') {
      const templateId = cmd.message.templateId;
      if (!templateId || typeof templateId !== 'string' || !templateId.trim()) {
        throw new Error('[MetaCloudAdapter] Outbound message with kind: template requires a non-empty templateId');
      }
    }

    // 5.1 Evaluate Publish Gate via CapabilityRegistry
    if (this.capabilityRegistry) {
      // Strict template classification: only template kind is considered template, preventing spoofing via templateId parameter on text messages
      const isTemplate = cmd.message.kind === 'template';
      let resolvedKind: keyof TechnicalFeatures = 'text';
      if (cmd.message.parameters?.messageKind && typeof cmd.message.parameters.messageKind === 'string') {
        resolvedKind = cmd.message.parameters.messageKind as keyof TechnicalFeatures;
      } else if (cmd.message.kind === 'text') {
        resolvedKind = 'text';
      } else if (cmd.message.kind === 'template') {
        resolvedKind = 'template';
      } else if (cmd.message.kind === 'interactive') {
        resolvedKind = 'interactive';
      } else if (cmd.message.kind === 'media') {
        const mediaType = (cmd.message.parameters?.mediaType as keyof TechnicalFeatures) || 'image';
        resolvedKind = mediaType;
      }

      const intent: PublishIntent = {
        messageKind: resolvedKind,
        isTemplate,
        correlationId: cmd.effectKey,
        recipientCountry: (cmd.message.parameters?.recipientCountry as string) || undefined,
        lastCustomerInteractionAt: (cmd.message.parameters?.lastCustomerInteractionAt as string) || undefined,
      };

      const gateResult = await this.capabilityRegistry.evaluatePublish(
        Number(cmd.tenantId),
        cmd.connectionId,
        intent
      );

      if (!gateResult.permitted) {
        throw new PublishGateError(gateResult);
      }
    }

    // 5.2 Retrieve connection credentials
    let token = '';
    let accountId = '';

    try {
      const sql = `
        SELECT account_id, credentials_encrypted
        FROM channel_connections
        WHERE id = $1
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [cmd.connectionId]);
      if (res.rows && res.rows.length > 0) {
        accountId = res.rows[0].account_id || '';
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          token = creds.accessToken || '';
        }
      }
    } catch {
      // Fallback
    }

    if (!token) {
      token = config.meta?.accessToken || 'test-token';
    }
    if (!accountId) {
      accountId = config.meta?.phoneNumberId || 'test-account';
    }

    // 5.3 Build Graph API payload
    let url = '';
    let body: any = {};

    if (this.kind === 'whatsapp-cloud') {
      url = `https://graph.facebook.com/${this.graphVersion}/${accountId}/messages`;

      if (cmd.message.kind === 'text') {
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cmd.conversationId,
          type: 'text',
          text: { body: cmd.message.text || '' },
        };
      } else if (cmd.message.kind === 'template') {
        const templateName = cmd.message.templateId?.trim();
        if (!templateName) {
          throw new Error('[MetaCloudAdapter] Cannot construct WhatsApp template payload without templateId');
        }
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cmd.conversationId,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: (cmd.message.parameters?.languageCode as string) || 'es_CO',
            },
            components: cmd.message.parameters?.components,
          },
        };
      } else if (cmd.message.kind === 'media') {
        const mediaType = (cmd.message.parameters?.mediaType as string) || 'image';
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cmd.conversationId,
          type: mediaType,
          [mediaType]: {
            id: cmd.message.mediaRef,
            link: cmd.message.parameters?.url,
          },
        };
      } else if (cmd.message.kind === 'interactive') {
        body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cmd.conversationId,
          type: 'interactive',
          interactive: cmd.message.parameters?.interactive,
        };
      }
    } else if (this.kind === 'instagram') {
      url = `https://graph.facebook.com/${this.graphVersion}/${accountId}/messages`;

      const commentId = cmd.message.parameters?.commentId;
      if (commentId) {
        // Comment-to-DM Private Reply
        body = {
          recipient: { comment_id: String(commentId) },
          message: { text: cmd.message.text || '' },
        };
      } else {
        // Standard Direct Message
        body = {
          recipient: { id: cmd.conversationId },
          message: { text: cmd.message.text || '' },
        };
        if (cmd.causedBy?.type === 'human' && cmd.message.parameters?.tag === 'HUMAN_AGENT') {
          body.messaging_type = 'MESSAGE_TAG';
          body.tag = 'HUMAN_AGENT';
        }
      }
    }

    // 5.4 Execute Outbound HTTP Dispatch
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        const providerMessageId =
          json.messages?.[0]?.id ||
          json.message_id ||
          json.id ||
          null;

        return {
          providerMessageId,
          accepted: true,
          rawStatus: 'sent',
          deliveryState: 'dispatched',
        };
      }

      // Non-200 API Response
      const errJson = await res.json().catch(() => ({}));
      const rawMsg = errJson.error?.message || `HTTP ${res.status}`;
      return {
        providerMessageId: null,
        accepted: false,
        rawStatus: rawMsg,
        deliveryState: 'failed',
      };
    } catch (netErr: any) {
      return {
        providerMessageId: null,
        accepted: false,
        rawStatus: netErr?.message || 'network_error',
        deliveryState: 'failed',
      };
    }
  }

  /**
   * 6. Real-time connection health monitoring.
   */
  async health(connectionId: string): Promise<ChannelConnectionHealthV1> {
    const nowIso = new Date().toISOString();
    let token = '';
    let accountId = '';

    try {
      const sql = `
        SELECT account_id, credentials_encrypted
        FROM channel_connections
        WHERE id = $1
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0) {
        accountId = res.rows[0].account_id || '';
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          token = creds.accessToken || '';
        }
      }
    } catch {
      // Fallback
    }

    if (!token) {
      token = config.meta?.accessToken || '';
    }

    if (!token) {
      return {
        configured: false,
        authorized: false,
        lastErrorCode: 'MISSING_CREDENTIALS',
        lastCheckedAt: nowIso,
      };
    }

    let pingUrl = '';
    if (this.kind === 'whatsapp-cloud') {
      const targetId = accountId || config.meta?.phoneNumberId || 'me';
      pingUrl = `https://graph.facebook.com/${this.graphVersion}/${targetId}?fields=id,verified_name`;
    } else {
      pingUrl = `https://graph.facebook.com/${this.graphVersion}/me?fields=id,name`;
    }

    try {
      const res = await this.fetchFn(pingUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        return {
          configured: true,
          authorized: true,
          lastErrorCode: null,
          lastCheckedAt: nowIso,
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          configured: true,
          authorized: false,
          lastErrorCode: 'TOKEN_EXPIRED',
          lastCheckedAt: nowIso,
        };
      }

      return {
        configured: true,
        authorized: false,
        lastErrorCode: `API_ERROR_${res.status}`,
        lastCheckedAt: nowIso,
      };
    } catch (err: any) {
      return {
        configured: true,
        authorized: false,
        lastErrorCode: err?.code || 'NETWORK_ERROR',
        lastCheckedAt: nowIso,
      };
    }
  }
}
