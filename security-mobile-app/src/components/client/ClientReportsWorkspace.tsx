import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  getClientPortalIncidentReport,
  getClientPortalServiceHoursReport,
  getClientPortalWelfareReport,
} from '../../services/api';
import { ClientPortalIncident, ClientPortalWelfareRow } from '../../types/models';

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

export function ClientReportsWorkspace() {
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [siteId, setSiteId] = React.useState('');
  const [serviceRows, setServiceRows] = React.useState<Array<{ site: string; period: string; approvedHours: number }>>([]);
  const [incidentRows, setIncidentRows] = React.useState<ClientPortalIncident[]>([]);
  const [welfareRows, setWelfareRows] = React.useState<ClientPortalWelfareRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const filters = React.useMemo(() => ({
    startDate: startDate.trim() || undefined,
    endDate: endDate.trim() || undefined,
    siteId: siteId.trim() ? Number(siteId) : undefined,
  }), [endDate, siteId, startDate]);

  const loadReports = React.useCallback(async () => {
    setError(null);
    try {
      const [service, incidents, welfare] = await Promise.all([
        getClientPortalServiceHoursReport(filters),
        getClientPortalIncidentReport(filters),
        getClientPortalWelfareReport(filters),
      ]);
      setServiceRows(service);
      setIncidentRows(incidents);
      setWelfareRows(welfare);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load client reports.'));
    }
  }, [filters]);

  React.useEffect(() => {
    loadReports();
  }, []);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Reports</Text>
      <View style={styles.filterRow}>
        <TextInput style={styles.input} value={startDate} onChangeText={setStartDate} placeholder="Start date YYYY-MM-DD" />
        <TextInput style={styles.input} value={endDate} onChangeText={setEndDate} placeholder="End date YYYY-MM-DD" />
        <TextInput style={styles.input} value={siteId} onChangeText={setSiteId} placeholder="Site ID optional" />
        <Pressable style={styles.primaryButton} onPress={loadReports}>
          <Text style={styles.primaryButtonText}>Refresh</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <View style={styles.reportRow}>
        <Pressable
          style={styles.exportButton}
          onPress={() =>
            downloadCsv('client-service-hours-report.csv', [
              ['site', 'period', 'approved hours'],
              ...serviceRows.map((row) => [row.site, row.period, row.approvedHours]),
            ])
          }
        >
          <Text style={styles.exportButtonText}>Export Service Hours</Text>
        </Pressable>
        <Pressable
          style={styles.exportButton}
          onPress={() =>
            downloadCsv('client-incident-summary-report.csv', [
              ['site', 'date', 'incident type', 'severity', 'status', 'summary'],
              ...incidentRows.map((row) => [row.siteName, row.reportedAt, row.category, row.severity, row.status, row.summary]),
            ])
          }
        >
          <Text style={styles.exportButtonText}>Export Incident Summary</Text>
        </Pressable>
        <Pressable
          style={styles.exportButton}
          onPress={() =>
            downloadCsv('client-welfare-summary-report.csv', [
              ['site', 'period', 'check-calls expected', 'check-calls completed', 'missed count', 'compliance %', 'welfare alerts'],
              ...welfareRows.map((row) => [row.site, row.period, row.expectedCheckCalls, row.completedCheckCalls, row.missedCheckCalls, row.complianceRate, row.welfareAlerts]),
            ])
          }
        >
          <Text style={styles.exportButtonText}>Export Welfare Summary</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 18, gap: 12 },
  title: { color: '#0F172A', fontSize: 22, fontWeight: '800' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: { minWidth: 180, flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#FFF' },
  primaryButton: { backgroundColor: '#0F172A', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  primaryButtonText: { color: '#FFF', fontWeight: '800' },
  reportRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  exportButton: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: '#F8FAFC' },
  exportButtonText: { color: '#0F172A', fontWeight: '700' },
  errorText: { color: '#B91C1C', fontWeight: '700' },
});
