import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  AccountDeletionStatus,
  confirmAccountDeletion,
  formatApiErrorMessage,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '../../services/api';
import { colors, control, radii, spacing, typography } from '../../theme';
import { ACCOUNT_DELETION_COPY as COPY } from './accountDeletionCopy';

type Step = 'idle' | 'explain' | 'blocked' | 'confirm';

interface AccountSettingsPanelProps {
  email?: string | null;
  /** Called once the server has deleted the account; the app then signs out locally. */
  onDeleted: (message: string) => void | Promise<void>;
}

/**
 * Settings / Account → Delete account → explanation → confirmation → deletion → sign out.
 *
 * Two server steps, matching the lifecycle: Continue records the request (deletionRequestedAt), and the
 * password confirmation completes it. An account that cannot delete itself (a company owner, a Platform
 * Admin) is told why after Continue — the request is still recorded so support can act on it.
 */
export function AccountSettingsPanel({ email, onDeleted }: AccountSettingsPanelProps) {
  const [step, setStep] = useState<Step>('idle');
  const [status, setStatus] = useState<AccountDeletionStatus | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setError(null);
    setBusy(true);
    try {
      setStatus(await getAccountDeletionStatus());
      setStep('explain');
    } catch (failure) {
      setError(formatApiErrorMessage(failure, 'Account settings are unavailable right now. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function continueToConfirm() {
    setError(null);
    setBusy(true);
    try {
      const next = await requestAccountDeletion();
      setStatus(next);
      setStep(next.selfServiceAvailable ? 'confirm' : 'blocked');
    } catch (failure) {
      setError(formatApiErrorMessage(failure, 'We could not record your request. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!password) {
      setError('Enter your password to confirm.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await confirmAccountDeletion(password);
      setPassword('');
      await onDeleted(result.message || COPY.deletedNotice);
    } catch (failure) {
      setError(formatApiErrorMessage(failure, 'We could not delete your account. Try again.'));
      setBusy(false);
    }
  }

  function cancel() {
    setStep('idle');
    setPassword('');
    setError(null);
  }

  return (
    <View style={styles.card} testID="account-settings-panel">
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
          {status?.deletionRequestedAt ? (
            <Text style={styles.caption}>You asked to delete this account on {new Date(status.deletionRequestedAt).toLocaleDateString('en-GB')}.</Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={cancel} disabled={busy} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>{COPY.cancel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={continueToConfirm} disabled={busy} style={styles.dangerButton}>
              <Text style={styles.dangerText}>{busy ? 'Please wait…' : COPY.explainContinue}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {step === 'blocked' ? (
        <View style={styles.section}>
          <Text style={styles.heading}>We have recorded your request</Text>
          <Text style={styles.point}>{status?.blockerMessage ?? 'This account cannot be deleted from the app.'}</Text>
          <Pressable accessibilityRole="button" onPress={cancel} style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'confirm' ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{COPY.confirmTitle}</Text>
          <Text style={styles.point}>{COPY.confirmBody}</Text>
          <Text style={styles.fieldLabel}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            style={styles.input}
            placeholder="Your current password"
            placeholderTextColor={colors.fieldPlaceholder}
          />
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={cancel} disabled={busy} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>{COPY.cancel}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={confirm} disabled={busy} style={styles.dangerButton}>
              <Text style={styles.dangerText}>{busy ? 'Deleting…' : COPY.confirmButton}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
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
  fieldLabel: { ...typography.label, color: colors.textPrimary },
  input: {
    minHeight: control.inputHeight,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    color: colors.textPrimary,
    backgroundColor: colors.card,
  },
  errorBanner: {
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  errorText: { ...typography.caption, color: colors.danger },
});
