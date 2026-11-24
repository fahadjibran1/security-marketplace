import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords (TOTP) for Platform Admin two-step verification, on Node's own crypto: no
 * third-party library. The parameters are the ones every authenticator app supports without configuration: HMAC-SHA-1,
 * 6 digits, a 30-second step, a 160-bit secret (RFC 4226 section 4 recommends at least 128 bits; 160 is the HMAC-SHA-1
 * block-size convention authenticator apps expect).
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_SECRET_BYTES = 20;
/** Steps either side of now that are accepted, for clock drift between the server and the phone (±30 s). */
export const TOTP_DRIFT_STEPS = 1;
export const TOTP_ISSUER = 'S4';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding (the form authenticator apps take). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode; case, spaces and padding are ignored. Throws on any other character. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP value for one counter, as a zero-padded decimal string of `digits` digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code an authenticator shows at `nowMs` (used by tests and nowhere else in the application). */
export function totpAt(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * The time step a presented code matches, within ±TOTP_DRIFT_STEPS of now, or null. Steps are tried newest first so a
 * code is always attributed to the latest step it is valid for. Comparison is constant-time per candidate. The caller
 * is responsible for refusing a step at or below the last one accepted (replay).
 */
export function matchTotpStep(secretBase32: string, code: unknown, nowMs: number): number | null {
  // Authenticator apps display "123 456"; a pasted space is not a different code.
  const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const presented = Buffer.from(digits, 'utf8');
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = now + TOTP_DRIFT_STEPS; step >= now - TOTP_DRIFT_STEPS; step -= 1) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(expected, presented) && matched === null) matched = step;
  }
  return matched;
}

/** The otpauth:// URI an authenticator app imports (Key Uri Format), for a QR code or manual entry. */
export function otpauthUri(secretBase32: string, accountName: string, issuer = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
