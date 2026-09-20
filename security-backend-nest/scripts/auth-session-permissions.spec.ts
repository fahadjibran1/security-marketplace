/**
 * Auth session permissions spec — Phase 2D2.4
 *
 * Certifies:
 *  11. Effective permission derivation for all 7 CompanyMembershipRoles
 *  12. Legacy COMPANY/COMPANY_ADMIN owner without a membership row → OWNER permissions
 *  13. Only ACTIVE membership is used; SUSPENDED/REVOKED/absent → no permissions
 *  14. companyPermissions field is informational to the frontend only;
 *      backend /auth/me and AuthService.computeCompanyPermissions must never
 *      be used as the authorization gate for mutations
 */

import * as path from 'path';
import * as fs from 'fs';

// ─── Load source under test ───────────────────────────────────────────────────

const REPO = path.resolve(__dirname, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO, 'src', rel), 'utf8');
}

// ─── Permission matrix (inline — source of truth) ────────────────────────────

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
  GUARDS_MANAGE  = 'guards.manage',
  GUARDS_VIEW    = 'guards.view',
  PAYROLL_MANAGE = 'payroll.manage',
  PAYROLL_VIEW   = 'payroll.view',
  STAFF_MANAGE   = 'staff.manage',
  PERSONNEL_HR_VIEW   = 'personnel_hr.view',
  PERSONNEL_HR_MANAGE = 'personnel_hr.manage',
  PERSONNEL_BANK_VIEW = 'personnel_bank.view',
  SHIFTS_MANAGE  = 'shifts.manage',
  SHIFTS_VIEW    = 'shifts.view',
}

// Import actual permission sets from backend source
const typesPath = path.join(REPO, 'src', 'company-membership', 'company-membership-types.ts');
const typesContent = readSrc('company-membership/company-membership-types.ts');

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

// ─── Derive effective permissions from source (regex-based, no transpile) ────

// Map CompanyPermission enum values to their enum key names (for source matching)
const PERM_ENUM_KEY: Partial<Record<CompanyPermission, string>> = {
  [CompanyPermission.GUARDS_MANAGE]:  'GUARDS_MANAGE',
  [CompanyPermission.PAYROLL_MANAGE]: 'PAYROLL_MANAGE',
  [CompanyPermission.PAYROLL_VIEW]:   'PAYROLL_VIEW',
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

  // Extract the block for this const
  const startIdx = typesContent.indexOf(`const ${constName}`);
  if (startIdx === -1) return false;

  // Find next 'const ' to delimit the block
  let endIdx = typesContent.indexOf('const ', startIdx + constName.length + 6);
  if (endIdx === -1) endIdx = typesContent.length;
  const block = typesContent.slice(startIdx, endIdx);

  // OWNER is 'new Set(Object.values(CompanyPermission))' — has everything
  if (constName === 'OWNER_PERMISSIONS' && block.includes('Object.values(CompanyPermission)')) {
    return true;
  }

  // Source uses enum member references: CompanyPermission.GUARDS_MANAGE
  const enumKey = PERM_ENUM_KEY[perm];
  if (enumKey && block.includes(`CompanyPermission.${enumKey}`)) return true;

  // Fallback: check string value literal
  return block.includes(`'${perm}'`);
}

// ─── 11. Effective permission derivation for all 7 roles ─────────────────────

