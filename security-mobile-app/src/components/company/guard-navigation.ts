// Selected-Guard workspace navigation (2D3.3). Pure helpers — no React / React Native imports — so the exact
// functions the dashboard and workspaces call can be unit-tested.
//
// Model: the dashboard owns ONE piece of parent-level state, a one-shot "guard target":
//
//   Guards → View Compliance/Availability  ⇒  openGuardTarget(section, guardId, requestId)  (+ switch section)
//   destination workspace, once its own data is loaded and it has made an authoritative decision
//                                             ⇒  consumeGuardTarget(current, requestId)      (target is gone)
//   sidebar click / leaving the section       ⇒  clearGuardTarget / reconcileGuardTarget      (never stale)
//
// The target carries only a Guard id. It never carries a Guard record, so a workspace can only ever open a Guard
// that exists in ITS OWN already-loaded data (strict lookup, no fallback — the 2D3.1 selection invariant).

export type GuardNavSection = 'compliance' | 'availability';

export type GuardNavTarget = {
  section: GuardNavSection;
  guardId: number;
  /** Monotonic id. A consume only clears the request it was issued for, never a newer one. */
  requestId: number;
};

export function openGuardTarget(section: GuardNavSection, guardId: number, requestId: number): GuardNavTarget {
  return { section, guardId, requestId };
}

/** One-shot: clears the target only if it is still the request being consumed (a late consume of an older request is ignored). */
export function consumeGuardTarget(current: GuardNavTarget | null, requestId: number): GuardNavTarget | null {
  return current && current.requestId === requestId ? null : current;
}

/** Sidebar / direct navigation never carries a target. */
export function clearGuardTarget(): null {
  return null;
}

/** A target only belongs to its own section; leaving that section drops it. */
export function reconcileGuardTarget(current: GuardNavTarget | null, activeSection: string): GuardNavTarget | null {
  return current && current.section === activeSection ? current : null;
}

/** What a workspace is handed: its own section's target, or null. */
export function targetForSection(current: GuardNavTarget | null, section: GuardNavSection): GuardNavTarget | null {
  return current && current.section === section ? current : null;
}

// ─── Permissions ─────────────────────────────────────────────────────────────

export type GuardNavPermissions = {
  /** compliance.view — the Compliance workspace is available. */
  canViewCompliance: boolean;
  /** shifts.view — the Availability read endpoints (rules / overrides) require it. */
  canViewAvailability: boolean;
};

/**
 * Effective Company permissions from the backend session. Only when the session has no permission list at all
 * (older sessions) do we fall back to the legacy owner roles — same fallback as the rest of the dashboard.
 */
export function resolveGuardNavPermissions(
  permissions: readonly string[] | null | undefined,
  role?: string | null,
): GuardNavPermissions {
  if (permissions) {
    return {
      canViewCompliance: permissions.includes('compliance.view'),
      canViewAvailability: permissions.includes('shifts.view'),
    };
  }
  const legacyOwner = role === 'company' || role === 'company_admin';
  return { canViewCompliance: legacyOwner, canViewAvailability: legacyOwner };
}

/** The single gate used both to show the Guards buttons and to accept the navigation (no hidden bypass). */
export function canOpenGuardWorkspace(section: GuardNavSection, permissions: GuardNavPermissions): boolean {
  return section === 'compliance' ? permissions.canViewCompliance : permissions.canViewAvailability;
}

// ─── Availability target ─────────────────────────────────────────────────────

export type AvailabilityTargetPlan = {
  found: boolean;
  /** Value for the existing Guard selector: the target's id when it is in the loaded list, otherwise '' (all Guards). */
  guardFilter: string;
};

/** Strict: the target must be one of the Company's loaded Guards. Otherwise show everyone — never an unrelated Guard. */
export function planAvailabilityTarget(
  companyGuards: Array<{ guard?: { id: number } | null }>,
  guardId: number,
): AvailabilityTargetPlan {
  const found = companyGuards.some((link) => link.guard?.id === guardId);
  return { found, guardFilter: found ? String(guardId) : '' };
}
