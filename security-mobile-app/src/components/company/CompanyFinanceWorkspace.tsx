import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  formatApiErrorMessage,
  getFinanceReceivables,
  getFinanceReconciliation,
  getFinanceSummary,
} from '../../services/api';
import {
  FinanceMonthlyPoint,
  FinanceReceivablesResponse,
  FinanceReconciliationResponse,
  FinanceSummaryResponse,
  Timesheet,
} from '../../types/models';

type CompanyFinanceWorkspaceProps = {
  timesheets: Timesheet[];
  refreshing?: boolean;
  onRefresh?: () => Promise<void> | void;
};

type WebOption = { value: string; label: string };

const UK_LOCALE = 'en-GB';
const MONEY_FORMATTER = new Intl.NumberFormat(UK_LOCALE, { style: 'currency', currency: 'GBP' });

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

function sanitizeFilenamePart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

function getDownloadTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatMoney(value?: number | null) {
  return MONEY_FORMATTER.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatStatusLabel(value?: string | null) {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function getClientMeta(timesheet: Timesheet) {
  const client = timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
  return {
    id: client?.id ?? timesheet.shift?.site?.clientId ?? timesheet.shift?.job?.site?.clientId ?? null,
    name: client?.name ?? timesheet.shift?.site?.clientName ?? 'Unknown client',
  };
}

function getSiteMeta(timesheet: Timesheet) {
  return {
    id: timesheet.shift?.site?.id ?? timesheet.shift?.siteId ?? timesheet.shift?.job?.siteId ?? null,
    name: timesheet.shift?.site?.name ?? timesheet.shift?.siteName ?? 'Unknown site',
  };
}

function WebSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: WebOption[] }) {
  const [browserReady, setBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setBrowserReady(typeof document !== 'undefined');
  }, []);

  if (browserReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag value={value} onChange={(event: any) => onChange(event.target.value)} style={webSelectStyle}>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }

  return <TextInput style={styles.input} value={value} onChangeText={onChange} />;
}

