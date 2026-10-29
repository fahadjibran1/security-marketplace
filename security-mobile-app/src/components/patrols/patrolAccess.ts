// Who may see and do what in Patrol Management (Patrols P1-D). Display only: the server re-checks every request.
//
// The backend matrix (company-membership-types.ts, owner-approved 28 / 29 Oct 2026):
//   patrols.view      Owner, Admin, Operations, Control Room, Viewer
//   patrols.manage    Owner, Admin, Operations          (site settings, schedules, checkpoints, routes, labels)
//   patrols.evidence  Owner, Admin, Operations, Control Room   (photo evidence and its metadata)
//   patrols.holds     Owner, Admin                      (holds, exports, storage usage)
//   alerts.manage     Owner, Admin, Operations, Control Room   (act on patrol alerts)
//
// THE FEATURE SWITCH. The session lists the patrols.* permissions only while the company's patrolsEnabled switch is on
// (auth.service withPatrolSwitch), so "no patrols.view in the session" is exactly "the page does not exist". There is
// deliberately NO legacy-role fallback for patrols: a session without a permission list cannot tell whether the switch
// is on, so it fails closed and shows nothing — no navigation entry, no summary card and no patrol request at all.
// alerts.manage is not patrol-gated, so it keeps the dashboard's usual legacy-owner fallback.

export type PatrolPermissions = {
  canView: boolean;
  canManage: boolean;
  canViewEvidence: boolean;
  canManageHolds: boolean;
  canActOnAlerts: boolean;
};

export const NO_PATROL_PERMISSIONS: PatrolPermissions = Object.freeze({
  canView: false,
  canManage: false,
  canViewEvidence: false,
  canManageHolds: false,
  canActOnAlerts: false,
});

const LEGACY_OWNER_ROLES = new Set(['company', 'company_admin']);

export function resolvePatrolPermissions(companyPermissions: string[] | null | undefined, role: string | null | undefined): PatrolPermissions {
  const list = Array.isArray(companyPermissions) ? companyPermissions : null;
  const has = (permission: string) => Boolean(list && list.includes(permission));
  const canView = has('patrols.view');
  return {
    canView,
    // Nothing patrol-specific without patrols.view: the session would never list one without the other, and if it
    // somehow did, the page is not reachable anyway.
    canManage: canView && has('patrols.manage'),
    canViewEvidence: canView && has('patrols.evidence'),
    canManageHolds: canView && has('patrols.holds'),
    canActOnAlerts: list ? has('alerts.manage') : LEGACY_OWNER_ROLES.has(String(role || '')),
  };
}

export type PatrolTab =
  | 'overview'
  | 'live'
  | 'schedules'
  | 'checkpoints'
  | 'history'
  | 'evidence'
  | 'retention'
  | 'settings'
  | 'storage';

export const PATROL_TABS: Array<{ id: PatrolTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'live', label: 'Live Patrols' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'checkpoints', label: 'Checkpoints & Routes' },
  { id: 'history', label: 'History' },
  { id: 'evidence', label: 'Photographic Evidence' },
  { id: 'retention', label: 'Downloads, retention & holds' },
  { id: 'settings', label: 'Site settings' },
  { id: 'storage', label: 'Storage usage' },
];

/**
 * The tabs this person can open. Photographic Evidence needs patrols.evidence (a Viewer never sees a photo or its
 * metadata); Storage usage needs patrols.holds, because the metering endpoint does. Downloads, retention & holds stays
 * visible with patrols.view so everyone can read the retention period; its hold and export controls need patrols.holds.
 */
export function visiblePatrolTabs(permissions: PatrolPermissions): PatrolTab[] {
  if (!permissions.canView) return [];
  return PATROL_TABS.map((tab) => tab.id).filter((id) => {
    if (id === 'evidence') return permissions.canViewEvidence;
    if (id === 'storage') return permissions.canManageHolds;
    return true;
  });
}

/** The tab to show: the requested one when allowed, otherwise the first allowed one (or null: no page at all). */
export function resolvePatrolTab(requested: PatrolTab | null | undefined, permissions: PatrolPermissions): PatrolTab | null {
  const tabs = visiblePatrolTabs(permissions);
  if (!tabs.length) return null;
  return requested && tabs.includes(requested) ? requested : tabs[0];
}

/** Where the Patrol Management entry sits in the company navigation: directly after Live Operations. */
export function withPatrolNavEntry<T extends string>(itemIds: T[], patrolId: T, liveOperationsId: T, permissions: PatrolPermissions): T[] {
  const without = itemIds.filter((id) => id !== patrolId);
  if (!permissions.canView) return without;
  const at = without.indexOf(liveOperationsId);
  if (at < 0) return [...without, patrolId];
  return [...without.slice(0, at + 1), patrolId, ...without.slice(at + 1)];
}

/**
 * The server's patrol refusals, read for the screen. 404 PATROLS_NOT_ENABLED means the switch is off (stop asking);
 * 403 means this person lacks the permission (show it, keep the page); anything else is a plain error.
 */
export type PatrolFailureKind = 'not_enabled' | 'forbidden' | 'not_found' | 'unavailable' | 'error';

export function classifyPatrolFailure(error: unknown): PatrolFailureKind {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null;
  const body = (error as { body?: unknown })?.body;
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null;
  if (code === 'PATROLS_NOT_ENABLED') return 'not_enabled';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 503) return 'unavailable';
  return 'error';
}

export function patrolFailureMessage(error: unknown, fallback: string): string {
  switch (classifyPatrolFailure(error)) {
    case 'not_enabled':
      return 'Patrol Management is not enabled for this company.';
    case 'forbidden':
      return 'You do not have permission for this part of Patrol Management.';
    case 'not_found':
      return 'That patrol record was not found.';
    case 'unavailable': {
      const body = (error as { body?: unknown })?.body;
      const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
      return typeof message === 'string' && message.trim() ? message : 'This patrol service is temporarily unavailable.';
    }
    default: {
      const body = (error as { body?: unknown })?.body;
      const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
      if (typeof message === 'string' && message.trim()) return message;
      if (Array.isArray(message) && message.length) return message.join(', ');
      return fallback;
    }
  }
}
