import * as React from 'react';
import { Fragment } from 'react/jsx-runtime';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { ShiftOperationsView } from '../../types/models';
import {
  logBookCell,
  operationalExceptions,
  operationsDetailLines,
  welfareCell,
  type OperationsTone,
} from './operationsPresentation';
import {
  DEFAULT_SITE_TIME_ZONE,
  formatInstantTime,
  formatUkDate,
  formatUkDateTime,
  formatUkRange,
  shiftSiteDateInput,
  siteToday,
} from '../../services/siteTime';
import type { BoardInclusion } from './liveOperationsPolicy';
import { hoursPastEnd, type BoardDateMode } from './liveOperationsBoard';
import { completedWithoutBookOffLabel, isCompletedWithoutBookOff, isEligibleForReconciliation } from './shiftReconciliation';
import { isEligibleForExtension } from './shiftAmendments';
import { NativeDateInput } from './NativeDateInput';
import { CompanyOperationsTimeline } from './CompanyOperationsTimeline';
import { countStatusWord, countText, safeCount, type SafeCount, type SourceState } from './sourceAvailability';
import {
  buildHandovers,
  buildNextUp,
  type Handover,
  type NextUpEvent,
  type OutlookShiftInput,
} from './operationsOutlook';
import { buildTodaySoFar, type TodaySoFar } from './operationsSummary';
import { incidentAttentionActions } from './incidentLifecycle';
import { logTypeLabel } from './logBookRegister';
import { safetyAlertDrawerLabel, welfareIntervalLabel, welfareWindowRows, type WelfareDisplayState } from './welfareMonitoring';
import { COVERAGE_TONE, COVERAGE_WORD, coverageSentence, earlyBookOffMinutes, formatDuration, staffingSentence } from './earlyBookOff';
import { WELFARE_MARKER_GLYPH } from './operationsTimeline';
import { Drawer } from '../ui/Drawer';
import { colors, radii, spacing } from '../../theme';
import { DailyLog, Incident, SafetyAlert, Shift, Timesheet } from '../../types/models';

const IS_WEB = typeof document !== 'undefined';
const WEB_PTR = IS_WEB ? ({ cursor: 'pointer' } as const) : null;
const UK_LOCALE = 'en-GB';
const MISSED_GRACE = 15;

// ─── Shift status options (must match CompanyDashboardScreen) ──────────────────
const SHIFT_STATUS_OPTS = [
  { label: 'Unfilled',    value: 'unfilled' },
  { label: 'Offered',     value: 'offered' },
  { label: 'Ready',       value: 'ready' },
  { label: 'Missed',      value: 'missed' },
  { label: 'Cancelled',   value: 'cancelled' },
  { label: 'Rejected',    value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed',   value: 'completed' },
];

// ─── Locally-declared types (structurally match CompanyDashboardScreen locals) ─

type UrgentCategory =
  | 'panic'
  | 'incident'
  | 'late_start'
  | 'missed_check_call'
  | 'rejected_offer'
  | 'safety'
  /** A Guard-raised non-emergency need at the site: fuel, log books, equipment, access, lighting. */
  | 'site_request'
  /** A shift that ended with no Book Off. Its own category so it is never read as generic safety. */
  | 'missing_book_off'
  /** A mandatory company compliance check lapsed during a live shift. Urgent, but never an SOS. */
  | 'compliance_lapse'
  | 'upcoming_risk'
  | 'missed_shift'
  | 'uncovered_shift';

export type UrgentOperationalItem = {
  id: string;
  /** An incident's own recorded severity (low / medium / high / critical); absent for other items. */
  severity?: string | null;
  shiftId?: number | null;
  incidentId?: number | null;
  alertId?: number | null;
  status?: string | null;
  siteName: string;
  guardName: string;
  category: UrgentCategory;
  issueType: string;
  message: string;
  occurredAt: string;
};

type OperationalActivityItem = {
  id: string;
  shiftId?: number | null;
  siteName: string;
  guardName: string;
  eventType: string;
  message: string;
  occurredAt: string;
};

export type LiveFilters = {
  clientId: string;
  siteId: string;
  guardId: string;
  date: string;
  status: string;
};

// ─── Exported pre-computed data types ─────────────────────────────────────────

/**
 * A shift in the Needs Reconciliation queue: worked, never booked off, more than 24 hours past its
 * scheduled end. Listed so it is never lost; nothing here changes it.
 */
export type ReconciliationRow = {
  shift: Shift;
  bookedOnAt: string | null;
  /** Open or acknowledged actionable alerts on the shift (Missing Book Off, Welfare summary...). */
  openAlerts: number;
};

export type LiveBoardRow = {
  shift: Shift;
  /**
   * Why the policy put this row on the board.
   *
   * Carried rather than recomputed so the counts, the metric filters and the rows can never disagree:
   * each reads this one value. Live Operations is the control room, not shift history, and this is the
   * reason a row is part of "now".
   */
  inclusion: BoardInclusion;
  /** True only when the reconciliation audit entry exists for this shift (Close without Book Off). */
  closedByControl: boolean;
  /** Server-computed monitoring. Presented as given; the board never recomputes a window or a count. */
  operations: ShiftOperationsView | null;
  attendance: { checkInAt: string | null; checkOutAt: string | null } | undefined;
  timesheet: Timesheet | undefined;
  shiftLogs: DailyLog[];
  shiftIncidents: Incident[];
  shiftAlerts: SafetyAlert[];
  lastCheckCall: DailyLog | undefined;
  panicOrWelfareCount: number;
  lifecycleStatus: string;
  risk: { level: 'high' | 'medium' | 'low'; label: string; color: string };
  delay: number | null;
  likelyLate: boolean;
  siteRiskLabel: string;
  primaryActionLabel: string;
  rowTone: string;
};

export type CloseOutSummary = {
  scheduledStart: string;
  scheduledEnd: string;
  actualCheckInAt: string | null;
  actualCheckOutAt: string | null;
  logsCount: number;
  incidentsCount: number;
  safetyEventsCount: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  timesheetStatus: string;
  unresolvedFollowUpCount: number;
  closedCleanly: boolean;
};

export type SelectedShiftContext = {
  shift: Shift;
  operations: ShiftOperationsView | null;
  attendance: { checkInAt: string | null; checkOutAt: string | null } | undefined;
  timesheet: Timesheet | undefined;
  logs: DailyLog[];
  incidents: Incident[];
  alerts: SafetyAlert[];
  lifecycleStatus: string;
  badge: { label: string; color: string; icon: string };
  exception: { title: string; message: string; outcome: string } | null;
  clientName: string;
  /** True only when the reconciliation audit entry exists for this shift. */
  closedByControl: boolean;
};

/**
 * Whether each Live Operations data source loaded on the latest attempt. A failed source is shown as
 * unavailable — never as zero, "Queue clear" or "nothing in progress". Omitted entries are ready.
 */
export type LiveOpsSourceStates = Partial<Record<
  'shifts' | 'attendance' | 'monitoring' | 'coverage' | 'incidents' | 'alerts' | 'dailyLogs',
  SourceState
>>;

/** 'error' if any of the given sources failed. */
function anyFailed(states: LiveOpsSourceStates, ...keys: Array<keyof LiveOpsSourceStates>): SourceState {
  return keys.some((key) => states[key] === 'error') ? 'error' : 'ready';
}

const SOURCE_LABELS: Record<keyof LiveOpsSourceStates, string> = {
  shifts: 'shifts',
  attendance: 'attendance',
  monitoring: 'Welfare and Log Book monitoring',
  coverage: 'coverage',
  incidents: 'incidents',
  alerts: 'safety alerts',
  dailyLogs: 'Log Book entries',
};

export type CompanyLiveOperationsWorkspaceProps = {
  /** See LiveOpsSourceStates. */
  sourceStates?: LiveOpsSourceStates;
  /**
   * shifts.manage. Without it the shortcut is not rendered at all, because the backend would refuse
   * the create anyway and offering the button would only produce a dead end.
   */
  canManageShifts: boolean;
  /** Opens the existing Rota Planner Add Shift drawer. No form lives in this component. */
  onAddShift: () => void;

  // Status counts
  liveShiftsCount: number;
  guardsNotBookedOnCount: number;
  /** Worked shifts past end + 15 minutes with no Book Off, under 24 hours. Never in liveShiftsCount. */
  overdueBookOffCount: number;
  /** Worked shifts more than 24 hours past their end with no Book Off. Independent of the selected date. */
  reconciliationRows: ReconciliationRow[];
  /** 'live' (no date), 'today' (the site's today selected) or 'day' (another day). */
  boardDateMode: BoardDateMode;
  /** Selects the site's today, re-centres the timeline on now and refreshes the data. */
  onToday: () => void;
  /**
   * Opens Close without Book Off for a shift (Phase 4). Absent when the user cannot manage shifts, so the
   * action is never offered to someone the API would refuse.
   */
  onReconcileShift?: (shiftId: number) => void;
  /**
   * Opens Shift extension for a shift (Live Shift Amendments). Absent when the user holds no amendment permission;
   * `amendmentsEnabled` is the company policy the API returned, so a switched-off company is never offered a proposal.
   */
  onManageExtension?: (shiftId: number) => void;
  amendmentsEnabled?: boolean;
  timelineRecentreSignal: number;
  activePanicAlertsCount: number;
  openIncidentsCount: number;
  missedCheckCallsCount: number;
  // Urgent queue
  urgentOperationalItems: UrgentOperationalItem[];
  urgentActionItemId: string | null;
  liveOperationsFeedback: { tone: 'success' | 'error'; message: string } | null;
  // Board
  liveOperationEnrichedRows: LiveBoardRow[];
  selectedShiftId: number | null;
  setSelectedShiftId: (id: number | null) => void;
  highlightedLiveShiftId: number | null;
  // Filters
  liveFilters: LiveFilters;
  setLiveFilters: React.Dispatch<React.SetStateAction<LiveFilters>>;
  siteClientOptions: Array<{ value: string; label: string }>;
  siteOptions: Array<{ value: string; label: string }>;
  linkedGuardOptions: Array<{ value: string; label: string }>;
  // Lower strip
  recentOperationalActivity: OperationalActivityItem[];
  /** Resolves a shift's SITE timezone. Live Operations renders every instant on the site's clock. */
  resolveShiftZone: (shiftId?: number | null) => string;
  // Detail panel
  selectedShiftContext: SelectedShiftContext | null;
  selectedShiftCloseOutSummary: CloseOutSummary | null;
  closeOutNotesDraft: string;
  setCloseOutNotesDraft: (text: string) => void;
  savingCloseOutNotes: boolean;
  // Action handlers
  refreshing: boolean;
  onLiveBoardPrimaryAction: (shift: Shift) => void;
  onOpenUrgentDetail: (item: UrgentOperationalItem) => void;
  onOpenUrgentShift: (item: UrgentOperationalItem) => void;
  onUrgentIncidentFollowUp: (item: UrgentOperationalItem, status: 'in_review' | 'resolved') => Promise<void>;
  onUrgentAlertFollowUp: (item: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>;
  /** Open the resolution dialog for an INCIDENT. Never the safety-alert path. */
  onOpenIncidentResolution: (item: UrgentOperationalItem) => void;
  onSaveCloseOutNotes: () => void;
  onOpenCoverage: (context?: { uncoveredOnly?: boolean; shiftId?: number }) => void;
  // Layout anchors
  /** The operational clock from the ONE existing refresh cycle. The timeline never keeps its own. */
  operationalNowMs: number;
  /** The instant the visible window is positioned around — the selected operational day. */
  timelineAnchorMs: number;
  /** Which day that is ('live', 'today' or YYYY-MM-DD): a change re-centres the timeline, a clock tick does not. */
  timelineAnchorKey?: string;
  /** Opens the server-built report dialog (Welfare Phase 3). */
  onOpenReport?: (kind: 'shift-attendance' | 'welfare-monitoring') => void;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  exporting: boolean;
  onBoardLayout: (y: number) => void;
  onDetailLayout: (y: number) => void;
};

// ─── Pure helpers (duplicated for component isolation) ────────────────────────

// Every time on this board is a TRUE INSTANT and must be read on the SITE's clock.
//
// These three used to lift the hour and minute straight out of the ISO string — `match[4]:match[5]` — so
// a shift stored as 10:10Z displayed as "10:10" while the Guard app correctly showed 11:10 BST. The
// Welfare column never had the bug, because it already went through operationsPresentation with the site
// timezone, so one row showed "Next 12:10" beside "10:10–11:10": two conventions in a single row.
//
// The timezone is now a REQUIRED argument rather than an optional one. An omission is a type error, not a
// silent fall back to UTC digits or to whatever zone the controller's browser happens to be in.

function fmtTime(value: string | null | undefined, timeZone: string): string {
  // A bare HH:MM (an operating-hours field) is already a clock reading, not an instant.
  if (value && /^\d{2}:\d{2}$/.test(value)) return value;
  return formatInstantTime(value, timeZone);
}

function fmtDateTime(value: string | null | undefined, timeZone: string): string {
  // DD-MM-YYYY · HH:MM on the site's clock (S4 Live Operations Phase 3).
  return formatUkDateTime(value, timeZone, 'Not recorded');
}

function fmtStatus(value?: string | null): string {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function fmtActivityType(eventType: string): string {
  switch (eventType) {
    case 'check_call':         return 'Check call';
    case 'incident_reported':  return 'Incident reported';
    case 'booked_on':          return 'Guard booked on';
    case 'booked_off':         return 'Guard booked off';
    case 'welfare_check':      return 'Welfare check';
    case 'panic_triggered':    return 'Panic alarm';
    case 'shift_started':      return 'Shift started';
    case 'shift_ended':        return 'Shift ended';
    default:                   return fmtStatus(eventType);
  }
}

function fmtDate(value: string | null | undefined, timeZone: string): string {
  // DD-MM-YYYY on the site's clock (S4 Live Operations Phase 3).
  return formatUkDate(value, timeZone, 'Not set');
}

function normalizeLifecycle(value?: string | null): string {
  const n = (value || '').trim().toLowerCase();
  if (['planned', 'unassigned', 'scheduled'].includes(n)) return 'unfilled';
  if (n === 'assigned') return 'offered';
  if (n === 'accepted') return 'ready';
  return n || 'unfilled';
}

function getStatusBadge(status: string): { label: string; color: string; icon: string } {
  switch (normalizeLifecycle(status)) {
    case 'missed':      return { label: 'Missed',     color: colors.warning,         icon: '⚠️' };
    case 'offered':     return { label: 'Offered',    color: colors.info,            icon: '🔵' };
    case 'ready':       return { label: 'Ready',      color: colors.warning,         icon: '🟡' };
    case 'in_progress': return { label: 'Live',       color: colors.success,         icon: '🟢' };
    case 'completed':   return { label: 'Completed',  color: colors.primaryNavySoft, icon: '⚫' };
    case 'rejected':    return { label: 'Rejected',   color: colors.danger,          icon: '🔴' };
    case 'cancelled':   return { label: 'Cancelled',  color: colors.neutralSlate,    icon: '⚫' };
    default:            return { label: 'Unfilled',   color: colors.textSecondary,   icon: '⚪' };
  }
}

function getExceptionSummary(status?: string | null): { title: string; message: string; outcome: string } | null {
  switch (normalizeLifecycle(status || 'unfilled')) {
    case 'missed':
      return {
        title: 'Missed check-in exception',
        message: `No attendance check-in was recorded within ${MISSED_GRACE} minutes of shift start.`,
        outcome: 'Needs re-cover now and may need attendance follow-up.',
      };
    case 'rejected':
      return {
        title: 'Offer rejected',
        message: 'The assigned guard rejected this shift before it became live.',
        outcome: 'Needs fresh cover, but not attendance escalation.',
      };
    case 'cancelled':
      return {
        title: 'Shift cancelled',
        message: 'This shift was cancelled by the company.',
        outcome: 'No re-cover action is needed unless the work is replanned.',
      };
    default:
      return null;
  }
}

function getAttentionSeverity(category: UrgentCategory): 'red' | 'amber' | 'blue' {
  if (['panic', 'incident', 'missed_shift', 'compliance_lapse'].includes(category)) return 'red';
  if (['late_start', 'missed_check_call', 'uncovered_shift', 'rejected_offer', 'safety'].includes(category)) return 'amber';
  // A Site Request is a need, not a risk. Colouring it like a welfare lapse would train the control
  // room to discount the colour that matters.
  return 'blue';
}

function getAttentionLabel(category: UrgentCategory): string {
  switch (category) {
    case 'panic':            return 'Critical';
    case 'incident':         return 'Incident';
    case 'late_start':       return 'Late start';
    case 'missed_check_call':return 'Miss check';
    case 'rejected_offer':   return 'Rejected';
    case 'safety':           return 'Welfare';
    case 'site_request':     return 'Site Request';
    case 'upcoming_risk':    return 'Risk shift';
    case 'missed_shift':     return 'Missed';
    case 'missing_book_off': return 'Missing Book Off';
    case 'compliance_lapse': return 'Compliance';
    case 'uncovered_shift':  return 'Coverage gap';
    default:                 return 'Alert';
  }
}

function getUrgentPrimaryLabel(item: UrgentOperationalItem): string {
  switch (item.category) {
    case 'rejected_offer':
    case 'missed_shift':    return 'Open Re-cover';
    case 'incident':        return 'View Incident';
    case 'panic':           return item.status === 'acknowledged' ? 'Resolve Alert' : 'View Alert';
    case 'missed_check_call': return item.status === 'acknowledged' ? 'Close Follow-up' : 'View Safety Detail';
    case 'safety':          return item.status === 'acknowledged' ? 'Close Alert' : 'View Safety Detail';
    case 'site_request':    return item.status === 'acknowledged' ? 'Close Request' : 'View Request';
    default:                return 'Open Shift';
  }
}

function getAttendanceState(row: LiveBoardRow, timeZone: string): { primary: string; secondary: string | null; color: string } {
  const { lifecycleStatus, attendance } = row;
  if (lifecycleStatus === 'in_progress') {
    if (attendance?.checkInAt) {
      return { primary: '● On site', secondary: fmtTime(attendance.checkInAt, timeZone), color: colors.success };
    }
    return { primary: '⚠ Not booked on', secondary: null, color: colors.warning };
  }
  if (lifecycleStatus === 'missed') {
    return { primary: '✕ Missed', secondary: null, color: colors.danger };
  }
  if (lifecycleStatus === 'completed') {
    return {
      primary: '● Off site',
      secondary: attendance?.checkOutAt ? fmtTime(attendance.checkOutAt, timeZone) : null,
      color: colors.textSecondary,
    };
  }
  if (['ready', 'offered'].includes(lifecycleStatus)) {
    return { primary: '○ Not started', secondary: null, color: colors.textMuted };
  }
  return { primary: '—', secondary: null, color: colors.textMuted };
}

// ─── WebSelect (compact, filter-bar variant) ──────────────────────────────────

function WSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { setReady(typeof document !== 'undefined'); }, []);

  if (ready) {
    const Sel: any = 'select';
    const Opt: any = 'option';
    return (
      <Sel
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
        style={wSelectStyle}
        aria-label={placeholder || 'Select'}
      >
        <Opt value="">{placeholder || 'All'}</Opt>
        {options.map((o) => <Opt key={o.value} value={o.value}>{o.label}</Opt>)}
      </Sel>
    );
  }
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      style={styles.filterInput}
    />
  );
}

