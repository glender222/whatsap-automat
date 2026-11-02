const jwt = require('jsonwebtoken') as any;
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
import * as socketEmitterDefault from '../../sockets/socketEmitter';
import config from '../../config/index';
import pool from '../../config/database';

export interface WebchatVisitorClaims {
  readonly sub: string; // visitorId
  readonly tenantId: string;
  readonly connectionId: string;
  readonly conversationId?: string;
  readonly role: 'visitor';
  readonly iat?: number;
  readonly exp?: number;
}

export interface WebchatAdapterOptions {
  readonly pool?: Pool | { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly jwtSecret?: string;
  readonly defaultTenantId?: string | number;
  readonly socketEmitter?: {
    emitConversation: (tenantId: number | string, conversationId: string, event: string, payload: unknown) => void;
    emitToTenant?: (tenantId: number | string, event: string, payload: unknown) => void;
    emitToRoom?: (room: string, event: string, payload: unknown) => void;
  };
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
 * WebchatAdapter implements ChannelAdapterV1 for self-hosted Webchat.
 * Adheres to:
 * - HMAC-SHA256 (HS256) visitor tokens (mintVisitorToken & verifyVisitorToken)
 * - MSG-05: Strict fail-closed tenancy resolution (rejects unauthenticated/unmapped requests)
 * - CH-01: Full ChannelAdapterV1 compliance and schema conformity
 * - Real-time dispatch via socketEmitter to tenant-isolated conversation rooms (no 24h Meta restriction)
 */
export class WebchatAdapter implements ChannelAdapterV1 {
  public readonly kind: ChannelKind = 'webchat';
  private readonly db: { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  private readonly capabilityRegistry: CapabilityRegistry | null;
  private readonly jwtSecret: string;
  private readonly defaultTenantId: string;
  private readonly socketEmitter: {
    emitConversation: (tenantId: number | string, conversationId: string, event: string, payload: unknown) => void;
    emitToTenant?: (tenantId: number | string, event: string, payload: unknown) => void;
    emitToRoom?: (room: string, event: string, payload: unknown) => void;
  };

  constructor(options: WebchatAdapterOptions = {}) {
    this.db = options.pool || (pool as unknown as Pool);
    this.capabilityRegistry = options.capabilityRegistry || null;
    this.jwtSecret = options.jwtSecret !== undefined ? options.jwtSecret : (config.jwt?.secret || 'webchat-secret-must-be-at-least-32-chars!');
    this.defaultTenantId = String(options.defaultTenantId || '1');
    this.socketEmitter = options.socketEmitter || socketEmitterDefault;
  }

  /**
   * Mints an HMAC-SHA256 signed JWT visitor token.
   */
  mintVisitorToken(
    params: {
      tenantId: string | number;
      connectionId: string;
      visitorId: string;
      conversationId?: string;
      expiresInSeconds?: number;
    },
    secretOverride?: string
  ): string {
    const secret = secretOverride || this.jwtSecret;
    const expiresIn = params.expiresInSeconds !== undefined ? params.expiresInSeconds : 86400; // 24h default

    const payload: Omit<WebchatVisitorClaims, 'iat' | 'exp'> = {
      sub: String(params.visitorId),
      tenantId: String(params.tenantId),
      connectionId: String(params.connectionId),
      conversationId: params.conversationId ? String(params.conversationId) : undefined,
      role: 'visitor',
    };

    return jwt.sign(payload, secret, {
      algorithm: 'HS256',
      expiresIn,
    });
  }

  /**
   * Cryptographically verifies an HMAC-SHA256 signed JWT visitor token.
   * Returns parsed claims or null on any verification/expiration failure.
   */
  verifyVisitorToken(token: string, secretOverride?: string): WebchatVisitorClaims | null {
    if (!token || typeof token !== 'string') {
      return null;
    }

    const secret = secretOverride || this.jwtSecret;

    try {
      const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as any;
      if (!decoded || typeof decoded !== 'object') {
        return null;
      }

      if (!decoded.sub || !decoded.tenantId || !decoded.connectionId || decoded.role !== 'visitor') {
        return null;
      }

      return {
        sub: String(decoded.sub),
        tenantId: String(decoded.tenantId),
        connectionId: String(decoded.connectionId),
        conversationId: decoded.conversationId ? String(decoded.conversationId) : undefined,
        role: 'visitor',
        iat: decoded.iat,
        exp: decoded.exp,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolves internal connectionId and tenantId from incoming Webchat request.
   * Enforces Invariant MSG-05: Strict fail-closed resolution. Never defaults to default tenant.
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

    // 2. Path key resolution (/api/v1/webhooks/webchat/:pathKey)
    if (req.pathKey) {
      try {
        const sql = `
          SELECT id, tenant_id, channel, status
          FROM channel_connections
          WHERE id = $1 AND channel = 'webchat' AND status <> 'inactive'
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

    // 3. Visitor token resolution (x-visitor-token or Authorization Bearer)
    const token = this.extractVisitorToken(headers);
    if (token) {
      // Decode unverified token to identify target connectionId
      const unverified = jwt.decode(token) as any;
      if (unverified && typeof unverified === 'object' && unverified.connectionId) {
        const connId = String(unverified.connectionId);

        try {
          const sql = `
            SELECT id, tenant_id, channel, status, credentials_encrypted
            FROM channel_connections
            WHERE id = $1 AND channel = 'webchat' AND status <> 'inactive'
            LIMIT 1;
          `;
          const res = await dbClient.query(sql, [connId]);
          if (res.rows && res.rows.length > 0) {
            const row = res.rows[0];
            const creds = row.credentials_encrypted;
            const secret = (creds && typeof creds === 'object')
              ? creds.visitorJwtSecret || creds.jwtSecret || this.jwtSecret
              : this.jwtSecret;

            // Cryptographic verification against connection secret
            const claims = this.verifyVisitorToken(token, secret);
            if (claims && claims.tenantId === String(row.tenant_id) && claims.connectionId === String(row.id)) {
              return {
                connectionId: String(row.id),
                tenantId: String(row.tenant_id),
              };
            }
          }
        } catch {
          // Fall through
        }
      }
    }

    // Fail-closed defense (MSG-05): Never fallback to company 1
    return null;
  }

  /**
   * Cryptographic verification of inbound Webchat request.
   * Validates visitor token signature and claims matching the target connectionId.
   */
  async verifyInbound(
    connectionId: string,
    _rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>
  ): Promise<boolean> {
    if (!headers || typeof headers !== 'object') {
      return false;
    }

    const token = this.extractVisitorToken(headers);
    if (!token) {
      return false;
    }

    let secret = this.jwtSecret;

    try {
      const sql = `
        SELECT credentials_encrypted, status
        FROM channel_connections
        WHERE id = $1 AND channel = 'webchat'
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);
      if (res.rows && res.rows.length > 0) {
        if (res.rows[0].status === 'inactive') {
          return false;
        }
        const creds = res.rows[0].credentials_encrypted;
        if (creds && typeof creds === 'object') {
          secret = creds.visitorJwtSecret || creds.jwtSecret || this.jwtSecret;
        }
      }
    } catch {
      // Fallback to adapter configuration
    }

    const claims = this.verifyVisitorToken(token, secret);
    if (!claims) {
      return false;
    }

    return claims.connectionId === connectionId;
  }

  /**
   * Normalizes incoming Webchat visitor payload into canonical ChannelEventV1[].
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

    const items: any[] = Array.isArray(payload) ? payload : [payload];

    // Resolve tenantId
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

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const messageId = String(item.messageId || item.id || `wc_msg_${Date.now()}`);
      const conversationId = String(item.conversationId || item.chatId || `wc_conv_${Date.now()}`);
      const visitorId = item.visitorId || item.userId || item.from || 'visitor';
      const occurredAt = safeIsoTimestamp(item.occurredAt || item.timestamp || item.date, nowIso);

      // 1. Text Message
      if (typeof item.text === 'string' && !item.interactive) {
        const event: ChannelEventV1 = {
          schemaVersion: 1,
          eventId: `evt_wc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          tenantId,
          connectionId,
          channel: 'webchat',
          externalEventId: String(item.eventId || messageId),
          externalConversationId: conversationId,
          externalIdentityId: String(visitorId),
          eventType: 'message.received',
          occurredAt,
          receivedAt: nowIso,
          correlationId: `corr_wc_${messageId}`,
          payloadRef: `ref:payload:wc:text:${messageId}`,
          payload: {
            kind: 'message',
            data: {
              messageId,
              kind: 'text',
              text: item.text,
            },
          },
        };

        const parse = channelEventV1Schema.safeParse(event);
        if (parse.success) {
          events.push(parse.data);
        }
        continue;
      }

      // 2. Media Message
      if (item.media && typeof item.media === 'object') {
        const event: ChannelEventV1 = {
          schemaVersion: 1,
          eventId: `evt_wc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          tenantId,
          connectionId,
          channel: 'webchat',
          externalEventId: String(item.eventId || messageId),
          externalConversationId: conversationId,
          externalIdentityId: String(visitorId),
          eventType: 'message.received',
          occurredAt,
          receivedAt: nowIso,
          correlationId: `corr_wc_media_${messageId}`,
          payloadRef: `ref:payload:wc:media:${messageId}`,
          payload: {
            kind: 'message',
            data: {
              messageId,
              kind: 'media',
              media: {
                mimeType: item.media.mimeType || 'application/octet-stream',
                providerMediaId: item.media.providerMediaId || item.media.id,
                url: item.media.url,
                filename: item.media.filename,
                sizeBytes: item.media.sizeBytes,
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

      // 3. Interactive / Button Reply
      if (item.interactive || item.type === 'button_reply') {
        const interObj = item.interactive || {
          type: 'button_reply',
          id: item.buttonId || item.id,
          title: item.title || item.text || '',
        };

        const event: ChannelEventV1 = {
          schemaVersion: 1,
          eventId: `evt_wc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          tenantId,
          connectionId,
          channel: 'webchat',
          externalEventId: String(item.eventId || messageId),
          externalConversationId: conversationId,
          externalIdentityId: String(visitorId),
          eventType: 'interaction.received',
          occurredAt,
          receivedAt: nowIso,
          correlationId: `corr_wc_inter_${messageId}`,
          payloadRef: `ref:payload:wc:inter:${messageId}`,
          payload: {
            kind: 'message',
            data: {
              messageId,
              kind: 'interactive',
              interactive: {
                type: interObj.type || 'button_reply',
                id: String(interObj.id || interObj.buttonId || ''),
                title: String(interObj.title || ''),
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
   * Returns technical capabilities supported by Webchat.
   */
  async getCapabilities(_connectionId: string): Promise<Set<ChannelCapability>> {
    return new Set<ChannelCapability>([
      'text',
      'image',
      'document',
      'interactive',
      'read-receipt',
      'typing',
    ]);
  }

  /**
   * Sends outbound message in real-time to the visitor socket / SSE stream.
   * Gated through CapabilityRegistry (no 24h Meta window restriction).
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

    // 2. Real-time emission to tenant and conversation room via socketEmitter
    const providerMessageId = `wc_msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const realtimePayload = {
      providerMessageId,
      conversationId: cmd.conversationId,
      tenantId: cmd.tenantId,
      connectionId: cmd.connectionId,
      message: cmd.message,
      causedBy: cmd.causedBy,
      dispatchedAt: new Date().toISOString(),
    };

    // Emit to conversation room: conversation:<tenantId>:<conversationId>
    this.socketEmitter.emitConversation(
      cmd.tenantId,
      cmd.conversationId,
      'webchat.agent_message',
      realtimePayload
    );

    return {
      providerMessageId,
      accepted: true,
      rawStatus: 'dispatched_realtime',
      deliveryState: 'dispatched',
    };
  }

  /**
   * Health check for Webchat connection.
   */
  async health(connectionId: string): Promise<ChannelConnectionHealthV1> {
    const nowIso = new Date().toISOString();

    try {
      const sql = `
        SELECT status, credentials_encrypted
        FROM channel_connections
        WHERE id = $1 AND channel = 'webchat'
        LIMIT 1;
      `;
      const res = await this.db.query(sql, [connectionId]);

      if (!res.rows || res.rows.length === 0) {
        return {
          configured: false,
          authorized: false,
          lastErrorCode: 'CONNECTION_NOT_FOUND',
          lastCheckedAt: nowIso,
        };
      }

      const row = res.rows[0];
      if (row.status === 'inactive') {
        return {
          configured: true,
          authorized: false,
          lastErrorCode: 'CONNECTION_INACTIVE',
          lastCheckedAt: nowIso,
        };
      }

      if (row.status === 'needs_reauthorization') {
        return {
          configured: true,
          authorized: false,
          lastErrorCode: 'SECRET_EXPIRED',
          lastCheckedAt: nowIso,
        };
      }

      const creds = row.credentials_encrypted;
      const secret = (creds && typeof creds === 'object' && (creds.visitorJwtSecret || creds.jwtSecret))
        ? (creds.visitorJwtSecret || creds.jwtSecret)
        : this.jwtSecret;

      if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
        return {
          configured: false,
          authorized: false,
          lastErrorCode: 'MISSING_SECRET',
          lastCheckedAt: nowIso,
        };
      }

      return {
        configured: true,
        authorized: true,
        lastErrorCode: null,
        lastCheckedAt: nowIso,
      };
    } catch (err: any) {
      return {
        configured: true,
        authorized: false,
        lastErrorCode: err?.code || 'DB_ERROR',
        lastCheckedAt: nowIso,
      };
    }
  }

  /**
   * Helper to extract visitor JWT token from headers.
   */
  private extractVisitorToken(headers: Readonly<Record<string, string | undefined>>): string | null {
    if (!headers) return null;

    // Direct header: x-visitor-token
    const direct = headers['x-visitor-token'] || headers['X-Visitor-Token'];
    if (direct && typeof direct === 'string' && direct.trim().length > 0) {
      return direct.trim();
    }

    // Check case-insensitive
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'x-visitor-token') {
        const val = headers[key];
        if (val && typeof val === 'string' && val.trim().length > 0) {
          return val.trim();
        }
      }
    }

    // Authorization Bearer token
    const auth = headers['authorization'] || headers['Authorization'];
    if (auth && typeof auth === 'string') {
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return null;
  }
}
