import { useCallback, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { clientLogin, formatApiErrorMessage, login, register } from '../services/api';
import { AuthSession, AppRole } from '../types/models';
import { brand, colors } from '../theme';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void | Promise<void>;
  noticeMessage?: string | null;
  onDismissNotice?: () => void;
}

type AuthMode = 'login' | 'register';
type RegistrationRole = 'company' | 'guard';
type LoginRole = 'company' | 'guard' | 'client';

type LabeledInputProps = {
  label: string;
  style?: object | object[] | undefined;
  placeholderTextColor?: string;
  /** After the field receives focus (e.g. scroll form so CTA stays reachable on small Android). */
  onInputFocus?: () => void;
} & Record<string, unknown>;

function LabeledInput({ label, style, placeholderTextColor, onInputFocus, ...rest }: LabeledInputProps) {
  const inputRest = rest as Record<string, unknown>;
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        {...inputRest}
        style={[styles.input, style]}
        placeholderTextColor={placeholderTextColor ?? colors.fieldPlaceholder}
        numberOfLines={1}
        onFocus={(event: any) => {
          const userHandler = inputRest.onFocus as ((e: any) => void) | undefined;
          userHandler?.(event);
          onInputFocus?.();
        }}
      />
    </View>
  );
}

export function AuthScreen({ onLoggedIn, noticeMessage, onDismissNotice }: AuthScreenProps) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const scrollRef = useRef<any>(null);
  const bumpScrollForKeyboard = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 72);
    });
  }, []);

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
    <KeyboardAvoidingView
      style={styles.keyboardRoot}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 6 : 0}
      enabled
    >
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        nestedScrollEnabled
        contentContainerStyle={[
          styles.container,
          isDesktopWeb ? styles.containerScrollWeb : styles.containerScrollMobile,
          isDesktopWeb && styles.containerDesktop,
          Platform.OS === 'android' && !isDesktopWeb && styles.containerAndroid,
        ]}
      >
      <View style={[styles.shell, isDesktopWeb && styles.shellDesktop]}>
        <View style={[styles.introPanel, isDesktopWeb && styles.introPanelDesktop]}>
          <Image
            source={require('../../assets/icon.png')}
            style={[styles.brandLogo, isDesktopWeb && styles.brandLogoDesktop]}
            resizeMode="contain"
            accessibilityLabel={brand.appName}
          />
          <Text style={styles.kicker}>{brand.appName}</Text>
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

          <LabeledInput
            label="Email"
            autoCapitalize="none"
            editable={!submitting}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
          />
          <LabeledInput
            label="Password"
            secureTextEntry
            editable={!submitting}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
          />

          {mode === 'register' && role === 'company' ? (
            <>
              <LabeledInput
                label="Company name"
                editable={!submitting}
                value={companyName}
                onChangeText={setCompanyName}
                placeholder="Company name"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
              <LabeledInput
                label="Company number"
                editable={!submitting}
                value={companyNumber}
                onChangeText={setCompanyNumber}
                placeholder="Company number"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
              <LabeledInput
                label="Address"
                editable={!submitting}
                value={address}
                onChangeText={setAddress}
                placeholder="Address"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
              <LabeledInput
                label="Contact details"
                editable={!submitting}
                value={contactDetails}
                onChangeText={setContactDetails}
                placeholder="Contact details"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
            </>
          ) : null}

          {mode === 'register' && role === 'guard' ? (
            <>
              <LabeledInput
                label="Full name"
                editable={!submitting}
                value={fullName}
                onChangeText={setFullName}
                placeholder="Full name"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
              <LabeledInput
                label="SIA licence number"
                editable={!submitting}
                value={siaLicenseNumber}
                onChangeText={setSiaLicenseNumber}
                placeholder="SIA licence number"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
              <LabeledInput
                label="Phone number"
                editable={!submitting}
                value={phone}
                onChangeText={setPhone}
                placeholder="Phone number"
                onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined}
              />
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardRoot: {
    flex: 1,
  },
  container: {
    padding: 24,
    backgroundColor: colors.background,
    gap: 10,
  },
  /** Wide web: keep vertically centred layout. */
  containerScrollWeb: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: 120,
  },
  /** Native / narrow: top-align so shrinking viewport + keyboard can scroll to focused field and CTA. */
  containerScrollMobile: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    paddingBottom: 240,
  },
  containerDesktop: {
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  /** Slight extra top inset on native Android when scroll content meets the status area. */
  containerAndroid: {
    paddingTop: 28,
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
  brandLogo: {
    width: 56,
    height: 56,
    alignSelf: 'center',
    marginBottom: 4,
  },
  brandLogoDesktop: {
    alignSelf: 'flex-start',
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
    flexShrink: 1,
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
  fieldBlock: {
    gap: 4,
    alignSelf: 'stretch',
    maxWidth: '100%',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  input: {
    alignSelf: 'stretch',
    width: '100%',
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    minHeight: 52,
    backgroundColor: colors.background,
    color: colors.textPrimary,
  },
  button: {
    marginTop: 8,
    backgroundColor: colors.primaryNavy,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.85,
  },
  buttonText: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontWeight: '700',
  },
});
