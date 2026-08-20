import type { AppRole } from '../types/models';

export type AdminSection =
  | 'overview' | 'companies' | 'guards' | 'sites' | 'jobs' | 'applications'
  | 'assignments' | 'shifts' | 'attendance' | 'timesheets' | 'incidents'
  | 'alerts' | 'dailyLogs' | 'audit' | 'notifications' | 'health';

export interface AdminNavItem {
  key: AdminSection;
  label: string;
  group: 'Overview' | 'Directory' | 'Operations' | 'Assurance';
  emptyLabel: string;
}

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { key: 'overview', label: 'Dashboard', group: 'Overview', emptyLabel: 'No platform data is available yet.' },
  { key: 'companies', label: 'Companies', group: 'Directory', emptyLabel: 'No companies have been created yet.' },
  { key: 'guards', label: 'Guard access & status', group: 'Directory', emptyLabel: 'No guards have been created yet.' },
  { key: 'sites', label: 'Sites', group: 'Directory', emptyLabel: 'No sites have been created yet.' },
  { key: 'jobs', label: 'Jobs', group: 'Operations', emptyLabel: 'No jobs have been created yet.' },
  { key: 'applications', label: 'Applications', group: 'Operations', emptyLabel: 'No applications have been created yet.' },
  { key: 'assignments', label: 'Assignments', group: 'Operations', emptyLabel: 'No assignments have been created yet.' },
  { key: 'shifts', label: 'Shifts', group: 'Operations', emptyLabel: 'No shifts have been created yet.' },
  { key: 'attendance', label: 'Attendance', group: 'Operations', emptyLabel: 'No attendance events have been recorded yet.' },
  { key: 'timesheets', label: 'Timesheets', group: 'Operations', emptyLabel: 'No timesheets have been created yet.' },
  { key: 'incidents', label: 'Incidents', group: 'Assurance', emptyLabel: 'No incidents have been reported yet.' },
  { key: 'alerts', label: 'Panic & safety alerts', group: 'Assurance', emptyLabel: 'No safety alerts have been raised yet.' },
  { key: 'dailyLogs', label: 'Daily logs', group: 'Assurance', emptyLabel: 'No daily logs have been recorded yet.' },
  { key: 'audit', label: 'Audit trail', group: 'Assurance', emptyLabel: 'No audit events have been recorded yet.' },
  { key: 'notifications', label: 'Admin notifications', group: 'Assurance', emptyLabel: 'No admin notifications have been received yet.' },
  { key: 'health', label: 'Service health', group: 'Assurance', emptyLabel: 'No health response was returned.' },
] as const;

export function canAccessAdminPortal(role: AppRole | string | null | undefined): boolean {
  return role === 'admin';
}

export function adminPortalError(status?: number): string {
  if (status === 403) return 'Access denied. Your authenticated role cannot view this Platform Admin resource.';
  if (status === 404) return 'This Platform Admin resource is not available in the current RC1 API.';
  return 'Unable to load this Platform Admin view. Retry or check service health.';
}

export function matchesAdminSearch(values: unknown[], query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || values.some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
}