export function CompanyFinanceWorkspace({ timesheets, refreshing, onRefresh }: CompanyFinanceWorkspaceProps) {
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [clientFilter, setClientFilter] = React.useState('all');
  const [siteFilter, setSiteFilter] = React.useState('all');
  const [summary, setSummary] = React.useState<FinanceSummaryResponse | null>(null);
  const [receivables, setReceivables] = React.useState<FinanceReceivablesResponse | null>(null);
  const [reconciliation, setReconciliation] = React.useState<FinanceReconciliationResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const clientOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    timesheets.forEach((timesheet) => {
      const client = getClientMeta(timesheet);
      if (client.id) map.set(String(client.id), client.name);
    });
    return [{ value: 'all', label: 'All clients' }, ...Array.from(map.entries()).map(([value, label]) => ({ value, label }))];
  }, [timesheets]);

  const siteOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    timesheets.forEach((timesheet) => {
      const site = getSiteMeta(timesheet);
      if (site.id) map.set(String(site.id), site.name);
    });
    return [{ value: 'all', label: 'All sites' }, ...Array.from(map.entries()).map(([value, label]) => ({ value, label }))];
  }, [timesheets]);

  const filters = React.useMemo(
    () => ({
      startDate: startDate.trim() || undefined,
      endDate: endDate.trim() || undefined,
      clientId: clientFilter !== 'all' ? Number(clientFilter) : undefined,
      siteId: siteFilter !== 'all' ? Number(siteFilter) : undefined,
    }),
    [clientFilter, endDate, siteFilter, startDate],
  );

  const loadFinance = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryResponse, receivablesResponse, reconciliationResponse] = await Promise.all([
        getFinanceSummary(filters),
        getFinanceReceivables(filters),
        getFinanceReconciliation(filters),
      ]);
      setSummary(summaryResponse);
      setReceivables(receivablesResponse);
      setReconciliation(reconciliationResponse);
    } catch (loadError) {
      setError(formatApiErrorMessage(loadError, 'Unable to load finance reconciliation.'));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  React.useEffect(() => {
    loadFinance();
  }, [loadFinance]);

  const handleRefresh = React.useCallback(async () => {
    await Promise.all([Promise.resolve(onRefresh?.()), loadFinance()]);
  }, [loadFinance, onRefresh]);

  const exportSummary = React.useCallback(() => {
    if (!summary) return;
    const rows: Array<Array<string | number | null | undefined>> = [
      ['period', 'revenue', 'cost', 'profit'],
      ...summary.monthly.map((point: FinanceMonthlyPoint) => [point.month, point.revenue.toFixed(2), point.cost.toFixed(2), point.profit.toFixed(2)]),
    ];
    downloadCsv(`finance-summary-${sanitizeFilenamePart(clientFilter)}-${sanitizeFilenamePart(siteFilter)}-${getDownloadTimestamp()}.csv`, rows);
  }, [clientFilter, siteFilter, summary]);

  const exportReceivables = React.useCallback(() => {
    if (!receivables) return;
    const rows: Array<Array<string | number | null | undefined>> = [[
      'invoice',
      'client',
      'sites',
      'issued date',
      'due date',
      'amount',
      'paid',
      'outstanding',
      'payment status',
      'age bucket',
      'age days',
    ]];

    receivables.rows.forEach((row) => {
      rows.push([
        row.invoiceNumber || row.invoiceReference || `Batch #${row.invoiceBatchId}`,
        row.clientName,
        row.siteNames.join(' | '),
        formatDate(row.issuedDate),
        formatDate(row.dueDate),
        row.amount.toFixed(2),
        row.paid.toFixed(2),
        row.outstanding.toFixed(2),
        formatStatusLabel(row.paymentStatus),
        row.ageBucket,
        row.ageDays,
      ]);
    });

    downloadCsv(`finance-receivables-${sanitizeFilenamePart(clientFilter)}-${sanitizeFilenamePart(siteFilter)}-${getDownloadTimestamp()}.csv`, rows);
  }, [clientFilter, receivables, siteFilter]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Finance Reconciliation</Text>
          <Text style={styles.title}>Finance</Text>
          <Text style={styles.subtitle}>
            Connect approved work, payroll cost, invoiced revenue, and received cash without changing the existing batch workflows.
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={handleRefresh} disabled={refreshing || loading}>
            <Text style={styles.secondaryButtonText}>{refreshing || loading ? 'Refreshing...' : 'Refresh'}</Text>
          </Pressable>
          <Pressable style={[styles.secondaryButton, !summary && styles.disabledButton]} onPress={exportSummary} disabled={!summary}>
            <Text style={styles.secondaryButtonText}>Export Summary</Text>
          </Pressable>
          <Pressable style={[styles.primaryButton, !receivables && styles.disabledButton]} onPress={exportReceivables} disabled={!receivables}>
            <Text style={styles.primaryButtonText}>Export Receivables</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.filterCard}>
        <View style={styles.filterGrid}>
          <TextInput style={styles.input} value={startDate} onChangeText={setStartDate} placeholder="Date from YYYY-MM-DD" />
          <TextInput style={styles.input} value={endDate} onChangeText={setEndDate} placeholder="Date to YYYY-MM-DD" />
          <WebSelect value={clientFilter} onChange={setClientFilter} options={clientOptions} />
          <WebSelect value={siteFilter} onChange={setSiteFilter} options={siteOptions} />
        </View>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Finance data unavailable</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.summaryGrid}>
        <MetricCard label="Total Revenue" value={formatMoney(summary?.revenueSummary.totalRevenue)} />
        <MetricCard label="Total Cost" value={formatMoney(summary?.costSummary.totalCost)} />
        <MetricCard label="Profit" value={formatMoney(summary?.profitSummary.totalProfit)} />
        <MetricCard label="Outstanding" value={formatMoney(summary?.revenueSummary.outstandingRevenue)} tone="warning" />
        <MetricCard label="Paid Revenue" value={formatMoney(summary?.revenueSummary.totalPaid)} />
        <MetricCard label="Pending Payroll" value={formatMoney(summary?.costSummary.pendingPayroll)} tone="warning" />
      </View>

      <View style={styles.contentLayout}>
        <View style={styles.mainColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Revenue vs Cost by Month</Text>
            {loading ? (
              <Text style={styles.helperText}>Loading finance summary...</Text>
            ) : summary?.monthly.length ? (
              summary.monthly.map((point) => (
                <View key={point.month} style={styles.monthRow}>
                  <View style={styles.monthMeta}>
                    <Text style={styles.monthLabel}>{point.month}</Text>
                    <Text style={styles.helperText}>Profit {formatMoney(point.profit)}</Text>
                  </View>
                  <View style={styles.monthValues}>
                    <Text style={styles.monthValue}>Revenue {formatMoney(point.revenue)}</Text>
                    <Text style={styles.monthValue}>Cost {formatMoney(point.cost)}</Text>
                  </View>
                </View>
              ))
            ) : (
              <Text style={styles.helperText}>No finance summary rows match the current filters.</Text>
            )}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Aged Receivables</Text>
            {loading ? (
              <Text style={styles.helperText}>Loading receivables...</Text>
            ) : receivables ? (
              <>
                <View style={styles.bucketRow}>
                  <BucketCard label="0-30 days" value={formatMoney(receivables.buckets['0-30'])} />
                  <BucketCard label="31-60 days" value={formatMoney(receivables.buckets['31-60'])} />
                  <BucketCard label="61-90 days" value={formatMoney(receivables.buckets['61-90'])} />
                  <BucketCard label="90+ days" value={formatMoney(receivables.buckets['90+'])} tone="danger" />
                </View>
                <ScrollView horizontal>
                  <View style={styles.table}>
                    <View style={styles.tableHeader}>
                      <Text style={[styles.headerCell, styles.invoiceCol]}>Invoice</Text>
                      <Text style={styles.headerCell}>Client</Text>
                      <Text style={styles.headerCell}>Issued</Text>
                      <Text style={styles.headerCell}>Amount</Text>
                      <Text style={styles.headerCell}>Paid</Text>
                      <Text style={styles.headerCell}>Outstanding</Text>
                      <Text style={styles.headerCell}>Age</Text>
                      <Text style={styles.headerCell}>Status</Text>
                    </View>
                    {receivables.rows.map((row) => (
                      <View key={row.invoiceBatchId} style={styles.tableRow}>
                        <View style={styles.invoiceCol}>
                          <Text style={styles.rowTitle}>{row.invoiceNumber || row.invoiceReference || `Batch #${row.invoiceBatchId}`}</Text>
                          <Text style={styles.rowMeta}>{row.siteNames.join(' | ')}</Text>
                        </View>
                        <Text style={styles.tableCell}>{row.clientName}</Text>
                        <Text style={styles.tableCell}>{formatDate(row.issuedDate)}</Text>
                        <Text style={styles.tableCell}>{formatMoney(row.amount)}</Text>
                        <Text style={styles.tableCell}>{formatMoney(row.paid)}</Text>
                        <Text style={styles.tableCell}>{formatMoney(row.outstanding)}</Text>
                        <Text style={styles.tableCell}>{row.ageBucket}</Text>
                        <Text style={styles.tableCell}>{formatStatusLabel(row.paymentStatus)}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </>
            ) : null}
          </View>
        </View>

        <View style={styles.sideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Invoice Payment Tracking</Text>
            {loading ? (
              <Text style={styles.helperText}>Loading payment tracking...</Text>
            ) : reconciliation?.rows.length ? (
              reconciliation.rows.map((row) => (
                <View key={`track-${row.invoiceBatchId}`} style={styles.reconCard}>
                  <Text style={styles.rowTitle}>{row.invoiceNumber || row.invoiceReference || `Batch #${row.invoiceBatchId}`}</Text>
                  <Text style={styles.helperText}>{row.clientName}</Text>
                  <Detail label="Invoice amount" value={formatMoney(row.amount)} />
                  <Detail label="Paid" value={formatMoney(row.paid)} />
                  <Detail label="Remaining" value={formatMoney(row.outstanding)} />
                  <Detail label="Status" value={formatStatusLabel(row.paymentStatus)} />
                  {row.payments.length ? (
                    <View style={styles.paymentList}>
                      {row.payments.map((payment) => (
                        <Text key={payment.id} style={styles.paymentItem}>
                          {formatDate(payment.paymentDate)} | {formatMoney(payment.amount)} | {formatStatusLabel(payment.method)}
                          {payment.reference ? ` | ${payment.reference}` : ''}
                        </Text>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.helperText}>No payments recorded yet.</Text>
                  )}
                </View>
              ))
            ) : (
              <Text style={styles.helperText}>No invoice reconciliation rows match these filters.</Text>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'danger' }) {
  const toneStyle = tone === 'danger' ? styles.metricDanger : tone === 'warning' ? styles.metricWarning : null;
  return (
    <View style={[styles.metricCard, toneStyle]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function BucketCard({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <View style={[styles.bucketCard, tone === 'danger' && styles.bucketDanger]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const webSelectStyle = {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: '#d6dce5',
  backgroundColor: '#ffffff',
  padding: '12px 14px',
  fontSize: 14,
  color: '#132238',
  minHeight: 46,
} as const;

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
    flexWrap: 'wrap',
    gap: 16,
  },
  headerCopy: { flex: 1, minWidth: 320 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  eyebrow: { color: '#0f766e', fontSize: 12, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { color: '#0f172a', fontSize: 30, fontWeight: '800' },
  subtitle: { color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center' },
  primaryButtonText: { color: '#ffffff', fontWeight: '800' },
  secondaryButton: { backgroundColor: '#ffffff', borderColor: '#cbd5e1', borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  disabledButton: { opacity: 0.45 },
  filterCard: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: {
    minWidth: 190,
    flex: 1,
    backgroundColor: '#ffffff',
    borderColor: '#d6dce5',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
  },
  errorCard: { backgroundColor: '#fee2e2', borderRadius: 18, padding: 16, gap: 4 },
  errorTitle: { color: '#991b1b', fontWeight: '800' },
  errorText: { color: '#7f1d1d' },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metricCard: { minWidth: 170, flex: 1, backgroundColor: '#ffffff', borderRadius: 18, padding: 16, borderColor: '#dbe4ef', borderWidth: 1 },
  metricWarning: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  metricDanger: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  metricLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metricValue: { color: '#0f172a', fontSize: 20, fontWeight: '800', marginTop: 8 },
  contentLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  mainColumn: { flex: 2, minWidth: 620, gap: 18 },
  sideColumn: { flex: 1, minWidth: 360, gap: 18 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  monthRow: { borderBottomColor: '#eef2f7', borderBottomWidth: 1, paddingBottom: 10, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  monthMeta: { flex: 1 },
  monthLabel: { color: '#0f172a', fontWeight: '800', fontSize: 15 },
  monthValues: { minWidth: 240, gap: 4 },
  monthValue: { color: '#334155', fontWeight: '700', textAlign: 'right' },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bucketCard: { minWidth: 150, flex: 1, backgroundColor: '#f8fafc', borderRadius: 16, padding: 14, borderColor: '#e2e8f0', borderWidth: 1 },
  bucketDanger: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  table: { minWidth: 980 },
  tableHeader: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomColor: '#e2e8f0', borderBottomWidth: 1 },
  headerCell: { width: 110, color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  tableRow: { flexDirection: 'row', gap: 10, paddingVertical: 12, borderBottomColor: '#f1f5f9', borderBottomWidth: 1, alignItems: 'center' },
  tableCell: { width: 110, color: '#0f172a', fontWeight: '700', fontSize: 12 },
  invoiceCol: { width: 220 },
  rowTitle: { color: '#0f172a', fontWeight: '800' },
  rowMeta: { color: '#64748b', fontSize: 12, marginTop: 3 },
  reconCard: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 18, padding: 14, gap: 8 },
  detailRow: { borderBottomColor: '#eef2f7', borderBottomWidth: 1, paddingBottom: 8 },
  detailLabel: { color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  detailValue: { color: '#0f172a', fontSize: 14, fontWeight: '700', marginTop: 3 },
  paymentList: { marginTop: 4, gap: 4 },
  paymentItem: { color: '#334155', fontSize: 12, fontWeight: '700' },
});
