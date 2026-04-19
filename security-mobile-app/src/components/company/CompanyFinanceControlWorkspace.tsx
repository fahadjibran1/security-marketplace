import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Timesheet, TimesheetBillingStatus, TimesheetPayrollStatus } from '../../types/models';

type GroupView = 'week' | 'month' | 'client' | 'site';
type CommercialState =
  | 'unpaid_uninvoiced'
  | 'paid_not_invoiced'
  | 'invoiced_not_paid'
  | 'fully_settled'
  | 'missing_data';

type CommercialStateFilter = CommercialState | 'all' | 'missing_client' | 'missing_rate';

type FinanceControlWorkspaceProps = {
  timesheets: Timesheet[];
  refreshing?: boolean;
  onRefresh?: () => Promise<void> | void;
};

type FinanceRow = {
  timesheet: Timesheet;
  id: number;
  siteName: string;
  clientName: string;
  guardName: string;
  shiftDate: string;
  shiftDateValue: Date | null;
  approvedHours: number;
  billableHours: number;
  hourlyRate: number | null;
  billingRate: number | null;
  costAmount: number | null;
  revenueAmount: number | null;
  marginAmount: number | null;
  payrollStatus: TimesheetPayrollStatus;
  payrollBatchLabel: string;
  billingStatus: TimesheetBillingStatus;
  invoiceBatchLabel: string;
  commercialState: CommercialState;
  flags: string[];
  companyNote: string;
  searchText: string;
};

type FinanceGroup = {
  key: string;
  label: string;
  rows: FinanceRow[];
  totals: FinanceTotals;
};

type FinanceTotals = {
  records: number;
  approvedHours: number;
  cost: number;
  revenue: number;
  margin: number;
  unpaidCount: number;
  uninvoicedCount: number;
  paidNotInvoicedCount: number;
  invoicedNotPaidCount: number;
  missingDataCount: number;
};

const UK_LOCALE = 'en-GB';
const MONEY_FORMATTER = new Intl.NumberFormat(UK_LOCALE, { style: 'currency', currency: 'GBP' });

const PAYROLL_OPTIONS = [
  { label: 'All payroll statuses', value: 'all' },
  { label: 'Unpaid', value: 'unpaid' },
  { label: 'Included', value: 'included' },
  { label: 'Paid', value: 'paid' },
];

const BILLING_OPTIONS = [
  { label: 'All billing statuses', value: 'all' },
  { label: 'Uninvoiced', value: 'uninvoiced' },
  { label: 'Included', value: 'included' },
  { label: 'Invoiced', value: 'invoiced' },
];

const COMMERCIAL_STATE_OPTIONS: Array<{ label: string; value: CommercialStateFilter }> = [
  { label: 'All commercial states', value: 'all' },
  { label: 'Unpaid and uninvoiced', value: 'unpaid_uninvoiced' },
  { label: 'Paid not invoiced', value: 'paid_not_invoiced' },
  { label: 'Invoiced not paid', value: 'invoiced_not_paid' },
  { label: 'Fully settled', value: 'fully_settled' },
  { label: 'Missing client', value: 'missing_client' },
  { label: 'Missing rate', value: 'missing_rate' },
];

const GROUP_OPTIONS = [
  { label: 'Group by week', value: 'week' },
  { label: 'Group by month', value: 'month' },
  { label: 'Group by client', value: 'client' },
  { label: 'Group by site', value: 'site' },
];

type WebSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
};

function WebSelect({ value, onChange, options }: WebSelectProps) {
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

function toNumber(value?: string | number | null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePayrollStatus(value?: string | null): TimesheetPayrollStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'included' || normalized === 'paid') return normalized;
  return 'unpaid';
}

function normalizeBillingStatus(value?: string | null): TimesheetBillingStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'included' || normalized === 'invoiced') return normalized;
  return 'uninvoiced';
}

function formatStatusLabel(value?: string | null) {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatMoney(value?: number | null) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'Rate unavailable' : MONEY_FORMATTER.format(value);
}

function formatMoneyTotal(value: number) {
  return MONEY_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

function formatHours(value: number) {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.00$/, '') : '0';
}

