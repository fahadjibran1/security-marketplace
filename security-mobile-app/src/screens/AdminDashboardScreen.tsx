import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatApiErrorMessage,
  listAssignments,
  listAuditLogs,
  listCompanies,
  listGuards,
  listJobs,
  listShifts,
  listSites,
  listTimesheets,
} from '../services/api';
import { ADMIN_DASHBOARD_ENDPOINTS } from '../navigation/role-routing';
import { colors } from '../theme';

const LOADERS = [
  listCompanies,
  listGuards,
  listSites,
  listJobs,
  listAssignments,
  listShifts,
  listTimesheets,
  listAuditLogs,
] as const;

const LABELS = ['Companies', 'Guards', 'Sites', 'Jobs', 'Assignments', 'Shifts', 'Timesheets', 'Audit events'];

export function AdminDashboardScreen() {
  const [counts, setCounts] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(LOADERS.map((loader) => loader()));
      setCounts(results.map((items) => items.length));
    } catch (nextError) {
      setError(formatApiErrorMessage(nextError, 'Unable to load the Platform Admin overview.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.headingRow}>
        <View>
          <Text style={styles.title}>Platform Admin Dashboard</Text>
          <Text style={styles.subtitle}>Global read-only operational overview</Text>
        </View>
        <Pressable style={styles.refreshButton} onPress={load} disabled={loading}>
          <Text style={styles.refreshText}>{loading ? 'Loading…' : 'Refresh'}</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.grid}>
        {LABELS.map((label, index) => (
          <View style={styles.card} key={ADMIN_DASHBOARD_ENDPOINTS[index]}>
            <Text style={styles.cardLabel}>{label}</Text>
            <Text style={styles.cardValue}>{loading ? '—' : counts[index] ?? 0}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 20, backgroundColor: colors.background, minHeight: '100%' },
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, marginTop: 4 },
  refreshButton: { backgroundColor: colors.primaryNavy, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  refreshText: { color: '#FFFFFF', fontWeight: '700' },
  error: { color: '#B91C1C', backgroundColor: '#FEF2F2', borderRadius: 10, padding: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  card: { minWidth: 190, flexGrow: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 20 },
  cardLabel: { color: colors.textSecondary, fontWeight: '700' },
  cardValue: { color: colors.textPrimary, fontSize: 30, fontWeight: '800', marginTop: 8 },
});
