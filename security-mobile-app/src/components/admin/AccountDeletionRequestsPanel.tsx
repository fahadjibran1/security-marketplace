import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { FieldInput, FormField } from '../ui/FormField';
import { S4LegalLinks } from '../account/S4LegalLinks';
import {
  ApiError, completeAccountDeletionRequest, formatApiErrorMessage, listAccountDeletionRequests, recordAccountDeletionRequest,
  type AdminDeletionRequest,
} from '../../services/api';
import {
  DELETION_ACCOUNT_TYPE_LABEL, deletionCompletionConfirmation, deletionRequestError, recordRequestEmailError,
} from '../../navigation/account-deletion-requests';

const when = (value?: string | null) => (value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded');
const keyOf = (row: Pick<AdminDeletionRequest, 'kind' | 'id'>) => `${row.kind}:${row.id}`;
const errorCode = (error: unknown) => (error instanceof ApiError ? ((error.body as { code?: string } | null)?.code ?? null) : null);

/**
 * Platform Admin → Account deletion requests. Lists every recorded request that is not yet complete (company owners,
 * Platform Admins, client portal logins, emailed requests and any other account), records a request received by email,
 * and completes a request after a confirmation. The backend decides what is allowed (a company with shifts in progress,
 * your own account, the last Platform Admin) and audits every step; the screen shows its reasons.
 */
export function AccountDeletionRequestsPanel() {
  const [rows, setRows] = React.useState<AdminDeletionRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState('');
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [pending, setPending] = React.useState<AdminDeletionRequest | null>(null);
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
    const problem = recordRequestEmailError(email);
    setEmailError(problem);
    if (problem) return;
    setRecording(true); setFeedback(null);
    try {
      const result = await recordAccountDeletionRequest(email);
      setFeedback({ tone: 'success', message: result.alreadyRequested ? `A deletion request was already recorded for ${result.request.email}.` : `Deletion request recorded for ${result.request.email}. Complete it below when you are ready.` });
      setEmail('');
      void load();
    } catch (error) {
      setFeedback({ tone: 'error', message: deletionRequestError(errorCode(error), formatApiErrorMessage(error, 'The request was not recorded. Try again.')) });
    } finally { setRecording(false); }
  };

  const complete = async () => {
    if (!pending) return;
    const target = pending;
    setSaving(true);
    try {
      await completeAccountDeletionRequest(target.kind, target.id);
      setFeedback({ tone: 'success', message: `${target.email} has been deleted.${target.companies.length ? ' Its company has been closed and its team\'s access ended.' : ''} This is recorded in the audit trail.` });
      setRows((current) => current.filter((row) => keyOf(row) !== keyOf(target)));
    } catch (error) {
      setFeedback({ tone: 'error', message: deletionRequestError(errorCode(error), formatApiErrorMessage(error, 'The deletion was not completed. Try again.')) });
      void load();
    } finally { setSaving(false); setPending(null); }
  };

  const confirmation = pending ? deletionCompletionConfirmation(pending) : null;

  return (
    <View style={styles.root} testID="account-deletion-requests-panel">
      <View style={styles.headerRow}>
        <Text style={styles.intro}>Requests recorded in the app or received by email. Company owners, Platform Admins and client portal logins cannot finish deletion themselves; complete their requests here. Completing an owner's request closes their company first. Records are kept; personal identifiers on the account are removed.</Text>
        <Button label={loading ? 'Loading…' : 'Refresh'} variant="secondary" size="sm" onPress={() => void load()} disabled={loading} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>RECORD AN EMAILED REQUEST</Text>
        <FormField label="Email address the request came from" required helperText="It must be the account's registered email address." error={emailError ?? undefined}>
          <FieldInput accessibilityLabel="Email address the request came from" value={email} autoCapitalize="none" keyboardType="email-address"
            onChangeText={(value: string) => { setEmail(value); if (emailError) setEmailError(null); }} hasError={!!emailError} placeholder="name@example.com" />
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

      {rows.map((row) => (
        <View key={keyOf(row)} style={styles.card} accessibilityLabel={`Deletion request for ${row.email}`}>
          <View style={styles.rowHead}>
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>{row.email}</Text>
              <Text style={styles.muted}>{row.name ? `${row.name} · ` : ''}{DELETION_ACCOUNT_TYPE_LABEL[row.accountType] ?? row.accountType} · {row.kind === 'client_portal_user' ? 'Client login' : 'User'} #{row.id}</Text>
              <Text style={styles.muted}>Requested {when(row.requestedAt)} · {row.requestedBy === 'admin' ? 'recorded by S4 from an email' : 'in the app'}</Text>
            </View>
            <StatusBadge label={row.blockedCode ? 'Waiting' : 'Ready'} tone={row.blockedCode ? 'warning' : 'info'} />
          </View>
          {row.companies.map((company) => (
            <Text key={company.id} style={styles.fieldValue}>Owns {company.name} (#{company.id}) · {company.verificationStatus.replace('_', ' ')} · {company.shiftsInProgress} shift{company.shiftsInProgress === 1 ? '' : 's'} in progress</Text>
          ))}
          {row.client ? <Text style={styles.fieldValue}>Client {row.client.name}{row.client.companyName ? ` of ${row.client.companyName}` : ''}</Text> : null}
          {row.blockedReason ? <Text style={styles.warningText}>{row.blockedReason}</Text> : null}
          <View style={styles.actions}>
            <Button label="Complete deletion" variant="danger" size="md" disabled={saving || !!row.blockedCode} onPress={() => { setFeedback(null); setPending(row); }} />
          </View>
        </View>
      ))}

      <S4LegalLinks testID="admin-legal-links" />

      {confirmation ? (
        <ConfirmationDialog
          visible={!!pending}
          onClose={() => { if (!saving) setPending(null); }}
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
  sectionLabel: { ...typography.label, color: colors.textSecondary, letterSpacing: 0.5 },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  rowCopy: { flex: 1, gap: 2, minWidth: 0 },
  rowTitle: { ...typography.bodyStrong, color: colors.textPrimary },
  muted: { ...typography.caption, color: colors.textSecondary },
  fieldValue: { ...typography.body, color: colors.textPrimary },
  warningText: { ...typography.caption, color: colors.warning },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  empty: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.xl, alignItems: 'center', gap: spacing.xs },
  emptyTitle: { ...typography.bodyStrong, color: colors.textPrimary, textAlign: 'center' },
  successBox: { backgroundColor: colors.successSurface, borderColor: colors.successBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  successText: { ...typography.body, color: colors.success },
  errorBox: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  errorText: { ...typography.body, color: colors.danger },
});
