import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { login, register } from '../services/api';
import { AuthSession, AppRole } from '../types/models';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void | Promise<void>;
}

type AuthMode = 'login' | 'register';

export function AuthScreen({ onLoggedIn }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [role, setRole] = useState<AppRole>('company');
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

  async function handleSubmit() {
    try {
      setSubmitting(true);

      const session =
        mode === 'login'
          ? await login(email, password)
          : await register({
              email,
              password,
              role,
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{mode === 'login' ? 'Security App Login' : 'Create Your Security Account'}</Text>
      <Text style={styles.subtitle}>
        {mode === 'login'
          ? 'Sign in with an existing account.'
          : 'Choose your role and complete the minimum onboarding details to get started.'}
      </Text>

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
          {submitting ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : mode === 'login' ? 'Sign In' : 'Create Account'}
        </Text>
      </Pressable>
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
  title: { fontSize: 28, fontWeight: '700', color: '#111827', textAlign: 'center' },
  subtitle: { textAlign: 'center', color: '#4b5563', marginBottom: 8 },
  helperText: { color: '#4b5563', textAlign: 'center' },
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
