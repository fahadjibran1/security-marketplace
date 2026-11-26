import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  AccountDeletionStatus,
  formatApiErrorMessage,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '../../services/api';
import { colors, control, radii, spacing, typography } from '../../theme';
import { CLIENT_ACCOUNT_DELETION_COPY as COPY } from './accountDeletionCopy';
import { S4LegalLinks } from './S4LegalLinks';

type Step = 'idle' | 'explain' | 'requested';

interface ClientAccountPanelProps {
  email?: string | null;
}

/**
 * Client portal → Account: the S4 links, and "Request account deletion" → explanation → Send request. The request is
 * recorded on the server (POST /account/deletion/request) and S4 completes it from the Platform Admin queue; a client
 * portal login never deletes itself and there is no password step.
 */
export function ClientAccountPanel({ email }: ClientAccountPanelProps) {
  const [step, setStep] = useState<Step>('idle');
  const [status, setStatus] = useState<AccountDeletionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setError(null);
    setBusy(true);
    try {
      const current = await getAccountDeletionStatus();
      setStatus(current);
      setStep(current.deletionRequestedAt ? 'requested' : 'explain');
    } catch (failure) {
      setError(formatApiErrorMessage(failure, 'Account settings are unavailable right now. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setError(null);
    setBusy(true);
    try {
      setStatus(await requestAccountDeletion());
      setStep('requested');
    } catch (failure) {
      setError(formatApiErrorMessage(failure, 'We could not record your request. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card} testID="client-account-panel">
      <Text style={styles.title}>Account</Text>
      {email ? <Text style={styles.caption}>Signed in as {email}</Text> : null}

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {step === 'idle' ? (
        <Pressable accessibilityRole="button" onPress={begin} disabled={busy} style={styles.entryRow}>
          <View style={styles.entryText}>
            <Text style={styles.dangerLabel}>{COPY.entryTitle}</Text>
            <Text style={styles.caption}>{COPY.entryCaption}</Text>
          </View>
          {busy ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.chevron}>›</Text>}
        </Pressable>
      ) : null}

      {step === 'explain' ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{COPY.explainTitle}</Text>
          {COPY.explainPoints.map((point) => (
            <Text key={point} style={styles.point}>• {point}</Text>
          ))}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={() => setStep('idle')} disabled={busy} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>{COPY.cancel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={send} disabled={busy} style={styles.dangerButton}>
              <Text style={styles.dangerText}>{busy ? 'Please wait…' : COPY.explainContinue}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {step === 'requested' ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{COPY.requestedTitle}</Text>
          {status?.deletionRequestedAt ? (
            <Text style={styles.caption}>Requested on {new Date(status.deletionRequestedAt).toLocaleDateString('en-GB')}.</Text>
          ) : null}
          {status?.blockerMessage ? <Text style={styles.point}>{status.blockerMessage}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => setStep('idle')} style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.divider} />
      <S4LegalLinks showSupportAddress testID="client-legal-links" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { ...typography.panelHeading, color: colors.textPrimary },
  heading: { ...typography.label, color: colors.textPrimary },
  caption: { ...typography.caption, color: colors.textSecondary },
  point: { ...typography.caption, color: colors.textPrimary },
  section: { gap: spacing.sm },
  divider: { height: 1, backgroundColor: colors.border },
  entryRow: {
    minHeight: control.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  entryText: { flexShrink: 1, gap: 2 },
  dangerLabel: { ...typography.label, color: colors.danger },
  chevron: { fontSize: 22, color: colors.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  secondaryButton: {
    minHeight: control.minTouchTarget,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
  },
  secondaryText: { ...typography.label, color: colors.textPrimary },
  dangerButton: {
    minHeight: control.minTouchTarget,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.danger,
  },
  dangerText: { ...typography.label, color: colors.textOnBrand },
  errorBanner: {
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  errorText: { ...typography.caption, color: colors.danger },
});
