import type { AppRole, AuthSession } from '../types/models';

export type AppSurface = 'admin' | 'company' | 'guard' | 'client' | 'denied';

export const SESSION_STORAGE_VERSION = 2;

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

export function serializeStoredSession(session: AuthSession): string {
  return JSON.stringify({ version: SESSION_STORAGE_VERSION, session });
}

export function parseStoredSession(raw: string): AuthSession | null {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; session?: unknown };
    if (parsed.version !== SESSION_STORAGE_VERSION || !isValidSession(parsed.session)) return null;
    return parsed.session;
  } catch {
    return null;
  }
}
