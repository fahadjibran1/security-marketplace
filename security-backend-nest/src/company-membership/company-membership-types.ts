export enum CompanyMembershipRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  OPERATIONS = 'operations',
  CONTROL_ROOM = 'control_room',
  HR_COMPLIANCE = 'hr_compliance',
  FINANCE = 'finance',
  VIEWER = 'viewer',
}

export enum CompanyMembershipStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
}

export enum CompanyPermission {
  COMPANY_MANAGE = 'company.manage',
  STAFF_MANAGE = 'staff.manage',
  SITES_VIEW = 'sites.view',
  SITES_MANAGE = 'sites.manage',
  CLIENTS_VIEW = 'clients.view',
  CLIENTS_MANAGE = 'clients.manage',
  GUARDS_VIEW = 'guards.view',
  GUARDS_MANAGE = 'guards.manage',
  COMPLIANCE_VIEW = 'compliance.view',
  COMPLIANCE_MANAGE = 'compliance.manage',
  SCREENING_VIEW = 'screening.view',
  SHIFTS_VIEW = 'shifts.view',
  SHIFTS_MANAGE = 'shifts.manage',
  /**
   * Close without Book Off (S4 Live Operations). Narrower than shifts.manage: it reconciles a shift a Guard
   * booked on to and never booked off from, and nothing else — so a control room can do it without being
   * able to create, edit or cancel shifts.
   */
  SHIFTS_RECONCILE = 'shifts.reconcile',
  /**
   * Live Shift Amendments (owner-approved 22 Oct 2026). Propose / withdraw an extension of an in-progress shift.
   * Narrower than shifts.manage. A Control Room member holds it only when individually authorised
   * (company_memberships.canAmendShifts), never by role; see shift-amendment-policy.ts.
   */
  SHIFTS_AMEND = 'shifts.amend',
  /** Record a Guard's verbal agreement to an extension (staff-reported, never a Guard response). */
  SHIFTS_AMEND_RECORD_AGREEMENT = 'shifts.amend.record_agreement',
  /** Management approval of an extension over the fatigue approval threshold (Owner / Admin). */
  SHIFTS_AMEND_APPROVE = 'shifts.amend.approve',
  /** Resolve a Guard's dispute of a staff-recorded verbal agreement (Owner / Admin). */
  SHIFTS_AMEND_RESOLVE_DISPUTE = 'shifts.amend.resolve_dispute',
  ATTENDANCE_VIEW = 'attendance.view',
  /**
   * Manual attendance (Migration 67, owner-approved 27 Oct 2026): record a Book On / Book Off for a Guard and correct a
   * recorded time (append-only). Owner, Admin and Operations by role. A Control Room member holds it only when
   * individually authorised (company_memberships.canManageAttendance), never by role; see manual-attendance-policy.ts.
   */
  ATTENDANCE_MANAGE = 'attendance.manage',
  TIMESHEETS_VIEW = 'timesheets.view',
  TIMESHEETS_REVIEW = 'timesheets.review',
  CLIENT_BILLING_VIEW = 'client_billing.view',
  CLIENT_BILLING_SUBMIT = 'client_billing.submit',
  CLIENT_BILLING_CORRECT = 'client_billing.correct',
  PAYROLL_VIEW = 'payroll.view',
  PAYROLL_MANAGE = 'payroll.manage',
  BILLING_VIEW = 'billing.view',
  BILLING_MANAGE = 'billing.manage',
  INCIDENTS_VIEW = 'incidents.view',
  INCIDENTS_MANAGE = 'incidents.manage',
  PERSONNEL_BASIC_VIEW = 'personnel_basic.view',
  PERSONNEL_HR_VIEW = 'personnel_hr.view',
  PERSONNEL_HR_MANAGE = 'personnel_hr.manage',
  PERSONNEL_BANK_VIEW = 'personnel_bank.view',
  REPORTS_OPERATIONAL = 'reports.operational',
  REPORTS_FINANCIAL = 'reports.financial',
  /**
   * Patrol Management (Migration 68, owner-approved 28 Oct 2026). Effective only while the company's patrolsEnabled
   * switch is on (the session list omits them otherwise). Exceptions are handled through the existing alerts flow.
   *   patrols.view      Owner, Admin, Operations, Control Room, Viewer
   *   patrols.manage    Owner, Admin, Operations          (site settings, schedules, checkpoints, routes, labels)
   *   patrols.evidence  Owner, Admin, Operations, Control Room   (patrol photo evidence and its metadata)
   *   patrols.holds     Owner, Admin                      (evidence holds)
   */
  PATROLS_VIEW = 'patrols.view',
  PATROLS_MANAGE = 'patrols.manage',
  PATROLS_EVIDENCE = 'patrols.evidence',
  PATROLS_HOLDS = 'patrols.holds',
  /**
   * Act on patrol alerts (owner decision, 29 Oct 2026, Patrols P1-C): acknowledge, investigate, escalate and resolve the
   * company's patrol alerts (and with them their patrol exceptions) through the existing alert lifecycle. Owner, Admin,
   * Operations and Control Room. It is deliberately separate from patrols.manage: a Control Room operator handles patrol
   * alerts but can never change patrol configuration (site settings, schedules, checkpoints, routes, labels). It changes
   * nothing for any other alert type (panic / SOS, welfare, Missing Book Off, compliance lapse, site requests, incidents).
   */
  ALERTS_MANAGE = 'alerts.manage',
}

