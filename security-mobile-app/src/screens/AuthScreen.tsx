import { useCallback, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { clientLogin, formatApiErrorMessage, login, register } from '../services/api';
import { AuthSession, AppRole } from '../types/models';
import { brand, colors, control, radii, spacing, typography } from '../theme';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void | Promise<void>;
  noticeMessage?: string | null;
  onDismissNotice?: () => void;
}

type AuthMode = 'login' | 'register';
type RegistrationRole = 'company' | 'guard';
type LoginRole = 'admin' | 'company' | 'guard' | 'client';

type LabeledInputProps = {
  label: string;
  style?: object | object[];
  placeholderTextColor?: string;
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
          const handler = inputRest.onFocus as ((e: any) => void) | undefined;
          handler?.(event);
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
    requestAnimationFrame(() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 72));
  }, []);

  const [mode, setMode] = useState<AuthMode>('login');
  const [role, setRole] = useState<RegistrationRole>('guard');
  const [loginRole, setLoginRole] = useState<LoginRole>('guard');
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
      const session = mode === 'login'
        ? loginRole === 'client' ? await clientLogin(email, password) : await login(email, password)
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
      setErrorMessage(formatApiErrorMessage(error, mode === 'login' ? 'We could not sign you in. Check your details and try again.' : 'We could not create your account. Check the details and try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  const isGuard = mode === 'login' ? loginRole === 'guard' : role === 'guard';
  const heading = mode === 'login' ? (isGuard ? 'Welcome back' : 'Sign in to S4') : (role === 'guard' ? 'Create your Guard account' : 'Create your Company account');
  const subheading = mode === 'login' ? (isGuard ? 'Sign in to manage your work, shifts and compliance.' : 'Use your existing S4 account to continue.') : (role === 'guard' ? 'Create your account now. Work eligibility remains subject to profile, compliance and approval checks.' : 'Set up your organisation to start managing security operations.');

  return (
    <KeyboardAvoidingView style={styles.keyboardRoot} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 6 : 0} enabled>
      <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled contentContainerStyle={[styles.container, isDesktopWeb ? styles.containerWeb : styles.containerMobile]}>
        <View style={[styles.shell, isDesktopWeb && styles.shellDesktop]}>
          <View style={[styles.brandPanel, isDesktopWeb && styles.brandPanelDesktop]}>
            <Image source={require('../../assets/icon.png')} style={styles.brandLogo} resizeMode="contain" accessibilityLabel={brand.appName} />
            <View>
              <Text style={styles.brandName}>{brand.shortBrand}</Text>
              <Text style={styles.productName}>{isGuard ? brand.guardAppName : brand.appName}</Text>
            </View>
            <Text style={[styles.brandHeadline, isDesktopWeb && styles.brandHeadlineDesktop]}>Security operations, without the noise.</Text>
            <Text style={styles.brandCopy}>One trusted workspace for people, sites, shifts and compliance.</Text>
            <View style={styles.trustRow}>
              <View style={styles.trustDot} />
              <Text style={styles.trustText}>{brand.tagline}</Text>
            </View>
          </View>

          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <Text style={styles.eyebrow}>{isGuard ? 'S4 GUARD' : 'S4 SECURITY'}</Text>
              <Text style={styles.title}>{heading}</Text>
              <Text style={styles.subtitle}>{subheading}</Text>
            </View>

            {noticeMessage ? <View style={styles.noticeBanner}><Text style={styles.noticeText}>{noticeMessage}</Text></View> : null}
            {errorMessage ? <View style={styles.errorBanner}><Text style={styles.errorText}>{errorMessage}</Text></View> : null}

            <View style={styles.modeRow}>
              {(['login', 'register'] as AuthMode[]).map((value) => (
                <Pressable key={value} accessibilityRole="button" style={[styles.segment, mode === value && styles.segmentActive]} onPress={() => { setMode(value); setErrorMessage(null); }}>
                  <Text style={[styles.segmentText, mode === value && styles.segmentTextActive]}>{value === 'login' ? 'Sign in' : 'Create account'}</Text>
                </Pressable>
              ))}
            </View>

            {mode === 'login' ? (
              <View style={styles.roleSection}>
                <Text style={styles.sectionLabel}>I’m signing in as</Text>
                <View style={styles.roleGrid}>
                  {(['guard', 'company', 'client', 'admin'] as LoginRole[]).map((value) => (
                    <Pressable key={value} style={[styles.roleButton, loginRole === value && styles.roleButtonActive]} onPress={() => setLoginRole(value)}>
                      <Text style={[styles.roleButtonText, loginRole === value && styles.roleButtonTextActive]}>{value === 'admin' ? 'Platform Admin' : value === 'company' ? 'Company' : value === 'guard' ? 'Guard' : 'Client'}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <View style={styles.roleSection}>
                <Text style={styles.sectionLabel}>Account type</Text>
                <View style={styles.roleGrid}>
                  {(['guard', 'company'] as RegistrationRole[]).map((value) => (
                    <Pressable key={value} style={[styles.roleButton, role === value && styles.roleButtonActive]} onPress={() => setRole(value)}>
                      <Text style={[styles.roleButtonText, role === value && styles.roleButtonTextActive]}>{value === 'guard' ? 'Guard' : 'Company'}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.fields}>
              <LabeledInput label="Email address" autoCapitalize="none" keyboardType="email-address" editable={!submitting} value={email} onChangeText={setEmail} placeholder="you@example.com" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
              <LabeledInput label="Password" secureTextEntry editable={!submitting} value={password} onChangeText={setPassword} placeholder="Enter your password" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />

              {mode === 'register' && role === 'company' ? <>
                <LabeledInput label="Company name" editable={!submitting} value={companyName} onChangeText={setCompanyName} placeholder="Company name" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <LabeledInput label="Company number" editable={!submitting} value={companyNumber} onChangeText={setCompanyNumber} placeholder="Company number" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <LabeledInput label="Address" editable={!submitting} value={address} onChangeText={setAddress} placeholder="Registered address" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <LabeledInput label="Contact details" editable={!submitting} value={contactDetails} onChangeText={setContactDetails} placeholder="Primary contact details" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
              </> : null}

              {mode === 'register' && role === 'guard' ? <>
                <LabeledInput label="Full name" editable={!submitting} value={fullName} onChangeText={setFullName} placeholder="Your full name" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <LabeledInput label="SIA licence number" editable={!submitting} value={siaLicenseNumber} onChangeText={setSiaLicenseNumber} placeholder="SIA licence number" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <LabeledInput label="Phone number" keyboardType="phone-pad" editable={!submitting} value={phone} onChangeText={setPhone} placeholder="Phone number" onInputFocus={!isDesktopWeb ? bumpScrollForKeyboard : undefined} />
                <View style={styles.pendingNote}><Text style={styles.pendingTitle}>Account creation does not mean approval to work</Text><Text style={styles.pendingText}>After signing in, complete your profile and compliance requirements. S4 will show your current work-readiness status.</Text></View>
              </> : null}
            </View>

            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, submitting && styles.primaryButtonDisabled]} onPress={handleSubmit} disabled={submitting}>
              <Text style={styles.primaryButtonText}>{submitting ? (mode === 'login' ? 'Signing in…' : 'Creating account…') : (mode === 'login' ? 'Sign in securely' : 'Create account')}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardRoot: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, backgroundColor: colors.background, padding: spacing.lg },
  containerWeb: { justifyContent: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xxl },
  containerMobile: { justifyContent: 'flex-start', paddingTop: Platform.OS === 'android' ? spacing.xxl : spacing.xl, paddingBottom: 220 },
  shell: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: spacing.lg },
  shellDesktop: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.xl },
  brandPanel: { backgroundColor: colors.primaryNavy, borderRadius: radii.xl, padding: spacing.xl, gap: spacing.md },
  brandPanelDesktop: { flex: 1, maxWidth: 460, padding: spacing.xxl, justifyContent: 'center' },
  brandLogo: { width: 56, height: 56 },
  brandName: { color: colors.accentTeal, fontSize: 28, fontWeight: '800', letterSpacing: 1 },
  productName: { color: colors.textOnBrand, ...typography.label },
  brandHeadline: { color: colors.textOnBrand, ...typography.title, marginTop: spacing.md },
  brandHeadlineDesktop: { fontSize: 32, lineHeight: 38 },
  brandCopy: { color: '#D6E2EC', ...typography.body },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  trustDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accentTeal },
  trustText: { color: '#BFD0DE', ...typography.caption, fontWeight: '600' },
  formCard: { flex: 1, width: '100%', maxWidth: 540, alignSelf: 'center', backgroundColor: colors.card, borderRadius: radii.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, gap: spacing.lg },
  formHeader: { gap: spacing.sm },
  eyebrow: { color: colors.accentTealStrong, ...typography.label, letterSpacing: 1.1 },
  title: { color: colors.textPrimary, ...typography.title },
  subtitle: { color: colors.textSecondary, ...typography.body },
  noticeBanner: { backgroundColor: colors.infoSurface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: '#BFDBFE' },
  noticeText: { color: colors.info, ...typography.label },
  errorBanner: { backgroundColor: colors.dangerSurface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: '#FECDCA' },
  errorText: { color: colors.danger, ...typography.label },
  modeRow: { flexDirection: 'row', backgroundColor: colors.surfaceSubtle, borderRadius: radii.md, padding: spacing.xs, gap: spacing.xs },
  segment: { flex: 1, minHeight: control.minTouchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm, paddingHorizontal: spacing.md },
  segmentActive: { backgroundColor: colors.card },
  segmentText: { color: colors.textSecondary, ...typography.label },
  segmentTextActive: { color: colors.primaryNavy, fontWeight: '700' },
  roleSection: { gap: spacing.sm },
  sectionLabel: { color: colors.textPrimary, ...typography.label },
  roleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  roleButton: { minHeight: control.minTouchTarget, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, backgroundColor: colors.card },
  roleButtonActive: { backgroundColor: colors.accentTealSoft, borderColor: colors.accentTealStrong },
  roleButtonText: { color: colors.textSecondary, ...typography.label },
  roleButtonTextActive: { color: colors.accentTealStrong },
  fields: { gap: spacing.md },
  fieldBlock: { gap: 6 },
  fieldLabel: { color: colors.textPrimary, ...typography.label },
  input: { minHeight: control.inputHeight, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radii.md, backgroundColor: colors.card, paddingHorizontal: spacing.lg, color: colors.textPrimary, ...typography.body },
  pendingNote: { backgroundColor: colors.warningSurface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs, borderWidth: 1, borderColor: '#FDE68A' },
  pendingTitle: { color: colors.warning, ...typography.label },
  pendingText: { color: colors.textSecondary, ...typography.caption },
  primaryButton: { minHeight: control.buttonHeight, borderRadius: radii.md, backgroundColor: colors.accentTealStrong, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primaryButtonPressed: { backgroundColor: colors.accentTeal },
  primaryButtonDisabled: { backgroundColor: colors.disabledSurface },
  primaryButtonText: { color: colors.textOnBrand, ...typography.bodyStrong },
});
