import type { AppRole, AuthSession, StoredSession } from '../types/models';

export type AppSurface = 'admin' | 'company' | 'guard' | 'client' | 'denied';

/**
 * v3 persists the renewable refresh token and the user, and deliberately does NOT persist the
 * access token — that lives in memory only and is re-minted from the refresh token on each cold
 * start. v2 is the shape shipped in v1.0.0–v1.0.3: user plus a bare access token. It is still
 * read so an in-place upgrade does not log the owner out; it is never written again.
 */
export const SESSION_STORAGE_VERSION = 3;
export const LEGACY_SESSION_STORAGE_VERSION = 2;

export const ADMIN_DASHBOARD_ENDPOINTS = [
  '/companies',
  '/guards',
  '/sites',
  '/jobs',
  '/assignments',
  '/shifts',
  '/timesheets',
  '/audit-logs',
  '/job-applications',
  '/attendance/company',
  '/incidents/company',
  '/alerts/company',
  '/daily-logs/company',
  '/notifications/company',
  '/health/live',
  '/health/ready',
] as const;

export function isAppRole(value: unknown): value is AppRole {
  return [
    'admin',
    'company',
    'company_admin',
    'company_staff',
    'guard',
    'client_admin',
    'client_viewer',
  ].includes(value as AppRole);
}

export function getAppSurface(role: unknown): AppSurface {
  if (role === 'admin') return 'admin';
  if (role === 'company' || role === 'company_admin' || role === 'company_staff') return 'company';
  if (role === 'guard') return 'guard';
  if (role === 'client_admin' || role === 'client_viewer') return 'client';
  return 'denied';
}

function isValidSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthSession>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    !!candidate.user &&
    typeof candidate.user.id === 'number' &&
    typeof candidate.user.email === 'string' &&
    isAppRole(candidate.user.role)
  );
}

function isValidUser(value: unknown): value is AuthSession['user'] {
  if (!value || typeof value !== 'object') return false;
  const user = value as Partial<AuthSession['user']>;
  return (
    typeof user.id === 'number' && typeof user.email === 'string' && isAppRole(user.role as string)
  );
}

export function serializeStoredSession(session: StoredSession): string {
  // The access token is intentionally dropped here — it is short-lived and must never reach disk.
  return JSON.stringify({
    version: SESSION_STORAGE_VERSION,
    session: { user: session.user, refreshToken: session.refreshToken },
  });
}

export function parseStoredSession(raw: string): StoredSession | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; session?: unknown };

    if (parsed.version === SESSION_STORAGE_VERSION) {
      const candidate = parsed.session as Partial<StoredSession> | undefined;
      if (!candidate || !isValidUser(candidate.user)) return null;
      if (typeof candidate.refreshToken !== 'string' || !candidate.refreshToken) return null;
      return { user: candidate.user, refreshToken: candidate.refreshToken };
    }

    // Legacy upgrade path: a build before v1.0.4 stored a bare access token and no renewable
    // session. Keep the owner signed in on whatever validity that token has left; the first
    // refresh-less 401 then takes them to Login once, which establishes a v3 session.
    if (parsed.version === LEGACY_SESSION_STORAGE_VERSION && isValidSession(parsed.session)) {
      return { user: parsed.session.user, legacyAccessToken: parsed.session.accessToken };
    }

    return null;
  } catch {
    return null;
  }
}
