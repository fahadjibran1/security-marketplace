import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatApiErrorMessage, getCompanyWeeklyApprovals, getEligibleTimesheets, submitWeeklyApproval, updateTimesheet } from '../../services/api';
import { ClientWeeklyApprovalSummary, EligibleTimesheetRow, Timesheet } from '../../types/models';
import { colors } from '../../theme';

type WorkspaceLevel = 'overview' | 'detail';
type WorkflowStatus = 'all' | 'awaiting-guard' | 'needs-review' | 'ready-for-client' | 'awaiting-client' | 'returned' | 'client-approved' | 'finalised';

type WorkspaceFeedback = {
  tone: 'success' | 'error' | 'info';
  title: string;
  message: string;
} | null;

type CompanyTimesheetsWorkspaceProps = {
  timesheets: Timesheet[];
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onNavigateToClientTimesheets?: (requestId?: number) => void;
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
  hourlyRate: number | null;
  claimedAmount: number | null;
  approvedAmount: number | null;
};

type GroupedTimesheets = {
  key: string;
  numericSiteId: number | null;
  clientId: number | null;
  clientName: string | null;
  siteName: string;
  periodKey: string;
  periodLabel: string;
  weekLabel: string;
  clientSubmissionStatus: string | null;
  clientRequestId: number | null;
  rows: EnrichedTimesheet[];
  totals: {
    count: number;
    guardCount: number;
    claimedHours: number;
    approvedHours: number;
    claimedAmount: number;
    approvedAmount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    reviewedCount: number;
    returnedCount: number;
    awaitingGuardCount: number;
    awaitingCompanyCount: number;
    missingRateCount: number;
  };
};

