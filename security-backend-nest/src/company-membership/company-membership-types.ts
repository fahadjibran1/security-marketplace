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
  ATTENDANCE_VIEW = 'attendance.view',
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
}

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
  CompanyPermission.ATTENDANCE_VIEW,
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
  CompanyPermission.ATTENDANCE_VIEW,
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
]);

const CONTROL_ROOM_PERMISSIONS: Set<CompanyPermission> = new Set([
  CompanyPermission.SITES_VIEW,
  CompanyPermission.CLIENTS_VIEW,
  CompanyPermission.GUARDS_VIEW,
  CompanyPermission.COMPLIANCE_VIEW,
  CompanyPermission.SHIFTS_VIEW,
  CompanyPermission.ATTENDANCE_VIEW,
  CompanyPermission.TIMESHEETS_VIEW,
  CompanyPermission.INCIDENTS_VIEW,
  CompanyPermission.INCIDENTS_MANAGE,
  CompanyPermission.PERSONNEL_BASIC_VIEW,
  CompanyPermission.REPORTS_OPERATIONAL,
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
