import * as React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type {
  GuardCompanyMembership,
  GuardInvitationPreview,
} from '../../types/models';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { AppModal } from '../ui/Modal';
import { StatusBadge } from '../StatusBadge';
import {
  invitationErrorMessage,
  relationshipTypeLabel,
} from '../company/workforceStatus';

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

type Feedback = { tone: 'success' | 'info'; text: string } | null;

export type GuardCompaniesPanelProps = {
  companies: GuardCompanyMembership[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  onPreview: (code: string) => Promise<GuardInvitationPreview>;
  onAccept: (code: string) => Promise<unknown>;
  onDecline: (code: string) => Promise<unknown>;
};

/**
 * "My Companies" — the guard's own workforce memberships, plus joining a new one with a code.
 *
 * Read-only after joining, deliberately. Leaving a company would have to reckon with rostered shifts,
 * employment records and payroll already attached to that relationship, which is a lifecycle decision
 * rather than a UI one.
 */
export function GuardCompaniesPanel({
  companies,
  loading,
  onRefresh,
  onPreview,
  onAccept,
  onDecline,
}: GuardCompaniesPanelProps) {
  const [joinOpen, setJoinOpen] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [preview, setPreview] = React.useState<GuardInvitationPreview | null>(null);
  const [busy, setBusy] = React.useState<null | 'preview' | 'accept' | 'decline'>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<Feedback>(null);

  const closeJoin = React.useCallback(() => {
    setJoinOpen(false);
    // The code is a bearer secret: never leave it sitting in component state after the flow ends.
    setCode('');
    setPreview(null);
    setError(null);
    setBusy(null);
  }, []);

  const handlePreview = React.useCallback(async () => {
    if (busy) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the invitation code your company gave you.');
      return;
    }
    setBusy('preview');
    setError(null);
    try {
      // Preview only. Nothing is accepted until the guard chooses to.
      const result = await onPreview(trimmed);
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setError(invitationErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [busy, code, onPreview]);

  const handleAccept = React.useCallback(async () => {
    if (busy || !preview) return;
    const trimmed = code.trim();
    setBusy('accept');
    setError(null);
    try {
      await onAccept(trimmed);
      const companyName = preview.companyName;
      closeJoin();
      setFeedback({ tone: 'success', text: `You've joined ${companyName}'s workforce on S4.` });
      await onRefresh();
    } catch (err) {
      setError(invitationErrorMessage(err));
      setBusy(null);
    }
  }, [busy, preview, code, onAccept, onRefresh, closeJoin]);

  const [declineConfirm, setDeclineConfirm] = React.useState(false);

  const handleDecline = React.useCallback(async () => {
    if (busy || !preview) return;
    const trimmed = code.trim();
    setBusy('decline');
    setError(null);
    try {
      await onDecline(trimmed);
      const companyName = preview.companyName;
      setDeclineConfirm(false);
      closeJoin();
      setFeedback({ tone: 'info', text: `Invitation from ${companyName} declined.` });
    } catch (err) {
      setError(invitationErrorMessage(err));
      setBusy(null);
    }
  }, [busy, preview, code, onDecline, closeJoin]);

  return (
    <View style={styles.wrapper}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={styles.title}>My Companies</Text>
          <Text style={styles.subtitle}>
            {companies.length > 0
              ? `You are part of ${companies.length} workforce${companies.length === 1 ? '' : 's'}.`
              : 'Companies you work for will appear here once you join them.'}
          </Text>
        </View>
        <Button label="Join Company" onPress={() => setJoinOpen(true)} />
      </View>

      {feedback ? (
        <View style={[styles.feedback, feedback.tone === 'success' ? styles.feedbackSuccess : styles.feedbackInfo]}>
          <Text style={styles.feedbackText}>{feedback.text}</Text>
          <Button label="Dismiss" variant="tertiary" size="sm" onPress={() => setFeedback(null)} />
        </View>
      ) : null}

      {loading && companies.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>Loading your companies…</Text>
        </View>
      ) : companies.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>You have not joined a company yet</Text>
          <Text style={styles.emptyText}>
            If a company has given you an invitation code, use Join Company to enter it.
          </Text>
        </View>
      ) : (
        companies.map((membership) => (
          <View key={membership.companyId} style={styles.companyCard}>
            <View style={styles.companyHeader}>
              <Text style={styles.companyName}>{membership.companyName}</Text>
              <StatusBadge label={relationshipTypeLabel(membership.relationshipType)} tone="info" />
            </View>
            <Text style={styles.companyMeta}>
              {membership.acceptedAt
                ? `Joined ${fmtDate(membership.acceptedAt)}`
                : `In workforce since ${fmtDate(membership.since)}`}
            </Text>
          </View>
        ))
      )}

      {/* ── Join company ────────────────────────────────────────────────────── */}
      <AppModal
        visible={joinOpen}
        onClose={closeJoin}
        title="Join a company"
        subtitle="Enter the invitation code the company gave you."
        size="small"
        footer={
          preview ? (
            <View style={styles.actions}>
              <Button
                label="Decline"
                variant="secondary"
                onPress={() => setDeclineConfirm(true)}
                disabled={busy !== null}
              />
              <Button
                label="Accept"
                onPress={handleAccept}
                loading={busy === 'accept'}
                disabled={busy !== null}
              />
            </View>
          ) : (
            <View style={styles.actions}>
              <Button label="Cancel" variant="secondary" onPress={closeJoin} disabled={busy !== null} />
              <Button
                label="Preview"
                onPress={handlePreview}
                loading={busy === 'preview'}
                disabled={busy !== null}
              />
            </View>
          )
        }
      >
        <View style={styles.form}>
          {!preview ? (
            <>
              <Text style={styles.fieldLabel}>Invitation code</Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                editable={busy === null}
                placeholder="Paste or type the code"
                placeholderTextColor={colors.fieldPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                accessibilityLabel="Invitation code"
              />
            </>
          ) : (
            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>You have been invited to join</Text>
              <Text style={styles.previewCompany}>{preview.companyName}</Text>
              <Text style={styles.previewMeta}>
                As: {relationshipTypeLabel(preview.relationshipType)}
              </Text>
              <Text style={styles.previewMeta}>Invitation valid until {fmtDate(preview.expiresAt)}</Text>
              {preview.alreadyInWorkforce ? (
                <Text style={styles.previewNote}>You are already part of this workforce.</Text>
              ) : null}
            </View>
          )}

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      </AppModal>

      <AppModal
        visible={declineConfirm}
        onClose={() => setDeclineConfirm(false)}
        title="Decline invitation"
        size="small"
        footer={
          <View style={styles.actions}>
            <Button
              label="Keep it"
              variant="secondary"
              onPress={() => setDeclineConfirm(false)}
              disabled={busy !== null}
            />
            <Button
              label="Decline"
              variant="danger"
              onPress={handleDecline}
              loading={busy === 'decline'}
              disabled={busy !== null}
            />
          </View>
        }
      >
        <Text style={styles.confirmText}>
          {preview ? `Decline this invitation from ${preview.companyName}?` : ''}
        </Text>
        <Text style={styles.confirmHint}>The code will stop working and you will not join.</Text>
      </AppModal>
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
  headerText: { flexShrink: 1, minWidth: 200, gap: 2 },
  title: { ...typography.panelHeading, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textMuted },
  feedback: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.md,
    flexWrap: 'wrap',
  },
  feedbackSuccess: { borderColor: colors.successBorder, backgroundColor: colors.successSurface },
  feedbackInfo: { borderColor: colors.infoBorder, backgroundColor: colors.infoSurface },
  feedbackText: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  emptyCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.card,
    backgroundColor: colors.card,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  emptyTitle: { ...typography.bodyStrong, color: colors.textPrimary },
  emptyText: { ...typography.caption, color: colors.textMuted },
  companyCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.card,
    backgroundColor: colors.card,
    padding: spacing.md,
    gap: spacing.xs,
  },
  companyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  companyName: { ...typography.bodyStrong, color: colors.textPrimary, flexShrink: 1 },
  companyMeta: { ...typography.caption, color: colors.textMuted },
  form: { gap: spacing.sm },
  fieldLabel: { ...typography.label, color: colors.textPrimary },
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
  previewBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSubtle,
    padding: spacing.md,
    gap: spacing.xs,
  },
  previewLabel: { ...typography.caption, color: colors.textMuted },
  previewCompany: { ...typography.heading, color: colors.textPrimary },
  previewMeta: { ...typography.caption, color: colors.textSecondary },
  previewNote: { ...typography.caption, color: colors.textMuted, fontStyle: 'italic' },
  errorText: { ...typography.caption, color: colors.danger },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap' },
  confirmText: { ...typography.body, color: colors.textPrimary },
  confirmHint: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
});
