import { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View, Pressable, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CompanyDashboardScreen } from './src/screens/CompanyDashboardScreen';
import { ClientPortalScreen } from './src/screens/ClientPortalScreen';
import { GuardDashboardScreen } from './src/screens/GuardDashboardScreen';
import { AdminDashboardScreen } from './src/screens/AdminDashboardScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { logout, restoreSession, setUnauthorizedHandler } from './src/services/api';
import { installAttendanceLocationTransport } from './src/services/attendanceTransport';
import { clearStoredSession, loadStoredSession, persistSession } from './src/services/session';
import { AuthSession } from './src/types/models';
import { getAppSurface } from './src/navigation/role-routing';
import { colors } from './src/theme';

const IS_WEB = typeof document !== 'undefined';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  useEffect(() => installAttendanceLocationTransport(), []);

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

  useEffect(() => {
    setUnauthorizedHandler(async (message: string) => {
      logout();
      await clearStoredSession();
      setSession(null);
      setAuthNotice(message);
    });

    return () => {
      setUnauthorizedHandler(null);
    };
  }, []);

  async function handleLoggedIn(nextSession: AuthSession) {
    if (getAppSurface(nextSession.user.role) === 'denied') {
      logout();
      await clearStoredSession();
      setSession(null);
      setAuthNotice('This account role is not supported. Contact an administrator.');
      return;
    }
    restoreSession(nextSession);
    await persistSession(nextSession);
    setAuthNotice(null);
    setSession(nextSession);
  }

  async function handleLogout() {
    logout();
    await clearStoredSession();
    setAuthNotice(null);
    setSession(null);
  }

  const surface = session ? getAppSurface(session.user.role) : null;
  const surfaceLabel = surface === 'admin'
    ? 'Platform Admin'
    : surface === 'company'
      ? 'Company View'
      : surface === 'client'
        ? 'Client Portal'
        : surface === 'guard'
          ? 'Guard View'
          : 'Access Denied';

  return (
    <SafeAreaProvider>
      {booting ? (
        <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
          <StatusBar barStyle="dark-content" />
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Restoring session...</Text>
          </View>
        </SafeAreaView>
      ) : !session ? (
        <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
          <StatusBar barStyle="dark-content" />
          <AuthScreen
            onLoggedIn={handleLoggedIn}
            noticeMessage={authNotice}
            onDismissNotice={() => setAuthNotice(null)}
          />
        </SafeAreaView>
      ) : (
        <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
          <StatusBar barStyle="dark-content" />
          <View style={styles.screenContainer}>
            <View style={styles.topBar}>
              <Text style={styles.topBarText}>{surfaceLabel}</Text>
              <Pressable onPress={handleLogout}>
                <Text style={styles.switchText}>Logout</Text>
              </Pressable>
            </View>
            {surface === 'admin' ? (
              <AdminDashboardScreen />
            ) : surface === 'company' ? (
              <CompanyDashboardScreen user={session.user} />
            ) : surface === 'client' ? (
              <ClientPortalScreen user={session.user} />
            ) : surface === 'guard' ? (
              <GuardDashboardScreen user={session.user} />
            ) : (
              <View style={styles.loadingContainer}>
                <Text style={styles.loadingText}>Access denied. Please log out and contact an administrator.</Text>
              </View>
            )}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
    ...(IS_WEB ? { height: '100vh', overflow: 'hidden' } : null),
  },
  screenContainer: {
    flex: 1,
    minHeight: 0,
    ...(IS_WEB ? { overflow: 'hidden' } : null),
  },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    gap: 8,
  },
  topBarText: { fontWeight: '700', color: colors.textPrimary },
  switchText: { color: colors.supportBlue, fontWeight: '600' },
});