const wSelectStyle = {
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.card,
  padding: '4px 8px',
  fontSize: 12,
  color: colors.primaryNavyStrong,
  minHeight: 32,
  flex: 1,
} as const;

// ─── MetricFocus ──────────────────────────────────────────────────────────────

type MetricFocus = 'all' | 'live' | 'not-booked' | 'no-book-off' | 'panic' | 'incidents' | 'missed-checks';

// ─── LiveOpsStatusBar ─────────────────────────────────────────────────────────

type StatusDotTone = 'aqua' | 'warning' | 'danger' | null;

function StatusMetric({
  count, label, tone: knownTone, active, onPress,
}: {
  count: SafeCount; label: string; tone: StatusDotTone; active: boolean; onPress: () => void;
}) {
  // An unavailable figure is flagged in warning colour; a stale one keeps its (non-zero) severity.
  const tone: StatusDotTone = count.kind === 'unavailable' ? 'warning' : count.kind === 'loading' ? null : knownTone;
  const statusWord = countStatusWord(count);
  const dotColor =
    tone === 'aqua'    ? colors.accentAqua :
    tone === 'warning' ? colors.warning :
    tone === 'danger'  ? colors.danger :
    colors.border;
  const valueColor =
    tone === 'aqua'    ? colors.accentAqua :
    tone === 'warning' ? colors.warning :
    tone === 'danger'  ? colors.danger :
    colors.textPrimary;
  const activeBg =
    active && tone === 'aqua'    ? `${colors.accentAqua}18` :
    active && tone === 'warning' ? `${colors.warning}18` :
    active && tone === 'danger'  ? `${colors.danger}18` :
    undefined;
  return (
    <Pressable
      style={[styles.statusMetric, activeBg ? { backgroundColor: activeBg } : null, IS_WEB ? (WEB_PTR as any) : null]}
      onPress={onPress}
    >
      <View style={styles.statusMetricRow}>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <Text style={[styles.statusMetricValue, { color: valueColor }]}>{countText(count)}</Text>
      </View>
      <Text style={styles.statusMetricLabel}>{label}</Text>
      {statusWord ? <Text style={styles.statusMetricState}>{statusWord}</Text> : null}
      {active && <View style={styles.statusMetricActiveLine} />}
    </Pressable>
  );
}

function LiveOpsStatusBar({
  sources,
  liveShiftsCount,
  guardsNotBookedOnCount,
  overdueBookOffCount,
  activePanicAlertsCount,
  openIncidentsCount,
  missedCheckCallsCount,
  metricFocus,
  onMetricPress,
}: {
  liveShiftsCount: number;
  guardsNotBookedOnCount: number;
  overdueBookOffCount: number;
  activePanicAlertsCount: number;
  openIncidentsCount: number;
  missedCheckCallsCount: number;
  metricFocus: MetricFocus;
  onMetricPress: (f: MetricFocus) => void;
  sources: LiveOpsSourceStates;
}) {
  const live = safeCount(liveShiftsCount, anyFailed(sources, 'shifts', 'attendance'));
  const notBookedOn = safeCount(guardsNotBookedOnCount, anyFailed(sources, 'shifts', 'attendance'));
  const noBookOff = safeCount(overdueBookOffCount, anyFailed(sources, 'shifts', 'attendance'));
  const panic = safeCount(activePanicAlertsCount, anyFailed(sources, 'alerts'));
  const incidents = safeCount(openIncidentsCount, anyFailed(sources, 'incidents'));
  const missedChecks = safeCount(missedCheckCallsCount, anyFailed(sources, 'alerts'));
  return (
    <View style={styles.statusBar}>
      <StatusMetric count={live}         label="Live shifts"    tone={liveShiftsCount > 0        ? 'aqua'    : null} active={metricFocus === 'live'}          onPress={() => onMetricPress('live')} />
      <View style={styles.statusBarSep} />
      <StatusMetric count={notBookedOn}  label="Not booked on"  tone={guardsNotBookedOnCount > 0 ? 'warning' : null} active={metricFocus === 'not-booked'}    onPress={() => onMetricPress('not-booked')} />
      <View style={styles.statusBarSep} />
      <StatusMetric count={noBookOff}    label="No Book Off"    tone={overdueBookOffCount > 0    ? 'warning' : null} active={metricFocus === 'no-book-off'}   onPress={() => onMetricPress('no-book-off')} />
      <View style={styles.statusBarSep} />
      <StatusMetric count={panic}        label="Panic alerts"   tone={activePanicAlertsCount > 0 ? 'danger'  : null} active={metricFocus === 'panic'}         onPress={() => onMetricPress('panic')} />
      <View style={styles.statusBarSep} />
      <StatusMetric count={incidents}    label="Open incidents" tone={openIncidentsCount > 0     ? 'danger'  : null} active={metricFocus === 'incidents'}     onPress={() => onMetricPress('incidents')} />
      <View style={styles.statusBarSep} />
      <StatusMetric count={missedChecks} label="Missed checks"  tone={missedCheckCallsCount > 0  ? 'warning' : null} active={metricFocus === 'missed-checks'} onPress={() => onMetricPress('missed-checks')} />
    </View>
  );
}

// ─── MetricFocusHint ──────────────────────────────────────────────────────────

const METRIC_FOCUS_LABELS: Record<MetricFocus, string> = {
  'all': '', 'live': 'Live shifts', 'not-booked': 'Not booked on', 'no-book-off': 'No Book Off',
  'panic': 'Panic alerts', 'incidents': 'Open incidents', 'missed-checks': 'Missed checks',
};

function MetricFocusHint({ metricFocus, onClear }: { metricFocus: MetricFocus; onClear: () => void }) {
  if (metricFocus === 'all') return null;
  return (
    <View style={styles.metricFocusHint}>
      <Text style={styles.metricFocusHintText}>Showing: {METRIC_FOCUS_LABELS[metricFocus]}</Text>
      <Pressable style={[styles.metricFocusHintClear, IS_WEB ? (WEB_PTR as any) : null]} onPress={onClear}>
        <Text style={styles.metricFocusHintClearText}>Clear ×</Text>
      </Pressable>
    </View>
  );
}

// ─── LiveOpsFilterToolbar ─────────────────────────────────────────────────────

/** The shared date input, sized to sit in this toolbar beside the 32px selects. A plain object: on web it
 *  is spread onto a DOM element, where a StyleSheet reference would not apply. */
const LIVE_DATE_INPUT_STYLE = {
  height: 32,
  minWidth: 132,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  paddingHorizontal: spacing.sm,
  fontSize: 12,
  color: colors.primaryNavyStrong,
};

function LiveOpsFilterToolbar({
  liveFilters,
  setLiveFilters,
  siteClientOptions,
  siteOptions,
  linkedGuardOptions,
  operationalTimeZone,
  boardDateMode,
  onToday,
}: {
  liveFilters: LiveFilters;
  setLiveFilters: React.Dispatch<React.SetStateAction<LiveFilters>>;
  siteClientOptions: Array<{ value: string; label: string }>;
  siteOptions: Array<{ value: string; label: string }>;
  linkedGuardOptions: Array<{ value: string; label: string }>;
  /** The zone the day steps are resolved against — the site's, never the device's. */
  operationalTimeZone: string;
  boardDateMode: BoardDateMode;
  onToday: () => void;
}) {
  const todayActive = boardDateMode !== 'day';
  /**
   * Day navigation writes to `liveFilters.date` — the ONE operational date the timeline, the filters,
   * the counts and the export all read. A second date state is how a controller ends up exporting a
   * different day from the one on screen.
   *
   * An empty date means "live", so stepping from empty starts at the site's today rather than at the
   * device's, and at 00:30 in London a New York site correctly starts on its own previous day.
   */
  const stepDay = (days: number) => setLiveFilters((prev) => ({
    ...prev,
    date: shiftSiteDateInput(prev.date || siteToday(operationalTimeZone), days),
  }));
  return (
    <View style={styles.filterBar}>
      <WSelect value={liveFilters.clientId} onChange={(v) => setLiveFilters((f) => ({ ...f, clientId: v }))} options={siteClientOptions} placeholder="Client" />
      <WSelect value={liveFilters.siteId}   onChange={(v) => setLiveFilters((f) => ({ ...f, siteId: v }))}   options={siteOptions}       placeholder="Site" />
      <WSelect value={liveFilters.guardId}  onChange={(v) => setLiveFilters((f) => ({ ...f, guardId: v }))}  options={linkedGuardOptions} placeholder="Guard" />
      <View style={styles.dateNav}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          style={[styles.dateNavBtn, IS_WEB ? (WEB_PTR as any) : null]}
          onPress={() => stepDay(-1)}
        >
          <Text style={styles.dateNavBtnText}>‹</Text>
        </Pressable>
        {/* The browser's own date picker on web (React Native Web's TextInput dropped `type="date"`, so
            this used to be a plain text box); a typed ISO field elsewhere. */}
        <NativeDateInput
          value={liveFilters.date}
          onChange={(v: string) => setLiveFilters((f) => ({ ...f, date: v }))}
          accessibilityLabel="Operational date"
          style={LIVE_DATE_INPUT_STYLE}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next day"
          style={[styles.dateNavBtn, IS_WEB ? (WEB_PTR as any) : null]}
          onPress={() => stepDay(1)}
        >
          <Text style={styles.dateNavBtnText}>›</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Today"
          accessibilityState={{ selected: todayActive }}
          style={[styles.dateNavToday, todayActive ? styles.dateNavTodayActive : null, IS_WEB ? (WEB_PTR as any) : null]}
          // Selects the site's today (it used to clear the date, which was already the default, so it did
          // nothing), re-centres the timeline on now and refreshes the data.
          onPress={onToday}
        >
          <Text style={[styles.dateNavTodayText, todayActive ? styles.dateNavTodayTextActive : null]}>Today</Text>
        </Pressable>
      </View>
      <WSelect value={liveFilters.status} onChange={(v) => setLiveFilters((f) => ({ ...f, status: v }))} options={SHIFT_STATUS_OPTS} placeholder="Status" />
    </View>
  );
}

