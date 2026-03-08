import { useMemo, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, View, Pressable, Text } from 'react-native';
import { CompanyDashboardScreen } from './src/screens/CompanyDashboardScreen';
import { GuardDashboardScreen } from './src/screens/GuardDashboardScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { RoleSelectionScreen } from './src/screens/RoleSelectionScreen';
import { AppRole, AuthSession } from './src/types/models';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [manualRole, setManualRole] = useState<AppRole | null>(null);

  const role = useMemo(() => manualRole || session?.user.role || null, [manualRole, session?.user.role]);

  if (!session) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <AuthScreen onLoggedIn={setSession} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      {role ? (
        <View style={styles.screenContainer}>
          <View style={styles.topBar}>
            <Text style={styles.topBarText}>{role === 'company' ? 'Company View' : 'Guard View'}</Text>
            <Pressable onPress={() => setManualRole((prev) => (prev || session.user.role) === 'company' ? 'guard' : 'company')}>
              <Text style={styles.switchText}>Switch Dashboard</Text>
            </Pressable>
            <Pressable onPress={() => setSession(null)}>
              <Text style={styles.switchText}>Logout</Text>
            </Pressable>
          </View>
          {role === 'company' ? <CompanyDashboardScreen /> : <GuardDashboardScreen />}
        </View>
      ) : (
        <RoleSelectionScreen onSelectRole={setManualRole} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f3f4f6' },
  screenContainer: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
    gap: 8,
  },
  topBarText: { fontWeight: '700', color: '#111827' },
  switchText: { color: '#2563eb', fontWeight: '600' },
});