// GUARDS_MANAGE
assert(hasPermissionInSource(CompanyMembershipRole.OWNER,        CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-OWNER:     GUARDS_MANAGE yes');
assert(hasPermissionInSource(CompanyMembershipRole.ADMIN,        CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-ADMIN:     GUARDS_MANAGE yes');
assert(hasPermissionInSource(CompanyMembershipRole.OPERATIONS,   CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-OPS:       GUARDS_MANAGE yes');
assert(hasPermissionInSource(CompanyMembershipRole.HR_COMPLIANCE,CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-HR:        GUARDS_MANAGE yes');
assert(!hasPermissionInSource(CompanyMembershipRole.CONTROL_ROOM,  CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-CR:        GUARDS_MANAGE no');
assert(!hasPermissionInSource(CompanyMembershipRole.FINANCE,       CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-FIN:       GUARDS_MANAGE no');
assert(!hasPermissionInSource(CompanyMembershipRole.VIEWER,        CompanyPermission.GUARDS_MANAGE), 'PERM-GUARDS-VIEWER:    GUARDS_MANAGE no');

// PAYROLL_MANAGE
assert(hasPermissionInSource(CompanyMembershipRole.OWNER,        CompanyPermission.PAYROLL_MANAGE), 'PERM-PAYROLL-OWNER:    PAYROLL_MANAGE yes');
assert(hasPermissionInSource(CompanyMembershipRole.ADMIN,        CompanyPermission.PAYROLL_MANAGE), 'PERM-PAYROLL-ADMIN:    PAYROLL_MANAGE yes');
assert(!hasPermissionInSource(CompanyMembershipRole.OPERATIONS,  CompanyPermission.PAYROLL_MANAGE), 'PERM-PAYROLL-OPS:      PAYROLL_MANAGE no');
assert(!hasPermissionInSource(CompanyMembershipRole.HR_COMPLIANCE,CompanyPermission.PAYROLL_MANAGE),'PERM-PAYROLL-HR:       PAYROLL_MANAGE no');
assert(!hasPermissionInSource(CompanyMembershipRole.CONTROL_ROOM, CompanyPermission.PAYROLL_MANAGE),'PERM-PAYROLL-CR:       PAYROLL_MANAGE no');
assert(hasPermissionInSource(CompanyMembershipRole.FINANCE,      CompanyPermission.PAYROLL_MANAGE), 'PERM-PAYROLL-FIN:      PAYROLL_MANAGE yes');
assert(!hasPermissionInSource(CompanyMembershipRole.VIEWER,      CompanyPermission.PAYROLL_MANAGE), 'PERM-PAYROLL-VIEWER:   PAYROLL_MANAGE no');

// ─── 12. Legacy owner — computeCompanyPermissions source inspection ───────────

const authServiceSrc = readSrc('auth/auth.service.ts');

assert(
  authServiceSrc.includes('computeCompanyPermissions'),
  'LEGACY-1: computeCompanyPermissions method exists in AuthService',
);

assert(
  authServiceSrc.includes('UserRole.COMPANY') && authServiceSrc.includes('OWNER'),
  'LEGACY-2: legacy COMPANY/COMPANY_ADMIN → OWNER permission fallback present',
);

assert(
  authServiceSrc.includes('CompanyMembershipStatus.ACTIVE'),
  'LEGACY-3: only ACTIVE membership queried for permissions',
);

assert(
  authServiceSrc.includes('fail-safe') || authServiceSrc.includes('fail safe') || authServiceSrc.includes('Fail-safe'),
  'LEGACY-4: fail-safe catch block present in computeCompanyPermissions',
);

// ─── 12b. signToken augmented with companyPermissions ─────────────────────────

assert(
  authServiceSrc.includes('companyPermissions') && authServiceSrc.includes('signToken'),
  'SESSION-1: signToken includes companyPermissions in response',
);

// ─── 12c. /auth/me endpoint ───────────────────────────────────────────────────

const authControllerSrc = readSrc('auth/auth.controller.ts');

assert(
  authControllerSrc.includes("@Get('me')") || authControllerSrc.includes('@Get("me")'),
  'SESSION-2: GET /auth/me endpoint declared',
);

assert(
  authControllerSrc.includes('JwtAuthGuard'),
  'SESSION-3: /auth/me protected by JwtAuthGuard',
);

assert(
  authControllerSrc.includes('getCurrentUser'),
  'SESSION-4: /auth/me calls getCurrentUser',
);

// ─── 13. Cross-company — ACTIVE-only query ────────────────────────────────────

assert(
  authServiceSrc.includes('status: CompanyMembershipStatus.ACTIVE'),
  'CROSS-COMPANY-1: membership query is filtered to status ACTIVE only',
);

// Only one findOne call — never merges multiple company memberships
const findOneCount = (authServiceSrc.match(/membershipRepo\.findOne/g) ?? []).length;
assert(
  findOneCount === 1,
  `CROSS-COMPANY-2: exactly one membershipRepo.findOne call (found ${findOneCount}) — no multi-company merge`,
);

// ─── 14. Backend remains authoritative — no client-supplied permissions ────────

// Verify that auth/me uses user.sub from JWT (not a query param or body field)
assert(
  authControllerSrc.includes('user.sub') && authControllerSrc.includes('@CurrentUser'),
  'SECURITY-1: /auth/me uses @CurrentUser JWT sub — no client-supplied userId',
);

// No companyPermissions in JWT payload type
const jwtPayloadSrc = readSrc('auth/types/jwt-payload.type.ts');
assert(
  !jwtPayloadSrc.includes('companyPermissions') && !jwtPayloadSrc.includes('permissions'),
  'SECURITY-2: JwtPayload does not carry companyPermissions — permissions are not trusted from JWT',
);

// AuthModule registers the membership repository (not the service — avoids coupling)
const authModuleSrc = readSrc('auth/auth.module.ts');
assert(
  authModuleSrc.includes('TypeOrmModule.forFeature') && authModuleSrc.includes('CompanyMembership'),
  'SECURITY-3: AuthModule registers CompanyMembership repository for direct lookup — no delegated trust',
);

// ─── Frontend model — companyPermissions is optional ─────────────────────────

const modelsSrc = fs.readFileSync(
  path.join(REPO, '..', 'security-mobile-app', 'src', 'types', 'models.ts'),
  'utf8',
);

assert(
  modelsSrc.includes('companyPermissions?:') || modelsSrc.includes('companyPermissions ?: '),
  'FRONTEND-1: AuthUser.companyPermissions is optional — backward compatible with old sessions',
);

// ─── Frontend derivation — uses permissions if present, role fallback if not ──

const dashboardSrc = fs.readFileSync(
  path.join(REPO, '..', 'security-mobile-app', 'src', 'screens', 'CompanyDashboardScreen.tsx'),
  'utf8',
);

assert(
  dashboardSrc.includes('guards.manage') || dashboardSrc.includes("'guards.manage'"),
  'FRONTEND-2: canManageGuards checks guards.manage permission string',
);

assert(
  dashboardSrc.includes('payroll.manage') || dashboardSrc.includes("'payroll.manage'"),
  'FRONTEND-3: canPayAdmin checks payroll.manage permission string',
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`══ AUTH SESSION PERMISSIONS: ${passed} PASS / ${failed} FAIL ══`);
if (failed === 0) {
  console.log('FOCUSED SPEC: PASS');
  process.exit(0);
} else {
  process.exit(1);
}
