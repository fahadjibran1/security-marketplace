import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  finaliseCompanyPayrollBatch,
  formatApiErrorMessage,
  getCompanyPayrollBatch,
  listCompanyPayrollBatches,
  payCompanyPayrollBatch,
} from '../../services/api';
import { PayrollBatch, Timesheet } from '../../types/models';

type WorkspaceFeedback = {
  tone: 'success' | 'error' | 'info';
  title: string;
  message: string;
} | null;

const UK_LOCALE = 'en-GB';
const GBP_CURRENCY = 'GBP';

function normalizeBatchStatus(value?: string | null) {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'finalised') return 'finalised';
  if (normalized === 'paid') return 'paid';
  return 'draft';
}

function formatDateLabel(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(UK_LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(UK_LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatCurrency(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) {
    return 'Rate unavailable';
  }

  return Number(value).toLocaleString(UK_LOCALE, {
    style: 'currency',
    currency: GBP_CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRate(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) {
    return 'Rate unavailable';
  }

  return `${formatCurrency(value)} / h`;
}

function toHours(value?: number | null) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getApprovedHours(timesheet: Timesheet) {
  if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
    return Number(timesheet.approvedHours);
  }
  return toHours(timesheet.hoursWorked);
}

function getTimesheetRate(timesheet: Timesheet) {
  const directJobRate = timesheet.shift?.job?.hourlyRate;
  if (directJobRate !== undefined && directJobRate !== null && Number.isFinite(Number(directJobRate))) {
    return Number(directJobRate);
  }

  const assignmentJobRate = timesheet.shift?.assignment?.job?.hourlyRate;
  if (assignmentJobRate !== undefined && assignmentJobRate !== null && Number.isFinite(Number(assignmentJobRate))) {
    return Number(assignmentJobRate);
  }

  return null;
}

function getApprovedAmount(timesheet: Timesheet) {
  const rate = getTimesheetRate(timesheet);
  if (rate === null) return null;
  return Math.round(getApprovedHours(timesheet) * rate * 100) / 100;
}

function getPayableHours(timesheet: Timesheet) {
  if (timesheet.payableHoursSnapshot !== undefined && timesheet.payableHoursSnapshot !== null && Number.isFinite(Number(timesheet.payableHoursSnapshot))) {
    return Number(timesheet.payableHoursSnapshot);
  }
  if (timesheet.payableHours !== undefined && timesheet.payableHours !== null && Number.isFinite(Number(timesheet.payableHours))) {
    return Number(timesheet.payableHours);
  }
  return getApprovedHours(timesheet);
}

function getPayableAmount(timesheet: Timesheet) {
  if (timesheet.payableAmountSnapshot !== undefined && timesheet.payableAmountSnapshot !== null && Number.isFinite(Number(timesheet.payableAmountSnapshot))) {
    return Math.round(Number(timesheet.payableAmountSnapshot) * 100) / 100;
  }
  if (timesheet.payableAmount !== undefined && timesheet.payableAmount !== null && Number.isFinite(Number(timesheet.payableAmount))) {
    return Math.round(Number(timesheet.payableAmount) * 100) / 100;
  }
  return getApprovedAmount(timesheet);
}

function getStatusPalette(status: string) {
  switch (normalizeBatchStatus(status)) {
    case 'paid':
      return { bg: '#DCFCE7', text: '#166534' };
    case 'finalised':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'draft':
    default:
      return { bg: '#FEF3C7', text: '#B45309' };
  }
}

function formatBatchStatusLabel(status?: string | null) {
  switch (normalizeBatchStatus(status)) {
    case 'paid':
      return 'Paid';
    case 'finalised':
      return 'Finalised';
    case 'draft':
    default:
      return 'Draft';
  }
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
  return true;
}

function sanitizeFilenamePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'export';
}

function getDownloadTimestamp(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function CompanyPayrollBatchesWorkspace() {
  const [batches, setBatches] = React.useState<PayrollBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = React.useState<number | null>(null);
  const [selectedBatch, setSelectedBatch] = React.useState<PayrollBatch | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [feedback, setFeedback] = React.useState<WorkspaceFeedback>(null);
  const [busyAction, setBusyAction] = React.useState<'finalise' | 'pay' | null>(null);

  const refreshWorkspace = React.useCallback(async () => {
    setLoading(true);
    try {
      const companyBatches = await listCompanyPayrollBatches();
      setBatches(companyBatches);
      const nextSelectedId =
        selectedBatchId && companyBatches.some((batch) => batch.id === selectedBatchId)
          ? selectedBatchId
          : companyBatches[0]?.id ?? null;
      setSelectedBatchId(nextSelectedId);
      if (nextSelectedId) {
        const batch = await getCompanyPayrollBatch(nextSelectedId);
        setSelectedBatch(batch);
      } else {
        setSelectedBatch(null);
      }
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Unable to load payroll batches',
        message: formatApiErrorMessage(error, 'Unable to load payroll batches right now.'),
      });
    } finally {
      setLoading(false);
    }
  }, [selectedBatchId]);

  React.useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  React.useEffect(() => {
    if (!selectedBatchId) {
      setSelectedBatch(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const batch = await getCompanyPayrollBatch(selectedBatchId);
        if (!cancelled) {
          setSelectedBatch(batch);
        }
      } catch (error) {
        if (!cancelled) {
          setFeedback({
            tone: 'error',
            title: 'Unable to load batch detail',
            message: formatApiErrorMessage(error, 'Unable to load batch detail right now.'),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedBatchId]);

  const handleFinalise = React.useCallback(async () => {
    if (!selectedBatch) return;
    try {
      setBusyAction('finalise');
      const updated = await finaliseCompanyPayrollBatch(selectedBatch.id);
      setSelectedBatch(updated);
      await refreshWorkspace();
      setFeedback({ tone: 'success', title: 'Batch finalised', message: `Payroll batch #${updated.id} is now finalised.` });
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Unable to finalise batch',
        message: formatApiErrorMessage(error, 'Unable to finalise this payroll batch.'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [refreshWorkspace, selectedBatch]);

  const handlePay = React.useCallback(async () => {
    if (!selectedBatch) return;
    try {
      setBusyAction('pay');
      const updated = await payCompanyPayrollBatch(selectedBatch.id);
      setSelectedBatch(updated);
      await refreshWorkspace();
      setFeedback({ tone: 'success', title: 'Batch paid', message: `Payroll batch #${updated.id} is now marked paid.` });
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Unable to mark batch paid',
        message: formatApiErrorMessage(error, 'Unable to mark this payroll batch paid.'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [refreshWorkspace, selectedBatch]);

  const handleExport = React.useCallback(() => {
    if (!selectedBatch) {
      setFeedback({ tone: 'info', title: 'No batch selected', message: 'Select a payroll batch before exporting.' });
      return;
    }

    const rows = [
      ['Batch ID', 'Period', 'Site', 'Guard', 'Shift Date', 'Approved Hours', 'Payable Hours', 'Hourly Rate', 'Approved Amount', 'Payable Amount', 'Payroll Status', 'Batch Status', 'Company Note'],
      ...(selectedBatch.timesheets || []).map((timesheet) => {
        const siteName = timesheet.shift?.site?.name || timesheet.shift?.siteName || `Site ${timesheet.shiftId}`;
        const guardName = timesheet.guard?.fullName || `Guard #${timesheet.guardId}`;
        const approvedHours = getApprovedHours(timesheet);
        const payableHours = getPayableHours(timesheet);
        const rate = getTimesheetRate(timesheet);
        const approvedAmount = getApprovedAmount(timesheet);
        const payableAmount = getPayableAmount(timesheet);

        return [
          String(selectedBatch.id),
          `${formatDateLabel(selectedBatch.periodStart)} - ${formatDateLabel(selectedBatch.periodEnd)}`,
          siteName,
          guardName,
          formatDateLabel(timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt),
          approvedHours.toFixed(2),
          payableHours.toFixed(2),
          rate !== null ? formatCurrency(rate) : 'Rate unavailable',
          approvedAmount !== null ? formatCurrency(approvedAmount) : 'Rate unavailable',
          payableAmount !== null ? formatCurrency(payableAmount) : 'Rate unavailable',
          String(timesheet.payrollStatus || ''),
          formatBatchStatusLabel(selectedBatch.status),
          timesheet.companyNote || '',
        ];
      }),
    ];

    const didDownload = downloadCsv(
      `payroll-batch-${sanitizeFilenamePart(String(selectedBatch.id))}-${sanitizeFilenamePart(String(selectedBatch.status))}-${getDownloadTimestamp()}.csv`,
      rows,
    );

    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Batch export ready', message: `Exported payroll batch #${selectedBatch.id}.` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [selectedBatch]);

  if (loading) {
    return (
      <View style={styles.workspace}>
        <Text style={styles.emptyText}>Loading payroll batches...</Text>
      </View>
    );
  }

  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Payroll Batches</Text>
          <Text style={styles.subtitle}>Create, finalise, pay, and export payroll runs without changing review status.</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={() => void refreshWorkspace()} disabled={Boolean(busyAction)}>
            <Text style={styles.secondaryButtonText}>Refresh</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={handleExport} disabled={!selectedBatch}>
            <Text style={styles.primaryButtonText}>Export batch</Text>
          </Pressable>
        </View>
      </View>

      {feedback ? (
        <View
          style={[
            styles.feedbackCard,
            feedback.tone === 'success' && styles.feedbackSuccess,
            feedback.tone === 'error' && styles.feedbackError,
            feedback.tone === 'info' && styles.feedbackInfo,
          ]}
        >
          <Text style={styles.feedbackTitle}>{feedback.title}</Text>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.layout}>
        <View style={styles.listCard}>
          {batches.length === 0 ? <Text style={styles.emptyText}>No payroll batches yet. Create one from the Payroll page.</Text> : null}
          {batches.map((batch) => {
            const palette = getStatusPalette(batch.status);
            const active = batch.id === selectedBatchId;

            return (
              <Pressable key={batch.id} style={[styles.batchRow, active && styles.batchRowActive]} onPress={() => setSelectedBatchId(batch.id)}>
                <View style={styles.batchRowCopy}>
                  <Text style={styles.batchTitle}>Batch #{batch.id}</Text>
                  <Text style={styles.batchMeta}>
                    {formatDateLabel(batch.periodStart)} - {formatDateLabel(batch.periodEnd)} | {batch.totals.recordsCount} records | {(batch.totals.payableHours ?? batch.totals.approvedHours).toFixed(2)} payable h | {formatCurrency(batch.totals.approvedAmount)}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: palette.bg }]}>
                  <Text style={[styles.statusBadgeText, { color: palette.text }]}>{formatBatchStatusLabel(batch.status)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.detailCard}>
          {selectedBatch ? (
            <>
              <Text style={styles.detailTitle}>Batch #{selectedBatch.id}</Text>
              <Text style={styles.detailSubtitle}>Period {formatDateLabel(selectedBatch.periodStart)} - {formatDateLabel(selectedBatch.periodEnd)}</Text>

              <View style={styles.summaryGrid}>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Status</Text>
                  <Text style={styles.summaryValueSmall}>{formatBatchStatusLabel(selectedBatch.status)}</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Records</Text>
                  <Text style={styles.summaryValueSmall}>{selectedBatch.totals.recordsCount}</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Approved Hours</Text>
                  <Text style={styles.summaryValueSmall}>{selectedBatch.totals.approvedHours.toFixed(2)} h</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Payable Hours</Text>
                  <Text style={styles.summaryValueSmall}>{(selectedBatch.totals.payableHours ?? selectedBatch.totals.approvedHours).toFixed(2)} h</Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Payable Amount</Text>
                  <Text style={styles.summaryValueSmall}>{formatCurrency(selectedBatch.totals.approvedAmount)}</Text>
                </View>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>Batch metadata</Text>
                <Text style={styles.detailLine}>Created: {formatDateTimeLabel(selectedBatch.createdAt)}</Text>
                <Text style={styles.detailLine}>Finalised: {formatDateTimeLabel(selectedBatch.finalisedAt)}</Text>
                <Text style={styles.detailLine}>Paid: {formatDateTimeLabel(selectedBatch.paidAt)}</Text>
                <Text style={styles.detailLine}>Notes: {selectedBatch.notes?.trim() ? selectedBatch.notes : 'No notes provided.'}</Text>
              </View>

              <View style={styles.detailActions}>
                {normalizeBatchStatus(selectedBatch.status) === 'draft' ? (
                  <Pressable style={styles.primaryButton} onPress={handleFinalise} disabled={Boolean(busyAction)}>
                    <Text style={styles.primaryButtonText}>{busyAction === 'finalise' ? 'Finalising...' : 'Finalise batch'}</Text>
                  </Pressable>
                ) : null}
                {normalizeBatchStatus(selectedBatch.status) === 'finalised' ? (
                  <Pressable style={styles.primaryButton} onPress={handlePay} disabled={Boolean(busyAction)}>
                    <Text style={styles.primaryButtonText}>{busyAction === 'pay' ? 'Marking paid...' : 'Mark paid'}</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>Included timesheets</Text>
                {(selectedBatch.timesheets || []).length === 0 ? <Text style={styles.emptyText}>No timesheets attached.</Text> : null}
                {(selectedBatch.timesheets || []).map((timesheet) => {
                  const siteName = timesheet.shift?.site?.name || timesheet.shift?.siteName || `Site ${timesheet.shiftId}`;
                  const guardName = timesheet.guard?.fullName || `Guard #${timesheet.guardId}`;
                  return (
                    <View key={timesheet.id} style={styles.timesheetRow}>
                      <Text style={styles.rowPrimary}>{guardName}</Text>
                      <Text style={styles.rowSecondary}>{siteName}</Text>
                      <Text style={styles.rowSecondary}>{formatDateLabel(timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt)}</Text>
                      <Text style={styles.rowSecondary}>{getApprovedHours(timesheet).toFixed(2)} h</Text>
                      <Text style={styles.rowSecondary}>{formatRate(getTimesheetRate(timesheet))}</Text>
                      <Text style={styles.rowSecondary}>{formatCurrency(getApprovedAmount(timesheet))}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          ) : (
            <Text style={styles.emptyText}>Select a payroll batch to review its records and lifecycle.</Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  workspaceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  headerCopy: { gap: 4 },
  title: { color: '#0f172a', fontSize: 28, fontWeight: '800' },
  subtitle: { color: '#475569', fontSize: 14 },
  headerActions: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  primaryButton: { backgroundColor: '#0f172a', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  primaryButtonText: { color: '#f8fafc', fontWeight: '700' },
  secondaryButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#e2e8f0' },
  secondaryButtonText: { color: '#0f172a', fontWeight: '700' },
  feedbackCard: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackInfo: { backgroundColor: '#DBEAFE' },
  feedbackTitle: { color: '#0f172a', fontWeight: '800', fontSize: 15 },
  feedbackText: { color: '#334155', fontSize: 13, lineHeight: 18 },
  layout: { flexDirection: 'row', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' },
  listCard: { flex: 1.2, minWidth: 360, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 12 },
  detailCard: { flex: 1.8, minWidth: 520, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14, borderWidth: 1, borderColor: '#DBEAFE' },
  batchRow: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, padding: 14, flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  batchRowActive: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  batchRowCopy: { flex: 1, gap: 4 },
  batchTitle: { color: '#0f172a', fontSize: 16, fontWeight: '800' },
  batchMeta: { color: '#475569', fontSize: 13, lineHeight: 18 },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  statusBadgeText: { fontWeight: '800', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  detailTitle: { color: '#0f172a', fontSize: 22, fontWeight: '800' },
  detailSubtitle: { color: '#64748b', fontSize: 13, lineHeight: 18 },
  summaryGrid: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  summaryCard: { flexGrow: 1, minWidth: 140, backgroundColor: '#F8FAFC', borderRadius: 18, padding: 14, gap: 6 },
  summaryLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  summaryValueSmall: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  detailSection: { gap: 8, borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 14 },
  sectionTitle: { color: '#0f172a', fontSize: 15, fontWeight: '800' },
  detailLine: { color: '#334155', fontSize: 13, lineHeight: 18 },
  detailActions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  timesheetRow: { borderBottomWidth: 1, borderBottomColor: '#E2E8F0', paddingVertical: 10, gap: 4 },
  rowPrimary: { color: '#0f172a', fontSize: 14, fontWeight: '700' },
  rowSecondary: { color: '#475569', fontSize: 13, lineHeight: 18 },
  emptyText: { color: '#64748b', fontSize: 14, lineHeight: 20 },
});
