import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage, getCompanyMarginReport } from '../../services/api';
import { MarginReport } from '../../types/models';

const UK_LOCALE = 'en-GB';
const MONEY_FORMATTER = new Intl.NumberFormat(UK_LOCALE, { style: 'currency', currency: 'GBP' });

function formatMoney(value?: number | null) {
  return MONEY_FORMATTER.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatPercent(value?: number | null) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'Unavailable' : `${value.toFixed(2)}%`;
}

function formatHours(value?: number | null) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00';
}

function getMarginTone(marginPercent?: number | null, margin?: number | null) {
  if ((margin ?? 0) < 0) return { label: 'Negative', color: '#B91C1C', background: '#FEE2E2' };
  if (marginPercent !== null && marginPercent !== undefined && marginPercent < 20) {
    return { label: 'Low margin', color: '#B45309', background: '#FEF3C7' };
  }
  return { label: 'Profitable', color: '#047857', background: '#D1FAE5' };
}

export function CompanyMarginWorkspace() {
  const [report, setReport] = React.useState<MarginReport | null>(null);
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [siteId, setSiteId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadReport = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextReport = await getCompanyMarginReport({
        startDate: startDate.trim() || undefined,
        endDate: endDate.trim() || undefined,
        clientId: clientId.trim() ? Number(clientId) : undefined,
        siteId: siteId.trim() ? Number(siteId) : undefined,
      });
      setReport(nextReport);
    } catch (err) {
      setError(formatApiErrorMessage(err, 'Unable to load margin report.'));
    } finally {
      setLoading(false);
    }
  }, [clientId, endDate, siteId, startDate]);

  React.useEffect(() => {
    loadReport();
  }, []);

  const totalTone = getMarginTone(report?.marginPercent ?? null, report?.totalMargin ?? null);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Commercial Intelligence</Text>
          <Text style={styles.title}>Margins</Text>
          <Text style={styles.subtitle}>Approved-timesheet revenue, guard cost, and profit by client, site, and contract rule.</Text>
        </View>
        <Pressable style={styles.primaryButton} onPress={loadReport} disabled={loading}>
          <Text style={styles.primaryButtonText}>{loading ? 'Refreshing...' : 'Refresh Report'}</Text>
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
          <TextInput style={styles.input} value={clientId} onChangeText={setClientId} placeholder="Client ID (optional)" />
          <TextInput style={styles.input} value={siteId} onChangeText={setSiteId} placeholder="Site ID (optional)" />
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <MetricCard label="Total Revenue" value={formatMoney(report?.totalRevenue)} />
        <MetricCard label="Total Cost" value={formatMoney(report?.totalCost)} />
        <MetricCard label="Total Profit" value={formatMoney(report?.totalMargin)} />
        <MetricCard label="Margin %" value={formatPercent(report?.marginPercent)} tone={totalTone} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Commercial Breakdown</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.headerCell, styles.clientCol]}>Client</Text>
          <Text style={styles.headerCell}>Site</Text>
          <Text style={styles.headerCell}>Contract Rule</Text>
          <Text style={styles.headerCell}>Hours</Text>
          <Text style={styles.headerCell}>Revenue</Text>
          <Text style={styles.headerCell}>Cost</Text>
          <Text style={styles.headerCell}>Profit</Text>
          <Text style={styles.headerCell}>Margin %</Text>
        </View>
        {!report?.breakdown.length ? (
          <Text style={styles.helperText}>No approved timesheet margin data matches the current filters.</Text>
        ) : (
          report.breakdown.map((row) => {
            const tone = getMarginTone(row.marginPercent, row.margin);
            return (
              <View key={`${row.clientId ?? 'unassigned'}-${row.siteId ?? 'all-sites'}-${row.contractRuleId ?? 'fallback'}-${row.clientName}`} style={styles.tableRow}>
                <Text style={[styles.tableCellStrong, styles.clientCol]}>{row.clientName}</Text>
                <Text style={styles.tableCell}>{row.siteName || 'All sites'}</Text>
                <Text style={styles.tableCell}>{row.contractRuleName || 'Fallback rate'}</Text>
                <Text style={styles.tableCell}>{formatHours(row.approvedHours)} / {formatHours(row.billableHours)}</Text>
                <Text style={styles.tableCell}>{formatMoney(row.revenue)}</Text>
                <Text style={styles.tableCell}>{formatMoney(row.cost)}</Text>
                <Text style={[styles.tableCell, { color: tone.color }]}>{formatMoney(row.margin)}</Text>
                <View style={[styles.marginBadge, { backgroundColor: tone.background }]}>
                  <Text style={[styles.marginBadgeText, { color: tone.color }]}>{formatPercent(row.marginPercent)}</Text>
                </View>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: { color: string; background: string } }) {
  return (
    <View style={[styles.metricCard, tone ? { backgroundColor: tone.background } : null]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, tone ? { color: tone.color } : null]}>{value}</Text>
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
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignSelf: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  errorCard: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1, borderRadius: 16, padding: 14 },
  errorText: { color: '#991b1b', fontWeight: '700' },
  filterCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 180,
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
  metricCard: { minWidth: 170, flex: 1, backgroundColor: '#ffffff', borderRadius: 18, padding: 16, borderColor: '#dbe4ef', borderWidth: 1 },
  metricLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metricValue: { color: '#0f172a', fontSize: 24, fontWeight: '800', marginTop: 8 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 12 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  tableHeader: { flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomColor: '#e2e8f0', borderBottomWidth: 1 },
  tableRow: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomColor: '#f1f5f9', borderBottomWidth: 1, alignItems: 'center' },
  headerCell: { flex: 1, color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  tableCell: { flex: 1, color: '#0f172a', fontWeight: '700' },
  tableCellStrong: { color: '#0f172a', fontWeight: '800' },
  clientCol: { flex: 1.5 },
  marginBadge: { flex: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, alignItems: 'center' },
  marginBadgeText: { fontSize: 12, fontWeight: '800' },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
});
