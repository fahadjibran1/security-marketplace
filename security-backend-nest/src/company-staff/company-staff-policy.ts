import { UserRole } from '../user/entities/user.entity';
import { CompanyMembershipRole } from '../company-membership/company-membership-types';

/**
 * Company staff management rules (owner-approved 27 Oct 2026). Pure, so the certification suite executes them and
 * the company web mirrors them for display; every route re-checks them on the server under a row lock.
 *
 * Who manages staff: holders of staff.manage — Owner and Admin (company-membership-types.ts). Within that:
 *  - Only an Owner may invite, promote to, change, suspend or remove an Owner or an Admin. An Admin manages the
 *    other roles (Operations, Control Room, HR & Compliance, Finance, Viewer) and nobody senior to them.
 *  - Nobody changes their own role or access here (no self-promotion, no accidental self-lockout).
 *  - The company's account owner (companies.userId, the legacy Owner) is never changed, suspended or removed
 *    here — so a company always keeps at least that Owner — and the last remaining Owner can never be demoted,
 *    suspended or removed (checked under lock in the service as well).
 */

export const ROLE_LABELS: Record<CompanyMembershipRole, string> = {
  [CompanyMembershipRole.OWNER]: 'Owner',
  [CompanyMembershipRole.ADMIN]: 'Admin',
  [CompanyMembershipRole.OPERATIONS]: 'Operations',
  [CompanyMembershipRole.CONTROL_ROOM]: 'Control Room',
  [CompanyMembershipRole.HR_COMPLIANCE]: 'HR & Compliance',
  [CompanyMembershipRole.FINANCE]: 'Finance',
  [CompanyMembershipRole.VIEWER]: 'Viewer',
};

/** Roles only an Owner may grant, change or take away. */
export const SENIOR_ROLES: readonly CompanyMembershipRole[] = [CompanyMembershipRole.OWNER, CompanyMembershipRole.ADMIN];

export function isStaffManager(role: CompanyMembershipRole): boolean {
  return role === CompanyMembershipRole.OWNER || role === CompanyMembershipRole.ADMIN;
}

/** The roles this actor may invite someone into or move someone to. */
export function assignableRoles(actorRole: CompanyMembershipRole): CompanyMembershipRole[] {
  if (actorRole === CompanyMembershipRole.OWNER) return Object.values(CompanyMembershipRole);
  if (actorRole === CompanyMembershipRole.ADMIN) {
    return Object.values(CompanyMembershipRole).filter((role) => !SENIOR_ROLES.includes(role));
  }
  return [];
}

export type StaffTarget = {
  userId: number;
  role: CompanyMembershipRole;
  /** companies.userId: the company's account holder. */
  isPrimaryOwner: boolean;
};

export type StaffRefusal =
  | 'not_a_manager'
  | 'primary_owner'
  | 'self'
  | 'senior_role_owner_only'
  | 'role_not_assignable'
  | 'last_owner';

export const STAFF_REFUSAL_MESSAGES: Record<StaffRefusal, string> = {
  not_a_manager: 'Only an Owner or Admin can manage company staff.',
  primary_owner: "The company's account owner can't be changed, suspended or removed here.",
  self: "You can't change your own role or access.",
  senior_role_owner_only: 'Only an Owner can change, suspend or remove an Owner or Admin.',
  role_not_assignable: 'Only an Owner can give someone the Owner or Admin role.',
  last_owner: 'A company must always keep at least one active Owner.',
};

/** Whether the actor may act on this member at all (role change, suspend, reactivate, remove). */
export function manageRefusal(actor: { userId: number; role: CompanyMembershipRole }, target: StaffTarget): StaffRefusal | null {
  if (!isStaffManager(actor.role)) return 'not_a_manager';
  if (target.isPrimaryOwner) return 'primary_owner';
  if (target.userId === actor.userId) return 'self';
  if (SENIOR_ROLES.includes(target.role) && actor.role !== CompanyMembershipRole.OWNER) return 'senior_role_owner_only';
  return null;
}

export function roleChangeRefusal(
  actor: { userId: number; role: CompanyMembershipRole },
  target: StaffTarget,
  nextRole: CompanyMembershipRole,
  otherActiveOwners: number,
): StaffRefusal | null {
  const refusal = manageRefusal(actor, target);
  if (refusal) return refusal;
  if (!assignableRoles(actor.role).includes(nextRole)) return 'role_not_assignable';
  if (target.role === CompanyMembershipRole.OWNER && nextRole !== CompanyMembershipRole.OWNER && otherActiveOwners < 1) {
    return 'last_owner';
  }
  return null;
}

/** Suspending or removing takes an Owner out of the active Owners, so it is held to the same last-Owner rule. */
export function accessChangeRefusal(
  actor: { userId: number; role: CompanyMembershipRole },
  target: StaffTarget,
  otherActiveOwners: number,
): StaffRefusal | null {
  const refusal = manageRefusal(actor, target);
  if (refusal) return refusal;
  if (target.role === CompanyMembershipRole.OWNER && otherActiveOwners < 1) return 'last_owner';
  return null;
}

/**
 * The account role a staff member's user row carries. Owner and Admin members sit in the company-admin account role
 * (the routes guarded by COMPANY_ADMIN_ROLES); everyone else is company staff. What they may actually do is always the
 * membership's permission set, resolved per request by CompanyMembershipService.
 */
export function userRoleForMembership(role: CompanyMembershipRole): UserRole {
  return SENIOR_ROLES.includes(role) ? UserRole.COMPANY_ADMIN : UserRole.COMPANY_STAFF;
}

/**
 * Which existing S4 accounts may accept a staff invitation. Never a Guard, a platform administrator, a client portal
 * account, the holder of a company, a deleted or platform-suspended account, or anyone still bound to a company
 * (ACTIVE or SUSPENDED membership — CompanyMembershipService.canAcceptInvitation).
 */
export function existingAccountRefusal(account: {
  role: UserRole;
  status: string;
  deleted: boolean;
  ownsCompany: boolean;
  boundToCompany: boolean;
}): string | null {
  if (account.deleted) return 'deleted';
  if (![UserRole.COMPANY_STAFF, UserRole.COMPANY_ADMIN, UserRole.COMPANY].includes(account.role)) return `account_role_${account.role}`;
  if (account.status !== 'active') return 'account_not_active';
  if (account.ownsCompany) return 'owns_company';
  if (account.boundToCompany) return 'bound_to_company';
  return null;
}

/** Normalised for storage and comparison: trimmed and lower-cased. */
export function normaliseStaffEmail(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}
