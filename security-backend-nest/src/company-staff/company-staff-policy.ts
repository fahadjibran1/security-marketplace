import {
  CompanyMembershipRole,
  CompanyPermission,
  ROLE_PERMISSIONS,
  hasPermission,
} from '../company-membership/company-membership-types';

/**
 * Who may manage a company's staff, and what they may grant (company staff management, owner-approved).
 *
 * Rules, all enforced on the server:
 *   - Only the Owner and members holding staff.manage (today: Admin) manage staff at all.
 *   - Nobody can grant Owner. There is one Owner, the account that registered the company.
 *   - Nobody can grant a role carrying a permission they do not hold themselves.
 *   - Admin is granted by the Owner only. (An Admin holds every Admin permission, so the subset rule alone would let
 *     an Admin create more Admins; the permission model gives no reason to allow that, so it is not allowed.)
 *   - The same test applies to a member's CURRENT role before it can be changed or revoked: an Admin cannot change or
 *     revoke another Admin.
 *   - Nobody can change or revoke the Owner, or themselves.
 */

/** Roles a company invitation or role change may name. Owner is never one of them. */
export const ASSIGNABLE_ROLES: readonly CompanyMembershipRole[] = [
  CompanyMembershipRole.ADMIN,
  CompanyMembershipRole.OPERATIONS,
  CompanyMembershipRole.CONTROL_ROOM,
  CompanyMembershipRole.HR_COMPLIANCE,
  CompanyMembershipRole.FINANCE,
  CompanyMembershipRole.VIEWER,
];

export function mayManageStaff(actorRole: CompanyMembershipRole): boolean {
  return actorRole === CompanyMembershipRole.OWNER || hasPermission(actorRole, CompanyPermission.STAFF_MANAGE);
}

/** May `actorRole` give someone `role` (by invitation or role change), or act on a member who holds it? */
export function mayGrantRole(actorRole: CompanyMembershipRole, role: CompanyMembershipRole): boolean {
  if (!mayManageStaff(actorRole)) return false;
  if (!ASSIGNABLE_ROLES.includes(role)) return false; // owner, or anything unknown
  if (role === CompanyMembershipRole.ADMIN && actorRole !== CompanyMembershipRole.OWNER) return false;
  const own = ROLE_PERMISSIONS[actorRole];
  const wanted = ROLE_PERMISSIONS[role];
  if (!own || !wanted) return false;
  for (const permission of wanted) if (!own.has(permission)) return false;
  return true;
}

export function grantableRoles(actorRole: CompanyMembershipRole): CompanyMembershipRole[] {
  return ASSIGNABLE_ROLES.filter((role) => mayGrantRole(actorRole, role));
}

/** Roles whose ACTIVE members are notified of a Guard's Emergency (alerts.manage), alongside the Owner. */
export function receivesEmergencyAlerts(role: CompanyMembershipRole): boolean {
  return role === CompanyMembershipRole.OWNER || hasPermission(role, CompanyPermission.ALERTS_MANAGE);
}
