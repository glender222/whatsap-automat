import crypto from 'node:crypto';
import config from '../../config/index';

/**
 * Standard Envelope Format for AES-256-GCM Two-Tier Encryption
 * Specification: Phase F8 (SEC-006, SEC-011, ADR-013, ADR-021)
 */
export interface EncryptedEnvelope {
  /**
   * Data Encryption Key (DEK) wrapped by Master Key (KEK).
   * Format: `${dekIv}:${dekTag}:${wrappedDekCipher}` in base64url encoding.
   */
  readonly encryptedDek: string;

  /**
   * Secret ciphertext encrypted by the ephemeral DEK.
   */
  readonly encryptedData: string;

  /**
   * 12-byte initialization vector used for encryptedData (base64url).
   */
  readonly iv: string;

  /**
   * 16-byte authentication tag verifying integrity of encryptedData (base64url).
   */
  readonly tag: string;

  /**
   * Master key version used to wrap the DEK (enables multi-key rotation).
   */
  readonly keyVersion: number;

  /**
   * Authenticated encryption algorithm.
   */
  readonly algorithm: 'aes-256-gcm';
}

export class InvalidMasterKeyError extends Error {
  readonly code = 'INVALID_MASTER_KEY';
  constructor(message = 'MASTER_ENCRYPTION_KEY must be at least 32 characters or a 32-byte Buffer') {
    super(message);
    this.name = 'InvalidMasterKeyError';
  }
}

export class DecryptionAuthenticationError extends Error {
  readonly code = 'DECRYPTION_AUTH_FAILED';
  constructor(message = 'AEAD authentication failed: ciphertext, IV, tag, or wrapped DEK has been tampered with') {
    super(message);
    this.name = 'DecryptionAuthenticationError';
  }
}

export class MalformedEnvelopeError extends Error {
  readonly code = 'MALFORMED_ENVELOPE';
  constructor(message = 'Payload is not a valid AES-256-GCM encrypted envelope') {
    super(message);
    this.name = 'MalformedEnvelopeError';
  }
}

export interface SecretVaultOptions {
  /**
   * Primary Master Key (KEK) or Keyring map indexed by version number.
   * If omitted, falls back to process.env.MASTER_ENCRYPTION_KEY or config.security.tokenEncryptionKey.
   */
  masterKey?: string | Buffer | Record<number, string | Buffer>;

  /**
   * Default key version to apply for new encryptions (default: 1).
   */
  defaultVersion?: number;
}

export class SecretVault {
  private readonly keyring: Map<number, Buffer> = new Map();
  private defaultVersion: number;
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // 96 bits recommended for GCM
  private static readonly TAG_LENGTH = 16; // 128 bits auth tag
  private static readonly DEK_LENGTH = 32; // 256-bit key

  constructor(options: SecretVaultOptions = {}) {
    const defaultVer = options.defaultVersion ?? 1;
    this.defaultVersion = defaultVer;

    if (options.masterKey) {
      if (typeof options.masterKey === 'object' && !(options.masterKey instanceof Buffer) && !Array.isArray(options.masterKey)) {
        // Multi-version keyring record
        for (const [verStr, keyVal] of Object.entries(options.masterKey)) {
          const verNum = Number(verStr);
          this.keyring.set(verNum, this.normalizeKey(keyVal));
        }
      } else {
        // Single master key provided
        this.keyring.set(defaultVer, this.normalizeKey(options.masterKey as string | Buffer));
      }
    } else {
      // Fallback to environment variables
      const rawEnv = process.env.MASTER_ENCRYPTION_KEY || config.security.tokenEncryptionKey || '';
      if (!rawEnv || String(rawEnv).trim().length < 32) {
        // In non-production or test mode, generate a deterministic fallback if explicitly unconfigured
        if (process.env.NODE_ENV === 'test') {
          this.keyring.set(defaultVer, crypto.createHash('sha256').update('test-master-encryption-key-f8-32bytes-min').digest());
        } else {
          throw new InvalidMasterKeyError();
        }
      } else {
        this.keyring.set(defaultVer, this.normalizeKey(rawEnv));
      }
    }

    if (!this.keyring.has(this.defaultVersion)) {
      const firstAvailable = this.keyring.keys().next().value;
      if (firstAvailable !== undefined) {
        this.defaultVersion = firstAvailable;
      }
    }
  }

