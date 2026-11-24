import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';
import { FieldInput, FormField } from '../ui/FormField';
import { AdminMfaQr } from './AdminMfaQr';
import { ApiError, confirmAdminMfaEnrolment, formatApiErrorMessage, startAdminMfaEnrolment } from '../../services/api';
import {
  adminMfaErrorMessage, formatTotpSecret, normaliseTotpCode, totpCodeError, type AdminMfaEnrolmentSetup,
} from '../../navigation/admin-mfa';
import type { AuthSession } from '../../types/models';

type Props = {
  /** The enrolment token from a sign-in that must enrol first; absent when a signed-in admin enrols voluntarily. */
  enrollmentToken?: string;
  onEnrolled: (session: AuthSession) => void | Promise<void>;
  onCancel?: () => void;
};

/**
 * Set up an authenticator app: the backend issues a secret (shown once, as a QR code and as a setup key for typing),
 * then a code from the app confirms it. Confirming returns a fresh two-step session, handed to onEnrolled.
 */
export function AdminMfaEnrolment({ enrollmentToken, onEnrolled, onCancel }: Props) {
  const [setup, setSetup] = React.useState<AdminMfaEnrolmentSetup | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const start = React.useCallback(async () => {
    setStarting(true); setError(null); setCode('');
    try { setSetup(await startAdminMfaEnrolment(enrollmentToken)); }
    catch (e) { setError(e instanceof ApiError ? adminMfaErrorMessage(e.body, formatApiErrorMessage(e, 'Two-step verification setup could not start.')) : formatApiErrorMessage(e, 'Two-step verification setup could not start.')); }
    finally { setStarting(false); }
  }, [enrollmentToken]);
  React.useEffect(() => { void start(); }, [start]);

  async function confirm() {
    const problem = totpCodeError(code);
    if (problem) { setError(problem); return; }
    setSaving(true); setError(null);
    try {
      const session = await confirmAdminMfaEnrolment(normaliseTotpCode(code), enrollmentToken);
      setSetup(null); // the secret leaves the screen as soon as it is confirmed
      await onEnrolled(session);
    } catch (e) {
      setError(e instanceof ApiError ? adminMfaErrorMessage(e.body, 'That code could not be confirmed.') : formatApiErrorMessage(e, 'That code could not be confirmed.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.lead}>
        Scan the QR code with an authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password),
        then enter the 6-digit code it shows.
      </Text>
      {error ? <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View> : null}
      {starting && !setup ? <Text style={styles.muted}>Preparing your setup key…</Text> : null}
      {setup ? (
        <View style={styles.setup}>
          <AdminMfaQr uri={setup.otpauthUri} />
          <View style={styles.keyBlock}>
            <Text style={styles.keyLabel}>Can’t scan? Enter this setup key instead</Text>
            <Text style={styles.key} selectable accessibilityLabel="Setup key">{formatTotpSecret(setup.secret)}</Text>
            <Text style={styles.muted}>Account: {setup.accountName} · Time-based · 6 digits</Text>
          </View>
          <FormField label="Code from your authenticator app" required>
            <FieldInput
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={9}
              editable={!saving}
              accessibilityLabel="Authentication code"
              onSubmitEditing={confirm}
            />
          </FormField>
          <Button label={saving ? 'Confirming…' : 'Confirm and turn on'} onPress={confirm} loading={saving} disabled={saving} fullWidth />
        </View>
      ) : null}
      {!starting && !setup ? <Button label="Start again" variant="secondary" onPress={start} /> : null}
      {onCancel ? <Button label="Cancel" variant="tertiary" onPress={onCancel} disabled={saving} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  lead: { color: colors.textSecondary, ...typography.body },
  setup: { gap: spacing.md, alignItems: 'stretch' },
  keyBlock: { gap: spacing.xs, backgroundColor: colors.surfaceSubtle, borderRadius: radii.md, padding: spacing.md },
  keyLabel: { color: colors.textPrimary, ...typography.label },
  key: { color: colors.textPrimary, ...typography.bodyStrong, letterSpacing: 1 },
  muted: { color: colors.textSecondary, ...typography.caption },
  errorBanner: { backgroundColor: colors.dangerSurface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: colors.dangerBorder },
  errorText: { color: colors.danger, ...typography.label },
});