// ─── Board table ──────────────────────────────────────────────────────────────

/**
 * Amber for an operational exception, red only for a welfare breach. A missing Log Book entry is
 * incomplete paperwork; colouring it like a possible harm to a person would teach the control room to
 * ignore the colour that matters.
 */
function operationsToneColor(tone: OperationsTone): string {
  if (tone === 'danger') return colors.danger;
  if (tone === 'warning') return colors.warning;
  if (tone === 'good') return colors.success;
  return colors.textSecondary;
}

const BOARD_COL_HDR = ['Site / Guard', 'Scheduled', 'Attendance', 'Welfare / Log Book', 'Status', 'Risk', 'Alerts', 'Action'] as const;

const COL: any[] = [
  { flex: 26, minWidth: 160 },                 // Site / Guard (stacked)
  { flex: 7,  minWidth: 64 },                  // Scheduled time
  { flex: 12, minWidth: 96 },                  // Attendance state
  { flex: 14, minWidth: 116 },                 // Welfare status + Log Book, stacked
  { flex: 8,  minWidth: 72 },                  // Status badge
  { flex: 7,  minWidth: 60 },                  // Risk
  { flex: 5,  minWidth: 44 },                  // Alerts
  { flex: 10, minWidth: 88, flexShrink: 0 },   // Action
];

function getRowAccent(rowTone: string): { leftColor: string | null; bgTint: string } {
  if (rowTone === colors.dangerSurface)  return { leftColor: colors.danger,  bgTint: 'rgba(180,35,24,0.03)'  };
  if (rowTone === colors.warningSurface) return { leftColor: colors.warning, bgTint: 'rgba(161,92,7,0.03)'   };
  return { leftColor: null, bgTint: colors.card };
}

function BoardTableHeader() {
  return (
    <View style={styles.boardHdrRow}>
      {BOARD_COL_HDR.map((lbl, i) => (
        <Text key={lbl} style={[styles.boardHdrCell, COL[i]]}>{lbl}</Text>
      ))}
    </View>
  );
}

