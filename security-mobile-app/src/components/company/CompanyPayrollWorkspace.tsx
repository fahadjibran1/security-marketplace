import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  createCompanyPayrollBatch,
  formatApiErrorMessage,
  updateCompanyTimesheetPayroll,
} from '../../services/api';
import { PayrollBatchStatus, Timesheet, TimesheetPayrollStatus } from '../../types/models';

type WorkspaceFeedback = {
  tone: 'success' | 'error' | 'info';
  title: string;
  message: string;
} | null;

type PeriodView = 'week' | 'month';
type PayrollFilter = TimesheetPayrollStatus | 'all';

type CompanyPayrollWorkspaceProps = {
  timesheets: Timesheet[];
  refreshing: boolean;
  onRefresh: () => Promise<void>;
};

type WebSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
};

type WebCheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
};

type EnrichedTimesheet = {
  timesheet: Timesheet;
  siteId: string;
  siteName: string;
  guardId: string;
  guardName: string;
  shiftDate: Date;
  shiftDateLabel: string;
  scheduledLabel: string;
  attendanceLabel: string;
  hourlyRate: number | null;
  approvedHours: number;
  approvedAmount: number | null;
  costAmount: number | null;
  payrollStatus: TimesheetPayrollStatus;
  payrollIncludedAtLabel: string;
  payrollPaidAtLabel: string;
  batchStateLabel: string;
  batchStateTone: 'neutral' | 'draft' | 'finalised' | 'paid';
  searchText: string;
  selectableForPayrollActions: boolean;
  selectableForBatchCreation: boolean;
};

type GroupedPayrollTimesheets = {
  key: string;
  siteName: string;
  periodKey: string;
  periodLabel: string;
  rows: EnrichedTimesheet[];
  totals: {
    count: number;
    approvedHours: number;
    approvedAmount: number;
    costAmount: number;
    missingRateCount: number;
    unpaidCount: number;
    includedCount: number;
    paidCount: number;
  };
};

const UK_LOCALE = 'en-GB';
const GBP_CURRENCY = 'GBP';

function getLiteralDateTimeParts(value?: string | null) {
  if (!value) return null;

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;

  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || null,
    minute: match[5] || null,
  };
}

