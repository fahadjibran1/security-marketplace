/**
 * The password rules self-service accounts already live under. Registration and password reset share
 * them so a reset can never set a password that registration would have refused. (Platform admins are
 * created by the operator CLI under its own stricter rule.)
 */
export const PASSWORD_MIN_LENGTH = 6;
/** bcrypt only reads the first 72 bytes; anything far beyond that is a mistake or an attack on the hash. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Written over a deleted account's password hash. Deliberately not a bcrypt hash, so no password can
 * ever match it.
 */
export const DELETED_ACCOUNT_PASSWORD_SENTINEL = '!account-deleted';

/** True only for a bcrypt hash. Anything else — the deletion sentinel included — can never authenticate. */
export function isUsablePasswordHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(hash);
}
