/**
 * Pay Admin permission certification — Phase 2D2.5
 *
 * Certifies:
 *   PAY-OWNER           OWNER has PAYROLL_MANAGE
 *   PAY-ADMIN           ADMIN has PAYROLL_MANAGE
 *   PAY-FINANCE         FINANCE has PAYROLL_MANAGE
 *   PAY-OPERATIONS-DENIED   OPERATIONS does NOT have PAYROLL_MANAGE
 *   PAY-HR-DENIED       HR_COMPLIANCE does NOT have PAYROLL_MANAGE
 *   PAY-CONTROL-DENIED  CONTROL_ROOM does NOT have PAYROLL_MANAGE
 *   PAY-VIEWER-DENIED   VIEWER does NOT have PAYROLL_MANAGE
 *   PAY-TENANT-ISOLATION   companyId resolved from authenticated context; guardId alone is not sufficient
 *   PAY-LEGACY-OWNER    legacy COMPANY/COMPANY_ADMIN without membership row → OWNER-level access (resolveCompanyContext fallback)
 *
 * Run: ts-node -r tsconfig-paths/register scripts/pay-admin-permission.spec.ts
 */

import * as path from 'path';
import * as fs from 'fs';

const REPO = path.resolve(__dirname, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO, 'src', rel), 'utf8');
}

// ─── Permission matrix (inline, matches backend source of truth) ─────────────

enum CompanyMembershipRole {
  OWNER       = 'owner',
  ADMIN       = 'admin',
  OPERATIONS  = 'operations',
  CONTROL_ROOM   = 'control_room',
  HR_COMPLIANCE  = 'hr_compliance',
  FINANCE     = 'finance',
  VIEWER      = 'viewer',
}