/** The four Patrol Management permissions (Migration 68). */
export const PATROL_PERMISSIONS: readonly CompanyPermission[] = [
  CompanyPermission.PATROLS_VIEW,
  CompanyPermission.PATROLS_MANAGE,
  CompanyPermission.PATROLS_EVIDENCE,
  CompanyPermission.PATROLS_HOLDS,
];

// --- Permission matrix ---
// Data minimisation principles:
// - OPERATIONS: no payroll/billing/HR/bank — operational staff only
// - CONTROL_ROOM: live ops only — no financial, no HR documents
// - HR_COMPLIANCE: employment/compliance — no bank, no payroll batches, no billing rates
// - FINANCE: financial processing — no HR records, no operational management
// - VIEWER: read-only operational — no financial, no HR documents, no bank

const OWNER_PERMISSIONS = new Set(Object.values(CompanyPermission));

const ADMIN_PERMISSIONS: Set<CompanyPermission> = new Set([
  // company.manage excluded — only OWNER can change company settings
  CompanyPermission.STAFF_MANAGE,
  CompanyPermission.SITES_VIEW,
  CompanyPermission.SITES_MANAGE,
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.CLIENTS_MANAGE,
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.GUARDS_MANAGE,
  CompanyPermission.COMPLIANCE_VIEW,
  CompanyPermission.COMPLIANCE_MANAGE,
  CompanyPermission.SCREENING_VIEW,
  CompanyPermission.SHIFTS_VIEW,
  CompanyPermission.SHIFTS_MANAGE,
  CompanyPermission.SHIFTS_RECONCILE,
  CompanyPermission.SHIFTS_AMEND,
  CompanyPermission.SHIFTS_AMEND_RECORD_AGREEMENT,
  CompanyPermission.SHIFTS_AMEND_APPROVE,
  CompanyPermission.SHIFTS_AMEND_RESOLVE_DISPUTE,
  CompanyPermission.ATTENDANCE_VIEW,
  CompanyPermission.ATTENDANCE_MANAGE,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.TIMESHEETS_REVIEW,
  CompanyPermission.CLIENT_BILLING_VIEW,
  CompanyPermission.CLIENT_BILLING_SUBMIT,
  CompanyPermission.CLIENT_BILLING_CORRECT,
  CompanyPermission.PAYROLL_VIEW,
  CompanyPermission.PAYROLL_MANAGE,
  CompanyPermission.BILLING_VIEW,
  CompanyPermission.BILLING_MANAGE,
  CompanyPermission.INCIDENTS_VIEW,
  CompanyPermission.INCIDENTS_MANAGE,
  CompanyPermission.PERSONNEL_BASIC_VIEW,
  CompanyPermission.PERSONNEL_HR_VIEW,
  CompanyPermission.PERSONNEL_HR_MANAGE,
  CompanyPermission.PERSONNEL_BANK_VIEW,
  CompanyPermission.REPORTS_OPERATIONAL,
  CompanyPermission.REPORTS_FINANCIAL,
  CompanyPermission.PATROLS_VIEW,
  CompanyPermission.PATROLS_MANAGE,
  CompanyPermission.PATROLS_EVIDENCE,
  CompanyPermission.PATROLS_HOLDS,
  CompanyPermission.ALERTS_MANAGE,
]);

const OPERATIONS_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.SITES_VIEW,
  CompanyPermission.SITES_MANAGE,
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.CLIENTS_MANAGE,
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.GUARDS_MANAGE,
  CompanyPermission.COMPLIANCE_VIEW,
  CompanyPermission.SCREENING_VIEW,
  CompanyPermission.SHIFTS_VIEW,
  CompanyPermission.SHIFTS_MANAGE,
  CompanyPermission.SHIFTS_RECONCILE,
  CompanyPermission.SHIFTS_AMEND,
  CompanyPermission.SHIFTS_AMEND_RECORD_AGREEMENT,
  CompanyPermission.ATTENDANCE_VIEW,
  CompanyPermission.ATTENDANCE_MANAGE,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.TIMESHEETS_REVIEW,
  CompanyPermission.CLIENT_BILLING_VIEW,
  CompanyPermission.CLIENT_BILLING_SUBMIT,
  // client_billing.correct excluded — billing corrections are a Finance function
  // payroll.* excluded — financial data, not operational
  // billing.* excluded — contract pricing is commercially sensitive
  CompanyPermission.INCIDENTS_VIEW,
  CompanyPermission.INCIDENTS_MANAGE,
  CompanyPermission.PERSONNEL_BASIC_VIEW,
  CompanyPermission.REPORTS_OPERATIONAL,
  // reports.financial excluded — reveals billing rates / profit margins
  CompanyPermission.PATROLS_VIEW,
  CompanyPermission.PATROLS_MANAGE,
  CompanyPermission.PATROLS_EVIDENCE,
  // patrols.holds excluded — evidence holds are an Owner / Admin decision
  CompanyPermission.ALERTS_MANAGE,
]);

