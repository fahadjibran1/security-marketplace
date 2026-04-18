import * as React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage, updateTimesheet } from '../../services/api';
import { Timesheet } from '../../types/models';

type WorkspaceFeedback = {
  tone: 'success' | 'error' | 'info';
  title: string;
  message: string;
} | null;

type PeriodView = 'week' | 'month';

type CompanyTimesheetsWorkspaceProps = {
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

type EnrichedTimesheet = {
  timesheet: Timesheet;
  siteId: string;
  siteName: string;
  guardId: string;
  guardName: string;
  displayStatus: string;
  searchText: string;
  shiftDate: Date;
  shiftDateLabel: string;
  scheduledLabel: string;
  attendanceLabel: string;
};

type GroupedTimesheets = {
  key: string;
  siteName: string;
  periodKey: string;
  periodLabel: string;
  rows: EnrichedTimesheet[];
  totals: {
    count: number;
    claimedHours: number;
    approvedHours: number;
    pendingCount: number;
    approvedCount: number;
  };
};

const UK_LOCALE = 'en-GB';

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

function normalizeStatus(value?: string | null) {
  return (value || '').trim().toLowerCase();
}

function getDisplayStatus(timesheet: Timesheet) {
  return normalizeStatus(timesheet.approvalStatus) || 'unknown';
}

function formatStatusLabel(value?: string | null) {
  switch (normalizeStatus(value)) {
    case 'draft':
      return 'Draft';
    case 'submitted':
      return 'Submitted';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'returned':
      return 'Returned';
    default:
      return value
        ? value.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase())
        : 'Unknown';
  }
}