function parseDateValue(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabel(value?: string | null) {
  const date = parseDateValue(value);
  if (!date) return 'Not set';
  return date.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
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

function getPeriodInfo(date: Date | null, groupView: GroupView) {
  if (!date || Number.isNaN(date.getTime())) return { key: 'unknown-period', label: 'Unknown period' };

  if (groupView === 'month') {
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleDateString(UK_LOCALE, { month: 'long', year: 'numeric' }),
    };
  }

  const weekStart = getWeekStart(date);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  return {
    key: `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`,
    label: `${formatDateLabel(weekStart.toISOString())} - ${formatDateLabel(weekEnd.toISOString())}`,
  };
}

function getClient(timesheet: Timesheet) {
  return timesheet.shift?.site?.client ?? timesheet.shift?.job?.site?.client ?? timesheet.shift?.assignment?.job?.site?.client ?? null;
}

function getClientName(timesheet: Timesheet) {
  const client = getClient(timesheet);
  return client?.name || timesheet.shift?.site?.clientName || 'Client unavailable';
}

function getClientId(timesheet: Timesheet) {
  return getClient(timesheet)?.id ?? timesheet.shift?.site?.clientId ?? timesheet.shift?.job?.site?.clientId ?? null;
}

function getSiteName(timesheet: Timesheet) {
  return timesheet.shift?.site?.name || timesheet.shift?.siteName || 'Unknown site';
}

function getSiteId(timesheet: Timesheet) {
  return timesheet.shift?.site?.id ?? timesheet.shift?.siteId ?? timesheet.shift?.job?.siteId ?? null;
}

function getGuardName(timesheet: Timesheet) {
  return timesheet.guard?.fullName || timesheet.shift?.guard?.fullName || timesheet.shift?.assignment?.guard?.fullName || `Guard #${timesheet.guardId}`;
}

function getGuardId(timesheet: Timesheet) {
  return timesheet.guard?.id ?? timesheet.shift?.guard?.id ?? timesheet.shift?.assignment?.guard?.id ?? timesheet.guardId ?? null;
}

function getHourlyRate(timesheet: Timesheet) {
  return toNumber(timesheet.shift?.job?.hourlyRate) ?? toNumber(timesheet.shift?.assignment?.job?.hourlyRate);
}

function getBillingRate(timesheet: Timesheet) {
  return (
    toNumber(timesheet.effectiveBillingRate) ??
    toNumber(timesheet.billingRate) ??
    toNumber(timesheet.shift?.job?.billingRate) ??
    toNumber(timesheet.shift?.assignment?.job?.billingRate) ??
    getHourlyRate(timesheet)
  );
}

function getApprovedHours(timesheet: Timesheet) {
  return toNumber(timesheet.approvedHours) ?? toNumber(timesheet.hoursWorked) ?? 0;
}

function getCommercialState(payrollStatus: TimesheetPayrollStatus, billingStatus: TimesheetBillingStatus, hasMissingData: boolean): CommercialState {
  if (hasMissingData) return 'missing_data';
  if (payrollStatus === 'paid' && billingStatus === 'invoiced') return 'fully_settled';
  if (payrollStatus === 'paid' && billingStatus !== 'invoiced') return 'paid_not_invoiced';
  if (payrollStatus !== 'paid' && billingStatus === 'invoiced') return 'invoiced_not_paid';
  return 'unpaid_uninvoiced';
}

function buildFinanceRow(timesheet: Timesheet): FinanceRow | null {
  if (String(timesheet.approvalStatus || '').trim().toLowerCase() !== 'approved') return null;

  const approvedHours = getApprovedHours(timesheet);
  const billableHours = toNumber(timesheet.billableHours) ?? approvedHours;
  const hourlyRate = getHourlyRate(timesheet);
  const billingRate = getBillingRate(timesheet);
  const costAmount = toNumber(timesheet.costAmount) ?? (hourlyRate === null ? null : approvedHours * hourlyRate);
  const revenueAmount = toNumber(timesheet.revenueAmount) ?? (billingRate === null ? null : billableHours * billingRate);
  const marginAmount = toNumber(timesheet.marginAmount) ?? (costAmount === null || revenueAmount === null ? null : revenueAmount - costAmount);
  const payrollStatus = normalizePayrollStatus(timesheet.payrollStatus);
  const billingStatus = normalizeBillingStatus(timesheet.billingStatus);
  const clientId = getClientId(timesheet);
  const missingClient = clientId === null;
  const missingRate = hourlyRate === null;
  const missingBillingRate = billingRate === null;
  const flags = [
    missingClient ? 'Missing client' : null,
    missingRate ? 'Missing guard rate' : null,
    missingBillingRate ? 'Missing billing rate' : null,
    payrollStatus === 'paid' && billingStatus !== 'invoiced' ? 'Paid not invoiced' : null,
    billingStatus === 'invoiced' && payrollStatus !== 'paid' ? 'Invoiced not paid' : null,
    payrollStatus !== 'paid' && billingStatus !== 'invoiced' ? 'Neither paid nor invoiced' : null,
    payrollStatus === 'paid' && billingStatus === 'invoiced' ? 'Paid and invoiced' : null,
  ].filter((flag): flag is string => Boolean(flag));
  const commercialState = getCommercialState(payrollStatus, billingStatus, missingClient || missingRate || missingBillingRate);
  const shiftDateValue = parseDateValue(getShiftDate(timesheet));
  const siteName = getSiteName(timesheet);
  const clientName = getClientName(timesheet);
  const guardName = getGuardName(timesheet);
  const payrollBatchLabel = timesheet.payrollBatch
    ? `#${timesheet.payrollBatch.id} ${formatStatusLabel(timesheet.payrollBatch.status)}`
    : 'Unbatched';
  const invoiceBatchLabel = timesheet.invoiceBatch
    ? `#${timesheet.invoiceBatch.id} ${formatStatusLabel(timesheet.invoiceBatch.status)}`
    : 'Unbatched';

  return {
    timesheet,
    id: timesheet.id,
    siteName,
    clientName,
    guardName,
    shiftDate: formatDateLabel(getShiftDate(timesheet)),
    shiftDateValue,
    approvedHours,
    billableHours,
    hourlyRate,
    billingRate,
    costAmount,
    revenueAmount,
    marginAmount,
    payrollStatus,
    payrollBatchLabel,
    billingStatus,
    invoiceBatchLabel,
    commercialState,
    flags,
    companyNote: timesheet.companyNote || '',
    searchText: `${timesheet.id} ${siteName} ${clientName} ${guardName} ${formatStatusLabel(payrollStatus)} ${formatStatusLabel(billingStatus)} ${flags.join(' ')}`.toLowerCase(),
  };
}

function createEmptyTotals(): FinanceTotals {
  return {
    records: 0,
    approvedHours: 0,
    cost: 0,
    revenue: 0,
    margin: 0,
    unpaidCount: 0,
    uninvoicedCount: 0,
    paidNotInvoicedCount: 0,
    invoicedNotPaidCount: 0,
    missingDataCount: 0,
  };
}

function addRowToTotals(totals: FinanceTotals, row: FinanceRow) {
  totals.records += 1;
  totals.approvedHours += row.approvedHours;
  totals.cost += row.costAmount ?? 0;
  totals.revenue += row.revenueAmount ?? 0;
  totals.margin += row.marginAmount ?? 0;
  if (row.payrollStatus !== 'paid') totals.unpaidCount += 1;
  if (row.billingStatus !== 'invoiced') totals.uninvoicedCount += 1;
  if (row.commercialState === 'paid_not_invoiced') totals.paidNotInvoicedCount += 1;
  if (row.commercialState === 'invoiced_not_paid') totals.invoicedNotPaidCount += 1;
  if (row.commercialState === 'missing_data') totals.missingDataCount += 1;
}

function roundTotals(totals: FinanceTotals): FinanceTotals {
  return {
    ...totals,
    approvedHours: Number(totals.approvedHours.toFixed(2)),
    cost: Number(totals.cost.toFixed(2)),
    revenue: Number(totals.revenue.toFixed(2)),
    margin: Number(totals.margin.toFixed(2)),
  };
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

function buildCsvRows(rows: FinanceRow[], groups: FinanceGroup[] = []) {
  const output: Array<Array<string | number | null | undefined>> = [[
    'timesheet id',
    'site',
    'client',
    'guard',
    'shift date',
    'approved hours',
    'hourly rate',
    'billing rate',
    'cost amount',
    'revenue amount',
    'margin amount',
    'payroll status',
    'payroll batch',
    'billing status',
    'invoice batch',
    'commercial state',
    'flags',
    'company note',
  ]];

  rows.forEach((row) => {
    output.push([
      row.id,
      row.siteName,
      row.clientName,
      row.guardName,
      row.shiftDate,
      formatHours(row.approvedHours),
      row.hourlyRate === null ? 'Rate unavailable' : row.hourlyRate.toFixed(2),
      row.billingRate === null ? 'Rate unavailable' : row.billingRate.toFixed(2),
      row.costAmount === null ? 'Rate unavailable' : row.costAmount.toFixed(2),
      row.revenueAmount === null ? 'Rate unavailable' : row.revenueAmount.toFixed(2),
      row.marginAmount === null ? 'Unavailable' : row.marginAmount.toFixed(2),
      formatStatusLabel(row.payrollStatus),
      row.payrollBatchLabel,
      formatStatusLabel(row.billingStatus),
      row.invoiceBatchLabel,
      formatStatusLabel(row.commercialState),
      row.flags.join(' | '),
      row.companyNote,
    ]);
  });

  groups.forEach((group) => {
    output.push([
      'SUMMARY',
      group.label,
      '',
      '',
      '',
      formatHours(group.totals.approvedHours),
      '',
      '',
      group.totals.cost.toFixed(2),
      group.totals.revenue.toFixed(2),
      group.totals.margin.toFixed(2),
      `Unpaid ${group.totals.unpaidCount}`,
      '',
      `Uninvoiced ${group.totals.uninvoicedCount}`,
      '',
      `Paid not invoiced ${group.totals.paidNotInvoicedCount} | Invoiced not paid ${group.totals.invoicedNotPaidCount}`,
      `Missing data ${group.totals.missingDataCount}`,
      `${group.totals.records} records`,
    ]);
  });

  return output;
}

function getStateTone(state: CommercialState) {
  switch (state) {
    case 'fully_settled':
      return { background: '#dcfce7', color: '#166534' };
    case 'paid_not_invoiced':
    case 'invoiced_not_paid':
      return { background: '#fef3c7', color: '#92400e' };
    case 'missing_data':
      return { background: '#fee2e2', color: '#991b1b' };
    case 'unpaid_uninvoiced':
    default:
      return { background: '#e0f2fe', color: '#075985' };
  }
}

export function CompanyFinanceControlWorkspace({ timesheets, refreshing, onRefresh }: FinanceControlWorkspaceProps) {
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [siteFilter, setSiteFilter] = React.useState('all');
  const [clientFilter, setClientFilter] = React.useState('all');
  const [guardFilter, setGuardFilter] = React.useState('all');
  const [payrollFilter, setPayrollFilter] = React.useState('all');
  const [billingFilter, setBillingFilter] = React.useState('all');
  const [commercialStateFilter, setCommercialStateFilter] = React.useState<CommercialStateFilter>('all');
  const [groupView, setGroupView] = React.useState<GroupView>('week');
  const [search, setSearch] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [selectedRowId, setSelectedRowId] = React.useState<number | null>(null);

  const rows = React.useMemo(
    () => timesheets.map(buildFinanceRow).filter((row): row is FinanceRow => Boolean(row)),
    [timesheets],
  );

  const siteOptions = React.useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => values.set(String(getSiteId(row.timesheet) ?? row.siteName), row.siteName));
    return [{ label: 'All sites', value: 'all' }, ...Array.from(values.entries()).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const clientOptions = React.useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => values.set(String(getClientId(row.timesheet) ?? row.clientName), row.clientName));
    return [{ label: 'All clients', value: 'all' }, ...Array.from(values.entries()).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const guardOptions = React.useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => values.set(String(getGuardId(row.timesheet) ?? row.guardName), row.guardName));
    return [{ label: 'All guards', value: 'all' }, ...Array.from(values.entries()).map(([value, label]) => ({ value, label }))];
  }, [rows]);

  const filteredRows = React.useMemo(() => {
    const fromDate = dateFrom.trim() ? parseDateValue(dateFrom.trim()) : null;
    const toDate = dateTo.trim() ? parseDateValue(dateTo.trim()) : null;
    if (toDate) toDate.setHours(23, 59, 59, 999);
    const searchTerm = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (fromDate && row.shiftDateValue && row.shiftDateValue < fromDate) return false;
      if (toDate && row.shiftDateValue && row.shiftDateValue > toDate) return false;
      if (siteFilter !== 'all' && String(getSiteId(row.timesheet) ?? row.siteName) !== siteFilter) return false;
      if (clientFilter !== 'all' && String(getClientId(row.timesheet) ?? row.clientName) !== clientFilter) return false;
      if (guardFilter !== 'all' && String(getGuardId(row.timesheet) ?? row.guardName) !== guardFilter) return false;
      if (payrollFilter !== 'all' && row.payrollStatus !== payrollFilter) return false;
      if (billingFilter !== 'all' && row.billingStatus !== billingFilter) return false;
      if (commercialStateFilter === 'missing_client' && !row.flags.includes('Missing client')) return false;
      if (commercialStateFilter === 'missing_rate' && !row.flags.some((flag) => flag === 'Missing guard rate' || flag === 'Missing billing rate')) return false;
      if (!['all', 'missing_client', 'missing_rate'].includes(commercialStateFilter) && row.commercialState !== commercialStateFilter) return false;
      if (searchTerm && !row.searchText.includes(searchTerm)) return false;
      return true;
    });
  }, [billingFilter, clientFilter, commercialStateFilter, dateFrom, dateTo, guardFilter, payrollFilter, rows, search, siteFilter]);

  const selectedRows = React.useMemo(
    () => filteredRows.filter((row) => selectedIds.includes(row.id)),
    [filteredRows, selectedIds],
  );

  const selectedRow = React.useMemo(
    () => filteredRows.find((row) => row.id === selectedRowId) ?? filteredRows[0] ?? null,
    [filteredRows, selectedRowId],
  );

  const totals = React.useMemo(() => {
    const next = createEmptyTotals();
    filteredRows.forEach((row) => addRowToTotals(next, row));
    return roundTotals(next);
  }, [filteredRows]);

  const paidNotInvoicedAmount = React.useMemo(
    () => filteredRows.reduce((sum, row) => sum + (row.commercialState === 'paid_not_invoiced' ? row.revenueAmount ?? 0 : 0), 0),
    [filteredRows],
  );

  const invoicedNotPaidAmount = React.useMemo(
    () => filteredRows.reduce((sum, row) => sum + (row.commercialState === 'invoiced_not_paid' ? row.costAmount ?? 0 : 0), 0),
    [filteredRows],
  );

  const groups = React.useMemo(() => {
    const map = new Map<string, FinanceGroup>();
    filteredRows.forEach((row) => {
      let key = '';
      let label = '';
      if (groupView === 'client') {
        key = `client-${getClientId(row.timesheet) ?? row.clientName}`;
        label = row.clientName;
      } else if (groupView === 'site') {
        key = `site-${getSiteId(row.timesheet) ?? row.siteName}`;
        label = row.siteName;
      } else {
        const period = getPeriodInfo(row.shiftDateValue, groupView);
        key = `${groupView}-${period.key}`;
        label = period.label;
      }

      if (!map.has(key)) {
        map.set(key, { key, label, rows: [], totals: createEmptyTotals() });
      }
      const group = map.get(key)!;
      group.rows.push(row);
      addRowToTotals(group.totals, row);
    });

    return Array.from(map.values())
      .map((group) => ({ ...group, totals: roundTotals(group.totals) }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [filteredRows, groupView]);

  function toggleSelected(row: FinanceRow) {
    setSelectedIds((current) => (current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id]));
    setSelectedRowId(row.id);
  }

  function exportFiltered() {
    downloadCsv(
      `finance-control-filtered-${sanitizeFilenamePart(groupView)}-${getDownloadTimestamp()}.csv`,
      buildCsvRows(filteredRows, groups),
    );
  }

  function exportSelected() {
    downloadCsv(
      `finance-control-selected-${getDownloadTimestamp()}.csv`,
      buildCsvRows(selectedRows),
    );
  }

  function exportGroup(group: FinanceGroup) {
    downloadCsv(
      `finance-control-group-${sanitizeFilenamePart(group.label)}-${getDownloadTimestamp()}.csv`,
      buildCsvRows(group.rows, [group]),
    );
  }

  return (
    <View style={styles.workspace}>
      <View style={styles.headerCard}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Commercial Operations</Text>
          <Text style={styles.title}>Finance Control</Text>
          <Text style={styles.subtitle}>
            Read-only control room for approved work, payroll exposure, invoice exposure, and incomplete commercial data.
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={onRefresh} disabled={refreshing}>
            <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh Data'}</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={exportFiltered}>
            <Text style={styles.primaryButtonText}>Export Filtered View</Text>
          </Pressable>
          <Pressable style={[styles.secondaryButton, !selectedRows.length && styles.buttonDisabled]} onPress={exportSelected} disabled={!selectedRows.length}>
            <Text style={styles.secondaryButtonText}>Export Selected</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <MetricCard label="Approved Records" value={String(totals.records)} />
        <MetricCard label="Approved Hours" value={`${formatHours(totals.approvedHours)} h`} />
        <MetricCard label="Total Cost" value={formatMoneyTotal(totals.cost)} />
        <MetricCard label="Total Revenue" value={formatMoneyTotal(totals.revenue)} />
        <MetricCard label="Gross Margin" value={formatMoneyTotal(totals.margin)} />
        <MetricCard label="Paid Not Invoiced" value={formatMoneyTotal(paidNotInvoicedAmount)} tone="warning" />
        <MetricCard label="Invoiced Not Paid" value={formatMoneyTotal(invoicedNotPaidAmount)} tone="warning" />
        <MetricCard label="Missing Data" value={String(totals.missingDataCount)} tone={totals.missingDataCount ? 'danger' : undefined} />
      </View>

      <View style={styles.filterCard}>
        <View style={styles.filterGrid}>
          <TextInput style={styles.input} value={dateFrom} onChangeText={setDateFrom} placeholder="Date from YYYY-MM-DD" />
          <TextInput style={styles.input} value={dateTo} onChangeText={setDateTo} placeholder="Date to YYYY-MM-DD" />
          <WebSelect value={siteFilter} onChange={setSiteFilter} options={siteOptions} />
          <WebSelect value={clientFilter} onChange={setClientFilter} options={clientOptions} />
          <WebSelect value={guardFilter} onChange={setGuardFilter} options={guardOptions} />
          <WebSelect value={payrollFilter} onChange={setPayrollFilter} options={PAYROLL_OPTIONS} />
          <WebSelect value={billingFilter} onChange={setBillingFilter} options={BILLING_OPTIONS} />
          <WebSelect value={commercialStateFilter} onChange={(value) => setCommercialStateFilter(value as CommercialStateFilter)} options={COMMERCIAL_STATE_OPTIONS} />
          <WebSelect value={groupView} onChange={(value) => setGroupView(value as GroupView)} options={GROUP_OPTIONS} />
          <TextInput style={styles.input} value={search} onChangeText={setSearch} placeholder="Search site, client, guard, flag..." />
        </View>
      </View>

      <View style={styles.contentLayout}>
        <View style={styles.mainColumn}>
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>Control Groups</Text>
                <Text style={styles.helperText}>{filteredRows.length} approved row(s) match the current filters.</Text>
              </View>
            </View>

            {groups.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No approved finance rows match these filters.</Text>
                <Text style={styles.helperText}>Approved timesheets appear here once they have payroll, billing, and commercial data.</Text>
              </View>
            ) : (
              groups.map((group) => (
                <View key={group.key} style={styles.groupCard}>
                  <View style={styles.groupHeader}>
                    <View style={styles.groupHeaderCopy}>
                      <Text style={styles.groupTitle}>{group.label}</Text>
                      <Text style={styles.groupMeta}>
                        {group.totals.records} records | {formatHours(group.totals.approvedHours)} h | Cost {formatMoneyTotal(group.totals.cost)} | Revenue {formatMoneyTotal(group.totals.revenue)}
                      </Text>
                    </View>
                    <Pressable style={styles.secondaryButton} onPress={() => exportGroup(group)}>
                      <Text style={styles.secondaryButtonText}>Export Group</Text>
                    </Pressable>
                  </View>
                  <View style={styles.groupStats}>
                    <Text style={styles.groupStat}>Margin {formatMoneyTotal(group.totals.margin)}</Text>
                    <Text style={styles.groupStat}>Unpaid {group.totals.unpaidCount}</Text>
                    <Text style={styles.groupStat}>Uninvoiced {group.totals.uninvoicedCount}</Text>
                    <Text style={styles.groupStat}>Paid not invoiced {group.totals.paidNotInvoicedCount}</Text>
                    <Text style={styles.groupStat}>Invoiced not paid {group.totals.invoicedNotPaidCount}</Text>
                    <Text style={styles.groupStat}>Missing data {group.totals.missingDataCount}</Text>
                  </View>

                  <ScrollView horizontal>
                    <View style={styles.table}>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.headerCell, styles.checkboxCol]}>Sel</Text>
                        <Text style={[styles.headerCell, styles.identityCol]}>Work</Text>
                        <Text style={styles.headerCell}>Hours</Text>
                        <Text style={styles.headerCell}>Cost</Text>
                        <Text style={styles.headerCell}>Revenue</Text>
                        <Text style={styles.headerCell}>Margin</Text>
                        <Text style={styles.headerCell}>Payroll</Text>
                        <Text style={styles.headerCell}>Billing</Text>
                        <Text style={[styles.headerCell, styles.stateCol]}>State</Text>
                      </View>

                      {group.rows.map((row) => {
                        const tone = getStateTone(row.commercialState);
                        const isSelected = selectedIds.includes(row.id);
                        return (
                          <Pressable key={row.id} style={styles.tableRow} onPress={() => setSelectedRowId(row.id)}>
                            <Pressable style={[styles.checkbox, isSelected && styles.checkboxSelected]} onPress={() => toggleSelected(row)}>
                              <Text style={styles.checkboxText}>{isSelected ? 'x' : ''}</Text>
                            </Pressable>
                            <View style={styles.identityCol}>
                              <Text style={styles.rowTitle}>#{row.id} {row.guardName}</Text>
                              <Text style={styles.rowMeta}>{row.shiftDate} | {row.siteName} | {row.clientName}</Text>
                            </View>
                            <Text style={styles.tableCell}>{formatHours(row.approvedHours)}</Text>
                            <Text style={styles.tableCell}>{formatMoney(row.costAmount)}</Text>
                            <Text style={styles.tableCell}>{formatMoney(row.revenueAmount)}</Text>
                            <Text style={styles.tableCell}>{formatMoney(row.marginAmount)}</Text>
                            <Text style={styles.tableCell}>{formatStatusLabel(row.payrollStatus)}</Text>
                            <Text style={styles.tableCell}>{formatStatusLabel(row.billingStatus)}</Text>
                            <View style={[styles.stateBadge, { backgroundColor: tone.background }]}>
                              <Text style={[styles.stateBadgeText, { color: tone.color }]}>{formatStatusLabel(row.commercialState)}</Text>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  </ScrollView>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.sideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Finance Row Detail</Text>
            {selectedRow ? (
              <View style={styles.detailStack}>
                <Detail label="Timesheet" value={`#${selectedRow.id}`} />
                <Detail label="Site" value={selectedRow.siteName} />
                <Detail label="Client" value={selectedRow.clientName} />
                <Detail label="Guard" value={selectedRow.guardName} />
                <Detail label="Shift Date" value={selectedRow.shiftDate} />
                <Detail label="Approved Hours" value={formatHours(selectedRow.approvedHours)} />
                <Detail label="Billable Hours" value={formatHours(selectedRow.billableHours)} />
                <Detail label="Hourly Rate" value={formatMoney(selectedRow.hourlyRate)} />
                <Detail label="Billing Rate" value={formatMoney(selectedRow.billingRate)} />
                <Detail label="Cost" value={formatMoney(selectedRow.costAmount)} />
                <Detail label="Revenue" value={formatMoney(selectedRow.revenueAmount)} />
                <Detail label="Margin" value={formatMoney(selectedRow.marginAmount)} />
                <Detail label="Review Status" value={formatStatusLabel(selectedRow.timesheet.approvalStatus)} />
                <Detail label="Payroll Status" value={formatStatusLabel(selectedRow.payrollStatus)} />
                <Detail label="Payroll Batch" value={selectedRow.payrollBatchLabel} />
                <Detail label="Billing Status" value={formatStatusLabel(selectedRow.billingStatus)} />
                <Detail label="Invoice Batch" value={selectedRow.invoiceBatchLabel} />
                <Detail label="Company Note" value={selectedRow.companyNote || 'No company note'} />
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>Key warnings / flags</Text>
                  {selectedRow.flags.length ? (
                    selectedRow.flags.map((flag) => <Text key={flag} style={styles.warningText}>- {flag}</Text>)
                  ) : (
                    <Text style={styles.helperText}>No commercial warnings for this row.</Text>
                  )}
                </View>
              </View>
            ) : (
              <Text style={styles.helperText}>Select a row to inspect commercial status, batch links, and warnings.</Text>
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
  buttonDisabled: { opacity: 0.5 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metricCard: { minWidth: 165, flex: 1, backgroundColor: '#ffffff', borderRadius: 18, padding: 16, borderColor: '#dbe4ef', borderWidth: 1 },
  metricWarning: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  metricDanger: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  metricLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  metricValue: { color: '#0f172a', fontSize: 22, fontWeight: '800', marginTop: 8 },
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
  contentLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  mainColumn: { flex: 2, minWidth: 620 },
  sideColumn: { flex: 1, minWidth: 360 },
  panel: { backgroundColor: '#ffffff', borderRadius: 22, padding: 18, borderColor: '#dbe4ef', borderWidth: 1, gap: 14 },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  panelTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  helperText: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  emptyState: { backgroundColor: '#f8fafc', borderRadius: 18, padding: 18, borderColor: '#e2e8f0', borderWidth: 1 },
  emptyTitle: { color: '#0f172a', fontWeight: '800', fontSize: 16, marginBottom: 4 },
  groupCard: { borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 18, padding: 14, gap: 12 },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  groupHeaderCopy: { flex: 1, minWidth: 320 },
  groupTitle: { color: '#0f172a', fontWeight: '800', fontSize: 16 },
  groupMeta: { color: '#64748b', fontSize: 12, marginTop: 4 },
  groupStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groupStat: { color: '#334155', fontSize: 12, fontWeight: '700', backgroundColor: '#f8fafc', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  table: { minWidth: 1120 },
  tableHeader: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomColor: '#e2e8f0', borderBottomWidth: 1 },
  tableRow: { flexDirection: 'row', gap: 10, paddingVertical: 12, borderBottomColor: '#f1f5f9', borderBottomWidth: 1, alignItems: 'center' },
  headerCell: { width: 105, color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  tableCell: { width: 105, color: '#0f172a', fontWeight: '700', fontSize: 12 },
  checkboxCol: { width: 44 },
  checkbox: { width: 30, height: 30, borderRadius: 8, borderColor: '#94a3b8', borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: '#0f172a', borderColor: '#0f172a' },
  checkboxText: { color: '#ffffff', fontWeight: '900' },
  identityCol: { width: 260 },
  stateCol: { width: 150 },
  rowTitle: { color: '#0f172a', fontWeight: '800' },
  rowMeta: { color: '#64748b', fontSize: 12, marginTop: 3 },
  stateBadge: { width: 150, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, alignItems: 'center' },
  stateBadgeText: { fontSize: 12, fontWeight: '800' },
  detailStack: { gap: 10 },
  detailRow: { borderBottomColor: '#eef2f7', borderBottomWidth: 1, paddingBottom: 8 },
  detailLabel: { color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  detailValue: { color: '#0f172a', fontSize: 14, fontWeight: '700', marginTop: 3 },
  warningBox: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 16, padding: 12, gap: 6 },
  warningTitle: { color: '#0f172a', fontWeight: '800' },
  warningText: { color: '#334155', fontWeight: '700' },
});
