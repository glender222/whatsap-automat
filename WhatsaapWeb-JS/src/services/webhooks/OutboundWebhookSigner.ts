import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-automat-signature';
export const TIMESTAMP_HEADER = 'x-automat-timestamp';
export const EVENT_ID_HEADER = 'x-automat-event-id';

export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes replay window
export const MAX_FUTURE_SKEW_SECONDS = 60; // 1 minute future skew threshold
export const MIN_SECRET_LENGTH_BYTES = 32; // 256 bits fail-closed requirement

export class InvalidWebhookSecretError extends Error {
  constructor(message = 'Webhook secret must be at least 32 bytes (256 bits)') {
    super(message);
    this.name = 'InvalidWebhookSecretError';
  }
}

export class ReplayAttackError extends Error {
  constructor(message = 'Webhook timestamp expired: exceeds 300s replay window') {
    super(message);
    this.name = 'ReplayAttackError';
  }
}

export class ClockSkewError extends Error {
  constructor(message = 'Webhook timestamp is in the future: exceeds 60s clock skew window') {
    super(message);
    this.name = 'ClockSkewError';
  }
}

export class WebhookVerificationError extends Error {
  constructor(message = 'Invalid webhook cryptographic signature') {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface SignWebhookOptions {
  payload: string | Buffer;
  secret: string;
  timestamp?: number;
  eventId?: string;
}

export interface SignedHeaders {
  'Content-Type': 'application/json';
  'X-Automat-Signature': string;
  'X-Automat-Timestamp': string;
  'X-Automat-Event-Id': string;
}

export interface VerifySignatureOptions {
  payload: string | Buffer;
  signatureHeader: string;
  timestampHeader: string | number;
  secret: string;
  toleranceSeconds?: number;
  maxFutureSkewSeconds?: number;
  currentTimestamp?: number;
}

export class OutboundWebhookSigner {
  /**
   * Validates secret key length fails closed on secrets < 32 bytes
   */
  static validateSecret(secret: string): void {
    if (!secret || typeof secret !== 'string') {
      throw new InvalidWebhookSecretError('Webhook secret must be a non-empty string');
    }
    const byteLength = Buffer.byteLength(secret, 'utf8');
    if (byteLength < MIN_SECRET_LENGTH_BYTES) {
      throw new InvalidWebhookSecretError(
        `Webhook secret must be at least ${MIN_SECRET_LENGTH_BYTES} bytes; got ${byteLength} bytes`
      );
    }
  }

  /**
   * Computes the HMAC-SHA256 signature string over `${timestamp}.${rawBody}`
   */
  static computeSignature(payload: string | Buffer, secret: string, timestamp: number): string {
    this.validateSecret(secret);
    const bodyStr = typeof payload === 'string' ? payload : payload.toString('utf8');
    const toSign = `${timestamp}.${bodyStr}`;
    return crypto.createHmac('sha256', secret).update(toSign, 'utf8').digest('hex');
  }

  /**
   * Generates outgoing HTTP headers including X-Automat-Signature, X-Automat-Timestamp, X-Automat-Event-Id
   */
  static sign(options: SignWebhookOptions): SignedHeaders {
    this.validateSecret(options.secret);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const eventId = options.eventId ?? crypto.randomUUID();
    const signature = this.computeSignature(options.payload, options.secret, timestamp);

    return {
      'Content-Type': 'application/json',
      'X-Automat-Signature': `v1=${signature}`,
      'X-Automat-Timestamp': String(timestamp),
      'X-Automat-Event-Id': eventId,
    };
  }

  /**
   * Verifies an incoming/outgoing webhook signature with replay protection and clock skew guards
   * Returns true if valid, false if invalid
   */
  static verify(options: VerifySignatureOptions): boolean {
    try {
      this.verifyStrict(options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Strictly verifies signature, throwing typed errors on replay, clock skew, or tamper
   */
  static verifyStrict(options: VerifySignatureOptions): void {
    this.validateSecret(options.secret);

    if (!options.signatureHeader || !options.timestampHeader) {
      throw new WebhookVerificationError('Missing required signature or timestamp headers');
    }

    const timestamp =
      typeof options.timestampHeader === 'number'
        ? options.timestampHeader
        : parseInt(options.timestampHeader, 10);

    if (isNaN(timestamp)) {
      throw new WebhookVerificationError('Timestamp header is not a valid integer Unix timestamp');
    }

    const now = options.currentTimestamp ?? Math.floor(Date.now() / 1000);
    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const maxFutureSkew = options.maxFutureSkewSeconds ?? MAX_FUTURE_SKEW_SECONDS;

    // Guard 1: Clock skew check (timestamp too far in the future)
    if (timestamp - now > maxFutureSkew) {
      throw new ClockSkewError(
        `Timestamp is in future (${timestamp - now}s ahead), max permitted skew is ${maxFutureSkew}s`
      );
    }

    // Guard 2: Replay check (timestamp too old)
    if (now - timestamp > tolerance) {
      throw new ReplayAttackError(
        `Timestamp expired (${now - timestamp}s old), exceeds tolerance of ${tolerance}s`
      );
    }

    // Extract signature hash from header (supports "v1=<hash>" or "sha256=<hash>" or raw "<hash>")
    let actualHash = options.signatureHeader.trim();
    if (actualHash.startsWith('v1=')) {
      actualHash = actualHash.slice(3);
    } else if (actualHash.startsWith('sha256=')) {
      actualHash = actualHash.slice(7);
    }

    const expectedHash = this.computeSignature(options.payload, options.secret, timestamp);

    const actualBuf = Buffer.from(actualHash, 'utf8');
    const expectedBuf = Buffer.from(expectedHash, 'utf8');

    if (actualBuf.length !== expectedBuf.length) {
      throw new WebhookVerificationError('Signature hash length mismatch');
    }

    if (!crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      throw new WebhookVerificationError('Signature cryptographic verification failed');
    }
  }
}

export default OutboundWebhookSigner;
