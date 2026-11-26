import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, acceptCompanyStaffInvitation, formatApiErrorMessage } from '../services/api';
import { AccountLink, validateNewPassword } from '../components/account/accountLinks';
import { brand, colors, control, radii, spacing, typography } from '../theme';

export const INVALID_INVITATION =
  'This invitation link is invalid or has expired. Ask the person who invited you to send a new invitation.';

type Phase = 'form' | 'working' | 'done' | 'failed';

/** The message to show for the name fields, or null when they are filled in. */
export function validateStaffName(firstName: string, lastName: string): string | null {
  if (!firstName.trim() || !lastName.trim()) return 'Enter your first and last name.';
  if (firstName.trim().length > 80 || lastName.trim().length > 80) return 'Your name must be at most 80 characters for each part.';
  return null;
}

/**
 * The S4 web page behind an emailed company staff invitation (/join-company?token=…): the invited person sets their
 * name and password, then signs in. Works from any browser with no session; the token is held in memory only.
 */
export function StaffInvitationScreen({ link, onDone }: { link: AccountLink; onDone: () => void }) {
  const tokenRef = useRef<string | null>(link.token);
  const [phase, setPhase] = useState<Phase>(link.token ? 'form' : 'failed');
  const [message, setMessage] = useState<string | null>(link.token ? null : INVALID_INVITATION);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  async function submit() {
    const problem = validateStaffName(firstName, lastName) ?? validateNewPassword(password, confirmation);
    if (problem) { setMessage(problem); return; }
    const token = tokenRef.current;
    if (!token) { setMessage(INVALID_INVITATION); setPhase('failed'); return; }
    setMessage(null);
    setPhase('working');
    try {
      const result = await acceptCompanyStaffInvitation(token, firstName, lastName, password);
      tokenRef.current = null;
      setPassword('');
      setConfirmation('');
      setMessage(result.message);
      setPhase('done');
    } catch (error) {
      // A refused link (400) or an address that already has an account (409) cannot succeed on retry.
      const final = error instanceof ApiError && (error.status === 400 || error.status === 409)
        && /invitation/i.test(JSON.stringify(error.body ?? ''));
      setMessage(error instanceof ApiError && error.status === 400 && final ? INVALID_INVITATION : formatApiErrorMessage(error, INVALID_INVITATION));
      if (final) tokenRef.current = null;
      setPhase(final ? 'failed' : 'form');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card} testID="account-link-join-company">
        <Text style={styles.brand}>{brand.appName}</Text>
        <Text style={styles.title}>Join your company on {brand.appName}</Text>

        {message ? (
          <View style={[styles.banner, phase === 'done' ? styles.bannerSuccess : styles.bannerError]}>
            <Text style={[styles.bannerText, phase === 'done' ? styles.bannerTextSuccess : styles.bannerTextError]}>{message}</Text>
          </View>
        ) : null}

        {phase === 'form' || phase === 'working' ? (
          <View style={styles.form}>
            <Text style={styles.caption}>Set your name and a password. You will sign in with the email address this invitation was sent to.</Text>
            <Text style={styles.label}>First name</Text>
            <TextInput value={firstName} onChangeText={setFirstName} autoComplete="given-name" textContentType="givenName" style={styles.input} />
            <Text style={styles.label}>Last name</Text>
            <TextInput value={lastName} onChangeText={setLastName} autoComplete="family-name" textContentType="familyName" style={styles.input} />
            <Text style={styles.label}>Password</Text>
            <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" style={styles.input} />
            <Text style={styles.label}>Confirm password</Text>
            <TextInput value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" style={styles.input} />
            <Text style={styles.caption}>Your password must be at least 6 characters.</Text>
            <Pressable accessibilityRole="button" onPress={submit} disabled={phase === 'working'} style={styles.primary}>
              <Text style={styles.primaryText}>{phase === 'working' ? 'Joining…' : 'Accept invitation'}</Text>
            </Pressable>
          </View>
        ) : null}

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
