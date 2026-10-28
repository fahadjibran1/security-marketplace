import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  changeCompanyStaffRole,
  formatApiErrorMessage,
  getCompanyStaff,
  getCompanyStaffAudit,
  inviteCompanyStaff,
  reactivateCompanyStaff,
  removeCompanyStaff,
  resendCompanyStaffInvitation,
  revokeCompanyStaffInvitation,
  setControlRoomAmendmentAuthorisation,
  setControlRoomAttendanceAuthorisation,
  suspendCompanyStaff,
} from '../../services/api';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import {
  confirmationCopy,
  describeStaffAudit,
  formatLastActivity,
  groupMembers,
  invitationStateLabel,
  STAFF_ROLE_DESCRIPTIONS,
  STAFF_STATUS_LABELS,
  StaffAuditEntry,
  StaffConfirmKind,
  StaffDirectory,
  StaffInvitation,
  StaffMember,
  StaffRole,
  validateStaffInvite,
} from './companyStaff';

type Pending =
  | { kind: 'suspend' | 'remove'; member: StaffMember }
  | { kind: 'change-role'; member: StaffMember; role: StaffRole }
  | { kind: 'revoke-invitation'; invitation: StaffInvitation };

function fmtDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Company web → Staff (Owner / Admin). Invite people by email, give them a role, switch the Control Room
 * permissions on or off, suspend, reactivate or remove access, and read the history of those changes.
 *
 * Every action is a press, and anything that takes access away asks for confirmation first. Nothing here writes on
 * load, refresh or a timer. The API re-checks every rule (Owner-only senior roles, the account holder, the last
 * Owner, company isolation); what this shows is only what the server said this person may do.
 */
