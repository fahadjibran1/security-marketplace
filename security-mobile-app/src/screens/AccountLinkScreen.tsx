import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, formatApiErrorMessage, resetPassword, verifyEmailAddress } from '../services/api';
import { AccountLink, validateNewPassword } from '../components/account/accountLinks';
import { brand, colors, control, radii, spacing, typography } from '../theme';

interface AccountLinkScreenProps {
  link: AccountLink;
  /** Leave the link page and show S4 sign-in. */
  onDone: () => void;
}

type Phase = 'form' | 'working' | 'done' | 'failed';

const INVALID_LINK = {
  'reset-password': 'This password reset link is invalid or has expired. Request a new one from the S4 sign-in screen.',
  'verify-email': 'This verification link is invalid or has expired. Request a new one from the S4 sign-in screen.',
} as const;

/**
 * The S4 web pages behind emailed links: choose a new password, or confirm an email address.
 *
 * Works from any browser with no session and without the mobile app installed — it depends only on the
 * S4 web app and the API, never on an app scheme or package identity.
 */
export function AccountLinkScreen({ link, onDone }: AccountLinkScreenProps) {
  // Held in a ref and dropped after use: the URL no longer carries it (see takeAccountLink).
  const tokenRef = useRef<string | null>(link.token);
  const [phase, setPhase] = useState<Phase>(link.token ? (link.kind === 'verify-email' ? 'working' : 'form') : 'failed');
  const [message, setMessage] = useState<string | null>(link.token ? null : INVALID_LINK[link.kind]);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  function failWith(error: unknown) {
    // Every refusal of the link itself is a 400 with the generic message; anything else is shown as-is.
    setMessage(
      error instanceof ApiError && error.status === 400 && link.kind === 'verify-email'
        ? INVALID_LINK['verify-email']
        : formatApiErrorMessage(error, INVALID_LINK[link.kind]),
    );
  }

  useEffect(() => {
    if (link.kind !== 'verify-email' || !tokenRef.current) return;
    const token = tokenRef.current;
    tokenRef.current = null;
    verifyEmailAddress(token)
      .then((result) => { setMessage(result.message); setPhase('done'); })
      .catch((error) => { failWith(error); setPhase('failed'); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitReset() {
    const problem = validateNewPassword(password, confirmation);
    if (problem) { setMessage(problem); return; }
    const token = tokenRef.current;
    if (!token) { setMessage(INVALID_LINK['reset-password']); setPhase('failed'); return; }
    setMessage(null);
    setPhase('working');
    try {
      const result = await resetPassword(token, password);
      tokenRef.current = null;
      setPassword('');
      setConfirmation('');
      setMessage(result.message);
      setPhase('done');
    } catch (error) {
      failWith(error);
      // A refused link cannot succeed on retry, so the form goes; any other problem leaves it to correct.
      const refusedLink = error instanceof ApiError && error.status === 400 && /link is invalid or has expired/i.test(JSON.stringify(error.body ?? ''));
      if (refusedLink) tokenRef.current = null;
      setPhase(refusedLink ? 'failed' : 'form');
    }
  }

  const title = link.kind === 'reset-password' ? 'Choose a new password' : 'Verify your email address';

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card} testID={`account-link-${link.kind}`}>
        <Text style={styles.brand}>{brand.appName}</Text>
        <Text style={styles.title}>{title}</Text>

        {message ? (
          <View style={[styles.banner, phase === 'done' ? styles.bannerSuccess : styles.bannerError]}>
            <Text style={[styles.bannerText, phase === 'done' ? styles.bannerTextSuccess : styles.bannerTextError]}>{message}</Text>
          </View>
        ) : null}

        {link.kind === 'reset-password' && (phase === 'form' || phase === 'working') ? (
          <View style={styles.form}>
            <Text style={styles.caption}>Your new password must be at least 6 characters. You will be signed out of {brand.appName} on every device.</Text>
            <Text style={styles.label}>New password</Text>
            <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" style={styles.input} />
            <Text style={styles.label}>Confirm new password</Text>
            <TextInput value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" style={styles.input} />
            <Pressable accessibilityRole="button" onPress={submitReset} disabled={phase === 'working'} style={styles.primary}>
              <Text style={styles.primaryText}>{phase === 'working' ? 'Saving…' : 'Save new password'}</Text>
            </Pressable>
          </View>
        ) : null}

        {link.kind === 'verify-email' && phase === 'working' ? <Text style={styles.caption}>Verifying your email address…</Text> : null}

        {phase === 'done' || phase === 'failed' ? (
          <Pressable accessibilityRole="button" onPress={onDone} style={styles.primary}>
            <Text style={styles.primaryText}>Go to {brand.appName} sign in</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  card: { width: '100%', maxWidth: 440, gap: spacing.md, padding: spacing.xl, borderRadius: radii.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  brand: { ...typography.label, color: colors.accentTealStrong, letterSpacing: 1 },
  title: { ...typography.sectionTitle, color: colors.textPrimary },
  caption: { ...typography.caption, color: colors.textSecondary },
  form: { gap: spacing.sm },
  label: { ...typography.label, color: colors.textPrimary },
  input: { minHeight: control.inputHeight, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.sm, paddingHorizontal: spacing.md, color: colors.textPrimary, backgroundColor: colors.card },
  primary: { minHeight: control.buttonHeight, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm, backgroundColor: colors.primaryNavy, marginTop: spacing.sm },
  primaryText: { ...typography.label, color: colors.textOnBrand },
  banner: { padding: spacing.md, borderRadius: radii.sm, borderWidth: 1 },
  bannerSuccess: { backgroundColor: colors.successSurface, borderColor: colors.successBorder },
  bannerError: { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder },
  bannerText: { ...typography.caption },
  bannerTextSuccess: { color: colors.success },
  bannerTextError: { color: colors.danger },
});
