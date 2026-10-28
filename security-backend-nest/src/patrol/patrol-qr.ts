import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, rotatable static checkpoint labels (plan section D).
 *
 *   label payload   s4cp:1:<keyId>:<publicId>:<tokenVersion>:<mac>
 *   mac             base64url(HMAC-SHA256(key, "s4cp:1:<keyId>:<publicId>:<tokenVersion>"))
 *
 * The key never leaves the server and is never stored in the database:
 *   PATROL_QR_SIGNING_KEY            current key (at least 32 characters)
 *   PATROL_QR_SIGNING_KEY_ID         its id, printed in the label (default 'k1'; [A-Za-z0-9]{1,16})
 *   PATROL_QR_PREVIOUS_SIGNING_KEY / PATROL_QR_PREVIOUS_SIGNING_KEY_ID
 *                                    optional: the key being rotated out, still accepted for verification only
 *
 * Without PATROL_QR_SIGNING_KEY the server REFUSES to generate labels (PATROL_QR_SIGNING_KEY_UNAVAILABLE) and records
 * every scan as `unverified` with the flag `signing_key_unavailable` — never as verified, never rejected.
 *
 * A scan only ever proves that a label was scanned, never that a person was at the checkpoint.
 */

export const PATROL_QR_PREFIX = 's4cp';
export const PATROL_QR_FORMAT_VERSION = '1';
const KEY_ID_PATTERN = /^[A-Za-z0-9]{1,16}$/;
const PUBLIC_ID_PATTERN = /^[0-9a-f]{32}$/;
const MIN_KEY_LENGTH = 32;

export type PatrolQrKey = { keyId: string; key: string };
export type PatrolQrKeyring = { current: PatrolQrKey | null; accepted: PatrolQrKey[] };

/** Reads the signing keys from the environment. Malformed or short keys are treated as absent (fail closed). */
export function patrolQrKeyring(env: NodeJS.ProcessEnv = process.env): PatrolQrKeyring {
  const read = (keyVar: string, idVar: string, defaultId: string | null): PatrolQrKey | null => {
    const key = env[keyVar]?.trim();
    const keyId = (env[idVar]?.trim() || defaultId) ?? '';
    if (!key || key.length < MIN_KEY_LENGTH || !KEY_ID_PATTERN.test(keyId)) return null;
    return { keyId, key };
  };
  const current = read('PATROL_QR_SIGNING_KEY', 'PATROL_QR_SIGNING_KEY_ID', 'k1');
  const previous = read('PATROL_QR_PREVIOUS_SIGNING_KEY', 'PATROL_QR_PREVIOUS_SIGNING_KEY_ID', null);
  const accepted = [current, previous].filter((k): k is PatrolQrKey => k !== null);
  return { current, accepted: accepted.filter((k, i) => accepted.findIndex((o) => o.keyId === k.keyId) === i) };
}

/** 128 bits of cryptographic randomness as 32 lowercase hex characters. */
export function newCheckpointPublicId(): string {
  return randomBytes(16).toString('hex');
}

function mac(key: string, keyId: string, publicId: string, tokenVersion: number): string {
  return createHmac('sha256', key)
    .update(`${PATROL_QR_PREFIX}:${PATROL_QR_FORMAT_VERSION}:${keyId}:${publicId}:${tokenVersion}`)
    .digest('base64url');
}

/** The label payload for a checkpoint, or null when no signing key is configured. */
export function signCheckpointLabel(publicId: string, tokenVersion: number, keyring: PatrolQrKeyring = patrolQrKeyring()): string | null {
  if (!keyring.current) return null;
  const { keyId, key } = keyring.current;
  return `${PATROL_QR_PREFIX}:${PATROL_QR_FORMAT_VERSION}:${keyId}:${publicId}:${tokenVersion}:${mac(key, keyId, publicId, tokenVersion)}`;
}

export type ParsedLabel = { keyId: string; publicId: string; tokenVersion: number; mac: string };

/** Parses a label payload; null when it is not a well-formed s4cp:1 label. */
export function parseCheckpointLabel(payload: string): ParsedLabel | null {
  if (typeof payload !== 'string' || payload.length > 256) return null;
  const parts = payload.trim().split(':');
  if (parts.length !== 6 || parts[0] !== PATROL_QR_PREFIX || parts[1] !== PATROL_QR_FORMAT_VERSION) return null;
  const [, , keyId, publicId, version, signature] = parts;
  if (!KEY_ID_PATTERN.test(keyId) || !PUBLIC_ID_PATTERN.test(publicId) || !/^[1-9][0-9]{0,8}$/.test(version)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  return { keyId, publicId, tokenVersion: Number(version), mac: signature };
}

export type SignatureCheck = 'valid' | 'invalid' | 'unknown_key' | 'no_key';

/** Constant-time check of a parsed label's MAC against the accepted keys. */
export function checkLabelSignature(label: ParsedLabel, keyring: PatrolQrKeyring = patrolQrKeyring()): SignatureCheck {
  if (!keyring.accepted.length) return 'no_key';
  const key = keyring.accepted.find((k) => k.keyId === label.keyId);
  if (!key) return 'unknown_key';
  const expected = Buffer.from(mac(key.key, key.keyId, label.publicId, label.tokenVersion));
  const given = Buffer.from(label.mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? 'valid' : 'invalid';
}
