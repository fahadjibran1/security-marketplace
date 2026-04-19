import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  getIncidentAnalyticsReport,
  getSiteRiskReport,
  getWelfareAnalyticsReport,
} from '../../services/api';
import {
  IncidentAnalyticsReport,
  SiteRiskReport,
  WelfareAnalyticsReport,
} from '../../types/models';

const UK_LOCALE = 'en-GB';

function csvEscape(value: string | number | null | undefined) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  if (typeof document === 'undefined') return;
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatPercent(value?: number | null) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '0%' : `${Number(value).toFixed(2)}%`;
}

function formatDateLabel(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function sanitizeFilenamePart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}

function getTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

function getRiskTone(level?: string | null) {
  if (level === 'high') return { backgroundColor: '#FEE2E2', color: '#B91C1C' };
  if (level === 'medium') return { backgroundColor: '#FEF3C7', color: '#B45309' };
  return { backgroundColor: '#DCFCE7', color: '#166534' };
}

export function CompanyAnalyticsWorkspace() {
  const [incidentReport, setIncidentReport] = React.useState<IncidentAnalyticsReport | null>(null);
  const [welfareReport, setWelfareReport] = React.useState<WelfareAnalyticsReport | null>(null);
  const [siteRiskReport, setSiteRiskReport] = React.useState<SiteRiskReport | null>(null);
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [siteId, setSiteId] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [guardId, setGuardId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const filters = React.useMemo(
    () => ({
      startDate: startDate.trim() || undefined,
      endDate: endDate.trim() || undefined,
      siteId: siteId.trim() ? Number(siteId) : undefined,
      clientId: clientId.trim() ? Number(clientId) : undefined,
      guardId: guardId.trim() ? Number(guardId) : undefined,
    }),
    [clientId, endDate, guardId, siteId, startDate],
  );

  const loadReports = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextIncidents, nextWelfare, nextRisk] = await Promise.all([
        getIncidentAnalyticsReport(filters),
        getWelfareAnalyticsReport(filters),
        getSiteRiskReport(filters),
      ]);
      setIncidentReport(nextIncidents);
      setWelfareReport(nextWelfare);
      setSiteRiskReport(nextRisk);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load analytics reports.'));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  React.useEffect(() => {
    loadReports();
  }, []);

  const exportIncidentReport = React.useCallback(() => {
    if (!incidentReport) return;
    downloadCsv(
      `incident-report-${sanitizeFilenamePart(startDate || 'all')}-${getTimestamp()}.csv`,
      [
        ['date', 'site', 'client', 'guard', 'category', 'severity', 'notes'],
        ...incidentReport.records.map((row) => [formatDateLabel(row.reportedAt), row.site, row.client, row.guard, row.category, row.severity, row.notes]),
      ],
    );
  }, [incidentReport, startDate]);

  const exportWelfareReport = React.useCallback(() => {
    if (!welfareReport) return;
    downloadCsv(
      `welfare-report-${sanitizeFilenamePart(startDate || 'all')}-${getTimestamp()}.csv`,
      [
        ['guard', 'site', 'client', 'check-calls expected', 'check-calls completed', 'missed count', 'compliance %', 'late check-in', 'panic alerts', 'welfare alerts'],
        ...welfareReport.records.map((row) => [
          row.guard,
          row.site,
          row.client,
          row.expectedCheckCalls,
          row.completedCheckCalls,
          row.missedCheckCalls,
          row.complianceRate,
          row.lateCheckIn ? 'Yes' : 'No',
          row.panicAlerts,
          row.welfareAlerts,
        ]),
      ],
    );
  }, [startDate, welfareReport]);

  const exportSiteRiskReport = React.useCallback(() => {
    if (!siteRiskReport) return;
    downloadCsv(
      `site-risk-report-${sanitizeFilenamePart(startDate || 'all')}-${getTimestamp()}.csv`,
      [
        ['site', 'client', 'incidents', 'high severity incidents', 'alerts', 'missed check-calls', 'risk score', 'risk level'],
        ...siteRiskReport.sites.map((row) => [
          row.site,
          row.client,
          row.incidents,
          row.highSeverityIncidents,
          row.welfareAlerts + row.panicAlerts + row.lateCheckIns,
          row.missedCheckCalls,
          row.riskScore,
          row.riskLevel,
        ]),
      ],
    );
  }, [siteRiskReport, startDate]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View style={styles.headerTextBlock}>
          <Text style={styles.eyebrow}>Operational Intelligence</Text>
          <Text style={styles.title}>Analytics</Text>
          <Text style={styles.subtitle}>Incident trends, welfare KPIs, and site risk insights for contracts, renewals, audits, and live decisions.</Text>
        </View>
        <Pressable style={styles.primaryButton} onPress={loadReports} disabled={loading}>
          <Text style={styles.primaryButtonText}>{loading ? 'Refreshing...' : 'Refresh Analytics'}</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.filterCard}>
        <View style={styles.filterGrid}>
          <TextInput style={styles.input} value={startDate} onChangeText={setStartDate} placeholder="Start date (YYYY-MM-DD)" />
          <TextInput style={styles.input} value={endDate} onChangeText={setEndDate} placeholder="End date (YYYY-MM-DD)" />
          <TextInput style={styles.input} value={siteId} onChangeText={setSiteId} placeholder="Site ID (optional)" />
          <TextInput style={styles.input} value={clientId} onChangeText={setClientId} placeholder="Client ID (optional)" />
          <TextInput style={styles.input} value={guardId} onChangeText={setGuardId} placeholder="Guard ID (optional)" />
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <MetricCard label="Total Incidents" value={String(incidentReport?.totalIncidents ?? 0)} />
        <MetricCard label="Check-call Compliance" value={formatPercent(welfareReport?.checkCallComplianceRate)} />
        <MetricCard label="Missed Check-calls" value={String(welfareReport?.missedCheckCalls ?? 0)} />
        <MetricCard label="High-risk Sites" value={String(siteRiskReport?.summary.highRisk ?? 0)} />
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.panelTitle}>Incident Overview</Text>
            <Text style={styles.panelSubtitle}>Trends, categories, severity, and the riskiest sites from raw incident records.</Text>
          </View>
          <Pressable style={styles.secondaryButton} onPress={exportIncidentReport}>
            <Text style={styles.secondaryButtonText}>Export Incident Report</Text>
          </Pressable>
        </View>
        <View style={styles.bucketRow}>
          {(incidentReport?.byCategory || []).slice(0, 6).map((bucket) => (
            <View key={`cat-${bucket.key}`} style={styles.bucketCard}>
              <Text style={styles.bucketLabel}>{bucket.key.replace(/_/g, ' ')}</Text>
              <Text style={styles.bucketValue}>{bucket.count}</Text>
            </View>
          ))}
        </View>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.siteCol]}>High-Risk Site</Text>
          <Text style={styles.headerCell}>Client</Text>
          <Text style={styles.headerCell}>Incidents</Text>
          <Text style={styles.headerCell}>High Severity</Text>
        </View>
        {(incidentReport?.highRiskSites || []).slice(0, 8).map((site) => (
          <View key={`incident-site-${site.siteId ?? site.site}`} style={styles.tableRow}>
            <Text style={[styles.tableCellStrong, styles.siteCol]}>{site.site}</Text>
            <Text style={styles.tableCell}>{site.client}</Text>
            <Text style={styles.tableCell}>{site.count}</Text>
            <Text style={styles.tableCell}>{site.highSeverityCount}</Text>
          </View>
        ))}
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.panelTitle}>Welfare & Compliance</Text>
            <Text style={styles.panelSubtitle}>Check-call performance, missed calls, panic/welfare alerts, and late check-ins.</Text>
          </View>
          <Pressable style={styles.secondaryButton} onPress={exportWelfareReport}>
            <Text style={styles.secondaryButtonText}>Export Welfare Report</Text>
          </Pressable>
        </View>
        <View style={styles.summaryGrid}>
          <MetricCard label="Expected Calls" value={String(welfareReport?.expectedCheckCalls ?? 0)} compact />
          <MetricCard label="Completed Calls" value={String(welfareReport?.completedCheckCalls ?? 0)} compact />
          <MetricCard label="Panic Alerts" value={String(welfareReport?.panicAlerts ?? 0)} compact />
          <MetricCard label="Late Check-ins" value={String(welfareReport?.lateCheckIns ?? 0)} compact />
        </View>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.siteCol]}>Guard</Text>
          <Text style={styles.headerCell}>Expected</Text>
          <Text style={styles.headerCell}>Completed</Text>
          <Text style={styles.headerCell}>Missed</Text>
          <Text style={styles.headerCell}>Compliance</Text>
        </View>
        {(welfareReport?.byGuard || []).slice(0, 8).map((guard) => (
          <View key={`guard-${guard.guardId ?? guard.guard}`} style={styles.tableRow}>
            <Text style={[styles.tableCellStrong, styles.siteCol]}>{guard.guard}</Text>
            <Text style={styles.tableCell}>{guard.expected}</Text>
            <Text style={styles.tableCell}>{guard.completed}</Text>
            <Text style={styles.tableCell}>{guard.missed}</Text>
            <Text style={styles.tableCell}>{formatPercent(guard.complianceRate)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.panel}>
        <View style={styles.panelHeader}>
          <View>
            <Text style={styles.panelTitle}>Site Risk View</Text>
            <Text style={styles.panelSubtitle}>Simple weighted risk scoring from incidents, severity, missed check-calls, and welfare alerts.</Text>
          </View>
          <Pressable style={styles.secondaryButton} onPress={exportSiteRiskReport}>
            <Text style={styles.secondaryButtonText}>Export Site Risk Report</Text>
          </Pressable>
        </View>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.siteCol]}>Site</Text>
          <Text style={styles.headerCell}>Client</Text>
          <Text style={styles.headerCell}>Incidents</Text>
          <Text style={styles.headerCell}>Alerts</Text>
          <Text style={styles.headerCell}>Risk Score</Text>
          <Text style={styles.headerCell}>Level</Text>
        </View>
        {(siteRiskReport?.sites || []).map((site) => {
          const tone = getRiskTone(site.riskLevel);
          return (
            <View key={`risk-${site.siteId ?? site.site}`} style={styles.tableRow}>
              <Text style={[styles.tableCellStrong, styles.siteCol]}>{site.site}</Text>
              <Text style={styles.tableCell}>{site.client}</Text>
              <Text style={styles.tableCell}>{site.incidents}</Text>
              <Text style={styles.tableCell}>{site.welfareAlerts + site.panicAlerts + site.lateCheckIns}</Text>
              <Text style={styles.tableCell}>{site.riskScore.toFixed(2)}</Text>
              <View style={[styles.levelBadge, { backgroundColor: tone.backgroundColor }]}>
                <Text style={[styles.levelBadgeText, { color: tone.color }]}>{site.riskLevel}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function MetricCard({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <View style={[styles.metricCard, compact ? styles.metricCardCompact : null]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  headerCard: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 22,
    borderWidth: 1,
    borderColor: '#dbe4ef',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  headerTextBlock: { flex: 1 },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignSelf: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 14, paddingVertical: 10 },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  errorCard: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1, borderRadius: 16, padding: 14 },
  errorText: { color: '#991b1b', fontWeight: '700' },
  filterCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 170,
    flex: 1,
    backgroundColor: '#ffffff',
    borderColor: '#d6dce5',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
  },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metricCard: { minWidth: 180, flex: 1, backgroundColor: '#ffffff', borderRadius: 18, padding: 16, borderColor: '#dbe4ef', borderWidth: 1 },
  metricCardCompact: { minWidth: 150 },
  metricLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metricValue: { color: '#0f172a', fontSize: 24, fontWeight: '800', marginTop: 8 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 12 },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  panelSubtitle: { color: '#64748b', fontSize: 13, marginTop: 4 },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bucketCard: { backgroundColor: '#F8FAFC', borderColor: '#E2E8F0', borderWidth: 1, borderRadius: 16, padding: 12, minWidth: 120 },
  bucketLabel: { color: '#64748B', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  bucketValue: { color: '#0F172A', fontSize: 22, fontWeight: '800', marginTop: 6 },
  tableHeader: { flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomColor: '#e2e8f0', borderBottomWidth: 1 },
  tableRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomColor: '#f1f5f9', borderBottomWidth: 1, alignItems: 'center' },
  headerCell: { flex: 1, color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  tableCell: { flex: 1, color: '#0f172a', fontWeight: '700' },
  tableCellStrong: { color: '#0f172a', fontWeight: '800' },
  siteCol: { flex: 1.5 },
  levelBadge: { flex: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, alignItems: 'center' },
  levelBadgeText: { fontSize: 12, fontWeight: '800', textTransform: 'capitalize' },
});