export function CompanyStaffWorkspace() {
  const [directory, setDirectory] = React.useState<StaffDirectory | null>(null);
  const [history, setHistory] = React.useState<StaffAuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<StaffRole | null>(null);
  const [inviteError, setInviteError] = React.useState<string | null>(null);

  const [roleEditor, setRoleEditor] = React.useState<{ userId: number; role: StaffRole } | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [showRemoved, setShowRemoved] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const [staff, audit] = await Promise.allSettled([getCompanyStaff(), getCompanyStaffAudit()]);
    if (staff.status === 'fulfilled') setDirectory(staff.value);
    else setError(formatApiErrorMessage(staff.reason, 'Unable to load your staff.'));
    if (audit.status === 'fulfilled') setHistory(audit.value.entries ?? []);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** One request at a time; the list and history are re-read from the server afterwards. */
  const run = React.useCallback(async (action: () => Promise<unknown>, success: string, fallback: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await load();
      return true;
    } catch (err) {
      setError(formatApiErrorMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const sendInvite = React.useCallback(async () => {
    const problem = validateStaffInvite(inviteEmail, inviteRole);
    setInviteError(problem);
    if (problem || !inviteRole) return;
    const email = inviteEmail.trim();
    let emailSent = true;
    const ok = await run(async () => {
      const result = await inviteCompanyStaff(email, inviteRole);
      emailSent = result.emailSent;
    }, `Invitation sent to ${email}.`, 'The invitation could not be sent.');
    if (ok) {
      setInviteEmail('');
      setInviteRole(null);
      if (!emailSent) setNotice(`Invitation saved for ${email}, but the email could not be delivered. Try "Re-send" later.`);
    }
  }, [inviteEmail, inviteRole, run]);

  const confirmPending = React.useCallback(async () => {
    const p = pending;
    if (!p) return;
    let ok = false;
    if (p.kind === 'revoke-invitation') {
      const { invitation } = p;
      ok = await run(() => revokeCompanyStaffInvitation(invitation.id), `The invitation to ${invitation.email} has been withdrawn.`, 'Unable to withdraw this invitation.');
    } else if (p.kind === 'change-role') {
      const { member, role } = p;
      ok = await run(() => changeCompanyStaffRole(member.userId, role), `${member.displayName}'s role has been changed.`, 'Unable to change this role.');
    } else if (p.kind === 'suspend') {
      const { member } = p;
      ok = await run(() => suspendCompanyStaff(member.userId), `${member.displayName} has been suspended.`, 'Unable to suspend this person.');
    } else {
      const { member } = p;
      ok = await run(() => removeCompanyStaff(member.userId), `${member.displayName} has been removed.`, 'Unable to remove this person.');
    }
    setPending(null);
    if (ok && p.kind === 'change-role') setRoleEditor(null);
  }, [pending, run]);

  const toggleGrant = React.useCallback((member: StaffMember, grant: 'extensions' | 'attendance') => {
    if (grant === 'extensions') {
      const next = !member.canAmendShifts;
      void run(() => setControlRoomAmendmentAuthorisation(member.userId, next),
        `Shift extensions switched ${next ? 'on' : 'off'} for ${member.displayName}.`, 'Unable to change this permission.');
    } else {
      const next = !member.canManageAttendance;
      void run(() => setControlRoomAttendanceAuthorisation(member.userId, next),
        `Attendance management switched ${next ? 'on' : 'off'} for ${member.displayName}.`, 'Unable to change this permission.');
    }
  }, [run]);

  const roles = directory?.assignableRoles ?? [];
  const groups = groupMembers(directory?.members ?? []);
  const copy = pending
    ? confirmationCopy(
      pending.kind as StaffConfirmKind,
      pending.kind === 'revoke-invitation' ? pending.invitation.email : pending.member.displayName,
      pending.kind === 'change-role' ? { role: pending.role } : undefined,
    )
    : null;

  const renderMember = (member: StaffMember) => {
    const editing = roleEditor?.userId === member.userId;
    return (
      <View key={member.userId} style={styles.row} testID={`staff-member-${member.userId}`}>
        <View style={styles.rowMain}>
          <View style={styles.nameLine}>
            <Text style={styles.name}>{member.displayName}</Text>
            {member.isYou ? <StatusBadge label="You" tone="info" size="small" /> : null}
            {member.isPrimaryOwner ? <StatusBadge label="Account owner" tone="neutral" size="small" /> : null}
          </View>
          <Text style={styles.meta}>{member.email}</Text>
          <View style={styles.nameLine}>
            <StatusBadge label={member.roleLabel} tone="neutral" size="small" />
            <StatusBadge
              label={STAFF_STATUS_LABELS[member.status]}
              tone={member.status === 'active' ? 'success' : member.status === 'suspended' ? 'warning' : 'pending'}
              size="small"
            />
            <Text style={styles.meta}>Last sign-in: {formatLastActivity(member.lastLoginAt)}</Text>
          </View>
          {member.role === 'control_room' && member.status !== 'revoked' ? (
            <View style={styles.grants}>
              <Text style={styles.metaStrong}>Control Room permissions</Text>
              <GrantToggle
                label="Shift extensions"
                on={member.canAmendShifts}
                disabled={busy || !member.actions.grants}
                onPress={() => toggleGrant(member, 'extensions')}
                accessibilityLabel={`Shift extensions for ${member.displayName}`}
              />
              <GrantToggle
                label="Attendance management"
                on={member.canManageAttendance}
                disabled={busy || !member.actions.grants}
                onPress={() => toggleGrant(member, 'attendance')}
                accessibilityLabel={`Attendance management for ${member.displayName}`}
              />
            </View>
          ) : null}
          {editing ? (
            <View style={styles.roleEditor}>
              <Text style={styles.metaStrong}>New role</Text>
              <RolePicker roles={roles} value={roleEditor!.role} onChange={(role) => setRoleEditor({ userId: member.userId, role })} prefix={`${member.displayName} role`} />
              <View style={styles.actions}>
                <Button label="Cancel" variant="secondary" size="sm" onPress={() => setRoleEditor(null)} accessibilityLabel={`Cancel role change for ${member.displayName}`} />
                <Button
                  label="Save role"
                  size="sm"
                  disabled={busy || roleEditor!.role === member.role}
                  onPress={() => setPending({ kind: 'change-role', member, role: roleEditor!.role })}
                  accessibilityLabel={`Save role for ${member.displayName}`}
                />
              </View>
            </View>
          ) : null}
        </View>
        <View style={styles.actions}>
          {member.actions.changeRole && !editing ? (
            <Button label="Change role" variant="secondary" size="sm" disabled={busy}
              onPress={() => setRoleEditor({ userId: member.userId, role: member.role })}
              accessibilityLabel={`Change role for ${member.displayName}`} />
          ) : null}
          {member.actions.suspend ? (
            <Button label="Suspend" variant="secondary" size="sm" disabled={busy}
              onPress={() => setPending({ kind: 'suspend', member })} accessibilityLabel={`Suspend ${member.displayName}`} />
          ) : null}
          {member.actions.reactivate ? (
            <Button label="Reactivate" size="sm" disabled={busy}
              onPress={() => void run(() => reactivateCompanyStaff(member.userId), `${member.displayName} has been reactivated.`, 'Unable to reactivate this person.')}
              accessibilityLabel={`Reactivate ${member.displayName}`} />
          ) : null}
          {member.actions.remove ? (
            <Button label="Remove" variant="danger" size="sm" disabled={busy}
              onPress={() => setPending({ kind: 'remove', member })} accessibilityLabel={`Remove ${member.displayName}`} />
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.page} testID="company-staff-workspace">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Staff</Text>
          <Text style={styles.subtitle}>
            Invite your team, choose what each person can do, and control their access. Invited people set their own
            password; nobody else ever sees or sets it.
          </Text>
        </View>
        <Button label="Refresh" variant="secondary" size="sm" disabled={loading || busy} onPress={() => void load()} />
      </View>

      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="success" text={notice} /> : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Invite staff</Text>
        <Text style={styles.meta}>We email them a link. It works once and expires in 7 days.</Text>
        <Text style={styles.label}>Email address</Text>
        <TextInput
          value={inviteEmail}
          onChangeText={setInviteEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="name@yourcompany.co.uk"
          style={styles.input}
          accessibilityLabel="Invite email"
        />
        <Text style={styles.label}>Role</Text>
        <RolePicker roles={roles} value={inviteRole} onChange={setInviteRole} prefix="Invite role" />
        {inviteRole ? <Text style={styles.meta}>{STAFF_ROLE_DESCRIPTIONS[inviteRole]}</Text> : null}
        {inviteError ? <Text style={styles.fieldError}>{inviteError}</Text> : null}
        <View style={styles.actions}>
          <Button label="Send invitation" disabled={busy} loading={busy && !pending} onPress={() => void sendInvite()} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Team</Text>
        {loading && !directory ? <Text style={styles.meta}>Loading staff…</Text> : null}
        {groups.current.map(renderMember)}
        {groups.removed.length ? (
          <Pressable accessibilityRole="button" onPress={() => setShowRemoved((v) => !v)} style={styles.linkButton}>
            <Text style={styles.link}>{showRemoved ? 'Hide' : 'Show'} removed staff ({groups.removed.length})</Text>
          </Pressable>
        ) : null}
        {showRemoved ? groups.removed.map(renderMember) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pending invitations</Text>
        {directory && directory.invitations.length === 0 ? <Text style={styles.meta}>No invitations waiting.</Text> : null}
        {(directory?.invitations ?? []).map((invitation) => (
          <View key={invitation.id} style={styles.row} testID={`staff-invitation-${invitation.id}`}>
            <View style={styles.rowMain}>
              <Text style={styles.name}>{invitation.email}</Text>
              <View style={styles.nameLine}>
                <StatusBadge label={invitation.roleLabel} tone="neutral" size="small" />
                <StatusBadge label={invitationStateLabel(invitation.state)} tone={invitation.state === 'PENDING' ? 'info' : 'warning'} size="small" />
                <Text style={styles.meta}>{invitation.state === 'EXPIRED' ? 'Expired' : 'Expires'} {fmtDate(invitation.expiresAt)}</Text>
              </View>
            </View>
            {invitation.canManage ? (
              <View style={styles.actions}>
                <Button label="Re-send" variant="secondary" size="sm" disabled={busy}
                  onPress={() => void run(() => resendCompanyStaffInvitation(invitation.id), `A new invitation link was sent to ${invitation.email}.`, 'Unable to re-send this invitation.')}
                  accessibilityLabel={`Re-send invitation to ${invitation.email}`} />
                <Button label="Withdraw" variant="danger" size="sm" disabled={busy}
                  onPress={() => setPending({ kind: 'revoke-invitation', invitation })}
                  accessibilityLabel={`Withdraw invitation to ${invitation.email}`} />
              </View>
            ) : null}
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>History</Text>
        <Text style={styles.meta}>Every invitation, role, access and Control Room permission change, newest first.</Text>
        {history.length === 0 ? <Text style={styles.meta}>No staff changes recorded yet.</Text> : null}
        {history.map((entry) => (
          <View key={entry.id} style={styles.historyRow} testID={`staff-history-${entry.id}`}>
            <Text style={styles.historyText}>{describeStaffAudit(entry)}</Text>
            <Text style={styles.meta}>{fmtDate(entry.createdAt)}</Text>
          </View>
        ))}
      </View>

      <ConfirmationDialog
        visible={Boolean(pending && copy)}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        title={copy?.title ?? ''}
        message={copy?.message ?? ''}
        confirmLabel={copy?.confirmLabel}
        variant={copy?.danger ? 'danger' : 'standard'}
        loading={busy}
      />
    </View>
  );
}

function RolePicker({ roles, value, onChange, prefix }: {
  roles: Array<{ role: StaffRole; label: string }>;
  value: StaffRole | null;
  onChange: (role: StaffRole) => void;
  prefix: string;
}) {
  return (
    <View style={styles.chips}>
      {roles.map(({ role, label }) => {
        const selected = value === role;
        return (
          <Pressable
            key={role}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${prefix} ${label}`}
            onPress={() => onChange(role)}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function GrantToggle({ label, on, disabled, onPress, accessibilityLabel }: {
  label: string;
  on: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={styles.grantRow}
    >
      <View style={[styles.switchTrack, on && styles.switchTrackOn]}>
        <View style={[styles.switchThumb, on && styles.switchThumbOn]} />
      </View>
      <Text style={styles.grantText}>{`${label}: ${on ? 'On' : 'Off'}`}</Text>
    </Pressable>
  );
}

function Banner({ tone, text }: { tone: 'error' | 'success'; text: string }) {
  return (
    <View style={[styles.banner, tone === 'error' ? styles.bannerError : styles.bannerSuccess]}>
      <Text style={[styles.bannerText, { color: tone === 'error' ? colors.danger : colors.success }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, flexWrap: 'wrap' },
  title: { ...typography.pageTitle, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs, maxWidth: 720 },
  card: { backgroundColor: colors.card, borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm },
  cardTitle: { ...typography.panelHeading, color: colors.textPrimary },
  label: { ...typography.label, color: colors.textPrimary, marginTop: spacing.xs },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, paddingHorizontal: spacing.md, color: colors.textPrimary, backgroundColor: colors.card, maxWidth: 480 },
  fieldError: { ...typography.caption, color: colors.danger },
  meta: { ...typography.caption, color: colors.textSecondary },
  metaStrong: { ...typography.caption, color: colors.textPrimary, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, alignItems: 'flex-start' },
  rowMain: { flex: 1, minWidth: 260, gap: spacing.xs },
  nameLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.label, color: colors.textPrimary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  grants: { gap: spacing.xs, marginTop: spacing.xs, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.surfaceSubtle },
  grantRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36 },
  grantText: { ...typography.caption, color: colors.textPrimary },
  switchTrack: { width: 36, height: 20, borderRadius: 10, backgroundColor: colors.neutralSlate, padding: 2 },
  switchTrackOn: { backgroundColor: colors.accentTealStrong },
  switchThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.card },
  switchThumbOn: { transform: [{ translateX: 16 }] },
  roleEditor: { gap: spacing.sm, marginTop: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, minHeight: 36, justifyContent: 'center', borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  chipText: { ...typography.caption, color: colors.textPrimary },
  chipTextSelected: { color: colors.textOnBrand, fontWeight: '600' },
  linkButton: { paddingVertical: spacing.sm },
  link: { ...typography.caption, color: colors.accentTealStrong, fontWeight: '600' },
  historyRow: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 },
  historyText: { ...typography.caption, color: colors.textPrimary },
  banner: { padding: spacing.md, borderRadius: radii.sm, borderWidth: 1 },
  bannerError: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  bannerSuccess: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  bannerText: { ...typography.caption },
});
