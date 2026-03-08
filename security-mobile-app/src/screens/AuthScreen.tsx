import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { login } from '../services/api';
import { AuthSession } from '../types/models';

interface AuthScreenProps {
  onLoggedIn: (session: AuthSession) => void;
}

export function AuthScreen({ onLoggedIn }: AuthScreenProps) {
  const [email, setEmail] = useState('admin@sentinel.com');
  const [password, setPassword] = useState('pass1234');
  const [submitting, setSubmitting] = useState(false);

  async function handleLogin() {
    try {
      setSubmitting(true);
      const session = await login(email, password);
      onLoggedIn(session);
    } catch (error) {
      Alert.alert('Login failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Security App Login</Text>
      <Text style={styles.subtitle}>Use seeded backend credentials to sign in.</Text>

      <TextInput style={styles.input} autoCapitalize="none" value={email} onChangeText={setEmail} placeholder="Email" />
      <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} placeholder="Password" />

      <Pressable style={styles.button} onPress={handleLogin} disabled={submitting}>
        <Text style={styles.buttonText}>{submitting ? 'Signing in...' : 'Sign In'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f9fafb',
    gap: 10,
  },
  title: { fontSize: 28, fontWeight: '700', color: '#111827', textAlign: 'center' },
  subtitle: { textAlign: 'center', color: '#4b5563', marginBottom: 8 },
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