  /**
   * Normalizes an input master key into a strictly 32-byte cryptographic Buffer.
   * Supports raw 32-byte Buffers, 64-char hex strings, 44-char base64 strings, or >=32-char passphrases.
   */
  private normalizeKey(key: string | Buffer): Buffer {
    if (Buffer.isBuffer(key)) {
      if (key.length === 32) return key;
      if (key.length > 32) return crypto.createHash('sha256').update(key).digest();
      throw new InvalidMasterKeyError(`Buffer key must be at least 32 bytes, received ${key.length}`);
    }

    const str = String(key || '').trim();
    if (str.length < 32) {
      throw new InvalidMasterKeyError(`Master key string must be at least 32 characters, received ${str.length}`);
    }

    // Check if 64-char hex string
    if (/^[0-9a-fA-F]{64}$/.test(str)) {
      return Buffer.from(str, 'hex');
    }

    // Check if 32-byte base64 string
    if (/^[A-Za-z0-9+/]{43}=$/.test(str) || /^[A-Za-z0-9_-]{43}$/.test(str)) {
      try {
        const buf = Buffer.from(str, 'base64');
        if (buf.length === 32) return buf;
      } catch {
        // Fall through to SHA-256 digest
      }
    }

    // High-entropy derivation using SHA-256
    return crypto.createHash('sha256').update(str, 'utf8').digest();
  }

  /**
   * Retrieves the KEK for a given key version.
   */
  private getKek(version: number, override?: string | Buffer): Buffer {
    if (override) {
      return this.normalizeKey(override);
    }
    const kek = this.keyring.get(version);
    if (!kek) {
      throw new InvalidMasterKeyError(`Master key version ${version} not found in keyring`);
    }
    return kek;
  }

