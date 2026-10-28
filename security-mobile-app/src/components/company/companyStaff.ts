/**
 * Company staff management (company web): the pure rules the Staff section uses. Executed by the certification suite
 * (scripts/company-staff-ui.spec.cjs). Everything here is display only — the API re-checks every action, under lock,
 * against the caller's own company.
 */

export type StaffRole = 'owner' | 'admin' | 'operations' | 'control_room' | 'hr_compliance' | 'finance' | 'viewer';
export type StaffStatus = 'active' | 'suspended' | 'revoked';
export type StaffInvitationState = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operations: 'Operations',
  control_room: 'Control Room',
  hr_compliance: 'HR & Compliance',
  finance: 'Finance',
  viewer: 'Viewer',
};

/** One line on what each role is for, shown beside the role picker. */
export const STAFF_ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  owner: 'Everything, including company settings. Only an Owner can add or change Owners and Admins.',
  admin: 'Everything except company settings, including managing staff (but not Owners or Admins).',
  operations: 'Sites, clients, Guards, shifts, attendance and incidents. No payroll, billing or HR records.',
  control_room: 'Live operations and incidents. Extensions and attendance only when you switch them on below.',
  hr_compliance: 'Guard records, compliance and screening. No bank details, payroll or billing.',
  finance: 'Timesheets, payroll, billing and invoices. No HR records or operational management.',
  viewer: 'Read-only operational view. No financial or HR records.',
};

export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  revoked: 'Removed',
};

export type StaffMember = {
  userId: number;
  membershipId: number | null;
  displayName: string;
  email: string;
  role: StaffRole;
  roleLabel: string;
  status: StaffStatus;
  isPrimaryOwner: boolean;
  isYou: boolean;
  canAmendShifts: boolean;
  canManageAttendance: boolean;
  lastLoginAt: string | null;
  joinedAt: string | null;
  disabledAt: string | null;
  actions: { changeRole: boolean; suspend: boolean; reactivate: boolean; remove: boolean; grants: boolean };
};

export type StaffInvitation = {
  id: number;
  email: string;
  role: StaffRole;
  roleLabel: string;
  state: StaffInvitationState;
  createdAt: string;
  expiresAt: string;
  invitedByUserId: number;
  canManage: boolean;
};

export type StaffDirectory = {
  you: { userId: number; role: StaffRole; isPrimaryOwner: boolean };
  assignableRoles: Array<{ role: StaffRole; label: string }>;
  members: StaffMember[];
  invitations: StaffInvitation[];
};

export type StaffAuditEntry = {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  actorUserId: number | null;
  actorName: string | null;
  targetUserId: number | null;
  targetName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * Whether the signed-in user should see the Staff section: staff.manage (Owner, Admin). A session without
 * companyPermissions is a legacy owner session (company / company_admin), exactly as the rest of the dashboard reads it.
 */
export function canManageStaffFromSession(companyPermissions: string[] | undefined | null, role: string | undefined | null): boolean {
  if (companyPermissions) return companyPermissions.includes('staff.manage');
  return role === 'company' || role === 'company_admin';
}

export function roleLabel(role: string | null | undefined): string {
  return (role && STAFF_ROLE_LABELS[role as StaffRole]) || 'Staff';
}

/** The message to show for the invite form, or null when it can be sent. */
export function validateStaffInvite(email: string, role: string | null): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Enter the email address of the person you are inviting.';
  if (trimmed.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Enter a valid email address.';
  if (!role) return 'Choose a role for this person.';
  return null;
}

export type StaffConfirmKind = 'suspend' | 'remove' | 'revoke-invitation' | 'change-role';

/** What a confirmation says, in words: who, and exactly what happens to their access. */
export function confirmationCopy(kind: StaffConfirmKind, name: string, extra?: { role?: string }) {
  switch (kind) {
    case 'suspend':
      return {
        title: `Suspend ${name}?`,
        message: `${name} will lose access to your company in S4 straight away and will be signed out of the S4 app on every device. You can reactivate them later.`,
        confirmLabel: 'Suspend access',
        danger: true,
      };
    case 'remove':
      return {
        title: `Remove ${name}?`,
        message: `${name} will be removed from your company and signed out of the S4 app on every device. Their Control Room permissions are cleared. To bring them back you will need to invite them again. Their history is kept.`,
        confirmLabel: 'Remove from company',
        danger: true,
      };
    case 'revoke-invitation':
      return {
        title: 'Withdraw this invitation?',
        message: `The invitation link sent to ${name} will stop working. You can invite them again later.`,
        confirmLabel: 'Withdraw invitation',
        danger: true,
      };
    case 'change-role':
    default:
      return {
        title: `Change ${name}'s role?`,
        message: `${name} will become ${roleLabel(extra?.role)}. What they can see and do in S4 changes on their next action.${extra?.role && extra.role !== 'control_room' ? ' Any Control Room permissions are switched off.' : ''}`,
        confirmLabel: 'Change role',
        danger: false,
      };
  }
}

export function invitationStateLabel(state: StaffInvitationState): string {
  return state === 'PENDING' ? 'Pending' : state === 'EXPIRED' ? 'Expired' : state === 'ACCEPTED' ? 'Accepted' : 'Withdrawn';
}

const yesNo = (v: unknown) => (v ? 'on' : 'off');

/** One readable line per history entry. Names come from the server; never an email of another company. */
export function describeStaffAudit(entry: StaffAuditEntry): string {
  const actor = entry.actorName ?? 'S4';
  const target = entry.targetName ?? 'a staff member';
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  switch (entry.action) {
    case 'company_staff_invitation.created':
      return `${actor} invited ${String(after.email ?? 'someone')} as ${roleLabel(after.role as string)}`;
    case 'company_staff_invitation.resent':
      return `${actor} re-sent the invitation to ${String(after.email ?? 'someone')}`;
    case 'company_staff_invitation.revoked':
      return after.reason === 'superseded'
        ? `An earlier invitation to ${String(after.email ?? 'someone')} was replaced by a new one`
        : `${actor} withdrew the invitation to ${String(after.email ?? 'someone')}`;
    case 'company_staff_invitation.accepted':
      return `${target} accepted the invitation and joined as ${roleLabel(after.role as string)}${after.accountCreated ? ' (new S4 account)' : ''}`;
    case 'company_staff.role_changed':
      return `${actor} changed ${target}'s role from ${roleLabel((after.previousRole ?? before.role) as string)} to ${roleLabel(after.role as string)}${after.grantsCleared ? '; Control Room permissions switched off' : ''}`;
    case 'company_staff.suspended':
      return `${actor} suspended ${target}'s access`;
    case 'company_staff.reactivated':
      return `${actor} reactivated ${target}'s access`;
    case 'company_staff.removed':
      return `${actor} removed ${target} from the company`;
    case 'company_membership.amendment_authorisation':
      return `${actor} switched shift extensions ${yesNo(after.canAmendShifts)} for ${target}`;
    case 'company_membership.attendance_authorisation':
      return `${actor} switched attendance management ${yesNo(after.canManageAttendance)} for ${target}`;
    default:
      return `${actor}: ${entry.action}`;
  }
}

/** "Never" when the person has never signed in; otherwise a short date and time. */
export function formatLastActivity(value: string | null | undefined): string {
  if (!value) return 'Never signed in';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Active first, then suspended, then removed; the account holder at the top. */
export function groupMembers(members: StaffMember[]) {
  return {
    current: members.filter((m) => m.status !== 'revoked'),
    removed: members.filter((m) => m.status === 'revoked'),
  };
}
