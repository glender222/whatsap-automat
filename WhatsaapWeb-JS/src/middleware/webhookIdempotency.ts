import crypto from 'node:crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createProblemDetails, StandardErrorCode } from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../db/TenantScopedUoW';
import { OutboxRepository, outboxRepository } from '../services/outbox/OutboxRepository';

export interface WebhookIdempotencyOptions {
  secret?: string | (() => string);
  signatureHeader?: string;       // Default: 'x-hub-signature-256'
  timestampHeader?: string;       // Default: 'x-timestamp'
  toleranceSeconds?: number;      // Default: 300s (+/- 5 minutes)
  requireTimestamp?: boolean;     // Default: false (enforced if header present, optional otherwise)
  source?: string;                // Default: 'webhook'
  eventType?: string;             // Default: 'webhook.inbound.received'
  autoRespond?: boolean;          // Default: true (returns 200 directly)
  uow?: TenantScopedUoW;
  outboxRepo?: OutboxRepository;
  extractTenantId?: (req: Request) => Promise<number | null | undefined> | number | null | undefined;
  extractIdempotencyKey?: (req: Request) => string | null | undefined;
}

export interface AntiReplayVerificationResult {
  valid: boolean;
  reason?: string;
  skewSeconds?: number;
}

/**
 * Constant-time HMAC SHA-256 verification using crypto.timingSafeEqual.
 */
