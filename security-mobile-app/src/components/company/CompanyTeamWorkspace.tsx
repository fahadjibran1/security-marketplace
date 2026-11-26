import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fragment } from 'react/jsx-runtime';

import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { ActionCell, MetaCell, PrimaryCell, StatusCell, TableEmptyState, TableHeader, TableHeaderCell, TableRow } from '../ui/TableFoundation';
import {
  cancelCompanyStaffInvitation,
  changeCompanyStaffRole,
  formatApiErrorMessage,
  getCompanyTeam,
  inviteCompanyStaff,
  revokeCompanyStaffAccess,
} from '../../services/api';
import {
  CompanyTeam,
  EMERGENCY_ALERT_NOTE,
  REVOKE_CONFIRMATION,
  TeamInvitation,
  TeamMember,
  TeamRole,
  invitationStateLabel,
  memberStatusLabel,
  roleLabel,
  roleOptions,
  validateInvite,
} from './companyTeam';

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Team: the company's staff and their access. Owner and staff.manage only (the API refuses anyone else). Members,
 * open invitations, invite by email, cancel, change role and revoke access (with confirmation).
 */
export function CompanyTeamWorkspace() {
  const [team, setTeam] = React.useState<CompanyTeam | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<TeamRole | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [roleTarget, setRoleTarget] = React.useState<TeamMember | null>(null);
  const [newRole, setNewRole] = React.useState<TeamRole | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<TeamMember | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<TeamInvitation | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setTeam(await getCompanyTeam());
      setError(null);
    } catch (e) {
      setError(formatApiErrorMessage(e, 'Your team could not be loaded. Try again.'));
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const grantable = team?.grantableRoles ?? [];
  const options = roleOptions(grantable);

  const closeInvite = () => { setInviteOpen(false); setEmail(''); setRole(null); setFormError(null); };

  async function sendInvite() {
    const problem = validateInvite(email, role, grantable);
    if (problem) { setFormError(problem); return; }
    setBusy(true);
    setFormError(null);
    try {
      const result = await inviteCompanyStaff(email, role!);
      closeInvite();
      setNotice(result.emailSent
        ? `Invitation sent to ${result.invitation.email}. The link works once and expires in 7 days.`
        : `The invitation for ${result.invitation.email} was created but the email could not be sent. Cancel it and try again.`);
      await load();
    } catch (e) {
      setFormError(formatApiErrorMessage(e, 'The invitation could not be sent. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      setNotice(success);
      setError(null);
    } catch (e) {
      setError(formatApiErrorMessage(e, 'That change could not be made. Try again.'));
    } finally {
      setBusy(false);
      await load();
    }
  }

  const members = team?.members ?? [];
  const invitations = team?.invitations ?? [];

  return (
    <View style={styles.wrapper} testID="company-team">
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.sectionTitle}>Team</Text>
          <Text style={styles.sectionSubtitle}>The people who can sign in to your company on S4, and what they can do.</Text>
        </View>
        {options.length > 0 ? <Button label="Invite team member" onPress={() => setInviteOpen(true)} disabled={busy} /> : null}
      </View>

      <View style={styles.note}><Text style={styles.noteText}>{EMERGENCY_ALERT_NOTE}</Text></View>
      {notice ? <View style={styles.success}><Text style={styles.successText}>{notice}</Text></View> : null}
      {error ? <View style={styles.danger}><Text style={styles.dangerText}>{error}</Text></View> : null}

      <Text style={styles.panelHeading}>Members</Text>
      <View style={styles.tableCard}>
        <TableHeader>
          <TableHeaderCell label="Name" flex={1.8} />
          <TableHeaderCell label="Role" flex={1.2} />
          <TableHeaderCell label="Joined" flex={1} />
          <TableHeaderCell label="Status" flex={1} />
          <TableHeaderCell label="" flex={0} width={200} align="right" />
        </TableHeader>
        {members.length === 0 ? (
          <TableEmptyState message={loading ? 'Loading your team…' : 'No team members yet.'} />
        ) : members.map((m) => {
          const status = memberStatusLabel(m.status);
          return (
            <Fragment key={m.userId}>
              <TableRow>
                <PrimaryCell flex={1.8} label={m.isYou ? `${m.name} (you)` : m.name} subtitle={m.email} />
                <MetaCell flex={1.2} value={`${roleLabel(m.role)}${m.receivesEmergencyAlerts ? ' · Emergency alerts' : ''}`} />
                <MetaCell flex={1} value={fmtDate(m.joinedAt)} />
                <StatusCell flex={1} label={status.label} tone={status.tone} />
                <ActionCell width={200}>
                  {m.manageable && m.status === 'active' ? (
                    <View style={styles.actions}>
                      <Button label="Change role" variant="secondary" size="sm" disabled={busy} onPress={() => { setRoleTarget(m); setNewRole(null); }} />
                      <Button label="Revoke" variant="secondary" size="sm" disabled={busy} onPress={() => setRevokeTarget(m)} />
                    </View>
                  ) : <Text style={styles.muted}>—</Text>}
                </ActionCell>
              </TableRow>
            </Fragment>
          );
        })}
      </View>

      <Text style={styles.panelHeading}>Pending invitations</Text>
      <View style={styles.tableCard}>
        <TableHeader>
          <TableHeaderCell label="Email" flex={1.8} />
          <TableHeaderCell label="Role" flex={1.2} />
          <TableHeaderCell label="Expires" flex={1} />
          <TableHeaderCell label="Status" flex={1} />
          <TableHeaderCell label="" flex={0} width={200} align="right" />
        </TableHeader>
        {invitations.length === 0 ? (
          <TableEmptyState message={loading ? 'Loading invitations…' : 'No invitations waiting.'} />
        ) : invitations.map((i) => {
          const state = invitationStateLabel(i.state);
          const mayCancel = grantable.includes(i.role);
          return (
            <Fragment key={i.id}>
              <TableRow>
                <PrimaryCell flex={1.8} label={i.email} />
                <MetaCell flex={1.2} value={roleLabel(i.role)} />
                <MetaCell flex={1} value={fmtDate(i.expiresAt)} />
                <StatusCell flex={1} label={state.label} tone={state.tone} />
                <ActionCell width={200}>
                  {mayCancel ? <Button label="Cancel invitation" variant="secondary" size="sm" disabled={busy} onPress={() => setCancelTarget(i)} /> : <Text style={styles.muted}>—</Text>}
                </ActionCell>
              </TableRow>
            </Fragment>
          );
        })}
      </View>

      <AppModal
        visible={inviteOpen}
        onClose={closeInvite}
        title="Invite a team member"
        subtitle="We email them a link to set their name and password. It works once and expires in 7 days."
        footer={
          <View style={styles.formActions}>
            <Button label="Cancel" variant="secondary" onPress={closeInvite} disabled={busy} />
            <Button label="Send invitation" onPress={sendInvite} loading={busy} disabled={busy} />
          </View>
        }
      >
        <View style={styles.form}>
          <Text style={styles.fieldLabel}>Email address</Text>
          <TextInput value={email} onChangeText={setEmail} editable={!busy} autoCapitalize="none" keyboardType="email-address" autoComplete="off" style={styles.input} accessibilityLabel="Email address" />
          <Text style={[styles.fieldLabel, styles.fieldSpacing]}>Role</Text>
          <RoleChoices options={options} selected={role} onSelect={setRole} disabled={busy} />
          <Text style={styles.fieldHelp}>{EMERGENCY_ALERT_NOTE}</Text>
          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        </View>
      </AppModal>

      <AppModal
        visible={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title={roleTarget ? `Change ${roleTarget.name}'s role` : 'Change role'}
        subtitle={roleTarget ? `Currently ${roleLabel(roleTarget.role)}. The change applies from their next sign-in or refresh.` : undefined}
        footer={
          <View style={styles.formActions}>
            <Button label="Cancel" variant="secondary" onPress={() => setRoleTarget(null)} disabled={busy} />
            <Button
              label="Change role"
              disabled={busy || !newRole || newRole === roleTarget?.role}
              onPress={() => {
                const target = roleTarget;
                const chosen = newRole;
                setRoleTarget(null);
                if (target && chosen) void run(() => changeCompanyStaffRole(target.userId, chosen), `${target.name} is now ${roleLabel(chosen)}.`);
              }}
            />
          </View>
        }
      >
        <RoleChoices options={options.filter((o) => o.value !== roleTarget?.role)} selected={newRole} onSelect={setNewRole} disabled={busy} />
      </AppModal>

      <ConfirmationDialog
        visible={!!revokeTarget}
        title={revokeTarget ? `Revoke ${revokeTarget.name}'s access?` : 'Revoke access?'}
        message={REVOKE_CONFIRMATION}
        confirmLabel="Revoke access"
        variant="danger"
        loading={busy}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => {
          const target = revokeTarget;
          setRevokeTarget(null);
          if (target) void run(() => revokeCompanyStaffAccess(target.userId), `${target.name}'s access has been revoked and they have been signed out.`);
        }}
      />

      <ConfirmationDialog
        visible={!!cancelTarget}
        title="Cancel this invitation?"
        message={cancelTarget ? `The link sent to ${cancelTarget.email} will stop working immediately.` : ''}
        confirmLabel="Cancel invitation"
        cancelLabel="Keep it"
        onClose={() => setCancelTarget(null)}
        onConfirm={() => {
          const target = cancelTarget;
          setCancelTarget(null);
          if (target) void run(() => cancelCompanyStaffInvitation(target.id), `The invitation for ${target.email} has been cancelled.`);
        }}
      />
    </View>
  );
}

function RoleChoices({ options, selected, onSelect, disabled }: {
  options: ReturnType<typeof roleOptions>;
  selected: TeamRole | null;
  onSelect: (role: TeamRole) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.choices}>
      {options.map((o) => {
        const active = selected === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onSelect(o.value)}
            disabled={disabled}
            style={[styles.choice, active && styles.choiceActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            testID={`team-role-${o.value}`}
          >
            <Text style={[styles.choiceTitle, active && styles.choiceTitleActive]}>
              {o.label}{o.emergency ? ' · receives Emergency alerts' : ''}
            </Text>
            <Text style={styles.choiceDescription}>{o.description}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap' },
  headerText: { flexShrink: 1, minWidth: 220, gap: 2 },
  sectionTitle: { ...typography.panelHeading, color: colors.textPrimary },
  sectionSubtitle: { ...typography.caption, color: colors.textMuted },
  panelHeading: { ...typography.label, color: colors.textPrimary, marginTop: spacing.sm },
  tableCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.card, backgroundColor: colors.card, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: spacing.xs, justifyContent: 'flex-end', flexWrap: 'wrap' },
  muted: { ...typography.caption, color: colors.textMuted },
  note: { padding: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSubtle },
  noteText: { ...typography.caption, color: colors.textSecondary },
  success: { padding: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.successBorder, backgroundColor: colors.successSurface },
  successText: { ...typography.caption, color: colors.success },
  danger: { padding: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerSurface },
  dangerText: { ...typography.caption, color: colors.danger },
  form: { gap: spacing.sm },
  fieldLabel: { ...typography.label, color: colors.textPrimary },
  fieldSpacing: { marginTop: spacing.sm },
  fieldHelp: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, color: colors.textPrimary, backgroundColor: colors.card, minHeight: 44 },
  errorText: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap' },
  choices: { gap: spacing.xs },
  choice: { padding: spacing.sm, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.surfaceSubtle, gap: 2 },
  choiceActive: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  choiceTitle: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },
  choiceTitleActive: { color: colors.accentTealStrong },
  choiceDescription: { ...typography.caption, color: colors.textMuted },
});
