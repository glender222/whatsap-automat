import crypto from 'crypto';
import config from '../../config/index';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

export class SecretCipher {
  private readonly key: Buffer;

  constructor(secret = config.security.tokenEncryptionKey) {
    const normalizedSecret = String(secret || '').trim();
    if (normalizedSecret.length < 32) {
      throw new Error('META_TOKEN_ENCRYPTION_KEY debe tener al menos 32 caracteres');
    }
    this.key = crypto.createHash('sha256').update(normalizedSecret).digest();
  }

  encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, encryptedValue] = String(value || '').split(':');
    if (version !== VERSION || !ivValue || !tagValue || !encryptedValue) {
      throw new Error('Formato de secreto cifrado no soportado');
    }

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(ivValue, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export default SecretCipher;
