import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fragment } from 'react/jsx-runtime';

import type {
  CompanyGuardInvitation,
  CompanyGuardInvitationCreated,
  CompanyGuardRelationshipType,
  CreateCompanyGuardInvitationPayload,
} from '../../types/models';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { StatusBadge } from '../StatusBadge';
import {
  ActionCell,
  MetaCell,
  PrimaryCell,
  StatusCell,
  TableEmptyState,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '../ui/TableFoundation';
import {
  RELATIONSHIP_TYPE_OPTIONS,
  invitationStatePresentation,
  maskSiaLicence,
  relationshipTypeLabel,
} from './workforceStatus';

const IS_WEB = typeof document !== 'undefined';

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export type CompanyGuardInvitationsPanelProps = {
  invitations: CompanyGuardInvitation[];
  loading: boolean;
  canManageGuards: boolean;
  onCreate: (payload: CreateCompanyGuardInvitationPayload) => Promise<CompanyGuardInvitationCreated>;
  onRevoke: (invitationId: number) => Promise<void>;
  onRefresh: () => void;
};

export function CompanyGuardInvitationsPanel({
  invitations,
  loading,
  canManageGuards,
  onCreate,
  onRevoke,
  onRefresh,
}: CompanyGuardInvitationsPanelProps) {
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [relationshipType, setRelationshipType] =
    React.useState<CompanyGuardRelationshipType>('APPROVED_CONTRACTOR');
  const [siaLicence, setSiaLicence] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // The one-time code lives only here. Dismissing this state destroys it: the server stores a digest,
  // so there is nothing to fetch again.
  const [issued, setIssued] = React.useState<CompanyGuardInvitationCreated | null>(null);
  const [copied, setCopied] = React.useState(false);

  const [revokeTarget, setRevokeTarget] = React.useState<CompanyGuardInvitation | null>(null);
  const [revokingId, setRevokingId] = React.useState<number | null>(null);

  const resetForm = React.useCallback(() => {
    setRelationshipType('APPROVED_CONTRACTOR');
    setSiaLicence('');
    setFormError(null);
  }, []);

  const closeInvite = React.useCallback(() => {
    setInviteOpen(false);
    resetForm();
  }, [resetForm]);

  const dismissIssued = React.useCallback(() => {
    setIssued(null);
    setCopied(false);
  }, []);

  const handleGenerate = React.useCallback(async () => {
    if (submitting) return;
    const trimmed = siaLicence.replace(/\s/g, '');
    if (trimmed && !/^\d{16}$/.test(trimmed)) {
      setFormError('An SIA licence number is 16 digits. Leave it blank if you do not have it.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await onCreate({
        relationshipType,
        ...(trimmed ? { targetSiaLicenceNumber: trimmed } : {}),
      });
      setInviteOpen(false);
      resetForm();
      setIssued(result);
      onRefresh();
    } catch (error) {
      setFormError((error as Error)?.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, siaLicence, relationshipType, onCreate, onRefresh, resetForm]);

  const handleCopy = React.useCallback(async () => {
    if (!issued) return;
    try {
      if (IS_WEB && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(issued.code);
        setCopied(true);
      }
    } catch {
      /* copying is a convenience; the code stays on screen either way */
    }
  }, [issued]);

  const confirmRevoke = React.useCallback(async () => {
    const target = revokeTarget;
    if (!target || revokingId !== null) return;
    setRevokingId(target.id);
    setRevokeTarget(null);
    try {
      await onRevoke(target.id);
    } finally {
      setRevokingId(null);
    }
  }, [revokeTarget, revokingId, onRevoke]);

  const pendingCount = invitations.filter((item) => item.state === 'PENDING').length;

  return (
    <View style={styles.wrapper}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.sectionTitle}>Invitations</Text>
          <Text style={styles.sectionSubtitle}>
            {pendingCount > 0
              ? `${pendingCount} invitation${pendingCount === 1 ? '' : 's'} waiting to be used.`
              : 'Invite a guard to join your workforce with a one-time code.'}
          </Text>
        </View>
        {canManageGuards ? (
          <Button label="Invite Guard" onPress={() => setInviteOpen(true)} />
        ) : null}
      </View>

      <View style={styles.tableCard}>
        <TableHeader>
          <TableHeaderCell label="Relationship" flex={1.6} />
          <TableHeaderCell label="For licence" flex={1.3} />
          <TableHeaderCell label="Created" flex={1} />
          <TableHeaderCell label="Expires" flex={1} />
          <TableHeaderCell label="Status" flex={1} />
          <TableHeaderCell label="" flex={0} width={92} align="right" />
        </TableHeader>

        {invitations.length === 0 ? (
          <TableEmptyState
            message={
              loading
                ? 'Loading invitations…'
                : 'No invitations yet. Use Invite Guard to create a one-time code, then share it with the guard.'
            }
          />
        ) : (
          invitations.map((invitation) => {
            const state = invitationStatePresentation(invitation.state);
            const masked = maskSiaLicence(invitation.targetSiaLicenceNumber);
            return (
              <Fragment key={invitation.id}>
              <TableRow>
                <PrimaryCell flex={1.6} label={relationshipTypeLabel(invitation.relationshipType)} />
                <MetaCell flex={1.3} value={masked ?? 'Any guard'} />
                <MetaCell flex={1} value={fmtDate(invitation.createdAt)} />
                <MetaCell flex={1} value={fmtDate(invitation.expiresAt)} />
                <StatusCell flex={1} label={state.label} tone={state.tone} />
                <ActionCell width={92}>
                  {invitation.state === 'PENDING' && canManageGuards ? (
                    <Button
                      label={revokingId === invitation.id ? 'Revoking…' : 'Revoke'}
                      variant="secondary"
                      size="sm"
                      onPress={() => setRevokeTarget(invitation)}
                      disabled={revokingId !== null}
                    />
                  ) : (
                    <Text style={styles.mutedSmall}>—</Text>
                  )}
                </ActionCell>
              </TableRow>
              </Fragment>
            );
          })
        )}
      </View>

      {/* ── Invite form ─────────────────────────────────────────────────────── */}
      <AppModal
        visible={inviteOpen}
        onClose={closeInvite}
        title="Invite a guard"
        subtitle="Generate a one-time code and share it with the guard."
        footer={
          <View style={styles.formActions}>
            <Button label="Cancel" variant="secondary" onPress={closeInvite} disabled={submitting} />
            <Button
              label="Generate Invitation"
              onPress={handleGenerate}
              loading={submitting}
              disabled={submitting}
            />
          </View>
        }
      >
        <View style={styles.form}>
          <Text style={styles.fieldLabel}>Relationship type</Text>
          <View style={styles.choiceRow}>
            {RELATIONSHIP_TYPE_OPTIONS.map((option) => {
              const active = relationshipType === option.value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setRelationshipType(option.value)}
                  disabled={submitting}
                  style={[styles.choice, active && styles.choiceActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.choiceText, active && styles.choiceTextActive]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, styles.fieldSpacing]}>SIA licence number (optional)</Text>
          <Text style={styles.fieldHelp}>
            If entered, only the guard with this SIA licence number can use this invitation.
          </Text>
          <TextInput
            value={siaLicence}
            onChangeText={setSiaLicence}
            editable={!submitting}
            placeholder="16 digits"
            placeholderTextColor={colors.fieldPlaceholder}
            keyboardType="number-pad"
            maxLength={16}
            style={styles.input}
            accessibilityLabel="SIA licence number, optional"
          />

          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        </View>
      </AppModal>

      {/* ── One-time code ───────────────────────────────────────────────────── */}
      <AppModal
        visible={!!issued}
        onClose={dismissIssued}
        title="Invitation code"
        footer={
          <View style={styles.formActions}>
            {IS_WEB ? (
              <Button
                label={copied ? 'Copied' : 'Copy Code'}
                variant="secondary"
                onPress={handleCopy}
              />
            ) : null}
            <Button label="Done" onPress={dismissIssued} />
          </View>
        }
      >
        {issued ? (
          <View style={styles.form}>
            <Text style={styles.codeCaption}>INVITATION CODE</Text>
            <View style={styles.codeBox}>
              <Text selectable style={styles.codeText}>
                {issued.code}
              </Text>
            </View>
            <Text style={styles.codeWarning}>
              Share this code with the guard. For security, it is shown only once.
            </Text>
            <Text style={styles.codeMeta}>
              {relationshipTypeLabel(issued.invitation.relationshipType)} · expires{' '}
              {fmtDate(issued.invitation.expiresAt)}
              {issued.invitation.targetSiaLicenceNumber
                ? ` · only for licence ${maskSiaLicence(issued.invitation.targetSiaLicenceNumber)}`
                : ''}
            </Text>
            <Text style={styles.responsibility}>{issued.responsibilityStatement}</Text>
          </View>
        ) : null}
      </AppModal>

      <ConfirmationDialog
        visible={!!revokeTarget}
        title="Revoke this invitation?"
        message={
          revokeTarget
            ? `The code for this ${relationshipTypeLabel(
                revokeTarget.relationshipType,
              )} invitation will stop working immediately.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={confirmRevoke}
        onClose={() => setRevokeTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  headerText: { flexShrink: 1, minWidth: 220, gap: 2 },
  sectionTitle: { ...typography.panelHeading, color: colors.textPrimary },
  sectionSubtitle: { ...typography.caption, color: colors.textMuted },
  tableCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.card,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  mutedSmall: { ...typography.caption, color: colors.textMuted },
  form: { gap: spacing.sm },
  fieldLabel: { ...typography.label, color: colors.textPrimary },
  fieldSpacing: { marginTop: spacing.sm },
  fieldHelp: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.xs },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choice: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.surfaceSubtle,
    minHeight: 36,
    justifyContent: 'center',
  },
  choiceActive: { borderColor: colors.accentTeal, backgroundColor: colors.accentTealSoft },
  choiceText: { ...typography.body, color: colors.textSecondary },
  choiceTextActive: { color: colors.accentTealStrong, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    color: colors.textPrimary,
    backgroundColor: colors.card,
    minHeight: 44,
  },
  errorText: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  codeCaption: { ...typography.label, color: colors.textMuted, letterSpacing: 1 },
  codeBox: {
    borderWidth: 1,
    borderColor: colors.accentTeal,
    backgroundColor: colors.accentTealSoft,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  // The token is long and opaque: wrap it rather than let it overflow a phone screen.
  codeText: { ...typography.bodyStrong, color: colors.textPrimary },
  codeWarning: { ...typography.body, color: colors.textPrimary, marginTop: spacing.xs },
  codeMeta: { ...typography.caption, color: colors.textMuted },
  responsibility: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
});
