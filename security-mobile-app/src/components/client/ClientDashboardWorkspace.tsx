import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ClientPortalDashboard } from '../../types/models';

export function ClientDashboardWorkspace({ dashboard }: { dashboard: ClientPortalDashboard | null }) {
  return (
    <View style={styles.stack}>
      <View style={styles.heroCard}>
        <Text style={styles.eyebrow}>Client Portal</Text>
        <Text style={styles.title}>{dashboard?.client.name || 'Your service overview'}</Text>
        <Text style={styles.subtitle}>A client-safe view of active sites, approved work, incidents, welfare, and invoices.</Text>
      </View>

      <View style={styles.metricGrid}>
        <MetricCard label="Active Sites" value={String(dashboard?.activeSites ?? 0)} />
        <MetricCard label="Approved Hours" value={String(dashboard?.approvedHoursThisPeriod ?? 0)} />
        <MetricCard label="Recent Incidents" value={String(dashboard?.recentIncidents.length ?? 0)} />
        <MetricCard label="Outstanding Invoices" value={String(dashboard?.invoicesSummary.outstanding ?? 0)} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Recent incidents</Text>
        {(dashboard?.recentIncidents || []).length === 0 ? (
          <Text style={styles.helperText}>No recent incidents for your sites.</Text>
        ) : (
          dashboard!.recentIncidents.map((incident) => (
            <View key={incident.id} style={styles.row}>
              <View style={styles.flexGrow}>
                <Text style={styles.rowTitle}>{incident.title}</Text>
                <Text style={styles.rowMeta}>{incident.siteName} · {incident.category} · {incident.severity}</Text>
              </View>
              <Text style={styles.rowStatus}>{incident.status}</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 18 },
  heroCard: { backgroundColor: '#0F172A', borderRadius: 24, padding: 22 },
  eyebrow: { color: '#7DD3FC', fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.4 },
  title: { color: '#FFFFFF', fontSize: 30, fontWeight: '800', marginTop: 8 },
  subtitle: { color: '#CBD5E1', marginTop: 8, lineHeight: 20 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metricCard: { minWidth: 170, flex: 1, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 16 },
  metricLabel: { color: '#64748B', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metricValue: { color: '#0F172A', fontSize: 24, fontWeight: '800', marginTop: 8 },
  panel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 18, gap: 12 },
  panelTitle: { color: '#0F172A', fontSize: 18, fontWeight: '800' },
  helperText: { color: '#64748B' },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', alignItems: 'center' },
  flexGrow: { flex: 1 },
  rowTitle: { color: '#0F172A', fontWeight: '800' },
  rowMeta: { color: '#64748B', marginTop: 2 },
  rowStatus: { color: '#0F172A', fontWeight: '700', textTransform: 'capitalize' },
});