  /**
   * Wraps an ephemeral DEK with the specified KEK using AES-256-GCM.
   */
  private wrapDek(dek: Buffer, kek: Buffer): string {
    const dekIv = crypto.randomBytes(SecretVault.IV_LENGTH);
    const cipher = crypto.createCipheriv(SecretVault.ALGORITHM, kek, dekIv);
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      dekIv.toString('base64url'),
      tag.toString('base64url'),
      wrapped.toString('base64url'),
    ].join(':');
  }

  /**
   * Unwraps an encrypted DEK string using the specified KEK with AES-256-GCM.
   */
  private unwrapDek(encryptedDek: string, kek: Buffer): Buffer {
    const parts = String(encryptedDek || '').split(':');
    if (parts.length !== 3) {
      throw new MalformedEnvelopeError('Invalid wrapped DEK structure');
    }

    const [ivB64, tagB64, cipherB64] = parts;
    try {
      const iv = Buffer.from(ivB64, 'base64url');
      const tag = Buffer.from(tagB64, 'base64url');
      const ciphertext = Buffer.from(cipherB64, 'base64url');

      const decipher = crypto.createDecipheriv(SecretVault.ALGORITHM, kek, iv);
      decipher.setAuthTag(tag);

      const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (dek.length !== SecretVault.DEK_LENGTH) {
        throw new DecryptionAuthenticationError('Unwrapped DEK length mismatch');
      }
      return dek;
    } catch (err: any) {
      if (err instanceof DecryptionAuthenticationError) throw err;
      throw new DecryptionAuthenticationError(`DEK unwrap failed: ${err?.message || 'auth failure'}`);
    }
  }

  /**
   * Encrypts a plaintext string into a Two-Tier AES-256-GCM Envelope.
   * Generates a fresh random 32-byte DEK, encrypts payload, then wraps DEK with Master KEK.
   */
  encrypt(
    plaintext: string,
    options?: { keyVersion?: number; kekOverride?: string | Buffer }
  ): EncryptedEnvelope {
    const version = options?.keyVersion ?? this.defaultVersion;
    const kek = this.getKek(version, options?.kekOverride);

    // 1. Generate fresh ephemeral DEK and data IV
    const dek = crypto.randomBytes(SecretVault.DEK_LENGTH);
    const dataIv = crypto.randomBytes(SecretVault.IV_LENGTH);

    // 2. Encrypt plaintext data using DEK
    const cipher = crypto.createCipheriv(SecretVault.ALGORITHM, dek, dataIv);
    const encryptedData = Buffer.concat([
      cipher.update(Buffer.from(String(plaintext ?? ''), 'utf8')),
      cipher.final(),
    ]);
    const dataTag = cipher.getAuthTag();

    // 3. Wrap DEK using KEK
    const encryptedDek = this.wrapDek(dek, kek);

    return {
      encryptedDek,
      encryptedData: encryptedData.toString('base64url'),
      iv: dataIv.toString('base64url'),
      tag: dataTag.toString('base64url'),
      keyVersion: version,
      algorithm: 'aes-256-gcm',
    };
  }

  /**
   * Decrypts an EncryptedEnvelope (or JSON-serialized envelope) back to plaintext string.
   */
  decrypt(
    envelopeOrJson: EncryptedEnvelope | string,
    options?: { kekOverride?: string | Buffer }
  ): string {
    const env: EncryptedEnvelope = typeof envelopeOrJson === 'string'
      ? this.deserializeEnvelope(envelopeOrJson)
      : envelopeOrJson;

    if (!env || typeof env !== 'object') {
      throw new MalformedEnvelopeError('Envelope must be a non-null object');
    }

    if (env.algorithm !== 'aes-256-gcm') {
      throw new MalformedEnvelopeError(`Unsupported cipher algorithm: ${env.algorithm}`);
    }

    if (!env.encryptedDek || !env.encryptedData || !env.iv || !env.tag) {
      throw new MalformedEnvelopeError('Missing mandatory envelope fields');
    }

    // 1. Retrieve KEK and unwrap ephemeral DEK
    const kek = this.getKek(env.keyVersion, options?.kekOverride);
    const dek = this.unwrapDek(env.encryptedDek, kek);

    // 2. Decrypt data ciphertext using unwrapped DEK
    try {
      const dataIv = Buffer.from(env.iv, 'base64url');
      const dataTag = Buffer.from(env.tag, 'base64url');
      const ciphertext = Buffer.from(env.encryptedData, 'base64url');

      const decipher = crypto.createDecipheriv(SecretVault.ALGORITHM, dek, dataIv);
      decipher.setAuthTag(dataTag);

      const plaintextBuf = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return plaintextBuf.toString('utf8');
    } catch (err: any) {
      throw new DecryptionAuthenticationError(`Data decryption failed: ${err?.message || 'auth failure'}`);
    }
  }

  /**
   * Re-encrypts the envelope's DEK under a new Master Key (KEK) without decrypting the data payload.
   * Guarantees O(1) time and memory overhead, zero plaintext exposure, and zero downtime.
   */
  rotateMasterKey(
    envelope: EncryptedEnvelope,
    newKek: string | Buffer,
    newVersion: number,
    oldKekOverride?: string | Buffer
  ): EncryptedEnvelope {
    if (!envelope || !envelope.encryptedDek || !envelope.encryptedData) {
      throw new MalformedEnvelopeError('Invalid envelope provided for key rotation');
    }

    // 1. Resolve old KEK and unwrap the existing DEK
    const oldKek = this.getKek(envelope.keyVersion, oldKekOverride);
    const dek = this.unwrapDek(envelope.encryptedDek, oldKek);

    // 2. Normalize new KEK and re-wrap the DEK
    const normalizedNewKek = this.normalizeKey(newKek);
    const newEncryptedDek = this.wrapDek(dek, normalizedNewKek);

    // 3. Return updated envelope: encryptedData, iv, and tag are UNTOUCHED!
    return {
      encryptedDek: newEncryptedDek,
      encryptedData: envelope.encryptedData,
      iv: envelope.iv,
      tag: envelope.tag,
      keyVersion: newVersion,
      algorithm: 'aes-256-gcm',
    };
  }

  /**
   * Recursively redacts passwords, tokens, API keys, and JWTs in strings and JSON objects.
   * Safe against circular references and deep object trees.
   */
  redactSecrets<T>(target: T): T {
    const seen = new WeakSet<object>();

    const redactString = (str: string): string => {
      let result = str;

      // 1. Redact JWTs (header.payload.signature)
      result = result.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');

      // 2. Redact Bearer tokens
      result = result.replace(/\bBearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi, 'Bearer [REDACTED]');

      // 3. Redact OpenAI / Anthropic / Meta keys
      result = result.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');
      result = result.replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');
      result = result.replace(/\bEAA[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');

      // 4. Redact database URLs with embedded credentials
      result = result.replace(
        /(postgres(?:ql)?|mysql|mongodb|redis):\/\/([^:]+):([^@]+)@/gi,
        '$1://$2:[REDACTED]@'
      );

      // 5. Redact URL query parameter secrets
      result = result.replace(
        /([?&](?:token|access_token|api_key|secret|password)=)[^&]+/gi,
        '$1[REDACTED]'
      );

      return result;
    };

    const isSensitiveKey = (key: string): boolean => {
      const lower = key.toLowerCase();
      return (
        lower === 'password' ||
        lower === 'passwd' ||
        lower === 'pwd' ||
        lower === 'token' ||
        lower === 'accesstoken' ||
        lower === 'access_token' ||
        lower === 'refreshtoken' ||
        lower === 'refresh_token' ||
        lower === 'secret' ||
        lower === 'appsecret' ||
        lower === 'app_secret' ||
        lower === 'clientsecret' ||
        lower === 'client_secret' ||
        lower === 'apikey' ||
        lower === 'api_key' ||
        lower === 'privatekey' ||
        lower === 'private_key' ||
        lower === 'master_encryption_key' ||
        lower === 'masterkey' ||
        lower === 'master_key' ||
        lower === 'jwt' ||
        lower === 'authorization' ||
        lower === 'proxy-authorization' ||
        lower === 'creditcard' ||
        lower === 'credit_card' ||
        lower === 'cardnumber' ||
        lower === 'cvv' ||
        lower === 'cvc' ||
        lower === 'ssn'
      );
    };

    const walk = (val: any): any => {
      if (val === null || val === undefined) return val;

      if (typeof val === 'string') {
        return redactString(val);
      }

      if (typeof val !== 'object') {
        return val;
      }

      if (val instanceof Date || val instanceof RegExp) {
        return val;
      }

      if (Buffer.isBuffer(val)) {
        return val;
      }

      if (seen.has(val)) {
        return '[CIRCULAR_REFERENCE]';
      }
      seen.add(val);

      if (Array.isArray(val)) {
        return val.map((item) => walk(item));
      }

      const copy: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        if (isSensitiveKey(k)) {
          copy[k] = '[REDACTED]';
        } else {
          copy[k] = walk(v);
        }
      }
      return copy;
    };

    return walk(target);
  }

  /**
   * Serializes an EncryptedEnvelope into a JSON string.
   */
  serializeEnvelope(envelope: EncryptedEnvelope): string {
    return JSON.stringify(envelope);
  }

  /**
   * Parses a JSON string into an EncryptedEnvelope.
   */
  deserializeEnvelope(json: string): EncryptedEnvelope {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object') {
        throw new MalformedEnvelopeError();
      }
      return parsed as EncryptedEnvelope;
    } catch (err: any) {
      if (err instanceof MalformedEnvelopeError) throw err;
      throw new MalformedEnvelopeError(`Failed to parse envelope JSON: ${err?.message}`);
    }
  }
}

// Default singleton instance
export const secretVault = new SecretVault();
export default secretVault;