function getStatusPalette(status: string) {
  switch (normalizeStatus(status)) {
    case 'approved':
      return { bg: '#DCFCE7', text: '#166534' };
    case 'submitted':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'returned':
      return { bg: '#FEF3C7', text: '#B45309' };
    case 'rejected':
      return { bg: '#FEE2E2', text: '#B91C1C' };
    case 'draft':
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

function formatHoursInput(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return '';
  }

  const normalized = roundHours(Number(value));
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(2);
}

function parseHoursInput(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? roundHours(parsed) : Number.NaN;
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

export function CompanyTimesheetsWorkspace({
  timesheets,
  refreshing,
  onRefresh,
}: CompanyTimesheetsWorkspaceProps) {
  const [siteFilter, setSiteFilter] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('submitted');
  const [guardFilter, setGuardFilter] = React.useState('');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [periodView, setPeriodView] = React.useState<PeriodView>('week');
  const [feedback, setFeedback] = React.useState<WorkspaceFeedback>(null);
  const [selectedTimesheetId, setSelectedTimesheetId] = React.useState<number | null>(null);
  const [companyNote, setCompanyNote] = React.useState('');
  const [approvedHoursInput, setApprovedHoursInput] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = React.useState<Record<string, boolean>>({});

  const enrichedTimesheets = React.useMemo<EnrichedTimesheet[]>(() => {
    return timesheets
      .map((timesheet) => {
        const siteId = String(timesheet.shift?.site?.id ?? timesheet.shift?.siteId ?? timesheet.shiftId ?? 'unknown');
        const siteName = timesheet.shift?.site?.name || timesheet.shift?.siteName || `Site ${siteId}`;
        const guardId = String(timesheet.guard?.id ?? timesheet.guardId ?? 'unknown');
        const guardName = timesheet.guard?.fullName || `Guard #${guardId}`;
        const shiftDate =
          parseDateValue(timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt) || new Date();
        const scheduledStart = timesheet.scheduledStartAt || timesheet.shift?.start || null;
        const scheduledEnd = timesheet.scheduledEndAt || timesheet.shift?.end || null;
        const displayStatus = getDisplayStatus(timesheet);

        return {
          timesheet,
          siteId,
          siteName,
          guardId,
          guardName,
          displayStatus,
          searchText: [
            siteName,
            guardName,
            timesheet.id,
            timesheet.shiftId,
            timesheet.guardNote || '',
            timesheet.companyNote || '',
          ]
            .join(' ')
            .toLowerCase(),
          shiftDate,
          shiftDateLabel: formatDateLabel(scheduledStart || timesheet.createdAt),
          scheduledLabel: `${formatTimeLabel(scheduledStart)} - ${formatTimeLabel(scheduledEnd)}`,
          attendanceLabel: `${formatTimeLabel(timesheet.actualCheckInAt)} / ${formatTimeLabel(timesheet.actualCheckOutAt)}`,
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
      if (statusFilter !== 'all' && statusFilter && normalizeStatus(entry.displayStatus) !== normalizeStatus(statusFilter)) return false;

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
  }, [enrichedTimesheets, endDate, guardFilter, searchTerm, siteFilter, startDate, statusFilter]);

  const groupedTimesheets = React.useMemo<GroupedTimesheets[]>(() => {
    const groups = new Map<string, GroupedTimesheets>();

    filteredTimesheets.forEach((entry) => {
      const periodKey = getPeriodKey(entry.shiftDate, periodView);
      const periodLabel = getPeriodLabel(entry.shiftDate, periodView);
      const groupKey = `${entry.siteName}__${periodKey}`;
      const existing =
        groups.get(groupKey) ||
        {
          key: groupKey,
          siteName: entry.siteName,
          periodKey,
          periodLabel,
          rows: [],
          totals: { count: 0, claimedHours: 0, approvedHours: 0, pendingCount: 0, approvedCount: 0 },
        };

      existing.rows.push(entry);
      existing.totals.count += 1;
      existing.totals.claimedHours += toHours(entry.timesheet.hoursWorked);
      if (normalizeStatus(entry.displayStatus) === 'approved') {
        existing.totals.approvedHours += toHours(entry.timesheet.approvedHours ?? entry.timesheet.hoursWorked);
        existing.totals.approvedCount += 1;
      }
      if (normalizeStatus(entry.displayStatus) === 'submitted') {
        existing.totals.pendingCount += 1;
      }

      groups.set(groupKey, existing);
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        rows: group.rows.sort((left, right) => right.shiftDate.getTime() - left.shiftDate.getTime()),
        totals: {
          ...group.totals,
          claimedHours: roundHours(group.totals.claimedHours),
          approvedHours: roundHours(group.totals.approvedHours),
        },
      }))
      .sort((left, right) => {
        if (left.siteName !== right.siteName) return left.siteName.localeCompare(right.siteName);
        return right.rows[0].shiftDate.getTime() - left.rows[0].shiftDate.getTime();
      });
  }, [filteredTimesheets, periodView]);

  const summary = React.useMemo(() => {
    const submitted = filteredTimesheets.filter((entry) => normalizeStatus(entry.displayStatus) === 'submitted').length;
    const approved = filteredTimesheets.filter((entry) => normalizeStatus(entry.displayStatus) === 'approved').length;
    const returnedOrRejected = filteredTimesheets.filter((entry) => {
      const status = normalizeStatus(entry.displayStatus);
      return status === 'returned' || status === 'rejected';
    }).length;
    const totalHours = roundHours(filteredTimesheets.reduce((sum, entry) => sum + toHours(entry.timesheet.hoursWorked), 0));

    return { submitted, approved, returnedOrRejected, totalHours };
  }, [filteredTimesheets]);

  const selectedTimesheet = React.useMemo(
    () => filteredTimesheets.find((entry) => entry.timesheet.id === selectedTimesheetId) || null,
    [filteredTimesheets, selectedTimesheetId],
  );

  React.useEffect(() => {
    if (!filteredTimesheets.length) {
      setSelectedTimesheetId(null);
      return;
    }

    if (!selectedTimesheetId || !filteredTimesheets.some((entry) => entry.timesheet.id === selectedTimesheetId)) {
      setSelectedTimesheetId(filteredTimesheets[0].timesheet.id);
    }
  }, [filteredTimesheets, selectedTimesheetId]);

  React.useEffect(() => {
    setCompanyNote(selectedTimesheet?.timesheet.companyNote || '');
  }, [selectedTimesheet?.timesheet.id, selectedTimesheet?.timesheet.companyNote, selectedTimesheet?.timesheet.updatedAt]);

  React.useEffect(() => {
    if (!selectedTimesheet) {
      setApprovedHoursInput('');
      return;
    }

    const currentApprovedHours =
      selectedTimesheet.timesheet.approvedHours ?? selectedTimesheet.timesheet.hoursWorked;
    setApprovedHoursInput(formatHoursInput(currentApprovedHours));
  }, [
    selectedTimesheet?.timesheet.id,
    selectedTimesheet?.timesheet.approvedHours,
    selectedTimesheet?.timesheet.hoursWorked,
    selectedTimesheet?.timesheet.updatedAt,
  ]);

  const setGroupCollapsed = React.useCallback((groupKey: string) => {
    setCollapsedGroupKeys((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  }, []);

  const buildExportRows = React.useCallback((groups: GroupedTimesheets[]) => {
    return [
      ['Site', 'Period', 'Guard', 'Shift Date', 'Scheduled', 'Attendance', 'Claimed Hours', 'Approved Hours', 'Status', 'Company Note'],
      ...groups.flatMap((group) =>
        [
          ...group.rows.map((entry) => [
            group.siteName,
            group.periodLabel,
            entry.guardName,
            entry.shiftDateLabel,
            entry.scheduledLabel,
            entry.attendanceLabel,
            toHours(entry.timesheet.hoursWorked).toFixed(2),
            entry.timesheet.approvedHours != null
              ? toHours(entry.timesheet.approvedHours).toFixed(2)
              : normalizeStatus(entry.displayStatus) === 'approved'
                ? toHours(entry.timesheet.hoursWorked).toFixed(2)
                : '',
            formatStatusLabel(entry.displayStatus),
            entry.timesheet.companyNote || '',
          ]),
          [
            group.siteName,
            group.periodLabel,
            'SUMMARY',
            '',
            '',
            '',
            group.totals.claimedHours.toFixed(2),
            group.totals.approvedHours.toFixed(2),
            `Pending ${group.totals.pendingCount} | Approved ${group.totals.approvedCount}`,
            `Timesheets ${group.totals.count}`,
          ],
        ],
      ),
    ];
  }, []);

  const handleExportFiltered = React.useCallback(() => {
    const rows = buildExportRows(groupedTimesheets);
    const didDownload = downloadCsv(
      `timesheets-filtered-${sanitizeFilenamePart(periodView)}-${getDownloadTimestamp()}.csv`,
      rows,
    );
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Export ready', message: `Exported ${filteredTimesheets.length} filtered timesheets.` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows, filteredTimesheets.length, groupedTimesheets, periodView]);

  const handleExportGroup = React.useCallback((group: GroupedTimesheets) => {
    const rows = buildExportRows([group]);
    const safeSiteName = sanitizeFilenamePart(group.siteName);
    const safePeriodKey = sanitizeFilenamePart(group.periodKey);
    const didDownload = downloadCsv(
      `timesheets-group-${safeSiteName}-${safePeriodKey}-${getDownloadTimestamp()}.csv`,
      rows,
    );
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Group export ready', message: `Exported ${group.totals.count} timesheets for ${group.siteName} (${group.periodLabel}).` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows]);

  const handleExport = React.useCallback(() => {
    handleExportFiltered();
  }, [handleExportFiltered]);

  const runCompanyAction = React.useCallback(
    async (actionKey: string, timesheetId: number, payload: Parameters<typeof updateTimesheet>[1], successTitle: string, successMessage: string) => {
      try {
        setBusyAction(actionKey);
        await updateTimesheet(timesheetId, payload);
        await onRefresh();
        setFeedback({ tone: 'success', title: successTitle, message: successMessage });
      } catch (error) {
        setFeedback({
          tone: 'error',
          title: 'Review action failed',
          message: formatApiErrorMessage(error, 'Unable to update this timesheet.'),
        });
      } finally {
        setBusyAction(null);
      }
    },
    [onRefresh],
  );

  const buildApprovalPayload = React.useCallback(
    (mode: 'save' | 'approve') => {
      if (!selectedTimesheet) {
        return null;
      }

      const claimedHours = toHours(selectedTimesheet.timesheet.hoursWorked);
      const trimmedCompanyNote = companyNote.trim();
      const parsedApprovedHours = parseHoursInput(approvedHoursInput);
      const hasApprovedHoursValue = approvedHoursInput.trim().length > 0;
      const finalApprovedHours =
        mode === 'approve'
          ? hasApprovedHoursValue
            ? parsedApprovedHours
            : claimedHours
          : hasApprovedHoursValue
            ? parsedApprovedHours
            : undefined;

      if (finalApprovedHours != null && (!Number.isFinite(finalApprovedHours) || finalApprovedHours < 0)) {
        setFeedback({
          tone: 'error',
          title: 'Invalid approved hours',
          message: 'Approved hours must be 0 or more.',
        });
        return null;
      }

      if (
        finalApprovedHours != null &&
        Math.abs(finalApprovedHours - claimedHours) > 0.009 &&
        !trimmedCompanyNote
      ) {
        setFeedback({
          tone: 'error',
          title: 'Company note required',
          message: 'Add a company note when approved hours differ from claimed hours.',
        });
        return null;
      }

      return {
        companyNote: trimmedCompanyNote || null,
        approvedHours: finalApprovedHours,
      };
    },
    [approvedHoursInput, companyNote, selectedTimesheet],
  );

  const handleSaveCompanyNote = React.useCallback(async () => {
    if (!selectedTimesheet) return;
    const payload = buildApprovalPayload('save');
    if (!payload) return;
    await runCompanyAction(
      `note-${selectedTimesheet.timesheet.id}`,
      selectedTimesheet.timesheet.id,
      payload,
      'Review details saved',
      'The company note and approved hours were saved for this timesheet.',
    );
  }, [buildApprovalPayload, runCompanyAction, selectedTimesheet]);

  const handleApprove = React.useCallback(
    async (entry: EnrichedTimesheet) => {
      const payload =
        entry.timesheet.id === selectedTimesheet?.timesheet.id
          ? buildApprovalPayload('approve')
          : {
              approvedHours: entry.timesheet.approvedHours ?? entry.timesheet.hoursWorked,
              companyNote: entry.timesheet.companyNote ?? null,
            };
      if (!payload) return;

      await runCompanyAction(
        `approve-${entry.timesheet.id}`,
        entry.timesheet.id,
        { ...payload, approvalStatus: 'approved', rejectionReason: null },
        'Timesheet approved',
        'The claimed hours were approved for payroll and client sign-off.',
      );
    },
    [buildApprovalPayload, runCompanyAction, selectedTimesheet?.timesheet.id],
  );

  const handleReturn = React.useCallback(
    async (entry: EnrichedTimesheet) => {
      const noteSource =
        entry.timesheet.id === selectedTimesheet?.timesheet.id ? companyNote.trim() : '';
      const note = noteSource || entry.timesheet.rejectionReason?.trim() || 'Returned for correction by company reviewer.';
      await runCompanyAction(
        `return-${entry.timesheet.id}`,
        entry.timesheet.id,
        { approvalStatus: 'returned', rejectionReason: note },
        'Returned for correction',
        'The timesheet was returned to the guard for correction.',
      );
    },
    [companyNote, runCompanyAction, selectedTimesheet?.timesheet.id],
  );

  const handleReject = React.useCallback(
    async (entry: EnrichedTimesheet) => {
      const noteSource =
        entry.timesheet.id === selectedTimesheet?.timesheet.id ? companyNote.trim() : '';
      const note = noteSource || entry.timesheet.rejectionReason?.trim() || 'Rejected by company reviewer.';
      await runCompanyAction(
        `reject-${entry.timesheet.id}`,
        entry.timesheet.id,
        { approvalStatus: 'rejected', rejectionReason: note },
        'Timesheet rejected',
        'The timesheet was rejected and marked for follow-up.',
      );
    },
    [companyNote, runCompanyAction, selectedTimesheet?.timesheet.id],
  );

  const activeSelected = selectedTimesheet?.timesheet;
  const selectedClaimedHours = activeSelected ? toHours(activeSelected.hoursWorked) : 0;
  const parsedSelectedApprovedHours = parseHoursInput(approvedHoursInput);
  const hasSelectedApprovedHoursValue = approvedHoursInput.trim().length > 0;
  const adjustedHoursRequireNote =
    hasSelectedApprovedHoursValue &&
    parsedSelectedApprovedHours !== null &&
    Number.isFinite(parsedSelectedApprovedHours) &&
    Math.abs(parsedSelectedApprovedHours - selectedClaimedHours) > 0.009 &&
    !companyNote.trim();

  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Timesheets</Text>
          <Text style={styles.subtitle}>Review, approve, and organise submitted guard hours.</Text>
        </View>
        <View style={styles.headerActions}>
          <PeriodToggle value={periodView} onChange={setPeriodView} />
          <Pressable style={styles.secondaryButton} onPress={() => onRefresh()} disabled={refreshing}>
            <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={handleExport}>
            <Text style={styles.primaryButtonText}>Export filtered view</Text>
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
            <Text style={styles.filterLabel}>Status</Text>
            <WebSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { label: 'Submitted', value: 'submitted' },
                { label: 'Approved', value: 'approved' },
                { label: 'Returned', value: 'returned' },
                { label: 'Rejected', value: 'rejected' },
                { label: 'Draft', value: 'draft' },
                { label: 'All statuses', value: 'all' },
              ]}
              placeholder="Status"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>Guard</Text>
            <WebSelect value={guardFilter} onChange={setGuardFilter} options={guardOptions} placeholder="All guards" />
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
              placeholder="Guard, site, note, shift"
              placeholderTextColor="#64748b"
            />
          </View>
          <View style={styles.filterField}>
            <Text style={styles.filterLabel}>View type</Text>
            <PeriodToggle value={periodView} onChange={setPeriodView} />
          </View>
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <SummaryCard label="Submitted" value={String(summary.submitted)} />
        <SummaryCard label="Approved" value={String(summary.approved)} />
        <SummaryCard label="Returned / Rejected" value={String(summary.returnedOrRejected)} />
        <SummaryCard label="Total Hours" value={`${summary.totalHours.toFixed(2)} h`} />
      </View>

      <View style={styles.reviewLayout}>
        <View style={styles.reviewListCard}>
          {groupedTimesheets.length === 0 ? <Text style={styles.emptyText}>No timesheets match the current filters.</Text> : null}
          {groupedTimesheets.map((group) => {
            const isCollapsed = Boolean(collapsedGroupKeys[group.key]);

            return (
              <View key={group.key} style={styles.groupCard}>
                <Pressable style={styles.groupHeader} onPress={() => setGroupCollapsed(group.key)}>
                  <View style={styles.groupHeaderCopy}>
                    <Text style={styles.groupSite}>{group.siteName}</Text>
                    <Text style={styles.groupPeriod}>
                      {group.periodLabel} | {group.totals.count} timesheets | {group.totals.claimedHours.toFixed(2)} claimed h | {group.totals.approvedHours.toFixed(2)} approved h
                    </Text>
                  </View>
                  <View style={styles.groupHeaderActions}>
                    <Pressable style={styles.inlineAction} onPress={() => handleExportGroup(group)}>
                      <Text style={styles.inlineActionText}>Export group</Text>
                    </Pressable>
                    <Text style={styles.groupToggle}>{isCollapsed ? 'Expand' : 'Collapse'}</Text>
                  </View>
                </Pressable>

                {!isCollapsed ? (
                  <>
                    <View style={styles.rowsHeader}>
                      <Text style={[styles.rowsHeaderText, styles.guardCol]}>Guard</Text>
                      <Text style={[styles.rowsHeaderText, styles.dateCol]}>Shift Date</Text>
                      <Text style={[styles.rowsHeaderText, styles.scheduleCol]}>Scheduled</Text>
                      <Text style={[styles.rowsHeaderText, styles.attendanceCol]}>Attendance</Text>
                      <Text style={[styles.rowsHeaderText, styles.hoursCol]}>Claimed Hours</Text>
                      <Text style={[styles.rowsHeaderText, styles.statusCol]}>Status</Text>
                      <Text style={[styles.rowsHeaderText, styles.actionsCol]}>Actions</Text>
                    </View>

                    {group.rows.map((entry) => {
                      const statusPalette = getStatusPalette(entry.displayStatus);
                      const isSelected = entry.timesheet.id === selectedTimesheetId;
                      const isSubmitted = normalizeStatus(entry.displayStatus) === 'submitted';
                      const approveBusy = busyAction === `approve-${entry.timesheet.id}`;
                      const returnBusy = busyAction === `return-${entry.timesheet.id}`;

                      return (
                        <Pressable
                          key={entry.timesheet.id}
                          style={[styles.timesheetRow, isSelected && styles.timesheetRowSelected]}
                          onPress={() => setSelectedTimesheetId(entry.timesheet.id)}
                        >
                          <Text style={[styles.rowTextStrong, styles.guardCol]}>{entry.guardName}</Text>
                          <Text style={[styles.rowText, styles.dateCol]}>{entry.shiftDateLabel}</Text>
                          <Text style={[styles.rowText, styles.scheduleCol]}>{entry.scheduledLabel}</Text>
                          <Text style={[styles.rowText, styles.attendanceCol]}>{entry.attendanceLabel}</Text>
                          <Text style={[styles.rowText, styles.hoursCol]}>{toHours(entry.timesheet.hoursWorked).toFixed(2)}</Text>
                          <View style={[styles.statusBadge, styles.statusCol, { backgroundColor: statusPalette.bg }]}>
                            <Text style={[styles.statusBadgeText, { color: statusPalette.text }]}>{formatStatusLabel(entry.displayStatus)}</Text>
                          </View>
                          <View style={[styles.rowActions, styles.actionsCol]}>
                            <Pressable style={styles.secondaryChip} onPress={() => setSelectedTimesheetId(entry.timesheet.id)}>
                              <Text style={styles.secondaryChipText}>View</Text>
                            </Pressable>
                            {isSubmitted ? (
                              <>
                                <Pressable style={styles.primaryChip} onPress={() => handleApprove(entry)} disabled={approveBusy || Boolean(busyAction)}>
                                  <Text style={styles.primaryChipText}>{approveBusy ? 'Approving...' : 'Approve'}</Text>
                                </Pressable>
                                <Pressable style={styles.warningChip} onPress={() => handleReturn(entry)} disabled={returnBusy || Boolean(busyAction)}>
                                  <Text style={styles.warningChipText}>{returnBusy ? 'Returning...' : 'Return'}</Text>
                                </Pressable>
                              </>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}

                    <View style={styles.groupFooter}>
                      <Text style={styles.groupFooterText}>Timesheets: {group.totals.count}</Text>
                      <Text style={styles.groupFooterText}>Claimed: {group.totals.claimedHours.toFixed(2)} h</Text>
                      <Text style={styles.groupFooterText}>Approved: {group.totals.approvedHours.toFixed(2)} h</Text>
                      <Text style={styles.groupFooterText}>Pending: {group.totals.pendingCount}</Text>
                      <Text style={styles.groupFooterText}>Approved count: {group.totals.approvedCount}</Text>
                    </View>
                  </>
                ) : null}
              </View>
            );
          })}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailTitle}>Timesheet review</Text>
          <Text style={styles.detailSubtitle}>Open a row to review guard hours, notes, and action outcomes.</Text>

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
                  <Text style={styles.detailMetaLabel}>Status</Text>
                  <View style={[styles.detailStatusBadge, { backgroundColor: getStatusPalette(selectedTimesheet?.displayStatus || '').bg }]}>
                    <Text style={[styles.detailStatusBadgeText, { color: getStatusPalette(selectedTimesheet?.displayStatus || '').text }]}>
                      {formatStatusLabel(selectedTimesheet?.displayStatus)}
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
                <Text style={styles.detailLine}>Recorded minutes: {activeSelected.workedMinutes ?? 0}</Text>
                <Text style={styles.detailLine}>Claimed hours: {selectedClaimedHours.toFixed(2)}</Text>
                <Text style={styles.detailLine}>
                  Approved hours: {toHours(activeSelected.approvedHours ?? activeSelected.hoursWorked).toFixed(2)}
                </Text>
                <Text style={styles.detailLine}>Submitted: {activeSelected.submittedAt ? formatDateTimeLabel(activeSelected.submittedAt) : 'Not submitted'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Guard note</Text>
                <Text style={styles.detailParagraph}>{activeSelected.guardNote?.trim() ? activeSelected.guardNote : 'No guard note provided.'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Company note</Text>
                <TextInput
                  value={companyNote}
                  onChangeText={setCompanyNote}
                  style={[styles.input, styles.noteInput]}
                  multiline
                  textAlignVertical="top"
                  placeholder="Add payroll / client approval context, or note why this should be returned."
                  placeholderTextColor="#64748b"
                />
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Approved hours</Text>
                <Text style={styles.detailLine}>Claimed hours remain read-only so the original submission stays intact.</Text>
                <TextInput
                  value={approvedHoursInput}
                  onChangeText={setApprovedHoursInput}
                  style={styles.input}
                  keyboardType="decimal-pad"
                  placeholder={formatHoursInput(activeSelected.hoursWorked)}
                  placeholderTextColor="#64748b"
                />
                {adjustedHoursRequireNote ? (
                  <Text style={styles.validationText}>Add a company note when approved hours differ from claimed hours.</Text>
                ) : null}
              </View>

              <View style={styles.detailActions}>
                <Pressable style={styles.secondaryButton} onPress={handleSaveCompanyNote} disabled={busyAction === `note-${activeSelected.id}` || Boolean(busyAction)}>
                  <Text style={styles.secondaryButtonText}>{busyAction === `note-${activeSelected.id}` ? 'Saving...' : 'Save review details'}</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={() => handleApprove(selectedTimesheet)} disabled={busyAction === `approve-${activeSelected.id}` || Boolean(busyAction)}>
                  <Text style={styles.primaryButtonText}>{busyAction === `approve-${activeSelected.id}` ? 'Approving...' : 'Approve'}</Text>
                </Pressable>
                <Pressable style={styles.warningButton} onPress={() => handleReturn(selectedTimesheet)} disabled={busyAction === `return-${activeSelected.id}` || Boolean(busyAction)}>
                  <Text style={styles.warningButtonText}>{busyAction === `return-${activeSelected.id}` ? 'Returning...' : 'Return for correction'}</Text>
                </Pressable>
                <Pressable style={styles.dangerButton} onPress={() => handleReject(selectedTimesheet)} disabled={busyAction === `reject-${activeSelected.id}` || Boolean(busyAction)}>
                  <Text style={styles.dangerButtonText}>{busyAction === `reject-${activeSelected.id}` ? 'Rejecting...' : 'Reject'}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={styles.emptyText}>Select a timesheet row to review guard hours and record an approval decision.</Text>
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
  warningButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FEF3C7' },
  warningButtonText: { color: '#B45309', fontWeight: '700' },
  dangerButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FEE2E2' },
  dangerButtonText: { color: '#B91C1C', fontWeight: '700' },
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
  input: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: '#d6dce5', backgroundColor: '#ffffff', paddingHorizontal: 14, paddingVertical: 12, color: '#132238' },
  webSelect: { borderRadius: 14, borderWidth: 1, borderColor: '#d6dce5', backgroundColor: '#ffffff', padding: '14px 16px', fontSize: 14, color: '#132238', minHeight: 48 },
  summaryGrid: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  summaryCard: { flexGrow: 1, minWidth: 180, backgroundColor: '#FFFFFF', borderRadius: 20, padding: 18, gap: 8 },
  summaryLabel: { color: '#64748b', fontSize: 13, fontWeight: '700' },
  summaryValue: { color: '#0f172a', fontSize: 28, fontWeight: '800' },
  reviewLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  reviewListCard: { flex: 2.2, minWidth: 760, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14 },
  detailCard: { flex: 1, minWidth: 340, backgroundColor: '#FFFFFF', borderRadius: 22, padding: 18, gap: 14, borderWidth: 1, borderColor: '#DBEAFE' },
  detailTitle: { color: '#0f172a', fontSize: 20, fontWeight: '800' },
  detailSubtitle: { color: '#64748b', fontSize: 13, lineHeight: 18 },
  groupCard: { borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 18, overflow: 'hidden' },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#F8FAFC' },
  groupHeaderCopy: { flex: 1, gap: 4 },
  groupSite: { color: '#0f172a', fontSize: 18, fontWeight: '800' },
  groupPeriod: { color: '#475569', fontSize: 13 },
  groupHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  inlineAction: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: '#E2E8F0' },
  inlineActionText: { color: '#0f172a', fontWeight: '700', fontSize: 12 },
  groupToggle: { color: '#1D4ED8', fontWeight: '700', fontSize: 12 },
  rowsHeader: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#E2E8F0', borderBottomWidth: 1, borderBottomColor: '#E2E8F0', backgroundColor: '#FFFFFF' },
  rowsHeaderText: { color: '#64748b', fontWeight: '700', fontSize: 12, textTransform: 'uppercase' },
  timesheetRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  timesheetRowSelected: { backgroundColor: '#EFF6FF' },
  rowText: { color: '#334155', fontSize: 13 },
  rowTextStrong: { color: '#0f172a', fontSize: 13, fontWeight: '700' },
  guardCol: { flex: 1.3 },
  dateCol: { flex: 0.9 },
  scheduleCol: { flex: 1.1 },
  attendanceCol: { flex: 1.1 },
  hoursCol: { flex: 0.8 },
  statusCol: { flex: 0.9 },
  actionsCol: { flex: 1.4 },
  statusBadge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  statusBadgeText: { fontWeight: '800', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  rowActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  secondaryChip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#E2E8F0' },
  secondaryChipText: { color: '#0f172a', fontWeight: '700', fontSize: 12 },
  primaryChip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#DBEAFE' },
  primaryChipText: { color: '#1D4ED8', fontWeight: '700', fontSize: 12 },
  warningChip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#FEF3C7' },
  warningChipText: { color: '#B45309', fontWeight: '700', fontSize: 12 },
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
  validationText: { color: '#B45309', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  noteInput: { minHeight: 110, textAlignVertical: 'top' },
  detailActions: { gap: 10 },
  emptyText: { color: '#64748b', fontSize: 14, lineHeight: 20 },
});