const CONTROL_ROOM_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.SITES_VIEW,
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.COMPLIANCE_VIEW,
  CompanyPermission.SHIFTS_VIEW,
  // Close without Book Off only: a control room cannot create, edit or cancel shifts (no shifts.manage).
  CompanyPermission.SHIFTS_RECONCILE,
  CompanyPermission.ATTENDANCE_VIEW,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.INCIDENTS_VIEW,
  CompanyPermission.INCIDENTS_MANAGE,
  CompanyPermission.PERSONNEL_BASIC_VIEW,
  CompanyPermission.REPORTS_OPERATIONAL,
  // Patrols: watch and review (including photo evidence), never configure (no patrols.manage) or hold.
  CompanyPermission.PATROLS_VIEW,
  CompanyPermission.PATROLS_EVIDENCE,
  // Patrol alerts: acknowledge, investigate, escalate and resolve them (owner decision, P1-C). Still no patrols.manage.
  CompanyPermission.ALERTS_MANAGE,
]);

const HR_COMPLIANCE_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.GUARDS_MANAGE,
  CompanyPermission.COMPLIANCE_VIEW,
  CompanyPermission.COMPLIANCE_MANAGE,
  CompanyPermission.SCREENING_VIEW,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.INCIDENTS_VIEW,
  CompanyPermission.PERSONNEL_BASIC_VIEW,
  CompanyPermission.PERSONNEL_HR_VIEW,
  CompanyPermission.PERSONNEL_HR_MANAGE,
  // personnel_bank.view excluded — bank details are a Finance function (payment processing)
  CompanyPermission.REPORTS_OPERATIONAL,
]);

const FINANCE_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.GUARDS_VIEW,
  // guards.view returns finance DTO only (no personal data) — enforced at service layer
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.CLIENT_BILLING_VIEW,
  CompanyPermission.CLIENT_BILLING_SUBMIT,
  CompanyPermission.CLIENT_BILLING_CORRECT,
  CompanyPermission.PAYROLL_VIEW,
  CompanyPermission.PAYROLL_MANAGE,
  CompanyPermission.BILLING_VIEW,
  CompanyPermission.BILLING_MANAGE,
  CompanyPermission.PERSONNEL_BANK_VIEW,
  CompanyPermission.REPORTS_FINANCIAL,
]);

const VIEWER_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.SITES_VIEW,
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.COMPLIANCE_VIEW,
  // compliance.view returns status only; document access requires compliance.manage
  CompanyPermission.SHIFTS_VIEW,
  CompanyPermission.ATTENDANCE_VIEW,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.CLIENT_BILLING_VIEW,
  CompanyPermission.INCIDENTS_VIEW,
  // Patrols: read-only; no photo evidence (patrols.evidence).
  CompanyPermission.PATROLS_VIEW,
]);

export const ROLE_PERMISSIONS: Record<CompanyMembershipRole, Set<CompanyPermission>> = {
  [CompanyMembershipRole.OWNER]: OWNER_PERMISSIONS,
  [CompanyMembershipRole.ADMIN]: ADMIN_PERMISSIONS,
  [CompanyMembershipRole.OPERATIONS]: OPERATIONS_PERMISSIONS,
  [CompanyMembershipRole.CONTROL_ROOM]: CONTROL_ROOM_PERMISSIONS,
  [CompanyMembershipRole.HR_COMPLIANCE]: HR_COMPLIANCE_PERMISSIONS,
  [CompanyMembershipRole.FINANCE]: FINANCE_PERMISSIONS,
  [CompanyMembershipRole.VIEWER]: VIEWER_PERMISSIONS,
};

export function hasPermission(role: CompanyMembershipRole, permission: CompanyPermission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Who may acknowledge / resolve a patrol alert (and its patrol exception): alerts.manage (owner decision, P1-C), or
 * patrols.manage (P1-B's rule, kept so no role that could act before loses the right). Never grants patrols.manage.
 */
export const PATROL_ALERT_ACT_PERMISSIONS: readonly CompanyPermission[] = [CompanyPermission.ALERTS_MANAGE, CompanyPermission.PATROLS_MANAGE];

export function mayActOnPatrolAlerts(role: CompanyMembershipRole): boolean {
  return PATROL_ALERT_ACT_PERMISSIONS.some((permission) => hasPermission(role, permission));
}
