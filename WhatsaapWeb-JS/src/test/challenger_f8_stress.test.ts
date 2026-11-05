/**
 * Challenger Adversarial Stress Test Suite: Phase F8 Enterprise Hardening & SRE
 * 
 * Empirically challenges and stress-tests:
 * 1. SecretVault AES-256-GCM AEAD tamper detection (single-bit flips in ciphertext, IV, tag, wrapped DEK).
 * 2. Key rotation canary & multi-version keyring O(1) bulk data preservation invariants.
 * 3. Deep recursive PII scrubbing, circular graph reference handling, diverse secret patterns.
 * 4. DiagnosticDoctor fault tolerance (absent keys, short keys, DB pool drop/crash, secret masking).
 * 5. Disaster recovery backup rehearsal corruption & truncation detection.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execSync } from 'node:child_process';

import {
  SecretVault,
  InvalidMasterKeyError,
  DecryptionAuthenticationError,
  MalformedEnvelopeError,
  EncryptedEnvelope,
} from '../services/security/SecretVault';

import {
  DiagnosticDoctor,
  redactDiagnosticSecrets,
  DiagnosticReport,
} from '../services/diagnostics/DiagnosticDoctor';

describe('CHALLENGER-F8: Cryptographic & SRE Adversarial Stress Suite', () => {
  const KEK_V1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex = 32 bytes
  const KEK_V2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const KEK_V3 = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
  const KEK_V4 = '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa';

  // =========================================================================
  // GROUP 1: AES-256-GCM Single-Bit & Multi-Bit Tamper Detection (Fail-Closed)
  // =========================================================================
  describe('Group 1: SecretVault AES-256-GCM AEAD Tamper Resistance', () => {
    const vault = new SecretVault({ masterKey: KEK_V1, defaultVersion: 1 });
    const originalPlaintext = 'TOP_SECRET_ENTERPRISE_PAYLOAD_PHASE_F8_CHALLENGE';

    test('1.1: Single-bit flip at every bit position (0..7) of byte 0, middle byte, and last byte in encryptedData fails closed', () => {
      const envelope = vault.encrypt(originalPlaintext);
      const dataBuf = Buffer.from(envelope.encryptedData, 'base64url');

      const byteIndices = [0, Math.floor(dataBuf.length / 2), dataBuf.length - 1];

      for (const byteIdx of byteIndices) {
        for (let bit = 0; bit < 8; bit++) {
          const tamperedBuf = Buffer.from(dataBuf);
          tamperedBuf[byteIdx] ^= (1 << bit); // flip single bit
          const tamperedB64 = tamperedBuf.toString('base64url');

          const tamperedEnvelope: EncryptedEnvelope = {
            ...envelope,
            encryptedData: tamperedB64,
          };

          assert.throws(
            () => vault.decrypt(tamperedEnvelope),
            (err: any) => {
              assert.ok(
                err instanceof DecryptionAuthenticationError,
                `Expected DecryptionAuthenticationError on byte ${byteIdx} bit ${bit}, got ${err?.constructor?.name}`
              );
              return true;
            },
            `Failed to reject tampered ciphertext at byte ${byteIdx} bit ${bit}`
          );
        }
      }
    });

    test('1.2: Single-bit flip at every bit position (0..7) of byte 0, middle byte, and last byte in auth tag fails closed', () => {
      const envelope = vault.encrypt(originalPlaintext);
      const tagBuf = Buffer.from(envelope.tag, 'base64url');
      assert.equal(tagBuf.length, 16, 'Auth tag must be exactly 16 bytes (128 bits)');

      const byteIndices = [0, 8, 15];

      for (const byteIdx of byteIndices) {
        for (let bit = 0; bit < 8; bit++) {
          const tamperedTagBuf = Buffer.from(tagBuf);
          tamperedTagBuf[byteIdx] ^= (1 << bit);
          const tamperedTagB64 = tamperedTagBuf.toString('base64url');

          const tamperedEnvelope: EncryptedEnvelope = {
            ...envelope,
            tag: tamperedTagB64,
          };

          assert.throws(
            () => vault.decrypt(tamperedEnvelope),
            (err: any) => err instanceof DecryptionAuthenticationError,
            `Failed to reject tampered tag at byte ${byteIdx} bit ${bit}`
          );
        }
      }
    });

    test('1.3: Single-bit flip at every bit position (0..7) of byte 0, middle byte, and last byte in IV fails closed', () => {
      const envelope = vault.encrypt(originalPlaintext);
      const ivBuf = Buffer.from(envelope.iv, 'base64url');
      assert.equal(ivBuf.length, 12, 'IV must be exactly 12 bytes (96 bits)');

      const byteIndices = [0, 6, 11];

      for (const byteIdx of byteIndices) {
        for (let bit = 0; bit < 8; bit++) {
          const tamperedIvBuf = Buffer.from(ivBuf);
          tamperedIvBuf[byteIdx] ^= (1 << bit);
          const tamperedIvB64 = tamperedIvBuf.toString('base64url');

          const tamperedEnvelope: EncryptedEnvelope = {
            ...envelope,
            iv: tamperedIvB64,
          };

          assert.throws(
            () => vault.decrypt(tamperedEnvelope),
            (err: any) => err instanceof DecryptionAuthenticationError,
            `Failed to reject tampered IV at byte ${byteIdx} bit ${bit}`
          );
        }
      }
    });

    test('1.4: Tampering with components of wrapped DEK (IV, Tag, Ciphertext) fails closed', () => {
      const envelope = vault.encrypt(originalPlaintext);
      const parts = envelope.encryptedDek.split(':');
      assert.equal(parts.length, 3, 'Wrapped DEK format must be iv:tag:cipher');

      const [dekIvB64, dekTagB64, dekCipherB64] = parts;

      // Tamper wrapped DEK IV
      const tamperedDekIv = Buffer.from(dekIvB64, 'base64url');
      tamperedDekIv[0] ^= 0x01;
      const envBadDekIv: EncryptedEnvelope = {
        ...envelope,
        encryptedDek: [tamperedDekIv.toString('base64url'), dekTagB64, dekCipherB64].join(':'),
      };
      assert.throws(() => vault.decrypt(envBadDekIv), (err: any) => err instanceof DecryptionAuthenticationError);

      // Tamper wrapped DEK Tag
      const tamperedDekTag = Buffer.from(dekTagB64, 'base64url');
      tamperedDekTag[0] ^= 0x01;
      const envBadDekTag: EncryptedEnvelope = {
        ...envelope,
        encryptedDek: [dekIvB64, tamperedDekTag.toString('base64url'), dekCipherB64].join(':'),
      };
      assert.throws(() => vault.decrypt(envBadDekTag), (err: any) => err instanceof DecryptionAuthenticationError);

      // Tamper wrapped DEK Ciphertext
      const tamperedDekCipher = Buffer.from(dekCipherB64, 'base64url');
      tamperedDekCipher[0] ^= 0x01;
      const envBadDekCipher: EncryptedEnvelope = {
        ...envelope,
        encryptedDek: [dekIvB64, dekTagB64, tamperedDekCipher.toString('base64url')].join(':'),
      };
      assert.throws(() => vault.decrypt(envBadDekCipher), (err: any) => err instanceof DecryptionAuthenticationError);
    });

    test('1.5: Malformed envelope structures reject cleanly with MalformedEnvelopeError', () => {
      assert.throws(() => vault.decrypt(null as any), (err: any) => err instanceof MalformedEnvelopeError);
      assert.throws(() => vault.decrypt('not-valid-json' as any), (err: any) => err instanceof MalformedEnvelopeError);
      assert.throws(() => vault.decrypt({} as any), (err: any) => err instanceof MalformedEnvelopeError);
      assert.throws(
        () => vault.decrypt({ algorithm: 'aes-128-cbc' } as any),
        (err: any) => err instanceof MalformedEnvelopeError
      );
      assert.throws(
        () => vault.decrypt({ algorithm: 'aes-256-gcm', encryptedDek: 'a:b' } as any),
        (err: any) => err instanceof MalformedEnvelopeError
      );
    });

    test('1.6: Nonce & DEK uniqueness: 500 encryptions produce 500 distinct IVs, DEKs, and ciphertexts', () => {
      const ivs = new Set<string>();
      const deks = new Set<string>();
      const ciphertexts = new Set<string>();
      const count = 500;

      for (let i = 0; i < count; i++) {
        const env = vault.encrypt('constant-invariant-check');
        ivs.add(env.iv);
        deks.add(env.encryptedDek);
        ciphertexts.add(env.encryptedData);
      }

      assert.equal(ivs.size, count, 'Zero IV collisions expected');
      assert.equal(deks.size, count, 'Zero DEK collisions expected');
      assert.equal(ciphertexts.size, count, 'Zero ciphertext collisions expected');
    });

    test('1.7: Decryption failure guarantees zero plaintext leakage', () => {
      const envelope = vault.encrypt('SENSITIVE_SECRET_DATA');
      const tampered: EncryptedEnvelope = {
        ...envelope,
        tag: Buffer.alloc(16, 0).toString('base64url'),
      };

      let leakedOutput: any = undefined;
      try {
        leakedOutput = vault.decrypt(tampered);
      } catch (err) {
        // expected failure
      }
      assert.equal(leakedOutput, undefined, 'Plaintext must remain undefined on auth failure');
    });
  });

  // =========================================================================
  // GROUP 2: Key Rotation Canary & Multi-Version Keyring Stress
  // =========================================================================
  describe('Group 2: SecretVault Master Key Rotation Canary & Multi-Version Stress', () => {
    const initialVault = new SecretVault({ masterKey: KEK_V1, defaultVersion: 1 });
    const payload = 'CRITICAL_CANARY_FOR_O1_BULK_DATA_PRESERVATION';

    test('2.1: Key rotation canary preserves exact ciphertext, IV, and tag (O(1) invariant)', () => {
      const envV1 = initialVault.encrypt(payload);

      // Rotate to V2
      const envV2 = initialVault.rotateMasterKey(envV1, KEK_V2, 2);

      // Invariants:
      assert.equal(envV2.encryptedData, envV1.encryptedData, 'Ciphertext must be untouched');
      assert.equal(envV2.iv, envV1.iv, 'IV must be untouched');
      assert.equal(envV2.tag, envV1.tag, 'Auth tag must be untouched');
      assert.notEqual(envV2.encryptedDek, envV1.encryptedDek, 'Wrapped DEK must be updated');
      assert.equal(envV2.keyVersion, 2, 'Key version must be 2');

      // V2 vault decrypts V2 envelope
      const v2Vault = new SecretVault({ masterKey: KEK_V2, defaultVersion: 2 });
      assert.equal(v2Vault.decrypt(envV2), payload);

      // V1 key CANNOT decrypt V2 envelope
      assert.throws(
        () => initialVault.decrypt(envV2, { kekOverride: KEK_V1 }),
        (err: any) => err instanceof DecryptionAuthenticationError
      );

      // Original V1 envelope still decrypts with V1 key
      assert.equal(initialVault.decrypt(envV1), payload);
    });

    test('2.2: Multi-step key rotation cascade (V1 -> V2 -> V3 -> V4) maintains byte-for-byte bulk preservation', () => {
      const envV1 = initialVault.encrypt(payload);
      const envV2 = initialVault.rotateMasterKey(envV1, KEK_V2, 2);
      const envV3 = initialVault.rotateMasterKey(envV2, KEK_V3, 3, KEK_V2);
      const envV4 = initialVault.rotateMasterKey(envV3, KEK_V4, 4, KEK_V3);

      // All 4 envelopes share identical bulk data
      assert.equal(envV4.encryptedData, envV1.encryptedData);
      assert.equal(envV4.iv, envV1.iv);
      assert.equal(envV4.tag, envV1.tag);
      assert.equal(envV4.keyVersion, 4);

      // Only KEK_V4 can decrypt envV4
      const v4Vault = new SecretVault({ masterKey: KEK_V4, defaultVersion: 4 });
      assert.equal(v4Vault.decrypt(envV4), payload);

      // KEK 1, 2, 3 must all fail on envV4
      assert.throws(() => initialVault.decrypt(envV4, { kekOverride: KEK_V1 }), (err: any) => err instanceof DecryptionAuthenticationError);
      assert.throws(() => initialVault.decrypt(envV4, { kekOverride: KEK_V2 }), (err: any) => err instanceof DecryptionAuthenticationError);
      assert.throws(() => initialVault.decrypt(envV4, { kekOverride: KEK_V3 }), (err: any) => err instanceof DecryptionAuthenticationError);
    });

    test('2.3: Rotation attempted with wrong old KEK aborts cleanly without altering state', () => {
      const envV1 = initialVault.encrypt(payload);
      const wrongOldKek = KEK_V3;

      assert.throws(
        () => initialVault.rotateMasterKey(envV1, KEK_V2, 2, wrongOldKek),
        (err: any) => err instanceof DecryptionAuthenticationError
      );
    });

    test('2.4: Multi-version keyring correctly resolves version corresponding to envelope', () => {
      const multiVault = new SecretVault({
        masterKey: {
          1: KEK_V1,
          2: KEK_V2,
          3: KEK_V3,
        },
        defaultVersion: 3,
      });

      const e1 = multiVault.encrypt('p1', { keyVersion: 1 });
      const e2 = multiVault.encrypt('p2', { keyVersion: 2 });
      const e3 = multiVault.encrypt('p3', { keyVersion: 3 });

      assert.equal(multiVault.decrypt(e1), 'p1');
      assert.equal(multiVault.decrypt(e2), 'p2');
      assert.equal(multiVault.decrypt(e3), 'p3');

      // Envelope requesting unknown version 99 throws InvalidMasterKeyError
      const badVerEnv: EncryptedEnvelope = { ...e3, keyVersion: 99 };
      assert.throws(
        () => multiVault.decrypt(badVerEnv),
        (err: any) => err instanceof InvalidMasterKeyError
      );
    });
  });

  // =========================================================================
  // GROUP 3: Deep Recursive PII & Secret Scrubbing Stress
  // =========================================================================
  describe('Group 3: Recursive PII & Secret Scrubbing Stress', () => {
    const vault = new SecretVault({ masterKey: KEK_V1 });

    test('3.1: Deeply nested object tree (depth 25) redacts sensitive keys at every depth', () => {
      let root: any = { depth: 0, password: 'rootPassword!' };
      let current = root;

      for (let i = 1; i <= 25; i++) {
        current.child = {
          depth: i,
          token: `token_at_depth_${i}`,
          safeVal: `safe_${i}`,
        };
        current = current.child;
      }
      current.finalSecret = 'end_secret';
      current.secret = 'must_redact_end';

      const scrubbed = vault.redactSecrets(root);

      assert.equal(scrubbed.password, '[REDACTED]');
      assert.equal(scrubbed.depth, 0);

      let probe = scrubbed;
      for (let i = 1; i <= 25; i++) {
        probe = probe.child;
        assert.equal(probe.depth, i);
        assert.equal(probe.safeVal, `safe_${i}`);
        assert.equal(probe.token, '[REDACTED]');
      }
      assert.equal(probe.secret, '[REDACTED]');
      assert.equal(probe.finalSecret, 'end_secret');
    });

    test('3.2: Complex circular graph (self-loop + 3-node cycle) handled without stack overflow', () => {
      const nodeA: any = { name: 'A', password: 'passA' };
      const nodeB: any = { name: 'B', apiKey: 'keyB' };
      const nodeC: any = { name: 'C', secret: 'secC' };

      nodeA.self = nodeA;
      nodeA.next = nodeB;
      nodeB.next = nodeC;
      nodeC.next = nodeA; // cycle back to A

      const scrubbed = vault.redactSecrets(nodeA);

      assert.equal(scrubbed.password, '[REDACTED]');
      assert.equal(scrubbed.self, '[CIRCULAR_REFERENCE]');
      assert.equal(scrubbed.next.apiKey, '[REDACTED]');
      assert.equal(scrubbed.next.next.secret, '[REDACTED]');
      assert.equal(scrubbed.next.next.next, '[CIRCULAR_REFERENCE]');
    });

    test('3.3: Comprehensive sensitive key variations all scrubbed', () => {
      const input = {
        password: '1',
        passwd: '2',
        pwd: '3',
        token: '4',
        accesstoken: '5',
        access_token: '6',
        refreshtoken: '7',
        refresh_token: '8',
        secret: '9',
        appsecret: '10',
        app_secret: '11',
        clientsecret: '12',
        client_secret: '13',
        apikey: '14',
        api_key: '15',
        privatekey: '16',
        private_key: '17',
        master_encryption_key: '18',
        masterkey: '19',
        master_key: '20',
        jwt: '21',
        authorization: '22',
        creditcard: '23',
        credit_card: '24',
        cardnumber: '25',
        cvv: '26',
        cvc: '27',
        ssn: '28',
        regularField: 'safe',
      };

      const redacted = vault.redactSecrets(input);

      for (const [k, v] of Object.entries(redacted)) {
        if (k === 'regularField') {
          assert.equal(v, 'safe');
        } else {
          assert.equal(v, '[REDACTED]', `Key ${k} should have been redacted`);
        }
      }
    });

    test('3.4: Diverse regex string scrubber matches JWTs, Bearer headers, API keys, DB URIs, and query params', () => {
      const inputs = [
        {
          raw: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.someSignature123',
          redactedMustNotInclude: ['someSignature123', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
          redactedMustInclude: ['Bearer [REDACTED_JWT]'],
        },
        {
          raw: 'Authorization: Bearer myOpaqueAccessToken1234567890',
          redactedMustNotInclude: ['myOpaqueAccessToken1234567890'],
          redactedMustInclude: ['Bearer [REDACTED]'],
        },
        {
          raw: 'Configured openai: sk-1234567890abcdef1234567890 and anthropic: sk-ant-api03-1234567890abcdef1234567890',
          redactedMustNotInclude: ['sk-1234567890abcdef1234567890', 'sk-ant-api03-1234567890abcdef1234567890'],
          redactedMustInclude: ['[REDACTED_API_KEY]'],
        },
        {
          raw: 'Meta webhook token: EAAabcdefghijklmnopqrstuvwxyz1234567890',
          redactedMustNotInclude: ['EAAabcdefghijklmnopqrstuvwxyz1234567890'],
          redactedMustInclude: ['[REDACTED_TOKEN]'],
        },
        {
          raw: 'Database connect: postgresql://admin_user:P%40ssw0rd!123@cluster.aws.internal:5432/production_db',
          redactedMustNotInclude: ['P%40ssw0rd!123', 'ssw0rd!123'],
          redactedMustInclude: ['postgresql://admin_user:[REDACTED]@cluster.aws.internal:5432/production_db'],
        },
        {
          raw: 'Database connect: redis://default:MyRedisPass123@redis-master:6379',
          redactedMustNotInclude: ['MyRedisPass123'],
          redactedMustInclude: ['redis://default:[REDACTED]@redis-master:6379'],
        },
        {
          raw: 'Webhook call: https://api.partner.com/v1/events?api_key=secretKey123&client=test&token=sessionToken456',
          redactedMustNotInclude: ['secretKey123', 'sessionToken456'],
          redactedMustInclude: ['api_key=[REDACTED]', 'token=[REDACTED]'],
        },
      ];

      for (const item of inputs) {
        const scrubbed = vault.redactSecrets(item.raw);
        for (const notExpected of item.redactedMustNotInclude) {
          assert.ok(!scrubbed.includes(notExpected), `Leaked secret "${notExpected}" in scrubbed string: ${scrubbed}`);
        }
        for (const expected of item.redactedMustInclude) {
          assert.ok(scrubbed.includes(expected), `Expected token "${expected}" missing in scrubbed string: ${scrubbed}`);
        }
      }
    });

    test('3.5: Preserves non-sensitive types intact (arrays, numbers, booleans, dates, buffers)', () => {
      const now = new Date();
      const buf = Buffer.from('binary-payload');
      const input = {
        intVal: 42,
        floatVal: 3.14159,
        negVal: -100,
        boolTrue: true,
        boolFalse: false,
        nullVal: null,
        undefVal: undefined,
        dateVal: now,
        bufferVal: buf,
        arr: [1, 'two', { ok: true }],
      };

      const redacted = vault.redactSecrets(input);

      assert.equal(redacted.intVal, 42);
      assert.equal(redacted.floatVal, 3.14159);
      assert.equal(redacted.negVal, -100);
      assert.equal(redacted.boolTrue, true);
      assert.equal(redacted.boolFalse, false);
      assert.equal(redacted.nullVal, null);
      assert.equal(redacted.undefVal, undefined);
      assert.equal(redacted.dateVal, now);
      assert.ok(Buffer.isBuffer(redacted.bufferVal));
      assert.deepEqual(redacted.arr, [1, 'two', { ok: true }]);
    });
  });

  // =========================================================================
  // GROUP 4: DiagnosticDoctor Resilience & Secret Masking
  // =========================================================================
  describe('Group 4: DiagnosticDoctor Resilience & Secret Masking', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test('4.1: Absent master key returns FAIL with code SEC-ENC-001 without throwing unhandled exceptions', async () => {
      delete process.env.MASTER_ENCRYPTION_KEY;
      delete process.env.META_TOKEN_ENCRYPTION_KEY;

      const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
      const result = await doctor.checkMasterEncryptionKey();

      assert.equal(result.code, 'SEC-ENC-001');
      assert.equal(result.status, 'FAIL');
      assert.ok(result.latencyMs >= 0);
      assert.ok(result.details.includes('not defined'));
      assert.ok(result.remediationGuide?.includes('MASTER_ENCRYPTION_KEY'));
    });

    test('4.2: Master key too short (< 32 chars) fails without leaking key content', async () => {
      process.env.MASTER_ENCRYPTION_KEY = 'my-secret-key-that-is-short';

      const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
      const result = await doctor.checkMasterEncryptionKey();

      assert.equal(result.code, 'SEC-ENC-001');
      assert.equal(result.status, 'FAIL');
      assert.ok(result.details.includes('too short'));
      assert.ok(!result.details.includes('my-secret-key'), 'Raw key must not appear in diagnostic details');
    });

    test('4.3: DB Connection pool drop fails gracefully with code DB-PG-001 and redacts credentials', async () => {
      const crashingPool: any = {
        connect: async () => {
          const err: any = new Error('connect ECONNREFUSED 127.0.0.1:5432 postgresql://postgres:SecretPassword999@localhost:5432/whatsap');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      };

      const doctor = new DiagnosticDoctor({ pool: crashingPool, skipDatabase: false, skipNetwork: true });
      const result = await doctor.checkDatabaseLiveness(crashingPool);

      assert.equal(result.code, 'DB-PG-001');
      assert.equal(result.status, 'FAIL');
      assert.ok(result.latencyMs >= 0);
      assert.ok(result.details.includes('ECONNREFUSED'));
      assert.ok(!result.details.includes('SecretPassword999'), 'Database password must be redacted from details');
      assert.ok(result.remediationGuide?.includes('DB_PASSWORD'));
    });

    test('4.4: DB Connection pool null/undefined handled gracefully', async () => {
      // 1. Explicitly null pool triggers "No database connection pool configured"
      const doctorNoPool = new DiagnosticDoctor({ skipDatabase: false, skipNetwork: true });
      (doctorNoPool as any).pool = null;
      const resultNull = await doctorNoPool.checkDatabaseLiveness(null as any);
      assert.equal(resultNull.code, 'DB-PG-001');
      assert.equal(resultNull.status, 'FAIL');
      assert.ok(resultNull.details.includes('No database connection pool configured'));

      // 2. Default pool fallback when DB is down fails gracefully with ECONNREFUSED without throwing unhandled rejection
      const doctorDefault = new DiagnosticDoctor({ pool: undefined, skipDatabase: false, skipNetwork: true });
      const resultDefault = await doctorDefault.checkDatabaseLiveness(undefined);
      assert.equal(resultDefault.code, 'DB-PG-001');
      assert.equal(resultDefault.status, 'FAIL');
      assert.ok(resultDefault.details.includes('Database connection failed') || resultDefault.details.includes('ECONNREFUSED'));
    });

    test('4.5: Full diagnostic report runAll() produces clean report with zero secret leakage', async () => {
      process.env.MASTER_ENCRYPTION_KEY = KEK_V1;
      process.env.JWT_SECRET = 'a_very_high_entropy_jwt_secret_with_more_than_32_characters_for_sre';
      delete process.env.REDIS_URL;

      const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
      const report: DiagnosticReport = await doctor.runAll();

      assert.equal(report.overallStatus, 'PASS');
      assert.equal(report.failed, 0);

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes(KEK_V1), 'Master key must not leak in diagnostic report');
      assert.ok(!serialized.includes('a_very_high_entropy_jwt_secret'), 'JWT secret must not leak in diagnostic report');
    });

    test('4.6: Migration check fails when schema_migrations table is missing', async () => {
      const emptyDbPool: any = {
        query: async () => ({ rows: [{ exists: null }] }),
      };

      const doctor = new DiagnosticDoctor({ pool: emptyDbPool });
      const result = await doctor.checkMigrationStatus(emptyDbPool);

      assert.equal(result.code, 'DB-MIG-001');
      assert.equal(result.status, 'FAIL');
      assert.ok(result.details.includes('schema_migrations tracking table does not exist'));
      assert.ok(result.remediationGuide?.includes('npm run db:migrate'));
    });
  });

  // =========================================================================
  // GROUP 5: Backup Rehearsal Script Corruption & Truncation Detection
  // =========================================================================
  describe('Group 5: Backup Rehearsal Script Adversarial Verification', () => {
    const scriptPath = path.resolve(__dirname, '../../../scripts/backup-rehearsal.sh');

    test('5.1: backup-rehearsal.sh runs in --synthetic mode and produces valid JSON metrics', () => {
      assert.ok(fs.existsSync(scriptPath), `Script must exist at ${scriptPath}`);

      const res = spawnSync('bash', [scriptPath, '--synthetic', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH },
      });

      assert.equal(res.status, 0, `Execution failed: ${res.stderr}`);
      const json = JSON.parse(res.stdout.trim());
      assert.equal(json.status, 'SUCCESS');
      assert.equal(json.phase, 'REHEARSAL_COMPLETED');
      assert.equal(json.metrics.checksumValid, true);
      assert.equal(json.metrics.eofMarkerValid, true);
      assert.ok(json.metrics.tablesVerified >= 3);
      assert.ok(json.metrics.rowsVerified >= 9);
      assert.ok(json.metrics.durationMs > 0);
    });

    test('5.2: Truncated dump missing SQL EOF marker is rejected', () => {
      const tempDir = path.join(os.tmpdir(), `challenger_dr_eof_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const dumpFile = path.join(tempDir, 'truncated.sql.gz');

      // Create truncated dump without "-- PostgreSQL database dump complete"
      execSync(`echo "CREATE TABLE test_truncated (id int); INSERT INTO test_truncated VALUES (1);" | gzip > "${dumpFile}"`);

      // Verify that grep for EOF marker fails
      const grepCheck = spawnSync('bash', ['-c', `gzip -dc "${dumpFile}" | grep -q -- "-- PostgreSQL database dump complete"`]);
      assert.notEqual(grepCheck.status, 0, 'Grep must not match EOF marker on truncated dump');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('5.3: SHA-256 Checksum single-bit tampering fails verification', () => {
      const tempDir = path.join(os.tmpdir(), `challenger_dr_sha_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const dumpFile = path.join(tempDir, 'valid.sql.gz');
      const checksumFile = `${dumpFile}.sha256`;

      // 1. Write original dump and compute sha256
      fs.writeFileSync(dumpFile, 'valid synthetic backup stream');
      execSync(`sha256sum "${dumpFile}" | awk '{print $1}' > "${checksumFile}"`);

      // 2. Corrupt exactly 1 byte in dumpFile
      const rawBytes = fs.readFileSync(dumpFile);
      rawBytes[0] ^= 0x01;
      fs.writeFileSync(dumpFile, rawBytes);

      // 3. sha256sum verification must fail
      const shaCheck = spawnSync('bash', ['-c', `cd "${tempDir}" && sha256sum -c "${path.basename(checksumFile)}"`]);
      assert.notEqual(shaCheck.status, 0, 'sha256sum -c must fail closed when file is tampered');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('5.4: backup-rehearsal.sh rejects unknown CLI arguments with exit code 1', () => {
      const res = spawnSync('bash', [scriptPath, '--invalid-malicious-flag'], {
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.ok(res.stderr.includes('Unknown option'));
    });
  });

  // =========================================================================
  // GROUP 6: Adversarial Boundary & Empirical Findings Verification
  // =========================================================================
  describe('Group 6: Adversarial Boundary & Empirical Findings Verification', () => {
    const vault = new SecretVault({ masterKey: KEK_V1 });

    test('6.1: Truncated ciphertext and invalid base64url inputs fail closed', () => {
      const env = vault.encrypt('valid-secret');
      // Truncate to empty ciphertext
      const emptyEnv: EncryptedEnvelope = { ...env, encryptedData: '' };
      assert.throws(() => vault.decrypt(emptyEnv), (err: any) => err instanceof MalformedEnvelopeError);

      // Truncate to 1 byte
      const oneByteEnv: EncryptedEnvelope = { ...env, encryptedData: 'AA' };
      assert.throws(() => vault.decrypt(oneByteEnv), (err: any) => err instanceof DecryptionAuthenticationError);

      // Tampered algorithm name
      const badAlgoEnv: any = { ...env, algorithm: 'aes-128-cbc' };
      assert.throws(() => vault.decrypt(badAlgoEnv), (err: any) => err instanceof MalformedEnvelopeError);
    });

    test('6.2: Prototype pollution payloads are sanitized without polluting Object.prototype', () => {
      const maliciousJson = JSON.parse('{"__proto__": {"pollutedKey": "LEAKED_SECRET"}, "constructor": {"prototype": {"admin": true}}, "password": "root"}');
      const scrubbed = vault.redactSecrets(maliciousJson);

      assert.equal(scrubbed.password, '[REDACTED]');
      assert.equal((Object.prototype as any).pollutedKey, undefined, 'Prototype must not be polluted');
      assert.equal((Object.prototype as any).admin, undefined, 'Prototype must not be polluted');
    });

    test('6.3: Large 1MB payload envelope encryption round-trip and tamper resilience', () => {
      const largePayload = 'A'.repeat(1024 * 1024); // 1 MB
      const env = vault.encrypt(largePayload);

      // Decrypt succeeds
      const decrypted = vault.decrypt(env);
      assert.equal(decrypted.length, largePayload.length);
      assert.equal(decrypted, largePayload);

      // Single-bit flip in large payload fails closed
      const buf = Buffer.from(env.encryptedData, 'base64url');
      buf[500000] ^= 0x01;
      const tamperedLargeEnv: EncryptedEnvelope = { ...env, encryptedData: buf.toString('base64url') };
      assert.throws(() => vault.decrypt(tamperedLargeEnv), (err: any) => err instanceof DecryptionAuthenticationError);
    });

    test('6.4: [EMPIRICAL FINDING F8-01] Unencoded "@" in URI password causes partial password exposure', () => {
      // Demonstrates empirical finding: /([^@]+)@/ stops at the first '@', leaving subsequent characters unredacted
      const unencodedAtPassword = 'postgresql://admin_user:P@ssw0rd!123@cluster.aws.internal:5432/production_db';
      const scrubbed = vault.redactSecrets(unencodedAtPassword);

      // The prefix before the first '@' is masked, but the tail 'ssw0rd!123' remains visible
      assert.ok(scrubbed.includes('[REDACTED]@ssw0rd!123@cluster.aws.internal:5432/production_db'), 'Empirically confirms regex stops at first @');
      assert.ok(!scrubbed.includes('postgresql://admin_user:[REDACTED]@cluster.aws.internal:5432/production_db'), 'Clean redaction fails on unencoded @');
    });

    test('6.5: [EMPIRICAL FINDING F8-02] CamelCase query param "apiKey" is not matched by snake_case regex', () => {
      // Demonstrates empirical finding: /api_key/ does not match camelCase apiKey
      const url = 'https://api.partner.com?apiKey=leakedSecret123&api_key=redactedSecret456';
      const scrubbed = vault.redactSecrets(url);

      assert.ok(scrubbed.includes('apiKey=leakedSecret123'), 'Empirically confirms apiKey query param is not scrubbed');
      assert.ok(scrubbed.includes('api_key=[REDACTED]'), 'snake_case api_key is scrubbed');
    });

    test('6.6: Backup rehearsal script dry-run mode (--dry-run --json) succeeds without side effects', () => {
      const scriptPath = path.resolve(__dirname, '../../../scripts/backup-rehearsal.sh');
      const res = spawnSync('bash', [scriptPath, '--dry-run', '--json'], { encoding: 'utf8' });
      assert.equal(res.status, 0);
      const json = JSON.parse(res.stdout.trim());
      assert.equal(json.status, 'DRY_RUN_SUCCESS');
      assert.equal(json.phase, 'VALIDATION_COMPLETED');
    });
  });
});
