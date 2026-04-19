import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  createCompanyInvoiceBatch,
  finaliseCompanyInvoiceBatch,
  formatApiErrorMessage,
  getCompanyInvoiceBatch,
  issueCompanyInvoiceBatch,
  listCompanyInvoiceBatches,
  payCompanyInvoiceBatch,
} from '../../services/api';
import { Client, InvoiceBatch, InvoiceBatchStatus, Timesheet, TimesheetBillingStatus } from '../../types/models';

type PeriodView = 'week' | 'month';
type BillingFilter = 'all' | TimesheetBillingStatus;

type CompanyInvoiceWorkspaceProps = {
  timesheets: Timesheet[];
  refreshing?: boolean;
  onRefresh?: () => Promise<void> | void;
};

type InvoiceEntry = {
  timesheet: Timesheet;
  client: Client | null;
  clientId: number | null;
  clientName: string;
  siteName: string;
  guardName: string;
  shiftDate: string;
  shiftDateValue: Date | null;
  scheduledTime: string;
  approvedHours: number;
  billableHours: number;
  billingRate: number | null;
  invoiceAmount: number | null;
  contractRuleName: string;
  billingStatus: TimesheetBillingStatus;
  invoiceBatchStatus: InvoiceBatchStatus | null;
  selectable: boolean;
};

type InvoiceGroup = {
  key: string;
  clientId: number | null;
  clientName: string;
  siteName: string;
  periodKey: string;
  periodLabel: string;
  entries: InvoiceEntry[];
  approvedHours: number;
  billableHours: number;
  invoiceAmount: number;
  missingRateCount: number;
};

const UK_LOCALE = 'en-GB';
const MONEY_FORMATTER = new Intl.NumberFormat(UK_LOCALE, { style: 'currency', currency: 'GBP' });

function toNumber(value?: string | number | null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBillingStatus(value?: string | null): TimesheetBillingStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'included' || normalized === 'invoiced') return normalized;
  return 'uninvoiced';
}

function normalizeBatchStatus(value?: string | null): InvoiceBatchStatus | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'draft' || normalized === 'finalised' || normalized === 'issued' || normalized === 'paid') return normalized;
  return null;
}