function parseDateValue(value?: string | null) {
  if (!value) return null;

  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    const date = new Date(
      Number(literalParts.year),
      Number(literalParts.month) - 1,
      Number(literalParts.day),
      Number(literalParts.hour || '0'),
      Number(literalParts.minute || '0'),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabel(value?: string | null) {
  const date = parseDateValue(value);
  if (!date) return 'Not set';
  return date.toLocaleDateString(UK_LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeLabel(value?: string | null) {
  if (!value) {
    return 'Not set';
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts?.hour && literalParts?.minute) {
    return `${literalParts.hour}:${literalParts.minute}`;
  }

  const date = parseDateValue(value);
  if (!date) return value;
  return date.toLocaleTimeString(UK_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) return 'Not recorded';
  return `${formatDateLabel(value)} | ${formatTimeLabel(value)}`;
}

function normalizeApprovalStatus(value?: string | null) {
  return (value || '').trim().toLowerCase();
}

function normalizePayrollStatus(value?: string | null): TimesheetPayrollStatus {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'included') return 'included';
  if (normalized === 'paid') return 'paid';
  return 'unpaid';
}

function normalizeBatchStatus(value?: string | null): PayrollBatchStatus | null {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'draft') return 'draft';
  if (normalized === 'finalised') return 'finalised';
  if (normalized === 'paid') return 'paid';
  return null;
}

function formatPayrollStatusLabel(value?: string | null) {
  switch (normalizePayrollStatus(value)) {
    case 'included':
      return 'Included';
    case 'paid':
      return 'Paid';
    case 'unpaid':
    default:
      return 'Unpaid';
  }
}

function getBatchState(timesheet: Timesheet) {
  const batchStatus = normalizeBatchStatus(timesheet.payrollBatch?.status);
  if (batchStatus === 'paid') {
    return { label: `Batch #${timesheet.payrollBatch?.id} Paid`, tone: 'paid' as const };
  }
  if (batchStatus === 'finalised') {
    return { label: `Batch #${timesheet.payrollBatch?.id} Finalised`, tone: 'finalised' as const };
  }
  if (batchStatus === 'draft') {
    return { label: `Batch #${timesheet.payrollBatch?.id} Draft`, tone: 'draft' as const };
  }
  return { label: 'Unbatched', tone: 'neutral' as const };
}

function getApprovedStatusPalette() {
  return { bg: '#DCFCE7', text: '#166534' };
}

function getPayrollStatusPalette(status: TimesheetPayrollStatus) {
  switch (status) {
    case 'paid':
      return { bg: '#DCFCE7', text: '#166534' };
    case 'included':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'unpaid':
    default:
      return { bg: '#FEF3C7', text: '#B45309' };
  }
}

function getBatchStatePalette(tone: EnrichedTimesheet['batchStateTone']) {
  switch (tone) {
    case 'paid':
      return { bg: '#DCFCE7', text: '#166534' };
    case 'finalised':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'draft':
      return { bg: '#FEF3C7', text: '#B45309' };
    case 'neutral':
    default:
      return { bg: '#E5E7EB', text: '#374151' };
  }
}

function toHours(value?: number | null) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function roundHours(value: number) {
  return Math.round(value * 100) / 100;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
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

function getTimesheetRate(timesheet: Timesheet) {
  const directJobRate = timesheet.shift?.job?.hourlyRate;
  if (directJobRate !== undefined && directJobRate !== null && Number.isFinite(Number(directJobRate))) {
    return roundCurrency(Number(directJobRate));
  }

  const assignmentJobRate = timesheet.shift?.assignment?.job?.hourlyRate;
  if (assignmentJobRate !== undefined && assignmentJobRate !== null && Number.isFinite(Number(assignmentJobRate))) {
    return roundCurrency(Number(assignmentJobRate));
  }

  return null;
}

function getApprovedHoursValue(timesheet: Timesheet) {
  if (timesheet.approvedHours !== undefined && timesheet.approvedHours !== null && Number.isFinite(Number(timesheet.approvedHours))) {
    return Number(timesheet.approvedHours);
  }

  if (normalizeApprovalStatus(timesheet.approvalStatus) === 'approved') {
    return toHours(timesheet.hoursWorked);
  }

  return 0;
}

function getAmountForHours(hours: number | null, rate: number | null) {
  if (hours === null || rate === null) {
    return null;
  }

  return roundCurrency(hours * rate);
}

function toIsoDateInput(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeekStart(value: Date) {
  const date = new Date(value);
  const day = date.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + delta);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getWeekEnd(value: Date) {
  const start = getWeekStart(value);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function getDayEnd(value: Date) {
  const end = new Date(value);
  end.setHours(23, 59, 59, 999);
  return end;
}

function getPeriodLabel(value: Date, periodView: PeriodView) {
  if (periodView === 'month') {
    return `Month of ${value.toLocaleDateString(UK_LOCALE, {
      month: 'long',
      year: 'numeric',
    })}`;
  }

  const weekStart = getWeekStart(value);
  const weekEnd = getWeekEnd(value);
  return `Week of ${formatDateLabel(weekStart.toISOString())} - ${formatDateLabel(weekEnd.toISOString())}`;
}

function getPeriodKey(value: Date, periodView: PeriodView) {
  if (periodView === 'month') {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  return toIsoDateInput(getWeekStart(value));
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

function WebSelect({ value, onChange, options, placeholder }: WebSelectProps) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';

    return (
      <SelectTag
        value={value}
        onChange={(event: any) => onChange(event.target.value)}
        style={styles.webSelect}
        aria-label={placeholder || 'Select an option'}
      >
        <OptionTag value="">{placeholder || 'Select an option'}</OptionTag>
        {options.map((option) => (
          <OptionTag key={option.value} value={option.value}>
            {option.label}
          </OptionTag>
        ))}
      </SelectTag>
    );
  }

  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      style={styles.input}
      placeholder={placeholder || 'Select an option'}
      placeholderTextColor="#64748b"
    />
  );
}

function WebCheckbox({ checked, onChange }: WebCheckboxProps) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserReady) {
    const InputTag: any = 'input';
    return (
      <InputTag
        type="checkbox"
        checked={checked}
        onChange={(event: any) => onChange(Boolean(event.target.checked))}
        style={styles.webCheckbox}
      />
    );
  }

  return (
    <Pressable style={styles.nativeCheckboxWrap} onPress={() => onChange(!checked)}>
      <View style={[styles.nativeCheckbox, checked && styles.nativeCheckboxChecked]} />
    </Pressable>
  );
}

function PeriodToggle({
  value,
  onChange,
}: {
  value: PeriodView;
  onChange: (value: PeriodView) => void;
}) {
  return (
    <View style={styles.segmentedControl}>
      {(['week', 'month'] as PeriodView[]).map((option) => {
        const active = value === option;
        return (
          <Pressable
            key={option}
            style={[styles.segmentedOption, active && styles.segmentedOptionActive]}
            onPress={() => onChange(option)}
          >
            <Text style={[styles.segmentedOptionText, active && styles.segmentedOptionTextActive]}>
              {option === 'week' ? 'Week' : 'Month'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function buildGroups(rows: EnrichedTimesheet[], periodView: PeriodView) {
  const groups = new Map<string, GroupedPayrollTimesheets>();

  rows.forEach((entry) => {
    const periodKey = getPeriodKey(entry.shiftDate, periodView);
    const periodLabel = getPeriodLabel(entry.shiftDate, periodView);
    const groupKey = `${entry.siteName}__${periodKey}`;
    const existing =
      groups.get(groupKey) || {
        key: groupKey,
        siteName: entry.siteName,
        periodKey,
        periodLabel,
        rows: [],
        totals: {
          count: 0,
          approvedHours: 0,
          approvedAmount: 0,
          costAmount: 0,
          missingRateCount: 0,
          unpaidCount: 0,
          includedCount: 0,
          paidCount: 0,
        },
      };

    existing.rows.push(entry);
    existing.totals.count += 1;
    existing.totals.approvedHours += entry.approvedHours;
    if (entry.approvedAmount !== null) {
      existing.totals.approvedAmount += entry.approvedAmount;
    } else {
      existing.totals.missingRateCount += 1;
    }
    if (entry.costAmount !== null) {
      existing.totals.costAmount += entry.costAmount;
    }

    if (entry.payrollStatus === 'paid') {
      existing.totals.paidCount += 1;
    } else if (entry.payrollStatus === 'included') {
      existing.totals.includedCount += 1;
    } else {
      existing.totals.unpaidCount += 1;
    }

    groups.set(groupKey, existing);
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      rows: group.rows.sort((left, right) => right.shiftDate.getTime() - left.shiftDate.getTime()),
      totals: {
        ...group.totals,
        approvedHours: roundHours(group.totals.approvedHours),
        approvedAmount: roundCurrency(group.totals.approvedAmount),
        costAmount: roundCurrency(group.totals.costAmount),
      },
    }))
    .sort((left, right) => {
      if (left.siteName !== right.siteName) return left.siteName.localeCompare(right.siteName);
      return right.rows[0].shiftDate.getTime() - left.rows[0].shiftDate.getTime();
    });
}

export function CompanyPayrollWorkspace({
  timesheets,
  refreshing,
  onRefresh,
}: CompanyPayrollWorkspaceProps) {
  const [siteFilter, setSiteFilter] = React.useState('');
  const [guardFilter, setGuardFilter] = React.useState('');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [periodView, setPeriodView] = React.useState<PeriodView>('week');
  const [payrollStatusFilter, setPayrollStatusFilter] = React.useState<PayrollFilter>('all');
  const [feedback, setFeedback] = React.useState<WorkspaceFeedback>(null);
  const [selectedTimesheetId, setSelectedTimesheetId] = React.useState<number | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [busyAction, setBusyAction] = React.useState<'unpaid' | 'included' | 'paid' | 'batch' | null>(null);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = React.useState<Record<string, boolean>>({});
  const [batchPeriodStart, setBatchPeriodStart] = React.useState('');
  const [batchPeriodEnd, setBatchPeriodEnd] = React.useState('');
  const [batchNotes, setBatchNotes] = React.useState('');

  const enrichedTimesheets = React.useMemo<EnrichedTimesheet[]>(() => {
    return timesheets
      .filter((timesheet) => normalizeApprovalStatus(timesheet.approvalStatus) === 'approved')
      .map((timesheet) => {
        const siteId = String(timesheet.shift?.site?.id ?? timesheet.shift?.siteId ?? timesheet.shiftId ?? 'unknown');
        const siteName = timesheet.shift?.site?.name || timesheet.shift?.siteName || `Site ${siteId}`;
        const guardId = String(timesheet.guard?.id ?? timesheet.guardId ?? 'unknown');
        const guardName = timesheet.guard?.fullName || `Guard #${guardId}`;
        const shiftDate =
          parseDateValue(timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt) || new Date();
        const scheduledStart = timesheet.scheduledStartAt || timesheet.shift?.start || null;
        const scheduledEnd = timesheet.scheduledEndAt || timesheet.shift?.end || null;
        const approvedHours = getApprovedHoursValue(timesheet);
        const hourlyRate = getTimesheetRate(timesheet);
        const approvedAmount = getAmountForHours(approvedHours, hourlyRate);
        const costAmount = typeof timesheet.costAmount === 'number' ? timesheet.costAmount : approvedAmount;
        const payrollStatus = normalizePayrollStatus(timesheet.payrollStatus);
        const batchState = getBatchState(timesheet);
        const isBatchLocked =
          normalizeBatchStatus(timesheet.payrollBatch?.status) === 'finalised' ||
          normalizeBatchStatus(timesheet.payrollBatch?.status) === 'paid';
        const selectableForPayrollActions = !timesheet.payrollBatch && payrollStatus !== 'paid';
        const selectableForBatchCreation = !timesheet.payrollBatch && payrollStatus !== 'paid' && !isBatchLocked;

        return {
          timesheet,
          siteId,
          siteName,
          guardId,
          guardName,
          shiftDate,
          shiftDateLabel: formatDateLabel(scheduledStart || timesheet.createdAt),
          scheduledLabel: `${formatTimeLabel(scheduledStart)} - ${formatTimeLabel(scheduledEnd)}`,
          attendanceLabel: `${formatTimeLabel(timesheet.actualCheckInAt)} / ${formatTimeLabel(timesheet.actualCheckOutAt)}`,
          hourlyRate,
          approvedHours,
          approvedAmount,
          costAmount,
          payrollStatus,
          payrollIncludedAtLabel: formatDateTimeLabel(timesheet.payrollIncludedAt),
          payrollPaidAtLabel: formatDateTimeLabel(timesheet.payrollPaidAt),
          batchStateLabel: batchState.label,
          batchStateTone: batchState.tone,
          searchText: [
            siteName,
            guardName,
            timesheet.id,
            timesheet.shiftId,
            timesheet.guardNote || '',
            timesheet.companyNote || '',
            payrollStatus,
            batchState.label,
          ]
            .join(' ')
            .toLowerCase(),
          selectableForPayrollActions,
          selectableForBatchCreation,
        };
      })
      .sort((left, right) => right.shiftDate.getTime() - left.shiftDate.getTime());
  }, [timesheets]);

  const siteOptions = React.useMemo(
    () =>
      Array.from(new Map(enrichedTimesheets.map((entry) => [entry.siteId, entry.siteName])).entries())
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [enrichedTimesheets],
  );

  const guardOptions = React.useMemo(
    () =>
      Array.from(new Map(enrichedTimesheets.map((entry) => [entry.guardId, entry.guardName])).entries())
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [enrichedTimesheets],
  );

  const filteredTimesheets = React.useMemo(() => {
    return enrichedTimesheets.filter((entry) => {
      if (siteFilter && entry.siteId !== siteFilter) return false;
      if (guardFilter && entry.guardId !== guardFilter) return false;
      if (payrollStatusFilter !== 'all' && entry.payrollStatus !== payrollStatusFilter) return false;

      if (startDate) {
        const minDate = parseDateValue(startDate);
        if (minDate && entry.shiftDate < minDate) return false;
      }

      if (endDate) {
        const maxDate = parseDateValue(endDate);
        if (maxDate && entry.shiftDate > getDayEnd(maxDate)) return false;
      }

      if (searchTerm.trim() && !entry.searchText.includes(searchTerm.trim().toLowerCase())) return false;
      return true;
    });
  }, [enrichedTimesheets, endDate, guardFilter, payrollStatusFilter, searchTerm, siteFilter, startDate]);

  const groupedTimesheets = React.useMemo(() => buildGroups(filteredTimesheets, periodView), [filteredTimesheets, periodView]);

  const selectedTimesheets = React.useMemo(
    () => filteredTimesheets.filter((entry) => selectedIds.includes(entry.timesheet.id)),
    [filteredTimesheets, selectedIds],
  );

  const selectedGroupedTimesheets = React.useMemo(
    () => buildGroups(selectedTimesheets, periodView),
    [periodView, selectedTimesheets],
  );

  const summary = React.useMemo(() => {
    const approvedCount = filteredTimesheets.length;
    const approvedHours = roundHours(filteredTimesheets.reduce((sum, entry) => sum + entry.approvedHours, 0));
    const approvedAmount = roundCurrency(filteredTimesheets.reduce((sum, entry) => sum + (entry.approvedAmount ?? 0), 0));
    const costAmount = roundCurrency(filteredTimesheets.reduce((sum, entry) => sum + (entry.costAmount ?? 0), 0));
    const unpaidCount = filteredTimesheets.filter((entry) => entry.payrollStatus === 'unpaid').length;
    const includedCount = filteredTimesheets.filter((entry) => entry.payrollStatus === 'included').length;
    const paidCount = filteredTimesheets.filter((entry) => entry.payrollStatus === 'paid').length;

    return { approvedCount, approvedHours, approvedAmount, costAmount, unpaidCount, includedCount, paidCount };
  }, [filteredTimesheets]);

  const selectedTimesheet = React.useMemo(
    () => filteredTimesheets.find((entry) => entry.timesheet.id === selectedTimesheetId) || null,
    [filteredTimesheets, selectedTimesheetId],
  );

  React.useEffect(() => {
    const validIds = new Set(enrichedTimesheets.filter((entry) => entry.selectableForPayrollActions).map((entry) => entry.timesheet.id));
    setSelectedIds((current) => current.filter((id) => validIds.has(id)));
  }, [enrichedTimesheets]);

  React.useEffect(() => {
    if (!filteredTimesheets.length) {
      setSelectedTimesheetId(null);
      return;
    }

    if (!selectedTimesheetId || !filteredTimesheets.some((entry) => entry.timesheet.id === selectedTimesheetId)) {
      setSelectedTimesheetId(filteredTimesheets[0].timesheet.id);
    }
  }, [filteredTimesheets, selectedTimesheetId]);

  const setGroupCollapsed = React.useCallback((groupKey: string) => {
    setCollapsedGroupKeys((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  }, []);

  const toggleSelectedId = React.useCallback((timesheetId: number, checked: boolean) => {
    setSelectedIds((current) => {
      if (checked) {
        return current.includes(timesheetId) ? current : [...current, timesheetId];
      }
      return current.filter((id) => id !== timesheetId);
    });
  }, []);

  const buildExportRows = React.useCallback((groups: GroupedPayrollTimesheets[]) => {
    return [
      [
        'Site',
        'Period',
        'Guard',
        'Shift Date',
        'Scheduled',
        'Attendance',
        'Hourly Rate',
        'Approved Hours',
        'Approved Amount',
        'Cost Amount',
        'Payroll Status',
        'Payroll Included At',
        'Payroll Paid At',
        'Company Note',
      ],
      ...groups.flatMap((group) => [
        ...group.rows.map((entry) => [
          group.siteName,
          group.periodLabel,
          entry.guardName,
          entry.shiftDateLabel,
          entry.scheduledLabel,
          entry.attendanceLabel,
          entry.hourlyRate !== null ? formatCurrency(entry.hourlyRate) : 'Rate unavailable',
          entry.approvedHours.toFixed(2),
          entry.approvedAmount !== null ? formatCurrency(entry.approvedAmount) : 'Rate unavailable',
          entry.costAmount !== null ? formatCurrency(entry.costAmount) : 'Rate unavailable',
          formatPayrollStatusLabel(entry.payrollStatus),
          entry.timesheet.payrollIncludedAt ? entry.payrollIncludedAtLabel : '',
          entry.timesheet.payrollPaidAt ? entry.payrollPaidAtLabel : '',
          entry.timesheet.companyNote || '',
        ]),
        [
          group.siteName,
          group.periodLabel,
          'SUMMARY',
          '',
          '',
          '',
          `${group.totals.missingRateCount} rate unavailable`,
          group.totals.approvedHours.toFixed(2),
          formatCurrency(group.totals.approvedAmount),
          formatCurrency(group.totals.costAmount),
          `Unpaid ${group.totals.unpaidCount} | Included ${group.totals.includedCount} | Paid ${group.totals.paidCount}`,
          '',
          '',
          `Approved ${group.totals.count}`,
        ],
      ]),
    ];
  }, []);

  const handleExportFiltered = React.useCallback(() => {
    const rows = buildExportRows(groupedTimesheets);
    const didDownload = downloadCsv(
      `payroll-filtered-${sanitizeFilenamePart(payrollStatusFilter)}-${sanitizeFilenamePart(periodView)}-${getDownloadTimestamp()}.csv`,
      rows,
    );
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Payroll export ready', message: `Exported ${filteredTimesheets.length} payroll records.` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows, filteredTimesheets.length, groupedTimesheets, payrollStatusFilter, periodView]);

  const handleExportGroup = React.useCallback((group: GroupedPayrollTimesheets) => {
    const rows = buildExportRows([group]);
    const safeSiteName = sanitizeFilenamePart(group.siteName);
    const safePeriodKey = sanitizeFilenamePart(group.periodKey);
    const didDownload = downloadCsv(
      `payroll-group-${safeSiteName}-${safePeriodKey}-${getDownloadTimestamp()}.csv`,
      rows,
    );
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Group export ready', message: `Exported ${group.totals.count} payroll records for ${group.siteName} (${group.periodLabel}).` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows]);

  const handleExportSelected = React.useCallback(() => {
    if (!selectedTimesheets.length) {
      setFeedback({ tone: 'info', title: 'No selection', message: 'Select one or more payroll rows before exporting selected records.' });
      return;
    }

    const rows = buildExportRows(selectedGroupedTimesheets);
    const didDownload = downloadCsv(
      `payroll-selected-${sanitizeFilenamePart(payrollStatusFilter)}-${sanitizeFilenamePart(periodView)}-${getDownloadTimestamp()}.csv`,
      rows,
    );
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Selected export ready', message: `Exported ${selectedTimesheets.length} selected payroll records.` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows, payrollStatusFilter, periodView, selectedGroupedTimesheets, selectedTimesheets]);

  const runBulkPayrollAction = React.useCallback(
    async (nextStatus: TimesheetPayrollStatus) => {
      if (!selectedIds.length) {
        setFeedback({ tone: 'info', title: 'No selection', message: 'Select one or more unbatched payroll rows first.' });
        return;
      }

      try {
        setBusyAction(nextStatus);
        await updateCompanyTimesheetPayroll({
          ids: selectedIds,
          payrollStatus: nextStatus,
        });
        await onRefresh();
        setSelectedIds([]);
        setFeedback({
          tone: 'success',
          title: 'Payroll updated',
          message:
            nextStatus === 'paid'
              ? `Marked ${selectedIds.length} payroll records as paid.`
              : nextStatus === 'included'
                ? `Marked ${selectedIds.length} payroll records as included in payroll.`
                : `Moved ${selectedIds.length} payroll records back to unpaid.`,
        });
      } catch (error) {
        setFeedback({
          tone: 'error',
          title: 'Payroll update failed',
          message: formatApiErrorMessage(error, 'Unable to update payroll status for the selected records.'),
        });
      } finally {
        setBusyAction(null);
      }
    },
    [onRefresh, selectedIds],
  );

  const handleCreateBatch = React.useCallback(async () => {
    if (!selectedIds.length) {
      setFeedback({ tone: 'info', title: 'No selection', message: 'Select approved payroll rows before creating a batch.' });
      return;
    }

    if (!batchPeriodStart || !batchPeriodEnd) {
      setFeedback({ tone: 'error', title: 'Batch period required', message: 'Enter a period start and end before creating a payroll batch.' });
      return;
    }

    try {
      setBusyAction('batch');
      const batch = await createCompanyPayrollBatch({
        periodStart: batchPeriodStart,
        periodEnd: batchPeriodEnd,
        notes: batchNotes.trim() || null,
        timesheetIds: selectedIds,
      });
      await onRefresh();
      setSelectedIds([]);
      setBatchPeriodStart('');
      setBatchPeriodEnd('');
      setBatchNotes('');
      setFeedback({
        tone: 'success',
        title: 'Payroll batch created',
        message: `Created payroll batch #${batch.id} with ${batch.totals.recordsCount} records. Open Payroll Batches to finalise or pay it.`,
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        title: 'Batch creation failed',
        message: formatApiErrorMessage(error, 'Unable to create a payroll batch from the selected rows.'),
      });
    } finally {
      setBusyAction(null);
    }
  }, [batchNotes, batchPeriodEnd, batchPeriodStart, onRefresh, selectedIds]);

  const activeSelected = selectedTimesheet?.timesheet;
  const selectedApprovedHours = selectedTimesheet?.approvedHours ?? null;
  const selectedHourlyRate = selectedTimesheet?.hourlyRate ?? null;
  const selectedApprovedAmount = selectedTimesheet?.approvedAmount ?? null;
  const selectedCostAmount = selectedTimesheet?.costAmount ?? null;
  const selectedPayrollStatus = selectedTimesheet?.payrollStatus ?? 'unpaid';
  const selectedBatchState = selectedTimesheet?.batchStateLabel ?? 'Unbatched';

  const emptyStateMessage =
    timesheets.some((timesheet) => normalizeApprovalStatus(timesheet.approvalStatus) === 'approved')
      ? 'No approved payroll records match the current filters.'
      : 'No approved timesheets yet. Approved records will appear here for payroll processing.';

  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Payroll</Text>
          <Text style={styles.subtitle}>Approved hours, payroll lifecycle, and batch preparation.</Text>
        </View>
        <View style={styles.headerActions}>
          <PeriodToggle value={periodView} onChange={setPeriodView} />
          <Pressable style={styles.secondaryButton} onPress={() => onRefresh()} disabled={refreshing || Boolean(busyAction)}>
            <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={handleExportFiltered}>
            <Text style={styles.primaryButtonText}>Export payroll view</Text>
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

      <View style={styles.filterCard}>
        <View style={styles.filterRow}>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>Site</Text>
            <WebSelect value={siteFilter} onChange={setSiteFilter} options={siteOptions} placeholder="All sites" />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>Guard</Text>
            <WebSelect value={guardFilter} onChange={setGuardFilter} options={guardOptions} placeholder="All guards" />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>Payroll status</Text>
            <WebSelect
              value={payrollStatusFilter}
              onChange={(value) => setPayrollStatusFilter((value || 'all') as PayrollFilter)}
              options={[
                { label: 'Unpaid', value: 'unpaid' },
                { label: 'Included', value: 'included' },
                { label: 'Paid', value: 'paid' },
                { label: 'All payroll statuses', value: 'all' },
              ]}
              placeholder="All payroll statuses"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>From</Text>
            <TextInput value={startDate} onChangeText={setStartDate} style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor="#64748b" />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>To</Text>
            <TextInput value={endDate} onChangeText={setEndDate} style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor="#64748b" />
          </View>
          <View style={[styles.filterField, styles.searchField]}>
            <Text style={styles.filterLabel}>Search</Text>
            <TextInput
              value={searchTerm}
              onChangeText={setSearchTerm}
              style={styles.input}
              placeholder="Guard, site, note, batch"
              placeholderTextColor="#64748b"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>View type</Text>
            <PeriodToggle value={periodView} onChange={setPeriodView} />
          </View>
        </View>
      </View>

      <View style={styles.bulkCard}>
        <Text style={styles.bulkTitle}>Payroll controls</Text>
        <View style={styles.bulkActions}>
          <Pressable style={[styles.inlineAction, !selectedIds.length && styles.disabledAction]} onPress={handleExportSelected} disabled={!selectedIds.length || Boolean(busyAction)}>
            <Text style={styles.inlineActionText}>Export selected</Text>
          </Pressable>
          <Pressable style={[styles.inlineAction, !selectedIds.length && styles.disabledAction]} onPress={() => runBulkPayrollAction('unpaid')} disabled={!selectedIds.length || Boolean(busyAction)}>
            <Text style={styles.inlineActionText}>{busyAction === 'unpaid' ? 'Updating...' : 'Mark unpaid'}</Text>
          </Pressable>
          <Pressable style={[styles.inlineAction, !selectedIds.length && styles.disabledAction]} onPress={() => runBulkPayrollAction('included')} disabled={!selectedIds.length || Boolean(busyAction)}>
            <Text style={styles.inlineActionText}>{busyAction === 'included' ? 'Updating...' : 'Mark included'}</Text>
          </Pressable>
          <Pressable style={[styles.primaryButton, !selectedIds.length && styles.disabledPrimaryButton]} onPress={() => runBulkPayrollAction('paid')} disabled={!selectedIds.length || Boolean(busyAction)}>
            <Text style={styles.primaryButtonText}>{busyAction === 'paid' ? 'Updating...' : 'Mark paid'}</Text>
          </Pressable>
        </View>

        <View style={styles.batchBuilder}>
          <Text style={styles.batchBuilderTitle}>Create Payroll Batch</Text>
          <Text style={styles.batchBuilderCopy}>Use selected approved rows to open a new draft batch. Batch lifecycle is managed separately in Payroll Batches.</Text>
          <View style={styles.batchBuilderRow}>
            <TextInput value={batchPeriodStart} onChangeText={setBatchPeriodStart} style={styles.input} placeholder="Period start YYYY-MM-DD" placeholderTextColor="#64748b" />
            <TextInput value={batchPeriodEnd} onChangeText={setBatchPeriodEnd} style={styles.input} placeholder="Period end YYYY-MM-DD" placeholderTextColor="#64748b" />
          </View>
          <TextInput
            value={batchNotes}
            onChangeText={setBatchNotes}
            style={[styles.input, styles.noteInput]}
            placeholder="Optional pay-run notes"
            placeholderTextColor="#64748b"
            multiline
            textAlignVertical="top"
          />
          <Pressable style={[styles.primaryButton, !selectedIds.length && styles.disabledPrimaryButton]} onPress={handleCreateBatch} disabled={!selectedIds.length || Boolean(busyAction)}>
            <Text style={styles.primaryButtonText}>{busyAction === 'batch' ? 'Creating batch...' : 'Create Payroll Batch'}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <SummaryCard label="Approved Records" value={String(summary.approvedCount)} />
        <SummaryCard label="Approved Hours" value={`${summary.approvedHours.toFixed(2)} h`} />
        <SummaryCard label="Approved Amount" value={formatCurrency(summary.approvedAmount)} />
        <SummaryCard label="Total Cost" value={formatCurrency(summary.costAmount)} />
        <SummaryCard label="Unpaid / Included / Paid" value={`${summary.unpaidCount} / ${summary.includedCount} / ${summary.paidCount}`} />
      </View>

      <View style={styles.reviewLayout}>
        <View style={styles.reviewListCard}>
          {groupedTimesheets.length === 0 ? <Text style={styles.emptyText}>{emptyStateMessage}</Text> : null}
          {groupedTimesheets.map((group) => {
            const isCollapsed = Boolean(collapsedGroupKeys[group.key]);

            return (
              <View key={group.key} style={styles.groupCard}>
                <Pressable style={styles.groupHeader} onPress={() => setGroupCollapsed(group.key)}>
                  <View style={styles.groupHeaderCopy}>
                    <Text style={styles.groupSite}>{group.siteName}</Text>
                    <Text style={styles.groupPeriod}>
                      {group.periodLabel} | {group.totals.count} approved | {group.totals.approvedHours.toFixed(2)} approved h | {formatCurrency(group.totals.costAmount)} cost
                    </Text>
                  </View>
                  <View style={styles.groupHeaderActions}>
                    <Pressable style={styles.inlineAction} onPress={() => handleExportGroup(group)}>
                      <Text style={styles.inlineActionText}>Export payroll group</Text>
                    </Pressable>
                    <Text style={styles.groupToggle}>{isCollapsed ? 'Expand' : 'Collapse'}</Text>
                  </View>
                </Pressable>

                {!isCollapsed ? (
                  <>
                    <View style={styles.rowsHeader}>
                      <Text style={[styles.rowsHeaderText, styles.checkboxCol]}>Select</Text>
                      <Text style={[styles.rowsHeaderText, styles.guardCol]}>Guard</Text>
                      <Text style={[styles.rowsHeaderText, styles.dateCol]}>Shift Date</Text>
                      <Text style={[styles.rowsHeaderText, styles.hoursCol]}>Approved Hours</Text>
                      <Text style={[styles.rowsHeaderText, styles.rateCol]}>Rate</Text>
                      <Text style={[styles.rowsHeaderText, styles.amountCol]}>Approved Amount</Text>
                      <Text style={[styles.rowsHeaderText, styles.amountCol]}>Cost</Text>
                      <Text style={[styles.rowsHeaderText, styles.payrollCol]}>Payroll</Text>
                      <Text style={[styles.rowsHeaderText, styles.batchCol]}>Batch</Text>
                      <Text style={[styles.rowsHeaderText, styles.statusCol]}>Review</Text>
                    </View>

                    {group.rows.map((entry) => {
                      const approvedStatusPalette = getApprovedStatusPalette();
                      const payrollPalette = getPayrollStatusPalette(entry.payrollStatus);
                      const batchPalette = getBatchStatePalette(entry.batchStateTone);
                      const isSelectedRow = entry.timesheet.id === selectedTimesheetId;
                      const isChecked = selectedIds.includes(entry.timesheet.id);

                      return (
                        <Pressable
                          key={entry.timesheet.id}
                          style={[styles.timesheetRow, isSelectedRow && styles.timesheetRowSelected]}
                          onPress={() => setSelectedTimesheetId(entry.timesheet.id)}
                        >
                          <View style={styles.checkboxCol}>
                            {entry.selectableForBatchCreation ? (
                              <WebCheckbox checked={isChecked} onChange={(checked) => toggleSelectedId(entry.timesheet.id, checked)} />
                            ) : (
                              <Text style={styles.disabledSelectText}>Locked</Text>
                            )}
                          </View>
                          <Text style={[styles.rowTextStrong, styles.guardCol]}>{entry.guardName}</Text>
                          <Text style={[styles.rowText, styles.dateCol]}>{entry.shiftDateLabel}</Text>
                          <Text style={[styles.rowText, styles.hoursCol]}>{entry.approvedHours.toFixed(2)}</Text>
                          <Text style={[styles.rowText, styles.rateCol]}>{formatRate(entry.hourlyRate)}</Text>
                          <Text style={[styles.rowText, styles.amountCol]}>{entry.approvedAmount !== null ? formatCurrency(entry.approvedAmount) : 'Rate unavailable'}</Text>
                          <Text style={[styles.rowText, styles.amountCol]}>{entry.costAmount !== null ? formatCurrency(entry.costAmount) : 'Rate unavailable'}</Text>
                          <View style={[styles.statusBadge, styles.payrollCol, { backgroundColor: payrollPalette.bg }]}>
                            <Text style={[styles.statusBadgeText, { color: payrollPalette.text }]}>{formatPayrollStatusLabel(entry.payrollStatus)}</Text>
                          </View>
                          <View style={[styles.statusBadge, styles.batchCol, { backgroundColor: batchPalette.bg }]}>
                            <Text style={[styles.statusBadgeText, { color: batchPalette.text }]}>{entry.batchStateLabel}</Text>
                          </View>
                          <View style={[styles.statusBadge, styles.statusCol, { backgroundColor: approvedStatusPalette.bg }]}>
                            <Text style={[styles.statusBadgeText, { color: approvedStatusPalette.text }]}>Approved</Text>
                          </View>
                        </Pressable>
                      );
                    })}

                    <View style={styles.groupFooter}>
                      <Text style={styles.groupFooterText}>Approved records: {group.totals.count}</Text>
                      <Text style={styles.groupFooterText}>Approved hours: {group.totals.approvedHours.toFixed(2)} h</Text>
                      <Text style={styles.groupFooterText}>Approved amount: {formatCurrency(group.totals.approvedAmount)}</Text>
                      <Text style={styles.groupFooterText}>Total cost: {formatCurrency(group.totals.costAmount)}</Text>
                      <Text style={styles.groupFooterText}>Unpaid: {group.totals.unpaidCount}</Text>
                      <Text style={styles.groupFooterText}>Included: {group.totals.includedCount}</Text>
                      <Text style={styles.groupFooterText}>Paid: {group.totals.paidCount}</Text>
                    </View>
                  </>
                ) : null}
              </View>
            );
          })}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailTitle}>Payroll detail</Text>
          <Text style={styles.detailSubtitle}>Select an approved row to review payroll metadata and batch state.</Text>

          {activeSelected ? (
            <>
              <View style={styles.detailMetaGrid}>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Guard</Text>
                  <Text style={styles.detailMetaValue}>{selectedTimesheet?.guardName}</Text>
                </View>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Site</Text>
                  <Text style={styles.detailMetaValue}>{selectedTimesheet?.siteName}</Text>
                </View>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Shift date</Text>
                  <Text style={styles.detailMetaValue}>{selectedTimesheet?.shiftDateLabel}</Text>
                </View>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Batch state</Text>
                  <View style={[styles.detailStatusBadge, { backgroundColor: getBatchStatePalette(selectedTimesheet?.batchStateTone || 'neutral').bg }]}>
                    <Text style={[styles.detailStatusBadgeText, { color: getBatchStatePalette(selectedTimesheet?.batchStateTone || 'neutral').text }]}>
                      {selectedBatchState}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Attendance & hours</Text>
                <Text style={styles.detailLine}>
                  Scheduled: {formatDateTimeLabel(activeSelected.scheduledStartAt || activeSelected.shift?.start)} - {formatTimeLabel(activeSelected.scheduledEndAt || activeSelected.shift?.end)}
                </Text>
                <Text style={styles.detailLine}>Check-in: {formatDateTimeLabel(activeSelected.actualCheckInAt)}</Text>
                <Text style={styles.detailLine}>Check-out: {formatDateTimeLabel(activeSelected.actualCheckOutAt)}</Text>
                <Text style={styles.detailLine}>Approved hours: {selectedApprovedHours !== null ? selectedApprovedHours.toFixed(2) : '0.00'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Rate & amounts</Text>
                <Text style={styles.detailLine}>Hourly rate: {formatRate(selectedHourlyRate)}</Text>
                <Text style={styles.detailLine}>Approved amount: {selectedApprovedAmount !== null ? formatCurrency(selectedApprovedAmount) : 'Rate unavailable'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Financial Breakdown</Text>
                <Text style={styles.detailLine}>Cost (guard pay): {selectedCostAmount !== null ? formatCurrency(selectedCostAmount) : 'Rate unavailable'}</Text>
                <Text style={styles.detailLine}>Revenue (client charge): {activeSelected.revenueAmount !== null && activeSelected.revenueAmount !== undefined ? formatCurrency(activeSelected.revenueAmount) : 'Rate unavailable'}</Text>
                <Text style={styles.detailLine}>Profit: {activeSelected.marginAmount !== null && activeSelected.marginAmount !== undefined ? formatCurrency(activeSelected.marginAmount) : 'Rate unavailable'}</Text>
                <Text style={styles.detailLine}>Margin: {activeSelected.marginPercent !== null && activeSelected.marginPercent !== undefined ? `${activeSelected.marginPercent.toFixed(2)}%` : 'Unavailable'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Payroll metadata</Text>
                <Text style={styles.detailLine}>Payroll status: {formatPayrollStatusLabel(selectedPayrollStatus)}</Text>
                <Text style={styles.detailLine}>Included in payroll: {activeSelected.payrollIncludedAt ? formatDateTimeLabel(activeSelected.payrollIncludedAt) : 'Not included yet'}</Text>
                <Text style={styles.detailLine}>Paid at: {activeSelected.payrollPaidAt ? formatDateTimeLabel(activeSelected.payrollPaidAt) : 'Not paid yet'}</Text>
                <Text style={styles.detailLine}>Batch: {selectedBatchState}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Guard note</Text>
                <Text style={styles.detailParagraph}>{activeSelected.guardNote?.trim() ? activeSelected.guardNote : 'No guard note provided.'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Company note</Text>
                <Text style={styles.detailParagraph}>{activeSelected.companyNote?.trim() ? activeSelected.companyNote : 'No company note provided.'}</Text>
              </View>
            </>
          ) : (
            <Text style={styles.emptyText}>Select an approved timesheet to review payroll detail.</Text>
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
  segmentedControl: { flexDirection: 'row', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 14, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  segmentedOption: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#FFFFFF' },
  segmentedOptionActive: { backgroundColor: '#0f172a' },
  segmentedOptionText: { color: '#334155', fontWeight: '700' },
  segmentedOptionTextActive: { color: '#F8FAFC' },
  feedbackCard: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackInfo: { backgroundColor: '#DBEAFE' },
  feedbackTitle: { color: '#0f172a', fontWeight: '800', fontSize: 15 },
  feedbackText: { color: '#334155', fontSize: 13, lineHeight: 18 },
  filterCard: { backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 12 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  filterField: { minWidth: 150, flexGrow: 1, gap: 6 },
  searchField: { minWidth: 220, flexGrow: 1.4 },
  filterLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: '#d6dce5', backgroundColor: '#ffffff', paddingHorizontal: 14, paddingVertical: 12, color: '#132238', minWidth: 180 },
  webSelect: { borderRadius: 14, borderWidth: 1, borderColor: '#d6dce5', backgroundColor: '#ffffff', padding: '14px 16px', fontSize: 14, color: '#132238', minHeight: 48 },
  bulkCard: { backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14 },
  bulkTitle: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  bulkActions: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  inlineAction: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#E2E8F0' },
  inlineActionText: { color: '#0f172a', fontWeight: '700', fontSize: 12 },
  disabledAction: { opacity: 0.45 },
  disabledPrimaryButton: { opacity: 0.45 },
  batchBuilder: { gap: 10, borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 14 },
  batchBuilderTitle: { color: '#0f172a', fontSize: 16, fontWeight: '800' },
  batchBuilderCopy: { color: '#64748b', fontSize: 13, lineHeight: 18 },
  batchBuilderRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  noteInput: { minHeight: 88, textAlignVertical: 'top' },
  webCheckbox: { width: 16, height: 16 },
  nativeCheckboxWrap: { justifyContent: 'center', alignItems: 'center' },
  nativeCheckbox: { width: 16, height: 16, borderWidth: 1, borderColor: '#64748b', borderRadius: 4, backgroundColor: '#FFFFFF' },
  nativeCheckboxChecked: { backgroundColor: '#0f172a', borderColor: '#0f172a' },
  summaryGrid: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  summaryCard: { flexGrow: 1, minWidth: 180, backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, gap: 8 },
  summaryLabel: { color: '#64748b', fontSize: 13, fontWeight: '700' },
  summaryValue: { color: '#0f172a', fontSize: 28, fontWeight: '800' },
  reviewLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  reviewListCard: { flex: 2.2, minWidth: 880, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14 },
  detailCard: { flex: 1, minWidth: 340, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14, borderWidth: 1, borderColor: '#DBEAFE' },
  detailTitle: { color: '#0f172a', fontSize: 20, fontWeight: '800' },
  detailSubtitle: { color: '#64748b', fontSize: 13, lineHeight: 18 },
  groupCard: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, overflow: 'hidden' },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#F8FAFC' },
  groupHeaderCopy: { flex: 1, gap: 4 },
  groupSite: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  groupPeriod: { color: '#475569', fontSize: 13 },
  groupHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  groupToggle: { color: '#1D4ED8', fontWeight: '700', fontSize: 12 },
  rowsHeader: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#E2E8F0', borderBottomWidth: 1, borderBottomColor: '#E2E8F0', backgroundColor: '#FFFFFF' },
  rowsHeaderText: { color: '#64748b', fontWeight: '700', fontSize: 12, textTransform: 'uppercase' },
  timesheetRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  timesheetRowSelected: { backgroundColor: '#EFF6FF' },
  rowText: { color: '#334155', fontSize: 13 },
  rowTextStrong: { color: '#0f172a', fontSize: 13, fontWeight: '700' },
  disabledSelectText: { color: '#94A3B8', fontSize: 11, fontWeight: '700' },
  checkboxCol: { width: 54, justifyContent: 'center', alignItems: 'center' },
  guardCol: { flex: 1.2 },
  dateCol: { flex: 0.9 },
  hoursCol: { flex: 0.8 },
  rateCol: { flex: 1 },
  amountCol: { flex: 1 },
  payrollCol: { flex: 0.9 },
  batchCol: { flex: 1.3 },
  statusCol: { flex: 0.85 },
  statusBadge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  statusBadgeText: { fontWeight: '800', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  groupFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#F8FAFC' },
  groupFooterText: { color: '#475569', fontSize: 13, fontWeight: '700' },
  detailMetaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailMetaItem: { minWidth: 140, flexGrow: 1, gap: 4 },
  detailMetaLabel: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  detailMetaValue: { color: '#0f172a', fontSize: 15, fontWeight: '700' },
  detailStatusBadge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  detailStatusBadgeText: { fontWeight: '800', fontSize: 11, textTransform: 'uppercase' },
  detailSection: { gap: 8, borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 14 },
  detailSectionTitle: { color: '#0f172a', fontSize: 15, fontWeight: '800' },
  detailLine: { color: '#334155', fontSize: 13, lineHeight: 18 },
  detailParagraph: { color: '#334155', fontSize: 13, lineHeight: 20 },
  emptyText: { color: '#64748b', fontSize: 14, lineHeight: 20 },
});
