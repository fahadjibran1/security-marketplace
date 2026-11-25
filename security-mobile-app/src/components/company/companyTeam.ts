/**
 * Company Team (staff management): roles, their one-line descriptions, and who receives Emergency alerts.
 *
 * Pure so the certification suite executes it. Display only: the API decides who may invite, change and revoke
 * (the Owner, and members holding staff.manage, never beyond their own authority) and returns the roles the
 * signed-in person may grant as `grantableRoles`.
 */

export type TeamRole = 'owner' | 'admin' | 'operations' | 'control_room' | 'hr_compliance' | 'finance' | 'viewer';
export type TeamMemberStatus = 'active' | 'suspended' | 'revoked';
export type TeamInvitationState = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'CANCELLED';

export interface TeamMember {
  userId: number;
  name: string;
  email: string;
  role: TeamRole;
  status: TeamMemberStatus;
  joinedAt: string | null;
  isYou: boolean;
  receivesEmergencyAlerts: boolean;
  manageable: boolean;
}

export interface TeamInvitation {
  id: number;
  email: string;
  role: TeamRole;
  state: TeamInvitationState;
  createdAt: string;
  expiresAt: string;
}

export interface CompanyTeam {
  yourRole: TeamRole;
  grantableRoles: TeamRole[];
  members: TeamMember[];
  invitations: TeamInvitation[];
}

/** staff.manage, from the session; the legacy owner roles only when the session has no permission list. */
export function canManageTeam(companyPermissions?: string[] | null, role?: string | null): boolean {
  if (companyPermissions) return companyPermissions.includes('staff.manage');
  return role === 'company' || role === 'company_admin';
}

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operations: 'Operations',
  control_room: 'Control Room',
  hr_compliance: 'HR / Compliance',
  finance: 'Finance',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: 'The account that registered the company. Everything, including company settings.',
  admin: 'Everything except company settings, including managing the team.',
  operations: 'Runs day-to-day operations: sites, clients, guards, shifts, attendance and incidents.',
  control_room: 'Live operations: watches shifts, handles alerts and incidents, and closes shifts without Book Off.',
  hr_compliance: 'Guard records, compliance and screening. No finance or live operations.',
  finance: 'Billing, payroll and invoices. No HR records or live operations.',
  viewer: 'Read-only view of operations. Cannot change anything.',
};

/** Roles whose ACTIVE members are notified when a Guard raises an Emergency (alerts.manage), with the Owner. */
export const EMERGENCY_ALERT_ROLES: readonly TeamRole[] = ['owner', 'admin', 'operations', 'control_room'];

export function receivesEmergencyAlerts(role: TeamRole): boolean {
  return EMERGENCY_ALERT_ROLES.includes(role);
}

export const EMERGENCY_ALERT_NOTE =
  'Owner, Admin, Operations and Control Room receive Emergency alerts when a Guard raises one. HR / Compliance, Finance and Viewer do not.';

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as TeamRole] ?? role;
}

export function memberStatusLabel(status: TeamMemberStatus): { label: string; tone: 'success' | 'neutral' | 'danger' } {
  if (status === 'active') return { label: 'Active', tone: 'success' };
  return { label: 'Access revoked', tone: 'danger' };
}

export function invitationStateLabel(state: TeamInvitationState): { label: string; tone: 'warning' | 'neutral' } {
  if (state === 'PENDING') return { label: 'Waiting', tone: 'warning' };
  if (state === 'EXPIRED') return { label: 'Expired', tone: 'neutral' };
  if (state === 'ACCEPTED') return { label: 'Accepted', tone: 'neutral' };
  return { label: 'Cancelled', tone: 'neutral' };
}

/** The roles the person may choose in the invite form or a role change, in the order the API gives them. */
export function roleOptions(grantable: readonly TeamRole[] | null | undefined): Array<{ value: TeamRole; label: string; description: string; emergency: boolean }> {
  return (grantable ?? [])
    .filter((role) => role !== 'owner' && role in ROLE_LABELS)
    .map((role) => ({ value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role], emergency: receivesEmergencyAlerts(role) }));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The message to show for the invite form, or null when it can be sent. */
export function validateInvite(email: string, role: TeamRole | null, grantable: readonly TeamRole[]): string | null {
  const trimmed = email.trim();
  if (!EMAIL.test(trimmed)) return 'Enter the email address of the person you are inviting.';
  if (!role) return 'Choose a role.';
  if (!grantable.includes(role)) return 'You cannot give someone that role.';
  return null;
}

export const REVOKE_CONFIRMATION =
  'They will lose access to your company at once, and a team account will be signed out of S4 on every device. They will stop receiving Emergency alerts. This cannot be undone here: to give them access again, contact S4 support at support@sfour.co.uk.';
