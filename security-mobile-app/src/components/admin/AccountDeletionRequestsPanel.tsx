import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { FieldInput, FormField } from '../ui/FormField';
import { S4LegalLinks } from '../account/S4LegalLinks';
import {
  ApiError, completeAccountDeletionRequest, formatApiErrorMessage, getAccountDeletionPreview, listAccountDeletionRequests,
  recordAccountDeletionRequest,
  type AdminDeletionPreview, type AdminDeletionRequest, type DeletionVerificationMethod,
} from '../../services/api';
import {
  canConfirmCompletion, companySummaryLines, DELETION_ACCOUNT_TYPE_LABEL, DELETION_VERIFICATION_METHODS,
  DELETION_VERIFICATION_NOTE_MAX, deletionCompletionConfirmation, deletionRequestError, OWNER_RESOLUTION_GUIDANCE,
  recordRequestEmailError, recordRequestVerificationError,
} from '../../navigation/account-deletion-requests';

const when = (value?: string | null) => (value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded');
const keyOf = (row: Pick<AdminDeletionRequest, 'kind' | 'id'>) => `${row.kind}:${row.id}`;
const errorCode = (error: unknown) => (error instanceof ApiError ? ((error.body as { code?: string } | null)?.code ?? null) : null);

/** A small tick box / radio row: the Pressable is the control, announced with its role and state. */
function Choice({ label, checked, onPress, role }: { label: string; checked: boolean; onPress: () => void; role: 'checkbox' | 'radio' }) {
  return (
    <Pressable onPress={onPress} accessibilityRole={role} accessibilityState={{ checked }} accessibilityLabel={label} style={styles.choice}>
      <View style={[role === 'radio' ? styles.radio : styles.box, checked ? styles.boxChecked : null]}>
        {checked ? <Text style={styles.tick}>{role === 'radio' ? '●' : '✓'}</Text> : null}
      </View>
      <Text style={styles.choiceLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Platform Admin → Account deletion requests. Lists every recorded request that is not yet complete (company owners,
 * Platform Admins, client portal logins, emailed requests and any other account), records a request received by email
 * with how it was verified, shows a read-only summary of what the account owns before completion, and completes a
 * request after a confirmation. Personal deletion never closes a company: an owner's request waits until each company is
 * closed on the Company verification screen or ownership is transferred through S4 support. The backend decides what is
 * allowed and audits every step; the screen shows its reasons.
 */
export function AccountDeletionRequestsPanel() {
  const [rows, setRows] = React.useState<AdminDeletionRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState('');
  const [method, setMethod] = React.useState<DeletionVerificationMethod | null>(null);
  const [note, setNote] = React.useState('');
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [verificationError, setVerificationError] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [reviewing, setReviewing] = React.useState<AdminDeletionRequest | null>(null);
  const [preview, setPreview] = React.useState<AdminDeletionPreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setRows(await listAccountDeletionRequests()); }
    catch (error) { setLoadError(formatApiErrorMessage(error, 'Unable to load account deletion requests. Retry or check service health.')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const record = async () => {
    const emailProblem = recordRequestEmailError(email);
    const verificationProblem = recordRequestVerificationError(method, note);
    setEmailError(emailProblem);
    setVerificationError(verificationProblem);
    if (emailProblem || verificationProblem || !method) return;
    setRecording(true); setFeedback(null);
    try {
      const result = await recordAccountDeletionRequest(email, method, note);
      setFeedback({ tone: 'success', message: result.alreadyRequested ? `A deletion request was already recorded for ${result.request.email}.` : `Deletion request recorded for ${result.request.email}. Review and complete it below when you are ready.` });
      setEmail(''); setMethod(null); setNote('');
      void load();
    } catch (error) {
      setFeedback({ tone: 'error', message: deletionRequestError(errorCode(error), formatApiErrorMessage(error, 'The request was not recorded. Try again.')) });
    } finally { setRecording(false); }
  };

  const review = async (row: AdminDeletionRequest) => {
    setFeedback(null); setReviewing(row); setPreview(null); setPreviewError(null); setIdentityConfirmed(false);
    if (row.kind !== 'user') return;
    try { setPreview(await getAccountDeletionPreview(row.id)); }
    catch (error) { setPreviewError(formatApiErrorMessage(error, 'The summary could not be loaded. Try again.')); }
  };

  const closeReview = () => { setReviewing(null); setPreview(null); setPreviewError(null); setIdentityConfirmed(false); };

  const complete = async () => {
    if (!reviewing) return;
    const target = reviewing;
    setSaving(true);
    try {
      await completeAccountDeletionRequest(target.kind, target.id, target.requestedBy === 'admin' ? { identityConfirmed } : {});
      setFeedback({ tone: 'success', message: `${target.email} has been deleted. This is recorded in the audit trail.` });
      setRows((current) => current.filter((row) => keyOf(row) !== keyOf(target)));
      closeReview();
    } catch (error) {
      setFeedback({ tone: 'error', message: deletionRequestError(errorCode(error), formatApiErrorMessage(error, 'The deletion was not completed. Try again.')) });
      void load();
    } finally { setSaving(false); setConfirming(false); }
  };

  const confirmation = reviewing && confirming ? deletionCompletionConfirmation(reviewing) : null;

  return (
    <View style={styles.root} testID="account-deletion-requests-panel">
      <View style={styles.headerRow}>
        <Text style={styles.intro}>Requests recorded in the app or received by email. Company owners, Platform Admins and client portal logins cannot finish deletion themselves; complete their requests here. Deleting an account never closes a company: an owner's request waits until each company they own is closed on the Company verification screen, or ownership is transferred through S4 support. Records are kept; personal identifiers on the account are removed.</Text>
        <Button label={loading ? 'Loading…' : 'Refresh'} variant="secondary" size="sm" onPress={() => void load()} disabled={loading} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>RECORD AN EMAILED REQUEST</Text>
        <FormField label="Email address the request came from" required helperText="It must be the account's registered email address." error={emailError ?? undefined}>
          <FieldInput accessibilityLabel="Email address the request came from" value={email} autoCapitalize="none" keyboardType="email-address"
            onChangeText={(value: string) => { setEmail(value); if (emailError) setEmailError(null); }} hasError={!!emailError} placeholder="name@example.com" />
        </FormField>
        <FormField label="How was the request verified?" required error={verificationError ?? undefined}>
          <View accessibilityRole="radiogroup" style={styles.choices}>
            {DELETION_VERIFICATION_METHODS.map((option) => (
              <View key={option.value}>
                <Choice role="radio" label={option.label} checked={method === option.value}
                  onPress={() => { setMethod(option.value); if (verificationError) setVerificationError(null); }} />
              </View>
            ))}
          </View>
        </FormField>
        <FormField label="Verification note" required helperText={`A few words on the check, up to ${DELETION_VERIFICATION_NOTE_MAX} characters. No personal details needed.`}>
          <FieldInput accessibilityLabel="Verification note" value={note} maxLength={DELETION_VERIFICATION_NOTE_MAX}
            onChangeText={(value: string) => { setNote(value); if (verificationError) setVerificationError(null); }} placeholder="e.g. Matched the registered address" />
        </FormField>
        <View style={styles.actions}>
          <Button label={recording ? 'Recording…' : 'Record request'} variant="primary" size="md" onPress={() => void record()} disabled={recording} />
        </View>
      </View>

      {feedback ? (
        <View accessibilityLiveRegion="polite" style={feedback.tone === 'success' ? styles.successBox : styles.errorBox}>
          <Text style={feedback.tone === 'success' ? styles.successText : styles.errorText}>{feedback.message}</Text>
        </View>
      ) : null}
      {loadError ? <View style={styles.errorBox}><Text style={styles.errorText}>{loadError}</Text></View> : null}
      {loading && !rows.length ? <Text style={styles.muted}>Loading requests…</Text> : null}
      {!loading && !loadError && !rows.length ? (
        <View style={styles.empty}><Text style={styles.emptyTitle}>No account deletion requests are waiting</Text></View>
      ) : null}

      {rows.map((row) => {
        const open = reviewing && keyOf(reviewing) === keyOf(row);
        const ready = canConfirmCompletion(row, identityConfirmed, preview) && !row.blockedCode && (row.kind !== 'user' || !!preview);
        return (
          <View key={keyOf(row)} style={styles.card} accessibilityLabel={`Deletion request for ${row.email}`}>
            <View style={styles.rowHead}>
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{row.email}</Text>
                <Text style={styles.muted}>{row.name ? `${row.name} · ` : ''}{DELETION_ACCOUNT_TYPE_LABEL[row.accountType] ?? row.accountType} · {row.kind === 'client_portal_user' ? 'Client login' : 'User'} #{row.id}</Text>
                <Text style={styles.muted}>Requested {when(row.requestedAt)} · {row.requestedBy === 'admin' ? 'recorded by S4 from an email' : 'in the app'}</Text>
              </View>
              <StatusBadge label={row.blockedCode ? 'Pending' : 'Ready'} tone={row.blockedCode ? 'warning' : 'info'} />
            </View>
            {row.companies.map((company) => (
              <Text key={company.id} style={styles.fieldValue}>Owns {company.name} (#{company.id}) · {company.verificationStatus.replace(/_/g, ' ')}{company.closed ? ' (closed)' : ' (not closed)'} · {company.shiftsInProgress} in progress · {company.futureShifts} future shift{company.futureShifts === 1 ? '' : 's'}</Text>
            ))}
            {row.client ? <Text style={styles.fieldValue}>Client {row.client.name}{row.client.companyName ? ` of ${row.client.companyName}` : ''}</Text> : null}
            {row.blockedReason ? <Text style={styles.warningText}>{row.blockedReason}</Text> : null}
            {row.accountType === 'company_owner' ? <Text style={styles.muted}>{OWNER_RESOLUTION_GUIDANCE}</Text> : null}

            {open ? (
              <View style={styles.review} testID="account-deletion-review">
                <Text style={styles.sectionLabel}>BEFORE YOU COMPLETE</Text>
                {row.kind === 'user' && !preview && !previewError ? <Text style={styles.muted}>Loading summary…</Text> : null}
                {previewError ? <Text style={styles.errorText}>{previewError}</Text> : null}
                {preview ? (
                  preview.companies.length ? preview.companies.map((company) => (
                    <View key={company.companyId} style={styles.summary}>
                      {companySummaryLines(company).map((line) => <Text key={line} style={styles.fieldValue}>{line}</Text>)}
                    </View>
                  )) : <Text style={styles.muted}>This account owns no company.</Text>
                ) : null}
                {preview?.companies.length ? <Text style={styles.muted}>These counts are for information. Deletion changes none of them and deletes no records.</Text> : null}
                {row.requestedBy === 'admin' ? (
                  <Choice role="checkbox" checked={identityConfirmed} onPress={() => setIdentityConfirmed((v) => !v)}
                    label="I have verified that this request came from the account holder" />
                ) : null}
                <View style={styles.actions}>
                  <Button label="Complete deletion" variant="danger" size="md" disabled={saving || !ready} onPress={() => setConfirming(true)} />
                  <Button label="Cancel" variant="secondary" size="md" disabled={saving} onPress={closeReview} />
                </View>
              </View>
            ) : (
              <View style={styles.actions}>
                <Button label="Review deletion" variant="secondary" size="md" disabled={saving} onPress={() => void review(row)} />
              </View>
            )}
          </View>
        );
      })}

      <S4LegalLinks testID="admin-legal-links" />

      {confirmation ? (
        <ConfirmationDialog
          visible={confirming}
          onClose={() => { if (!saving) setConfirming(false); }}
          onConfirm={() => void complete()}
          title={confirmation.title}
          message={confirmation.message}
          confirmLabel={confirmation.confirmLabel}
          variant="danger"
          loading={saving}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.lg, flexWrap: 'wrap' },
  intro: { ...typography.body, color: colors.textSecondary, flex: 1, minWidth: 260 },
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  review: { borderTopColor: colors.border, borderTopWidth: 1, paddingTop: spacing.sm, gap: spacing.sm },
  summary: { gap: 2 },
  sectionLabel: { ...typography.label, color: colors.textSecondary, letterSpacing: 0.5 },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  rowCopy: { flex: 1, gap: 2, minWidth: 0 },
  rowTitle: { ...typography.bodyStrong, color: colors.textPrimary },
  muted: { ...typography.caption, color: colors.textSecondary },
  fieldValue: { ...typography.body, color: colors.textPrimary },
  warningText: { ...typography.caption, color: colors.warning },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choices: { gap: spacing.xs },
  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  boxChecked: { borderColor: colors.textPrimary },
  tick: { ...typography.caption, color: colors.textPrimary },
  choiceLabel: { ...typography.body, color: colors.textPrimary, flex: 1 },
  empty: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.xl, alignItems: 'center', gap: spacing.xs },
  emptyTitle: { ...typography.bodyStrong, color: colors.textPrimary, textAlign: 'center' },
  successBox: { backgroundColor: colors.successSurface, borderColor: colors.successBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  successText: { ...typography.body, color: colors.success },
  errorBox: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  errorText: { ...typography.body, color: colors.danger },
});