function BoardRow({
  row,
  selected,
  highlighted,
  onPress,
  onAction,
}: {
  row: LiveBoardRow;
  selected: boolean;
  highlighted: boolean;
  onPress: () => void;
  onAction: (shift: Shift) => void;
}) {
  const { shift, lifecycleStatus, risk, delay, likelyLate, siteRiskLabel, primaryActionLabel, rowTone, shiftIncidents, panicOrWelfareCount, operations } = row;
  const welfare = welfareCell(operations?.welfare, operations?.timezone);
  const logBook = logBookCell(operations?.logBook, operations?.timezone);
  const badge = getStatusBadge(shift.status || 'unfilled');
  const accent = getRowAccent(rowTone);
  // The SITE's clock, from the shift's own site; operations.timezone is the server's copy of the same.
  const timeZone = shift.site?.timezone || operations?.timezone || DEFAULT_SITE_TIME_ZONE;
  const att = getAttendanceState(row, timeZone);

  return (
    <Pressable
      style={[
        styles.boardRow,
        accent.leftColor
          ? { backgroundColor: accent.bgTint, borderLeftWidth: 3, borderLeftColor: accent.leftColor }
          : { backgroundColor: accent.bgTint },
        selected    ? styles.boardRowSelected    : null,
        highlighted ? styles.boardRowHighlighted : null,
        IS_WEB      ? (WEB_PTR as any)           : null,
      ]}
      onPress={onPress}
    >
      {/* Site / Guard — stacked primary + secondary */}
      <View style={[COL[0], styles.boardCellCol]}>
        <Text style={styles.boardCellSite}  numberOfLines={1}>{shift.site?.name || shift.siteName || 'Unknown'}</Text>
        <Text style={styles.boardCellGuard} numberOfLines={1}>{shift.guard?.fullName || 'Unassigned'}</Text>
        {siteRiskLabel !== 'LOW' ? <Text style={styles.boardCellSiteRisk}>{siteRiskLabel}</Text> : null}
      </View>
      {/* Scheduled */}
      <Text style={[COL[1], styles.boardCell]}>{fmtTime(shift.start, timeZone)}–{fmtTime(shift.end, timeZone)}</Text>
      {/* Attendance */}
      <View style={[COL[2], styles.boardCellCol]}>
        <Text style={[styles.boardCellAttPrimary, { color: att.color }]}>{att.primary}</Text>
        {att.secondary ? <Text style={styles.boardCellSm}>{att.secondary}</Text> : null}
      </View>
      {/* Welfare / Log Book — the smallest readable form; detail lives in the drawer */}
      <View style={[COL[3], styles.boardCellCol]}>
        <Text style={[styles.boardCellWelfare, { color: operationsToneColor(welfare.tone) }]} numberOfLines={1}>
          {welfare.label}
        </Text>
        {welfare.detail ? <Text style={styles.boardCellSm} numberOfLines={1}>{welfare.detail}</Text> : null}
        {welfare.missedSummary ? (
          <Text style={[styles.boardCellSm, { color: colors.danger }]} numberOfLines={1}>{welfare.missedSummary}</Text>
        ) : null}
        <Text style={[styles.boardCellSm, { color: operationsToneColor(logBook.tone) }]} numberOfLines={1}>
          Log Book: {logBook.label}
        </Text>
      </View>
      {/* Status */}
      <View style={[COL[4], styles.boardCellStatusWrap]}>
        <View style={[styles.boardStatusBadge, { borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>
          <Text style={[styles.boardStatusText, { color: badge.color }]}>{badge.label}</Text>
        </View>
      </View>
      {/* Risk */}
      <View style={[COL[5], styles.boardCellCol]}>
        <Text style={[styles.boardCellRisk, { color: risk.color }]}>{risk.label}</Text>
        {delay !== null ? <Text style={styles.boardCellDelay}>{delay}m late</Text> : null}
        {likelyLate && delay === null ? <Text style={styles.boardCellDelay}>Likely late</Text> : null}
      </View>
      {/* Alerts */}
      <View style={[COL[6], styles.boardCellAlerts]}>
        {shiftIncidents.length > 0      ? <Text style={styles.boardAlertInc}>{shiftIncidents.length}I</Text>  : null}
        {panicOrWelfareCount > 0        ? <Text style={styles.boardAlertPanic}>{panicOrWelfareCount}P</Text>  : null}
        {shiftIncidents.length === 0 && panicOrWelfareCount === 0 ? <Text style={styles.boardAlertNone}>—</Text> : null}
      </View>
      {/* Action */}
      <View style={[COL[7], styles.boardCellAction]}>
        <Pressable
          style={({ pressed }: any) => [styles.boardActionBtn, pressed ? styles.boardActionBtnPressed : null, IS_WEB ? WEB_PTR : null]}
          onPress={(e: any) => { e?.stopPropagation?.(); onAction(shift); }}
        >
          <Text style={styles.boardActionBtnText}>{primaryActionLabel}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── LiveOpsOperationsBoard ───────────────────────────────────────────────────

function LiveOpsOperationsBoard({
  rows,
  selectedShiftId,
  highlightedLiveShiftId,
  metricFocus,
  filtersActive,
  onSelectRow,
  onAction,
  onClearMetricFocus,
}: {
  rows: LiveBoardRow[];
  selectedShiftId: number | null;
  highlightedLiveShiftId: number | null;
  metricFocus: MetricFocus;
  /** Whether the user has narrowed the board themselves, which changes what empty means. */
  filtersActive: boolean;
  onSelectRow: (id: number) => void;
  onAction: (shift: Shift) => void;
  onClearMetricFocus: () => void;
}) {
  return (
    <View style={styles.boardColumn}>
      <View style={[styles.boardPanelHeader, styles.boardPanelHeaderBg]}>
        <Text style={styles.panelTitle}>Current Operations</Text>
        <Text style={styles.panelCount}>{rows.length} shift{rows.length !== 1 ? 's' : ''}</Text>
      </View>
      {rows.length === 0 ? (
        <View style={styles.boardEmpty}>
          {/* Three different kinds of empty, and a control room needs to know which one it is looking
              at. "Nothing is happening" is a legitimate answer and must read as one — the board never
              reaches back for historical shifts to avoid showing it. */}
          {metricFocus !== 'all' ? (
            <>
              <Text style={styles.boardEmptyTitle}>No operations match this view</Text>
              <Pressable style={[styles.boardEmptyClearBtn, IS_WEB ? (WEB_PTR as any) : null]} onPress={onClearMetricFocus}>
                <Text style={styles.boardEmptyClearText}>Clear metric filter</Text>
              </Pressable>
            </>
          ) : filtersActive ? (
            <>
              <Text style={styles.boardEmptyTitle}>No current operations match these filters</Text>
              <Text style={styles.boardEmptyDesc}>
                Clear the filters above to see everything live and upcoming. Past shifts are in Rota Planner and Coverage.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.boardEmptyTitle}>No live or upcoming operations requiring attention.</Text>
              <Text style={styles.boardEmptyDesc}>
                Nothing is in progress and nothing starts in the next 4 hours. Completed and historical shifts remain in Rota Planner and Coverage.
              </Text>
            </>
          )}
        </View>
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.boardHScroll}
          contentContainerStyle={styles.boardHScrollContent}
        >
          <View style={styles.boardTable}>
            <BoardTableHeader />
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator={IS_WEB}
              style={IS_WEB ? [styles.boardBodyScroll, { scrollbarWidth: 'thin' } as any] : styles.boardBodyScroll}
            >
              {rows.map((row) => (
                <Fragment key={row.shift.id}>
                  <BoardRow
                    row={row}
                    selected={selectedShiftId === row.shift.id}
                    highlighted={highlightedLiveShiftId === row.shift.id}
                    onPress={() => onSelectRow(row.shift.id)}
                    onAction={onAction}
                  />
                </Fragment>
              ))}
            </ScrollView>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ─── AttentionItem ─────────────────────────────────────────────────────────────

function getPrimaryAttentionAction(
  item: UrgentOperationalItem,
  busy: boolean,
  onOpenUrgentDetail: (i: UrgentOperationalItem) => void,
  onUrgentAlertFollowUp: (i: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>,
  onOpenIncidentResolution: (i: UrgentOperationalItem) => void,
): { label: string; onPress: () => void; disabled: boolean } {
  if (item.category === 'uncovered_shift') {
    return { label: 'Manage coverage', onPress: () => onOpenUrgentDetail(item), disabled: false };
  }
  /**
   * An incident resolves where it is, through the INCIDENT path.
   *
   * This branch used to route to `onOpenUrgentDetail`, which only ran `setActiveSection('incidents')`
   * — so a button labelled "View & Resolve" navigated to the register and offered no way to resolve
   * anything. It now opens the resolution dialog for this incident, and the label follows the real
   * lifecycle rather than being decided here.
   */
  if (item.category === 'incident') {
    const { resolveLabel } = incidentAttentionActions(item.status);
    if (!resolveLabel) {
      return { label: 'View Incident', onPress: () => onOpenUrgentDetail(item), disabled: false };
    }
    return {
      label: busy ? '…' : resolveLabel,
      onPress: () => onOpenIncidentResolution(item),
      disabled: busy,
    };
  }
  if (item.category === 'panic') {
    const label = item.status === 'acknowledged' ? (busy ? '…' : 'Resolve Alert') : 'View Alert';
    const isDisabled = busy && item.status === 'acknowledged';
    const onPress = item.status === 'acknowledged'
      ? () => onUrgentAlertFollowUp(item, 'close')
      : () => onOpenUrgentDetail(item);
    return { label, onPress, disabled: isDisabled };
  }
  /**
   * A Missing Book Off is resolved from the queue, open or acknowledged.
   *
   * It fell through to the default branch when the category was introduced, so its primary button read
   * "Open Shift" and the resolution dialog was unreachable for the one item type that most needs it —
   * a guard unaccounted for after their shift ended. It routes through the SAME alert path as every
   * other durable alert: `onUrgentAlertFollowUp(item, 'close')` opens the existing dialog, which
   * collects the reason and note. No second handler, no second modal.
   */
  if (item.category === 'missing_book_off') {
    return {
      label: busy ? '…' : 'Resolve',
      onPress: () => onUrgentAlertFollowUp(item, 'close'),
      disabled: busy,
    };
  }
  /**
   * A compliance lapse (Migration 63) is acknowledged first, then resolved with a reason and a mandatory
   * note through the same alert path as every other durable alert. Nothing here ends the shift.
   */
  if (item.category === 'compliance_lapse') {
    return item.status === 'acknowledged'
      ? { label: busy ? '…' : 'Resolve', onPress: () => onUrgentAlertFollowUp(item, 'close'), disabled: busy }
      : { label: busy ? '…' : 'Acknowledge', onPress: () => onUrgentAlertFollowUp(item, 'acknowledge'), disabled: busy };
  }
  if (item.category === 'missed_check_call' || item.category === 'safety') {
    const label = item.status === 'acknowledged' ? (busy ? '…' : getUrgentPrimaryLabel(item)) : getUrgentPrimaryLabel(item);
    const isDisabled = busy && item.status === 'acknowledged';
    const onPress = item.status === 'acknowledged'
      ? () => onUrgentAlertFollowUp(item, 'close')
      : () => onOpenUrgentDetail(item);
    return { label, onPress, disabled: isDisabled };
  }
  return { label: getUrgentPrimaryLabel(item), onPress: () => onOpenUrgentDetail(item), disabled: false };
}

function AttentionItem({
  item,
  isLast,
  urgentActionItemId,
  resolveShiftZone,
  onOpenUrgentDetail,
  onOpenUrgentShift,
  onUrgentIncidentFollowUp,
  onUrgentAlertFollowUp,
  onOpenIncidentResolution,
}: {
  item: UrgentOperationalItem;
  isLast: boolean;
  /** An attention item carries only a shiftId, so the site's clock is resolved from that. */
  resolveShiftZone: (shiftId?: number | null) => string;
  urgentActionItemId: string | null;
  onOpenUrgentDetail: (item: UrgentOperationalItem) => void;
  onOpenUrgentShift: (item: UrgentOperationalItem) => void;
  onUrgentIncidentFollowUp: (item: UrgentOperationalItem, status: 'in_review' | 'resolved') => Promise<void>;
  onUrgentAlertFollowUp: (item: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>;
  /** Open the resolution dialog for an INCIDENT. Never the safety-alert path. */
  onOpenIncidentResolution: (item: UrgentOperationalItem) => void;
}) {
  const sev = getAttentionSeverity(item.category);
  const sevColor = sev === 'red' ? colors.danger : sev === 'amber' ? colors.warning : colors.info;
  const badgeLabel = getAttentionLabel(item.category);
  const busy = urgentActionItemId === item.id;

  const handleRowPress = () => {
    if (item.category === 'uncovered_shift') {
      onOpenUrgentDetail(item);
    } else if (item.shiftId) {
      onOpenUrgentShift(item);
    }
  };

  const primary = getPrimaryAttentionAction(
    item, busy, onOpenUrgentDetail, onUrgentAlertFollowUp, onOpenIncidentResolution,
  );
  const acknowledged = (item.status || '').trim().toLowerCase() === 'acknowledged';
  const isIncident = item.category === 'incident';
  /**
   * Only a SAFETY ALERT can be acknowledged.
   *
   * This condition used to be `item.alertId || item.incidentId`, so the generic Acknowledge button
   * rendered on incidents — and it is wired to the safety-alert handler, which opens by rejecting
   * anything without an `alertId`. An incident carries `incidentId` and never `alertId`, so every
   * press failed with "No safety alert is linked to this urgent item". An incident is not a safety
   * alert and gets its own transition below.
   */
  const canAcknowledge = !isIncident && Boolean(item.alertId);
  const incidentActions = isIncident
    ? incidentAttentionActions(item.status)
    : { canMarkInReview: false, resolveLabel: null, stateLabel: null };

  return (
    <Pressable
      style={[styles.attentionItem, isLast ? styles.attentionItemLast : null, IS_WEB ? (WEB_PTR as any) : null]}
      onPress={handleRowPress}
    >
      {/* Header row */}
      <View style={styles.attentionItemHead}>
        <View style={[styles.attentionSevDot, { backgroundColor: sevColor }]} />
        <Text style={[styles.attentionIssueType, { color: sevColor }]}>{item.issueType}</Text>
        <View style={[styles.attentionBadge, { borderColor: sevColor, backgroundColor: `${sevColor}12` }]}>
          <Text style={[styles.attentionBadgeText, { color: sevColor }]}>{badgeLabel}</Text>
        </View>
        <Text style={styles.attentionTime}>{fmtTime(item.occurredAt, resolveShiftZone(item.shiftId))}</Text>
      </View>
      {/* Meta */}
      <Text style={styles.attentionMeta} numberOfLines={1}>{item.siteName} · {item.guardName}</Text>
      {item.message ? (
        <Text style={styles.attentionDetail} numberOfLines={2}>{item.message}</Text>
      ) : null}

      {/* The lifecycle, in a word. Acknowledged must not be a shade of a colour: a controller
          scanning the queue has to see that someone already has this one. */}
      {acknowledged && !isIncident ? (
        <View style={styles.attentionState}>
          <Text style={styles.attentionStateMark}>✓</Text>
          <Text style={styles.attentionStateText}>Acknowledged</Text>
        </View>
      ) : null}

      {/* An incident states its own lifecycle word, which is never "Acknowledged". */}
      {incidentActions.stateLabel ? (
        <View style={styles.attentionState}>
          <Text style={styles.attentionStateMark}>✓</Text>
          <Text style={styles.attentionStateText}>{incidentActions.stateLabel}</Text>
        </View>
      ) : null}

      {/* Open: Acknowledge and Resolve. Acknowledged: Resolve only — there is nothing left to
          acknowledge, and offering it again would invite a second pointless write. */}
      <View style={styles.attentionActions}>
        {/* An incident's real first transition is open → in_review, so the button says that. */}
        {incidentActions.canMarkInReview ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark In Review"
            style={[styles.aBtn, styles.aBtnSecondary, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => { void onUrgentIncidentFollowUp(item, 'in_review'); }}
            disabled={busy}
          >
            <Text style={styles.aBtnSecondaryText}>{busy ? '…' : 'Mark In Review'}</Text>
          </Pressable>
        ) : null}
        {canAcknowledge && !acknowledged ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Acknowledge"
            style={[styles.aBtn, styles.aBtnSecondary, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => { void onUrgentAlertFollowUp(item, 'acknowledge'); }}
            disabled={busy}
          >
            <Text style={styles.aBtnSecondaryText}>Acknowledge</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={primary.label}
          style={[styles.aBtn, styles.aBtnPrimary, IS_WEB ? (WEB_PTR as any) : null]}
          onPress={primary.onPress}
          disabled={primary.disabled}
        >
          <Text style={styles.aBtnPrimaryText}>{primary.label}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── LiveOpsAttentionRail ─────────────────────────────────────────────────────

export function LiveOpsAttentionRail({
  items,
  metricFocus,
  urgentActionItemId,
  resolveShiftZone,
  onOpenUrgentDetail,
  onOpenUrgentShift,
  onUrgentIncidentFollowUp,
  onUrgentAlertFollowUp,
  onOpenIncidentResolution,
  nextUp,
  sourceStates,
  stacked = false,
}: {
  items: UrgentOperationalItem[];
  metricFocus: MetricFocus;
  /** Below the timeline at full width (narrow web), rather than a fixed-width column beside it. */
  stacked?: boolean;
  resolveShiftZone: (shiftId?: number | null) => string;
  urgentActionItemId: string | null;
  onOpenUrgentDetail: (item: UrgentOperationalItem) => void;
  onOpenUrgentShift: (item: UrgentOperationalItem) => void;
  onUrgentIncidentFollowUp: (item: UrgentOperationalItem, status: 'in_review' | 'resolved') => Promise<void>;
  onUrgentAlertFollowUp: (item: UrgentOperationalItem, action: 'acknowledge' | 'close') => Promise<void>;
  /** Open the resolution dialog for an INCIDENT. Never the safety-alert path. */
  onOpenIncidentResolution: (item: UrgentOperationalItem) => void;
  nextUp: NextUpEvent[];
  /** See LiveOpsSourceStates. Omitted: all ready. */
  sourceStates?: LiveOpsSourceStates;
}) {
  const total = items.length;
  const sources = sourceStates ?? {};
  // The queue is built from shifts, attendance, coverage, incidents and alerts; if any failed it may be
  // incomplete, and an empty queue cannot be called clear.
  const queueIncomplete = anyFailed(sources, 'shifts', 'attendance', 'coverage', 'incidents', 'alerts') === 'error';

  /**
   * The operations rail: what needs doing now, then what is about to need doing.
   *
   * Two sections, one column, in that order — a controller's eye starts at the exception queue and falls
   * into the next few minutes. Recent Activity deliberately stays out: history is evidence, not an
   * action, and putting it here would make the rail something to read rather than something to work.
   */
  return (
    <View style={[styles.attentionColumn, stacked ? styles.attentionColumnStacked : null]}>
      <View style={[styles.attentionPanelHeader, styles.attentionPanelHeaderBg]}>
        <Text style={styles.panelTitle}>Attention Now</Text>
        {total > 0 ? (
          <View style={styles.attentionCountBadge}>
            <Text style={styles.attentionCountText}>{total}</Text>
          </View>
        ) : null}
      </View>
      <ScrollView
        style={styles.attentionScroll}
        showsVerticalScrollIndicator={IS_WEB}
        nestedScrollEnabled
      >
        {queueIncomplete && total > 0 ? (
          <View style={styles.sourceNotice} {...({ accessibilityRole: 'alert' } as any)}>
            <Text style={styles.sourceNoticeText}>Some sources could not be loaded, so this queue may be incomplete.</Text>
          </View>
        ) : null}
        {total === 0 && queueIncomplete ? (
          <View style={styles.attentionEmpty}>
            <Text style={[styles.attentionEmptyTitle, styles.unavailableText]}>Queue status unavailable</Text>
            <Text style={styles.attentionEmptyDesc}>Some sources could not be loaded, so S4 cannot confirm that nothing needs action. Use Refresh.</Text>
          </View>
        ) : total === 0 ? (
          <View style={styles.attentionEmpty}>
            <Text style={styles.attentionEmptyTitle}>{metricFocus !== 'all' ? 'No items match' : 'Queue clear'}</Text>
            <Text style={styles.attentionEmptyDesc}>{metricFocus !== 'all' ? 'No items match this view.' : 'No urgent operational items right now.'}</Text>
          </View>
        ) : (
          items.map((item, idx) => (
            <Fragment key={item.id}>
              <AttentionItem
                item={item}
                isLast={idx === total - 1}
                resolveShiftZone={resolveShiftZone}
                urgentActionItemId={urgentActionItemId}
                onOpenUrgentDetail={onOpenUrgentDetail}
                onOpenUrgentShift={onOpenUrgentShift}
                onUrgentIncidentFollowUp={onUrgentIncidentFollowUp}
                onUrgentAlertFollowUp={onUrgentAlertFollowUp}
                onOpenIncidentResolution={onOpenIncidentResolution}
              />
            </Fragment>
          ))
        )}

        <View style={styles.railSectionHeader}>
          <Text style={styles.railSectionTitle}>Next Up</Text>
          <Text style={styles.railSectionHint}>next 4h</Text>
        </View>
        {nextUp.length === 0 ? (
          <View style={styles.attentionEmpty}>
            <Text style={styles.attentionEmptyDesc}>Nothing due in the next few hours.</Text>
          </View>
        ) : (
          nextUp.map((event, idx) => (
            <View
              key={event.id}
              style={[styles.nextUpItem, idx === nextUp.length - 1 ? styles.attentionItemLast : null]}
            >
              <Text style={styles.nextUpTime}>{event.at}</Text>
              <View style={styles.nextUpBody}>
                <Text style={styles.nextUpLabel} numberOfLines={1}>{event.label}</Text>
                <Text style={styles.nextUpSite} numberOfLines={1}>{event.siteName}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ─── LiveOpsSnapshotStrip ─────────────────────────────────────────────────────


/** One labelled number in Today So Far. Deliberately a number and a word — no chart, no gauge. */
function SummaryStat({ label, value, tone, source = 'ready' }: { label: string; value: number; tone?: 'warn' | 'bad'; source?: SourceState }) {
  const count = safeCount(value, source);
  const statusWord = countStatusWord(count);
  return (
    <View style={styles.summaryStat}>
      <Text
        style={[
          styles.summaryStatValue,
          value > 0 && tone === 'warn' ? styles.summaryStatWarn : null,
          value > 0 && tone === 'bad' ? styles.summaryStatBad : null,
          count.kind === 'unavailable' ? styles.unavailableText : null,
        ]}
      >
        {countText(count)}
      </Text>
      <Text style={styles.summaryStatLabel}>{statusWord ? `${label} · ${statusWord.toLowerCase()}` : label}</Text>
    </View>
  );
}

export function LiveOpsLowerPanels({
  todaySoFar,
  handovers,
  recentOperationalActivity,
  liveOperationEnrichedRows,
  onOpenCoverage,
  resolveShiftZone,
  sourceStates,
}: {
  /** See LiveOpsSourceStates. Omitted: all ready. */
  sourceStates?: LiveOpsSourceStates;
  todaySoFar: TodaySoFar;
  handovers: Handover[];
  recentOperationalActivity: OperationalActivityItem[];
  resolveShiftZone: (shiftId?: number | null) => string;
  liveOperationEnrichedRows: LiveBoardRow[];
  onOpenCoverage: (context?: { uncoveredOnly?: boolean; shiftId?: number }) => void;
}) {
  const sources = sourceStates ?? {};
  const attendanceSource = anyFailed(sources, 'shifts', 'attendance');
  const welfareSource = anyFailed(sources, 'shifts', 'monitoring');
  const totalShifts = liveOperationEnrichedRows.length;
  const uncoveredRows = liveOperationEnrichedRows.filter((r) => r.lifecycleStatus === 'unfilled').length;
  const recentSlice = recentOperationalActivity.slice(0, 5);

  /**
   * The panels below the board.
   *
   * They wrap, so with two or three sites they fill the space the timeline does not need, and with
   * twenty they simply sit further down the page. Nothing here constrains the timeline's height: the
   * board is the primary surface and these are what a controller reads once they have finished with it.
   */
  return (
    <View style={styles.lowerStrip}>

      {/* ── Today So Far ──────────────────────────────────────────────────
          Nine numbers over the SAME rows the timeline draws — one pass, no request per metric. */}
      <View style={[styles.lowerPanel, styles.lowerPanelSummary]}>
        <View style={styles.lowerPanelTitleRow}>
          <Text style={styles.lowerPanelTitle}>Today So Far</Text>
          <Text style={styles.lowerPanelScope}>{todaySoFar.shiftCount} shifts in view</Text>
        </View>

        <Text style={styles.summaryGroupLabel}>Attendance</Text>
        <View style={styles.summaryRow}>
          <SummaryStat label="Booked on" value={todaySoFar.attendance.bookedOn} source={attendanceSource} />
          <SummaryStat label="Late / not on" value={todaySoFar.attendance.lateNotBookedOn} tone="bad" source={attendanceSource} />
          <SummaryStat label="Booked off" value={todaySoFar.attendance.bookedOff} source={attendanceSource} />
          <SummaryStat label="Booked off early" value={todaySoFar.attendance.bookedOffEarly} source={attendanceSource} />
        </View>

        {/* "Windows", on its face: Attention Now counts one missed-Welfare item per shift, this counts
            every window. Two honest numbers that measure different things must say which is which. */}
        <Text style={styles.summaryGroupLabel}>Welfare windows</Text>
        <View style={styles.summaryRow}>
          <SummaryStat label="Completed" value={todaySoFar.welfare.completed} source={welfareSource} />
          <SummaryStat label="Overdue" value={todaySoFar.welfare.overdue} tone="warn" source={welfareSource} />
          <SummaryStat label="Missed" value={todaySoFar.welfare.missed} tone="bad" source={welfareSource} />
        </View>

        <Text style={styles.summaryGroupLabel}>Operations</Text>
        <View style={styles.summaryRow}>
          <SummaryStat label="Open incidents" value={todaySoFar.operations.openIncidents} tone="warn" source={anyFailed(sources, 'shifts', 'incidents')} />
          <SummaryStat label="Site requests" value={todaySoFar.operations.siteRequests} source={anyFailed(sources, 'shifts', 'alerts')} />
          <SummaryStat label="Emergency" value={todaySoFar.operations.emergencyAlerts} tone="bad" source={anyFailed(sources, 'shifts', 'alerts')} />
        </View>

        {uncoveredRows > 0 ? (
          <Pressable
            style={[styles.lowerPanelCta, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onOpenCoverage({ uncoveredOnly: true })}
          >
            <Text style={styles.lowerPanelCtaText}>
              {uncoveredRows} of {totalShifts} require cover — manage coverage →
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* ── Upcoming Handovers ───────────────────────────────────────────
          Never a guess: a replacement is named only when exactly one shift starts around the end. */}
      <View style={[styles.lowerPanel, styles.lowerPanelHandovers]}>
        <Text style={styles.lowerPanelTitle}>Upcoming Handovers</Text>
        {handovers.length === 0 ? (
          <Text style={styles.lowerPanelCalm}>No staffing changes in the next few hours</Text>
        ) : (
          handovers.map((h, idx) => (
            <View
              key={h.id}
              style={[styles.handoverItem, idx < handovers.length - 1 ? styles.activityItemDivider : null]}
            >
              <Text style={styles.handoverTime}>{h.at}</Text>
              <View style={styles.handoverBody}>
                <Text style={styles.handoverSite} numberOfLines={1}>{h.siteName}</Text>
                {h.ending ? (
                  <Text style={styles.handoverLine} numberOfLines={1}>{h.ending.guardName} ending</Text>
                ) : null}
                {/* A shift with nobody on it has no name to print, so the note says the whole thing —
                    and when it does have a name, that line already says "due to start", so the note
                    would only repeat it. */}
                {!h.ending && h.startingAssigned && h.starting ? (
                  <Text style={styles.handoverLine} numberOfLines={1}>{h.starting.guardName} due to start</Text>
                ) : (
                  <Text
                    style={[
                      styles.handoverNote,
                      h.replacement === 'none' || !h.startingAssigned ? styles.handoverNoteBad : null,
                    ]}
                    numberOfLines={1}
                  >
                    {h.note}
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
      </View>

      {/* ── Recent Activity ───────────────────────────────────────────────
          Kept, and kept HERE. It is the only chronological evidence of what has already happened, which
          the rail (actions) and Today So Far (counts) do not carry. */}
      <View style={[styles.lowerPanel, styles.lowerPanelActivity]}>
        <Text style={styles.lowerPanelTitle}>Recent Activity</Text>
        {recentSlice.length === 0 ? (
          <Text style={styles.lowerPanelCalm}>No recent events</Text>
        ) : (
          recentSlice.map((a, idx) => (
            <View
              key={a.id}
              style={[styles.activityItem, idx < recentSlice.length - 1 ? styles.activityItemDivider : null]}
            >
              <Text style={styles.activityItemTime}>{fmtTime(a.occurredAt, resolveShiftZone(a.shiftId))}</Text>
              <View style={styles.activityItemBody}>
                <Text style={styles.activityItemEvent} numberOfLines={1}>{fmtActivityType(a.eventType)}</Text>
                {/*
                  A preview of what was written, not just that something was.
                  "Log Book entry added" told a controller nothing they could act on. One line is
                  enough here — the full record is in the Log Book register and the shift drawer, so
                  truncating this copy loses nothing.
                */}
                {a.message ? (
                  <Text style={styles.activityItemPreview} numberOfLines={1}>{a.message}</Text>
                ) : null}
                <Text style={styles.activityItemSite} numberOfLines={1}>{a.siteName}</Text>
              </View>
            </View>
          ))
        )}
      </View>

    </View>
  );
}

// ─── Detail panel sub-components ──────────────────────────────────────────────

function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <View style={styles.detailEmpty}>
      <Text style={styles.detailEmptyTitle}>{title}</Text>
      <Text style={styles.detailEmptyDesc}>{desc}</Text>
    </View>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function CompanyLiveOperationsWorkspace({
  sourceStates,
  canManageShifts,
  onAddShift,
  liveShiftsCount,
  guardsNotBookedOnCount,
  overdueBookOffCount,
  reconciliationRows,
  boardDateMode,
  onToday,
  onReconcileShift,
  onManageExtension,
  amendmentsEnabled,
  timelineRecentreSignal,
  activePanicAlertsCount,
  openIncidentsCount,
  missedCheckCallsCount,
  urgentOperationalItems,
  urgentActionItemId,
  liveOperationsFeedback,
  liveOperationEnrichedRows,
  selectedShiftId,
  setSelectedShiftId,
  highlightedLiveShiftId,
  liveFilters,
  setLiveFilters,
  siteClientOptions,
  siteOptions,
  linkedGuardOptions,
  recentOperationalActivity,
  resolveShiftZone,
  selectedShiftContext,
  selectedShiftCloseOutSummary,
  closeOutNotesDraft,
  setCloseOutNotesDraft,
  savingCloseOutNotes,
  onLiveBoardPrimaryAction,
  onOpenUrgentDetail,
  onOpenUrgentShift,
  onUrgentIncidentFollowUp,
  onUrgentAlertFollowUp,
  onOpenIncidentResolution,
  onSaveCloseOutNotes,
  onOpenCoverage,
  operationalNowMs,
  timelineAnchorMs,
  timelineAnchorKey,
  onOpenReport,
  onExportCsv,
  onExportXlsx,
  exporting,
  onBoardLayout,
  onDetailLayout,
}: CompanyLiveOperationsWorkspaceProps) {
  const [metricFocus, setMetricFocus] = React.useState<MetricFocus>('all');
  // Below 768px the 268px Attention Now column beside the timeline left the timeline about 80px wide, too
  // narrow to read a bar. There the two stack: the timeline at full width, then Attention Now below it.
  const { width: windowWidth } = useWindowDimensions();
  const stacked = IS_WEB && windowWidth < 768;
  /**
   * The zone the hour header is labelled in.
   *
   * Taken from the first site in view rather than the device, so a single-site control room reads its
   * own clock. Each ROW still renders its own site's zone — the foundation keeps per-site semantics —
   * and the timeline header says "mixed site timezones" when more than one is on screen, so the axis is
   * never silently someone else's clock.
   */
  const timelineHeaderZone =
    liveOperationEnrichedRows[0]?.shift.site?.timezone || DEFAULT_SITE_TIME_ZONE;
  const filtersActive = Boolean(
    liveFilters.clientId || liveFilters.siteId || liveFilters.guardId || liveFilters.date || liveFilters.status,
  );
  const handleMetricPress = React.useCallback(
    (focus: MetricFocus) => setMetricFocus((prev) => (prev === focus ? 'all' : focus)),
    [],
  );

  // Both filters read the inclusion reason the counts were computed from, so pressing a card reading 3
  // shows exactly those 3 rows. Previously "Guards Not Booked On" counted `ready` shifts and then filtered
  // the board for `in_progress` ones, so the card and the rows described different things.
  const focusedBoardRows = React.useMemo(() => {
    if (metricFocus === 'live')       return liveOperationEnrichedRows.filter((r) => r.inclusion === 'in_progress');
    if (metricFocus === 'not-booked') return liveOperationEnrichedRows.filter((r) => r.inclusion === 'late_not_booked_on');
    if (metricFocus === 'no-book-off') return liveOperationEnrichedRows.filter((r) => r.inclusion === 'overdue_book_off');
    return liveOperationEnrichedRows;
  }, [liveOperationEnrichedRows, metricFocus]);

  const focusedAttentionItems = React.useMemo(() => {
    if (metricFocus === 'panic')         return urgentOperationalItems.filter((i) => i.category === 'panic');
    if (metricFocus === 'incidents')     return urgentOperationalItems.filter((i) => i.category === 'incident');
    if (metricFocus === 'missed-checks') return urgentOperationalItems.filter((i) => i.category === 'missed_check_call');
    if (metricFocus === 'not-booked') {
      const notBookedShiftIds = new Set(
        liveOperationEnrichedRows
          .filter((r) => r.inclusion === 'late_not_booked_on')
          .map((r) => r.shift.id),
      );
      return urgentOperationalItems.filter((i) => i.shiftId != null && notBookedShiftIds.has(i.shiftId));
    }
    return urgentOperationalItems;
  }, [urgentOperationalItems, liveOperationEnrichedRows, metricFocus]);

  /**
   * The timeline's dataset: the same filtered, enriched rows the summary counts and Attention Now are
   * derived from. One dataset means the three can never contradict each other, and it is why there is
   * no request per cell or per Welfare marker — the whole visible scope arrives in one payload.
   */
  const timelineInputs: OutlookShiftInput[] = React.useMemo(
    () => focusedBoardRows.map((row) => ({
      shift: row.shift,
      attendance: row.attendance,
      operations: row.operations,
      closedByControl: row.closedByControl,
      // Carried on the SAME row the bar is drawn from, so Today So Far counts the incidents and alerts
      // belonging to exactly the shifts on screen. No second fetch, and nothing per metric.
      logs: row.shiftLogs,
      incidents: row.shiftIncidents,
      alerts: row.shiftAlerts,
    })),
    [focusedBoardRows],
  );

  /**
   * Next Up, Upcoming Handovers and Today So Far all read `timelineInputs`.
   *
   * That is the whole of rule §15: one filtered dataset, three presentations. Each is a pure function of
   * the array and the operational clock the board already has, so none of them can invent a universe of
   * its own — and none of them issues a request.
   */
  const nextUp = React.useMemo(
    () => buildNextUp(timelineInputs, operationalNowMs),
    [timelineInputs, operationalNowMs],
  );
  const handovers = React.useMemo(
    () => buildHandovers(timelineInputs, operationalNowMs),
    [timelineInputs, operationalNowMs],
  );
  const todaySoFar = React.useMemo(
    () => buildTodaySoFar(timelineInputs, operationalNowMs),
    [timelineInputs, operationalNowMs],
  );

  const effectiveSelectedShiftContext = React.useMemo(() => {
    if (!selectedShiftContext) return null;
    const id = selectedShiftContext.shift.id;
    // A shift opened from Needs Reconciliation is not on the board, and must still open.
    return focusedBoardRows.some((r) => r.shift.id === id) || reconciliationRows.some((r) => r.shift.id === id)
      ? selectedShiftContext
      : null;
  }, [selectedShiftContext, focusedBoardRows, reconciliationRows]);

  const sources = sourceStates ?? {};
  const failedSourceNames = (Object.keys(SOURCE_LABELS) as Array<keyof LiveOpsSourceStates>)
    .filter((key) => sources[key] === 'error')
    .map((key) => SOURCE_LABELS[key]);
  const shiftsUnavailable = anyFailed(sources, 'shifts', 'attendance') === 'error';

  return (
    <View style={styles.root}>

      {/* ── Header ──────────────────────────────────────────────────────────
          Add Shift lives here because this is where a control room works. It opens the existing Rota
          Planner drawer rather than a second form, so there stays exactly one shift-creation path. */}
      <View style={styles.liveOpsHeaderRow}>
        <View style={styles.liveOpsHeaderText}>
          <Text style={styles.liveOpsHeaderTitle}>Live Operations</Text>
          <Text style={styles.liveOpsHeaderCaption}>Monitor live shifts, attendance, Welfare Checks and operational alerts.</Text>
        </View>
        {canManageShifts ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add Shift"
            style={({ pressed }: any) => [styles.addShiftBtn, pressed ? styles.addShiftBtnPressed : null, IS_WEB ? WEB_PTR : null]}
            onPress={onAddShift}
          >
            <Text style={styles.addShiftBtnText}>+ Add Shift</Text>
          </Pressable>
        ) : null}
      </View>

      {/* ── Feedback banner ─────────────────────────────────────────────── */}
      {liveOperationsFeedback ? (
        <View style={[
          styles.feedbackBanner,
          liveOperationsFeedback.tone === 'error' ? styles.feedbackBannerError : styles.feedbackBannerSuccess,
        ]}>
          <Text style={[styles.feedbackTitle, liveOperationsFeedback.tone === 'error' ? styles.feedbackTitleError : styles.feedbackTitleSuccess]}>
            {liveOperationsFeedback.tone === 'error' ? 'Action failed' : 'Action completed'}
          </Text>
          <Text style={[styles.feedbackText, liveOperationsFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess]}>
            {liveOperationsFeedback.message}
          </Text>
        </View>
      ) : null}

      {/* ── Unavailable data ───────────────────────────────────────────────
          Named, so a controller knows which figures to distrust. Actions (Book On, Book Off, alert and
          incident follow-up) do not depend on these reads and keep working. */}
      {failedSourceNames.length > 0 ? (
        <View style={[styles.feedbackBanner, styles.feedbackBannerError]} {...({ accessibilityRole: 'alert' } as any)}>
          <Text style={[styles.feedbackTitle, styles.feedbackTitleError]}>Some live data could not be loaded</Text>
          <Text style={[styles.feedbackText, styles.feedbackTextError]}>
            {`Unavailable: ${failedSourceNames.join(', ')}. Figures shown as — are unavailable; other figures may be out of date. Use Refresh.`}
          </Text>
        </View>
      ) : null}

      {/* ── Operational state bar ───────────────────────────────────────── */}
      <LiveOpsStatusBar
        liveShiftsCount={liveShiftsCount}
        guardsNotBookedOnCount={guardsNotBookedOnCount}
        overdueBookOffCount={overdueBookOffCount}
        activePanicAlertsCount={activePanicAlertsCount}
        openIncidentsCount={openIncidentsCount}
        missedCheckCallsCount={missedCheckCallsCount}
        metricFocus={metricFocus}
        onMetricPress={handleMetricPress}
        sources={sources}
      />

      {/* ── Filter toolbar ───────────────────────────────────────────────── */}
      <LiveOpsFilterToolbar
        liveFilters={liveFilters}
        setLiveFilters={setLiveFilters}
        siteClientOptions={siteClientOptions}
        siteOptions={siteOptions}
        linkedGuardOptions={linkedGuardOptions}
        operationalTimeZone={timelineHeaderZone}
        boardDateMode={boardDateMode}
        onToday={onToday}
      />

      {/* ── Metric focus hint ────────────────────────────────────────────── */}
      <MetricFocusHint metricFocus={metricFocus} onClear={() => setMetricFocus('all')} />

      {/* ── Command workspace ────────────────────────────────────────────── */}
      <View style={[styles.workspaceRow, stacked ? styles.workspaceRowStacked : null]} onLayout={(e: any) => onBoardLayout(e.nativeEvent.layout.y)}>
        <View style={styles.timelineColumn}>
          <CompanyOperationsTimeline
            inputs={timelineInputs}
            nowMs={operationalNowMs}
            headerTimeZone={timelineHeaderZone}
            anchorMs={timelineAnchorMs}
            selectedShiftId={selectedShiftId}
            highlightedShiftId={highlightedLiveShiftId}
            onSelectShift={setSelectedShiftId}
            onExportCsv={onExportCsv}
            onExportXlsx={onExportXlsx}
            exporting={exporting}
            unavailable={shiftsUnavailable}
            recentreSignal={timelineRecentreSignal}
            anchorKey={timelineAnchorKey}
            onOpenReport={onOpenReport}
          />
          {metricFocus !== 'all' ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.clearFocusBtn, IS_WEB ? (WEB_PTR as any) : null]}
              onPress={() => setMetricFocus('all')}
            >
              <Text style={styles.clearFocusText}>Clear metric filter</Text>
            </Pressable>
          ) : null}
        </View>
        <LiveOpsAttentionRail
          stacked={stacked}
          items={focusedAttentionItems}
          metricFocus={metricFocus}
          resolveShiftZone={resolveShiftZone}
          urgentActionItemId={urgentActionItemId}
          onOpenUrgentDetail={onOpenUrgentDetail}
          onOpenUrgentShift={onOpenUrgentShift}
          onUrgentIncidentFollowUp={onUrgentIncidentFollowUp}
          onUrgentAlertFollowUp={onUrgentAlertFollowUp}
          onOpenIncidentResolution={onOpenIncidentResolution}
          nextUp={nextUp}
          sourceStates={sources}
        />
      </View>

      {/* ── Needs Reconciliation ───────────────────────────────────────────
          Worked, never booked off, more than 24 hours past the scheduled end. Off the live board and out
          of every live count, but listed here whatever date is selected so it can never be lost. Their
          alerts stay in Attention Now on their own lifecycle. Read-only: nothing here changes a shift. */}
      <LiveOpsReconciliationQueue
        rows={reconciliationRows}
        nowMs={operationalNowMs}
        resolveShiftZone={resolveShiftZone}
        onOpenShift={setSelectedShiftId}
        onReconcileShift={onReconcileShift}
      />

      {/* ── Supporting operational summaries ─────────────────────────────── */}
      <LiveOpsLowerPanels
        todaySoFar={todaySoFar}
        handovers={handovers}
        recentOperationalActivity={recentOperationalActivity}
        resolveShiftZone={resolveShiftZone}
        liveOperationEnrichedRows={liveOperationEnrichedRows}
        onOpenCoverage={onOpenCoverage}
        sourceStates={sources}
      />

      {/* ── Shift detail, on demand ──────────────────────────────────────
          Previously every selected shift rendered a full-height card below the board, so the page grew
          with the operation and a controller scrolled past the thing they were watching. The same
          content now opens in a drawer: Operational Monitoring, Attendance & Timesheet, Daily Logs,
          Incidents and Safety Alerts are reused verbatim — this recovers vertical space, it does not
          rebuild their workflows. */}
      <Drawer
        visible={!!effectiveSelectedShiftContext}
        onClose={() => setSelectedShiftId(null)}
        title="Shift Operations"
        subtitle={
          effectiveSelectedShiftContext
            ? `${effectiveSelectedShiftContext.shift.site?.name || effectiveSelectedShiftContext.shift.siteName || 'Site'} · ${effectiveSelectedShiftContext.shift.guard?.fullName || 'Unassigned'}`
            : undefined
        }
        width={620}
      >
        {effectiveSelectedShiftContext ? (
          <View onLayout={(e: any) => onDetailLayout(e.nativeEvent.layout.y)}>
            <DetailPanelContent
              ctx={effectiveSelectedShiftContext}
              closeOutSummary={selectedShiftCloseOutSummary}
              closeOutNotesDraft={closeOutNotesDraft}
              setCloseOutNotesDraft={setCloseOutNotesDraft}
              savingCloseOutNotes={savingCloseOutNotes}
              onSaveCloseOutNotes={onSaveCloseOutNotes}
              onOpenCoverage={onOpenCoverage}
              nowMs={operationalNowMs}
              onReconcileShift={onReconcileShift}
              onManageExtension={onManageExtension}
              amendmentsEnabled={!!amendmentsEnabled}
            />
          </View>
        ) : null}
      </Drawer>

    </View>
  );
}

// ─── LiveOpsReconciliationQueue ────────────────────────────────────────────────

function LiveOpsReconciliationQueue({
  rows,
  nowMs,
  resolveShiftZone,
  onOpenShift,
  onReconcileShift,
}: {
  rows: ReconciliationRow[];
  nowMs: number;
  resolveShiftZone: (shiftId?: number | null) => string;
  onOpenShift: (shiftId: number) => void;
  /** Opens the Close without Book Off dialog; nothing is changed until it is confirmed there. */
  onReconcileShift?: (shiftId: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <View style={styles.reconPanel} {...({ accessibilityRole: 'region', 'aria-label': 'Needs reconciliation' } as any)}>
      <Text style={styles.reconTitle}>Needs reconciliation · {rows.length}</Text>
      <Text style={styles.reconCaption}>
        Booked On with no Book Off, more than 24 hours after the scheduled end. Not counted as live. A shift
        leaves this list only when the Guard books off or a shift manager closes it without a Book Off.
      </Text>
      {rows.map(({ shift, bookedOnAt, openAlerts }) => {
        const zone = resolveShiftZone(shift.id);
        const hoursOverdue = hoursPastEnd(shift.end, nowMs);
        return (
          <View key={shift.id} style={styles.reconRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open shift ${shift.id}`}
            style={[styles.reconRowOpen, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onOpenShift(shift.id)}
          >
            <View style={styles.reconRowMain}>
              <Text style={styles.reconRowTitle} numberOfLines={1}>
                {shift.site?.name || shift.siteName || 'Site'} · {shift.guard?.fullName || 'Unassigned'}
              </Text>
              <Text style={styles.reconRowMeta} numberOfLines={3}>
                {formatUkRange(shift.start, shift.end, zone)}
                {' · '}Booked On {bookedOnAt ? formatUkDateTime(bookedOnAt, zone) : 'not recorded'}
                {' · '}No Book Off
              </Text>
            </View>
            <View style={styles.reconRowSide}>
              <Text style={styles.reconBadge}>{hoursOverdue}h overdue</Text>
              {openAlerts > 0 ? (
                <Text style={styles.reconAlerts}>{openAlerts} open alert{openAlerts === 1 ? '' : 's'}</Text>
              ) : null}
            </View>
          </Pressable>
          {onReconcileShift ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Close shift ${shift.id} without Book Off`}
              style={[styles.reconAction, IS_WEB ? (WEB_PTR as any) : null]}
              onPress={() => onReconcileShift(shift.id)}
            >
              <Text style={styles.reconActionText}>Close without Book Off</Text>
            </Pressable>
          ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ─── DetailPanelContent ────────────────────────────────────────────────────────

function DetailPanelContent({
  ctx,
  closeOutSummary,
  closeOutNotesDraft,
  setCloseOutNotesDraft,
  savingCloseOutNotes,
  onSaveCloseOutNotes,
  onOpenCoverage,
  nowMs,
  onReconcileShift,
  onManageExtension,
  amendmentsEnabled,
}: {
  ctx: SelectedShiftContext;
  closeOutSummary: CloseOutSummary | null;
  closeOutNotesDraft: string;
  setCloseOutNotesDraft: (v: string) => void;
  savingCloseOutNotes: boolean;
  onSaveCloseOutNotes: () => void;
  onOpenCoverage: (context?: { uncoveredOnly?: boolean; shiftId?: number }) => void;
  nowMs: number;
  onReconcileShift?: (shiftId: number) => void;
  onManageExtension?: (shiftId: number) => void;
  amendmentsEnabled: boolean;
}) {
  const { shift, attendance, timesheet, logs, incidents, alerts, lifecycleStatus, badge, exception, clientName, operations } = ctx;
  const timeZone = shift.site?.timezone || operations?.timezone || DEFAULT_SITE_TIME_ZONE;
  const operationsSections = operationsDetailLines(operations);
  const operationsExceptions = operationalExceptions(operations);
  const welfareRows = welfareWindowRows(operations, { nowMs, timeZone, shiftStatus: shift.status });
  // Welfare Phase 4: a recorded Book Off more than 15 minutes before the scheduled end. The coverage
  // assessment is the backend's; when monitoring has not loaded it is said to be unavailable, never guessed.
  const minutesEarly = earlyBookOffMinutes(shift.end, attendance?.checkOutAt);
  const early = operations?.earlyBookOff ?? null;

  return (
    <>
      <View style={styles.detailHeader}>
        <View style={styles.detailHeaderLeft}>
          <Text style={styles.detailTitle}>Shift #{shift.id}</Text>
          <Text style={styles.detailMeta}>{clientName} · {shift.site?.name || shift.siteName}</Text>
          <Text style={styles.detailMeta}>
            {shift.guard?.fullName || 'No guard assigned'} · {fmtDate(shift.start, timeZone)} · {fmtTime(shift.start, timeZone)}–{fmtTime(shift.end, timeZone)}
          </Text>
          <Text style={styles.detailMeta}>{welfareIntervalLabel(operations, shift)}</Text>
        </View>
        <View style={[styles.detailBadge, { borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>
          <Text style={[styles.detailBadgeText, { color: badge.color }]}>{badge.icon} {badge.label}</Text>
        </View>
      </View>

      {exception ? (
        <View style={styles.detailException}>
          <Text style={styles.detailExceptionTitle}>{exception.title}</Text>
          <Text style={styles.detailExceptionMsg}>{exception.message}</Text>
          <Text style={styles.detailExceptionOutcome}>{exception.outcome}</Text>
        </View>
      ) : null}

      {lifecycleStatus === 'unfilled' ? (
        <View style={styles.detailAction}>
          <Text style={styles.detailActionMsg}>No confirmed guard linked. This shift needs cover.</Text>
          <Pressable
            style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onOpenCoverage({ uncoveredOnly: true, shiftId: shift.id })}
          >
            <Text style={styles.detailPrimaryBtnText}>Manage Coverage</Text>
          </Pressable>
        </View>
      ) : null}
      {lifecycleStatus === 'offered'     ? <Text style={styles.detailInfoMsg}>Waiting for guard confirmation before live controls are used.</Text> : null}
      {lifecycleStatus === 'in_progress' ? (
        <Text style={styles.detailInfoMsg}>
          {ctx.badge.label === 'Missing Book Off' || ctx.badge.label === 'No Book Off'
            // Phase 3: never "live" once the Book Off is overdue. No Book Off time is shown or invented.
            ? 'Booked On, but no Book Off has been recorded. The shift stays in progress until the Guard books off or it is reconciled.'
            : 'Guard is booked on and the shift is live.'}
        </Text>
      ) : null}
      {lifecycleStatus === 'ready'       ? <Text style={styles.detailInfoMsg}>Guard confirmed. Ready for book on.</Text>                          : null}
      {lifecycleStatus === 'completed' ? (
        <Text style={styles.detailInfoMsg}>
          {isCompletedWithoutBookOff(shift, attendance)
            // Which label is decided by the reconciliation audit entry, never inferred. No time is shown or invented.
            ? `${completedWithoutBookOffLabel(ctx.closedByControl)}. No Book Off time was recorded. Records remain visible.`
            : minutesEarly !== null
              ? `Booked off early, ${formatDuration(minutesEarly)} before the scheduled end. Records remain visible.`
              : 'Shift completed. Records remain visible.'}
        </Text>
      ) : null}
      {onReconcileShift && isEligibleForReconciliation(shift, attendance, nowMs) ? (
        <View style={styles.detailAction}>
          <Text style={styles.detailActionMsg}>
            Booked On, no Book Off, and past the scheduled end plus 15 minutes. A shift manager can close it
            without a Book Off, with a reason; nothing is fabricated.
          </Text>
          <Pressable
            accessibilityRole="button"
            style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onReconcileShift(shift.id)}
          >
            <Text style={styles.detailPrimaryBtnText}>Close without Book Off</Text>
          </Pressable>
        </View>
      ) : null}
      {shift.originalEnd ? (
        <Text style={styles.detailInfoMsg}>
          Extended: originally scheduled to end {formatUkDateTime(shift.originalEnd, timeZone)}, now {formatUkDateTime(shift.end, timeZone)}.
        </Text>
      ) : null}
      {onManageExtension && ((amendmentsEnabled && isEligibleForExtension(shift, attendance, nowMs)) || !!shift.originalEnd) ? (
        <View style={styles.detailAction}>
          <Text style={styles.detailActionMsg}>
            {amendmentsEnabled && isEligibleForExtension(shift, attendance, nowMs)
              ? "The Guard is on shift. Propose a later end, follow the Guard's answer and management approval, and see every change."
              : 'See every extension of this shift and where each one stands.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
            onPress={() => onManageExtension(shift.id)}
          >
            <Text style={styles.detailPrimaryBtnText}>
              {amendmentsEnabled && isEligibleForExtension(shift, attendance, nowMs) ? 'Shift extension' : 'Extension history'}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {shift.instructions ? (
        <Text style={styles.detailInstructions}>Instructions: {shift.instructions}</Text>
      ) : null}

      <View style={styles.detailGrid}>

        {lifecycleStatus === 'completed' && closeOutSummary ? (
          <View style={[styles.detailCard, styles.detailCardCloseOut]}>
            <Text style={styles.detailCardTitle}>Close-Out</Text>
            {/* Phase 4: a shift Control closed without a Book Off is never "Closed cleanly". */}
            <Text style={closeOutSummary.closedCleanly && !isCompletedWithoutBookOff(shift, attendance) && minutesEarly === null ? styles.detailCloseOutGood : styles.detailCloseOutWarn}>
              {/* Welfare Phase 4: never "Closed cleanly" when the Guard left more than 15 minutes early. */}
              {minutesEarly !== null
                ? `Booked off early${early ? ` · ${COVERAGE_WORD[early.coverage.status]}` : ''}${closeOutSummary.unresolvedFollowUpCount > 0 ? ` · needs follow-up (${closeOutSummary.unresolvedFollowUpCount})` : ''}`
                : isCompletedWithoutBookOff(shift, attendance)
                ? closeOutSummary.unresolvedFollowUpCount > 0
                  ? `${completedWithoutBookOffLabel(ctx.closedByControl)} · needs follow-up (${closeOutSummary.unresolvedFollowUpCount})`
                  : completedWithoutBookOffLabel(ctx.closedByControl)
                : closeOutSummary.closedCleanly ? 'Closed cleanly' : `Needs follow-up (${closeOutSummary.unresolvedFollowUpCount})`}
            </Text>
            <Text style={styles.detailLine}>Scheduled: {fmtDateTime(closeOutSummary.scheduledStart, timeZone)} → {fmtDateTime(closeOutSummary.scheduledEnd, timeZone)}</Text>
            <Text style={styles.detailLine}>Actual: {fmtDateTime(closeOutSummary.actualCheckInAt, timeZone)} → {fmtDateTime(closeOutSummary.actualCheckOutAt, timeZone)}</Text>
            <Text style={styles.detailLine}>Logs: {closeOutSummary.logsCount} · Incidents: {closeOutSummary.incidentsCount} · Safety: {closeOutSummary.safetyEventsCount}</Text>
            <Text style={styles.detailLine}>Welfare Checks: {closeOutSummary.completedCheckCalls} complete / {closeOutSummary.missedCheckCalls} missed</Text>
            <Text style={styles.detailLine}>Timesheet: {fmtStatus(closeOutSummary.timesheetStatus)}</Text>
            <View style={styles.detailCloseOutNotes}>
              <Text style={styles.detailSubLabel}>Close-out notes</Text>
              <TextInput
                style={styles.detailNotesInput}
                multiline
                value={closeOutNotesDraft}
                onChangeText={setCloseOutNotesDraft}
                placeholder="Short operational handover note"
                placeholderTextColor={colors.textMuted}
              />
              <Pressable
                style={[styles.detailPrimaryBtn, IS_WEB ? (WEB_PTR as any) : null]}
                onPress={onSaveCloseOutNotes}
                disabled={savingCloseOutNotes}
              >
                <Text style={styles.detailPrimaryBtnText}>{savingCloseOutNotes ? 'Saving…' : 'Save Note'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {minutesEarly !== null ? (
          <View style={[styles.detailCard, styles.detailCardCloseOut]} accessibilityLabel="Early Book Off">
            <Text style={styles.detailCardTitle}>Booked Off Early</Text>
            <Text style={styles.detailStateLine}>
              Book Off {fmtTime(attendance?.checkOutAt ?? null, timeZone)}
              <Text style={styles.detailStateMuted}>{'  ·  '}Scheduled end {fmtDateTime(shift.end, timeZone)}</Text>
            </Text>
            <Text style={styles.detailLine}>Remaining scheduled time: {formatDuration(minutesEarly)}</Text>
            {early ? (
              <>
                <Text style={[styles.detailLine, { color: operationsToneColor(COVERAGE_TONE[early.coverage.status]), fontWeight: '700' }]}>
                  {COVERAGE_WORD[early.coverage.status]}
                </Text>
                <Text style={styles.detailLine}>{coverageSentence(early)}</Text>
                <Text style={styles.detailLine}>{staffingSentence(early)}</Text>
              </>
            ) : (
              <Text style={styles.detailLine}>Coverage assessment is not available right now.</Text>
            )}
            <Text style={styles.detailStateMuted}>
              Recorded as the Guard booked off. Worked hours come from the attendance record and are not changed;
              related alerts are listed under Safety Alerts.
            </Text>
          </View>
        ) : null}

        {operationsSections.length ? (
          <View style={styles.detailCard}>
            <Text style={styles.detailCardTitle}>Operational monitoring</Text>
            {operationsExceptions.length ? (
              <View style={styles.detailExceptionWrap}>
                {operationsExceptions.map((item) => (
                  <View
                    key={item.key}
                    style={[styles.detailExceptionChip, { borderColor: operationsToneColor(item.tone) }]}
                  >
                    <Text style={[styles.detailExceptionLabel, { color: operationsToneColor(item.tone) }]}>
                      {item.label}
                    </Text>
                    <Text style={styles.detailExceptionDetail}>{item.detail}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {operationsSections.map((section) => (
              <View key={section.heading} style={styles.detailOpsSection}>
                <Text style={styles.detailOpsHeading}>{section.heading}</Text>
                {section.lines.map((line, index) => (
                  <Text key={`${section.heading}-${index}`} style={styles.detailLine}>{line}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}

        {/* Welfare Phase 2: every scheduled window, what happened in it, and the alert it raised. The states
            and times are the backend's; this card only words them. A history record of a miss is never
            presented as "Closed" — the alert that carried it says who resolved it, if anyone did. */}
        {welfareRows.length ? (
          <View style={styles.detailCard}>
            <Text style={styles.detailCardTitle}>Welfare Checks</Text>
            {welfareRows.map((row) => (
              <View
                key={row.key}
                style={styles.welfareRow}
                accessibilityLabel={`${row.date} ${row.window}, ${row.stateWord}${row.checkedAt ? `, checked at ${row.checkedAt}` : ''}${row.alert ? `, ${row.alert}` : ''}`}
              >
                <Text style={styles.welfareWindow}>
                  {row.window}
                  <Text style={styles.detailStateMuted}>{'  '}{row.date}</Text>
                </Text>
                <Text style={[styles.welfareState, WELFARE_ROW_TONE[row.state] ?? null]}>
                  {WELFARE_MARKER_GLYPH[row.state]} {row.stateWord}
                </Text>
                <Text style={styles.welfareDetail}>
                  {row.checkedAt ? `Checked ${row.checkedAt}` : row.missRecordedAt ? `Recorded ${row.missRecordedAt}` : ''}
                  {row.alert ? `${row.checkedAt || row.missRecordedAt ? ' · ' : ''}${row.alert}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Attendance reads as a comparison, because that is the question: did the guard arrive when
            they were supposed to? The scheduled time sits beside the actual one rather than three lines
            away in the header. */}
        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Attendance &amp; Timesheet</Text>
          <Text style={styles.detailStateLine}>
            Book On {attendance?.checkInAt ? fmtTime(attendance.checkInAt, timeZone) : '—'}
            <Text style={styles.detailStateMuted}>{'  ·  '}Scheduled {fmtTime(shift.start, timeZone)}</Text>
          </Text>
          <Text style={styles.detailStateLine}>
            Book Off {attendance?.checkOutAt ? fmtTime(attendance.checkOutAt, timeZone) : '—'}
            <Text style={styles.detailStateMuted}>{'  ·  '}Scheduled {fmtTime(shift.end, timeZone)}</Text>
          </Text>
          <Text style={styles.detailLine}>Timesheet: {fmtStatus(timesheet?.approvalStatus || 'pending')}</Text>
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Daily Logs</Text>
          {logs.length === 0
            ? <DetailEmpty title="No daily logs" desc="Logs for this shift will appear here." />
            /*
              Each entry names its own type. A Log Book entry and a Welfare Check were rendered
              identically here, so a controller could not tell a written narrative from a proof of
              presence — and the two satisfy different obligations. The stored enum is untouched;
              only the reading changes.
            */
            : logs.map((log) => (
                <View key={log.id} style={styles.detailLogRow}>
                  <Text style={styles.detailListLine}>
                    <Text style={styles.detailListTime}>{fmtTime(log.createdAt, timeZone)}</Text>
                    {'  '}{log.message}
                  </Text>
                  <Text style={styles.detailLogKind}>{logTypeLabel(log.logType).toUpperCase()}</Text>
                </View>
              ))}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Incidents</Text>
          {incidents.length === 0
            ? <DetailEmpty title="No incidents" desc="Incidents linked to this shift will appear here." />
            : incidents.map((inc) => (
                <Text key={inc.id} style={styles.detailListLine}>
                  <Text style={styles.detailListTime}>{fmtTime(inc.createdAt, timeZone)}</Text>
                  {'  '}{inc.title} ({fmtStatus(inc.status)})
                </Text>
              ))}
        </View>

        <View style={styles.detailCard}>
          <Text style={styles.detailCardTitle}>Safety Alerts</Text>
          {alerts.length === 0
            ? <DetailEmpty title="No safety events" desc="Welfare, Emergency and Site Request items will appear here." />
            : alerts.map((a) => (
                <Text key={a.id} style={styles.detailListLine}>
                  <Text style={styles.detailListTime}>{fmtTime(a.createdAt, timeZone)}</Text>
                  {'  '}{safetyAlertDrawerLabel(a)}
                </Text>
              ))}
        </View>

      </View>
    </>
  );
}

/** Missed and still-due windows stand out in the drawer list; the glyph and word carry the meaning too. */
const WELFARE_ROW_TONE: Partial<Record<WelfareDisplayState, any>> = {
  missed: { color: colors.danger },
  overdue: { color: colors.warning },
  completed: { color: colors.success },
};

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  welfareRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: spacing.sm,
    rowGap: 2,
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  welfareWindow: { fontSize: 12, fontWeight: '700', color: colors.textPrimary, minWidth: 150 },
  welfareState: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, minWidth: 130 },
  welfareDetail: { fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
  root: {
    flex: 1,
    gap: spacing.sm,
  },

  // ── Feedback banner ───────────────────────────────────────────────────────
  addShiftBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radii.sm,
    backgroundColor: colors.accentTeal,
    flexShrink: 0,
  },
  addShiftBtnPressed: {
    opacity: 0.85,
  },
  addShiftBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  liveOpsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  liveOpsHeaderText: {
    flex: 1,
    gap: 2,
  },
  liveOpsHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  liveOpsHeaderCaption: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  statusMetricState: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning,
    marginTop: 1,
  },
  sourceNotice: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.sm,
    margin: spacing.sm,
  },
  sourceNoticeText: {
    fontSize: 12,
    color: colors.danger,
  },
  unavailableText: {
    color: colors.warning,
  },
  feedbackBanner: {
    borderRadius: radii.card,
    borderWidth: 1,
    padding: spacing.md,
  },
  feedbackBannerSuccess: {
    backgroundColor: colors.successSurface,
    borderColor: colors.successBorder,
  },
  feedbackBannerError: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
  },
  feedbackTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  feedbackTitleSuccess:  { color: colors.success },
  feedbackTitleError:    { color: colors.danger },
  feedbackText:          { fontSize: 12, lineHeight: 17 },
  feedbackTextSuccess:   { color: colors.success },
  feedbackTextError:     { color: colors.danger },

  // ── Operational state bar ─────────────────────────────────────────────────
  statusBar: {
    flexDirection: 'row',
    // A minimum, not a fixed height (Phase 3): at phone width "NOT BOOKED ON" and "NO BOOK OFF" wrap to
    // three lines and were clipped. On a desktop every label is one line and the bar is still 52px.
    minHeight: 52,
    flexShrink: 0,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  statusBarSep: {
    width: 1,
    backgroundColor: colors.border,
    alignSelf: 'stretch',
  },
  statusMetric: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
  },
  statusMetricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusMetricValue: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  statusMetricLabel: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    textAlign: 'center',
  },
  statusMetricActiveLine: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: colors.accentAqua,
  },

  // ── Metric focus hint ─────────────────────────────────────────────────────
  metricFocusHint: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    gap: spacing.sm,
    flexShrink: 0,
  },
  metricFocusHintText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  metricFocusHintClear: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metricFocusHintClearText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accentTeal,
  },

  // ── Filter toolbar ────────────────────────────────────────────────────────
  filterBar: {
    flexDirection: 'row',
    // Wraps on a narrow screen (Phase 3): at phone width the fixed-height single row pushed the date
    // field and Today off the edge. On a desktop it is still one row.
    flexWrap: 'wrap',
    gap: spacing.sm,
    alignItems: 'flex-start',
    minHeight: 36,
    flexShrink: 0,
  },
  filterInput: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.sm,
    fontSize: 12,
    color: colors.primaryNavyStrong,
  },

  // ── Needs Reconciliation ──────────────────────────────────────────────────
  reconPanel: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
    gap: spacing.xs,
  },
  reconTitle: { fontSize: 14, fontWeight: '700', color: colors.primaryNavyStrong },
  reconCaption: { fontSize: 12, color: colors.textSecondary },
  reconRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reconRowOpen: { flex: 1, minWidth: 220, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  reconAction: {
    paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radii.sm, borderWidth: 1,
    borderColor: colors.warning, backgroundColor: colors.warningSurface,
  },
  reconActionText: { fontSize: 12, fontWeight: '800', color: colors.primaryNavyStrong },
  reconRowMain: { flex: 1, minWidth: 0 },
  reconRowTitle: { fontSize: 13, fontWeight: '700', color: colors.primaryNavyStrong },
  reconRowMeta: { fontSize: 12, color: colors.textSecondary },
  reconRowSide: { alignItems: 'flex-end' },
  reconBadge: { fontSize: 11, fontWeight: '700', color: colors.warning },
  reconAlerts: { fontSize: 11, color: colors.textSecondary },

  // ── Command workspace row ─────────────────────────────────────────────────
  // The timeline takes the space the flat table used to, beside the Attention rail.
  timelineColumn: { flex: 1, minWidth: 0, gap: 6 },
  dateNav: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dateNavBtn: {
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card,
  },
  dateNavBtnText: { fontSize: 13, fontWeight: '800', color: colors.textSecondary, lineHeight: 15 },
  dateNavToday: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card,
  },
  dateNavTodayActive: { borderColor: colors.accentTeal },
  dateNavTodayText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  dateNavTodayTextActive: { color: colors.accentTeal },
  clearFocusBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accentTeal,
  },
  clearFocusText: { fontSize: 11, fontWeight: '700', color: colors.accentTeal },
  workspaceRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  attentionColumnStacked: { width: '100%', maxHeight: undefined },
  workspaceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    // No fixed height on web any more. The timeline is the primary surface and sizes to its own rows;
    // the summaries below simply start lower down when there are many sites. `flex-start` keeps the
    // rail from stretching to match a tall board.
    alignItems: IS_WEB ? 'flex-start' : undefined,
    flex:      IS_WEB ? undefined : 1,
    minHeight: IS_WEB ? undefined : 300,
  },

  // ── Current operations board (68-72%) ─────────────────────────────────────
  boardColumn: {
    flex: 70,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  boardPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  boardPanelHeaderBg: {
    backgroundColor: colors.surfaceSubtle,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primaryNavy,
    letterSpacing: 0.1,
  },
  panelCount: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  boardHScroll: {
    flex: 1,
  },
  boardHScrollContent: {
    flexGrow: 1,
  },
  boardTable: {
    flexGrow: 1,
    flexShrink: 0,
    flexDirection: 'column',
  },
  boardBodyScroll: {
    flex: 1,
  },
  boardHdrRow: {
    flexDirection: 'row',
    height: 32,
    alignItems: 'center',
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
    flexShrink: 0,
  },
  boardHdrCell: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    paddingHorizontal: 4,
  },
  boardRow: {
    flexDirection: 'row',
    minHeight: 48,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
  },
  boardRowSelected: {
    backgroundColor: colors.accentTealSoft,
  },
  boardRowHighlighted: {
    backgroundColor: colors.infoSurface,
  },
  boardCellCol: {
    flexDirection: 'column',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 2,
  },
  boardCell: {
    fontSize: 12,
    color: colors.textPrimary,
    paddingHorizontal: 4,
  },
  boardCellSite: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  boardCellGuard: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.textSecondary,
  },
  boardCellSiteRisk: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.warning,
    letterSpacing: 0.3,
  },
  boardCellAttPrimary: {
    fontSize: 12,
    fontWeight: '500',
  },
  boardCellWelfare: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  boardCellSm: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  boardCellStatusWrap: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  boardStatusBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  boardStatusText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  boardCellRisk: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 4,
  },
  boardCellDelay: {
    fontSize: 10,
    color: colors.warning,
    fontWeight: '500',
    paddingHorizontal: 4,
  },
  boardCellAlerts: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 3,
  },
  boardAlertInc: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.danger,
    backgroundColor: colors.dangerSurface,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  boardAlertPanic: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.warning,
    backgroundColor: colors.warningSurface,
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  boardAlertNone: {
    fontSize: 11,
    color: colors.textMuted,
  },
  boardCellAction: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  boardActionBtn: {
    borderWidth: 1,
    borderColor: colors.accentTeal,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: colors.card,
  },
  boardActionBtnPressed: {
    backgroundColor: colors.accentTealSoft,
  },
  boardActionBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accentTeal,
  },
  boardEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
    gap: spacing.xs,
  },
  boardEmptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  boardEmptyDesc: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  boardEmptyClearBtn: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accentTeal,
  },
  boardEmptyClearText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accentTeal,
  },

  // ── Attention rail (28-32%) ───────────────────────────────────────────────
  attentionColumn: {
    // A fixed 268px on desktop rather than 30% of the row: at 1366 a percentage rail ate a third of the
    // board, and the timeline is the surface a control room actually works from. Narrow enough to leave
    // the axis dominant, wide enough that "Missed Welfare Check" and a site name still fit on a line.
    ...(IS_WEB ? { width: 268, flexGrow: 0, flexShrink: 0, maxHeight: 620 } : { flex: 30 }),
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  railSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
  },
  railSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  railSectionHint: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  nextUpItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  nextUpTime: { fontSize: 11, fontWeight: '800', color: colors.textPrimary, width: 38 },
  nextUpBody: { flex: 1, minWidth: 0, gap: 1 },
  nextUpLabel: { fontSize: 11, color: colors.textPrimary, fontWeight: '600' },
  nextUpSite: { fontSize: 10, color: colors.textSecondary },
  attentionPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  attentionPanelHeaderBg: {
    backgroundColor: colors.surfaceSubtle,
  },
  attentionCountBadge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  attentionCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textOnBrand,
  },
  attentionScroll: {
    flex: 1,
  },
  attentionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  attentionItemLast: {
    borderBottomWidth: 0,
  },
  attentionDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 1,
  },
  attentionState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  attentionStateMark: { fontSize: 11, fontWeight: '800', color: colors.success },
  attentionStateText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  attentionItemHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  attentionSevDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    flexShrink: 0,
  },
  attentionIssueType: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  attentionBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  attentionBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  attentionTime: {
    fontSize: 10,
    color: colors.textMuted,
    flexShrink: 0,
  },
  attentionMeta: {
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 6,
  },
  attentionActions: {
    flexDirection: 'row',
  },
  aBtn: {
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aBtnPrimary: {
    backgroundColor: colors.accentTeal,
  },
  aBtnPrimaryText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textOnBrand,
  },
  aBtnSecondary: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
  },
  aBtnSecondaryText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  attentionEmpty: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: 4,
  },
  attentionEmptyTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.success,
  },
  attentionEmptyDesc: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  // ── Supporting snapshot strip ─────────────────────────────────────────────
  lowerStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexShrink: 0,
    ...(IS_WEB ? { flexWrap: 'wrap' as any } : {}),
  },
  lowerPanel: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.md,
    gap: 4,
    minHeight: 72,
  },
  lowerPanelSummary: {
    flex: IS_WEB ? 10 : 1,
    ...(IS_WEB ? { minWidth: 300 } : {}),
  },
  lowerPanelHandovers: {
    flex: IS_WEB ? 8 : 1,
    ...(IS_WEB ? { minWidth: 240 } : {}),
  },
  lowerPanelActivity: {
    flex: IS_WEB ? 7 : 1,
    ...(IS_WEB ? { minWidth: 220 } : {}),
  },
  lowerPanelTitleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  lowerPanelScope: { fontSize: 10, color: colors.textMuted, fontWeight: '600', marginBottom: 4 },

  summaryGroupLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 6,
  },
  summaryRow: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
  summaryStat: { minWidth: 82, gap: 0 },
  summaryStatValue: { fontSize: 18, fontWeight: '800', color: colors.textPrimary, lineHeight: 22 },
  summaryStatWarn: { color: colors.warning },
  summaryStatBad: { color: colors.danger },
  summaryStatLabel: { fontSize: 10, color: colors.textSecondary, fontWeight: '600' },

  handoverItem: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 6 },
  handoverTime: { fontSize: 11, fontWeight: '800', color: colors.textPrimary, width: 38 },
  handoverBody: { flex: 1, minWidth: 0, gap: 1 },
  handoverSite: { fontSize: 11, fontWeight: '700', color: colors.textPrimary },
  handoverLine: { fontSize: 11, color: colors.textSecondary },
  handoverNote: { fontSize: 10, color: colors.textSecondary, fontWeight: '600' },
  handoverNoteBad: { color: colors.danger, fontWeight: '800' },
  lowerPanelTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginBottom: 4,
  },
  lowerPanelCta: {
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  lowerPanelCtaText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accentTeal,
  },
  lowerPanelCalm: {
    fontSize: 12,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  activityItem: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'flex-start',
    paddingVertical: 3,
  },
  activityItemDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 4,
    marginBottom: 1,
  },
  activityItemTime: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '500',
    width: 36,
    flexShrink: 0,
    paddingTop: 1,
  },
  activityItemBody: {
    flex: 1,
    gap: 1,
  },
  activityItemEvent: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
    lineHeight: 16,
  },
  activityItemSite: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  },
  /** The entry preview: readable, but quieter than the event it belongs to. */
  detailLogRow: { gap: 1, paddingBottom: 4 },
  detailLogKind: {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: 0.7,
    color: colors.textSecondary,
  },
  activityItemPreview: {
    fontSize: 11,
    color: colors.textPrimary,
    lineHeight: 15,
  },


  // ── Shift detail panel ────────────────────────────────────────────────────
  detailPanel: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  detailPanelEmpty: {
    height: 36,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  detailPanelEmptyText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  detailEmpty: {
    paddingVertical: spacing.sm,
    gap: 2,
  },
  detailEmptyTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  detailEmptyDesc: {
    fontSize: 11,
    color: colors.textMuted,
  },

  // ── Detail header ─────────────────────────────────────────────────────────
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  detailHeaderLeft: {
    flex: 1,
    gap: 3,
  },
  detailTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.primaryNavy,
  },
  detailMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  detailBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    flexShrink: 0,
  },
  detailBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Detail exception ──────────────────────────────────────────────────────
  detailException: {
    backgroundColor: colors.warningSurface,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: 3,
    marginBottom: spacing.xs,
  },
  detailExceptionTitle:   { fontSize: 13, fontWeight: '600', color: colors.warning },
  detailExceptionMsg:     { fontSize: 12, color: colors.textPrimary },
  detailExceptionOutcome: { fontSize: 12, color: colors.textSecondary },

  // ── Detail action / info ──────────────────────────────────────────────────
  detailAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  detailActionMsg: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
  },
  detailInfoMsg: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  detailInstructions: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },

  // ── Detail primary button ─────────────────────────────────────────────────
  detailPrimaryBtn: {
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.accentTeal,
    alignSelf: 'flex-start',
  },
  detailPrimaryBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textOnBrand,
  },

  // ── Detail grid ───────────────────────────────────────────────────────────
  detailGrid: {
    flexDirection: IS_WEB ? ('row' as any) : 'column',
    flexWrap:      IS_WEB ? ('wrap' as any) : undefined,
    gap: spacing.sm,
  },
  detailCard: {
    minWidth: IS_WEB ? 240 : undefined,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
    ...(IS_WEB ? { flex: 1 } : {}),
  },
  detailCardCloseOut: {
    ...(IS_WEB ? { flexBasis: '100%' } : {}),
  },
  // Section headings are the drawer's spine: a controller scans these five words to find the one part
  // of the shift they came in for, so they are set apart from the lines beneath them.
  detailCardTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
    marginBottom: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /** The one line per section a controller must be able to read without stopping. */
  detailStateLine: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 19,
  },
  detailStateMuted: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  detailListTime: { fontWeight: '700', color: colors.textSecondary },
  detailOpsSection: {
    marginTop: spacing.sm,
  },
  detailOpsHeading: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: 0.2,
    marginBottom: 3,
  },
  detailExceptionWrap: {
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  detailExceptionChip: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  detailExceptionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  detailExceptionDetail: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 1,
  },
  detailLine: {
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  detailListLine: {
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  detailSubLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: spacing.xs,
    marginBottom: 2,
  },
  detailNotesInput: {
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radii.sm,
    padding: spacing.sm,
    fontSize: 12,
    color: colors.textPrimary,
    minHeight: 56,
    ...(IS_WEB ? { outlineStyle: 'none' } as object : {}),
  },
  detailCloseOutGood: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
  },
  detailCloseOutWarn: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.warning,
  },
  detailCloseOutNotes: {
    gap: 4,
  },
});
