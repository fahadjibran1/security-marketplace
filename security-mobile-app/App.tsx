import { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View, Pressable, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CompanyDashboardScreen } from './src/screens/CompanyDashboardScreen';
import { ClientPortalScreen } from './src/screens/ClientPortalScreen';
import { GuardDashboardScreen } from './src/screens/GuardDashboardScreen';
import { AdminDashboardScreen } from './src/screens/AdminDashboardScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { StatePanel } from './src/components/StatePanel';
import { fetchCurrentUser, getRefreshToken, logout, restoreSession, setRefreshPersister, setUnauthorizedHandler } from './src/services/api';
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
      try {
        const storedSession = await loadStoredSession();
        if (storedSession) {
          // No access token is ever persisted. A v3 session carries the renewable refresh token
          // and the very first authenticated call mints an access token through the 401 path;
          // a pre-v1.0.4 session carries only its old access token and no way to renew.
          restoreSession({
            accessToken: storedSession.legacyAccessToken,
            refreshToken: storedSession.refreshToken,
          });
          setSession({ accessToken: storedSession.legacyAccessToken ?? '', user: storedSession.user });
          // Refresh effective permissions from the live server; update in-memory
          // and persisted session so next boot also has fresh permissions. For a v3 session this
          // call is also what silently establishes the access token for this launch.
          fetchCurrentUser().then(freshUser => {
            setSession({ accessToken: '', user: freshUser });
            const rotated = getRefreshToken();
            if (rotated) persistSession({ user: freshUser, refreshToken: rotated });
          }).catch(() => { /* offline — keep the cached user; the 401 path handles a dead session */ });
        }
      }
      finally { setBooting(false); }
    }
    bootstrapSession();
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(async (message: string) => { await clearStoredSession(); setSession(null); setAuthNotice(message); });
    // Every silent rotation must reach SecureStore immediately: the token it replaces is already
    // dead server-side, so a missed write would strand the device on the next cold start.
    setRefreshPersister(async ({ user, refreshToken }) => { await persistSession({ user, refreshToken }); });
    return () => { setUnauthorizedHandler(null); setRefreshPersister(null); };
  }, []);

  async function handleLoggedIn(nextSession: AuthSession) {
    if (getAppSurface(nextSession.user.role) === 'denied') { await logout(); await clearStoredSession(); setSession(null); setAuthNotice('This account role is not supported. Contact an administrator.'); return; }
    restoreSession(nextSession); if (nextSession.refreshToken) await persistSession({ user: nextSession.user, refreshToken: nextSession.refreshToken }); setAuthNotice(null); setSession(nextSession);
  }
  async function handleLogout() { await logout(); await clearStoredSession(); setAuthNotice(null); setSession(null); }

  const surface = session ? getAppSurface(session.user.role) : null;
  const surfaceLabel = surface === 'admin' ? 'Platform Admin' : surface === 'company' ? 'Company' : surface === 'client' ? 'Client' : surface === 'guard' ? 'Guard' : 'Access Denied';

  return <SafeAreaProvider>
    {booting ? <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="dark-content" backgroundColor={colors.background}/><View style={styles.loadingContainer}><StatePanel title={`Loading ${brand.appName}`} message="Restoring your secure session." tone="info" loading /></View></SafeAreaView>
    : !session ? <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="dark-content" backgroundColor={colors.background}/><AuthScreen onLoggedIn={handleLoggedIn} noticeMessage={authNotice} onDismissNotice={() => setAuthNotice(null)} /></SafeAreaView>
    : <SafeAreaView style={styles.safeArea} edges={['top','right','bottom','left']}><StatusBar barStyle="light-content" backgroundColor={colors.primaryNavy}/><View style={styles.screenContainer}>
        {surface !== 'company' ? <View style={styles.topBar}><View style={styles.brandBlock}><Text style={styles.brandMark}>{brand.shortBrand}</Text><View><Text style={styles.surfaceName}>{surfaceLabel}</Text><Text style={styles.productLabel}>{surface === 'guard' ? brand.guardAppName : brand.appName}</Text></View></View><Pressable accessibilityRole="button" onPress={handleLogout} style={({ pressed }: { pressed: boolean }) => [styles.logoutButton, pressed && styles.pressed]}><Text style={styles.logoutText}>Log out</Text></Pressable></View> : null}
        {surface === 'admin' ? <AdminDashboardScreen /> : surface === 'company' ? <CompanyDashboardScreen user={session.user} onLogout={handleLogout} /> : surface === 'client' ? <ClientPortalScreen user={session.user} /> : surface === 'guard' ? <GuardDashboardScreen user={session.user} onLogout={handleLogout} /> : <View style={styles.loadingContainer}><StatePanel title="Access denied" message="This account cannot open an S4 workspace. Log out and contact an administrator." tone="error" /></View>}
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
  productLabel: { color: colors.border, ...typography.caption },
  logoutButton: { minHeight: control.minTouchTarget, justifyContent: 'center', borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryNavySoft, paddingHorizontal: spacing.md },
  logoutText: { color: colors.textOnBrand, ...typography.label },
  pressed: { opacity: 0.8 },
});
