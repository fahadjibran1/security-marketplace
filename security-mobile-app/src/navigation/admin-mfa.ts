// Platform Admin two-step verification (authenticator app) — the pure rules the sign-in code step, enrolment and the
// admin Security page share. The backend (security-backend-nest/src/auth/admin-mfa.service.ts) decides everything; this
// only recognises its responses, tidies what the person types and draws the otpauth:// URI as a QR code.
//
// QR encoder: qrcode-generator 1.4.4, already a pinned dependency (patrol checkpoint labels); no new package.

import qrcode from 'qrcode-generator';

/** POST /auth/login for an enrolled Platform Admin: no session yet, a code is needed. */
export interface AdminMfaChallenge {
  mfaRequired: true;
  method: 'totp';
  challengeToken: string;
  challengeExpiresAt: string;
}

/** POST /auth/login for an unenrolled Platform Admin while two-step verification is required: enrol first. */
export interface AdminMfaEnrollmentRequired {
  mfaEnrollmentRequired: true;
  enrollmentToken: string;
  enrollmentExpiresAt: string;
}

/** POST /auth/mfa/totp/enrol: shown once, before confirmation. */
export interface AdminMfaEnrolmentSetup {
  method: 'totp';
  issuer: string;
  accountName: string;
  secret: string;
  otpauthUri: string;
  digits: number;
  period: number;
  algorithm: string;
  expiresAt: string;
}

export interface AdminMfaStatus {
  enrolled: boolean;
  enabledAt: string | null;
  pending: boolean;
  required: boolean;
  method: 'totp';
}

export function isAdminMfaChallenge(value: unknown): value is AdminMfaChallenge {
  const v = value as Partial<AdminMfaChallenge> | null;
  return !!v && typeof v === 'object' && v.mfaRequired === true && typeof v.challengeToken === 'string' && v.challengeToken.length > 0;
}

export function isAdminMfaEnrollmentRequired(value: unknown): value is AdminMfaEnrollmentRequired {
  const v = value as Partial<AdminMfaEnrollmentRequired> | null;
  return !!v && typeof v === 'object' && v.mfaEnrollmentRequired === true && typeof v.enrollmentToken === 'string' && v.enrollmentToken.length > 0;
}

/** What the person typed, reduced to digits (authenticator apps show "123 456"; a paste may carry spaces or a dash). */
export function normaliseTotpCode(input: string): string {
  return String(input ?? '').replace(/[\s-]/g, '');
}

/** Null when the code can be sent; otherwise what to tell the person. */
export function totpCodeError(input: string): string | null {
  const code = normaliseTotpCode(input);
  if (!code) return 'Enter the 6-digit code from your authenticator app.';
  if (!/^\d{6}$/.test(code)) return 'The code is 6 digits, from your authenticator app.';
  return null;
}

/** The secret in groups of four, for typing it into an authenticator app by hand. */
export function formatTotpSecret(secret: string): string {
  return String(secret ?? '').replace(/\s/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** The QR module matrix (true = dark) for an otpauth://totp/ URI from the backend, or null for anything else. */
export function otpauthQrMatrix(uri: string): boolean[][] | null {
  if (typeof uri !== 'string' || !uri.startsWith('otpauth://totp/') || uri.length > 512) return null;
  const qr = qrcode(0, 'M');
  qr.addData(uri, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** The words for a refused code step, from the backend's code (falls back to the caller's message). */
export function adminMfaErrorMessage(body: unknown, fallback: string): string {
  const code = (body as { code?: unknown } | null)?.code;
  const message = (body as { message?: unknown } | null)?.message;
  if (code === 'MFA_CODE_INVALID') return 'That code is not valid. Enter the current 6-digit code from your authenticator app.';
  if (code === 'MFA_CHALLENGE_INVALID') return 'Your sign-in has expired. Sign in again with your email and password.';
  if (code === 'MFA_ENROLMENT_NOT_STARTED') return 'Setup has expired. Start setting up two-step verification again.';
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}
