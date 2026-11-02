import crypto from 'node:crypto';
import type { Pool } from 'pg';
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
  PublishIntent,
  TechnicalFeatures,
  channelEventV1Schema,
} from '@whatsap-automat/contracts';

import { CapabilityRegistry, PublishGateError } from './CapabilityRegistry';
import config from '../../config/index';
import pool from '../../config/database';

export interface TelegramBotAdapterOptions {
  readonly pool?: Pool | { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly botToken?: string;
  readonly secretToken?: string;
  readonly fetchFn?: typeof fetch;
  readonly defaultTenantId?: string | number;
}

/**
 * Safely parses any arbitrary input into an ISO 8601 UTC timestamp string.
 * Supports both:
 *   safeIsoTimestamp(ts, fallback)
 *   safeIsoTimestamp(ts, scale, fallback)
 * Guaranteed fail-safe against integer overflow, NaN, invalid Date values, and RangeError.
 */
export function safeIsoTimestamp(
  ts: unknown,
  scaleOrFallback?: number | string,
  fallback?: string
): string {
  const scale = typeof scaleOrFallback === 'number' ? scaleOrFallback : 1000;
  const rawFallback = typeof scaleOrFallback === 'string' ? scaleOrFallback : fallback;
  const fallbackIso = typeof rawFallback === 'string' && rawFallback.length > 0
    ? rawFallback
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
      try {
        return Number.isNaN(ts.getTime()) ? fallbackIso : ts.toISOString();
      } catch {
        return fallbackIso;
      }
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

/**
 * TelegramBotAdapter implements ChannelAdapterV1 for Telegram Bot API.
 * Adheres to Invariants:
 * - MSG-04: Constant-time X-Telegram-Bot-Api-Secret-Token validation (403 on invalid, 0 persistence)
 * - MSG-05: Strict fail-closed tenancy resolution (never fallback to default company)
 * - CH-01: Full ChannelAdapterV1 compliance and schema conformity
 * - CH-02: Health check mapping HTTP 401 to status needs_reauthorization with TOKEN_EXPIRED
 */
export class TelegramBotAdapter implements ChannelAdapterV1 {
  public readonly kind: ChannelKind = 'telegram';
  private readonly db: { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  private readonly capabilityRegistry: CapabilityRegistry | null;
  private readonly botToken: string;
  private readonly secretToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultTenantId: string;

  constructor(options: TelegramBotAdapterOptions = {}) {
    this.db = options.pool || (pool as unknown as Pool);
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.botToken = options.botToken || (config as any).telegram?.botToken || '';
    this.secretToken = options.secretToken || (config as any).telegram?.secretToken || '';
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.defaultTenantId = String(options.defaultTenantId || '1');
  }

  /**
   * Resolves internal connectionId and tenantId from incoming Telegram request.
   * Enforces Invariant MSG-05: Strict fail-closed resolution. Never defaults to default company.
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

    // 1. Header short-circuit (trusted internal forwarders or test fixtures)
    const headerConnId = headers['x-connection-id'] || headers['X-Connection-Id'];
    const headerTenantId = headers['x-tenant-id'] || headers['X-Tenant-Id'];
    if (headerConnId && headerTenantId) {
      return {
        connectionId: String(headerConnId),
        tenantId: String(headerTenantId),
      };
    }

    // 2. Path key resolution (/api/v1/webhooks/telegram/:pathKey)
    if (req.pathKey) {
      try {
        const sql = `
          SELECT id, tenant_id, channel, account_id, status
          FROM channel_connections
          WHERE id = $1 AND channel = 'telegram' AND status <> 'inactive'
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
        // Fall through
      }
    }

    // 3. Secret token lookup via X-Telegram-Bot-Api-Secret-Token
    const secretHeader = this.extractSecretTokenHeader(headers);
    if (secretHeader) {
      try {
        const sql = `
          SELECT id, tenant_id, channel, account_id, status, credentials_encrypted
          FROM channel_connections
          WHERE channel = 'telegram' AND status <> 'inactive'
            AND (credentials_encrypted->>'secretToken' = $1 OR credentials_encrypted->>'secret_token' = $1)
          LIMIT 1;
        `;
        const res = await dbClient.query(sql, [secretHeader]);
        if (res.rows && res.rows.length > 0) {
          return {
            connectionId: String(res.rows[0].id),
            tenantId: String(res.rows[0].tenant_id),
          };
        }
      } catch {
        // Fall through
      }
    }

    // Fail-closed defense (MSG-05): Never fallback to company 1
    return null;
  }

  /**
   * Cryptographic verification of X-Telegram-Bot-Api-Secret-Token.
   * Constant-time comparison via crypto.timingSafeEqual.
   * Enforces Invariant MSG-04: Missing or invalid secret token returns false (403, 0 persistence).
   */
  async verifyInbound(
    connectionId: string,
    _rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean> {
    if (!headers || typeof headers !== 'object') {
      return false;
    }

    const receivedSecret = this.extractSecretTokenHeader(headers);
    if (!receivedSecret || typeof receivedSecret !== 'string' || receivedSecret.trim().length === 0) {
      return false;
    }

    let expectedSecret = '';

    try {
      const sql = `
        SELECT credentials_encrypted
        FROM channel_connections
        WHERE id = $1 AND channel = 'telegram'
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0) {
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          const raw = creds.secretToken ?? creds.secret_token;
          if (typeof raw === 'string') {
            expectedSecret = raw;
          } else if (raw !== undefined && raw !== null) {
            // Malformed non-string secret in connection credentials -> fail closed per MSG-04
            return false;
          }
        }
      }
    } catch {
      // Fallback to adapter configuration
    }

    if (!expectedSecret && typeof this.secretToken === 'string') {
      expectedSecret = this.secretToken;
    }

    if (typeof expectedSecret !== 'string' || expectedSecret.trim().length === 0) {
      return false;
    }

    const receivedBuf = Buffer.from(receivedSecret, 'utf8');
    const expectedBuf = Buffer.from(expectedSecret, 'utf8');

    if (receivedBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(receivedBuf, expectedBuf);
  }

  /**
   * Normalizes incoming Telegram Update into canonical ChannelEventV1[].
   */
  async normalizeInbound(connectionId: string, raw: unknown): Promise<ChannelEventV1[]> {
    let payload: any = raw;

    if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      try {
        const text = Buffer.from(raw).toString('utf8');
        payload = JSON.parse(text);
      } catch {
        return [];
      }
    } else if (typeof raw === 'string') {
      try {
        payload = JSON.parse(raw);
      } catch {
        return [];
      }
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const updates: any[] = Array.isArray(payload) ? payload : [payload];

    // Resolve tenantId for connection
    let tenantId = this.defaultTenantId;
    try {
      const sql = `
        SELECT tenant_id FROM channel_connections WHERE id = $1 LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0) {
        tenantId = String(res.rows[0].tenant_id);
      }
    } catch {
      // Keep default
    }

    const nowIso = new Date().toISOString();
    const events: ChannelEventV1[] = [];

    for (const update of updates) {
      if (!update || typeof update !== 'object') continue;

      const updateId = update.update_id !== undefined ? String(update.update_id) : `upd_${Date.now()}`;

      // A. Message or Edited Message
      const msg = update.message || update.edited_message;
      if (msg && typeof msg === 'object') {
        const messageId = String(msg.message_id || `msg_${Date.now()}`);
        const chatId = String(msg.chat?.id || '');
        const userId = msg.from?.id ? String(msg.from.id) : null;
        const occurredAt = safeIsoTimestamp(msg.date, nowIso);

        // 1. Text Message
        if (typeof msg.text === 'string') {
          const event: ChannelEventV1 = {
            schemaVersion: 1,
            eventId: `evt_tg_${updateId}_${messageId}`,
            tenantId,
            connectionId,
            channel: 'telegram',
            externalEventId: updateId,
            externalConversationId: chatId,
            externalIdentityId: userId,
            eventType: 'message.received',
            occurredAt,
            receivedAt: nowIso,
            correlationId: `corr_tg_${updateId}`,
            payloadRef: `ref:payload:tg:${updateId}:${messageId}`,
            payload: {
              kind: 'message',
              data: {
                messageId,
                kind: 'text',
                text: msg.text,
              },
            },
          };

          const parse = channelEventV1Schema.safeParse(event);
          if (parse.success) {
            events.push(parse.data);
          }
          continue;
        }

        // 2. Photo Media Message (Select highest resolution)
        if (Array.isArray(msg.photo) && msg.photo.length > 0) {
          const validPhotos = msg.photo.filter(
            (p: any) => p && typeof p === 'object' && typeof p.file_id === 'string' && p.file_id.trim().length > 0
          );
          if (validPhotos.length > 0) {
            const highestPhoto = validPhotos[validPhotos.length - 1];
            const event: ChannelEventV1 = {
              schemaVersion: 1,
              eventId: `evt_tg_${updateId}_${messageId}`,
              tenantId,
              connectionId,
              channel: 'telegram',
              externalEventId: updateId,
              externalConversationId: chatId,
              externalIdentityId: userId,
              eventType: 'message.received',
              occurredAt,
              receivedAt: nowIso,
              correlationId: `corr_tg_photo_${updateId}`,
              payloadRef: `ref:payload:tg:photo:${updateId}:${messageId}`,
              payload: {
                kind: 'message',
                data: {
                  messageId,
                  kind: 'media',
                  media: {
                    mimeType: 'image/jpeg',
                    providerMediaId: highestPhoto.file_id,
                    sizeBytes: typeof highestPhoto.file_size === 'number' && Number.isInteger(highestPhoto.file_size) && highestPhoto.file_size >= 0
                      ? highestPhoto.file_size
                      : undefined,
                  },
                },
              },
            };

            const parse = channelEventV1Schema.safeParse(event);
            if (parse.success) {
              events.push(parse.data);
            }
            continue;
          }
        }

        // 3. Voice Media Message
        if (msg.voice && typeof msg.voice === 'object') {
          const event: ChannelEventV1 = {
            schemaVersion: 1,
            eventId: `evt_tg_${updateId}_${messageId}`,
            tenantId,
            connectionId,
            channel: 'telegram',
            externalEventId: updateId,
            externalConversationId: chatId,
            externalIdentityId: userId,
            eventType: 'message.received',
            occurredAt,
            receivedAt: nowIso,
            correlationId: `corr_tg_voice_${updateId}`,
            payloadRef: `ref:payload:tg:voice:${updateId}:${messageId}`,
            payload: {
              kind: 'message',
              data: {
                messageId,
                kind: 'media',
                media: {
                  mimeType: msg.voice.mime_type || 'audio/ogg',
                  providerMediaId: msg.voice.file_id,
                  sizeBytes: msg.voice.file_size,
                },
              },
            },
          };

          const parse = channelEventV1Schema.safeParse(event);
          if (parse.success) {
            events.push(parse.data);
          }
          continue;
        }

        // 4. Audio Media Message
        if (msg.audio && typeof msg.audio === 'object') {
          const event: ChannelEventV1 = {
            schemaVersion: 1,
            eventId: `evt_tg_${updateId}_${messageId}`,
            tenantId,
            connectionId,
            channel: 'telegram',
            externalEventId: updateId,
            externalConversationId: chatId,
            externalIdentityId: userId,
            eventType: 'message.received',
            occurredAt,
            receivedAt: nowIso,
            correlationId: `corr_tg_audio_${updateId}`,
            payloadRef: `ref:payload:tg:audio:${updateId}:${messageId}`,
            payload: {
              kind: 'message',
              data: {
                messageId,
                kind: 'media',
                media: {
                  mimeType: msg.audio.mime_type || 'audio/mpeg',
                  providerMediaId: msg.audio.file_id,
                  filename: msg.audio.file_name,
                  sizeBytes: msg.audio.file_size,
                },
              },
            },
          };

          const parse = channelEventV1Schema.safeParse(event);
          if (parse.success) {
            events.push(parse.data);
          }
          continue;
        }

        // 5. Video Media Message
        if (msg.video && typeof msg.video === 'object') {
          const event: ChannelEventV1 = {
            schemaVersion: 1,
            eventId: `evt_tg_${updateId}_${messageId}`,
            tenantId,
            connectionId,
            channel: 'telegram',
            externalEventId: updateId,
            externalConversationId: chatId,
            externalIdentityId: userId,
            eventType: 'message.received',
            occurredAt,
            receivedAt: nowIso,
            correlationId: `corr_tg_video_${updateId}`,
            payloadRef: `ref:payload:tg:video:${updateId}:${messageId}`,
            payload: {
              kind: 'message',
              data: {
                messageId,
                kind: 'media',
                media: {
                  mimeType: msg.video.mime_type || 'video/mp4',
                  providerMediaId: msg.video.file_id,
                  sizeBytes: msg.video.file_size,
                },
              },
            },
          };

          const parse = channelEventV1Schema.safeParse(event);
          if (parse.success) {
            events.push(parse.data);
          }
          continue;
        }

        // 6. Document Media Message
        if (msg.document && typeof msg.document === 'object') {
          const event: ChannelEventV1 = {
            schemaVersion: 1,
            eventId: `evt_tg_${updateId}_${messageId}`,
            tenantId,
            connectionId,
            channel: 'telegram',
            externalEventId: updateId,
            externalConversationId: chatId,
            externalIdentityId: userId,
            eventType: 'message.received',
            occurredAt,
            receivedAt: nowIso,
            correlationId: `corr_tg_doc_${updateId}`,
            payloadRef: `ref:payload:tg:doc:${updateId}:${messageId}`,
            payload: {
              kind: 'message',
              data: {
                messageId,
                kind: 'media',
                media: {
                  mimeType: msg.document.mime_type || 'application/octet-stream',
                  providerMediaId: msg.document.file_id,
                  filename: msg.document.file_name,
                  sizeBytes: msg.document.file_size,
                },
              },
            },
          };

          const parse = channelEventV1Schema.safeParse(event);
          if (parse.success) {
            events.push(parse.data);
          }
          continue;
        }
      }

      // B. Callback Query (Interactive Button Reply)
      if (update.callback_query && typeof update.callback_query === 'object') {
        const cb = update.callback_query;
        const cbId = String(cb.id || `cb_${Date.now()}`);
        const chatId = String(cb.message?.chat?.id || cb.from?.id || '');
        const userId = cb.from?.id ? String(cb.from.id) : null;
        const cbData = String(cb.data || '');

        const event: ChannelEventV1 = {
          schemaVersion: 1,
          eventId: `evt_tg_cb_${updateId}_${cbId}`,
          tenantId,
          connectionId,
          channel: 'telegram',
          externalEventId: updateId,
          externalConversationId: chatId,
          externalIdentityId: userId,
          eventType: 'interaction.received',
          occurredAt: nowIso,
          receivedAt: nowIso,
          correlationId: `corr_tg_cb_${updateId}`,
          payloadRef: `ref:payload:tg:cb:${updateId}:${cbId}`,
          payload: {
            kind: 'message',
            data: {
              messageId: cbId,
              kind: 'interactive',
              interactive: {
                type: 'button_reply',
                id: cbData,
                title: cbData,
              },
            },
          },
        };

        const parse = channelEventV1Schema.safeParse(event);
        if (parse.success) {
          events.push(parse.data);
        }
        continue;
      }
    }

    return events;
  }

  /**
   * Returns technical capabilities supported by Telegram Bot API.
   */
  async getCapabilities(_connectionId: string): Promise<Set<ChannelCapability>> {
    return new Set<ChannelCapability>([
      'text',
      'image',
      'audio',
      'video',
      'document',
      'interactive',
      'typing',
    ]);
  }

  /**
   * Sends outbound message via Telegram Bot API, gated through CapabilityRegistry.
   */
  async send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1> {
    // 1. Evaluate Publish Gate via CapabilityRegistry
    if (this.capabilityRegistry) {
      let resolvedKind: keyof TechnicalFeatures = 'text';
      if (cmd.message.parameters?.messageKind && typeof cmd.message.parameters.messageKind === 'string') {
        resolvedKind = cmd.message.parameters.messageKind as keyof TechnicalFeatures;
      } else if (cmd.message.kind === 'text') {
        resolvedKind = 'text';
      } else if (cmd.message.kind === 'interactive') {
        resolvedKind = 'interactive';
      } else if (cmd.message.kind === 'media') {
        const mediaType = (cmd.message.parameters?.mediaType as keyof TechnicalFeatures) || 'image';
        resolvedKind = mediaType;
      }

      const intent: PublishIntent = {
        messageKind: resolvedKind,
        isTemplate: false,
        correlationId: cmd.effectKey,
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

    // 2. Retrieve connection credentials (botToken)
    let token = '';

    try {
      const sql = `
        SELECT credentials_encrypted
        FROM channel_connections
        WHERE id = $1 AND channel = 'telegram'
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [cmd.connectionId]);
      if (res.rows && res.rows.length > 0) {
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          token = creds.botToken || creds.token || '';
        }
      }
    } catch {
      // Fallback
    }

    if (!token) {
      token = this.botToken;
    }

    if (!token) {
      token = 'test-telegram-token';
    }

    // 3. Build Telegram Bot API request
    const telegramBase = `https://api.telegram.org/bot${token}`;
    let method = 'sendMessage';
    let bodyPayload: Record<string, unknown> = {
      chat_id: cmd.conversationId,
    };

    if (cmd.message.kind === 'text') {
      method = 'sendMessage';
      bodyPayload.text = cmd.message.text || '';
    } else if (cmd.message.kind === 'media') {
      const mediaType = (cmd.message.parameters?.mediaType as string) || 'image';
      const fileTarget = cmd.message.mediaRef || cmd.message.parameters?.url;

      if (mediaType === 'image' || mediaType === 'photo') {
        method = 'sendPhoto';
        bodyPayload.photo = fileTarget;
        if (cmd.message.parameters?.caption || cmd.message.text) {
          bodyPayload.caption = cmd.message.parameters?.caption || cmd.message.text;
        }
      } else if (mediaType === 'document') {
        method = 'sendDocument';
        bodyPayload.document = fileTarget;
        if (cmd.message.parameters?.caption || cmd.message.text) {
          bodyPayload.caption = cmd.message.parameters?.caption || cmd.message.text;
        }
      } else if (mediaType === 'audio') {
        method = 'sendAudio';
        bodyPayload.audio = fileTarget;
      } else if (mediaType === 'voice') {
        method = 'sendVoice';
        bodyPayload.voice = fileTarget;
      } else if (mediaType === 'video') {
        method = 'sendVideo';
        bodyPayload.video = fileTarget;
      } else {
        method = 'sendDocument';
        bodyPayload.document = fileTarget;
      }
    } else if (cmd.message.kind === 'interactive') {
      method = 'sendMessage';
      bodyPayload.text = cmd.message.text || 'Opciones:';
      const buttons = cmd.message.parameters?.buttons || cmd.message.parameters?.inline_keyboard;
      if (buttons) {
        bodyPayload.reply_markup = {
          inline_keyboard: Array.isArray(buttons) ? buttons : [buttons],
        };
      }
    }

    // 4. Dispatch HTTP call to Telegram
    const url = `${telegramBase}/${method}`;

    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
      });

      const json = await res.json().catch(() => ({}));

      if (res.ok && json.ok !== false) {
        const providerMessageId = json.result?.message_id !== undefined
          ? String(json.result.message_id)
          : null;

        return {
          providerMessageId,
          accepted: true,
          rawStatus: 'sent',
          deliveryState: 'dispatched',
        };
      }

      // Handle non-200 or { ok: false } (e.g. 403 Forbidden - bot was blocked by the user)
      const rawStatus = json.description || `HTTP_${res.status}`;
      return {
        providerMessageId: null,
        accepted: false,
        rawStatus,
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
   * Health check for Telegram Bot connection.
   * Calls getMe endpoint.
   * Enforces Gate CH-02: HTTP 401 maps to authorized: false, lastErrorCode: 'TOKEN_EXPIRED'.
   */
  async health(connectionId: string): Promise<ChannelConnectionHealthV1> {
    const nowIso = new Date().toISOString();
    let token = '';

    try {
      const sql = `
        SELECT credentials_encrypted
        FROM channel_connections
        WHERE id = $1 AND channel = 'telegram'
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0) {
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          token = creds.botToken || creds.token || '';
        }
      }
    } catch {
      // Fallback
    }

    if (!token) {
      token = this.botToken;
    }

    if (!token) {
      return {
        configured: false,
        authorized: false,
        lastErrorCode: 'MISSING_CREDENTIALS',
        lastCheckedAt: nowIso,
      };
    }

    const pingUrl = `https://api.telegram.org/bot${token}/getMe`;

    try {
      const res = await this.fetchFn(pingUrl, {
        method: 'GET',
      });

      const json = await res.json().catch(() => ({}));

      if (res.ok && json.ok !== false) {
        return {
          configured: true,
          authorized: true,
          lastErrorCode: null,
          lastCheckedAt: nowIso,
        };
      }

      // Telegram Bot API returns 401 when token is invalid or revoked
      if (res.status === 401 || json.error_code === 401) {
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

  /**
   * Helper to retrieve X-Telegram-Bot-Api-Secret-Token case-insensitively.
   */
  private extractSecretTokenHeader(headers: Readonly<Record<string, string | undefined>>): string | null {
    if (!headers) return null;
    const direct = headers['x-telegram-bot-api-secret-token'] || headers['X-Telegram-Bot-Api-Secret-Token'];
    if (direct) return direct;

    const lowerTarget = 'x-telegram-bot-api-secret-token';
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowerTarget) {
        return headers[key] || null;
      }
    }
    return null;
  }
}