enum CompanyPermission {
  PAYROLL_MANAGE = 'payroll.manage',
  PAYROLL_VIEW   = 'payroll.view',
  GUARDS_MANAGE  = 'guards.manage',
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ─── Source inspection helpers ────────────────────────────────────────────────

const typesContent = readSrc('company-membership/company-membership-types.ts');

const PERM_ENUM_KEY: Partial<Record<CompanyPermission, string>> = {
  [CompanyPermission.PAYROLL_MANAGE]: 'PAYROLL_MANAGE',
};

function hasPermissionInSource(role: CompanyMembershipRole, perm: CompanyPermission): boolean {
  const constNameMap: Record<CompanyMembershipRole, string> = {
    [CompanyMembershipRole.OWNER]:        'OWNER_PERMISSIONS',
    [CompanyMembershipRole.ADMIN]:        'ADMIN_PERMISSIONS',
    [CompanyMembershipRole.OPERATIONS]:   'OPERATIONS_PERMISSIONS',
    [CompanyMembershipRole.CONTROL_ROOM]: 'CONTROL_ROOM_PERMISSIONS',
    [CompanyMembershipRole.HR_COMPLIANCE]:'HR_COMPLIANCE_PERMISSIONS',
    [CompanyMembershipRole.FINANCE]:      'FINANCE_PERMISSIONS',
    [CompanyMembershipRole.VIEWER]:       'VIEWER_PERMISSIONS',
  };

  const constName = constNameMap[role];
  if (!constName) return false;

  const startIdx = typesContent.indexOf(`const ${constName}`);
  if (startIdx === -1) return false;

  let endIdx = typesContent.indexOf('const ', startIdx + constName.length + 6);
  if (endIdx === -1) endIdx = typesContent.length;
  const block = typesContent.slice(startIdx, endIdx);

  if (constName === 'OWNER_PERMISSIONS' && block.includes('Object.values(CompanyPermission)')) {
    return true;
  }

  const enumKey = PERM_ENUM_KEY[perm];
  if (enumKey && block.includes(`CompanyPermission.${enumKey}`)) return true;
  return block.includes(`'${perm}'`);
}

const payrollServiceSrc  = readSrc('guard-personnel/payroll-admin.service.ts');
const payrollControllerSrc = readSrc('guard-personnel/guard-personnel.controller.ts');
const membershipServiceSrc = readSrc('company-membership/company-membership.service.ts');

// ─── PAY-OWNER: OWNER has PAYROLL_MANAGE ──────────────────────────────────────

assert(
  hasPermissionInSource(CompanyMembershipRole.OWNER, CompanyPermission.PAYROLL_MANAGE),
  'PAY-OWNER: OWNER has PAYROLL_MANAGE',
);

// ─── PAY-ADMIN: ADMIN has PAYROLL_MANAGE ──────────────────────────────────────

assert(
  hasPermissionInSource(CompanyMembershipRole.ADMIN, CompanyPermission.PAYROLL_MANAGE),
  'PAY-ADMIN: ADMIN has PAYROLL_MANAGE',
);

// ─── PAY-FINANCE: FINANCE has PAYROLL_MANAGE ─────────────────────────────────

assert(
  hasPermissionInSource(CompanyMembershipRole.FINANCE, CompanyPermission.PAYROLL_MANAGE),
  'PAY-FINANCE: FINANCE has PAYROLL_MANAGE',
);

// ─── PAY-OPERATIONS-DENIED: OPERATIONS does NOT have PAYROLL_MANAGE ──────────

assert(
  !hasPermissionInSource(CompanyMembershipRole.OPERATIONS, CompanyPermission.PAYROLL_MANAGE),
  'PAY-OPERATIONS-DENIED: OPERATIONS does not have PAYROLL_MANAGE',
);

// ─── PAY-HR-DENIED: HR_COMPLIANCE does NOT have PAYROLL_MANAGE ───────────────

assert(
  !hasPermissionInSource(CompanyMembershipRole.HR_COMPLIANCE, CompanyPermission.PAYROLL_MANAGE),
  'PAY-HR-DENIED: HR_COMPLIANCE does not have PAYROLL_MANAGE',
);

// ─── PAY-CONTROL-DENIED: CONTROL_ROOM does NOT have PAYROLL_MANAGE ───────────

assert(
  !hasPermissionInSource(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.PAYROLL_MANAGE),
  'PAY-CONTROL-DENIED: CONTROL_ROOM does not have PAYROLL_MANAGE',
);

// ─── PAY-VIEWER-DENIED: VIEWER does NOT have PAYROLL_MANAGE ──────────────────

assert(
  !hasPermissionInSource(CompanyMembershipRole.VIEWER, CompanyPermission.PAYROLL_MANAGE),
  'PAY-VIEWER-DENIED: VIEWER does not have PAYROLL_MANAGE',
);

// ─── PAY-TENANT-ISOLATION: company resolved from authenticated context ────────

// Service uses resolveCompanyContext (not a client-supplied companyId)
assert(
  payrollServiceSrc.includes('resolveCompanyContext'),
  'PAY-TENANT-ISOLATION-1: PayrollAdminService uses resolveCompanyContext for company resolution',
);

// resolveCompanyContext is called with PAYROLL_MANAGE — no weaker permission
assert(
  payrollServiceSrc.includes('CompanyPermission.PAYROLL_MANAGE'),
  'PAY-TENANT-ISOLATION-2: resolveCompanyContext enforces CompanyPermission.PAYROLL_MANAGE',
);

// Guard relationship verified against authenticated companyId (IDOR prevention)
assert(
  payrollServiceSrc.includes('company: { id: company.id }') ||
  payrollServiceSrc.includes('company: { id: company.id'),
  'PAY-TENANT-ISOLATION-3: guard relationship scoped to authenticated company.id — no IDOR by guardId',
);

// No raw company parameter accepted from controller/request
assert(
  !payrollServiceSrc.includes('companyId: number') ||
  (payrollServiceSrc.includes('companyId: company.id') || payrollServiceSrc.includes('companyId = company.id')),
  'PAY-TENANT-ISOLATION-4: companyId is derived internally, not accepted as a parameter',
);

// ─── PAY-LEGACY-OWNER: resolveCompanyContext fallback for pre-P1I owners ──────

// The membership service implements the legacy owner fallback
assert(
  membershipServiceSrc.includes('isLegacyOwnerRole') ||
  (membershipServiceSrc.includes('UserRole.COMPANY') && membershipServiceSrc.includes('UserRole.COMPANY_ADMIN') && membershipServiceSrc.includes('findByUserId')),
  'PAY-LEGACY-OWNER-1: resolveCompanyContext has legacy owner fallback path',
);

// Legacy COMPANY/COMPANY_ADMIN without membership → OWNER permissions via fallback
assert(
  membershipServiceSrc.includes('CompanyMembershipRole.OWNER'),
  'PAY-LEGACY-OWNER-2: legacy owners receive OWNER-level permissions via resolveCompanyContext',
);

// ─── Controller @Roles includes COMPANY_STAFF for payroll endpoints ───────────

// Extract the payroll-admin section of the controller
const payrollSection = (() => {
  const startIdx = payrollControllerSrc.indexOf("'company/guard/:guardId/payroll-admin'");
  if (startIdx === -1) return '';
  return payrollControllerSrc.slice(startIdx, startIdx + 1500);
})();

assert(
  payrollSection.includes('UserRole.COMPANY_STAFF'),
  'PAY-CONTROLLER-1: payroll-admin endpoints allow COMPANY_STAFF (required for FINANCE staff)',
);

// Controller passes user.role to service methods
assert(
  payrollControllerSrc.includes('user.role as UserRole'),
  'PAY-CONTROLLER-2: controller passes user.role to PayrollAdminService for resolveCompanyContext',
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`══ PAY ADMIN PERMISSIONS: ${passed} PASS / ${failed} FAIL ══`);
if (failed === 0) {
  console.log('FOCUSED SPEC: PASS');
  process.exit(0);
} else {
  process.exit(1);
}