type GuardGroup = {
  guardId: string;
  guardName: string;
  rows: EnrichedTimesheet[];
  totals: {
    count: number;
    claimedHours: number;
    approvedHours: number;
    reviewedCount: number;
    approvedCount: number;
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
  return date.toLocaleDateString(UK_LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTimeLabel(value?: string | null) {
  if (!value) return 'Not set';
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts?.hour && literalParts?.minute) return `${literalParts.hour}:${literalParts.minute}`;
  const date = parseDateValue(value);
  if (!date) return value;
  return date.toLocaleTimeString(UK_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
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
    case 'draft': return 'Awaiting Guard Submission';
    case 'submitted': return 'Awaiting Company Review';
    case 'approved': return 'Reviewed — Approved';
    case 'rejected': return 'Reviewed — Rejected';
    case 'returned': return 'Returned to Guard — Awaiting Resubmission';
    default: return value
      ? value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
      : 'Unknown';
  }
}

function getWorkflowStatePanel(value?: string | null): { title: string; body: string } {
  switch (normalizeStatus(value)) {
    case 'draft':
      return { title: 'Awaiting Guard Submission', body: 'The Guard must submit this timesheet before Company review.' };
    case 'returned':
      return { title: 'Awaiting Guard Resubmission', body: 'This timesheet was returned to the Guard for correction. Awaiting their resubmission.' };
    default:
      return { title: '', body: '' };
  }
}

function clientSubmissionStatusLabel(status: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'pending_approval': return 'Awaiting Client Approval';
    case 'resolved': return 'Awaiting Client Approval';
    case 'disputed': return 'Returned for Correction';
    case 'client_approved': return 'Client Approved';
    case 'locked': return 'Finalised';
    default: return status || 'Submitted';
  }
}

function getStatusPalette(status: string) {
  switch (normalizeStatus(status)) {
    case 'approved': return { bg: colors.successSurface, text: colors.success };
    case 'submitted': return { bg: colors.infoSurface, text: colors.info };
    case 'returned': return { bg: colors.warningSurface, text: colors.warning };
    case 'rejected': return { bg: colors.dangerSurface, text: colors.danger };
    case 'draft':
    default: return { bg: colors.pendingSurface, text: colors.primaryNavySoft };
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
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return 'Rate unavailable';
  return Number(value).toLocaleString(UK_LOCALE, { style: 'currency', currency: GBP_CURRENCY, minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRate(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return 'Rate unavailable';
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
  if (normalizeStatus(timesheet.approvalStatus) === 'approved') return toHours(timesheet.hoursWorked);
  return null;
}

function getAmountForHours(hours: number | null, rate: number | null) {
  if (hours === null || rate === null) return null;
  return roundCurrency(hours * rate);
}

function formatHoursInput(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '';
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

function getWeekRangeLabel(start: Date): string {
  const end = getWeekEnd(start);
  const sDay = start.getDate();
  const eDay = end.getDate();
  const eMon = end.toLocaleDateString(UK_LOCALE, { month: 'short' });
  const yr = end.getFullYear();
  if (start.getMonth() === end.getMonth()) return `${sDay}–${eDay} ${eMon} ${yr}`;
  const sMon = start.toLocaleDateString(UK_LOCALE, { month: 'short' });
  return `${sDay} ${sMon} – ${eDay} ${eMon} ${yr}`;
}

function getPeriodKey(value: Date) {
  return toIsoDateInput(getWeekStart(value));
}

function getGroupWorkflowStatus(totals: GroupedTimesheets['totals'], clientSubmissionStatus?: string | null): WorkflowStatus {
  const cs = (clientSubmissionStatus || '').toLowerCase();
  // Post-submission Client states (week already packaged and sent)
  if (cs === 'locked') return 'finalised';
  if (cs === 'client_approved') return 'client-approved';
  if (cs === 'pending_approval' || cs === 'resolved') return 'awaiting-client';
  if (cs === 'disputed') return 'returned';
  // Pre-submission Guard / Company states
  // 1. Guard must act (draft or returned timesheets awaiting guard)
  if (totals.awaitingGuardCount > 0) return 'awaiting-guard';
  // 2. Company must act (submitted timesheets awaiting company review)
  if (totals.awaitingCompanyCount > 0) return 'needs-review';
  // 3. All company-reviewed, not yet sent to client
  if (totals.approvedCount > 0) return 'ready-for-client';
  return 'needs-review';
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
}

function getDownloadTimestamp(value = new Date()) {
  const y = value.getFullYear();
  const mo = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  const h = String(value.getHours()).padStart(2, '0');
  const mi = String(value.getMinutes()).padStart(2, '0');
  const s = String(value.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function WebSelect({ value, onChange, options, placeholder }: WebSelectProps) {
  const [isBrowserReady, setIsBrowserReady] = React.useState(false);
  React.useEffect(() => { setIsBrowserReady(typeof document !== 'undefined'); }, []);
  if (isBrowserReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';
    return (
      <SelectTag value={value} onChange={(e: any) => onChange(e.target.value)} style={styles.webSelect} aria-label={placeholder || 'Select'}>
        <OptionTag value="">{placeholder || 'Select'}</OptionTag>
        {options.map((o) => <OptionTag key={o.value} value={o.value}>{o.label}</OptionTag>)}
      </SelectTag>
    );
  }
  return <TextInput value={value} onChangeText={onChange} style={styles.input} placeholder={placeholder} placeholderTextColor="#64748b" />;
}

function KpiCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <View style={[styles.kpiCard, accent && styles.kpiCardAccent]}>
      <Text style={styles.kpiValue}>{String(value)}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

function WorkflowBadge({ status }: { status: WorkflowStatus }) {
  if (status === 'awaiting-guard') return <View style={styles.badgeAwaitingGuard}><Text style={styles.badgeText}>Awaiting Guard</Text></View>;
  if (status === 'needs-review') return <View style={styles.badgeNeedsReview}><Text style={styles.badgeText}>Awaiting Company Review</Text></View>;
  if (status === 'ready-for-client') return <View style={styles.badgeReady}><Text style={styles.badgeText}>Ready for Client</Text></View>;
  if (status === 'awaiting-client') return <View style={styles.badgeAwaitingClient}><Text style={styles.badgeText}>Awaiting Client Approval</Text></View>;
  if (status === 'returned') return <View style={styles.badgeReturned}><Text style={styles.badgeText}>Returned for Correction</Text></View>;
  if (status === 'client-approved') return <View style={styles.badgeClientApproved}><Text style={styles.badgeText}>Client Approved</Text></View>;
  if (status === 'finalised') return <View style={styles.badgeFinalised}><Text style={styles.badgeText}>Finalised</Text></View>;
  return null;
}

export function CompanyTimesheetsWorkspace({
  timesheets,
  refreshing,
  onRefresh,
  onNavigateToClientTimesheets,
}: CompanyTimesheetsWorkspaceProps) {
  // Navigation
  const [level, setLevel] = React.useState<WorkspaceLevel>('overview');
  const [activeGroupKey, setActiveGroupKey] = React.useState<string | null>(null);

  // Filters
  const [siteFilter, setSiteFilter] = React.useState('');
  const [workflowStatusFilter, setWorkflowStatusFilter] = React.useState<WorkflowStatus>('all');
  const [weekOffset, setWeekOffset] = React.useState(0);

  // Review state
  const [selectedTimesheetId, setSelectedTimesheetId] = React.useState<number | null>(null);
  const [companyNote, setCompanyNote] = React.useState('');
  const [approvedHoursInput, setApprovedHoursInput] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<WorkspaceFeedback>(null);

  // Guard-level collapse in detail view
  const [collapsedGuardKeys, setCollapsedGuardKeys] = React.useState<Record<string, boolean>>({});

  // Send-to-client flow
  const [sendGroup, setSendGroup] = React.useState<{
    siteId: number;
    siteName: string;
    weekCommencing: string;
    clientId: number;
    clientName: string;
    unreviewedCount: number;
    totalCount: number;
  } | null>(null);
  const [sendEligible, setSendEligible] = React.useState<EligibleTimesheetRow[]>([]);
  const [sendLoading, setSendLoading] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sendSelectedIds, setSendSelectedIds] = React.useState<Set<number>>(new Set());
  const [sendExclusionReasons, setSendExclusionReasons] = React.useState<Record<number, string>>({});
  const [sendClientNote, setSendClientNote] = React.useState('');
  const [sendSubmitLoading, setSendSubmitLoading] = React.useState(false);
  const [sendSubmitError, setSendSubmitError] = React.useState<string | null>(null);

  // Weekly approvals — for duplicate-request detection and "Open Client Timesheet"
  const [weeklyApprovals, setWeeklyApprovals] = React.useState<ClientWeeklyApprovalSummary[]>([]);

  // ── DERIVED: active week ─────────────────────────────────────────────────
  const baseWeekStart = React.useMemo(() => getWeekStart(new Date()), []);
  const activeWeekStart = React.useMemo(() => {
    const d = new Date(baseWeekStart);
    d.setDate(d.getDate() + weekOffset * 7);
    return d;
  }, [baseWeekStart, weekOffset]);

  const weekNavLabel = React.useMemo(() => getWeekRangeLabel(activeWeekStart), [activeWeekStart]);

  // ── ENRICHED TIMESHEETS ──────────────────────────────────────────────────
  const enrichedTimesheets = React.useMemo<EnrichedTimesheet[]>(() => {
    return timesheets
      .map((timesheet) => {
        const siteId = String(timesheet.shift?.site?.id ?? timesheet.shift?.siteId ?? timesheet.shiftId ?? 'unknown');
        const siteName = timesheet.shift?.site?.name || timesheet.shift?.siteName || `Site ${siteId}`;
        const guardId = String(timesheet.guard?.id ?? timesheet.guardId ?? 'unknown');
        const guardName = timesheet.guard?.fullName || `Guard #${guardId}`;
        const shiftDate = parseDateValue(timesheet.scheduledStartAt || timesheet.shift?.start || timesheet.createdAt) || new Date();
        const scheduledStart = timesheet.scheduledStartAt || timesheet.shift?.start || null;
        const scheduledEnd = timesheet.scheduledEndAt || timesheet.shift?.end || null;
        const displayStatus = getDisplayStatus(timesheet);
        const hourlyRate = getTimesheetRate(timesheet);
        const claimedAmount = getAmountForHours(toHours(timesheet.hoursWorked), hourlyRate);
        const approvedAmount = getAmountForHours(getApprovedHoursValue(timesheet), hourlyRate);
        return {
          timesheet,
          siteId,
          siteName,
          guardId,
          guardName,
          displayStatus,
          searchText: [siteName, guardName, timesheet.id, timesheet.shiftId, timesheet.guardNote || '', timesheet.companyNote || ''].join(' ').toLowerCase(),
          shiftDate,
          shiftDateLabel: formatDateLabel(scheduledStart || timesheet.createdAt),
          scheduledLabel: `${formatTimeLabel(scheduledStart)} - ${formatTimeLabel(scheduledEnd)}`,
          attendanceLabel: `${formatTimeLabel(timesheet.actualCheckInAt)} / ${formatTimeLabel(timesheet.actualCheckOutAt)}`,
          hourlyRate,
          claimedAmount,
          approvedAmount,
        };
      })
      .sort((a, b) => b.shiftDate.getTime() - a.shiftDate.getTime());
  }, [timesheets]);

  const siteOptions = React.useMemo(
    () => Array.from(new Map(enrichedTimesheets.map((e) => [e.siteId, e.siteName])).entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [enrichedTimesheets],
  );

  // ── FILTERED TIMESHEETS (week + site) ────────────────────────────────────
  const filteredTimesheets = React.useMemo(() => {
    const weekEnd = getWeekEnd(activeWeekStart);
    return enrichedTimesheets.filter((entry) => {
      if (entry.shiftDate < activeWeekStart || entry.shiftDate > weekEnd) return false;
      if (siteFilter && entry.siteId !== siteFilter) return false;
      return true;
    });
  }, [enrichedTimesheets, activeWeekStart, siteFilter]);

  // ── WEEKLY APPROVAL LOOKUP (siteId + weekCommencing → status + requestId) ──
  const weeklyApprovalLookup = React.useMemo(() => {
    const map = new Map<string, { status: string; requestId: number }>();
    weeklyApprovals.forEach((wa) => {
      const key = `${wa.siteId}__${wa.weekCommencing}`;
      if (!map.has(key)) map.set(key, { status: wa.status, requestId: wa.id });
    });
    return map;
  }, [weeklyApprovals]);

  // ── GROUPED BY SITE + WEEK ───────────────────────────────────────────────
  const groupedTimesheets = React.useMemo<GroupedTimesheets[]>(() => {
    const groups = new Map<string, GroupedTimesheets>();
    filteredTimesheets.forEach((entry) => {
      const periodKey = getPeriodKey(entry.shiftDate);
      const weekStart = getWeekStart(entry.shiftDate);
      const groupKey = `${entry.siteName}__${periodKey}`;
      const existing = groups.get(groupKey) ?? {
        key: groupKey,
        numericSiteId: Number(entry.timesheet.shift?.site?.id) || null,
        clientId: (entry.timesheet.shift?.site?.clientId ?? null) as number | null,
        clientName: (entry.timesheet.shift?.site?.clientName ?? null) as string | null,
        siteName: entry.siteName,
        periodKey,
        periodLabel: `Week of ${formatDateLabel(weekStart.toISOString())}`,
        weekLabel: getWeekRangeLabel(weekStart),
        clientSubmissionStatus: null,
        clientRequestId: null,
        rows: [],
        totals: {
          count: 0, guardCount: 0, claimedHours: 0, approvedHours: 0,
          claimedAmount: 0, approvedAmount: 0,
          pendingCount: 0, approvedCount: 0, rejectedCount: 0,
          reviewedCount: 0, returnedCount: 0,
          awaitingGuardCount: 0, awaitingCompanyCount: 0,
          missingRateCount: 0,
        },
      };

      existing.rows.push(entry);
      existing.totals.count += 1;
      existing.totals.claimedHours += toHours(entry.timesheet.hoursWorked);
      if (entry.claimedAmount !== null) existing.totals.claimedAmount += entry.claimedAmount;

      const rowStatus = normalizeStatus(entry.displayStatus);
      if (rowStatus === 'approved') {
        existing.totals.approvedHours += toHours(entry.timesheet.approvedHours ?? entry.timesheet.hoursWorked);
        if (entry.approvedAmount !== null) existing.totals.approvedAmount += entry.approvedAmount;
        existing.totals.approvedCount += 1;
        existing.totals.reviewedCount += 1;
      }
      if (rowStatus === 'rejected') {
        existing.totals.rejectedCount += 1;
        existing.totals.reviewedCount += 1;
      }
      if (rowStatus === 'submitted') { existing.totals.pendingCount += 1; existing.totals.awaitingCompanyCount += 1; }
      if (rowStatus === 'returned') { existing.totals.returnedCount += 1; existing.totals.awaitingGuardCount += 1; }
      if (rowStatus === 'draft') existing.totals.awaitingGuardCount += 1;
      if (entry.hourlyRate === null) existing.totals.missingRateCount += 1;

      groups.set(groupKey, existing);
    });

    return Array.from(groups.values())
      .map((group) => {
        const approvalKey = `${group.numericSiteId}__${group.periodKey}`;
        const approval = weeklyApprovalLookup.get(approvalKey) ?? null;
        return {
          ...group,
          clientSubmissionStatus: approval ? approval.status : null,
          clientRequestId: approval ? approval.requestId : null,
          rows: group.rows.sort((a, b) => b.shiftDate.getTime() - a.shiftDate.getTime()),
          totals: {
            ...group.totals,
            guardCount: new Set(group.rows.map((r) => r.guardId)).size,
            claimedHours: roundHours(group.totals.claimedHours),
            approvedHours: roundHours(group.totals.approvedHours),
            claimedAmount: roundCurrency(group.totals.claimedAmount),
            approvedAmount: roundCurrency(group.totals.approvedAmount),
          },
        };
      })
      .sort((a, b) => a.siteName !== b.siteName ? a.siteName.localeCompare(b.siteName) : b.rows[0].shiftDate.getTime() - a.rows[0].shiftDate.getTime());
  }, [filteredTimesheets, weeklyApprovalLookup]);

  // ── ACTIVE GROUP (detail view) ───────────────────────────────────────────
  const activeGroup = React.useMemo(
    () => groupedTimesheets.find((g) => g.key === activeGroupKey) ?? null,
    [groupedTimesheets, activeGroupKey],
  );

  // ── GUARD GROUPS (within active site/week) ───────────────────────────────
  const guardGroups = React.useMemo<GuardGroup[]>(() => {
    if (!activeGroup) return [];
    const map = new Map<string, GuardGroup>();
    for (const entry of activeGroup.rows) {
      const existing = map.get(entry.guardId) ?? {
        guardId: entry.guardId,
        guardName: entry.guardName,
        rows: [],
        totals: { count: 0, claimedHours: 0, approvedHours: 0, reviewedCount: 0, approvedCount: 0 },
      };
      existing.rows.push(entry);
      existing.totals.count += 1;
      existing.totals.claimedHours += toHours(entry.timesheet.hoursWorked);
      const st = normalizeStatus(entry.displayStatus);
      if (st === 'approved') {
        existing.totals.approvedHours += toHours(entry.timesheet.approvedHours ?? entry.timesheet.hoursWorked);
        existing.totals.approvedCount += 1;
        existing.totals.reviewedCount += 1;
      }
      if (st === 'rejected') existing.totals.reviewedCount += 1;
      map.set(entry.guardId, existing);
    }
    return Array.from(map.values()).sort((a, b) => a.guardName.localeCompare(b.guardName));
  }, [activeGroup]);

  // ── WORKFLOW-FILTERED GROUPS (overview) ──────────────────────────────────
  const filteredGroups = React.useMemo(() => {
    if (workflowStatusFilter === 'all') return groupedTimesheets;
    return groupedTimesheets.filter((g) => getGroupWorkflowStatus(g.totals, g.clientSubmissionStatus) === workflowStatusFilter);
  }, [groupedTimesheets, workflowStatusFilter]);

  // ── KPI SUMMARY ──────────────────────────────────────────────────────────
  const kpis = React.useMemo(() => {
    const activeSites = new Set(groupedTimesheets.map((g) => g.siteName)).size;
    const totalTimesheets = groupedTimesheets.reduce((s, g) => s + g.totals.count, 0);
    const awaitingGuards = groupedTimesheets.filter((g) => g.totals.awaitingGuardCount > 0).length;
    const awaitingCompanyReview = groupedTimesheets.filter((g) => g.totals.awaitingCompanyCount > 0).length;
    const readyForClient = groupedTimesheets.filter((g) => getGroupWorkflowStatus(g.totals, g.clientSubmissionStatus) === 'ready-for-client').length;
    const awaitingClient = 0; // requires cross-referencing weekly approval submissions
    return { activeSites, totalTimesheets, awaitingGuards, awaitingCompanyReview, readyForClient, awaitingClient };
  }, [groupedTimesheets]);

  // ── SELECTED TIMESHEET ───────────────────────────────────────────────────
  const selectedTimesheet = React.useMemo(
    () => (activeGroup?.rows ?? []).find((e) => e.timesheet.id === selectedTimesheetId) ?? null,
    [activeGroup, selectedTimesheetId],
  );

  React.useEffect(() => {
    setSelectedTimesheetId(null);
    setCollapsedGuardKeys({});
  }, [activeGroupKey]);

  React.useEffect(() => {
    getCompanyWeeklyApprovals().then(setWeeklyApprovals).catch(() => {});
  }, []);

  React.useEffect(() => {
    setCompanyNote(selectedTimesheet?.timesheet.companyNote || '');
  }, [selectedTimesheet?.timesheet.id, selectedTimesheet?.timesheet.companyNote, selectedTimesheet?.timesheet.updatedAt]);

  React.useEffect(() => {
    if (!selectedTimesheet) { setApprovedHoursInput(''); return; }
    const cur = selectedTimesheet.timesheet.approvedHours ?? selectedTimesheet.timesheet.hoursWorked;
    setApprovedHoursInput(formatHoursInput(cur));
  }, [selectedTimesheet?.timesheet.id, selectedTimesheet?.timesheet.approvedHours, selectedTimesheet?.timesheet.hoursWorked, selectedTimesheet?.timesheet.updatedAt]);

  // ── SEND MODAL LOAD ──────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!sendGroup) {
      setSendEligible([]);
      setSendSelectedIds(new Set());
      setSendExclusionReasons({});
      setSendClientNote('');
      setSendSubmitError(null);
      return;
    }
    setSendLoading(true);
    setSendError(null);
    setSendEligible([]);
    setSendSelectedIds(new Set());
    setSendExclusionReasons({});
    getEligibleTimesheets(sendGroup.siteId, sendGroup.weekCommencing)
      .then((rows) => {
        setSendEligible(rows);
        setSendSelectedIds(new Set(rows.map((r) => r.id)));
      })
      .catch((err) => setSendError(formatApiErrorMessage(err, 'Failed to load eligible shifts.')))
      .finally(() => setSendLoading(false));
  }, [sendGroup]);

  const openSendModal = React.useCallback((group: GroupedTimesheets) => {
    if (!group.numericSiteId || !group.clientId) return;
    setSendGroup({
      siteId: group.numericSiteId,
      siteName: group.siteName,
      weekCommencing: group.periodKey,
      clientId: group.clientId,
      clientName: group.clientName ?? `Client #${group.clientId}`,
      unreviewedCount: group.totals.count - group.totals.reviewedCount,
      totalCount: group.totals.count,
    });
  }, []);

  const toggleSendId = React.useCallback((id: number) => {
    setSendSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        setSendExclusionReasons((prevR) => { const u = { ...prevR }; delete u[id]; return u; });
      }
      return next;
    });
  }, []);

  const handleSendToClient = React.useCallback(async () => {
    if (!sendGroup || sendSelectedIds.size === 0) return;
    const excluded = sendEligible.filter((r) => !sendSelectedIds.has(r.id));
    if (excluded.some((r) => !sendExclusionReasons[r.id]?.trim())) {
      setSendSubmitError('All excluded shifts require a reason before submitting.');
      return;
    }
    setSendSubmitLoading(true);
    setSendSubmitError(null);
    try {
      await submitWeeklyApproval({
        clientId: sendGroup.clientId,
        siteId: sendGroup.siteId,
        weekCommencing: sendGroup.weekCommencing,
        timesheetIds: Array.from(sendSelectedIds),
        clientSubmissionNote: sendClientNote.trim() || undefined,
      });
      setSendGroup(null);
      setFeedback({ tone: 'success', title: 'Sent to client', message: `${sendSelectedIds.size} shift${sendSelectedIds.size !== 1 ? 's' : ''} submitted to ${sendGroup.clientName} for approval.` });
      getCompanyWeeklyApprovals().then(setWeeklyApprovals).catch(() => {});
    } catch (err) {
      setSendSubmitError(formatApiErrorMessage(err, 'Submission failed.'));
    } finally {
      setSendSubmitLoading(false);
    }
  }, [sendClientNote, sendEligible, sendExclusionReasons, sendGroup, sendSelectedIds]);

  // ── CSV EXPORT (financial data preserved here, not in UI) ────────────────
  const buildExportRows = React.useCallback((groups: GroupedTimesheets[]) => {
    return [
      ['Site', 'Week', 'Guard', 'Shift Date', 'Scheduled', 'Attendance', 'Hourly Rate', 'Claimed Hours', 'Approved Hours', 'Claimed Amount', 'Approved Amount', 'Status', 'Company Note'],
      ...groups.flatMap((group) => [
        ...group.rows.map((entry) => {
          const approvedHoursValue = getApprovedHoursValue(entry.timesheet);
          return [
            group.siteName, group.weekLabel, entry.guardName, entry.shiftDateLabel, entry.scheduledLabel, entry.attendanceLabel,
            entry.hourlyRate !== null ? formatCurrency(entry.hourlyRate) : 'Rate unavailable',
            toHours(entry.timesheet.hoursWorked).toFixed(2),
            approvedHoursValue !== null ? approvedHoursValue.toFixed(2) : '',
            entry.claimedAmount !== null ? formatCurrency(entry.claimedAmount) : 'Rate unavailable',
            entry.approvedAmount !== null ? formatCurrency(entry.approvedAmount) : '',
            formatStatusLabel(entry.displayStatus),
            entry.timesheet.companyNote || '',
          ];
        }),
        [group.siteName, group.weekLabel, 'SUMMARY', '', '', '',
          group.totals.missingRateCount > 0 ? `${group.totals.missingRateCount} rate unavailable` : '',
          group.totals.claimedHours.toFixed(2), group.totals.approvedHours.toFixed(2),
          formatCurrency(group.totals.claimedAmount), formatCurrency(group.totals.approvedAmount),
          `Pending ${group.totals.pendingCount} | Approved ${group.totals.approvedCount}`, `Timesheets ${group.totals.count}`,
        ],
      ]),
    ];
  }, []);

  const handleExportGroup = React.useCallback((group: GroupedTimesheets) => {
    const rows = buildExportRows([group]);
    const didDownload = downloadCsv(`timesheets-${sanitizeFilenamePart(group.siteName)}-${sanitizeFilenamePart(group.periodKey)}-${getDownloadTimestamp()}.csv`, rows);
    setFeedback(
      didDownload
        ? { tone: 'success', title: 'Export ready', message: `Exported ${group.totals.count} timesheets for ${group.siteName}.` }
        : { tone: 'info', title: 'Export unavailable', message: 'CSV export is only available in the browser workspace.' },
    );
  }, [buildExportRows]);

  // ── COMPANY REVIEW ACTIONS ───────────────────────────────────────────────
  const runCompanyAction = React.useCallback(
    async (actionKey: string, timesheetId: number, payload: Parameters<typeof updateTimesheet>[1], successTitle: string, successMessage: string) => {
      try {
        setBusyAction(actionKey);
        await updateTimesheet(timesheetId, payload);
        await onRefresh();
        setFeedback({ tone: 'success', title: successTitle, message: successMessage });
      } catch (error) {
        setFeedback({ tone: 'error', title: 'Review action failed', message: formatApiErrorMessage(error, 'Unable to update this timesheet.') });
      } finally {
        setBusyAction(null);
      }
    },
    [onRefresh],
  );

  const buildApprovalPayload = React.useCallback(
    (mode: 'save' | 'approve') => {
      if (!selectedTimesheet) return null;
      const claimedHours = toHours(selectedTimesheet.timesheet.hoursWorked);
      const trimmedCompanyNote = companyNote.trim();
      const parsedApprovedHours = parseHoursInput(approvedHoursInput);
      const hasApprovedHoursValue = approvedHoursInput.trim().length > 0;
      const finalApprovedHours = mode === 'approve'
        ? hasApprovedHoursValue ? parsedApprovedHours : claimedHours
        : hasApprovedHoursValue ? parsedApprovedHours : undefined;
      if (finalApprovedHours != null && (!Number.isFinite(finalApprovedHours) || finalApprovedHours < 0)) {
        setFeedback({ tone: 'error', title: 'Invalid approved hours', message: 'Approved hours must be 0 or more.' });
        return null;
      }
      if (finalApprovedHours != null && Math.abs(finalApprovedHours - claimedHours) > 0.009 && !trimmedCompanyNote) {
        setFeedback({ tone: 'error', title: 'Company note required', message: 'Add a company note when approved hours differ from claimed hours.' });
        return null;
      }
      return { companyNote: trimmedCompanyNote || null, approvedHours: finalApprovedHours };
    },
    [approvedHoursInput, companyNote, selectedTimesheet],
  );

  const handleSaveCompanyNote = React.useCallback(async () => {
    if (!selectedTimesheet) return;
    const payload = buildApprovalPayload('save');
    if (!payload) return;
    await runCompanyAction(`note-${selectedTimesheet.timesheet.id}`, selectedTimesheet.timesheet.id, payload, 'Review details saved', 'The company note and approved hours were saved for this timesheet.');
  }, [buildApprovalPayload, runCompanyAction, selectedTimesheet]);

  const handleApprove = React.useCallback(async (entry: EnrichedTimesheet) => {
    const payload = entry.timesheet.id === selectedTimesheet?.timesheet.id
      ? buildApprovalPayload('approve')
      : { approvedHours: entry.timesheet.approvedHours ?? entry.timesheet.hoursWorked, companyNote: entry.timesheet.companyNote ?? null };
    if (!payload) return;
    await runCompanyAction(`approve-${entry.timesheet.id}`, entry.timesheet.id, { ...payload, approvalStatus: 'approved', rejectionReason: null }, 'Timesheet approved', 'The claimed hours were approved for payroll and client sign-off.');
  }, [buildApprovalPayload, runCompanyAction, selectedTimesheet?.timesheet.id]);

  const handleReturn = React.useCallback(async (entry: EnrichedTimesheet) => {
    const noteSource = entry.timesheet.id === selectedTimesheet?.timesheet.id ? companyNote.trim() : '';
    const note = noteSource || entry.timesheet.rejectionReason?.trim() || 'Returned for correction by company reviewer.';
    await runCompanyAction(`return-${entry.timesheet.id}`, entry.timesheet.id, { approvalStatus: 'returned', rejectionReason: note }, 'Returned for correction', 'The timesheet was returned to the guard for correction.');
  }, [companyNote, runCompanyAction, selectedTimesheet?.timesheet.id]);

  const handleReject = React.useCallback(async (entry: EnrichedTimesheet) => {
    const noteSource = entry.timesheet.id === selectedTimesheet?.timesheet.id ? companyNote.trim() : '';
    const note = noteSource || entry.timesheet.rejectionReason?.trim() || 'Rejected by company reviewer.';
    await runCompanyAction(`reject-${entry.timesheet.id}`, entry.timesheet.id, { approvalStatus: 'rejected', rejectionReason: note }, 'Timesheet rejected', 'The timesheet was rejected and marked for follow-up.');
  }, [companyNote, runCompanyAction, selectedTimesheet?.timesheet.id]);

  const activeSelected = selectedTimesheet?.timesheet;
  const isSubmittedForReview = normalizeStatus(activeSelected?.approvalStatus) === 'submitted';
  const selectedClaimedHours = activeSelected ? toHours(activeSelected.hoursWorked) : 0;
  const selectedApprovedHours = activeSelected && getApprovedHoursValue(activeSelected) !== null ? Number(getApprovedHoursValue(activeSelected)) : null;
  const parsedSelectedApprovedHours = parseHoursInput(approvedHoursInput);
  const adjustedHoursRequireNote = approvedHoursInput.trim().length > 0 && parsedSelectedApprovedHours !== null && Number.isFinite(parsedSelectedApprovedHours) && Math.abs(parsedSelectedApprovedHours - selectedClaimedHours) > 0.009 && !companyNote.trim();

  // ── SEND-TO-CLIENT MODAL (shared between overview card and detail) ────────
  const sendModal = (
    <Modal
      visible={!!sendGroup}
      transparent
      animationType="fade"
      onRequestClose={() => { if (!sendSubmitLoading) setSendGroup(null); }}
    >
      <View style={styles.sendOverlay}>
        <View style={styles.sendCard}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
            <Text style={styles.sendTitle}>Send Weekly Timesheet to Client</Text>
            {sendGroup && (
              <>
                <Text style={styles.sendMeta}>{sendGroup.siteName}</Text>
                <Text style={styles.sendMeta}>Week: {sendGroup.weekCommencing}</Text>
                <Text style={styles.sendMeta}>Client: {sendGroup.clientName}</Text>
                {sendGroup.unreviewedCount > 0 && (
                  <View style={styles.sendWarningBanner}>
                    <Text style={styles.sendWarningText}>
                      {sendGroup.totalCount - sendGroup.unreviewedCount} of {sendGroup.totalCount} shifts reviewed — {sendGroup.unreviewedCount} still require{sendGroup.unreviewedCount === 1 ? 's' : ''} a decision.
                    </Text>
                  </View>
                )}
              </>
            )}

            {sendLoading && <ActivityIndicator size="large" color={colors.primaryNavy} />}
            {sendError ? (
              <Text style={styles.sendErrorText}>{sendError}</Text>
            ) : sendEligible.length === 0 && !sendLoading ? (
              <Text style={styles.sendEmptyText}>No eligible approved, uninvoiced shifts found for this site and week.</Text>
            ) : null}

            {sendEligible.map((row) => {
              const isSelected = sendSelectedIds.has(row.id);
              const guardLabel = row.guard?.fullName ?? row.shift?.guard?.fullName ?? 'Guard';
              const shiftDateLabel = row.scheduledStartAt
                ? new Date(row.scheduledStartAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                : row.shift?.start ? new Date(row.shift.start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';
              const scheduledOn = row.scheduledStartAt ? new Date(row.scheduledStartAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const scheduledOff = row.scheduledEndAt ? new Date(row.scheduledEndAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const checkIn = row.actualCheckInAt ? new Date(row.actualCheckInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const checkOut = row.actualCheckOutAt ? new Date(row.actualCheckOutAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const approvedOn = row.companyApprovedStartAt ? new Date(row.companyApprovedStartAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const approvedOff = row.companyApprovedEndAt ? new Date(row.companyApprovedEndAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
              const approvedHrs = row.approvedHours != null ? Number(row.approvedHours).toFixed(2) : row.approvedMinutes != null ? (Number(row.approvedMinutes) / 60).toFixed(2) : Number(row.hoursWorked).toFixed(2);
              return (
                <View key={row.id} style={[styles.sendRow, !isSelected && styles.sendRowExcluded]}>
                  <Pressable style={styles.sendCheckRow} onPress={() => toggleSendId(row.id)}>
                    <View style={[styles.sendCheckbox, isSelected && styles.sendCheckboxChecked]}>
                      {isSelected && <Text style={styles.sendCheckmark}>✓</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sendGuardName}>{guardLabel}</Text>
                      <Text style={styles.sendShiftMeta}>{shiftDateLabel} · Scheduled: {scheduledOn}–{scheduledOff} · Check-in: {checkIn} / {checkOut}</Text>
                      <Text style={styles.sendShiftMeta}>Guard claimed: {Number(row.hoursWorked).toFixed(2)} h · Co. approved: {approvedHrs} h ({approvedOn}–{approvedOff})</Text>
                      {!isSelected && <Text style={styles.sendExcludedLabel}>Excluded</Text>}
                    </View>
                  </Pressable>
                  {!isSelected && (
                    <TextInput
                      style={styles.sendExclusionInput}
                      placeholder="Reason for exclusion (required)"
                      value={sendExclusionReasons[row.id] ?? ''}
                      onChangeText={(v: string) => setSendExclusionReasons((prev) => ({ ...prev, [row.id]: v }))}
                    />
                  )}
                </View>
              );
            })}

            {sendEligible.length > 0 && (
              <>
                <View style={styles.sendSummary}>
                  <Text style={styles.sendSummaryText}>
                    Submit {sendSelectedIds.size} shift{sendSelectedIds.size !== 1 ? 's' : ''} / {
                      sendEligible.filter((r) => sendSelectedIds.has(r.id))
                        .reduce((sum, r) => sum + (r.approvedHours != null ? Number(r.approvedHours) : r.approvedMinutes != null ? Number(r.approvedMinutes) / 60 : Number(r.hoursWorked)), 0)
                        .toFixed(2)
                    } approved hrs to {sendGroup?.clientName} for approval?
                  </Text>
                </View>
                <TextInput
                  style={styles.sendNoteInput}
                  placeholder="Client submission note (optional)"
                  value={sendClientNote}
                  onChangeText={setSendClientNote}
                  multiline
                />
              </>
            )}

            {sendSubmitError ? <Text style={styles.sendErrorText}>{sendSubmitError}</Text> : null}

            <View style={styles.sendActions}>
              <Pressable
                style={[styles.sendSubmitButton, (sendSelectedIds.size === 0 || sendSubmitLoading || sendLoading) && styles.sendButtonDisabled]}
                onPress={handleSendToClient}
                disabled={sendSelectedIds.size === 0 || sendSubmitLoading || sendLoading}
              >
                <Text style={styles.sendSubmitText}>{sendSubmitLoading ? 'Submitting...' : 'Confirm — Send to Client'}</Text>
              </Pressable>
              <Pressable style={styles.sendCancelButton} onPress={() => setSendGroup(null)} disabled={sendSubmitLoading}>
                <Text style={styles.sendCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  // ── FEEDBACK BANNER ──────────────────────────────────────────────────────
  const feedbackBanner = feedback ? (
    <View style={[styles.feedbackCard, feedback.tone === 'success' && styles.feedbackSuccess, feedback.tone === 'error' && styles.feedbackError, feedback.tone === 'info' && styles.feedbackInfo]}>
      <Text style={styles.feedbackTitle}>{feedback.title}</Text>
      <Text style={styles.feedbackText}>{feedback.message}</Text>
    </View>
  ) : null;

  // ════════════════════════════════════════════════════════════════════════
  // OVERVIEW RENDER
  // ════════════════════════════════════════════════════════════════════════
  if (level === 'overview') {
    return (
      <View style={styles.workspace}>
        {/* Header */}
        <View style={styles.workspaceHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Company Timesheets</Text>
            <Text style={styles.subtitle}>Review guard hours by site and week. Approved records move to Payroll.</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable style={styles.secondaryButton} onPress={() => onRefresh()} disabled={refreshing}>
              <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
            </Pressable>
          </View>
        </View>

        {feedbackBanner}

        {/* Week navigator + filters */}
        <View style={styles.filterCard}>
          <View style={styles.weekNavRow}>
            <Pressable style={styles.weekNavBtn} onPress={() => setWeekOffset((o) => o - 1)}>
              <Text style={styles.weekNavBtnText}>← Prev</Text>
            </Pressable>
            <Text style={styles.weekNavLabel}>{weekNavLabel}</Text>
            <Pressable style={[styles.weekNavBtn, weekOffset >= 0 && styles.weekNavBtnDisabled]} onPress={() => setWeekOffset((o) => o + 1)} disabled={weekOffset >= 0}>
              <Text style={styles.weekNavBtnText}>Next →</Text>
            </Pressable>
            {weekOffset !== 0 && (
              <Pressable style={styles.weekNavCurrentBtn} onPress={() => setWeekOffset(0)}>
                <Text style={styles.weekNavCurrentBtnText}>Current Week</Text>
              </Pressable>
            )}
          </View>
          <View style={styles.filterRow}>
            <View style={styles.filterField}>
              <Text style={styles.filterLabel}>Site</Text>
              <WebSelect value={siteFilter} onChange={setSiteFilter} options={siteOptions} placeholder="All sites" />
            </View>
            <View style={styles.filterField}>
              <Text style={styles.filterLabel}>Workflow Status</Text>
              <WebSelect
                value={workflowStatusFilter}
                onChange={(v) => setWorkflowStatusFilter(v as WorkflowStatus)}
                options={[
                  { label: 'All', value: 'all' },
                  { label: 'Awaiting Guard', value: 'awaiting-guard' },
                  { label: 'Needs Review', value: 'needs-review' },
                  { label: 'Ready for Client', value: 'ready-for-client' },
                  { label: 'Awaiting Client Approval', value: 'awaiting-client' },
                  { label: 'Returned for Correction', value: 'returned' },
                  { label: 'Client Approved', value: 'client-approved' },
                ]}
                placeholder="All"
              />
            </View>
          </View>
        </View>

        {/* KPI summary */}
        <View style={styles.kpiRow}>
          <KpiCard label="Active Sites" value={kpis.activeSites} />
          <KpiCard label="Timesheets" value={kpis.totalTimesheets} />
          <KpiCard label="Awaiting Guards" value={kpis.awaitingGuards} accent={kpis.awaitingGuards > 0} />
          <KpiCard label="Awaiting Company Review" value={kpis.awaitingCompanyReview} accent={kpis.awaitingCompanyReview > 0} />
          <KpiCard label="Ready for Client" value={kpis.readyForClient} />
        </View>

        {/* Site + Week cards */}
        <View style={styles.groupList}>
          {filteredGroups.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No timesheets found for this week.{siteFilter || workflowStatusFilter !== 'all' ? ' Try adjusting the filters.' : ''}</Text>
            </View>
          ) : null}
          {filteredGroups.map((group) => {
            const wfStatus = getGroupWorkflowStatus(group.totals, group.clientSubmissionStatus);
            const allReviewed = group.totals.awaitingGuardCount === 0 && group.totals.awaitingCompanyCount === 0;
            const sendReady = allReviewed && group.totals.approvedCount > 0 && !!group.numericSiteId && !!group.clientId;
            return (
              <View key={group.key} style={styles.siteWeekCard}>
                <View style={styles.siteWeekCardHeader}>
                  <View style={styles.siteWeekCardInfo}>
                    <Text style={styles.siteWeekSiteName}>{group.siteName}</Text>
                    <Text style={styles.siteWeekPeriod}>{group.weekLabel}</Text>
                    <Text style={styles.siteWeekMeta}>
                      {group.totals.guardCount} guard{group.totals.guardCount !== 1 ? 's' : ''} · {group.totals.count} shift{group.totals.count !== 1 ? 's' : ''} · {group.totals.reviewedCount}/{group.totals.count} reviewed · {group.totals.approvedHours.toFixed(2)} Guard Pay approved h
                    </Text>
                    {(group.totals.awaitingGuardCount > 0 || group.totals.awaitingCompanyCount > 0) && (
                      <Text style={styles.unreviewedWarning}>
                        {group.totals.awaitingGuardCount > 0 ? `Awaiting Guard — ${group.totals.awaitingGuardCount} timesheet${group.totals.awaitingGuardCount !== 1 ? 's' : ''}` : ''}
                        {group.totals.awaitingGuardCount > 0 && group.totals.awaitingCompanyCount > 0 ? ' · ' : ''}
                        {group.totals.awaitingCompanyCount > 0 ? `${group.totals.awaitingCompanyCount} Awaiting Company Review` : ''}
                      </Text>
                    )}
                  </View>
                  <View style={styles.siteWeekCardActions}>
                    <WorkflowBadge status={wfStatus} />
                    <Pressable style={styles.reviewSiteButton} onPress={() => { setActiveGroupKey(group.key); setLevel('detail'); setFeedback(null); }}>
                      <Text style={styles.reviewSiteButtonText}>Review Site</Text>
                    </Pressable>
                    {group.clientSubmissionStatus ? (
                      <Pressable
                        style={styles.openClientTimesheetButton}
                        onPress={() => onNavigateToClientTimesheets?.(group.clientRequestId ?? undefined)}
                      >
                        <Text style={styles.openClientTimesheetText}>Open Client Timesheet</Text>
                        <Text style={styles.clientTimesheetStatusText}>{clientSubmissionStatusLabel(group.clientSubmissionStatus)}</Text>
                      </Pressable>
                    ) : sendReady ? (
                      <>
                        <View style={styles.badgeReady}><Text style={styles.badgeText}>Ready for Client</Text></View>
                        <Pressable style={styles.sendToClientButton} onPress={() => openSendModal(group)}>
                          <Text style={styles.sendToClientText}>Send Weekly Timesheet to Client</Text>
                        </Pressable>
                      </>
                    ) : group.totals.awaitingGuardCount > 0 ? (
                      <Pressable style={[styles.sendToClientButton, styles.sendToClientButtonDisabled]} disabled>
                        <Text style={styles.sendToClientText}>Send Weekly Timesheet to Client</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {sendModal}
      </View>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // DETAIL RENDER (level === 'detail')
  // ════════════════════════════════════════════════════════════════════════
  if (!activeGroup) {
    return (
      <View style={styles.workspace}>
        <Pressable style={styles.backButton} onPress={() => setLevel('overview')}>
          <Text style={styles.backButtonText}>← Back to overview</Text>
        </Pressable>
        <Text style={styles.emptyText}>Site not found. Please go back and try again.</Text>
      </View>
    );
  }

  const detailAllReviewed = activeGroup.totals.awaitingGuardCount === 0 && activeGroup.totals.awaitingCompanyCount === 0;
  const detailSendReady = detailAllReviewed && activeGroup.totals.approvedCount > 0 && !!activeGroup.numericSiteId && !!activeGroup.clientId;

  return (
    <View style={styles.workspace}>
      {/* Back + title */}
      <Pressable style={styles.backButton} onPress={() => setLevel('overview')}>
        <Text style={styles.backButtonText}>← Back to overview</Text>
      </Pressable>

      <View style={styles.detailPageHeader}>
        <View style={styles.detailPageHeaderCopy}>
          <Text style={styles.detailPageTitle}>{activeGroup.siteName}</Text>
          <Text style={styles.detailPageWeek}>{activeGroup.weekLabel}</Text>
          <Text style={styles.detailPageMeta}>
            {activeGroup.totals.guardCount} guard{activeGroup.totals.guardCount !== 1 ? 's' : ''} · {activeGroup.totals.count} shift{activeGroup.totals.count !== 1 ? 's' : ''} · {activeGroup.totals.reviewedCount}/{activeGroup.totals.count} reviewed · {activeGroup.totals.approvedHours.toFixed(2)} Guard Pay approved h
          </Text>
          {!detailAllReviewed && (
            <Text style={styles.unreviewedWarning}>
              {activeGroup.totals.reviewedCount} of {activeGroup.totals.count} shifts reviewed — {activeGroup.totals.count - activeGroup.totals.reviewedCount} still require{activeGroup.totals.count - activeGroup.totals.reviewedCount === 1 ? 's' : ''} a decision before sending to client.
            </Text>
          )}
        </View>
        <View style={styles.detailPageActions}>
          {activeGroup.clientSubmissionStatus ? (
            <Pressable
              style={styles.openClientTimesheetButton}
              onPress={() => onNavigateToClientTimesheets?.(activeGroup.clientRequestId ?? undefined)}
            >
              <Text style={styles.openClientTimesheetText}>Open Client Timesheet</Text>
              <Text style={styles.clientTimesheetStatusText}>{clientSubmissionStatusLabel(activeGroup.clientSubmissionStatus)}</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.sendToClientButton, !detailSendReady && styles.sendToClientButtonDisabled]}
              onPress={() => { if (detailSendReady) openSendModal(activeGroup); }}
              disabled={!detailSendReady}
            >
              <Text style={styles.sendToClientText}>Send Weekly Timesheet to Client</Text>
            </Pressable>
          )}
          <Pressable style={styles.secondaryButton} onPress={() => handleExportGroup(activeGroup)}>
            <Text style={styles.secondaryButtonText}>Export CSV</Text>
          </Pressable>
        </View>
      </View>

      {feedbackBanner}

      {/* Guard groups + review panel layout */}
      <View style={styles.reviewLayout}>
        {/* Guard groups list */}
        <View style={styles.guardListCard}>
          {guardGroups.length === 0 ? (
            <Text style={styles.emptyText}>No timesheets in this group.</Text>
          ) : null}

          {guardGroups.map((gg) => {
            const isGuardCollapsed = Boolean(collapsedGuardKeys[gg.guardId]);
            return (
              <View key={gg.guardId} style={styles.guardGroupCard}>
                <Pressable
                  style={styles.guardGroupHeader}
                  onPress={() => setCollapsedGuardKeys((prev) => ({ ...prev, [gg.guardId]: !prev[gg.guardId] }))}
                >
                  <View style={styles.guardGroupHeaderCopy}>
                    <Text style={styles.guardGroupName}>{gg.guardName}</Text>
                    <Text style={styles.guardGroupMeta}>
                      {gg.totals.count} shift{gg.totals.count !== 1 ? 's' : ''} · {gg.totals.claimedHours.toFixed(2)} claimed h · {gg.totals.approvedHours.toFixed(2)} approved h · {gg.totals.reviewedCount}/{gg.totals.count} reviewed
                    </Text>
                  </View>
                  <Text style={styles.guardGroupToggle}>{isGuardCollapsed ? 'Expand' : 'Collapse'}</Text>
                </Pressable>

                {!isGuardCollapsed && (
                  <>
                    <View style={styles.shiftRowsHeader}>
                      <Text style={[styles.shiftHeaderText, styles.shiftDateCol]}>Date</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftScheduledCol]}>Scheduled</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftAttendanceCol]}>Attendance</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftClaimCol]}>Guard Claim</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftApprovedCol]}>Guard Pay Approved</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftStatusCol]}>Status</Text>
                      <Text style={[styles.shiftHeaderText, styles.shiftActionCol]}>Review</Text>
                    </View>

                    {gg.rows.map((entry) => {
                      const statusPalette = getStatusPalette(entry.displayStatus);
                      const isSelected = entry.timesheet.id === selectedTimesheetId;
                      const isSubmitted = normalizeStatus(entry.displayStatus) === 'submitted';
                      const approveBusy = busyAction === `approve-${entry.timesheet.id}`;
                      const returnBusy = busyAction === `return-${entry.timesheet.id}`;
                      const approvedHrs = getApprovedHoursValue(entry.timesheet);
                      return (
                        <Pressable
                          key={entry.timesheet.id}
                          style={[styles.shiftRow, isSelected && styles.shiftRowSelected]}
                          onPress={() => setSelectedTimesheetId(entry.timesheet.id)}
                        >
                          <Text style={[styles.shiftCell, styles.shiftDateCol]}>{entry.shiftDateLabel}</Text>
                          <Text style={[styles.shiftCell, styles.shiftScheduledCol]}>{entry.scheduledLabel}</Text>
                          <Text style={[styles.shiftCell, styles.shiftAttendanceCol]}>{entry.attendanceLabel}</Text>
                          <Text style={[styles.shiftCell, styles.shiftClaimCol]}>{toHours(entry.timesheet.hoursWorked).toFixed(2)} h</Text>
                          <Text style={[styles.shiftCell, styles.shiftApprovedCol]}>{approvedHrs !== null ? `${approvedHrs.toFixed(2)} h` : '—'}</Text>
                          <View style={[styles.shiftStatusBadge, styles.shiftStatusCol, { backgroundColor: statusPalette.bg }]}>
                            <Text style={[styles.shiftStatusText, { color: statusPalette.text }]}>{formatStatusLabel(entry.displayStatus)}</Text>
                          </View>
                          <View style={[styles.shiftActionCol, styles.shiftRowActions]}>
                            <Pressable style={styles.reviewChip} onPress={() => setSelectedTimesheetId(entry.timesheet.id)}>
                              <Text style={styles.reviewChipText}>Review</Text>
                            </Pressable>
                            {isSubmitted && (
                              <>
                                <Pressable style={styles.approveChip} onPress={() => handleApprove(entry)} disabled={approveBusy || Boolean(busyAction)}>
                                  <Text style={styles.approveChipText}>{approveBusy ? '…' : 'Approve'}</Text>
                                </Pressable>
                                <Pressable style={styles.returnChip} onPress={() => handleReturn(entry)} disabled={returnBusy || Boolean(busyAction)}>
                                  <Text style={styles.returnChipText}>{returnBusy ? '…' : 'Return'}</Text>
                                </Pressable>
                              </>
                            )}
                          </View>
                        </Pressable>
                      );
                    })}
                  </>
                )}
              </View>
            );
          })}
        </View>

        {/* Review detail panel */}
        <View style={styles.detailCard}>
          <Text style={styles.detailTitle}>Timesheet Review</Text>
          <Text style={styles.detailSubtitle}>Select a shift row to review guard hours and record a decision.</Text>

          {activeSelected ? (
            <>
              <View style={styles.detailMetaGrid}>
                <View style={styles.detailMetaItem}>
                  <Text style={styles.detailMetaLabel}>Guard</Text>
                  <Text style={styles.detailMetaValue}>{selectedTimesheet?.guardName}</Text>
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
                <Text style={styles.detailSectionTitle}>SCHEDULED</Text>
                <Text style={styles.detailLine}>Book On: {formatTimeLabel(activeSelected.scheduledStartAt || activeSelected.shift?.start)}</Text>
                <Text style={styles.detailLine}>Book Off: {formatTimeLabel(activeSelected.scheduledEndAt || activeSelected.shift?.end)}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>ATTENDANCE</Text>
                <Text style={styles.detailLine}>Check-in: {formatDateTimeLabel(activeSelected.actualCheckInAt)}</Text>
                <Text style={styles.detailLine}>Check-out: {formatDateTimeLabel(activeSelected.actualCheckOutAt)}</Text>
                <Text style={styles.detailLine}>Recorded: {activeSelected.workedMinutes ?? 0} min</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>GUARD CLAIM</Text>
                <Text style={styles.detailLine}>Claimed hours: {selectedClaimedHours.toFixed(2)} h</Text>
                <Text style={styles.detailLine}>Submitted: {activeSelected.submittedAt ? formatDateTimeLabel(activeSelected.submittedAt) : 'Not submitted'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>COMPANY GUARD-PAY APPROVAL</Text>
                <Text style={styles.detailLine}>Guard Pay Hours: {selectedApprovedHours !== null ? `${selectedApprovedHours.toFixed(2)} h` : 'Not approved yet'}</Text>
                {activeSelected.companyApprovedStartAt && <Text style={styles.detailLine}>Approved On: {formatTimeLabel(activeSelected.companyApprovedStartAt)}</Text>}
                {activeSelected.companyApprovedEndAt && <Text style={styles.detailLine}>Approved Off: {formatTimeLabel(activeSelected.companyApprovedEndAt)}</Text>}
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailSectionTitle}>Guard note</Text>
                <Text style={styles.detailParagraph}>{activeSelected.guardNote?.trim() ? activeSelected.guardNote : 'No guard note provided.'}</Text>
              </View>

              {isSubmittedForReview ? (
                <>
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
                    <Text style={styles.detailSectionTitle}>Guard Pay Hours</Text>
                    <Text style={styles.detailLine}>Claimed hours remain read-only so the original submission stays intact.</Text>
                    <TextInput
                      value={approvedHoursInput}
                      onChangeText={setApprovedHoursInput}
                      style={styles.input}
                      keyboardType="decimal-pad"
                      placeholder={formatHoursInput(activeSelected.hoursWorked)}
                      placeholderTextColor="#64748b"
                    />
                    {adjustedHoursRequireNote && <Text style={styles.validationText}>Add a company note when approved hours differ from claimed hours.</Text>}
                  </View>

                  <View style={styles.detailActions}>
                    <Pressable style={styles.secondaryButton} onPress={handleSaveCompanyNote} disabled={busyAction === `note-${activeSelected.id}` || Boolean(busyAction)}>
                      <Text style={styles.secondaryButtonText}>{busyAction === `note-${activeSelected.id}` ? 'Saving...' : 'Save review details'}</Text>
                    </Pressable>
                    <Pressable style={styles.primaryButton} onPress={() => handleApprove(selectedTimesheet!)} disabled={busyAction === `approve-${activeSelected.id}` || Boolean(busyAction)}>
                      <Text style={styles.primaryButtonText}>{busyAction === `approve-${activeSelected.id}` ? 'Approving...' : 'Approve'}</Text>
                    </Pressable>
                    <Pressable style={styles.warningButton} onPress={() => handleReturn(selectedTimesheet!)} disabled={busyAction === `return-${activeSelected.id}` || Boolean(busyAction)}>
                      <Text style={styles.warningButtonText}>{busyAction === `return-${activeSelected.id}` ? 'Returning...' : 'Return for correction'}</Text>
                    </Pressable>
                    <Pressable style={styles.dangerButton} onPress={() => handleReject(selectedTimesheet!)} disabled={busyAction === `reject-${activeSelected.id}` || Boolean(busyAction)}>
                      <Text style={styles.dangerButtonText}>{busyAction === `reject-${activeSelected.id}` ? 'Rejecting...' : 'Reject'}</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <View style={[
                  styles.workflowStatePanel,
                  normalizeStatus(activeSelected.approvalStatus) === 'approved' && { backgroundColor: colors.successSurface },
                  normalizeStatus(activeSelected.approvalStatus) === 'rejected' && { backgroundColor: colors.dangerSurface },
                  normalizeStatus(activeSelected.approvalStatus) === 'returned' && { backgroundColor: colors.warningSurface },
                ]}>
                  {(normalizeStatus(activeSelected.approvalStatus) === 'draft') && (
                    <>
                      <Text style={styles.workflowStatePanelTitle}>Awaiting Guard Submission</Text>
                      <Text style={styles.workflowStatePanelText}>The Guard must submit this timesheet before Company review.</Text>
                    </>
                  )}
                  {(normalizeStatus(activeSelected.approvalStatus) === 'returned') && (
                    <>
                      <Text style={styles.workflowStatePanelTitle}>Awaiting Guard Resubmission</Text>
                      <Text style={styles.workflowStatePanelText}>This timesheet was returned to the Guard for correction. Awaiting their resubmission.</Text>
                    </>
                  )}
                  {(normalizeStatus(activeSelected.approvalStatus) === 'approved') && (
                    <>
                      <Text style={[styles.workflowStatePanelTitle, { color: colors.success }]}>
                        Guard Pay Approved: {selectedApprovedHours !== null ? `${selectedApprovedHours.toFixed(2)} h` : '—'}
                      </Text>
                      {activeGroup.clientSubmissionStatus ? (
                        <Text style={styles.workflowStatePanelText}>
                          {'Included in Client Timesheet — '}{clientSubmissionStatusLabel(activeGroup.clientSubmissionStatus)}.
                        </Text>
                      ) : (
                        <Text style={styles.workflowStatePanelText}>
                          Not yet included in a Client Timesheet. Send this week to the client to include it.
                        </Text>
                      )}
                    </>
                  )}
                  {(normalizeStatus(activeSelected.approvalStatus) === 'rejected') && (
                    <>
                      <Text style={[styles.workflowStatePanelTitle, { color: colors.danger }]}>Company Review Complete — Rejected</Text>
                      <Text style={styles.workflowStatePanelText}>
                        This shift has been rejected and will not be included in the Client weekly timesheet.
                      </Text>
                    </>
                  )}
                </View>
              )}
            </>
          ) : (
            <Text style={styles.emptyText}>Select a shift row to review guard hours and record an approval decision.</Text>
          )}
        </View>
      </View>

      {sendModal}
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: 18 },
  workspaceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  headerCopy: { gap: 4 },
  title: { color: colors.primaryNavy, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, fontSize: 14 },
  headerActions: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },

  primaryButton: { backgroundColor: colors.primaryNavy, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  primaryButtonText: { color: colors.background, fontWeight: '700' },
  secondaryButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.pendingSurface },
  secondaryButtonText: { color: colors.primaryNavy, fontWeight: '700' },
  warningButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.warningSurface },
  warningButtonText: { color: colors.warning, fontWeight: '700' },
  dangerButton: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.dangerSurface },
  dangerButtonText: { color: colors.danger, fontWeight: '700' },

  feedbackCard: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  feedbackSuccess: { backgroundColor: colors.successSurface },
  feedbackError: { backgroundColor: colors.dangerSurface },
  feedbackInfo: { backgroundColor: colors.infoSurface },
  feedbackTitle: { color: colors.primaryNavy, fontWeight: '800', fontSize: 15 },
  feedbackText: { color: colors.primaryNavySoft, fontSize: 13, lineHeight: 18 },

  filterCard: { backgroundColor: colors.card, borderRadius: 22, padding: 18, gap: 12 },
  weekNavRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  weekNavBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.pendingSurface },
  weekNavBtnDisabled: { opacity: 0.35 },
  weekNavBtnText: { color: colors.primaryNavy, fontWeight: '700', fontSize: 13 },
  weekNavLabel: { flex: 1, color: colors.primaryNavy, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  weekNavCurrentBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.infoSurface },
  weekNavCurrentBtnText: { color: colors.info, fontWeight: '700', fontSize: 13 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  filterField: { minWidth: 150, flexGrow: 1, gap: 6 },
  filterLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingHorizontal: 14, paddingVertical: 12, color: colors.primaryNavyStrong },
  webSelect: { borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: '14px 16px', fontSize: 14, color: colors.primaryNavyStrong, minHeight: 48 },

  kpiRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  kpiCard: { flexGrow: 1, minWidth: 120, backgroundColor: colors.card, borderRadius: 18, padding: 16, gap: 4 },
  kpiCardAccent: { backgroundColor: colors.warningSurface },
  kpiValue: { color: colors.primaryNavy, fontSize: 28, fontWeight: '800' },
  kpiLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },

  groupList: { gap: 12 },
  siteWeekCard: { backgroundColor: colors.card, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: colors.pendingSurface },
  siteWeekCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  siteWeekCardInfo: { flex: 1, gap: 4 },
  siteWeekSiteName: { color: colors.primaryNavy, fontSize: 18, fontWeight: '800' },
  siteWeekPeriod: { color: colors.textSecondary, fontSize: 13 },
  siteWeekMeta: { color: colors.textSecondary, fontSize: 13 },
  siteWeekCardActions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  reviewSiteButton: { backgroundColor: colors.primaryNavy, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  reviewSiteButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },

  unreviewedWarning: { color: colors.warning, fontSize: 12, fontWeight: '700', marginTop: 4 },
  sendToClientButton: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.accentTeal ?? '#0d9488' },
  sendToClientButtonDisabled: { opacity: 0.35 },
  sendToClientText: { color: '#ffffff', fontWeight: '700', fontSize: 12 },

  badgeAwaitingGuard: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.pendingSurface },
  badgeNeedsReview: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.warningSurface },
  badgeReady: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.successSurface },
  badgeAwaitingClient: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.infoSurface },
  badgeReturned: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.dangerSurface },
  badgeClientApproved: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.successSurface },
  badgeFinalised: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.pendingSurface },
  badgeText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, color: colors.primaryNavy },

  emptyCard: { backgroundColor: colors.card, borderRadius: 20, padding: 24 },
  emptyText: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },

  // Detail view
  backButton: { alignSelf: 'flex-start', paddingVertical: 10 },
  backButtonText: { color: colors.info, fontWeight: '700', fontSize: 14 },
  detailPageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  detailPageHeaderCopy: { flex: 1, gap: 4 },
  detailPageTitle: { color: colors.primaryNavy, fontSize: 24, fontWeight: '800' },
  detailPageWeek: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
  detailPageMeta: { color: colors.textSecondary, fontSize: 13 },
  detailPageActions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },

  reviewLayout: { flexDirection: 'row', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' },
  guardListCard: { flex: 2, minWidth: 520, gap: 12 },

  guardGroupCard: { borderWidth: 1, borderColor: colors.pendingSurface, borderRadius: 18, overflow: 'hidden', backgroundColor: colors.card },
  guardGroupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: colors.background },
  guardGroupHeaderCopy: { flex: 1, gap: 3 },
  guardGroupName: { color: colors.primaryNavy, fontSize: 16, fontWeight: '800' },
  guardGroupMeta: { color: colors.textSecondary, fontSize: 13 },
  guardGroupToggle: { color: colors.info, fontWeight: '700', fontSize: 12 },

  shiftRowsHeader: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.pendingSurface, backgroundColor: colors.card },
  shiftHeaderText: { color: colors.textSecondary, fontWeight: '700', fontSize: 11, textTransform: 'uppercase' },
  shiftRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.pendingSurface },
  shiftRowSelected: { backgroundColor: colors.infoSurface },
  shiftRowActions: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  shiftCell: { color: colors.primaryNavySoft, fontSize: 12 },
  shiftDateCol: { flex: 0.9 },
  shiftScheduledCol: { flex: 1 },
  shiftAttendanceCol: { flex: 1 },
  shiftClaimCol: { flex: 0.7 },
  shiftApprovedCol: { flex: 0.7 },
  shiftStatusCol: { flex: 0.8 },
  shiftActionCol: { flex: 1.2 },
  shiftStatusBadge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  shiftStatusText: { fontWeight: '800', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  reviewChip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.pendingSurface },
  reviewChipText: { color: colors.primaryNavy, fontWeight: '700', fontSize: 11 },
  approveChip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.successSurface },
  approveChipText: { color: colors.success, fontWeight: '700', fontSize: 11 },
  returnChip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.warningSurface },
  returnChipText: { color: colors.warning, fontWeight: '700', fontSize: 11 },

  detailCard: { flex: 1, minWidth: 320, backgroundColor: colors.card, borderRadius: 22, padding: 18, gap: 14, borderWidth: 1, borderColor: colors.infoSurface },
  detailTitle: { color: colors.primaryNavy, fontSize: 18, fontWeight: '800' },
  detailSubtitle: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  detailMetaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailMetaItem: { minWidth: 120, flexGrow: 1, gap: 4 },
  detailMetaLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  detailMetaValue: { color: colors.primaryNavy, fontSize: 14, fontWeight: '700' },
  detailStatusBadge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  detailStatusBadgeText: { fontWeight: '800', fontSize: 11, textTransform: 'uppercase' },
  detailSection: { gap: 6, borderTopWidth: 1, borderTopColor: colors.pendingSurface, paddingTop: 12 },
  detailSectionTitle: { color: colors.primaryNavy, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  detailLine: { color: colors.primaryNavySoft, fontSize: 13, lineHeight: 18 },
  detailParagraph: { color: colors.primaryNavySoft, fontSize: 13, lineHeight: 20 },
  validationText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  noteInput: { minHeight: 90, textAlignVertical: 'top' },
  detailActions: { gap: 8 },

  // Send-to-client modal
  sendOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sendCard: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '100%', maxWidth: 680, maxHeight: '90%' },
  sendTitle: { fontSize: 18, fontWeight: '800', color: colors.primaryNavy },
  sendMeta: { fontSize: 14, color: colors.primaryNavySoft },
  sendWarningBanner: { backgroundColor: colors.warningSurface, borderRadius: 10, padding: 12 },
  sendWarningText: { color: colors.warning, fontWeight: '700', fontSize: 13 },
  sendRow: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 8 },
  sendRowExcluded: { borderColor: colors.danger, backgroundColor: colors.dangerSurface },
  sendCheckRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  sendCheckbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: colors.primaryNavy, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', marginTop: 2 },
  sendCheckboxChecked: { backgroundColor: colors.primaryNavy },
  sendCheckmark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  sendGuardName: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy },
  sendShiftMeta: { fontSize: 12, color: colors.textSecondary, lineHeight: 18 },
  sendExcludedLabel: { fontSize: 11, color: colors.danger, fontWeight: '800', textTransform: 'uppercase', marginTop: 2 },
  sendExclusionInput: { borderWidth: 1, borderColor: colors.danger, borderRadius: 8, padding: 8, fontSize: 13, backgroundColor: '#fff', color: colors.primaryNavyStrong },
  sendSummary: { backgroundColor: colors.infoSurface, borderRadius: 12, padding: 14 },
  sendSummaryText: { fontSize: 14, fontWeight: '700', color: colors.primaryNavy },
  sendNoteInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, minHeight: 64, textAlignVertical: 'top', fontSize: 13, backgroundColor: '#fff', color: colors.primaryNavyStrong },
  sendErrorText: { fontSize: 13, color: colors.danger, fontWeight: '700' },
  sendEmptyText: { fontSize: 13, color: colors.textSecondary, fontStyle: 'italic' },
  sendActions: { flexDirection: 'row', gap: 10 },
  sendSubmitButton: { flex: 1, backgroundColor: colors.accentTeal ?? '#0d9488', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  sendButtonDisabled: { opacity: 0.4 },
  sendSubmitText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  sendCancelButton: { flex: 1, backgroundColor: colors.pendingSurface, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  sendCancelText: { color: colors.primaryNavy, fontWeight: '700', fontSize: 14 },

  workflowStatePanel: { backgroundColor: colors.pendingSurface, borderRadius: 14, padding: 16, marginTop: 8, gap: 6 },
  workflowStatePanelTitle: { color: colors.primaryNavy, fontSize: 14, fontWeight: '800' },
  workflowStatePanelText: { color: colors.primaryNavy, fontSize: 13, lineHeight: 18 },

  openClientTimesheetButton: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.infoSurface, gap: 2 },
  openClientTimesheetText: { color: colors.info, fontWeight: '800', fontSize: 12 },
  clientTimesheetStatusText: { color: colors.info, fontSize: 11, fontWeight: '600' },
});
