import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';
import {
  SecretVault,
  InvalidMasterKeyError,
  DecryptionAuthenticationError,
  MalformedEnvelopeError,
  EncryptedEnvelope,
} from '../services/security/SecretVault';

describe('PR-F8-01: Two-Tier AES-256-GCM Envelope Encryption (SecretVault)', () => {
  const sampleKey32 = '0123456789abcdef0123456789abcdef'; // exactly 32 chars
  const hexKey64 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64 hex chars
  const vault = new SecretVault({ masterKey: sampleKey32, defaultVersion: 1 });

  describe('Suite 1: Keyring & Master Key (KEK) Validation', () => {
    test('1.1: Rejects master keys with fewer than 32 characters or bytes', () => {
      assert.throws(
        () => new SecretVault({ masterKey: 'too-short-key' }),
        (err: any) => err instanceof InvalidMasterKeyError
      );
    });

    test('1.2: Accepts 32-byte Buffer, 64-char Hex string, and multi-version keyrings', () => {
      const bufferKey = crypto.randomBytes(32);
      const vaultBuf = new SecretVault({ masterKey: bufferKey });
      assert.ok(vaultBuf);

      const vaultHex = new SecretVault({ masterKey: hexKey64 });
      assert.ok(vaultHex);

      const multiKeyring = new SecretVault({
        masterKey: {
          1: sampleKey32,
          2: hexKey64,
        },
        defaultVersion: 2,
      });
      assert.ok(multiKeyring);
    });
  });

  describe('Suite 2: Two-Tier Envelope Encryption & Decryption Round-Trip', () => {
    test('2.1: Encrypts plaintext and returns envelope matching specification format', () => {
      const secret = 'sk-meta-super-confidential-token-12345';
      const envelope = vault.encrypt(secret);

      assert.equal(typeof envelope.encryptedDek, 'string');
      assert.equal(typeof envelope.encryptedData, 'string');
      assert.equal(typeof envelope.iv, 'string');
      assert.equal(typeof envelope.tag, 'string');
      assert.equal(envelope.keyVersion, 1);
      assert.equal(envelope.algorithm, 'aes-256-gcm');

      // Ciphertext must never leak plaintext
      assert.ok(!envelope.encryptedData.includes('sk-meta'));
      assert.ok(!envelope.encryptedDek.includes('sk-meta'));

      // Decryption recovers exact original plaintext
      const decrypted = vault.decrypt(envelope);
      assert.equal(decrypted, secret);
    });

    test('2.2: Generates fresh random DEK and IV for identical plaintext (probabilistic cipher)', () => {
      const secret = 'constant-credential-value';
      const env1 = vault.encrypt(secret);
      const env2 = vault.encrypt(secret);

      assert.notEqual(env1.encryptedDek, env2.encryptedDek);
      assert.notEqual(env1.encryptedData, env2.encryptedData);
      assert.notEqual(env1.iv, env2.iv);
      assert.notEqual(env1.tag, env2.tag);

      assert.equal(vault.decrypt(env1), secret);
      assert.equal(vault.decrypt(env2), secret);
    });

    test('2.3: Supports JSON string serialization and deserialization', () => {
      const secret = JSON.stringify({ clientId: 'app_123', clientSecret: 'sec_xyz789' });
      const env = vault.encrypt(secret);
      const json = vault.serializeEnvelope(env);

      assert.equal(typeof json, 'string');
      const recovered = vault.decrypt(json);
      assert.equal(recovered, secret);
    });
  });

  describe('Suite 3: Cryptographic Tamper Detection & AEAD Authentication', () => {
    test('3.1: Rejects tampered ciphertext with DecryptionAuthenticationError', () => {
      const env = vault.encrypt('tamper-test-payload');
      // Flip one character in ciphertext
      const originalData = env.encryptedData;
      const tamperedData = (originalData.startsWith('A') ? 'B' : 'A') + originalData.slice(1);
      const tamperedEnv: EncryptedEnvelope = { ...env, encryptedData: tamperedData };

      assert.throws(
        () => vault.decrypt(tamperedEnv),
        (err: any) => err instanceof DecryptionAuthenticationError
      );
    });

    test('3.2: Rejects tampered authentication tag with DecryptionAuthenticationError', () => {
      const env = vault.encrypt('tamper-tag-payload');
      const tamperedTag = (env.tag.startsWith('X') ? 'Y' : 'X') + env.tag.slice(1);
      const tamperedEnv: EncryptedEnvelope = { ...env, tag: tamperedTag };

      assert.throws(
        () => vault.decrypt(tamperedEnv),
        (err: any) => err instanceof DecryptionAuthenticationError
      );
    });

    test('3.3: Rejects tampered wrapped DEK', () => {
      const env = vault.encrypt('tamper-dek-payload');
      const tamperedDek = env.encryptedDek.slice(0, -4) + 'AAAA';
      const tamperedEnv: EncryptedEnvelope = { ...env, encryptedDek: tamperedDek };

      assert.throws(
        () => vault.decrypt(tamperedEnv),
        (err: any) => err instanceof DecryptionAuthenticationError
      );
    });
  });

  describe('Suite 4: Master Key Rotation (rotateMasterKey) with O(1) Overhead', () => {
    test('4.1: Re-wraps DEK under new master key without decrypting or altering data payload', () => {
      const secret = 'critical-payment-gateway-private-key-rsa';
      const kekV1 = 'key-version-1-initial-master-key-32b';
      const kekV2 = 'key-version-2-rotated-master-key-32b';

      const initialVault = new SecretVault({ masterKey: kekV1, defaultVersion: 1 });
      const originalEnvelope = initialVault.encrypt(secret);

      // Perform key rotation to Version 2
      const rotatedEnvelope = initialVault.rotateMasterKey(originalEnvelope, kekV2, 2);

      // Critical Invariants:
      // 1. Data ciphertext, IV, and auth tag MUST BE IDENTICAL (O(1) payload preservation)
      assert.equal(rotatedEnvelope.encryptedData, originalEnvelope.encryptedData);
      assert.equal(rotatedEnvelope.iv, originalEnvelope.iv);
      assert.equal(rotatedEnvelope.tag, originalEnvelope.tag);

      // 2. Wrapped DEK and keyVersion must be updated
      assert.notEqual(rotatedEnvelope.encryptedDek, originalEnvelope.encryptedDek);
      assert.equal(rotatedEnvelope.keyVersion, 2);

      // 3. Decrypting rotated envelope with new KEK succeeds
      const rotatedVault = new SecretVault({ masterKey: kekV2, defaultVersion: 2 });
      const decryptedWithV2 = rotatedVault.decrypt(rotatedEnvelope);
      assert.equal(decryptedWithV2, secret);

      // 4. Decrypting rotated envelope with old KEK v1 FAILS (no longer valid)
      assert.throws(
        () => initialVault.decrypt(rotatedEnvelope, { kekOverride: kekV1 }),
        (err: any) => err instanceof DecryptionAuthenticationError
      );
    });
  });

  describe('Suite 5: PII & Secret Redaction (redactSecrets)', () => {
    test('5.1: Redacts sensitive object properties recursively', () => {
      const input = {
        user: 'alice',
        password: 'SuperSecretPassword!123',
        auth: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis',
          apiKey: 'sk-abcdef1234567890abcdef1234567890',
          nested: {
            client_secret: 'top-secret-val',
            allowed: true,
          },
        },
      };

      const redacted = vault.redactSecrets(input);

      assert.equal(redacted.user, 'alice');
      assert.equal(redacted.password, '[REDACTED]');
      assert.equal(redacted.auth.token, '[REDACTED]');
      assert.equal(redacted.auth.apiKey, '[REDACTED]');
      assert.equal(redacted.auth.nested.client_secret, '[REDACTED]');
      assert.equal(redacted.auth.nested.allowed, true);
    });

    test('5.2: Redacts embedded JWTs, Bearer headers, and DB connection strings in raw strings', () => {
      const logLine = 'Connected to postgresql://admin:secretPass123@db.prod.internal:5432/whatsapp with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.xyz987';
      const redacted = vault.redactSecrets(logLine);

      assert.ok(!redacted.includes('secretPass123'));
      assert.ok(redacted.includes('postgresql://admin:[REDACTED]@db.prod.internal:5432/whatsapp'));
      assert.ok(redacted.includes('Bearer [REDACTED]'));
    });

    test('5.3: Handles circular references gracefully without call stack overflow', () => {
      const obj: any = { name: 'cyclic' };
      obj.self = obj;

      const redacted = vault.redactSecrets(obj);
      assert.equal(redacted.name, 'cyclic');
      assert.equal(redacted.self, '[CIRCULAR_REFERENCE]');
    });
  });
});
