import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';
import {
  OutboundWebhookSigner,
  InvalidWebhookSecretError,
  ReplayAttackError,
  ClockSkewError,
  WebhookVerificationError,
} from '../services/webhooks/OutboundWebhookSigner';

describe('PR-F7-01: Outbound Webhook HMAC Signer Verification', () => {
  const validSecret = 'super-secret-key-that-is-at-least-32-bytes-long!';
  const samplePayload = JSON.stringify({
    event: 'conversation.created',
    tenantId: '101',
    timestamp: '2026-11-04T22:00:00Z',
  });

  describe('Secret Key Validation (Fail-Closed)', () => {
    test('accepts secrets with >= 32 bytes', () => {
      assert.doesNotThrow(() => OutboundWebhookSigner.validateSecret(validSecret));
    });

    test('rejects secrets shorter than 32 bytes', () => {
      assert.throws(
        () => OutboundWebhookSigner.validateSecret('short-secret-123'),
        InvalidWebhookSecretError
      );
    });

    test('rejects empty or non-string secrets', () => {
      assert.throws(() => OutboundWebhookSigner.validateSecret(''), InvalidWebhookSecretError);
      assert.throws(() => OutboundWebhookSigner.validateSecret(null as any), InvalidWebhookSecretError);
    });
  });

  describe('Signature Generation & Constant-Time Verification', () => {
    test('generates valid headers and verifies successfully', () => {
      const now = Math.floor(Date.now() / 1000);
      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: now,
        eventId: 'evt-test-123',
      });

      assert.equal(headers['Content-Type'], 'application/json');
      assert.equal(headers['X-Automat-Timestamp'], String(now));
      assert.equal(headers['X-Automat-Event-Id'], 'evt-test-123');
      assert.match(headers['X-Automat-Signature'], /^v1=[0-9a-f]{64}$/);

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
      });

      assert.equal(isValid, true);
    });

    test('verifies buffer payloads identically to string payloads', () => {
      const now = Math.floor(Date.now() / 1000);
      const buf = Buffer.from(samplePayload, 'utf8');

      const headers = OutboundWebhookSigner.sign({
        payload: buf,
        secret: validSecret,
        timestamp: now,
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
      });

      assert.equal(isValid, true);
    });

    test('fails verification when payload is tampered', () => {
      const now = Math.floor(Date.now() / 1000);
      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: now,
      });

      const tamperedPayload = JSON.stringify({
        event: 'conversation.created',
        tenantId: '999', // Modified!
        timestamp: '2026-11-04T22:00:00Z',
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: tamperedPayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
      });

      assert.equal(isValid, false);
      assert.throws(
        () =>
          OutboundWebhookSigner.verifyStrict({
            payload: tamperedPayload,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
        WebhookVerificationError
      );
    });

    test('fails verification when secret does not match', () => {
      const now = Math.floor(Date.now() / 1000);
      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: now,
      });

      const wrongSecret = 'another-secret-key-that-is-at-least-32-bytes-long!';
      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: wrongSecret,
        currentTimestamp: now,
      });

      assert.equal(isValid, false);
    });
  });

  describe('Anti-Replay Attack Protection (300-second window)', () => {
    test('accepts webhook timestamp within 300s window', () => {
      const now = 1000000;
      const validPastTimestamp = now - 299; // 299s old

      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: validPastTimestamp,
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
        toleranceSeconds: 300,
      });

      assert.equal(isValid, true);
    });

    test('rejects replay attack with timestamp > 300s old', () => {
      const now = 1000000;
      const replayedTimestamp = now - 301; // 301s old

      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: replayedTimestamp,
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
        toleranceSeconds: 300,
      });

      assert.equal(isValid, false);
      assert.throws(
        () =>
          OutboundWebhookSigner.verifyStrict({
            payload: samplePayload,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
            toleranceSeconds: 300,
          }),
        ReplayAttackError
      );
    });
  });

  describe('Clock Skew Protection (60-second forward window)', () => {
    test('accepts timestamp slightly into the future within 60s', () => {
      const now = 1000000;
      const futureTimestamp = now + 45; // 45s ahead

      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: futureTimestamp,
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
        maxFutureSkewSeconds: 60,
      });

      assert.equal(isValid, true);
    });

    test('rejects timestamp excessively into future (> 60s)', () => {
      const now = 1000000;
      const futureTimestamp = now + 65; // 65s ahead

      const headers = OutboundWebhookSigner.sign({
        payload: samplePayload,
        secret: validSecret,
        timestamp: futureTimestamp,
      });

      const isValid = OutboundWebhookSigner.verify({
        payload: samplePayload,
        signatureHeader: headers['X-Automat-Signature'],
        timestampHeader: headers['X-Automat-Timestamp'],
        secret: validSecret,
        currentTimestamp: now,
        maxFutureSkewSeconds: 60,
      });

      assert.equal(isValid, false);
      assert.throws(
        () =>
          OutboundWebhookSigner.verifyStrict({
            payload: samplePayload,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
            maxFutureSkewSeconds: 60,
          }),
        ClockSkewError
      );
    });
  });
});
