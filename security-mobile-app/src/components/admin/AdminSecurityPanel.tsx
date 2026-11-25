import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { StatusBadge } from '../StatusBadge';
import { Button } from '../ui/Button';
import { FieldInput, FormField } from '../ui/FormField';
import { AdminMfaEnrolment } from './AdminMfaEnrolment';
import { ApiError, disableAdminMfa, formatApiErrorMessage, getAdminMfaStatus } from '../../services/api';
import { adminMfaErrorMessage, normaliseTotpCode, totpCodeError, type AdminMfaStatus } from '../../navigation/admin-mfa';

const when = (value?: string | null) => (value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded');

/**
 * Platform Admin → Account security: two-step verification (authenticator app) for the signed-in admin. Shows whether it
 * is on, sets it up (QR code + setup key, confirmed with a code) and turns it off with a current code. The backend
 * refuses turning it off while S4 requires it; a lost device is an operator recovery.
 */
export function AdminSecurityPanel() {
  const [status, setStatus] = React.useState<AdminMfaStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [enrolling, setEnrolling] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setStatus(await getAdminMfaStatus()); }
    catch (e) { setLoadError(formatApiErrorMessage(e, 'Two-step verification status could not be loaded.')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function turnOff() {
    const problem = totpCodeError(code);
    if (problem) { setFeedback({ tone: 'error', message: problem }); return; }
    setSaving(true); setFeedback(null);
    try {
      await disableAdminMfa(normaliseTotpCode(code));
      setDisabling(false); setCode('');
      setFeedback({ tone: 'success', message: 'Two-step verification is off. Sign-in now needs only your password.' });
      await load();
    } catch (e) {
      setFeedback({ tone: 'error', message: e instanceof ApiError ? adminMfaErrorMessage(e.body, 'Two-step verification could not be turned off.') : formatApiErrorMessage(e, 'Two-step verification could not be turned off.') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Two-step verification</Text>
        {status ? <StatusBadge label={status.enrolled ? 'On' : 'Off'} tone={status.enrolled ? 'success' : status.required ? 'danger' : 'warning'} /> : null}
      </View>
      <Text style={styles.body}>
        Platform Admin sign-in asks for a 6-digit code from an authenticator app on your phone after your password, so a
        stolen password alone cannot open the admin portal.
      </Text>
      {feedback ? <View style={feedback.tone === 'success' ? styles.successBanner : styles.errorBanner}><Text style={feedback.tone === 'success' ? styles.successText : styles.errorText}>{feedback.message}</Text></View> : null}
      {loading ? <Text style={styles.muted}>Loading…</Text> : null}
      {loadError ? <><Text style={styles.errorText}>{loadError}</Text><Button label="Retry" variant="secondary" onPress={load} /></> : null}

      {status && !status.enrolled && !enrolling ? (
        <View style={styles.section}>
          {status.required ? <Text style={styles.body}>S4 requires two-step verification for Platform Admin accounts.</Text> : null}
          <Button label="Set up two-step verification" onPress={() => { setFeedback(null); setEnrolling(true); }} />
        </View>
      ) : null}
      {status && !status.enrolled && enrolling ? (
        <AdminMfaEnrolment
          onEnrolled={async () => {
            setEnrolling(false);
            setFeedback({ tone: 'success', message: 'Two-step verification is on. Other devices signed in to this account have been signed out.' });
            await load();
          }}
          onCancel={() => setEnrolling(false)}
        />
      ) : null}

      {status?.enrolled ? (
        <View style={styles.section}>
          <Text style={styles.body}>On since {when(status.enabledAt)}.</Text>
          {status.required ? (
            <Text style={styles.muted}>Required by S4 for Platform Admin accounts. If you lose your authenticator device, ask an S4 operator to recover the account.</Text>
          ) : !disabling ? (
            <Button label="Turn off two-step verification" variant="danger" onPress={() => { setFeedback(null); setDisabling(true); }} />
          ) : (
            <View style={styles.section}>
              <FormField label="Current code from your authenticator app" required>
                <FieldInput value={code} onChangeText={setCode} placeholder="123456" keyboardType="number-pad" autoComplete="one-time-code" maxLength={9} editable={!saving} accessibilityLabel="Authentication code" />
              </FormField>
              <View style={styles.actions}>
                <Button label={saving ? 'Turning off…' : 'Turn off'} variant="danger" onPress={turnOff} loading={saving} disabled={saving} />
                <Button label="Cancel" variant="tertiary" onPress={() => { setDisabling(false); setCode(''); }} disabled={saving} />
              </View>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.md, maxWidth: 640 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  title: { color: colors.textPrimary, ...typography.sectionTitle },
  body: { color: colors.textSecondary, ...typography.body },
  muted: { color: colors.textSecondary, ...typography.caption },
  section: { gap: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  successBanner: { backgroundColor: colors.successSurface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: colors.successBorder },
  successText: { color: colors.success, ...typography.label },
  errorBanner: { backgroundColor: colors.dangerSurface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: colors.dangerBorder },
  errorText: { color: colors.danger, ...typography.label },
});