export function verifyWebhookHmac(
  secret: string,
  rawBody: Buffer | string,
  signatureHeader?: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const trimmed = signatureHeader.trim();
  const expectedPrefix = 'sha256=';
  const cleanReceivedHex = trimmed.startsWith(expectedPrefix)
    ? trimmed.slice(expectedPrefix.length)
    : trimmed;

  // Hex string should only contain valid hex characters
  if (!/^[0-9a-fA-F]+$/.test(cleanReceivedHex)) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  const computedHex = hmac.digest('hex');

  const computedBuf = Buffer.from(computedHex, 'utf8');
  const receivedBuf = Buffer.from(cleanReceivedHex.toLowerCase(), 'utf8');

  if (computedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}

/**
 * Anti-replay timestamp check verifying request timestamp is within +/- toleranceSeconds.
 */
export function verifyAntiReplayTimestamp(
  timestampHeader?: string | number | null,
  toleranceSeconds: number = 300,
  currentTimestamp?: number
): AntiReplayVerificationResult {
  if (timestampHeader === undefined || timestampHeader === null || timestampHeader === '') {
    return { valid: false, reason: 'Missing timestamp header' };
  }

  let requestEpochMs: number;
  if (typeof timestampHeader === 'number') {
    requestEpochMs = timestampHeader < 1e11 ? timestampHeader * 1000 : timestampHeader;
  } else {
    const trimmed = String(timestampHeader).trim();
    const parsedNum = Number(trimmed);
    if (!Number.isNaN(parsedNum)) {
      requestEpochMs = parsedNum < 1e11 ? parsedNum * 1000 : parsedNum;
    } else {
      requestEpochMs = Date.parse(trimmed);
    }
  }

  if (Number.isNaN(requestEpochMs)) {
    return { valid: false, reason: 'Invalid timestamp format' };
  }

  const now = typeof currentTimestamp === 'number' ? currentTimestamp : Date.now();
  const diffMs = Math.abs(now - requestEpochMs);
  const skewSeconds = diffMs / 1000;

  if (skewSeconds > toleranceSeconds) {
    return {
      valid: false,
      reason: `Timestamp is outside allowable anti-replay window (+/- ${toleranceSeconds}s). Skew: ${skewSeconds.toFixed(1)}s`,
      skewSeconds,
    };
  }

  return { valid: true, skewSeconds };
}

/**
 * Creates Express middleware enforcing HMAC SHA-256 signature, anti-replay window (+/- 300s),
 * and atomic deduplication via idempotency_ledger and processing_outbox.
 */
export function createWebhookIdempotencyMiddleware(
  options: WebhookIdempotencyOptions = {}
): RequestHandler {
  const uow = options.uow || tenantScopedUoW;
  const outboxRepo = options.outboxRepo || outboxRepository;
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const signatureHeaderName = (options.signatureHeader || 'x-hub-signature-256').toLowerCase();
  const timestampHeaderName = (options.timestampHeader || 'x-timestamp').toLowerCase();
  const sourceName = options.source || 'webhook';
  const autoRespond = options.autoRespond !== false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Pass through GET requests (webhook challenge verification)
    if (req.method === 'GET') {
      return next();
    }

    const rawBodyBuffer: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}), 'utf8');

    // 2. Cryptographic HMAC SHA-256 Signature Verification
    const secret = typeof options.secret === 'function' ? options.secret() : options.secret;
    if (secret) {
      const signatureHeader =
        (req.headers[signatureHeaderName] as string | undefined) ||
        (req.headers['x-hub-signature-256'] as string | undefined) ||
        (req.headers['x-signature-256'] as string | undefined);

      if (!signatureHeader || !verifyWebhookHmac(secret, rawBodyBuffer, signatureHeader)) {
        res.status(401).json(
          createProblemDetails({
            code: StandardErrorCode.UNAUTHORIZED,
            title: 'Invalid Webhook Signature',
            detail: 'The provided webhook HMAC signature could not be verified against the configured channel secret.',
            instance: req.originalUrl || req.url,
            correlationId: (req.headers['x-correlation-id'] as string) || 'none',
            metadata: {
              header: signatureHeaderName,
            },
          })
        );
        return;
      }
    }

    // 3. Anti-Replay Timestamp Verification (+/- 300s tolerance)
    const timestampHeader =
      (req.headers[timestampHeaderName] as string | undefined) ||
      (req.headers['x-timestamp'] as string | undefined) ||
      (req.headers['x-hub-timestamp'] as string | undefined) ||
      (req.headers['x-request-timestamp'] as string | undefined);

    if (timestampHeader) {
      const replayCheck = verifyAntiReplayTimestamp(timestampHeader, toleranceSeconds);
      if (!replayCheck.valid) {
        res.status(400).json(
          createProblemDetails({
            code: StandardErrorCode.VALIDATION_ERROR,
            title: 'Timestamp Out of Allowed Replay Window',
            detail: replayCheck.reason || 'Webhook timestamp verification failed.',
            instance: req.originalUrl || req.url,
            correlationId: (req.headers['x-correlation-id'] as string) || 'none',
            metadata: {
              header: timestampHeaderName,
              skewSeconds: replayCheck.skewSeconds,
              toleranceSeconds,
            },
          })
        );
        return;
      }
    } else if (options.requireTimestamp) {
      res.status(400).json(
        createProblemDetails({
          code: StandardErrorCode.VALIDATION_ERROR,
          title: 'Missing Timestamp Header',
          detail: `Mandatory anti-replay timestamp header '${timestampHeaderName}' was not provided.`,
          instance: req.originalUrl || req.url,
          correlationId: (req.headers['x-correlation-id'] as string) || 'none',
        })
      );
      return;
    }

    // 4. Tenancy Resolution
    let tenantId: number | null | undefined = undefined;
    if (options.extractTenantId) {
      tenantId = await options.extractTenantId(req);
    }
    if (!tenantId) {
      tenantId =
        req.tenantId ||
        (req as any).tenant_id ||
        (req as any).user?.company_id ||
        (req as any).whatsappCompanyId ||
        (req.headers['x-tenant-id'] ? Number(req.headers['x-tenant-id']) : undefined) ||
        (req.query?.companyId ? Number(req.query.companyId) : undefined);
    }

    if (!tenantId || isNaN(tenantId) || tenantId <= 0) {
      res.status(403).json(
        createProblemDetails({
          code: StandardErrorCode.POLICY_DENIED,
          title: 'Missing Tenancy Context',
          detail: 'Webhook request lacks resolved tenantId context.',
          instance: req.originalUrl || req.url,
          correlationId: (req.headers['x-correlation-id'] as string) || 'none',
        })
      );
      return;
    }

    // 5. Idempotency Key Resolution
    let idempotencyKey: string | null | undefined = undefined;
    if (options.extractIdempotencyKey) {
      idempotencyKey = options.extractIdempotencyKey(req);
    }
    if (!idempotencyKey) {
      idempotencyKey =
        (req.headers['x-idempotency-key'] as string) ||
        req.body?.idempotencyKey ||
        req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id ||
        (typeof req.body?.id === 'string' && isNaN(Number(req.body.id)) ? req.body.id : undefined) ||
        `hash:${crypto.createHash('sha256').update(rawBodyBuffer).digest('hex')}`;
    }

    const resolvedTenantId = Number(tenantId);
    const resolvedKey = String(idempotencyKey);
    const requestHash = crypto.createHash('sha256').update(rawBodyBuffer).digest('hex');

    // 6. Atomic Deduplication via Idempotency Ledger and Outbox Enqueue inside TenantScopedUoW
    try {
      const outcome = await uow.run(resolvedTenantId, async (client) => {
        // Check if idempotency key already exists in ledger
        const checkSql = `
          SELECT response_status, response_body
          FROM idempotency_ledger
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1;
        `;
        const existing = await client.query(checkSql, [resolvedTenantId, resolvedKey]);

        if (existing.rows && existing.rows.length > 0) {
          const cachedRow = existing.rows[0];
          const cachedBody =
            typeof cachedRow.response_body === 'string'
              ? JSON.parse(cachedRow.response_body)
              : cachedRow.response_body;

          return {
            isDuplicate: true,
            status: Number(cachedRow.response_status || 200),
            body: cachedBody || { success: true, duplicate: true, idempotencyKey: resolvedKey },
          };
        }

        const successBody = {
          success: true,
          status: 'accepted',
          idempotencyKey: resolvedKey,
        };

        // Record into idempotency ledger
        const insertLedgerSql = `
          INSERT INTO idempotency_ledger (
            tenant_id, idempotency_key, source, request_hash, response_status, response_body, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW());
        `;
        await client.query(insertLedgerSql, [
          resolvedTenantId,
          resolvedKey,
          sourceName,
          requestHash,
          200,
          JSON.stringify(successBody),
        ]);

        // Enqueue into processing_outbox
        const outboxRecord = await outboxRepo.enqueue(
          resolvedTenantId,
          {
            eventType: options.eventType || req.body?.eventType || 'webhook.inbound.received',
            correlationId: (req.headers['x-correlation-id'] as string) || resolvedKey,
            idempotencyKey: resolvedKey,
            payload: req.body || {},
          },
          client
        );

        return {
          isDuplicate: false,
          status: 200,
          body: successBody,
          outboxRecord,
        };
      });

      if (autoRespond) {
        res.status(outcome.status).json(outcome.body);
        return;
      }

      // If autoRespond is false, attach metadata and pass to downstream handler
      (req as any).isDuplicateWebhook = outcome.isDuplicate;
      (req as any).idempotencyKey = resolvedKey;
      if (outcome.outboxRecord) {
        (req as any).outboxRecord = outcome.outboxRecord;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export const webhookIdempotency = createWebhookIdempotencyMiddleware;
