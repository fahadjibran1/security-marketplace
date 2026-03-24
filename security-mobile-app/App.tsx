import { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, View, Pressable, Text } from 'react-native';
import { CompanyDashboardScreen } from './src/screens/CompanyDashboardScreen';
import { GuardDashboardScreen } from './src/screens/GuardDashboardScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { logout, restoreSession } from './src/services/api';
import { clearStoredSession, loadStoredSession, persistSession } from './src/services/session';
import { AuthSession, isCompanyAppRole } from './src/types/models';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    async function bootstrapSession() {
      try {
        const storedSession = await loadStoredSession();
        if (storedSession) {
          restoreSession(storedSession);
          setSession(storedSession);
        }
      } finally {
        setBooting(false);
      }
    }

    bootstrapSession();
  }, []);

  async function handleLoggedIn(nextSession: AuthSession) {
    restoreSession(nextSession);
    await persistSession(nextSession);
    setSession(nextSession);
  }

  async function handleLogout() {
    logout();
    await clearStoredSession();
    setSession(null);
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Restoring session...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <AuthScreen onLoggedIn={handleLoggedIn} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.screenContainer}>
        <View style={styles.topBar}>
          <Text style={styles.topBarText}>{isCompanyAppRole(session.user.role) ? 'Company View' : 'Guard View'}</Text>
          <Pressable onPress={handleLogout}>
            <Text style={styles.switchText}>Logout</Text>
          </Pressable>
        </View>
        {isCompanyAppRole(session.user.role) ? (
          <CompanyDashboardScreen user={session.user} />
        ) : (
          <GuardDashboardScreen user={session.user} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f3f4f6' },
  screenContainer: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#374151', fontSize: 16, fontWeight: '600' },
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
