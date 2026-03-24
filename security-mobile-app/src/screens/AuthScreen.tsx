import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { login, register } from '../services/api';
import { AuthSession, AppRole } from '../types/models';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void | Promise<void>;
}

type AuthMode = 'login' | 'register';
type RegistrationRole = 'company' | 'guard';

export function AuthScreen({ onLoggedIn }: AuthScreenProps) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const [mode, setMode] = useState<AuthMode>('login');
  const [role, setRole] = useState<RegistrationRole>('company');
  const [email, setEmail] = useState('admin@sentinel.com');
  const [password, setPassword] = useState('pass1234');
  const [fullName, setFullName] = useState('');
  const [siaLicenseNumber, setSiaLicenseNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [address, setAddress] = useState('');
  const [contactDetails, setContactDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isDesktopWeb = width >= 980;

  async function handleSubmit() {
    try {
      setSubmitting(true);

      const session =
        mode === 'login'
          ? await login(email, password)
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
      Alert.alert(
        mode === 'login' ? 'Login failed' : 'Sign up failed',
        error instanceof Error ? error.message : 'Unknown error',
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
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeButton, mode === 'login' && styles.modeButtonActive]}
              onPress={() => setMode('login')}
            >
              <Text style={[styles.modeButtonText, mode === 'login' && styles.modeButtonTextActive]}>Sign In</Text>
            </Pressable>
            <Pressable
              style={[styles.modeButton, mode === 'register' && styles.modeButtonActive]}
              onPress={() => setMode('register')}
            >
              <Text style={[styles.modeButtonText, mode === 'register' && styles.modeButtonTextActive]}>Create Account</Text>
            </Pressable>
          </View>

          {mode === 'login' ? (
            <Text style={styles.helperText}>Demo credentials still work while we finish the full onboarding experience.</Text>
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

          <TextInput style={styles.input} autoCapitalize="none" value={email} onChangeText={setEmail} placeholder="Email" />
          <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} placeholder="Password" />

          {mode === 'register' && role === 'company' ? (
            <>
              <TextInput style={styles.input} value={companyName} onChangeText={setCompanyName} placeholder="Company name" />
              <TextInput style={styles.input} value={companyNumber} onChangeText={setCompanyNumber} placeholder="Company number" />
              <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="Address" />
              <TextInput
                style={styles.input}
                value={contactDetails}
                onChangeText={setContactDetails}
                placeholder="Contact details"
              />
            </>
          ) : null}

          {mode === 'register' && role === 'guard' ? (
            <>
              <TextInput style={styles.input} value={fullName} onChangeText={setFullName} placeholder="Full name" />
              <TextInput
                style={styles.input}
                value={siaLicenseNumber}
                onChangeText={setSiaLicenseNumber}
                placeholder="SIA licence number"
              />
              <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="Phone number" />
            </>
          ) : null}

          <Pressable style={styles.button} onPress={handleSubmit} disabled={submitting}>
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
    backgroundColor: '#f9fafb',
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
    backgroundColor: '#111827',
  },
  kicker: {
    color: '#60a5fa',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111827', textAlign: 'center' },
  titleDesktop: { color: '#fff', textAlign: 'left' },
  subtitle: { textAlign: 'center', color: '#4b5563', marginBottom: 8 },
  subtitleDesktop: { textAlign: 'left', color: '#d1d5db' },
  heroText: { color: '#d1d5db', lineHeight: 22 },
  helperText: { color: '#4b5563', textAlign: 'center' },
  formCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
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
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  modeButtonActive: {
    backgroundColor: '#111827',
    borderColor: '#111827',
  },
  modeButtonText: {
    textAlign: 'center',
    color: '#111827',
    fontWeight: '700',
  },
  modeButtonTextActive: {
    color: '#fff',
  },
  roleRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  roleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  roleButtonActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  roleButtonText: {
    textAlign: 'center',
    color: '#111827',
    fontWeight: '700',
  },
  roleButtonTextActive: {
    color: '#1d4ed8',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 12,
    backgroundColor: '#fff',
  },
  button: {
    marginTop: 8,
    backgroundColor: '#111827',
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: '700',
  },
});
