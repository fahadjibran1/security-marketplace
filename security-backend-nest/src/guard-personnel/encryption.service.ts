import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Bumping this integer is all that is needed to introduce a new key version.
// Decryption reads the version prefix from the stored envelope, so old ciphertexts
// are still decryptable while new ones use the current key.
const CURRENT_KEY_VERSION = 1;

const DEV_ENC_FALLBACK = '0000000000000000000000000000000000000000000000000000000000000000';
const DEV_HMAC_FALLBACK = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

@Injectable()
export class EncryptionService {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor() {
    const encHex = (process.env.GUARD_DATA_ENCRYPTION_KEY ?? '').trim();
    const hmacHex = (process.env.GUARD_DATA_HMAC_KEY ?? '').trim();
    const isProduction = process.env.NODE_ENV === 'production';

    if (!encHex || encHex.length !== 64) {
      if (isProduction) throw new Error('GUARD_DATA_ENCRYPTION_KEY must be a 64-char hex string in production');
      this.encKey = Buffer.from(DEV_ENC_FALLBACK, 'hex');
    } else {
      this.encKey = Buffer.from(encHex, 'hex');
    }

    if (!hmacHex || hmacHex.length !== 64) {
      if (isProduction) throw new Error('GUARD_DATA_HMAC_KEY must be a 64-char hex string in production');
      this.hmacKey = Buffer.from(DEV_HMAC_FALLBACK, 'hex');
    } else {
      this.hmacKey = Buffer.from(hmacHex, 'hex');
    }

    if (!isProduction && (encHex === DEV_ENC_FALLBACK || !encHex)) {
      console.warn('[EncryptionService] Using development fallback keys — set GUARD_DATA_ENCRYPTION_KEY and GUARD_DATA_HMAC_KEY for any persistent environment');
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) throw new Error('Unexpected GCM auth tag length');
    return `v${CURRENT_KEY_VERSION}:${iv.toString('base64')}:${body.toString('base64')}:${tag.toString('base64')}`;
  }

  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) throw new Error('Malformed encryption envelope');
    const version = parseInt(parts[0].slice(1), 10);
    if (isNaN(version) || version !== CURRENT_KEY_VERSION) {
      throw new Error(`Unsupported key version: ${parts[0]}`);
    }
    const iv = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  }

  // Keyed HMAC of the normalised plaintext — used for uniqueness checks without decryption.
  // normalise: uppercase + strip all whitespace (consistent regardless of input spacing).
  hmac(plaintext: string): string {
    const normalised = plaintext.replace(/\s/g, '').toUpperCase();
    return crypto.createHmac('sha256', this.hmacKey).update(normalised, 'utf8').digest('hex');
  }

  // AB 12 34 56 C → AB••••••C  (first 2 letters + last 1 letter visible)
  maskNino(plaintext: string): string {
    const n = plaintext.replace(/\s/g, '').toUpperCase();
    if (n.length < 3) return '••••••••••';
    return n.slice(0, 2) + '••••••' + n.slice(-1);
  }

  // 1234567890 → ••••••7890  (last 4 digits visible)
  maskUtr(plaintext: string): string {
    const n = plaintext.replace(/\s/g, '');
    if (n.length < 4) return '••••••••••';
    return '••••••' + n.slice(-4);
  }
}
