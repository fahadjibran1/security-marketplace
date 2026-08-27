import { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View, Pressable, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CompanyDashboardScreen } from './src/screens/CompanyDashboardScreen';
import { ClientPortalScreen } from './src/screens/ClientPortalScreen';
import { GuardDashboardScreen } from './src/screens/GuardDashboardScreen';
import { AdminDashboardScreen } from './src/screens/AdminDashboardScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { StatePanel } from './src/components/StatePanel';
import { logout, restoreSession, setUnauthorizedHandler } from './src/services/api';
import { installAttendanceLocationTransport } from './src/services/attendanceTransport';
import { clearStoredSession, loadStoredSession, persistSession } from './src/services/session';
import { AuthSession } from './src/types/models';
import { getAppSurface } from './src/navigation/role-routing';
import { brand, colors, control, radii, spacing, typography } from './src/theme';

const IS_WEB = typeof document !== 'undefined';

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  useEffect(() => installAttendanceLocationTransport(), []);
  useEffect(() => {
    async function bootstrapSession() {
      try { const storedSession = await loadStoredSession(); if (storedSession) { restoreSession(storedSession); setSession(storedSession); } }
      finally { setBooting(false); }
    }
    bootstrapSession();
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(async (message: string) => { logout(); await clearStoredSession(); setSession(null); setAuthNotice(message); });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function handleLoggedIn(nextSession: AuthSession) {
    if (getAppSurface(nextSession.user.role) === 'denied') { logout(); await clearStoredSession(); setSession(null); setAuthNotice('This account role is not supported. Contact an administrator.'); return; }
    restoreSession(nextSession); await persistSession(nextSession); setAuthNotice(null); setSession(nextSession);
  }
  async function handleLogout() { logout(); await clearStoredSession(); setAuthNotice(null); setSession(null); }

  const surface = session ? getAppSurface(session.user.role) : null;
  const surfaceLabel = surface === 'admin' ? 'Platform Admin' : surface === 'company' ? 'Company' : surface === 'client' ? 'Client' : surface === 'guard' ? 'Guard' : 'Access Denied';

  return <SafeAreaProvider>
    {booting ? <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="dark-content" backgroundColor={colors.background}/><View style={styles.loadingContainer}><StatePanel title={`Loading ${brand.appName}`} message="Restoring your secure session." tone="info" loading /></View></SafeAreaView>
    : !session ? <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="dark-content" backgroundColor={colors.background}/><AuthScreen onLoggedIn={handleLoggedIn} noticeMessage={authNotice} onDismissNotice={() => setAuthNotice(null)} /></SafeAreaView>
    : <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="light-content" backgroundColor={colors.primaryNavy}/><View style={styles.screenContainer}>
        <View style={styles.topBar}><View style={styles.brandBlock}><Text style={styles.brandMark}>{brand.shortBrand}</Text><View><Text style={styles.surfaceName}>{surfaceLabel}</Text><Text style={styles.productLabel}>{surface === 'guard' ? brand.guardAppName : brand.appName}</Text></View></View><Pressable accessibilityRole="button" onPress={handleLogout} style={({pressed}) => [styles.logoutButton, pressed && styles.pressed]}><Text style={styles.logoutText}>Log out</Text></Pressable></View>
        {surface === 'admin' ? <AdminDashboardScreen /> : surface === 'company' ? <CompanyDashboardScreen user={session.user} /> : surface === 'client' ? <ClientPortalScreen user={session.user} /> : surface === 'guard' ? <GuardDashboardScreen user={session.user} /> : <View style={styles.loadingContainer}><StatePanel title="Access denied" message="This account cannot open an S4 workspace. Log out and contact an administrator." tone="error" /></View>}
      </View></SafeAreaView>}
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background, ...(IS_WEB ? { height: '100vh', overflow: 'hidden' } : null) },
  screenContainer: { flex: 1, minHeight: 0, ...(IS_WEB ? { overflow: 'hidden' } : null) },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 62, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: colors.primaryNavy, gap: spacing.md },
  brandBlock: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  brandMark: { color: colors.accentTeal, fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  surfaceName: { color: colors.textOnBrand, ...typography.label },
  productLabel: { color: '#BFD0DE', ...typography.caption },
  logoutButton: { minHeight: control.minTouchTarget, justifyContent: 'center', borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryNavySoft, paddingHorizontal: spacing.md },
  logoutText: { color: colors.textOnBrand, ...typography.label },
  pressed: { opacity: 0.8 },
});
