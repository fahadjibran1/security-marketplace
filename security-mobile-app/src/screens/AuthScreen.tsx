import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { clientLogin, formatApiErrorMessage, login, register } from '../services/api';
import { AuthSession, AppRole } from '../types/models';
import { colors } from '../theme';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void | Promise<void>;
  noticeMessage?: string | null;
  onDismissNotice?: () => void;
}

type AuthMode = 'login' | 'register';
type RegistrationRole = 'company' | 'guard';
type LoginRole = 'company' | 'guard' | 'client';

export function AuthScreen({ onLoggedIn, noticeMessage, onDismissNotice }: AuthScreenProps) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const [mode, setMode] = useState<AuthMode>('login');
  const [role, setRole] = useState<RegistrationRole>('company');
  const [loginRole, setLoginRole] = useState<LoginRole>('company');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [siaLicenseNumber, setSiaLicenseNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [address, setAddress] = useState('');
  const [contactDetails, setContactDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isDesktopWeb = width >= 980;

  async function handleSubmit() {
    try {
      setSubmitting(true);
      setErrorMessage(null);
      onDismissNotice?.();

      const session =
        mode === 'login'
          ? loginRole === 'client'
            ? await clientLogin(email, password)
            : await login(email, password)
          : await register({
              email,
              password,
              role: role === 'company' ? ('company_admin' as AppRole) : 'guard',
              fullName: role === 'guard' ? fullName : undefined,
              siaLicenseNumber: role === 'guard' ? siaLicenseNumber : undefined,
              phone: role === 'guard' ? phone : undefined,
              companyName: role === 'company' ? companyName : undefined,
              companyNumber: role === 'company' ? companyNumber : undefined,
              address: role === 'company' ? address : undefined,
              contactDetails: role === 'company' ? contactDetails : undefined,
            });

      await onLoggedIn(session);
    } catch (error) {
      setErrorMessage(
        formatApiErrorMessage(
          error,
          mode === 'login' ? 'Sign-in failed. Please try again.' : 'Account creation failed. Please try again.',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, isDesktopWeb && styles.containerDesktop]}>
      <View style={[styles.shell, isDesktopWeb && styles.shellDesktop]}>
        <View style={[styles.introPanel, isDesktopWeb && styles.introPanelDesktop]}>
          <Text style={styles.kicker}>Observant Security Platform</Text>
          <Text style={[styles.title, isDesktopWeb && styles.titleDesktop]}>
            {mode === 'login' ? 'Security App Login' : 'Create Your Security Account'}
          </Text>
          <Text style={[styles.subtitle, isDesktopWeb && styles.subtitleDesktop]}>
            {mode === 'login'
              ? 'Sign in with an existing account.'
              : 'Choose your role and complete the minimum onboarding details to get started.'}
          </Text>
          <Text style={styles.heroText}>
            Company teams can manage sites, timesheets, and incidents. Guards can apply for work, check in to live shifts, and report activity from the same platform.
          </Text>
        </View>

        <View style={styles.formCard}>
          {noticeMessage ? (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>{noticeMessage}</Text>
            </View>
          ) : null}

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeButton, mode === 'login' && styles.modeButtonActive]}
              onPress={() => {
                setMode('login');
                setErrorMessage(null);
              }}
            >
              <Text style={[styles.modeButtonText, mode === 'login' && styles.modeButtonTextActive]}>Sign In</Text>
            </Pressable>
            <Pressable
              style={[styles.modeButton, mode === 'register' && styles.modeButtonActive]}
              onPress={() => {
                setMode('register');
                setErrorMessage(null);
              }}
            >
              <Text style={[styles.modeButtonText, mode === 'register' && styles.modeButtonTextActive]}>Create Account</Text>
            </Pressable>
          </View>

          {mode === 'login' ? (
            <>
              <Text style={styles.helperText}>Choose the portal you want to sign in to.</Text>
              <View style={styles.roleRow}>
                {(['company', 'guard', 'client'] as LoginRole[]).map((value) => (
                  <Pressable
                    key={value}
                    style={[styles.roleButton, loginRole === value && styles.roleButtonActive]}
                    onPress={() => setLoginRole(value)}
                  >
                    <Text style={[styles.roleButtonText, loginRole === value && styles.roleButtonTextActive]}>
                      {value === 'company' ? 'Company' : value === 'guard' ? 'Guard' : 'Client'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <View style={styles.roleRow}>
              <Pressable
                style={[styles.roleButton, role === 'company' && styles.roleButtonActive]}
                onPress={() => setRole('company')}
              >
                <Text style={[styles.roleButtonText, role === 'company' && styles.roleButtonTextActive]}>Company</Text>
              </Pressable>
              <Pressable
                style={[styles.roleButton, role === 'guard' && styles.roleButtonActive]}
                onPress={() => setRole('guard')}
              >
                <Text style={[styles.roleButtonText, role === 'guard' && styles.roleButtonTextActive]}>Guard</Text>
              </Pressable>
            </View>
          )}

          <TextInput style={styles.input} autoCapitalize="none" editable={!submitting} value={email} onChangeText={setEmail} placeholder="Email" />
          <TextInput style={styles.input} secureTextEntry editable={!submitting} value={password} onChangeText={setPassword} placeholder="Password" />

          {mode === 'register' && role === 'company' ? (
            <>
              <TextInput style={styles.input} editable={!submitting} value={companyName} onChangeText={setCompanyName} placeholder="Company name" />
              <TextInput style={styles.input} editable={!submitting} value={companyNumber} onChangeText={setCompanyNumber} placeholder="Company number" />
              <TextInput style={styles.input} editable={!submitting} value={address} onChangeText={setAddress} placeholder="Address" />
              <TextInput
                style={styles.input}
                editable={!submitting}
                value={contactDetails}
                onChangeText={setContactDetails}
                placeholder="Contact details"
              />
            </>
          ) : null}

          {mode === 'register' && role === 'guard' ? (
            <>
              <TextInput style={styles.input} editable={!submitting} value={fullName} onChangeText={setFullName} placeholder="Full name" />
              <TextInput
                style={styles.input}
                editable={!submitting}
                value={siaLicenseNumber}
                onChangeText={setSiaLicenseNumber}
                placeholder="SIA licence number"
              />
              <TextInput style={styles.input} editable={!submitting} value={phone} onChangeText={setPhone} placeholder="Phone number" />
            </>
          ) : null}

          <Pressable style={[styles.button, submitting && styles.buttonDisabled]} onPress={handleSubmit} disabled={submitting}>
            <Text style={styles.buttonText}>
              {submitting
                ? mode === 'login'
                  ? 'Signing in...'
                  : 'Creating account...'
                : mode === 'login'
                  ? 'Sign In'
                  : 'Create Account'}
            </Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.background,
    gap: 10,
  },
  containerDesktop: {
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  shell: {
    gap: 16,
  },
  shellDesktop: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 24,
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
  },
  introPanel: {
    gap: 12,
  },
  introPanelDesktop: {
    flex: 1,
    maxWidth: 420,
    justifyContent: 'center',
    padding: 24,
    borderRadius: 24,
    backgroundColor: colors.primaryNavy,
  },
  kicker: {
    color: colors.accentTeal,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: { fontSize: 28, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  titleDesktop: { color: '#FFFFFF', textAlign: 'left' },
  subtitle: { textAlign: 'center', color: colors.textSecondary, marginBottom: 8 },
  subtitleDesktop: { textAlign: 'left', color: colors.border },
  heroText: { color: colors.border, lineHeight: 22 },
  helperText: { color: colors.textSecondary, textAlign: 'center' },
  noticeBanner: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
  },
  noticeText: {
    color: colors.supportBlue,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    color: '#B91C1C',
    fontWeight: '600',
  },
  formCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 10,
    flex: 1,
    maxWidth: 520,
    alignSelf: 'center',
    width: '100%',
  },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: colors.card,
  },
  modeButtonActive: {
    backgroundColor: colors.primaryNavy,
    borderColor: colors.primaryNavy,
  },
  modeButtonText: {
    textAlign: 'center',
    color: colors.textPrimary,
    fontWeight: '700',
  },
  modeButtonTextActive: {
    color: '#FFFFFF',
  },
  roleRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  roleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: colors.card,
  },
  roleButtonActive: {
    borderColor: colors.supportBlue,
    backgroundColor: '#EFF6FF',
  },
  roleButtonText: {
    textAlign: 'center',
    color: colors.textPrimary,
    fontWeight: '700',
  },
  roleButtonTextActive: {
    color: colors.supportBlue,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    backgroundColor: colors.card,
    color: colors.textPrimary,
  },
  button: {
    marginTop: 8,
    backgroundColor: colors.primaryNavy,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontWeight: '700',
  },
});