function formatStatusLabel(value?: string | null) {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatDateLabel(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(UK_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTimeLabel(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(UK_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatMoney(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Rate unavailable';
  return MONEY_FORMATTER.format(value);
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, '') : '0';
}

function getApprovedHours(timesheet: Timesheet) {
  const approvedHours = toNumber(timesheet.approvedHours);
  if (approvedHours !== null) return approvedHours;
  return toNumber(timesheet.hoursWorked) ?? 0;
}

function getBillingRate(timesheet: Timesheet) {
  const computedBillingRate = toNumber(timesheet.billingRate);
  if (computedBillingRate !== null) return computedBillingRate;
  const directBillingRate = toNumber(timesheet.shift?.job?.billingRate);
  if (directBillingRate !== null) return directBillingRate;
  const assignmentBillingRate = toNumber(timesheet.shift?.assignment?.job?.billingRate);
  if (assignmentBillingRate !== null) return assignmentBillingRate;
  const directRate = toNumber(timesheet.shift?.job?.hourlyRate);
  if (directRate !== null) return directRate;
  const assignmentRate = toNumber(timesheet.shift?.assignment?.job?.hourlyRate);
  if (assignmentRate !== null) return assignmentRate;
  return null;
}

function getTimesheetClient(timesheet: Timesheet): Client | null {
  return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
}

function getSiteName(timesheet: Timesheet) {
  return timesheet.shift?.site?.name || timesheet.shift?.siteName || 'Unknown site';
}

function getGuardName(timesheet: Timesheet) {
  return timesheet.guard?.fullName || timesheet.shift?.guard?.fullName || timesheet.shift?.assignment?.guard?.fullName || `Guard #${timesheet.guardId}`;
}

function getShiftDate(timesheet: Timesheet) {
  return timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt;
}

function getWeekStart(date: Date) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function getPeriodInfo(dateValue: Date | null, periodView: PeriodView) {
  if (!dateValue || Number.isNaN(dateValue.getTime())) {
    return { key: 'unknown-period', label: 'Unknown period' };
  }

  if (periodView === 'month') {
    const key = `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}`;
    return {
      key,
      label: dateValue.toLocaleDateString(UK_LOCALE, { month: 'long', year: 'numeric' }),
    };
  }

  const weekStart = getWeekStart(dateValue);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const key = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
  return { key, label: `${formatDateLabel(weekStart.toISOString())} - ${formatDateLabel(weekEnd.toISOString())}` };
}

function sanitizeFilenamePart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

function getDownloadTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

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

function buildEntry(timesheet: Timesheet): InvoiceEntry | null {
  if (String(timesheet.approvalStatus).trim().toLowerCase() !== 'approved') return null;
  const client = getTimesheetClient(timesheet);
  const dateValue = new Date(getShiftDate(timesheet));
  const approvedHours = getApprovedHours(timesheet);
  const billableHours = toNumber(timesheet.billableHours) ?? approvedHours;
  const billingRate = getBillingRate(timesheet);
  const computedRevenue = toNumber(timesheet.revenueAmount);
  const billingStatus = normalizeBillingStatus(timesheet.billingStatus);
  const invoiceBatchStatus = normalizeBatchStatus(timesheet.invoiceBatch?.status);

  return {
    timesheet,
    client,
    clientId: client?.id ?? null,
    clientName: client?.name || timesheet.shift?.site?.clientName || 'Client unavailable',
    siteName: getSiteName(timesheet),
    guardName: getGuardName(timesheet),
    shiftDate: formatDateLabel(getShiftDate(timesheet)),
    shiftDateValue: Number.isNaN(dateValue.getTime()) ? null : dateValue,
    scheduledTime: `${formatTimeLabel(timesheet.scheduledStartAt || timesheet.shift?.start)}-${formatTimeLabel(timesheet.scheduledEndAt || timesheet.shift?.end)}`,
    approvedHours,
    billableHours,
    billingRate,
    invoiceAmount: computedRevenue !== null ? computedRevenue : billingRate === null ? null : approvedHours * billingRate,
    contractRuleName: timesheet.matchedContractRuleName || 'Fallback rate',
    billingStatus,
    invoiceBatchStatus,
    selectable: Boolean(client?.id) && !timesheet.invoiceBatch && billingStatus !== 'invoiced',
  };
}

function makeGroup(entries: InvoiceEntry[], periodView: PeriodView) {
  const map = new Map<string, InvoiceGroup>();

  entries.forEach((entry) => {
    const period = getPeriodInfo(entry.shiftDateValue, periodView);
    const key = `${entry.clientId || 'no-client'}|${entry.siteName}|${period.key}`;
    const current =
      map.get(key) ||
      {
        key,
        clientId: entry.clientId,
        clientName: entry.clientName,
        siteName: entry.siteName,
        periodKey: period.key,
        periodLabel: period.label,
        entries: [],
        approvedHours: 0,
        billableHours: 0,
        invoiceAmount: 0,
        missingRateCount: 0,
      };

    current.entries.push(entry);
    current.approvedHours += entry.approvedHours;
    current.billableHours += entry.billableHours;
    if (entry.invoiceAmount !== null) {
      current.invoiceAmount += entry.invoiceAmount;
    } else {
      current.missingRateCount += 1;
    }
    map.set(key, current);
  });

  return Array.from(map.values()).sort((left, right) => {
    const clientCompare = left.clientName.localeCompare(right.clientName);
    if (clientCompare !== 0) return clientCompare;
    const siteCompare = left.siteName.localeCompare(right.siteName);
    if (siteCompare !== 0) return siteCompare;
    return left.periodKey.localeCompare(right.periodKey);
  });
}

function getBillingPalette(status: TimesheetBillingStatus) {
  if (status === 'invoiced') return { background: '#ECFDF5', border: '#34D399', text: '#047857' };
  if (status === 'included') return { background: '#EFF6FF', border: '#60A5FA', text: '#1D4ED8' };
  return { background: '#FFFBEB', border: '#FBBF24', text: '#B45309' };
}

function getBatchPalette(status?: string | null) {
  const normalized = normalizeBatchStatus(status);
  if (normalized === 'paid') return { background: '#ECFDF5', border: '#34D399', text: '#047857' };
  if (normalized === 'issued') return { background: '#F0FDFA', border: '#2DD4BF', text: '#0F766E' };
  if (normalized === 'finalised') return { background: '#EFF6FF', border: '#60A5FA', text: '#1D4ED8' };
  return { background: '#F8FAFC', border: '#CBD5E1', text: '#475569' };
}

function WebSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserReady) {
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

  return <TextInput value={value} onChangeText={onChange} style={styles.input} />;
}

export function CompanyInvoiceWorkspace({ timesheets, refreshing, onRefresh }: CompanyInvoiceWorkspaceProps) {
  const [periodView, setPeriodView] = React.useState<PeriodView>('week');
  const [clientFilter, setClientFilter] = React.useState('all');
  const [siteFilter, setSiteFilter] = React.useState('all');
  const [guardFilter, setGuardFilter] = React.useState('all');
  const [billingFilter, setBillingFilter] = React.useState<BillingFilter>('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [selectedEntry, setSelectedEntry] = React.useState<InvoiceEntry | null>(null);
  const [invoiceReference, setInvoiceReference] = React.useState('');
  const [batchPeriodStart, setBatchPeriodStart] = React.useState('');
  const [batchPeriodEnd, setBatchPeriodEnd] = React.useState('');
  const [batchNotes, setBatchNotes] = React.useState('');
  const [feedback, setFeedback] = React.useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [batchAction, setBatchAction] = React.useState(false);
  const [batches, setBatches] = React.useState<InvoiceBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = React.useState<number | null>(null);
  const [selectedBatch, setSelectedBatch] = React.useState<InvoiceBatch | null>(null);
  const [loadingBatches, setLoadingBatches] = React.useState(false);

  const entries = React.useMemo(
    () => timesheets.map(buildEntry).filter((entry): entry is InvoiceEntry => Boolean(entry)),
    [timesheets],
  );

  const clientOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    entries.forEach((entry) => {
      if (entry.clientId) map.set(String(entry.clientId), entry.clientName);
    });
    return [{ value: 'all', label: 'All clients' }, ...Array.from(map.entries()).map(([value, label]) => ({ value, label }))];
  }, [entries]);

  const siteOptions = React.useMemo(() => {
    const names = Array.from(new Set(entries.map((entry) => entry.siteName))).sort();
    return [{ value: 'all', label: 'All sites' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [entries]);

  const guardOptions = React.useMemo(() => {
    const names = Array.from(new Set(entries.map((entry) => entry.guardName))).sort();
    return [{ value: 'all', label: 'All guards' }, ...names.map((name) => ({ value: name, label: name }))];
  }, [entries]);

  const filteredEntries = React.useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    const start = startDate ? new Date(`${startDate}T00:00:00`) : null;
    const end = endDate ? new Date(`${endDate}T23:59:59`) : null;

    return entries.filter((entry) => {
      if (clientFilter !== 'all' && String(entry.clientId) !== clientFilter) return false;
      if (siteFilter !== 'all' && entry.siteName !== siteFilter) return false;
      if (guardFilter !== 'all' && entry.guardName !== guardFilter) return false;
      if (billingFilter !== 'all' && entry.billingStatus !== billingFilter) return false;
      if (start && entry.shiftDateValue && entry.shiftDateValue.getTime() < start.getTime()) return false;
      if (end && entry.shiftDateValue && entry.shiftDateValue.getTime() > end.getTime()) return false;
      if (search) {
        const haystack = `${entry.clientName} ${entry.siteName} ${entry.guardName} ${entry.timesheet.companyNote || ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }, [billingFilter, clientFilter, entries, endDate, guardFilter, searchTerm, siteFilter, startDate]);

  const groupedEntries = React.useMemo(() => makeGroup(filteredEntries, periodView), [filteredEntries, periodView]);
  const selectedEntries = React.useMemo(
    () => entries.filter((entry) => selectedIds.includes(entry.timesheet.id)),
    [entries, selectedIds],
  );
  const selectedClientId = selectedEntries[0]?.clientId ?? null;
  const selectedClientMismatch = selectedEntries.some((entry) => entry.clientId !== selectedClientId);

  const loadBatches = React.useCallback(async (preferredId?: number | null) => {
    setLoadingBatches(true);
    try {
      const companyBatches = await listCompanyInvoiceBatches();
      setBatches(companyBatches);
      const nextId = preferredId ?? selectedBatchId ?? companyBatches[0]?.id ?? null;
      setSelectedBatchId(nextId);
      if (nextId) {
        const detail = await getCompanyInvoiceBatch(nextId);
        setSelectedBatch(detail);
      } else {
        setSelectedBatch(null);
      }
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to load invoice batches.') });
    } finally {
      setLoadingBatches(false);
    }
  }, [selectedBatchId]);

  React.useEffect(() => {
    loadBatches(null);
  }, []);

  const refreshAll = React.useCallback(async (preferredBatchId?: number | null) => {
    await Promise.all([Promise.resolve(onRefresh?.()), loadBatches(preferredBatchId)]);
  }, [loadBatches, onRefresh]);

  const toggleSelected = React.useCallback((entry: InvoiceEntry) => {
    if (!entry.selectable) return;
    setSelectedIds((current) =>
      current.includes(entry.timesheet.id)
        ? current.filter((id) => id !== entry.timesheet.id)
        : [...current, entry.timesheet.id],
    );
  }, []);

  const buildCsvRows = React.useCallback((rows: InvoiceEntry[], groups: InvoiceGroup[] = []) => {
    const output: Array<Array<string | number | null | undefined>> = [[
      'invoice batch id',
      'invoice reference',
      'client',
      'site',
      'guard',
      'shift date',
      'approved hours',
      'billable hours',
      'matched contract rule',
      'effective billing rate',
      'revenue amount',
      'cost amount',
      'margin amount',
      'billing status',
      'batch status',
      'company note',
    ]];

    rows.forEach((entry) => {
      output.push([
        entry.timesheet.invoiceBatch?.id ?? '',
        entry.timesheet.invoiceBatch?.invoiceReference ?? '',
        entry.clientName,
        entry.siteName,
        entry.guardName,
        entry.shiftDate,
        formatNumber(entry.approvedHours),
        formatNumber(entry.billableHours),
        entry.contractRuleName,
        entry.billingRate === null ? 'Rate unavailable' : entry.billingRate.toFixed(2),
        entry.invoiceAmount === null ? 'Rate unavailable' : entry.invoiceAmount.toFixed(2),
        entry.timesheet.costAmount === null || entry.timesheet.costAmount === undefined ? '' : entry.timesheet.costAmount.toFixed(2),
        entry.timesheet.marginAmount === null || entry.timesheet.marginAmount === undefined ? '' : entry.timesheet.marginAmount.toFixed(2),
        formatStatusLabel(entry.billingStatus),
        entry.timesheet.invoiceBatch?.status ? formatStatusLabel(entry.timesheet.invoiceBatch.status) : 'Unbatched',
        entry.timesheet.companyNote || '',
      ]);
    });

    groups.forEach((group) => {
      output.push([
        'SUMMARY',
        '',
        group.clientName,
        group.siteName,
        `${group.entries.length} records`,
        group.periodLabel,
        formatNumber(group.approvedHours),
        formatNumber(group.billableHours),
        '',
        '',
        group.invoiceAmount.toFixed(2),
        '',
        '',
        `${group.missingRateCount} missing rate`,
        '',
        '',
      ]);
    });

    return output;
  }, []);

  const exportFiltered = React.useCallback(() => {
    downloadCsv(
      `invoices-filtered-${sanitizeFilenamePart(billingFilter)}-${sanitizeFilenamePart(periodView)}-${getDownloadTimestamp()}.csv`,
      buildCsvRows(filteredEntries, groupedEntries),
    );
  }, [billingFilter, buildCsvRows, filteredEntries, groupedEntries, periodView]);

  const exportSelected = React.useCallback(() => {
    downloadCsv(
      `invoices-selected-${sanitizeFilenamePart(periodView)}-${getDownloadTimestamp()}.csv`,
      buildCsvRows(selectedEntries),
    );
  }, [buildCsvRows, periodView, selectedEntries]);

  const exportGroup = React.useCallback((group: InvoiceGroup) => {
    downloadCsv(
      `invoices-group-${sanitizeFilenamePart(group.clientName)}-${sanitizeFilenamePart(group.siteName)}-${sanitizeFilenamePart(group.periodKey)}-${getDownloadTimestamp()}.csv`,
      buildCsvRows(group.entries, [group]),
    );
  }, [buildCsvRows]);

  const exportBatch = React.useCallback((batch: InvoiceBatch) => {
    const batchEntries = (batch.timesheets || []).map(buildEntry).filter((entry): entry is InvoiceEntry => Boolean(entry));
    const rows = buildCsvRows(batchEntries);
    const batchBillableHours = batchEntries.reduce((sum, entry) => sum + entry.billableHours, 0);
    const batchRevenue = batch.totals.totalRevenueAmount ?? batch.totals.invoiceAmount;
    rows.push([
      'SUMMARY',
      batch.invoiceReference || '',
      batch.client?.name || `Client #${batch.clientId}`,
      '',
      `${batch.totals.recordsCount} records`,
      `${formatDateLabel(batch.periodStart)} - ${formatDateLabel(batch.periodEnd)}`,
      formatNumber(batch.totals.approvedHours),
      formatNumber(batchBillableHours),
      '',
      '',
      batchRevenue.toFixed(2),
      '',
      '',
      '',
      formatStatusLabel(batch.status),
      '',
    ]);
    downloadCsv(
      `invoices-batch-${batch.id}-${sanitizeFilenamePart(batch.client?.name || `client-${batch.clientId}`)}-${getDownloadTimestamp()}.csv`,
      rows,
    );
  }, [buildCsvRows]);

  const createBatch = React.useCallback(async () => {
    if (!selectedEntries.length) {
      setFeedback({ tone: 'error', message: 'Select at least one uninvoiced approved row first.' });
      return;
    }
    if (!selectedClientId || selectedClientMismatch) {
      setFeedback({ tone: 'error', message: 'Invoice batches must contain rows for one client only.' });
      return;
    }
    if (!batchPeriodStart || !batchPeriodEnd) {
      setFeedback({ tone: 'error', message: 'Enter a period start and period end before creating the invoice batch.' });
      return;
    }

    setBatchAction(true);
    try {
      const batch = await createCompanyInvoiceBatch({
        clientId: selectedClientId,
        periodStart: batchPeriodStart,
        periodEnd: batchPeriodEnd,
        invoiceReference: invoiceReference.trim() || null,
        notes: batchNotes.trim() || null,
        timesheetIds: selectedIds,
      });
      setSelectedIds([]);
      setInvoiceReference('');
      setBatchNotes('');
      setFeedback({ tone: 'success', message: `Invoice batch #${batch.id} created as a draft.` });
      await refreshAll(batch.id);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to create invoice batch.') });
    } finally {
      setBatchAction(false);
    }
  }, [batchNotes, batchPeriodEnd, batchPeriodStart, invoiceReference, refreshAll, selectedClientId, selectedClientMismatch, selectedEntries.length, selectedIds]);

  const runBatchAction = React.useCallback(async (action: 'finalise' | 'issue' | 'pay') => {
    if (!selectedBatch) return;
    setBatchAction(true);
    try {
      const updated =
        action === 'finalise'
          ? await finaliseCompanyInvoiceBatch(selectedBatch.id)
          : action === 'issue'
            ? await issueCompanyInvoiceBatch(selectedBatch.id)
            : await payCompanyInvoiceBatch(selectedBatch.id);
      setFeedback({ tone: 'success', message: `Invoice batch #${updated.id} is now ${formatStatusLabel(updated.status)}.` });
      await refreshAll(updated.id);
    } catch (error) {
      setFeedback({ tone: 'error', message: formatApiErrorMessage(error, 'Unable to update invoice batch.') });
    } finally {
      setBatchAction(false);
    }
  }, [refreshAll, selectedBatch]);

  const totals = React.useMemo(() => {
    return filteredEntries.reduce(
      (summary, entry) => {
        summary.records += 1;
        summary.approvedHours += entry.approvedHours;
        if (entry.invoiceAmount !== null) summary.invoiceAmount += entry.invoiceAmount;
        if (entry.billingStatus === 'uninvoiced') summary.uninvoiced += 1;
        if (entry.billingStatus === 'included') summary.included += 1;
        if (entry.billingStatus === 'invoiced') summary.invoiced += 1;
        if (entry.billingRate === null) summary.missingRate += 1;
        return summary;
      },
      { records: 0, approvedHours: 0, invoiceAmount: 0, uninvoiced: 0, included: 0, invoiced: 0, missingRate: 0 },
    );
  }, [filteredEntries]);

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View>
          <Text style={styles.eyebrow}>Client Billing</Text>
          <Text style={styles.title}>Invoices</Text>
          <Text style={styles.subtitle}>Approved timesheets for client billing. Payroll and invoice workflows stay separate.</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={() => refreshAll(selectedBatchId)}>
            <Text style={styles.secondaryButtonText}>{refreshing || loadingBatches ? 'Refreshing...' : 'Refresh'}</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={exportFiltered}>
            <Text style={styles.primaryButtonText}>Export Filtered</Text>
          </Pressable>
        </View>
      </View>

      {feedback ? (
        <View style={[styles.feedbackCard, feedback.tone === 'error' ? styles.feedbackError : styles.feedbackSuccess]}>
          <Text style={styles.feedbackText}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={styles.summaryGrid}>
        <MetricCard label="Approved Records" value={String(totals.records)} />
        <MetricCard label="Approved Hours" value={formatNumber(totals.approvedHours)} />
        <MetricCard label="Total Revenue" value={formatMoney(totals.invoiceAmount)} />
        <MetricCard label="Uninvoiced" value={String(totals.uninvoiced)} />
        <MetricCard label="Included" value={String(totals.included)} />
        <MetricCard label="Invoiced" value={String(totals.invoiced)} />
        <MetricCard label="Missing Rate" value={String(totals.missingRate)} />
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Billing Filters</Text>
        <View style={styles.filterGrid}>
          <WebSelect value={clientFilter} onChange={setClientFilter} options={clientOptions} />
          <WebSelect value={siteFilter} onChange={setSiteFilter} options={siteOptions} />
          <WebSelect value={guardFilter} onChange={setGuardFilter} options={guardOptions} />
          <WebSelect
            value={billingFilter}
            onChange={(value) => setBillingFilter(value as BillingFilter)}
            options={[
              { value: 'all', label: 'All billing statuses' },
              { value: 'uninvoiced', label: 'Uninvoiced' },
              { value: 'included', label: 'Included' },
              { value: 'invoiced', label: 'Invoiced' },
            ]}
          />
          <WebSelect
            value={periodView}
            onChange={(value) => setPeriodView(value as PeriodView)}
            options={[
              { value: 'week', label: 'Group by week' },
              { value: 'month', label: 'Group by month' },
            ]}
          />
          <TextInput style={styles.input} value={startDate} onChangeText={setStartDate} placeholder="From date (YYYY-MM-DD)" />
          <TextInput style={styles.input} value={endDate} onChangeText={setEndDate} placeholder="To date (YYYY-MM-DD)" />
          <TextInput style={styles.input} value={searchTerm} onChangeText={setSearchTerm} placeholder="Search client, site, guard, note" />
        </View>
      </View>

      <View style={styles.splitLayout}>
        <View style={styles.mainColumn}>
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>Billable Approved Rows</Text>
                <Text style={styles.helperText}>Select uninvoiced rows for one client, then create a draft invoice batch.</Text>
              </View>
              <Pressable
                style={[styles.secondaryButton, selectedEntries.length === 0 && styles.disabledButton]}
                onPress={exportSelected}
                disabled={selectedEntries.length === 0}
              >
                <Text style={styles.secondaryButtonText}>Export Selected</Text>
              </Pressable>
            </View>

            <View style={styles.batchCreateBox}>
              <Text style={styles.batchCreateTitle}>Create Invoice Batch</Text>
              <Text style={styles.helperText}>
                {selectedEntries.length
                  ? `${selectedEntries.length} row(s) selected for ${selectedEntries[0]?.clientName || 'one client'}.`
                  : 'Select eligible rows to create a client invoice batch.'}
              </Text>
              <View style={styles.filterGrid}>
                <TextInput style={styles.input} value={invoiceReference} onChangeText={setInvoiceReference} placeholder="Invoice reference (optional)" />
                <TextInput style={styles.input} value={batchPeriodStart} onChangeText={setBatchPeriodStart} placeholder="Period start (YYYY-MM-DD)" />
                <TextInput style={styles.input} value={batchPeriodEnd} onChangeText={setBatchPeriodEnd} placeholder="Period end (YYYY-MM-DD)" />
                <TextInput style={styles.input} value={batchNotes} onChangeText={setBatchNotes} placeholder="Notes (optional)" />
              </View>
              {selectedClientMismatch ? <Text style={styles.errorText}>Selected rows must all belong to the same client.</Text> : null}
              <Pressable
                style={[styles.primaryButton, (!selectedEntries.length || batchAction) && styles.disabledButton]}
                onPress={createBatch}
                disabled={!selectedEntries.length || batchAction}
              >
                <Text style={styles.primaryButtonText}>{batchAction ? 'Working...' : 'Create Invoice Batch'}</Text>
              </Pressable>
            </View>

            {groupedEntries.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No approved billable rows match these filters.</Text>
                <Text style={styles.helperText}>Approved timesheets with a client will appear here for invoicing.</Text>
              </View>
            ) : (
              groupedEntries.map((group) => (
                <View key={group.key} style={styles.groupCard}>
                  <View style={styles.groupHeader}>
                    <View>
                      <Text style={styles.groupTitle}>{group.clientName} / {group.siteName}</Text>
                      <Text style={styles.groupMeta}>{group.periodLabel}</Text>
                    </View>
                    <View style={styles.groupTotals}>
                      <Text style={styles.groupTotalText}>{group.entries.length} records</Text>
                      <Text style={styles.groupTotalText}>{formatNumber(group.approvedHours)} hrs</Text>
                      <Text style={styles.groupTotalText}>{formatNumber(group.billableHours)} billable hrs</Text>
                      <Text style={styles.groupTotalText}>Revenue {formatMoney(group.invoiceAmount)}</Text>
                    </View>
                    <Pressable style={styles.secondaryButton} onPress={() => exportGroup(group)}>
                      <Text style={styles.secondaryButtonText}>Export Group</Text>
                    </Pressable>
                  </View>

                  {group.entries.map((entry) => {
                    const billingPalette = getBillingPalette(entry.billingStatus);
                    const batchPalette = getBatchPalette(entry.timesheet.invoiceBatch?.status);
                    const isSelected = selectedIds.includes(entry.timesheet.id);
                    return (
                      <Pressable key={entry.timesheet.id} style={styles.rowCard} onPress={() => setSelectedEntry(entry)}>
                        <Pressable
                          style={[styles.checkbox, isSelected && styles.checkboxSelected, !entry.selectable && styles.checkboxDisabled]}
                          onPress={() => toggleSelected(entry)}
                          disabled={!entry.selectable}
                        >
                          <Text style={styles.checkboxText}>{isSelected ? '✓' : ''}</Text>
                        </Pressable>
                        <View style={styles.rowMain}>
                          <Text style={styles.rowTitle}>{entry.guardName}</Text>
                          <Text style={styles.rowMeta}>
                            {entry.shiftDate} | {entry.scheduledTime} | {entry.siteName} | {entry.contractRuleName}
                          </Text>
                        </View>
                        <Text style={styles.rowAmount}>{formatNumber(entry.approvedHours)} hrs</Text>
                        <Text style={styles.rowAmount}>{formatNumber(entry.billableHours)} billable</Text>
                        <Text style={styles.rowAmount}>{entry.billingRate === null ? 'No rate' : MONEY_FORMATTER.format(entry.billingRate)}</Text>
                        <Text style={styles.rowAmount}>{formatMoney(entry.invoiceAmount)}</Text>
                        <View style={[styles.statusBadge, { backgroundColor: billingPalette.background, borderColor: billingPalette.border }]}>
                          <Text style={[styles.statusBadgeText, { color: billingPalette.text }]}>{formatStatusLabel(entry.billingStatus)}</Text>
                        </View>
                        <View style={[styles.statusBadge, { backgroundColor: batchPalette.background, borderColor: batchPalette.border }]}>
                          <Text style={[styles.statusBadgeText, { color: batchPalette.text }]}>
                            {entry.timesheet.invoiceBatch ? `Batch #${entry.timesheet.invoiceBatch.id} ${formatStatusLabel(entry.timesheet.invoiceBatch.status)}` : 'Unbatched'}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.sideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Invoice Row Detail</Text>
            {selectedEntry ? (
              <View style={styles.detailStack}>
                <Detail label="Client" value={selectedEntry.clientName} />
                <Detail label="Site" value={selectedEntry.siteName} />
                <Detail label="Guard" value={selectedEntry.guardName} />
                <Detail label="Shift Date" value={selectedEntry.shiftDate} />
                <Detail label="Approved Hours" value={formatNumber(selectedEntry.approvedHours)} />
                <Detail label="Billable Hours" value={formatNumber(selectedEntry.billableHours)} />
                <Detail label="Matched Contract Rule" value={selectedEntry.contractRuleName} />
                <Detail label="Effective Billing Rate" value={selectedEntry.billingRate === null ? 'Rate unavailable' : MONEY_FORMATTER.format(selectedEntry.billingRate)} />
                <Detail label="Revenue" value={formatMoney(selectedEntry.invoiceAmount)} />
                <Detail label="Cost (Guard Pay)" value={selectedEntry.timesheet.costAmount !== null && selectedEntry.timesheet.costAmount !== undefined ? formatMoney(selectedEntry.timesheet.costAmount) : 'Rate unavailable'} />
                <Detail label="Profit" value={selectedEntry.timesheet.marginAmount !== null && selectedEntry.timesheet.marginAmount !== undefined ? formatMoney(selectedEntry.timesheet.marginAmount) : 'Rate unavailable'} />
                <Detail label="Margin" value={selectedEntry.timesheet.marginPercent !== null && selectedEntry.timesheet.marginPercent !== undefined ? `${selectedEntry.timesheet.marginPercent.toFixed(2)}%` : 'Unavailable'} />
                <Detail label="Billing Status" value={formatStatusLabel(selectedEntry.billingStatus)} />
                <Detail label="Invoice Batch" value={selectedEntry.timesheet.invoiceBatch ? `#${selectedEntry.timesheet.invoiceBatch.id} ${formatStatusLabel(selectedEntry.timesheet.invoiceBatch.status)}` : 'Unbatched'} />
                <Detail label="Company Note" value={selectedEntry.timesheet.companyNote || 'No company note'} />
              </View>
            ) : (
              <Text style={styles.helperText}>Select a billing row to inspect the client, amount, and invoice context.</Text>
            )}
          </View>

          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitle}>Invoice Batches</Text>
              <Text style={styles.helperText}>{loadingBatches ? 'Loading...' : `${batches.length} batch(es)`}</Text>
            </View>
            <ScrollView style={styles.batchList}>
              {batches.length === 0 ? (
                <Text style={styles.helperText}>No invoice batches yet.</Text>
              ) : (
                batches.map((batch) => {
                  const palette = getBatchPalette(batch.status);
                  return (
                    <Pressable
                      key={batch.id}
                      style={[styles.batchListItem, selectedBatchId === batch.id && styles.batchListItemActive]}
                      onPress={async () => {
                        setSelectedBatchId(batch.id);
                        setSelectedBatch(await getCompanyInvoiceBatch(batch.id));
                      }}
                    >
                      <Text style={styles.batchTitle}>Batch #{batch.id} · {batch.client?.name || `Client #${batch.clientId}`}</Text>
                      <Text style={styles.batchMeta}>{formatDateLabel(batch.periodStart)} - {formatDateLabel(batch.periodEnd)}</Text>
                      <View style={[styles.statusBadge, { backgroundColor: palette.background, borderColor: palette.border }]}>
                        <Text style={[styles.statusBadgeText, { color: palette.text }]}>{formatStatusLabel(batch.status)}</Text>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Batch Detail</Text>
            {selectedBatch ? (
              <View style={styles.detailStack}>
                <Detail label="Client" value={selectedBatch.client?.name || `Client #${selectedBatch.clientId}`} />
                <Detail label="Period" value={`${formatDateLabel(selectedBatch.periodStart)} - ${formatDateLabel(selectedBatch.periodEnd)}`} />
                <Detail label="Status" value={formatStatusLabel(selectedBatch.status)} />
                <Detail label="Invoice Reference" value={selectedBatch.invoiceReference || 'Not set'} />
                <Detail label="Records" value={String(selectedBatch.totals.recordsCount)} />
                <Detail label="Approved Hours" value={formatNumber(selectedBatch.totals.approvedHours)} />
                <Detail label="Total Revenue" value={formatMoney(selectedBatch.totals.totalRevenueAmount ?? selectedBatch.totals.invoiceAmount)} />
                <Detail label="Created" value={formatDateTimeLabel(selectedBatch.createdAt)} />
                <Detail label="Finalised" value={formatDateTimeLabel(selectedBatch.finalisedAt)} />
                <Detail label="Issued" value={formatDateTimeLabel(selectedBatch.issuedAt)} />
                <Detail label="Paid" value={formatDateTimeLabel(selectedBatch.paidAt)} />
                <Detail label="Notes" value={selectedBatch.notes || 'No notes'} />
                <View style={styles.rowActions}>
                  <Pressable style={styles.secondaryButton} onPress={() => exportBatch(selectedBatch)}>
                    <Text style={styles.secondaryButtonText}>Export Batch</Text>
                  </Pressable>
                  {selectedBatch.status === 'draft' ? (
                    <Pressable style={styles.primaryButton} onPress={() => runBatchAction('finalise')} disabled={batchAction}>
                      <Text style={styles.primaryButtonText}>Finalise Batch</Text>
                    </Pressable>
                  ) : null}
                  {selectedBatch.status === 'finalised' ? (
                    <Pressable style={styles.primaryButton} onPress={() => runBatchAction('issue')} disabled={batchAction}>
                      <Text style={styles.primaryButtonText}>Mark Issued</Text>
                    </Pressable>
                  ) : null}
                  {selectedBatch.status === 'issued' ? (
                    <Pressable style={styles.primaryButton} onPress={() => runBatchAction('pay')} disabled={batchAction}>
                      <Text style={styles.primaryButtonText}>Mark Paid</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={styles.sectionSubheading}>Included Timesheets</Text>
                {(selectedBatch.timesheets || []).map((timesheet) => {
                  const entry = buildEntry(timesheet);
                  if (!entry) return null;
                  return (
                    <View key={timesheet.id} style={styles.batchRow}>
                      <Text style={styles.batchRowTitle}>{entry.guardName}</Text>
                      <Text style={styles.batchMeta}>
                        {entry.siteName} | {entry.shiftDate} | {formatNumber(entry.billableHours)} billable hrs | {entry.contractRuleName} | {formatMoney(entry.invoiceAmount)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.helperText}>Select an invoice batch to view its lifecycle and rows.</Text>
            )}
          </View>
        </View>
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
  workspace: {
    gap: 18,
  },
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
  eyebrow: {
    color: '#0f766e',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    color: '#0f172a',
    fontSize: 30,
    fontWeight: '800',
  },
  subtitle: {
    color: '#64748b',
    marginTop: 6,
    fontSize: 14,
    lineHeight: 21,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#0f766e',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '800',
  },
  secondaryButton: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  feedbackCard: {
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
  },
  feedbackSuccess: {
    backgroundColor: '#ecfdf5',
    borderColor: '#bbf7d0',
  },
  feedbackError: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  feedbackText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    minWidth: 150,
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 16,
    borderColor: '#dbe4ef',
    borderWidth: 1,
  },
  metricLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  metricValue: {
    color: '#0f172a',
    fontSize: 22,
    fontWeight: '800',
    marginTop: 8,
  },
  panel: {
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 18,
    borderColor: '#dbe4ef',
    borderWidth: 1,
    gap: 14,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  panelTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '800',
  },
  helperText: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
  },
  errorText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '700',
  },
  filterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
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
  splitLayout: {
    flexDirection: 'row',
    gap: 18,
    alignItems: 'flex-start',
  },
  mainColumn: {
    flex: 2,
    gap: 18,
  },
  sideColumn: {
    flex: 1,
    minWidth: 340,
    gap: 18,
  },
  batchCreateBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 14,
    borderColor: '#e2e8f0',
    borderWidth: 1,
    gap: 10,
  },
  batchCreateTitle: {
    color: '#0f172a',
    fontWeight: '800',
  },
  emptyState: {
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  emptyTitle: {
    color: '#0f172a',
    fontWeight: '800',
    marginBottom: 4,
  },
  groupCard: {
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 18,
    overflow: 'hidden',
  },
  groupHeader: {
    backgroundColor: '#f8fafc',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    justifyContent: 'space-between',
  },
  groupTitle: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '800',
  },
  groupMeta: {
    color: '#64748b',
    fontSize: 13,
  },
  groupTotals: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  groupTotalText: {
    color: '#334155',
    fontWeight: '700',
    fontSize: 13,
  },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#94a3b8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#0f766e',
    borderColor: '#0f766e',
  },
  checkboxDisabled: {
    opacity: 0.35,
  },
  checkboxText: {
    color: '#ffffff',
    fontWeight: '800',
  },
  rowMain: {
    flex: 1.5,
    minWidth: 160,
  },
  rowTitle: {
    color: '#0f172a',
    fontWeight: '800',
  },
  rowMeta: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 3,
  },
  rowAmount: {
    color: '#0f172a',
    fontWeight: '700',
    minWidth: 86,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  detailStack: {
    gap: 10,
  },
  detailRow: {
    gap: 2,
  },
  detailLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  detailValue: {
    color: '#0f172a',
    fontWeight: '700',
  },
  batchList: {
    maxHeight: 280,
  },
  batchListItem: {
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  batchListItemActive: {
    borderColor: '#0f766e',
    backgroundColor: '#f0fdfa',
  },
  batchTitle: {
    color: '#0f172a',
    fontWeight: '800',
  },
  batchMeta: {
    color: '#64748b',
    fontSize: 12,
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sectionSubheading: {
    color: '#0f172a',
    fontWeight: '800',
    marginTop: 8,
  },
  batchRow: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 3,
  },
  batchRowTitle: {
    color: '#0f172a',
    fontWeight: '800',
  },
});
