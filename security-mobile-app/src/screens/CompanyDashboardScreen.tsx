import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  ApiError,
  acknowledgeSafetyAlert,
  approveGuard,
  closeSafetyAlert,
  createClient,
  createJob,
  createShift,
  createSite,
  deleteShift,
  formatApiErrorMessage,
  listCompanyAttendance,
  listClients,
  listCompanyDailyLogs,
  listCompanyGuards,
  listCompanyIncidents,
  listCompanyNotifications,
  listCompanySafetyAlerts,
  listCompanyTimesheets,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  listSites,
  reviewJobApplication,
  updateIncidentStatus,
  updateClient,
  updateShift,
  updateSite,
} from '../services/api';
import {
  AttendanceEvent,
  Client,
  CompanyGuard,
  CreateClientPayload,
  CreateJobPayload,
  CreateShiftPayload,
  CreateSitePayload,
  DailyLog,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  Notification,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
  UpdateClientPayload,
  UpdateShiftPayload,
  UpdateSitePayload,
} from '../types/models';

type CompanySection =
  | 'dashboard'
  | 'clients'
  | 'sites'
  | 'rota-planner'
  | 'shift-offers'
  | 'live-operations'
  | 'guards'
  | 'recruitment'
  | 'timesheets'
  | 'incidents'
  | 'alerts';

type ClientFormState = {
  id?: number;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  status: string;
  notes: string;
};

type SiteFormState = {
  id?: number;
  clientId: string;
  name: string;
  address: string;
  contactDetails: string;
  status: string;
  requiredGuardCount: string;
  operatingDays: string;
  operatingStartTime: string;
  operatingEndTime: string;
  checkCallIntervalMinutes: string;
  specialInstructions: string;
  initialShiftDate: string;
  initialShiftStartTime: string;
  initialShiftEndTime: string;
};

type JobFormState = {
  title: string;
  description: string;
  guardsRequired: string;
  hourlyRate: string;
  siteId: string;
};

type PlannerRow = {
  localId: string;
  date: string;
  startTime: string;
  endTime: string;
  guardsRequired: string;
  assignedGuardId: string;
  status: string;
  instructions: string;
  sourceShiftIds: number[];
};

type LiveFilters = {
  clientId: string;
  siteId: string;
  guardId: string;
  date: string;
  status: string;
};

type NavItem = {
  id: CompanySection;
  label: string;
  caption: string;
};

type SettledLoader = {
  label: string;
  run: () => Promise<any>;
  apply: (value: any) => void;
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

type UrgentOperationalItem = {
  id: string;
  shiftId?: number | null;
  incidentId?: number | null;
  alertId?: number | null;
  status?: string | null;
  siteName: string;
  guardName: string;
  category:
    | 'panic'
    | 'incident'
    | 'late_start'
    | 'missed_check_call'
    | 'rejected_offer'
    | 'safety'
    | 'upcoming_risk'
    | 'missed_shift';
  issueType: string;
  message: string;
  occurredAt: string;
};

type ManagementActionItem = {
  id: string;
  shiftId?: number | null;
  siteName: string;
  guardName: string;
  itemType: string;
  actionTaken: string;
  occurredAt: string;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', caption: 'Control-room overview and KPIs.' },
  { id: 'clients', label: 'Clients', caption: 'Client accounts and contacts.' },
  { id: 'sites', label: 'Sites', caption: 'Site setup, instructions, and coverage.' },
  { id: 'rota-planner', label: 'Rota Planner', caption: 'Plan weekly cover and assignments.' },
  { id: 'shift-offers', label: 'Shift Offers', caption: 'Track pending responses and re-cover needs.' },
  { id: 'live-operations', label: 'Live Operations', caption: 'Monitor book-ons, logs, and incidents.' },
  { id: 'guards', label: 'Guards', caption: 'Available platform guards and linked team.' },
  { id: 'recruitment', label: 'Recruitment', caption: 'Open jobs and incoming applications.' },
  { id: 'timesheets', label: 'Timesheets', caption: 'Review worked hours and approvals.' },
  { id: 'incidents', label: 'Incidents', caption: 'Track reported site issues.' },
  { id: 'alerts', label: 'Safety Alerts', caption: 'Watch welfare and check-call alerts.' },
];

const CLIENT_FORM_EMPTY: ClientFormState = {
  name: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  status: 'active',
  notes: '',
};

const SITE_FORM_EMPTY: SiteFormState = {
  clientId: '',
  name: '',
  address: '',
  contactDetails: '',
  status: 'active',
  requiredGuardCount: '1',
  operatingDays: 'Mon-Fri',
  operatingStartTime: '08:00',
  operatingEndTime: '18:00',
  checkCallIntervalMinutes: '60',
  specialInstructions: '',
  initialShiftDate: '',
  initialShiftStartTime: '',
  initialShiftEndTime: '',
};

const JOB_FORM_EMPTY: JobFormState = {
  title: '',
  description: '',
  guardsRequired: '1',
  hourlyRate: '12',
  siteId: '',
};

const SHIFT_STATUS_OPTIONS = [
  { label: 'Unfilled', value: 'unfilled' },
  { label: 'Offered', value: 'offered' },
  { label: 'Ready', value: 'ready' },
  { label: 'Missed', value: 'missed' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
];

const UK_LOCALE = 'en-GB';
const MISSED_CHECK_IN_GRACE_MINUTES = 15;

function toNumber(value?: string | number | null) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDateTimeLabel(value?: string | null) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(UK_LOCALE, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

function getLiteralDateTimeParts(value?: string | null) {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) {
    return null;
  }

  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] || null,
    minute: match[5] || null,
  };
}

function formatDateLabel(value?: string | null) {
  if (!value) {
    return 'Not set';
  }

  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    return `${literalParts.day}/${literalParts.month}/${literalParts.year}`;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(UK_LOCALE, {
        day: '2-digit',
        month: '2-digit',
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

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  return value;
}

function formatStatusLabel(value?: string | null) {
  if (!value) {
    return 'Unknown';
  }

  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeShiftLifecycleStatus(value?: string | null) {
  const normalized = (value || '').trim().toLowerCase();

  switch (normalized) {
    case 'planned':
    case 'unassigned':
    case 'scheduled':
      return 'unfilled';
    case 'assigned':
      return 'offered';
    case 'accepted':
      return 'ready';
    default:
      return normalized || 'unfilled';
  }
}

function getShiftStatusBadge(status: string) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'missed':
      return { label: 'Missed', color: '#C2410C', icon: '⚠️' };
    case 'offered':
      return { label: 'Offered', color: '#3B82F6', icon: '🔵' };
    case 'ready':
      return { label: 'Ready', color: '#F59E0B', icon: '🟡' };
    case 'in_progress':
      return { label: 'Live', color: '#10B981', icon: '🟢' };
    case 'completed':
      return { label: 'Completed', color: '#374151', icon: '⚫' };
    case 'rejected':
      return { label: 'Rejected', color: '#EF4444', icon: '🔴' };
    case 'cancelled':
      return { label: 'Cancelled', color: '#9CA3AF', icon: '⚫' };
    case 'unfilled':
    default:
      return { label: 'Unfilled', color: '#6B7280', icon: '⚪' };
  }
}

function getLiveShiftRowTone(status: string) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'in_progress':
      return '#ECFDF5';
    case 'ready':
      return '#FFFBEB';
    case 'missed':
      return '#FFF7ED';
    case 'rejected':
      return '#FEF2F2';
    default:
      return '#ffffff';
  }
}

function getShiftExceptionSummary(status?: string | null) {
  switch (normalizeShiftLifecycleStatus(status || 'unfilled')) {
    case 'missed':
      return {
        title: 'Missed check-in exception',
        message: `No attendance check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`,
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

function getUrgentPrimaryActionLabel(item: UrgentOperationalItem) {
  switch (item.category) {
    case 'rejected_offer':
    case 'missed_shift':
      return 'Open Re-cover';
    case 'incident':
      return 'View Incident';
    case 'panic':
      return item.status === 'acknowledged' ? 'Resolve Alert' : 'View Alert';
    case 'missed_check_call':
      return item.status === 'acknowledged' ? 'Close Follow-up' : 'View Safety Detail';
    case 'safety':
      return item.status === 'acknowledged' ? 'Close Alert' : 'View Safety Detail';
    case 'late_start':
    case 'upcoming_risk':
    default:
      return 'Open Shift';
  }
}

function getUrgentNextActionText(item: UrgentOperationalItem) {
  switch (item.category) {
    case 'missed_shift':
      return 'Next action: arrange replacement cover.';
    case 'rejected_offer':
      return 'Next action: re-offer the shift.';
    case 'incident':
      return (item.status || '').toLowerCase() === 'open'
        ? 'Next action: acknowledge or review the incident.'
        : 'Next action: resolve or review the incident.';
    case 'panic':
      return item.status === 'acknowledged'
        ? 'Next action: close once the escalation is resolved.'
        : 'Next action: open the alert or escalate immediately.';
    case 'missed_check_call':
      return item.status === 'acknowledged'
        ? 'Next action: close once follow-up is complete.'
        : 'Next action: review and mark followed up.';
    case 'safety':
      return item.status === 'acknowledged'
        ? 'Next action: close once the issue is resolved.'
        : 'Next action: review and acknowledge.';
    case 'late_start':
      return 'Next action: open the shift and confirm attendance.';
    case 'upcoming_risk':
      return 'Next action: open the shift and contact the guard if needed.';
    default:
      return 'Next action: review this item.';
  }
}

function shouldShowOperationalActivityMessage(eventType: string) {
  return ![
    'Shift offered',
    'Shift accepted',
    'Shift missed',
    'Shift rejected',
    'Guard checked in',
    'Guard checked out',
    'Timesheet submitted',
  ].includes(eventType);
}

function getShiftRisk(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
  incidents: Incident[] = [],
  alerts: SafetyAlert[] = [],
) {
  let score = 0;
  const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
  const now = new Date();
  const shiftStart = new Date(shift.start);
  const hasStarted = !Number.isNaN(shiftStart.getTime()) && now.getTime() > shiftStart.getTime();

  if (
    alerts.some(
      (alert) =>
        (alert.type || '').toLowerCase() === 'panic' &&
        !['closed', 'resolved'].includes((alert.status || '').toLowerCase()),
    )
  ) {
    score += 100;
  }

  if (incidents.some((incident) => ['open', 'in_review'].includes((incident.status || '').toLowerCase()))) {
    score += 50;
  }

  if (lifecycleStatus === 'ready' && hasStarted && !attendance?.checkInAt) {
    score += 40;
  }

  if (isLikelyToMissCheckIn(shift, attendance)) {
    score += 35;
  }

  if (
    alerts.some(
      (alert) =>
        (alert.type || '').toLowerCase() === 'missed_checkcall' &&
        !['closed', 'resolved'].includes((alert.status || '').toLowerCase()),
    )
  ) {
    score += 30;
  }

  if (lifecycleStatus === 'rejected') {
    score += 25;
  }

  if (lifecycleStatus === 'missed') {
    score += 45;
  }

  if (score >= 80) {
    return { level: 'high' as const, color: '#EF4444', label: 'HIGH 🔴' };
  }

  if (score >= 40) {
    return { level: 'medium' as const, color: '#F59E0B', label: 'MEDIUM 🟡' };
  }

  return { level: 'low' as const, color: '#10B981', label: 'LOW 🟢' };
}

function getShiftDelay(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready') {
    return null;
  }

  const shiftStart = new Date(shift.start);
  const now = new Date();

  if (Number.isNaN(shiftStart.getTime()) || now.getTime() <= shiftStart.getTime() || attendance?.checkInAt) {
    return null;
  }

  return Math.max(1, Math.floor((now.getTime() - shiftStart.getTime()) / 60000));
}

function isShiftPastMissedGracePeriod(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready' || attendance?.checkInAt) {
    return false;
  }

  const shiftStart = new Date(shift.start);
  const now = new Date();

  if (Number.isNaN(shiftStart.getTime())) {
    return false;
  }

  return now.getTime() - shiftStart.getTime() >= MISSED_CHECK_IN_GRACE_MINUTES * 60000;
}

function isLikelyToMissCheckIn(
  shift: Shift,
  attendance?: { checkInAt: string | null; checkOutAt: string | null } | null,
) {
  if (normalizeShiftLifecycleStatus(shift.status) !== 'ready') {
    return false;
  }

  const now = new Date();
  const shiftStart = new Date(shift.start);

  if (Number.isNaN(shiftStart.getTime()) || attendance?.checkInAt) {
    return false;
  }

  const minutesToStart = (shiftStart.getTime() - now.getTime()) / 60000;
  return minutesToStart <= 15 && minutesToStart > 0;
}

function getSiteRiskLevel(
  siteId: number | undefined,
  shifts: Shift[],
  attendanceByShiftId: Map<number, { checkInAt: string | null; checkOutAt: string | null }>,
  incidentsByShiftId: Map<number, Incident[]>,
  alertsByShiftId: Map<number, SafetyAlert[]>,
) {
  if (!siteId) {
    return 'LOW';
  }

  let rejectedCount = 0;
  let highRiskCount = 0;
  let lateCount = 0;

  shifts.forEach((shift) => {
    const currentSiteId = shift.site?.id ?? shift.siteId;
    if (currentSiteId !== siteId) {
      return;
    }

    const attendance = attendanceByShiftId.get(shift.id);
    const risk = getShiftRisk(
      shift,
      attendance,
      incidentsByShiftId.get(shift.id) || [],
      alertsByShiftId.get(shift.id) || [],
    );

    if (normalizeShiftLifecycleStatus(shift.status) === 'rejected') {
      rejectedCount += 1;
    }

    if (risk.level === 'high') {
      highRiskCount += 1;
    }

    if (getShiftDelay(shift, attendance) !== null) {
      lateCount += 1;
    }
  });

  const score = rejectedCount + highRiskCount + lateCount;
  if (highRiskCount >= 2 || score >= 3) {
    return 'HIGH';
  }

  if (score >= 1) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function getLiveShiftBoardRowTone(
  status: string,
  riskLevel?: 'high' | 'medium' | 'low',
) {
  if (riskLevel === 'high') {
    return '#FEF2F2';
  }

  return getLiveShiftRowTone(status);
}

function ShiftStatusBadge({ status }: { status?: string | null }) {
  const badge = getShiftStatusBadge(status || 'unfilled');

  return (
    <View style={[styles.statusBadge, { borderColor: badge.color, backgroundColor: `${badge.color}14` }]}>
      <Text style={[styles.statusBadgeText, { color: badge.color }]}>{`${badge.icon} ${badge.label}`}</Text>
    </View>
  );
}

function buildIsoDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function parseDateInput(value: string) {
  if (!isValidDateInput(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildShiftDateTimes(date: string, startTime: string, endTime: string) {
  const startAt = buildIsoDateTime(date, startTime);
  const endDate =
    endTime <= startTime
      ? formatDateInput(addDays(parseDateInput(date) || new Date(`${date}T00:00:00`), 1))
      : date;

  return {
    startAt,
    endAt: buildIsoDateTime(endDate, endTime),
  };
}

function isValidDateInput(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeInput(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateSameDayShiftTiming(date: string, startTime: string, endTime: string) {
  if (!date || !startTime || !endTime) {
    return 'Date, start time, and end time are required.';
  }

  if (!isValidDateInput(date)) {
    return 'Use a valid date in DD/MM/YYYY format.';
  }

  if (!isValidTimeInput(startTime) || !isValidTimeInput(endTime)) {
    return 'Use valid 24-hour times for both start and end.';
  }

  return null;
}

function isoToDateInput(value?: string | null) {
  if (!value) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToTimeInput(value?: string | null) {
  if (!value) {
    return '';
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function weekCommencingFor(raw?: string) {
  const base = raw ? parseDateInput(raw) || new Date(`${raw}T00:00:00`) : new Date();
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(base, mondayOffset);
  return formatDateInput(monday);
}

function buildWeekDays(weekCommencing: string) {
  const start = parseDateInput(weekCommencing) || new Date(`${weekCommencing}T00:00:00`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date: formatDateInput(date),
      label: date.toLocaleDateString([], { weekday: 'long' }),
      shortLabel: date.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }),
    };
  });
}

function normalizePlannerStatus(status: string, assignedGuardId: string) {
  const normalizedStatus = normalizeShiftLifecycleStatus(status);

  if (normalizedStatus) {
    return normalizedStatus;
  }

  return assignedGuardId ? 'offered' : 'unfilled';
}

function buildPlannerRow(date: string): PlannerRow {
  return {
    localId: `${date}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    startTime: '08:00',
    endTime: '18:00',
    guardsRequired: '1',
    assignedGuardId: '',
    status: 'unfilled',
    instructions: '',
    sourceShiftIds: [],
  };
}

function WebSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [isBrowserSelectReady, setIsBrowserSelectReady] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserSelectReady(typeof document !== 'undefined');
  }, []);

  if (isBrowserSelectReady) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';

    return (
      <SelectTag
        value={value}
        onChange={(event: any) => onChange(event.target.value)}
        style={webSelectStyle}
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
      onChangeText={(nextValue: string) => onChange(nextValue)}
      placeholder={placeholder || (options[0] ? `${options[0].label}` : 'Enter value')}
      style={webSelectStyle}
      placeholderTextColor="#6b7280"
    />
  );
}

function NativeBrowserSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  placeholder?: string;
}) {
  const [isBrowserMounted, setIsBrowserMounted] = React.useState(false);

  React.useEffect(() => {
    setIsBrowserMounted(typeof document !== 'undefined');
  }, []);

  if (isBrowserMounted) {
    const SelectTag: any = 'select';
    const OptionTag: any = 'option';

    return (
      <SelectTag
        value={value}
        onChange={(event: any) => onChange(event.target.value)}
        style={webSelectStyle}
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
      value={options.find((option) => option.value === value)?.label || ''}
      editable={false}
      placeholder={placeholder || 'Select an option'}
      style={webSelectStyle}
      placeholderTextColor="#6b7280"
    />
  );
}

function ControlledDateInput({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  if (typeof document === 'undefined') {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        style={webSelectStyle}
        placeholderTextColor="#6b7280"
      />
    );
  }

  const InputTag: any = 'input';

  return (
    <InputTag
      type="date"
      value={value}
      onChange={(event: any) => onChange(event.target.value)}
      style={webSelectStyle}
    />
  );
}

function ControlledTimeInput({
  value,
  onChange,
  placeholder = 'HH:MM',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  if (typeof document === 'undefined') {
    return (
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        style={webSelectStyle}
        placeholderTextColor="#6b7280"
      />
    );
  }

  const InputTag: any = 'input';

  return (
    <InputTag
      type="time"
      value={value}
      onChange={(event: any) => onChange(event.target.value)}
      style={webSelectStyle}
    />
  );
}

export function CompanyDashboardScreen() {
  const [activeSection, setActiveSection] = React.useState<CompanySection>('dashboard');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [clients, setClients] = React.useState<Client[]>([]);
  const [sites, setSites] = React.useState<Site[]>([]);
  const [shifts, setShifts] = React.useState<Shift[]>([]);
  const [guards, setGuards] = React.useState<GuardProfile[]>([]);
  const [companyGuards, setCompanyGuards] = React.useState<CompanyGuard[]>([]);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [applications, setApplications] = React.useState<JobApplication[]>([]);
  const [attendanceEvents, setAttendanceEvents] = React.useState<AttendanceEvent[]>([]);
  const [timesheets, setTimesheets] = React.useState<Timesheet[]>([]);
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [alerts, setAlerts] = React.useState<SafetyAlert[]>([]);
  const [dailyLogs, setDailyLogs] = React.useState<DailyLog[]>([]);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [selectedSiteId, setSelectedSiteId] = React.useState<number | null>(null);
  const [selectedShiftId, setSelectedShiftId] = React.useState<number | null>(null);
  const [clientForm, setClientForm] = React.useState<ClientFormState>(CLIENT_FORM_EMPTY);
  const [siteForm, setSiteForm] = React.useState<SiteFormState>(SITE_FORM_EMPTY);
  const [jobForm, setJobForm] = React.useState<JobFormState>(JOB_FORM_EMPTY);
  const [plannerClientId, setPlannerClientId] = React.useState('');
  const [plannerSiteId, setPlannerSiteId] = React.useState('');
  const [plannerWeekCommencing, setPlannerWeekCommencing] = React.useState(weekCommencingFor());
  const [plannerRows, setPlannerRows] = React.useState<PlannerRow[]>([]);
  const [plannerRemovedShiftIds, setPlannerRemovedShiftIds] = React.useState<number[]>([]);
  const [liveFilters, setLiveFilters] = React.useState<LiveFilters>({
    clientId: '',
    siteId: '',
    guardId: '',
    date: '',
    status: '',
  });
  const [savingClient, setSavingClient] = React.useState(false);
  const [savingSite, setSavingSite] = React.useState(false);
  const [savingRota, setSavingRota] = React.useState(false);
  const [creatingJob, setCreatingJob] = React.useState(false);
  const [approvingGuardId, setApprovingGuardId] = React.useState<number | null>(null);
  const [reviewingApplicationId, setReviewingApplicationId] = React.useState<number | null>(null);
  const [offerActionShiftId, setOfferActionShiftId] = React.useState<number | null>(null);
  const [reassignGuardByShiftId, setReassignGuardByShiftId] = React.useState<Record<number, string>>({});
  const [shiftOffersFeedback, setShiftOffersFeedback] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [liveOperationsFeedback, setLiveOperationsFeedback] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [urgentActionItemId, setUrgentActionItemId] = React.useState<string | null>(null);
  const [managementActions, setManagementActions] = React.useState<ManagementActionItem[]>([]);
  const [closeOutNotesDraft, setCloseOutNotesDraft] = React.useState('');
  const [savingCloseOutNotes, setSavingCloseOutNotes] = React.useState(false);
  const [showArchivedClients, setShowArchivedClients] = React.useState(false);
  const [liveBoardAnchorY, setLiveBoardAnchorY] = React.useState(0);
  const [highlightedLiveShiftId, setHighlightedLiveShiftId] = React.useState<number | null>(null);
  const [liveBoardHighlightTimeoutId, setLiveBoardHighlightTimeoutId] = React.useState<ReturnType<typeof setTimeout> | null>(null);
  const [autoMarkingMissedShiftIds, setAutoMarkingMissedShiftIds] = React.useState<number[]>([]);

  const runSettledLoaders = React.useMemo(
    () => async (loaders: SettledLoader[]) => {
      const results = await Promise.allSettled(loaders.map((loader) => loader.run()));
      const failures: unknown[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
        loaders[index].apply(result.value);
      } else {
        failures.push(result.reason);
      }
      });

      return failures;
    },
    [],
  );

  const loadData = React.useMemo(
    () =>
    async (isRefresh = false) => {
      try {
        setError(null);
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }

        let latestSites: Site[] = [];
        let latestShifts: Shift[] = [];

        const coreFailures = await runSettledLoaders([
          {
            label: 'clients',
            run: listClients,
            apply: (value: Client[]) => setClients(value),
          },
          {
            label: 'sites',
            run: listSites,
            apply: (value: Site[]) => {
              latestSites = value;
              setSites(latestSites);
            },
          },
          {
            label: 'shifts',
            run: listShifts,
            apply: (value: Shift[]) => {
              latestShifts = value.map((shift) => ({
                ...shift,
                status: normalizeShiftLifecycleStatus(shift.status),
              }));
              setShifts(latestShifts);
            },
          },
          {
            label: 'guards',
            run: listGuards,
            apply: (value: GuardProfile[]) => setGuards(value),
          },
          {
            label: 'company guards',
            run: listCompanyGuards,
            apply: (value: CompanyGuard[]) => setCompanyGuards(value),
          },
        ]);

        if (!selectedSiteId && latestSites[0]) {
          setSelectedSiteId(latestSites[0].id);
        }

        if (!selectedShiftId && latestShifts[0]) {
          setSelectedShiftId(latestShifts[0].id);
        }

        const sectionLoaders: Partial<Record<CompanySection, SettledLoader[]>> = {
          'live-operations': [
              { label: 'attendance', run: listCompanyAttendance, apply: (value: AttendanceEvent[]) => setAttendanceEvents(value) },
              { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
              { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
              { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
              { label: 'daily logs', run: listCompanyDailyLogs, apply: (value: DailyLog[]) => setDailyLogs(value) },
              { label: 'notifications', run: listCompanyNotifications, apply: (value: Notification[]) => setNotifications(value) },
            ],
          recruitment: [
            { label: 'jobs', run: listJobs, apply: (value: Job[]) => setJobs(value) },
            { label: 'applications', run: listJobApplications, apply: (value: JobApplication[]) => setApplications(value) },
          ],
          timesheets: [
            { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
          ],
          incidents: [
            { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
          ],
          alerts: [
            { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
          ],
        };

        const sectionFailures = await runSettledLoaders(sectionLoaders[activeSection] || []);
        const failures = [...coreFailures, ...sectionFailures];

        if (failures.length > 0) {
          setError(formatApiErrorMessage(failures[0], 'Some company workspace data could not be loaded.'));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeSection, runSettledLoaders, selectedShiftId, selectedSiteId],
  );

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  React.useEffect(() => {
    if (activeSection !== 'live-operations') {
      return;
    }

    const intervalId = setInterval(() => {
      loadData(true);
    }, 15000);

    return () => clearInterval(intervalId);
  }, [activeSection, loadData]);

  React.useEffect(() => {
    return () => {
      if (liveBoardHighlightTimeoutId) {
        clearTimeout(liveBoardHighlightTimeoutId);
      }
    };
  }, [liveBoardHighlightTimeoutId]);

  const activeCompanyGuards = React.useMemo(
    () =>
      companyGuards.filter((entry) => {
        const relationActive = (entry.status || '').toUpperCase() === 'ACTIVE';
        const guardStatus = (entry.guard?.status || '').toLowerCase();
        const guardApproval = (entry.guard?.approvalStatus || '').toLowerCase();
        const operationalStatus = !guardStatus || guardStatus === 'active' || guardStatus === 'approved';
        const approvedStatus = !guardApproval || guardApproval === 'approved';
        return relationActive && operationalStatus && approvedStatus;
      }),
    [companyGuards],
  );

  const linkedGuardIds = React.useMemo(
    () => new Set(activeCompanyGuards.map((entry) => entry.guard?.id).filter((value): value is number => typeof value === 'number')),
    [activeCompanyGuards],
  );

  const linkedGuards = React.useMemo(() => {
    const unique = new Map<number, GuardProfile>();
    activeCompanyGuards.forEach((entry) => {
      if (entry.guard?.id) {
        unique.set(entry.guard.id, entry.guard);
      }
    });
    return Array.from(unique.values()).sort((left, right) => left.fullName.localeCompare(right.fullName));
  }, [activeCompanyGuards]);

  const availablePlatformGuards = React.useMemo(
    () =>
      guards.filter((guard) => {
        const guardStatus = (guard.status || '').toLowerCase();
        const guardApproval = (guard.approvalStatus || '').toLowerCase();
        const operationalStatus = !guardStatus || guardStatus === 'active' || guardStatus === 'approved';
        const approvedStatus = !guardApproval || guardApproval === 'approved';
        return operationalStatus && approvedStatus && !linkedGuardIds.has(guard.id);
      }),
    [guards, linkedGuardIds],
  );

  const clientMap = React.useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients]);
  const siteMap = React.useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const guardMap = React.useMemo(() => new Map(guards.map((guard) => [guard.id, guard])), [guards]);
  const timesheetByShiftId = React.useMemo(
    () => new Map(timesheets.map((timesheet) => [timesheet.shiftId, timesheet])),
    [timesheets],
  );
  const attendanceByShiftId = React.useMemo(() => {
    const map = new Map<number, { checkInAt: string | null; checkOutAt: string | null }>();

    attendanceEvents.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) {
        return;
      }

      const current = map.get(shiftId) || { checkInAt: null, checkOutAt: null };
      if (event.type === 'check-in') {
        if (!current.checkInAt || current.checkInAt.localeCompare(event.occurredAt) < 0) {
          current.checkInAt = event.occurredAt;
        }
      }
      if (event.type === 'check-out') {
        if (!current.checkOutAt || current.checkOutAt.localeCompare(event.occurredAt) < 0) {
          current.checkOutAt = event.occurredAt;
        }
      }

      map.set(shiftId, current);
    });

    return map;
  }, [attendanceEvents]);
  const incidentsByShiftId = React.useMemo(() => {
    const map = new Map<number, Incident[]>();
    incidents.forEach((incident) => {
      const shiftId = incident.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(incident);
      map.set(shiftId, group);
    });
    return map;
  }, [incidents]);
  const alertsByShiftId = React.useMemo(() => {
    const map = new Map<number, SafetyAlert[]>();
    alerts.forEach((alert) => {
      const shiftId = alert.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(alert);
      map.set(shiftId, group);
    });
    return map;
  }, [alerts]);
  const logsByShiftId = React.useMemo(() => {
    const map = new Map<number, DailyLog[]>();
    dailyLogs.forEach((log) => {
      const shiftId = log.shift?.id;
      if (!shiftId) {
        return;
      }

      const group = map.get(shiftId) || [];
      group.push(log);
      map.set(shiftId, group);
    });
    return map;
  }, [dailyLogs]);
  const lastCheckCallByShiftId = React.useMemo(() => {
    const map = new Map<number, DailyLog>();
    dailyLogs.forEach((log) => {
      const shiftId = log.shift?.id;
      if (!shiftId || !['check_call', 'welfare_check'].includes(log.logType)) {
        return;
      }

      const current = map.get(shiftId);
      if (!current || current.createdAt.localeCompare(log.createdAt) < 0) {
        map.set(shiftId, log);
      }
    });
    return map;
  }, [dailyLogs]);

  React.useEffect(() => {
    if (activeSection !== 'live-operations') {
      return;
    }

    const overdueReadyShifts = shifts.filter((shift) =>
      isShiftPastMissedGracePeriod(shift, attendanceByShiftId.get(shift.id)),
    );

    if (overdueReadyShifts.length === 0) {
      return;
    }

    let cancelled = false;

    const runAutomation = async () => {
      let automatedAny = false;

      for (const shift of overdueReadyShifts) {
        if (cancelled || autoMarkingMissedShiftIds.includes(shift.id)) {
          continue;
        }

        setAutoMarkingMissedShiftIds((current) => [...current, shift.id]);

        try {
          await updateShift(shift.id, { status: 'missed' });
          automatedAny = true;
          recordManagementAction({
            shiftId: shift.id,
            siteName: shift.site?.name || shift.siteName || 'Unknown site',
            guardName: shift.guard?.fullName || 'Unassigned',
            itemType: 'Shift automation',
            actionTaken: `Shift auto-marked missed after ${MISSED_CHECK_IN_GRACE_MINUTES} minutes without check-in`,
          });
          setLiveOperationsFeedback({
            tone: 'success',
            message: `Shift #${shift.id} was automatically marked as missed after ${MISSED_CHECK_IN_GRACE_MINUTES} minutes without check-in.`,
          });
        } catch (automationError) {
          setAutoMarkingMissedShiftIds((current) => current.filter((id) => id !== shift.id));
          if (!cancelled) {
            setError(formatApiErrorMessage(automationError, 'Unable to mark this missed shift automatically.'));
            setLiveOperationsFeedback({
              tone: 'error',
              message: formatApiErrorMessage(automationError, 'Unable to mark this missed shift automatically.'),
            });
          }
        }
      }

      if (automatedAny && !cancelled) {
        await loadData(true);
      }
    };

    runAutomation();

    return () => {
      cancelled = true;
    };
  }, [activeSection, attendanceByShiftId, autoMarkingMissedShiftIds, loadData, shifts]);

  const activeClients = React.useMemo(
    () => clients.filter((client) => (client.status || 'active').toLowerCase() !== 'archived'),
    [clients],
  );

  const activeSites = React.useMemo(
    () => sites.filter((site) => (site.status || 'active').toLowerCase() !== 'archived'),
    [sites],
  );

  const todayIso = formatDateInput(new Date());
  const shiftsToday = React.useMemo(
    () => shifts.filter((shift) => shift.start.slice(0, 10) === todayIso),
    [shifts, todayIso],
  );
  const liveShifts = React.useMemo(
    () => shifts.filter((shift) => ['ready', 'in_progress'].includes(normalizeShiftLifecycleStatus(shift.status))),
    [shifts],
  );
  const pendingTimesheets = React.useMemo(
    () => timesheets.filter((timesheet) => (timesheet.approvalStatus || '').toLowerCase() !== 'approved'),
    [timesheets],
  );
  const openIncidents = React.useMemo(
    () => incidents.filter((incident) => ['open', 'in_review'].includes((incident.status || '').toLowerCase())),
    [incidents],
  );
  const outstandingAlerts = React.useMemo(
    () => alerts.filter((alert) => (alert.status || '').toLowerCase() !== 'closed'),
    [alerts],
  );
  const missedCheckCalls = React.useMemo(
    () => outstandingAlerts.filter((alert) => ['check_call', 'missed_checkcall'].includes((alert.type || '').toLowerCase())),
    [outstandingAlerts],
  );
  const activePanicAlerts = React.useMemo(
    () => outstandingAlerts.filter((alert) => (alert.type || '').toLowerCase() === 'panic'),
    [outstandingAlerts],
  );
  const recentActivity = React.useMemo(
    () =>
      [...dailyLogs]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 6),
    [dailyLogs],
  );
  const shiftOfferRows = React.useMemo(
    () =>
      shifts
        .filter((shift) => ['offered', 'ready', 'rejected', 'missed'].includes(normalizeShiftLifecycleStatus(shift.status)))
        .sort((left, right) => left.start.localeCompare(right.start)),
    [shifts],
  );
  const pendingShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'offered'),
    [shiftOfferRows],
  );
  const readyShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'ready'),
    [shiftOfferRows],
  );
  const missedShiftOffers = React.useMemo(
    () => shiftOfferRows.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'missed'),
    [shiftOfferRows],
  );
  const rejectedShiftOffers = React.useMemo(
    () =>
      shiftOfferRows.filter((shift) =>
        normalizeShiftLifecycleStatus(shift.status) === 'rejected',
      ),
    [shiftOfferRows],
  );
  const urgentOperationalItems = React.useMemo(() => {
    const now = new Date();
    const items: UrgentOperationalItem[] = [];
    const readyShiftsNotBookedOn = shifts.filter((shift) => {
      const attendance = attendanceByShiftId.get(shift.id);
      return (
        normalizeShiftLifecycleStatus(shift.status) === 'ready' &&
        !attendance?.checkInAt &&
        new Date(shift.start).getTime() <= now.getTime()
      );
    });
    const upcomingRiskShifts = shifts.filter((shift) =>
      isLikelyToMissCheckIn(shift, attendanceByShiftId.get(shift.id)),
    );

    activePanicAlerts.forEach((alert) => {
      items.push({
        id: `panic-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'panic',
        issueType: 'Active panic alert',
        message: alert.message || 'Emergency assistance requested from a live shift.',
        occurredAt: alert.createdAt,
      });
    });

    openIncidents.forEach((incident) => {
      items.push({
        id: `incident-${incident.id}`,
        incidentId: incident.id,
        shiftId: incident.shift?.id ?? null,
        status: incident.status,
        siteName: incident.site?.name || incident.shift?.site?.name || 'Unknown site',
        guardName: incident.guard?.fullName || 'Unknown guard',
        category: 'incident',
        issueType: 'Incident unresolved',
        message: incident.title,
        occurredAt: incident.createdAt,
      });
    });

    readyShiftsNotBookedOn.forEach((shift) => {
      items.push({
        id: `ready-overdue-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'late_start',
        issueType: 'Guard not booked on',
        message: 'Shift start time has passed but the guard has not booked on yet.',
        occurredAt: shift.start,
      });
    });

    upcomingRiskShifts.forEach((shift) => {
      items.push({
        id: `upcoming-risk-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'upcoming_risk',
        issueType: 'Upcoming Risk',
        message: 'Starting soon – no check-in ⚠️',
        occurredAt: shift.start,
      });
    });

    shifts
      .filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'missed')
      .forEach((shift) => {
        items.push({
          id: `missed-${shift.id}`,
          shiftId: shift.id,
          status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        category: 'missed_shift',
        issueType: 'Re-cover required',
        message: `No check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`,
        occurredAt: shift.start,
      });
      });

    missedCheckCalls.forEach((alert) => {
      items.push({
        id: `checkcall-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'missed_check_call',
        issueType: 'Missed or overdue check call',
        message: alert.message || 'A scheduled check call needs attention.',
        occurredAt: alert.createdAt,
      });
    });

    rejectedShiftOffers.forEach((shift) => {
      items.push({
        id: `rejected-${shift.id}`,
        shiftId: shift.id,
        status: shift.status,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'No guard',
        category: 'rejected_offer',
        issueType: 'Re-offer required',
        message: 'The offered guard rejected this shift and replacement cover is still needed.',
        occurredAt: shift.start,
      });
    });

    outstandingAlerts
      .filter((alert) => ['welfare', 'late_checkin', 'other'].includes((alert.type || '').toLowerCase()))
      .forEach((alert) => {
      items.push({
        id: `attention-${alert.id}`,
        alertId: alert.id,
        shiftId: alert.shift?.id ?? null,
        status: alert.status,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        category: 'safety',
        issueType: 'Safety / welfare needs attention',
        message: alert.message || 'A safety or welfare item needs review.',
        occurredAt: alert.createdAt,
        });
      });

    return items
      .filter((item, index, current) => current.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 10);
  }, [
    activePanicAlerts,
    attendanceByShiftId,
    missedShiftOffers,
    missedCheckCalls,
    openIncidents,
    outstandingAlerts,
    rejectedShiftOffers,
    shifts,
  ]);
  const recentOperationalActivity = React.useMemo(() => {
    const items: OperationalActivityItem[] = [];

    shiftOfferRows.forEach((shift) => {
      const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
      items.push({
        id: `shift-${shift.id}-${lifecycleStatus}`,
        shiftId: shift.id,
        siteName: shift.site?.name || shift.siteName || 'Unknown site',
        guardName: shift.guard?.fullName || 'Unassigned',
        eventType:
          lifecycleStatus === 'offered'
            ? 'Shift offered'
            : lifecycleStatus === 'ready'
              ? 'Shift accepted'
              : lifecycleStatus === 'missed'
                ? 'Shift missed'
                : 'Shift rejected',
        message:
          lifecycleStatus === 'offered'
            ? 'Waiting for guard response.'
            : lifecycleStatus === 'ready'
              ? 'Guard accepted and shift is ready to start.'
              : lifecycleStatus === 'missed'
                ? `No check-in was recorded within ${MISSED_CHECK_IN_GRACE_MINUTES} minutes of shift start.`
                : 'Guard rejected and new cover is required.',
        occurredAt: shift.start,
      });
    });

    shifts
      .filter((shift) => isLikelyToMissCheckIn(shift, attendanceByShiftId.get(shift.id)))
      .forEach((shift) => {
        items.push({
          id: `likely-late-${shift.id}`,
          shiftId: shift.id,
          siteName: shift.site?.name || shift.siteName || 'Unknown site',
          guardName: shift.guard?.fullName || 'Unassigned',
          eventType: 'Likely late',
          message: 'Starting soon with no recorded check-in yet.',
          occurredAt: shift.start,
        });
      });

    attendanceEvents.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) {
        return;
      }

      if (event.type === 'check-in') {
        items.push({
          id: `attendance-in-${event.id}`,
          shiftId,
          siteName: event.shift?.site?.name || event.shift?.siteName || 'Unknown site',
          guardName: event.guard?.fullName || 'Unknown guard',
          eventType: 'Guard checked in',
          message: 'Guard booked on and the shift is now live.',
          occurredAt: event.occurredAt,
        });
      }

      if (event.type === 'check-out') {
        items.push({
          id: `attendance-out-${event.id}`,
          shiftId,
          siteName: event.shift?.site?.name || event.shift?.siteName || 'Unknown site',
          guardName: event.guard?.fullName || 'Unknown guard',
          eventType: 'Guard checked out',
          message: 'Guard booked off and the shift is completed.',
          occurredAt: event.occurredAt,
        });
      }
    });

    timesheets.forEach((timesheet) => {
      if (timesheet.submittedAt) {
        items.push({
          id: `timesheet-submitted-${timesheet.id}`,
          shiftId: timesheet.shift?.id ?? timesheet.shiftId,
          siteName: timesheet.shift?.site?.name || timesheet.shift?.siteName || 'Unknown site',
          guardName: timesheet.guard?.fullName || 'Unknown guard',
          eventType: 'Timesheet submitted',
          message: 'Worked hours were submitted for company review.',
          occurredAt: timesheet.submittedAt,
        });
      }
    });

    dailyLogs.forEach((log) => {
      items.push({
        id: `log-${log.id}`,
        shiftId: log.shift?.id,
        siteName: log.shift?.site?.name || log.shift?.siteName || 'Unknown site',
        guardName: log.guard?.fullName || 'Unknown guard',
        eventType:
          log.logType === 'check_call'
            ? 'Check call recorded'
            : log.logType === 'welfare_check'
              ? 'Welfare update recorded'
              : 'Log entry added',
        message: log.message,
        occurredAt: log.createdAt,
      });
    });

    incidents.forEach((incident) => {
      items.push({
        id: `incident-${incident.id}`,
        shiftId: incident.shift?.id,
        siteName: incident.site?.name || incident.shift?.site?.name || 'Unknown site',
        guardName: incident.guard?.fullName || 'Unknown guard',
        eventType: 'Incident raised',
        message: incident.title,
        occurredAt: incident.createdAt,
      });
    });

    alerts.forEach((alert) => {
      items.push({
        id: `alert-${alert.id}`,
        shiftId: alert.shift?.id,
        siteName: alert.shift?.site?.name || alert.shift?.siteName || 'Unknown site',
        guardName: alert.guard?.fullName || 'Unknown guard',
        eventType:
          (alert.type || '').toLowerCase() === 'panic'
            ? 'Panic alert sent'
            : (alert.type || '').toLowerCase() === 'welfare'
              ? 'Welfare update recorded'
              : 'Safety alert raised',
        message: alert.message,
        occurredAt: alert.createdAt,
      });
    });

    notifications.forEach((notification) => {
      items.push({
        id: `notification-${notification.id}`,
        shiftId: null,
        siteName: 'Control room',
        guardName: notification.user?.firstName || 'System',
        eventType: notification.title,
        message: notification.message,
        occurredAt: notification.sentAt || notification.createdAt,
      });
    });

    return items
      .filter((item, index, current) => current.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 8);
  }, [alerts, attendanceByShiftId, attendanceEvents, dailyLogs, incidents, notifications, shiftOfferRows, shifts, timesheets]);

  const recentManagementActivity = React.useMemo(
    () =>
      [...managementActions]
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 6),
    [managementActions],
  );

  const filteredClients = React.useMemo(
    () =>
      clients.filter((client) =>
        showArchivedClients ? true : (client.status || 'active').toLowerCase() !== 'archived',
      ),
    [clients, showArchivedClients],
  );

  const selectedSite = React.useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [selectedSiteId, sites],
  );

  const selectedShift = React.useMemo(
    () => shifts.find((shift) => shift.id === selectedShiftId) ?? null,
    [selectedShiftId, shifts],
  );
  const selectedShiftCloseOutSummary = React.useMemo(() => {
    if (!selectedShift) {
      return null;
    }

    const timesheet = timesheetByShiftId.get(selectedShift.id);
    const attendance = attendanceByShiftId.get(selectedShift.id);
    const shiftLogs = logsByShiftId.get(selectedShift.id) || [];
    const shiftIncidents = incidentsByShiftId.get(selectedShift.id) || [];
    const shiftAlerts = alertsByShiftId.get(selectedShift.id) || [];
    const completedCheckCalls = shiftLogs.filter((log) => log.logType === 'check_call').length;
    const missedCheckCallsForShift = shiftAlerts.filter(
      (alert) => (alert.type || '').toLowerCase() === 'missed_checkcall',
    ).length;
    const safetyEventsCount = shiftAlerts.filter(
      (alert) => !['check_call', 'missed_checkcall'].includes((alert.type || '').toLowerCase()),
    ).length;
    const unresolvedIncidentsCount = shiftIncidents.filter((incident) =>
      ['open', 'in_review'].includes((incident.status || '').toLowerCase()),
    ).length;
    const unresolvedAlertsCount = shiftAlerts.filter((alert) => (alert.status || '').toLowerCase() !== 'closed').length;
    const unresolvedFollowUpCount = unresolvedIncidentsCount + unresolvedAlertsCount;

    return {
      scheduledStart: selectedShift.start,
      scheduledEnd: selectedShift.end,
      actualCheckInAt: attendance?.checkInAt || null,
      actualCheckOutAt: attendance?.checkOutAt || null,
      logsCount: shiftLogs.length,
      incidentsCount: shiftIncidents.length,
      safetyEventsCount,
      completedCheckCalls,
      missedCheckCalls: missedCheckCallsForShift,
      timesheetStatus: timesheet?.approvalStatus || 'pending',
      unresolvedFollowUpCount,
      closedCleanly: unresolvedFollowUpCount === 0,
    };
  }, [selectedShift, timesheetByShiftId, attendanceByShiftId, logsByShiftId, incidentsByShiftId, alertsByShiftId]);

  React.useEffect(() => {
    setCloseOutNotesDraft(selectedShift?.closeOutNotes || '');
  }, [selectedShift?.id, selectedShift?.closeOutNotes]);

  const siteShiftCounts = React.useMemo(() => {
    const counts = new Map<number, number>();
    shifts.forEach((shift) => {
      const siteId = shift.site?.id ?? shift.siteId;
      if (!siteId) {
        return;
      }

      counts.set(siteId, (counts.get(siteId) || 0) + 1);
    });
    return counts;
  }, [shifts]);

  const siteOptions = React.useMemo(
    () =>
      sites.map((site) => ({
        label: `${site.name}${site.client ? ` · ${site.client.name}` : ''}`,
        value: String(site.id),
      })),
    [sites],
  );

  const siteClientOptions = React.useMemo(
    () => activeClients.map((client) => ({ label: client.name, value: String(client.id) })),
    [activeClients],
  );

  const selectedSiteClient = React.useMemo(
    () => clients.find((client) => String(client.id) === siteForm.clientId) ?? null,
    [clients, siteForm.clientId],
  );

  const linkedGuardOptions = React.useMemo(
    () =>
      linkedGuards.map((guard) => ({
        label: `${guard.fullName} · ${guard.phone}`,
        value: String(guard.id),
      })),
    [linkedGuards],
  );

  const linkedGuardNameById = React.useMemo(() => {
    const map = new Map<number, string>();
    linkedGuards.forEach((guard) => {
      map.set(guard.id, guard.fullName);
    });
    return map;
  }, [linkedGuards]);

  const plannerSiteOptions = React.useMemo(
    () =>
      sites
        .filter((site) => !plannerClientId || String(site.client?.id ?? site.clientId ?? '') === plannerClientId)
        .map((site) => ({ label: site.name, value: String(site.id) })),
    [plannerClientId, sites],
  );

  const plannerWeekDays = React.useMemo(() => buildWeekDays(plannerWeekCommencing), [plannerWeekCommencing]);

  const plannerRowsByDate = React.useMemo(() => {
    const map = new Map<string, PlannerRow[]>();
    plannerWeekDays.forEach((day) => map.set(day.date, []));
    plannerRows.forEach((row) => {
      const group = map.get(row.date) || [];
      group.push(row);
      map.set(row.date, group);
    });
    return map;
  }, [plannerRows, plannerWeekDays]);

  const plannerSite = React.useMemo(
    () => sites.find((site) => String(site.id) === plannerSiteId) ?? null,
    [plannerSiteId, sites],
  );

  React.useEffect(() => {
    if (!plannerSiteId) {
      setPlannerRows([]);
      setPlannerRemovedShiftIds([]);
      return;
    }

    const weekDates = new Set(plannerWeekDays.map((day) => day.date));
    const matchingShifts = shifts.filter((shift) => {
      const siteId = shift.site?.id ?? shift.siteId;
      return String(siteId ?? '') === plannerSiteId && weekDates.has(shift.start.slice(0, 10));
    });

    const rows = matchingShifts.map((shift) => ({
      localId: `shift-${shift.id}`,
      date: shift.start.slice(0, 10),
      startTime: isoToTimeInput(shift.start),
      endTime: isoToTimeInput(shift.end),
      guardsRequired: '1',
      assignedGuardId: shift.guard?.id ? String(shift.guard.id) : '',
      status: normalizeShiftLifecycleStatus(shift.status),
      instructions: shift.instructions || '',
      sourceShiftIds: [shift.id],
    }));

    setPlannerRows(rows);
    setPlannerRemovedShiftIds([]);
  }, [plannerSiteId, plannerWeekDays, shifts]);

  const resetClientForm = () => setClientForm(CLIENT_FORM_EMPTY);
  const resetSiteForm = () => setSiteForm(SITE_FORM_EMPTY);
  const resetJobForm = () => setJobForm(JOB_FORM_EMPTY);

  const handleEditClient = (client: Client) => {
    setClientForm({
      id: client.id,
      name: client.name,
      contactName: client.contactName || '',
      contactEmail: client.contactEmail || '',
      contactPhone: client.contactPhone || '',
      status: client.status || 'active',
      notes: client.contactDetails || '',
    });
    setActiveSection('clients');
  };

  const handleSaveClient = async () => {
    try {
      setSavingClient(true);
      const payload: CreateClientPayload | UpdateClientPayload = {
        name: clientForm.name.trim(),
        contactName: clientForm.contactName.trim() || undefined,
        contactEmail: clientForm.contactEmail.trim() || undefined,
        contactPhone: clientForm.contactPhone.trim() || undefined,
        contactDetails: clientForm.notes.trim() || undefined,
        status: clientForm.status || 'active',
      };

      if (!payload.name) {
        throw new Error('Client name is required.');
      }

      if (clientForm.id) {
        await updateClient(clientForm.id, payload);
      } else {
        await createClient(payload as CreateClientPayload);
      }

      resetClientForm();
      await loadData(true);
    } catch (saveError) {
      setError(formatApiErrorMessage(saveError, 'Unable to save this client right now.'));
    } finally {
      setSavingClient(false);
    }
  };

  const handleArchiveClient = async (client: Client) => {
    try {
      await updateClient(client.id, { status: 'archived' });
      await loadData(true);
    } catch (archiveError) {
      setError(formatApiErrorMessage(archiveError, 'Unable to archive this client right now.'));
    }
  };

  const handleEditSite = (site: Site) => {
    setSiteForm({
      id: site.id,
      clientId: String(site.client?.id ?? site.clientId ?? ''),
      name: site.name,
      address: site.address,
      contactDetails: site.contactDetails || '',
      status: site.status || 'active',
      requiredGuardCount: String(site.requiredGuardCount || 1),
      operatingDays: site.operatingDays || '',
      operatingStartTime: site.operatingStartTime || '',
      operatingEndTime: site.operatingEndTime || '',
      checkCallIntervalMinutes: String(site.welfareCheckIntervalMinutes || 60),
      specialInstructions: site.specialInstructions || '',
      initialShiftDate: '',
      initialShiftStartTime: '',
      initialShiftEndTime: '',
    });
    setSelectedSiteId(site.id);
    setActiveSection('sites');
  };

  const handleSaveSite = async () => {
    try {
      setSavingSite(true);
      const selectedClientId = toNumber(siteForm.clientId);
      const trimmedSiteName = siteForm.name.trim();
      const trimmedAddress = siteForm.address.trim();
      const hasStarterShiftValue = Boolean(
        siteForm.initialShiftDate || siteForm.initialShiftStartTime || siteForm.initialShiftEndTime,
      );

      if (hasStarterShiftValue) {
        const starterValidationError = validateSameDayShiftTiming(
          siteForm.initialShiftDate,
          siteForm.initialShiftStartTime,
          siteForm.initialShiftEndTime,
        );
        if (starterValidationError) {
          throw new Error(`Starter planned shift: ${starterValidationError}`);
        }
      }

      const payload: CreateSitePayload | UpdateSitePayload = {
        clientId: selectedClientId,
        name: trimmedSiteName,
        address: trimmedAddress,
        contactDetails: siteForm.contactDetails.trim() || undefined,
        status: siteForm.status,
        requiredGuardCount: toNumber(siteForm.requiredGuardCount) || 1,
        operatingDays: siteForm.operatingDays.trim() || undefined,
        operatingStartTime: siteForm.operatingStartTime.trim() || undefined,
        operatingEndTime: siteForm.operatingEndTime.trim() || undefined,
        welfareCheckIntervalMinutes: toNumber(siteForm.checkCallIntervalMinutes) || 60,
        specialInstructions: siteForm.specialInstructions.trim() || undefined,
        initialShiftDate: hasStarterShiftValue ? siteForm.initialShiftDate : undefined,
        initialShiftStartTime: hasStarterShiftValue ? siteForm.initialShiftStartTime : undefined,
        initialShiftEndTime: hasStarterShiftValue ? siteForm.initialShiftEndTime : undefined,
      };

      console.log('[CompanyDashboardScreen] handleSaveSite payload', payload);

      if (!payload.clientId || !payload.name || !payload.address) {
        throw new Error('Client, site name, and address are required.');
      }

      if (siteForm.id) {
        await updateSite(siteForm.id, payload);
      } else {
        await createSite(payload as CreateSitePayload);
      }

      resetSiteForm();
      await loadData(true);
    } catch (saveError) {
      setError(formatApiErrorMessage(saveError, 'Unable to save this site right now.'));
    } finally {
      setSavingSite(false);
    }
  };

  const handlePlanSite = (site: Site) => {
    setPlannerClientId(String(site.client?.id ?? site.clientId ?? ''));
    setPlannerSiteId(String(site.id));
    setActiveSection('rota-planner');
  };

  const handleAddPlannerRow = (date: string) => {
    setPlannerRows((current) => [...current, buildPlannerRow(date)]);
  };

  const handlePlannerRowChange = (localId: string, patch: Partial<PlannerRow>) => {
    setPlannerRows((current) =>
      current.map((row) => (row.localId === localId ? { ...row, ...patch } : row)),
    );
  };

  const handleRemovePlannerRow = (localId: string) => {
    setPlannerRows((current) => {
      const row = current.find((entry) => entry.localId === localId);
      if (row?.sourceShiftIds?.length) {
        setPlannerRemovedShiftIds((existing) => [...existing, ...row.sourceShiftIds]);
      }

      return current.filter((entry) => entry.localId !== localId);
    });
  };

  const copyPlannerToNextWeek = () => {
    const nextRows = plannerRows.map((row) => ({
      ...row,
      localId: `${row.localId}-copy-${Math.random().toString(36).slice(2, 8)}`,
      date: formatDateInput(addDays(parseDateInput(row.date) || new Date(`${row.date}T00:00:00`), 7)),
      sourceShiftIds: [],
    }));

    setPlannerWeekCommencing(
      weekCommencingFor(
        formatDateInput(
          addDays(parseDateInput(plannerWeekCommencing) || new Date(`${plannerWeekCommencing}T00:00:00`), 7),
        ),
      ),
    );
    setPlannerRows(nextRows);
    setPlannerRemovedShiftIds([]);
  };

  const deletePlannerShiftIfPresent = async (shiftId: number) => {
    try {
      await deleteShift(shiftId);
    } catch (shiftError) {
      if (shiftError instanceof ApiError && shiftError.status === 404) {
        return;
      }

      throw shiftError;
    }
  };

  const handleSaveRota = async () => {
    try {
      if (!plannerSite || !plannerSiteId) {
        throw new Error('Choose a site before saving the rota.');
      }

      setSavingRota(true);

      for (const shiftId of Array.from(new Set(plannerRemovedShiftIds))) {
        await deletePlannerShiftIfPresent(shiftId);
      }

      for (const row of plannerRows) {
        const validationError = validateSameDayShiftTiming(row.date, row.startTime, row.endTime);
        if (validationError) {
          throw new Error(`${formatDateLabel(row.date)}: ${validationError}`);
        }

        const guardsRequired = Math.max(1, toNumber(row.guardsRequired) || 1);
        const { startAt, endAt } = buildShiftDateTimes(row.date, row.startTime, row.endTime);
        const plannedStatus = normalizePlannerStatus(row.status, row.assignedGuardId);
        const existingIds = [...row.sourceShiftIds];

        for (let index = 0; index < guardsRequired; index += 1) {
          const assignedGuardId = index === 0 ? toNumber(row.assignedGuardId) ?? null : null;
          const payload: CreateShiftPayload & UpdateShiftPayload = {
            siteId: Number(plannerSiteId),
            guardId: assignedGuardId,
            start: startAt,
            end: endAt,
            status: assignedGuardId ? plannedStatus : plannedStatus === 'cancelled' ? 'cancelled' : 'unfilled',
            checkCallIntervalMinutes: plannerSite.welfareCheckIntervalMinutes || 60,
            instructions: row.instructions.trim() || undefined,
          };

          const existingId = existingIds.shift();
          if (existingId) {
            await updateShift(existingId, payload);
          } else {
            await createShift(payload);
          }
        }

        for (const extraId of existingIds) {
          await deletePlannerShiftIfPresent(extraId);
        }
      }

      setPlannerRemovedShiftIds([]);
      await loadData(true);
      setActiveSection('live-operations');
    } catch (saveError) {
      setError(formatApiErrorMessage(saveError, 'Unable to save this rota right now.'));
    } finally {
      setSavingRota(false);
    }
  };

  const handleCreateJob = async () => {
    try {
      setCreatingJob(true);
      const payload: CreateJobPayload = {
        title: jobForm.title.trim(),
        description: jobForm.description.trim() || undefined,
        guardsRequired: toNumber(jobForm.guardsRequired) || 1,
        hourlyRate: toNumber(jobForm.hourlyRate) || 12,
        siteId: toNumber(jobForm.siteId),
      };

      if (!payload.title || !payload.siteId) {
        throw new Error('Job title and site are required.');
      }

      await createJob(payload);
      resetJobForm();
      await loadData(true);
    } catch (jobError) {
      setError(formatApiErrorMessage(jobError, 'Unable to create this recruitment job right now.'));
    } finally {
      setCreatingJob(false);
    }
  };

  const handleApproveGuard = async (guardId: number) => {
    try {
      setApprovingGuardId(guardId);
      await approveGuard(guardId);
      await loadData(true);
    } catch (approveError) {
      setError(formatApiErrorMessage(approveError, 'Unable to link this guard right now.'));
    } finally {
      setApprovingGuardId(null);
    }
  };

  const handleReviewApplication = async (
    applicationId: number,
    status: 'under_review' | 'accepted' | 'rejected',
  ) => {
    try {
      setReviewingApplicationId(applicationId);
      await reviewJobApplication(applicationId, { status });
      await loadData(true);
      if (status === 'accepted') {
        setActiveSection('guards');
      }
    } catch (reviewError) {
      setError(
        formatApiErrorMessage(
          reviewError,
          status === 'accepted'
            ? 'Unable to accept this application right now.'
            : status === 'rejected'
              ? 'Unable to reject this application right now.'
              : 'Unable to update this application right now.',
        ),
      );
    } finally {
      setReviewingApplicationId(null);
    }
  };

  const recordManagementAction = (
    item: Omit<ManagementActionItem, 'id' | 'occurredAt'>,
  ) => {
    setManagementActions((current) => {
      const nowIso = new Date().toISOString();
      const existingRecentMatch = current.find((entry) => {
        const occurredMs = Date.parse(entry.occurredAt);
        const isRecent = Number.isFinite(occurredMs) && Date.now() - occurredMs < 60_000;
        return (
          isRecent &&
          entry.shiftId === item.shiftId &&
          entry.itemType === item.itemType &&
          entry.actionTaken === item.actionTaken
        );
      });

      if (existingRecentMatch) {
        return current;
      }

      return [
        {
          ...item,
          id: `management-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          occurredAt: nowIso,
        },
        ...current,
      ].slice(0, 12);
    });
  };

  const focusShiftInLiveBoard = (shiftId: number) => {
    setSelectedShiftId(shiftId);
    setActiveSection('live-operations');
    setHighlightedLiveShiftId(shiftId);

    if (liveBoardHighlightTimeoutId) {
      clearTimeout(liveBoardHighlightTimeoutId);
    }

    setTimeout(() => {
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo({
          top: Math.max(liveBoardAnchorY - 24, 0),
          behavior: 'smooth',
        });
      }
    }, 0);

    const nextTimeoutId = setTimeout(() => {
      setHighlightedLiveShiftId((current) => (current === shiftId ? null : current));
    }, 2000);
    setLiveBoardHighlightTimeoutId(nextTimeoutId);
  };

  const handleCancelShiftOffer = async (shiftId: number) => {
    try {
      setOfferActionShiftId(shiftId);
      setShiftOffersFeedback(null);
      const shift = shifts.find((entry) => entry.id === shiftId) ?? null;
      await updateShift(shiftId, { status: 'cancelled' });
      await loadData(true);
      recordManagementAction({
        shiftId,
        siteName: shift?.site?.name || shift?.siteName || 'Unknown site',
        guardName: shift?.guard?.fullName || 'Unassigned',
        itemType: 'Shift offer',
        actionTaken: 'Shift offer withdrawn',
      });
      setShiftOffersFeedback({
        tone: 'success',
        message: `Shift #${shiftId} was withdrawn successfully and is no longer pending a guard response.`,
      });
    } catch (shiftError) {
      setError(formatApiErrorMessage(shiftError, 'Unable to cancel this shift offer right now.'));
      setShiftOffersFeedback({
        tone: 'error',
        message: formatApiErrorMessage(shiftError, 'Unable to withdraw this shift offer right now.'),
      });
    } finally {
      setOfferActionShiftId(null);
    }
  };

  const handleReofferShift = async (shiftId: number) => {
    const nextGuardId = toNumber(reassignGuardByShiftId[shiftId]);

    if (!nextGuardId) {
      setError('Choose a replacement guard before re-offering this shift.');
      setShiftOffersFeedback({
        tone: 'error',
        message: 'Choose a replacement guard before re-offering this shift.',
      });
      return;
    }

    try {
      setOfferActionShiftId(shiftId);
      setShiftOffersFeedback(null);
      const shift = shifts.find((entry) => entry.id === shiftId) ?? null;
      const replacementGuardName = linkedGuardNameById.get(nextGuardId) || `Guard #${nextGuardId}`;
      await updateShift(shiftId, { guardId: nextGuardId });
      setReassignGuardByShiftId((current) => ({ ...current, [shiftId]: '' }));
      await loadData(true);
      recordManagementAction({
        shiftId,
        siteName: shift?.site?.name || shift?.siteName || 'Unknown site',
        guardName: replacementGuardName,
        itemType: 'Rejected shift',
        actionTaken: `Shift re-offered to ${replacementGuardName}`,
      });
      setShiftOffersFeedback({
        tone: 'success',
        message: `Shift #${shiftId} was re-offered to ${replacementGuardName} and is now back in offered status.`,
      });
    } catch (shiftError) {
      setError(formatApiErrorMessage(shiftError, 'Unable to re-offer this shift right now.'));
      setShiftOffersFeedback({
        tone: 'error',
        message: formatApiErrorMessage(shiftError, 'Unable to re-offer this shift right now.'),
      });
    } finally {
      setOfferActionShiftId(null);
    }
  };

  const handleOpenUrgentShift = (item: UrgentOperationalItem) => {
    if (!item.shiftId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: `No linked shift is available for "${item.issueType}".`,
      });
      return;
    }

    focusShiftInLiveBoard(item.shiftId);
    setLiveOperationsFeedback({
      tone: 'success',
      message: `Opening Shift #${item.shiftId} for ${item.issueType.toLowerCase()}.`,
    });
  };

  const handleOpenUrgentDetail = (item: UrgentOperationalItem) => {
    if (item.category === 'rejected_offer' || item.category === 'missed_shift') {
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      setShiftOffersFeedback({
        tone: 'success',
        message: item.shiftId
          ? `Shift #${item.shiftId} is ready for re-cover in Shift Offers.`
          : 'Open Shift Offers to re-cover this shift.',
      });
      setActiveSection('shift-offers');
      return;
    }

    if (!item.shiftId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: `No linked shift is available for "${item.issueType}".`,
      });
      return;
    }

    focusShiftInLiveBoard(item.shiftId);

    if (item.category === 'incident') {
      setActiveSection('incidents');
      setLiveOperationsFeedback({
        tone: 'success',
        message: `Opening incident review for Shift #${item.shiftId}.`,
      });
      return;
    }

    if (item.category === 'panic' || item.category === 'missed_check_call' || item.category === 'safety') {
      setActiveSection('alerts');
      setLiveOperationsFeedback({
        tone: 'success',
        message: `Opening safety review for Shift #${item.shiftId}.`,
      });
      return;
    }

    setActiveSection('live-operations');
    setLiveOperationsFeedback({
      tone: 'success',
      message: `Opening Shift #${item.shiftId} in Live Operations.`,
    });
  };

  const handleLiveBoardPrimaryAction = (shift: Shift) => {
    const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);

    if (lifecycleStatus === 'offered') {
      setSelectedShiftId(shift.id);
      setActiveSection('shift-offers');
      setShiftOffersFeedback({
        tone: 'success',
        message: `Viewing offer details for Shift #${shift.id}.`,
      });
      return;
    }

    if (['rejected', 'missed'].includes(lifecycleStatus)) {
      setSelectedShiftId(shift.id);
      setActiveSection('shift-offers');
      setShiftOffersFeedback({
        tone: 'success',
        message:
          lifecycleStatus === 'missed'
            ? `Shift #${shift.id} missed check-in and is ready for re-cover.`
            : `Shift #${shift.id} is ready to be re-offered.`,
      });
      return;
    }

    focusShiftInLiveBoard(shift.id);
    setLiveOperationsFeedback({
      tone: 'success',
      message:
        lifecycleStatus === 'ready'
          ? `Opening Shift #${shift.id}.`
          : lifecycleStatus === 'in_progress'
            ? `Monitoring live Shift #${shift.id}.`
            : lifecycleStatus === 'missed'
              ? `Reviewing missed Shift #${shift.id}.`
            : `Reviewing Shift #${shift.id}.`,
    });
  };

  const handleUrgentIncidentFollowUp = async (
    item: UrgentOperationalItem,
    nextStatus: 'in_review' | 'resolved',
  ) => {
    if (!item.incidentId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'No incident is linked to this urgent item.',
      });
      return;
    }

    try {
      setUrgentActionItemId(item.id);
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      await updateIncidentStatus(item.incidentId, nextStatus);
      await loadData(true);
      recordManagementAction({
        shiftId: item.shiftId,
        siteName: item.siteName,
        guardName: item.guardName,
        itemType: 'Incident',
        actionTaken:
          nextStatus === 'in_review' ? 'Incident acknowledged' : 'Incident resolved',
      });
      setLiveOperationsFeedback({
        tone: 'success',
        message:
          nextStatus === 'in_review'
            ? `Incident #${item.incidentId} was acknowledged and moved to in review.`
            : `Incident #${item.incidentId} was resolved successfully.`,
      });
    } catch (followUpError) {
      setError(formatApiErrorMessage(followUpError, 'Unable to update this incident right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(followUpError, 'Unable to update this incident right now.'),
      });
    } finally {
      setUrgentActionItemId(null);
    }
  };

  const handleUrgentAlertFollowUp = async (
    item: UrgentOperationalItem,
    action: 'acknowledge' | 'close',
  ) => {
    if (!item.alertId) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'No safety alert is linked to this urgent item.',
      });
      return;
    }

    try {
      setUrgentActionItemId(item.id);
      if (item.shiftId) {
        setSelectedShiftId(item.shiftId);
      }
      if (action === 'acknowledge') {
        await acknowledgeSafetyAlert(item.alertId);
      } else {
        await closeSafetyAlert(item.alertId);
      }
      await loadData(true);
      recordManagementAction({
        shiftId: item.shiftId,
        siteName: item.siteName,
        guardName: item.guardName,
        itemType:
          item.category === 'panic'
            ? 'Panic alert'
            : item.category === 'missed_check_call'
              ? 'Missed check call'
              : 'Safety alert',
        actionTaken:
          action === 'acknowledge'
            ? item.category === 'panic'
              ? 'Panic alert escalated'
              : item.category === 'missed_check_call'
                ? 'Missed check call followed up'
                : 'Safety alert acknowledged'
            : item.category === 'panic'
              ? 'Panic alert resolved'
              : item.category === 'missed_check_call'
                ? 'Missed check call closed'
                : 'Safety alert closed',
      });
      setLiveOperationsFeedback({
        tone: 'success',
        message:
          action === 'acknowledge'
            ? `${
                item.category === 'panic'
                  ? 'Panic alert'
                  : item.category === 'missed_check_call'
                    ? 'Missed check call'
                    : 'Safety alert'
              } was marked for follow-up.`
            : `${
                item.category === 'panic'
                  ? 'Panic alert'
                  : item.category === 'missed_check_call'
                    ? 'Missed check call'
                    : 'Safety alert'
              } was closed successfully.`,
      });
    } catch (followUpError) {
      setError(formatApiErrorMessage(followUpError, 'Unable to update this safety item right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(followUpError, 'Unable to update this safety item right now.'),
      });
    } finally {
      setUrgentActionItemId(null);
    }
  };

  const handleSaveCloseOutNotes = async () => {
    if (!selectedShift) {
      setLiveOperationsFeedback({
        tone: 'error',
        message: 'Choose a shift before saving close-out notes.',
      });
      return;
    }

    try {
      setSavingCloseOutNotes(true);
      const nextNotes = closeOutNotesDraft.trim();
      await updateShift(selectedShift.id, {
        closeOutNotes: nextNotes || null,
      });
      await loadData(true);
      setLiveOperationsFeedback({
        tone: 'success',
        message: nextNotes
          ? `Close-out notes saved for Shift #${selectedShift.id}.`
          : `Close-out notes cleared for Shift #${selectedShift.id}.`,
      });
    } catch (notesError) {
      setError(formatApiErrorMessage(notesError, 'Unable to save close-out notes right now.'));
      setLiveOperationsFeedback({
        tone: 'error',
        message: formatApiErrorMessage(notesError, 'Unable to save close-out notes right now.'),
      });
    } finally {
      setSavingCloseOutNotes(false);
    }
  };

  const liveOperationRows = React.useMemo(() => {
    const priority = { high: 3, medium: 2, low: 1 };

    return shifts
      .filter((shift) => {
        const clientId = String(shift.site?.client?.id ?? shift.site?.clientId ?? '');
        const siteId = String(shift.site?.id ?? shift.siteId ?? '');
        const guardId = String(shift.guard?.id ?? shift.guardId ?? '');
        const date = shift.start.slice(0, 10);
        const status = (shift.status || '').toLowerCase();

        return (
          (!liveFilters.clientId || clientId === liveFilters.clientId) &&
          (!liveFilters.siteId || siteId === liveFilters.siteId) &&
          (!liveFilters.guardId || guardId === liveFilters.guardId) &&
          (!liveFilters.date || date === liveFilters.date) &&
          (!liveFilters.status || status === liveFilters.status.toLowerCase())
        );
      })
      .sort((left, right) => {
        const riskA = getShiftRisk(
          left,
          attendanceByShiftId.get(left.id),
          incidentsByShiftId.get(left.id) || [],
          alertsByShiftId.get(left.id) || [],
        );
        const riskB = getShiftRisk(
          right,
          attendanceByShiftId.get(right.id),
          incidentsByShiftId.get(right.id) || [],
          alertsByShiftId.get(right.id) || [],
        );

        const priorityDelta = priority[riskB.level] - priority[riskA.level];
        if (priorityDelta !== 0) {
          return priorityDelta;
        }

        const delayA = getShiftDelay(left, attendanceByShiftId.get(left.id)) || 0;
        const delayB = getShiftDelay(right, attendanceByShiftId.get(right.id)) || 0;
        if (delayB !== delayA) {
          return delayB - delayA;
        }

        return right.start.localeCompare(left.start);
      });
  }, [alertsByShiftId, attendanceByShiftId, incidentsByShiftId, liveFilters, shifts]);
  const guardsNotBookedOn = React.useMemo(
    () =>
      liveOperationRows.filter((shift) => {
        const attendance = attendanceByShiftId.get(shift.id);
        return ['ready'].includes(normalizeShiftLifecycleStatus(shift.status)) && !attendance?.checkInAt;
      }),
    [liveOperationRows, attendanceByShiftId],
  );

  const applicationShiftSummaryById = React.useMemo(() => {
    const map = new Map<
      number,
      {
        status: string;
        siteName: string;
        start: string;
      } | null
    >();

    applications.forEach((application) => {
      const assignmentShiftCandidates =
        application.assignments?.flatMap((assignment) => assignment.shifts || []) || [];
      const fallbackShiftCandidates = shifts.filter((shift) => {
        const sameGuard = (shift.guard?.id ?? shift.guardId) === application.guardId;
        const shiftCompanyId = shift.company?.id ?? shift.companyId ?? shift.assignment?.companyId;
        const applicationCompanyId = application.job?.company?.id ?? application.job?.companyId;
        return sameGuard && Boolean(applicationCompanyId) && shiftCompanyId === applicationCompanyId;
      });

      const latestShift =
        [...assignmentShiftCandidates, ...fallbackShiftCandidates]
          .sort((left, right) => right.start.localeCompare(left.start))[0] || null;

      map.set(
        application.id,
        latestShift
          ? {
              status: latestShift.status,
              siteName: latestShift.site?.name || latestShift.siteName || 'Site TBD',
              start: latestShift.start,
            }
          : null,
      );
    });

    return map;
  }, [applications, shifts]);

  const acceptedApplications = React.useMemo(
    () => applications.filter((application) => application.status === 'accepted'),
    [applications],
  );

  const renderTableHeader = (columns: string[]) => (
    <View style={styles.tableHeader}>
      {columns.map((column) => (
        <Text key={column} style={styles.tableHeaderText}>
          {column}
        </Text>
      ))}
    </View>
  );

  const renderDashboardSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.kpiGrid}>
        {[
          ['Active Clients', String(activeClients.length)],
          ['Active Sites', String(activeSites.length)],
          ['Linked Guards', String(linkedGuards.length)],
          ['Shifts Today', String(shiftsToday.length)],
          ['Live Shifts', String(liveShifts.length)],
          ['Pending Timesheets', String(pendingTimesheets.length)],
          ['Open Incidents', String(openIncidents.length)],
          ['Outstanding Alerts', String(outstandingAlerts.length)],
        ].map(([label, value]) => (
          <View key={label} style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>{label}</Text>
            <Text style={styles.kpiValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.panelGrid}>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Today&apos;s Live Shifts</Text>
          {liveShifts.slice(0, 6).map((shift) => (
            <Pressable key={shift.id} style={styles.recordRow} onPress={() => {
              setSelectedShiftId(shift.id);
              setActiveSection('live-operations');
            }}>
              <Text style={styles.recordTitle}>{shift.site?.name || shift.siteName}</Text>
              <Text style={styles.recordMeta}>
                {formatDateLabel(shift.start)} · {formatTimeLabel(shift.start)}-{formatTimeLabel(shift.end)}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Urgent Alerts</Text>
          {outstandingAlerts.slice(0, 6).map((alert) => (
            <View key={alert.id} style={styles.recordRow}>
              <Text style={styles.recordTitle}>{formatStatusLabel(alert.type)}</Text>
              <Text style={styles.recordMeta}>
                {alert.shift?.site?.name || alert.shift?.siteName || 'Shift alert'} · {formatDateTimeLabel(alert.createdAt)}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Recent Incidents</Text>
          {openIncidents.slice(0, 6).map((incident) => (
            <View key={incident.id} style={styles.recordRow}>
              <Text style={styles.recordTitle}>{incident.title}</Text>
              <Text style={styles.recordMeta}>
                {incident.site?.name || incident.shift?.site?.name || 'Site'} · {formatStatusLabel(incident.severity)}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Recent Activity</Text>
          {recentActivity.map((log) => (
            <View key={log.id} style={styles.recordRow}>
              <Text style={styles.recordTitle}>{log.message}</Text>
              <Text style={styles.recordMeta}>
                {log.shift?.site?.name || log.shift?.siteName || 'Shift'} · {formatDateTimeLabel(log.createdAt)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );

  const renderClientsSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionTitle}>Client Accounts</Text>
        <View style={styles.toolbarActions}>
          <Text style={styles.helperText}>Show archived</Text>
          <Switch value={showArchivedClients} onValueChange={setShowArchivedClients} />
        </View>
      </View>
      <View style={styles.splitLayout}>
        <View style={styles.tableCard}>
          {renderTableHeader(['Client', 'Contact', 'Phone', 'Status', 'Sites', 'Actions'])}
          {filteredClients.map((client) => (
            <View key={client.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{client.name}</Text>
              <Text style={styles.tableCell}>{client.contactName || '—'}</Text>
              <Text style={styles.tableCell}>{client.contactPhone || '—'}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(client.status)}</Text>
              <Text style={styles.tableCell}>{sites.filter((site) => (site.client?.id ?? site.clientId) === client.id).length}</Text>
              <View style={styles.rowActions}>
                <Pressable style={styles.secondaryButton} onPress={() => handleEditClient(client)}>
                  <Text style={styles.secondaryButtonText}>Edit</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => handleArchiveClient(client)}>
                  <Text style={styles.secondaryButtonText}>Archive</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.formCard}>
          <Text style={styles.panelTitle}>{clientForm.id ? 'Edit Client' : 'New Client'}</Text>
          <TextInput style={styles.input} value={clientForm.name} onChangeText={(value: string) => setClientForm((current) => ({ ...current, name: value }))} placeholder="Client name" />
          <TextInput style={styles.input} value={clientForm.contactName} onChangeText={(value: string) => setClientForm((current) => ({ ...current, contactName: value }))} placeholder="Contact person" />
          <TextInput style={styles.input} value={clientForm.contactEmail} onChangeText={(value: string) => setClientForm((current) => ({ ...current, contactEmail: value }))} placeholder="Contact email" />
          <TextInput style={styles.input} value={clientForm.contactPhone} onChangeText={(value: string) => setClientForm((current) => ({ ...current, contactPhone: value }))} placeholder="Contact phone" />
          <WebSelect value={clientForm.status} onChange={(value: string) => setClientForm((current) => ({ ...current, status: value || 'active' }))} options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }, { label: 'Archived', value: 'archived' }]} />
          <TextInput style={[styles.input, styles.textArea]} multiline value={clientForm.notes} onChangeText={(value: string) => setClientForm((current) => ({ ...current, notes: value }))} placeholder="Notes" />
          <View style={styles.formActions}>
            <Pressable style={styles.primaryButton} onPress={handleSaveClient} disabled={savingClient}>
              <Text style={styles.primaryButtonText}>{savingClient ? 'Saving...' : clientForm.id ? 'Update Client' : 'Create Client'}</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={resetClientForm}>
              <Text style={styles.secondaryButtonText}>Clear</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );

  const renderSitesSection = () => {
    const siteShifts = shifts.filter((shift) => (shift.site?.id ?? shift.siteId) === selectedSiteId);
    return (
      <View style={styles.sectionStack}>
        <View style={styles.splitLayout}>
          <View style={styles.tableCard}>
            {renderTableHeader(['Site', 'Client', 'Address', 'Guards', 'Hours', 'Active Shifts', 'Actions'])}
            {sites.map((site) => (
              <Pressable key={site.id} style={[styles.tableRow, selectedSiteId === site.id && styles.tableRowSelected]} onPress={() => setSelectedSiteId(site.id)}>
                <Text style={styles.tableCellStrong}>{site.name}</Text>
                <Text style={styles.tableCell}>{site.client?.name || clientMap.get(site.clientId || 0)?.name || '—'}</Text>
                <Text style={styles.tableCell}>{site.address}</Text>
                <Text style={styles.tableCell}>{site.requiredGuardCount || 1}</Text>
                <Text style={styles.tableCell}>{site.operatingStartTime || '—'}-{site.operatingEndTime || '—'}</Text>
                <Text style={styles.tableCell}>{siteShiftCounts.get(site.id) || 0}</Text>
                <View style={styles.rowActions}>
                  <Pressable style={styles.secondaryButton} onPress={() => handleEditSite(site)}>
                    <Text style={styles.secondaryButtonText}>Edit</Text>
                  </Pressable>
                  <Pressable style={styles.secondaryButton} onPress={() => handlePlanSite(site)}>
                    <Text style={styles.secondaryButtonText}>Plan Cover</Text>
                  </Pressable>
                </View>
              </Pressable>
            ))}
          </View>
          <View style={styles.formCard}>
            <Text style={styles.panelTitle}>{siteForm.id ? 'Edit Site' : 'New Site'}</Text>
            <NativeBrowserSelect
              value={siteForm.clientId}
              onChange={(value: string) => setSiteForm((current) => ({ ...current, clientId: value }))}
              options={siteClientOptions}
              placeholder="Linked client"
            />
            <Text style={styles.helperText}>
              Selected client id: {siteForm.clientId || 'none'}
              {selectedSiteClient ? ` · ${selectedSiteClient.name}` : ''}
            </Text>
            <TextInput style={styles.input} value={siteForm.name} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, name: value }))} placeholder="Site name" />
            <TextInput style={styles.input} value={siteForm.address} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, address: value }))} placeholder="Address" />
            <TextInput style={styles.input} value={siteForm.contactDetails} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, contactDetails: value }))} placeholder="Site contact details" />
            <View style={styles.formRow}>
              <TextInput style={[styles.input, styles.formCell]} value={siteForm.requiredGuardCount} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, requiredGuardCount: value }))} placeholder="Guards required" />
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>Check-call interval (minutes)</Text>
                <TextInput
                  style={styles.input}
                  value={siteForm.checkCallIntervalMinutes}
                  onChangeText={(value: string) => setSiteForm((current) => ({ ...current, checkCallIntervalMinutes: value }))}
                  placeholder="60"
                />
              </View>
            </View>
            <TextInput style={styles.input} value={siteForm.operatingDays} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, operatingDays: value }))} placeholder="Operating days" />
            <View style={styles.formRow}>
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>Start time (24h)</Text>
                <ControlledTimeInput
                  value={siteForm.operatingStartTime}
                  onChange={(value: string) => setSiteForm((current) => ({ ...current, operatingStartTime: value }))}
                />
              </View>
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>End time (24h)</Text>
                <ControlledTimeInput
                  value={siteForm.operatingEndTime}
                  onChange={(value: string) => setSiteForm((current) => ({ ...current, operatingEndTime: value }))}
                />
              </View>
            </View>
            <Text style={styles.subtleLabel}>Shift instructions / notes</Text>
            <TextInput style={[styles.input, styles.textArea]} multiline value={siteForm.specialInstructions} onChangeText={(value: string) => setSiteForm((current) => ({ ...current, specialInstructions: value }))} placeholder="Special instructions" />
            <Text style={styles.subtleLabel}>Starter unfilled shift</Text>
            <View style={styles.formRow}>
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>Date (DD/MM/YYYY)</Text>
                <ControlledDateInput
                  value={siteForm.initialShiftDate}
                  onChange={(value: string) => setSiteForm((current) => ({ ...current, initialShiftDate: value }))}
                />
                <Text style={styles.helperText}>{siteForm.initialShiftDate ? formatDateLabel(siteForm.initialShiftDate) : 'DD/MM/YYYY'}</Text>
              </View>
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>Start time (24h)</Text>
                <ControlledTimeInput
                  value={siteForm.initialShiftStartTime}
                  onChange={(value: string) => setSiteForm((current) => ({ ...current, initialShiftStartTime: value }))}
                />
              </View>
              <View style={styles.formCell}>
                <Text style={styles.subtleLabel}>End time (24h)</Text>
                <ControlledTimeInput
                  value={siteForm.initialShiftEndTime}
                  onChange={(value: string) => setSiteForm((current) => ({ ...current, initialShiftEndTime: value }))}
                />
              </View>
            </View>
            <View style={styles.formActions}>
              <Pressable style={styles.primaryButton} onPress={handleSaveSite} disabled={savingSite}>
                <Text style={styles.primaryButtonText}>{savingSite ? 'Saving...' : siteForm.id ? 'Update Site' : 'Create Site'}</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={resetSiteForm}>
                <Text style={styles.secondaryButtonText}>Clear</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {selectedSite && (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>{selectedSite.name} Detail</Text>
            <Text style={styles.recordMeta}>
              {selectedSite.client?.name || clientMap.get(selectedSite.clientId || 0)?.name || 'No client'} · {selectedSite.address}
            </Text>
            <Text style={styles.recordMeta}>
              Operating: {selectedSite.operatingDays || '—'} · {selectedSite.operatingStartTime || '—'}-{selectedSite.operatingEndTime || '—'}
            </Text>
            <Text style={styles.recordMeta}>Instructions: {selectedSite.specialInstructions || 'No special instructions recorded.'}</Text>
            <Text style={[styles.panelTitle, styles.panelTitleInline]}>Related Shifts</Text>
            {siteShifts.map((shift) => (
              <Pressable key={shift.id} style={styles.recordRow} onPress={() => {
                setSelectedShiftId(shift.id);
                setActiveSection('live-operations');
              }}>
                <Text style={styles.recordTitle}>Shift #{shift.id}</Text>
                <Text style={styles.recordMeta}>
                  {formatDateLabel(shift.start)} · {formatTimeLabel(shift.start)}-{formatTimeLabel(shift.end)} · {formatStatusLabel(normalizeShiftLifecycleStatus(shift.status))}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderRotaPlannerSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionTitle}>Weekly Rota Planner</Text>
        <View style={styles.toolbarActions}>
          <Pressable style={styles.secondaryButton} onPress={copyPlannerToNextWeek}>
            <Text style={styles.secondaryButtonText}>Copy To Next Week</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={handleSaveRota} disabled={savingRota}>
            <Text style={styles.primaryButtonText}>{savingRota ? 'Saving...' : 'Save Rota'}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.filterBar}>
        <NativeBrowserSelect
          value={plannerClientId}
          onChange={setPlannerClientId}
          options={siteClientOptions}
          placeholder="Client"
        />
        <WebSelect value={plannerSiteId} onChange={setPlannerSiteId} options={plannerSiteOptions} placeholder="Site" />
        <View style={styles.inputGroup}>
          <Text style={styles.subtleLabel}>Date (DD/MM/YYYY)</Text>
          <ControlledDateInput value={plannerWeekCommencing} onChange={setPlannerWeekCommencing} />
          <Text style={styles.helperText}>{plannerWeekCommencing ? formatDateLabel(plannerWeekCommencing) : 'DD/MM/YYYY'}</Text>
        </View>
      </View>

      <View style={styles.weekGrid}>
        {plannerWeekDays.map((day) => {
          const rows = plannerRowsByDate.get(day.date) || [];
          return (
            <View key={day.date} style={styles.dayCard}>
              <View style={styles.dayCardHeader}>
                <View>
                  <Text style={styles.dayCardTitle}>{day.label}</Text>
                  <Text style={styles.dayCardMeta}>{day.shortLabel}</Text>
                </View>
                <Pressable style={styles.secondaryButton} onPress={() => handleAddPlannerRow(day.date)}>
                  <Text style={styles.secondaryButtonText}>Add Shift</Text>
                </Pressable>
              </View>
              {rows.length === 0 ? <Text style={styles.helperText}>No planned cover for this day yet.</Text> : null}
              {rows.map((row) => (
                <View key={row.localId} style={styles.plannerRow}>
                  <View style={styles.formRow}>
                    <View style={styles.formCell}>
                      <Text style={styles.subtleLabel}>Date (DD/MM/YYYY)</Text>
                      <ControlledDateInput
                        value={row.date}
                        onChange={(value: string) => handlePlannerRowChange(row.localId, { date: value })}
                      />
                      <Text style={styles.helperText}>{formatDateLabel(row.date)}</Text>
                    </View>
                    <View style={styles.formCell}>
                      <Text style={styles.subtleLabel}>Start time (24h)</Text>
                      <ControlledTimeInput
                        value={row.startTime}
                        onChange={(value: string) => handlePlannerRowChange(row.localId, { startTime: value })}
                      />
                    </View>
                    <View style={styles.formCell}>
                      <Text style={styles.subtleLabel}>End time (24h)</Text>
                      <ControlledTimeInput
                        value={row.endTime}
                        onChange={(value: string) => handlePlannerRowChange(row.localId, { endTime: value })}
                      />
                    </View>
                  </View>
                  <View style={styles.formRow}>
                    <TextInput style={[styles.input, styles.formCell]} value={row.guardsRequired} onChangeText={(value: string) => handlePlannerRowChange(row.localId, { guardsRequired: value })} placeholder="Guards" />
                    <WebSelect value={row.assignedGuardId} onChange={(value: string) => handlePlannerRowChange(row.localId, { assignedGuardId: value })} options={linkedGuardOptions} placeholder="Assigned guard" />
                  </View>
                  <WebSelect
                    value={row.status}
                    onChange={(value: string) => handlePlannerRowChange(row.localId, { status: value })}
                    options={SHIFT_STATUS_OPTIONS}
                    placeholder="Status"
                  />
                  <Text style={styles.subtleLabel}>Shift instructions / notes</Text>
                  <TextInput style={[styles.input, styles.textAreaSmall]} multiline value={row.instructions} onChangeText={(value: string) => handlePlannerRowChange(row.localId, { instructions: value })} placeholder="Instructions" />
                  <Pressable style={styles.ghostButton} onPress={() => handleRemovePlannerRow(row.localId)}>
                    <Text style={styles.ghostButtonText}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );

  const renderLiveOperationsSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionTitle}>Live Operations</Text>
        <Pressable style={styles.secondaryButton} onPress={() => loadData(true)}>
          <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      <View style={styles.kpiGrid}>
        {[
          ['Live Shifts', String(liveShifts.length)],
          ['Guards Not Booked On', String(guardsNotBookedOn.length)],
          ['Open Incidents', String(openIncidents.length)],
          ['Missed Check Calls', String(missedCheckCalls.length)],
          ['Active Panic Alerts', String(activePanicAlerts.length)],
          ['Pending Timesheets', String(pendingTimesheets.length)],
        ].map(([label, value]) => (
          <View key={label} style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>{label}</Text>
            <Text style={styles.kpiValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.panel, styles.priorityPanel, styles.urgentPanel]}>
        <Text style={styles.panelTitle}>1. Urgent / Needs Attention</Text>
        <Text style={styles.helperText}>
          Highest-priority issues are shown here first so control-room actions are obvious.
        </Text>
        {liveOperationsFeedback ? (
          <View
            style={[
              styles.feedbackCard,
              liveOperationsFeedback.tone === 'error' ? styles.feedbackCardError : styles.feedbackCardSuccess,
            ]}
          >
            <Text
              style={[
                styles.feedbackTitle,
                liveOperationsFeedback.tone === 'error' ? styles.feedbackTitleError : styles.feedbackTitleSuccess,
              ]}
            >
              {liveOperationsFeedback.tone === 'error' ? 'Action failed' : 'Action completed'}
            </Text>
            <Text
              style={[
                styles.feedbackText,
                liveOperationsFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess,
              ]}
            >
              {liveOperationsFeedback.message}
            </Text>
          </View>
        ) : null}
        {urgentOperationalItems.map((item) => (
          <Pressable
            key={item.id}
            style={styles.recordRow}
            onPress={() => {
              if (item.shiftId) {
                handleOpenUrgentShift(item);
              }
            }}
          >
            <Text style={styles.recordTitle}>{item.issueType}</Text>
            <Text style={styles.recordMeta}>
              Shift {item.shiftId ? `#${item.shiftId}` : 'N/A'} | {item.siteName} | {item.guardName}
            </Text>
            <Text style={styles.recordMeta}>{item.message}</Text>
            <Text style={styles.nextActionText}>{getUrgentNextActionText(item)}</Text>
            <Text style={styles.recordMeta}>{formatDateTimeLabel(item.occurredAt)}</Text>
            <View style={styles.urgentItemActions}>
              {item.category === 'incident' && (item.status || '').toLowerCase() === 'open' ? (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => handleUrgentIncidentFollowUp(item, 'in_review')}
                  disabled={urgentActionItemId === item.id}
                >
                  <Text style={styles.secondaryButtonText}>
                    {urgentActionItemId === item.id ? 'Saving...' : 'Acknowledge'}
                  </Text>
                </Pressable>
              ) : null}
              {item.category === 'incident' ? (
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => handleOpenUrgentDetail(item)}
                >
                  <Text style={styles.primaryButtonText}>View Incident</Text>
                </Pressable>
              ) : null}
              {item.category === 'panic' && item.status !== 'acknowledged' ? (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => handleUrgentAlertFollowUp(item, 'acknowledge')}
                  disabled={urgentActionItemId === item.id}
                >
                  <Text style={styles.secondaryButtonText}>
                    {urgentActionItemId === item.id ? 'Saving...' : 'Mark Escalated'}
                  </Text>
                </Pressable>
              ) : null}
              {item.category === 'panic' ? (
                <Pressable
                  style={styles.primaryButton}
                  onPress={() =>
                    item.status === 'acknowledged'
                      ? handleUrgentAlertFollowUp(item, 'close')
                      : handleOpenUrgentDetail(item)
                  }
                  disabled={urgentActionItemId === item.id && item.status === 'acknowledged'}
                >
                  <Text style={styles.primaryButtonText}>
                    {item.status === 'acknowledged'
                      ? urgentActionItemId === item.id
                        ? 'Saving...'
                        : 'Resolve Alert'
                      : getUrgentPrimaryActionLabel(item)}
                  </Text>
                </Pressable>
              ) : null}
              {(item.category === 'missed_check_call' || item.category === 'safety') ? (
                <>
                  {item.status !== 'acknowledged' ? (
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleUrgentAlertFollowUp(item, 'acknowledge')}
                      disabled={urgentActionItemId === item.id}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {urgentActionItemId === item.id
                          ? 'Saving...'
                          : item.category === 'missed_check_call'
                            ? 'Mark Followed Up'
                            : 'Acknowledge'}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={styles.primaryButton}
                    onPress={() =>
                      item.status === 'acknowledged'
                        ? handleUrgentAlertFollowUp(item, 'close')
                        : handleOpenUrgentDetail(item)
                    }
                    disabled={urgentActionItemId === item.id && item.status === 'acknowledged'}
                  >
                    <Text style={styles.primaryButtonText}>
                      {item.status === 'acknowledged'
                        ? urgentActionItemId === item.id
                          ? 'Saving...'
                          : getUrgentPrimaryActionLabel(item)
                        : getUrgentPrimaryActionLabel(item)}
                    </Text>
                  </Pressable>
                </>
              ) : null}
              {item.category === 'incident' && ['open', 'in_review'].includes((item.status || '').toLowerCase()) ? (
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => handleUrgentIncidentFollowUp(item, 'resolved')}
                  disabled={urgentActionItemId === item.id}
                >
                  <Text style={styles.primaryButtonText}>
                    {urgentActionItemId === item.id ? 'Saving...' : 'Resolve'}
                  </Text>
                </Pressable>
              ) : null}
              {['rejected_offer', 'missed_shift', 'late_start', 'upcoming_risk'].includes(item.category) ? (
                <Pressable style={styles.primaryButton} onPress={() => handleOpenUrgentDetail(item)}>
                  <Text style={styles.primaryButtonText}>{getUrgentPrimaryActionLabel(item)}</Text>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        ))}
        {urgentOperationalItems.length === 0 ? (
          <Text style={styles.helperText}>No urgent operational items need attention right now.</Text>
        ) : null}
      </View>

      <View style={styles.filterBar}>
        <WebSelect
          value={liveFilters.clientId}
          onChange={(value: string) => setLiveFilters((current) => ({ ...current, clientId: value }))}
          options={siteClientOptions}
          placeholder="Client"
        />
        <WebSelect
          value={liveFilters.siteId}
          onChange={(value: string) => setLiveFilters((current) => ({ ...current, siteId: value }))}
          options={siteOptions}
          placeholder="Site"
        />
        <WebSelect
          value={liveFilters.guardId}
          onChange={(value: string) => setLiveFilters((current) => ({ ...current, guardId: value }))}
          options={linkedGuardOptions}
          placeholder="Guard"
        />
        <TextInput
          style={styles.input}
          value={liveFilters.date}
          onChangeText={(value: string) => setLiveFilters((current) => ({ ...current, date: value }))}
          placeholder="YYYY-MM-DD"
        />
        <WebSelect
          value={liveFilters.status}
          onChange={(value: string) => setLiveFilters((current) => ({ ...current, status: value }))}
          options={SHIFT_STATUS_OPTIONS}
          placeholder="Status"
        />
      </View>

      <View style={styles.panelGrid}>
        <View
          style={[styles.tableCard, styles.operationsBoardCard, styles.priorityPanel]}
          onLayout={(event: any) => setLiveBoardAnchorY(event.nativeEvent.layout.y)}
        >
          <Text style={styles.panelTitle}>2. Live Shift Board</Text>
          <Text style={styles.helperText}>Scan live and exception shifts here, then use the row action.</Text>
          {renderTableHeader([
            'Shift',
            'Site',
            'Guard',
            'Status',
            'Risk',
            'Delay',
            'Book On',
            'Book Off',
            'Last Check Call',
            'Logs',
            'Incidents',
            'Panic / Welfare',
            'Timesheet',
            'Action',
          ])}
          {liveOperationRows.map((shift) => {
            const timesheet = timesheetByShiftId.get(shift.id);
            const attendance = attendanceByShiftId.get(shift.id);
            const shiftLogs = logsByShiftId.get(shift.id) || [];
            const shiftIncidents = incidentsByShiftId.get(shift.id) || [];
            const shiftAlerts = alertsByShiftId.get(shift.id) || [];
            const lastCheckCall = lastCheckCallByShiftId.get(shift.id);
            const panicOrWelfareCount = shiftAlerts.filter((alert) =>
              ['panic', 'welfare', 'late_checkin'].includes((alert.type || '').toLowerCase()),
            ).length;
            const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
            const risk = getShiftRisk(shift, attendance, shiftIncidents, shiftAlerts);
            const delay = getShiftDelay(shift, attendance);
            const likelyLate = isLikelyToMissCheckIn(shift, attendance);
            const siteRiskLabel = getSiteRiskLevel(
              shift.site?.id ?? shift.siteId,
              shifts,
              attendanceByShiftId,
              incidentsByShiftId,
              alertsByShiftId,
            );
            const primaryActionLabel =
              lifecycleStatus === 'offered'
                ? 'View Offer'
                : lifecycleStatus === 'ready'
                  ? 'Open Shift'
                  : lifecycleStatus === 'in_progress'
                    ? 'Monitor'
                    : lifecycleStatus === 'missed'
                      ? 'Re-cover'
                      : lifecycleStatus === 'rejected'
                        ? 'Re-offer'
                        : 'Review Shift';

            return (
              <Pressable
                key={shift.id}
                style={[
                  styles.tableRow,
                  styles.liveBoardRow,
                  { backgroundColor: getLiveShiftBoardRowTone(lifecycleStatus, risk.level) },
                  likelyLate ? { borderLeftWidth: 4, borderLeftColor: '#F59E0B' } : null,
                  selectedShiftId === shift.id && styles.tableRowSelected,
                  highlightedLiveShiftId === shift.id && styles.liveBoardRowHighlighted,
                ]}
                onPress={() => setSelectedShiftId(shift.id)}
              >
                <Text style={styles.tableCellStrong}>#{shift.id}</Text>
                <View style={styles.tableCell}>
                  <Text style={styles.tableCell}>{shift.site?.name || shift.siteName || 'Unknown site'}</Text>
                  <Text style={[styles.helperText, { fontSize: 12 }]}>{siteRiskLabel}</Text>
                </View>
                <Text style={styles.tableCell}>{shift.guard?.fullName || 'Unassigned'}</Text>
                <View style={styles.tableCell}>
                  <ShiftStatusBadge status={shift.status} />
                </View>
                <View style={styles.tableCell}>
                  <Text style={[styles.tableCell, { color: risk.color, fontWeight: '700' }]}>{risk.label}</Text>
                  {likelyLate ? (
                    <Text style={{ color: '#F59E0B', fontWeight: '600' }}>Likely late ⚠️</Text>
                  ) : null}
                </View>
                <Text style={[styles.tableCell, delay !== null ? { color: '#EF4444', fontWeight: '600' } : null]}>
                  {delay !== null ? `Late by ${delay} min` : '—'}
                </Text>
                <Text style={styles.tableCell}>
                  {attendance?.checkInAt ? formatTimeLabel(attendance.checkInAt) : 'Pending'}
                </Text>
                <Text style={styles.tableCell}>
                  {attendance?.checkOutAt ? formatTimeLabel(attendance.checkOutAt) : 'Pending'}
                </Text>
                <Text style={styles.tableCell}>
                  {lastCheckCall ? formatTimeLabel(lastCheckCall.createdAt) : 'No check call'}
                </Text>
                <Text style={styles.tableCell}>{String(shiftLogs.length)}</Text>
                <Text style={styles.tableCell}>{String(shiftIncidents.length)}</Text>
                <Text style={styles.tableCell}>{String(panicOrWelfareCount)}</Text>
                <Text style={styles.tableCell}>{formatStatusLabel(timesheet?.approvalStatus || 'pending')}</Text>
                <View style={styles.tableCell}>
                  <Pressable style={styles.secondaryButton} onPress={() => handleLiveBoardPrimaryAction(shift)}>
                    <Text style={styles.secondaryButtonText}>{primaryActionLabel}</Text>
                  </Pressable>
                </View>
              </Pressable>
            );
          })}
          {liveOperationRows.length === 0 ? (
            <Text style={styles.helperText}>No shifts match the current live operations filters.</Text>
          ) : null}
        </View>

        <View style={styles.operationsSideColumn}>
          <View style={[styles.panel, styles.secondaryPanel]}>
            <Text style={[styles.panelTitle, styles.secondaryPanelTitle]}>4. Recent Operational Activity</Text>
            {recentOperationalActivity.map((activity) => (
              <Pressable
                key={activity.id}
                style={styles.recordRow}
                onPress={() => {
                  if (activity.shiftId) {
                    setSelectedShiftId(activity.shiftId);
                  }
                }}
              >
                <Text style={styles.recordTitle}>{activity.eventType}</Text>
                <Text style={styles.recordMeta}>
                  Shift {activity.shiftId ? `#${activity.shiftId}` : 'N/A'} | {activity.siteName} | {activity.guardName}
                </Text>
                {shouldShowOperationalActivityMessage(activity.eventType) ? (
                  <Text style={styles.recordMeta}>{activity.message}</Text>
                ) : null}
                <Text style={styles.recordMeta}>{formatDateTimeLabel(activity.occurredAt)}</Text>
              </Pressable>
            ))}
            {recentOperationalActivity.length === 0 ? <Text style={styles.helperText}>No recent operational activity.</Text> : null}
          </View>

          <View style={[styles.panel, styles.secondaryPanel]}>
            <Text style={[styles.panelTitle, styles.secondaryPanelTitle]}>5. Recent Management Actions</Text>
            <Text style={styles.helperText}>
              Follow-up and closure actions taken from the control room.
            </Text>
            {recentManagementActivity.map((activity) => (
              <Pressable
                key={activity.id}
                style={styles.recordRow}
                onPress={() => {
                  if (activity.shiftId) {
                    setSelectedShiftId(activity.shiftId);
                  }
                }}
              >
                <Text style={styles.recordTitle}>{activity.actionTaken}</Text>
                <Text style={styles.recordMeta}>
                  {activity.itemType} | Shift {activity.shiftId ? `#${activity.shiftId}` : 'N/A'} | {activity.siteName} | {activity.guardName}
                </Text>
                <Text style={styles.recordMeta}>{formatDateTimeLabel(activity.occurredAt)}</Text>
              </Pressable>
            ))}
            {recentManagementActivity.length === 0 ? (
              <Text style={styles.helperText}>No recent management actions have been taken yet.</Text>
            ) : null}
          </View>

          <View style={[styles.panel, styles.secondaryPanel]}>
            <Text style={styles.panelTitle}>Open Incidents</Text>
            {openIncidents.slice(0, 6).map((incident) => (
              <View key={incident.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>{incident.title}</Text>
                <Text style={styles.recordMeta}>
                  {incident.site?.name || incident.shift?.site?.name || 'Unknown site'} | {formatStatusLabel(incident.status)}
                </Text>
              </View>
            ))}
            {openIncidents.length === 0 ? <Text style={styles.helperText}>No open incidents.</Text> : null}
          </View>

          <View style={[styles.panel, styles.secondaryPanel]}>
            <Text style={styles.panelTitle}>Safety / Welfare / Panic</Text>
            {outstandingAlerts.slice(0, 6).map((alert) => (
              <View key={alert.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>{formatStatusLabel(alert.type)}</Text>
                <Text style={styles.recordMeta}>
                  {alert.shift?.site?.name || alert.shift?.siteName || 'Unknown shift'} | {formatStatusLabel(alert.status)}
                </Text>
              </View>
            ))}
            {outstandingAlerts.length === 0 ? <Text style={styles.helperText}>No active alerts.</Text> : null}
          </View>

        </View>
      </View>

      {selectedShift ? (
        <View style={[styles.panel, styles.priorityPanel, styles.selectedShiftPanel]}>
          {(() => {
            const selectedAttendance = attendanceByShiftId.get(selectedShift.id);
            const selectedTimesheet = timesheetByShiftId.get(selectedShift.id);
            const selectedShiftException = getShiftExceptionSummary(selectedShift.status);
            const selectedShiftBadge =
              normalizeShiftLifecycleStatus(selectedShift.status) === 'missed'
                ? { icon: '⚠️', label: 'Missed' }
                : getShiftStatusBadge(selectedShift.status || 'unfilled');
            return (
              <>
          <Text style={styles.panelTitle}>3. Selected Shift Detail</Text>
          <Text style={styles.helperText}>Compact summary for the selected shift, follow-up, and close-out.</Text>
          <Text style={styles.recordTitle}>Shift #{selectedShift.id} Operations</Text>
          <Text style={styles.recordMeta}>
            {selectedShift.site?.client?.name || clientMap.get(selectedShift.site?.clientId || 0)?.name || 'No client'} | {selectedShift.site?.name || selectedShift.siteName}
          </Text>
          <Text style={styles.recordMeta}>
            {selectedShift.guard?.fullName || 'No guard assigned'} | {formatDateLabel(selectedShift.start)} | {formatTimeLabel(selectedShift.start)}-{formatTimeLabel(selectedShift.end)}
          </Text>
          <Text style={styles.recordMeta}>
            Status: {`${selectedShiftBadge.icon} ${selectedShiftBadge.label}`} | Check calls: {selectedShift.checkCallIntervalMinutes || 60} mins
          </Text>
          <ShiftStatusBadge status={selectedShift.status} />
          {selectedShiftException ? (
            <>
              <Text style={styles.recordMeta}>{selectedShiftException.title}</Text>
              <Text style={styles.recordMeta}>{selectedShiftException.message}</Text>
              <Text style={styles.recordMeta}>{selectedShiftException.outcome}</Text>
            </>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'offered' ? (
            <Text style={styles.recordMeta}>Waiting for guard confirmation before live controls are used.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'unfilled' ? (
            <Text style={styles.recordMeta}>No confirmed guard is linked yet. This shift still needs cover.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'in_progress' ? (
            <Text style={styles.recordMeta}>Guard is booked on and the shift is live in operations.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'completed' ? (
            <Text style={styles.recordMeta}>Shift is completed. Operational records remain visible but no new live activity should be added.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'ready' ? (
            <Text style={styles.recordMeta}>Guard confirmed this shift. It is ready for book on.</Text>
          ) : null}
          <Text style={styles.recordMeta}>
            Instructions: {selectedShift.instructions || 'No instructions recorded.'}
          </Text>

          <View style={styles.detailGrid}>
            {normalizeShiftLifecycleStatus(selectedShift.status) === 'completed' && selectedShiftCloseOutSummary ? (
              <View style={[styles.detailCard, styles.closeOutCard]}>
                <Text style={styles.detailTitle}>Completed Shift Close-Out</Text>
                <Text
                  style={[
                    styles.recordTitle,
                    selectedShiftCloseOutSummary.closedCleanly
                      ? styles.closeOutStatusGood
                      : styles.closeOutStatusAttention,
                  ]}
                >
                  {selectedShiftCloseOutSummary.closedCleanly
                    ? 'Closed cleanly'
                    : `Needs follow-up (${selectedShiftCloseOutSummary.unresolvedFollowUpCount})`}
                </Text>
                <Text style={styles.recordMeta}>
                  Shift #{selectedShift.id} | {selectedShift.site?.name || selectedShift.siteName || 'Unknown site'} |{' '}
                  {selectedShift.guard?.fullName || 'No guard assigned'}
                </Text>
                <Text style={styles.recordMeta}>
                  Scheduled: {formatDateTimeLabel(selectedShiftCloseOutSummary.scheduledStart)} to{' '}
                  {formatDateTimeLabel(selectedShiftCloseOutSummary.scheduledEnd)}
                </Text>
                <Text style={styles.recordMeta}>
                  Actual: {formatDateTimeLabel(selectedShiftCloseOutSummary.actualCheckInAt)} to{' '}
                  {formatDateTimeLabel(selectedShiftCloseOutSummary.actualCheckOutAt)}
                </Text>
                <Text style={styles.recordMeta}>
                  Logs: {selectedShiftCloseOutSummary.logsCount} | Incidents: {selectedShiftCloseOutSummary.incidentsCount}
                </Text>
                <Text style={styles.recordMeta}>
                  Safety / welfare / panic: {selectedShiftCloseOutSummary.safetyEventsCount}
                </Text>
                <Text style={styles.recordMeta}>
                  Check calls completed / missed: {selectedShiftCloseOutSummary.completedCheckCalls} /{' '}
                  {selectedShiftCloseOutSummary.missedCheckCalls}
                </Text>
                <Text style={styles.recordMeta}>
                  Timesheet: {formatStatusLabel(selectedShiftCloseOutSummary.timesheetStatus)}
                </Text>
                {selectedShiftCloseOutSummary.unresolvedFollowUpCount > 0 ? (
                  <Text style={styles.recordMeta}>
                    Unresolved follow-up items: {selectedShiftCloseOutSummary.unresolvedFollowUpCount}
                  </Text>
                ) : (
                  <Text style={styles.recordMeta}>No unresolved follow-up items remain for this shift.</Text>
                )}
                <View style={styles.closeOutNotesSection}>
                  <Text style={styles.subtleLabel}>Close-out / handover notes</Text>
                  <TextInput
                    style={[styles.input, styles.textAreaSmall]}
                    multiline
                    value={closeOutNotesDraft}
                    onChangeText={setCloseOutNotesDraft}
                    placeholder="Short operational handover note for management review or next-shift awareness"
                  />
                  <View style={styles.rowActions}>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={handleSaveCloseOutNotes}
                      disabled={savingCloseOutNotes}
                    >
                      <Text style={styles.primaryButtonText}>
                        {savingCloseOutNotes ? 'Saving...' : 'Save Close-Out Note'}
                      </Text>
                    </Pressable>
                  </View>
                  {selectedShift.closeOutNotes && !closeOutNotesDraft.trim() ? (
                    <Text style={styles.helperText}>
                      Existing note will be cleared if you save with an empty value.
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>Attendance & Timesheet</Text>
              <Text style={styles.recordMeta}>
                Book on: {selectedAttendance?.checkInAt ? formatDateTimeLabel(selectedAttendance.checkInAt) : 'Pending'}
              </Text>
              <Text style={styles.recordMeta}>
                Book off: {selectedAttendance?.checkOutAt ? formatDateTimeLabel(selectedAttendance.checkOutAt) : 'Pending'}
              </Text>
              <Text style={styles.recordMeta}>
                Timesheet: {formatStatusLabel(selectedTimesheet?.approvalStatus || 'pending')}
              </Text>
            </View>
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>Daily Logs</Text>
              {(logsByShiftId.get(selectedShift.id) || []).map((log) => (
                <Text key={log.id} style={styles.recordMeta}>- {log.message}</Text>
              ))}
              {(logsByShiftId.get(selectedShift.id) || []).length === 0 ? (
                <Text style={styles.helperText}>No daily logs for this shift.</Text>
              ) : null}
            </View>
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>Incidents</Text>
              {(incidentsByShiftId.get(selectedShift.id) || []).map((incident) => (
                <Text key={incident.id} style={styles.recordMeta}>- {incident.title} ({formatStatusLabel(incident.status)})</Text>
              ))}
              {(incidentsByShiftId.get(selectedShift.id) || []).length === 0 ? (
                <Text style={styles.helperText}>No incidents linked to this shift.</Text>
              ) : null}
            </View>
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>Safety / Check Calls</Text>
              {(alertsByShiftId.get(selectedShift.id) || []).map((alert) => (
                <Text key={alert.id} style={styles.recordMeta}>- {formatStatusLabel(alert.type)} ({formatStatusLabel(alert.status)})</Text>
              ))}
              {(alertsByShiftId.get(selectedShift.id) || []).length === 0 ? (
                <Text style={styles.helperText}>No safety or welfare events linked to this shift.</Text>
              ) : null}
            </View>
          </View>
              </>
            );
          })()}
        </View>
      ) : null}
    </View>
  );

  const renderGuardsSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.splitLayout}>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Available Platform Guards</Text>
          {availablePlatformGuards.map((guard) => (
            <View key={guard.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{guard.fullName}</Text>
              <Text style={styles.tableCell}>{guard.siaLicenseNumber || guard.siaLicenceNumber || 'No SIA yet'}</Text>
              <Text style={styles.tableCell}>{guard.phone}</Text>
              <View style={styles.rowActions}>
                <Pressable style={styles.primaryButton} onPress={() => handleApproveGuard(guard.id)} disabled={approvingGuardId === guard.id}>
                  <Text style={styles.primaryButtonText}>{approvingGuardId === guard.id ? 'Linking...' : 'Link Guard'}</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Linked Guards</Text>
          {linkedGuards.map((guard) => (
            <View key={guard.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{guard.fullName}</Text>
              <Text style={styles.tableCell}>{guard.phone}</Text>
              <Text style={styles.tableCell}>{shifts.filter((shift) => (shift.guard?.id ?? shift.guardId) === guard.id).length} shifts</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );

  const renderShiftOffersSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.toolbar}>
        <Text style={styles.sectionTitle}>Shift Offers / Pending Responses</Text>
        <Pressable style={styles.secondaryButton} onPress={() => loadData(true)}>
          <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {shiftOffersFeedback ? (
        <View
          style={[
            styles.feedbackCard,
            shiftOffersFeedback.tone === 'error' ? styles.feedbackCardError : styles.feedbackCardSuccess,
          ]}
        >
          <Text
            style={[
              styles.feedbackTitle,
              shiftOffersFeedback.tone === 'error' ? styles.feedbackTitleError : styles.feedbackTitleSuccess,
            ]}
          >
            {shiftOffersFeedback.tone === 'error' ? 'Action failed' : 'Action completed'}
          </Text>
          <Text
            style={[
              styles.feedbackText,
              shiftOffersFeedback.tone === 'error' ? styles.feedbackTextError : styles.feedbackTextSuccess,
            ]}
          >
            {shiftOffersFeedback.message}
          </Text>
        </View>
      ) : null}

      <View style={styles.kpiGrid}>
        {[
          ['Waiting Response', String(pendingShiftOffers.length)],
          ['Ready To Start', String(readyShiftOffers.length)],
          ['Missed / Re-cover', String(missedShiftOffers.length)],
          ['Rejected / Re-cover', String(rejectedShiftOffers.length)],
        ].map(([label, value]) => (
          <View key={label} style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>{label}</Text>
            <Text style={styles.kpiValue}>{value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.panelGrid}>
        <View style={[styles.tableCard, styles.operationsBoardCard]}>
          <Text style={styles.panelTitle}>Offer Response Board</Text>
          <Text style={styles.helperText}>
            Track guard responses after rota planning. Offered shifts are waiting, ready shifts are confirmed, missed shifts need exception follow-up and re-cover, and rejected shifts need fresh cover.
          </Text>
          {renderTableHeader(['Shift', 'Site', 'Guard', 'Date', 'Time', 'State', 'Response'])}
          {shiftOfferRows.map((shift) => {
            const lifecycleStatus = normalizeShiftLifecycleStatus(shift.status);
            const responseText =
              lifecycleStatus === 'offered'
                ? 'Waiting for guard response'
                : lifecycleStatus === 'ready'
                  ? 'Accepted and ready to start'
                  : lifecycleStatus === 'missed'
                    ? 'Missed check-in, exception follow-up and re-cover required'
                    : 'Rejected and needs reassignment';

            const reassignmentOptions = linkedGuardOptions.filter(
              (option) => option.value !== String(shift.guard?.id ?? shift.guardId ?? ''),
            );

            return (
              <View
                key={shift.id}
                style={[styles.tableRow, selectedShiftId === shift.id && styles.tableRowSelected, styles.offerRow]}
              >
                <Pressable
                  style={styles.offerRowSummary}
                  onPress={() => {
                    setSelectedShiftId(shift.id);
                    setActiveSection('shift-offers');
                  }}
                >
                  <Text style={styles.tableCellStrong}>#{shift.id}</Text>
                  <Text style={styles.tableCell}>{shift.site?.name || shift.siteName || 'Unknown site'}</Text>
                  <Text style={styles.tableCell}>{shift.guard?.fullName || 'Unassigned'}</Text>
                  <Text style={styles.tableCell}>{formatDateLabel(shift.start)}</Text>
                  <Text style={styles.tableCell}>
                    {formatTimeLabel(shift.start)}-{formatTimeLabel(shift.end)}
                  </Text>
                  <View style={styles.tableCell}>
                    <ShiftStatusBadge status={shift.status} />
                  </View>
                  <Text style={styles.tableCell}>{responseText}</Text>
                </Pressable>
                <View style={styles.offerRowActions}>
                  {lifecycleStatus === 'offered' ? (
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleCancelShiftOffer(shift.id)}
                      disabled={offerActionShiftId === shift.id}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {offerActionShiftId === shift.id ? 'Cancelling...' : 'Withdraw Offer'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {lifecycleStatus === 'ready' ? (
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => {
                        setShiftOffersFeedback({
                          tone: 'success',
                          message: `Opening Shift #${shift.id} in Live Operations.`,
                        });
                        setSelectedShiftId(shift.id);
                        setActiveSection('live-operations');
                      }}
                    >
                      <Text style={styles.primaryButtonText}>Open In Live Ops</Text>
                    </Pressable>
                  ) : null}
                  {['rejected', 'missed'].includes(lifecycleStatus) ? (
                    <View style={styles.offerReassignBox}>
                      <WebSelect
                        value={reassignGuardByShiftId[shift.id] || ''}
                        onChange={(value: string) =>
                          setReassignGuardByShiftId((current) => ({ ...current, [shift.id]: value }))
                        }
                        options={reassignmentOptions}
                        placeholder="Choose replacement guard"
                      />
                      <Pressable
                        style={styles.primaryButton}
                        onPress={() => handleReofferShift(shift.id)}
                        disabled={offerActionShiftId === shift.id}
                      >
                        <Text style={styles.primaryButtonText}>
                          {offerActionShiftId === shift.id ? 'Re-offering...' : 'Re-offer Shift'}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
          {shiftOfferRows.length === 0 ? (
            <Text style={styles.helperText}>No current shift offers are waiting for response.</Text>
          ) : null}
        </View>

        <View style={styles.operationsSideColumn}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Waiting Response</Text>
            {pendingShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'Unassigned'} | {formatDateTimeLabel(shift.start)}
                </Text>
              </View>
            ))}
            {pendingShiftOffers.length === 0 ? <Text style={styles.helperText}>No outstanding guard responses.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Ready To Start</Text>
            {readyShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'Unassigned'} | Accepted and ready for book on
                </Text>
              </View>
            ))}
            {readyShiftOffers.length === 0 ? <Text style={styles.helperText}>No accepted offers are waiting to start.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Missed / Needs Re-cover</Text>
            {missedShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} · {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'No guard'} | Missed check-in, follow up if needed and find replacement cover
                </Text>
              </View>
            ))}
            {missedShiftOffers.length === 0 ? <Text style={styles.helperText}>No missed shifts need re-cover right now.</Text> : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Rejected / Needs Re-cover</Text>
            {rejectedShiftOffers.slice(0, 6).map((shift) => (
              <View key={shift.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>Shift #{shift.id} Â· {shift.site?.name || shift.siteName}</Text>
                <Text style={styles.recordMeta}>
                  {shift.guard?.fullName || 'No guard'} | Offer rejected, find replacement cover
                </Text>
              </View>
            ))}
            {rejectedShiftOffers.length === 0 ? <Text style={styles.helperText}>No rejected offers need re-cover right now.</Text> : null}
          </View>
        </View>
      </View>

      {selectedShift && ['offered', 'ready', 'rejected', 'missed'].includes(normalizeShiftLifecycleStatus(selectedShift.status)) ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Selected Offer Detail</Text>
          <Text style={styles.recordMeta}>
            {selectedShift.site?.client?.name || clientMap.get(selectedShift.site?.clientId || 0)?.name || 'No client'} | {selectedShift.site?.name || selectedShift.siteName}
          </Text>
          <Text style={styles.recordMeta}>
            {selectedShift.guard?.fullName || 'No guard assigned'} | {formatDateLabel(selectedShift.start)} | {formatTimeLabel(selectedShift.start)}-{formatTimeLabel(selectedShift.end)}
          </Text>
          <ShiftStatusBadge status={selectedShift.status} />
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'offered' ? (
            <Text style={styles.recordMeta}>Waiting for this guard to accept or reject the offer.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'ready' ? (
            <Text style={styles.recordMeta}>Guard accepted this shift. It is ready to move into live operations.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'rejected' ? (
            <Text style={styles.recordMeta}>Offer was rejected before the shift went live. Fresh cover is still required.</Text>
          ) : null}
          {normalizeShiftLifecycleStatus(selectedShift.status) === 'missed' ? (
            <Text style={styles.recordMeta}>Missed check-in exception: no attendance was recorded within the grace period. Re-cover is now required, and attendance follow-up may still be needed.</Text>
          ) : null}
          <Text style={styles.recordMeta}>Instructions: {selectedShift.instructions || 'No instructions recorded.'}</Text>
          <View style={styles.rowActions}>
            {normalizeShiftLifecycleStatus(selectedShift.status) === 'offered' ? (
              <Pressable
                style={styles.secondaryButton}
                onPress={() => handleCancelShiftOffer(selectedShift.id)}
                disabled={offerActionShiftId === selectedShift.id}
              >
                <Text style={styles.secondaryButtonText}>
                  {offerActionShiftId === selectedShift.id ? 'Cancelling...' : 'Withdraw Offer'}
                </Text>
              </Pressable>
            ) : null}
            {normalizeShiftLifecycleStatus(selectedShift.status) === 'ready' ? (
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  setShiftOffersFeedback({
                    tone: 'success',
                    message: `Opening Shift #${selectedShift.id} in Live Operations.`,
                  });
                  setActiveSection('live-operations');
                }}
              >
                <Text style={styles.primaryButtonText}>Open In Live Operations</Text>
              </Pressable>
            ) : null}
          </View>
          {['rejected', 'missed'].includes(normalizeShiftLifecycleStatus(selectedShift.status)) ? (
            <View style={styles.offerReassignBox}>
              <WebSelect
                value={reassignGuardByShiftId[selectedShift.id] || ''}
                onChange={(value: string) =>
                  setReassignGuardByShiftId((current) => ({ ...current, [selectedShift.id]: value }))
                }
                options={linkedGuardOptions.filter(
                  (option) => option.value !== String(selectedShift.guard?.id ?? selectedShift.guardId ?? ''),
                )}
                placeholder="Choose replacement guard"
              />
              <Pressable
                style={styles.primaryButton}
                onPress={() => handleReofferShift(selectedShift.id)}
                disabled={offerActionShiftId === selectedShift.id}
              >
                <Text style={styles.primaryButtonText}>
                  {offerActionShiftId === selectedShift.id ? 'Re-offering...' : 'Re-offer Shift'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const renderRecruitmentSection = () => (
    <View style={styles.sectionStack}>
      <View style={styles.splitLayout}>
        <View style={styles.formCard}>
          <Text style={styles.panelTitle}>Create Recruitment Job</Text>
          <TextInput style={styles.input} value={jobForm.title} onChangeText={(value: string) => setJobForm((current) => ({ ...current, title: value }))} placeholder="Job title" />
          <WebSelect value={jobForm.siteId} onChange={(value: string) => setJobForm((current) => ({ ...current, siteId: value }))} options={siteOptions} placeholder="Site" />
          <TextInput style={[styles.input, styles.textArea]} multiline value={jobForm.description} onChangeText={(value: string) => setJobForm((current) => ({ ...current, description: value }))} placeholder="Description" />
          <View style={styles.formRow}>
            <TextInput style={[styles.input, styles.formCell]} value={jobForm.guardsRequired} onChangeText={(value: string) => setJobForm((current) => ({ ...current, guardsRequired: value }))} placeholder="Guards required" />
            <TextInput style={[styles.input, styles.formCell]} value={jobForm.hourlyRate} onChangeText={(value: string) => setJobForm((current) => ({ ...current, hourlyRate: value }))} placeholder="Hourly rate" />
          </View>
          <Pressable style={styles.primaryButton} onPress={handleCreateJob} disabled={creatingJob}>
            <Text style={styles.primaryButtonText}>{creatingJob ? 'Saving...' : 'Create Job'}</Text>
          </Pressable>
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Applications</Text>
          <Text style={styles.helperText}>
            Application review approves a guard for future work with this company. Shift offers are tracked separately once rota or shift assignment is made.
          </Text>
          {applications.map((application) => (
            <View key={application.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{application.job?.title || `Job #${application.jobId}`}</Text>
              <Text style={styles.tableCell}>{application.guard?.fullName || `Guard #${application.guardId}`}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(application.status)}</Text>
              <Text style={styles.tableCell}>
                {applicationShiftSummaryById.get(application.id)
                  ? `${formatStatusLabel(applicationShiftSummaryById.get(application.id)?.status || '')} · ${applicationShiftSummaryById.get(application.id)?.siteName}`
                  : 'No shift offered'}
              </Text>
              <View style={styles.rowActions}>
                {application.status === 'applied' ? (
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => handleReviewApplication(application.id, 'under_review')}
                    disabled={reviewingApplicationId === application.id}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {reviewingApplicationId === application.id ? 'Updating...' : 'Under Review'}
                    </Text>
                  </Pressable>
                ) : null}
                {application.status !== 'accepted' && application.status !== 'rejected' ? (
                  <>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => handleReviewApplication(application.id, 'accepted')}
                      disabled={reviewingApplicationId === application.id}
                    >
                      <Text style={styles.primaryButtonText}>
                        {reviewingApplicationId === application.id ? 'Updating...' : 'Accept Application'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={() => handleReviewApplication(application.id, 'rejected')}
                      disabled={reviewingApplicationId === application.id}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {reviewingApplicationId === application.id ? 'Updating...' : 'Reject'}
                      </Text>
                    </Pressable>
                  </>
                ) : null}
                {application.status === 'accepted' ? (
                  <Text style={styles.helperText}>Approved for company assignment</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
        <View style={styles.tableCard}>
          <Text style={styles.panelTitle}>Approved Guards Ready For Shift Offers</Text>
          <Text style={styles.helperText}>
            These guards are recruitment-approved. Offer them specific shifts from Rota Planner or shift assignment without changing the application decision.
          </Text>
          {acceptedApplications.length === 0 ? (
            <Text style={styles.helperText}>No approved applications yet.</Text>
          ) : (
            acceptedApplications.map((application) => {
              const latestOffer = applicationShiftSummaryById.get(application.id);

              return (
                <View key={`approved-${application.id}`} style={styles.tableRow}>
                  <Text style={styles.tableCellStrong}>{application.guard?.fullName || `Guard #${application.guardId}`}</Text>
                  <Text style={styles.tableCell}>{application.job?.title || `Job #${application.jobId}`}</Text>
                  <Text style={styles.tableCell}>Application Accepted</Text>
                  <Text style={styles.tableCell}>
                    {latestOffer
                      ? `${formatStatusLabel(latestOffer.status)} · ${latestOffer.siteName}`
                      : 'No shift offered yet'}
                  </Text>
                </View>
              );
            })
          )}
        </View>
      </View>
    </View>
  );

  const renderSimpleTableSection = (
    title: string,
    columns: string[],
    rows: any,
  ) => (
    <View style={styles.sectionStack}>
      <View style={styles.tableCard}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {renderTableHeader(columns)}
        {rows}
      </View>
    </View>
  );

  const renderContent = () => {
    switch (activeSection) {
      case 'dashboard':
        return renderDashboardSection();
      case 'clients':
        return renderClientsSection();
      case 'sites':
        return renderSitesSection();
      case 'rota-planner':
        return renderRotaPlannerSection();
      case 'shift-offers':
        return renderShiftOffersSection();
      case 'live-operations':
        return renderLiveOperationsSection();
      case 'guards':
        return renderGuardsSection();
      case 'recruitment':
        return renderRecruitmentSection();
      case 'timesheets':
        return renderSimpleTableSection(
          'Timesheets',
          ['Guard', 'Site', 'Shift', 'Date', 'Hours', 'Status'],
          timesheets.map((timesheet) => (
            <View key={timesheet.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{timesheet.guard?.fullName || 'Unassigned'}</Text>
              <Text style={styles.tableCell}>{timesheet.shift?.site?.name || timesheet.shift?.siteName || '—'}</Text>
              <Text style={styles.tableCell}>#{timesheet.shiftId}</Text>
              <Text style={styles.tableCell}>{formatDateLabel(timesheet.shift?.start)}</Text>
              <Text style={styles.tableCell}>{timesheet.hoursWorked ?? 0}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(timesheet.approvalStatus)}</Text>
            </View>
          )),
        );
      case 'incidents':
        return renderSimpleTableSection(
          'Incidents',
          ['Incident', 'Shift', 'Site', 'Guard', 'Severity', 'Status', 'Time'],
          incidents.map((incident) => (
            <View key={incident.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>#{incident.id}</Text>
              <Text style={styles.tableCell}>{incident.shift?.id ? `#${incident.shift.id}` : '—'}</Text>
              <Text style={styles.tableCell}>{incident.site?.name || incident.shift?.site?.name || '—'}</Text>
              <Text style={styles.tableCell}>{incident.guard?.fullName || '—'}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(incident.severity)}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(incident.status)}</Text>
              <Text style={styles.tableCell}>{formatDateTimeLabel(incident.createdAt)}</Text>
            </View>
          )),
        );
      case 'alerts':
        return renderSimpleTableSection(
          'Safety Alerts',
          ['Type', 'Shift', 'Site', 'Guard', 'Status', 'Time'],
          alerts.map((alert) => (
            <View key={alert.id} style={styles.tableRow}>
              <Text style={styles.tableCellStrong}>{formatStatusLabel(alert.type)}</Text>
              <Text style={styles.tableCell}>{alert.shift?.id ? `#${alert.shift.id}` : '—'}</Text>
              <Text style={styles.tableCell}>{alert.shift?.site?.name || alert.shift?.siteName || '—'}</Text>
              <Text style={styles.tableCell}>{alert.guard?.fullName || '—'}</Text>
              <Text style={styles.tableCell}>{formatStatusLabel(alert.status)}</Text>
              <Text style={styles.tableCell}>{formatDateTimeLabel(alert.createdAt)}</Text>
            </View>
          )),
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingShell}>
        <Text style={styles.loadingText}>Loading company operations workspace...</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.sidebar}>
        <Text style={styles.brandEyebrow}>Observant Security</Text>
        <Text style={styles.brandTitle}>Company Operations</Text>
        <Text style={styles.brandCopy}>Clients, sites, rota planning, and live shift monitoring in one control room.</Text>
        {NAV_ITEMS.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.navItem, activeSection === item.id && styles.navItemActive]}
            onPress={() => setActiveSection(item.id)}
          >
            <Text style={[styles.navLabel, activeSection === item.id && styles.navLabelActive]}>{item.label}</Text>
            <Text style={[styles.navCaption, activeSection === item.id && styles.navCaptionActive]}>{item.caption}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>Operations Console</Text>
            <Text style={styles.headerTitle}>
              {NAV_ITEMS.find((item) => item.id === activeSection)?.label || 'Company Dashboard'}
            </Text>
          </View>
          <Pressable style={styles.secondaryButton} onPress={() => loadData(true)}>
            <Text style={styles.secondaryButtonText}>{refreshing ? 'Refreshing...' : 'Refresh Data'}</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Action required</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {renderContent()}
      </ScrollView>
    </View>
  );
}

const webSelectStyle = {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: '#d6dce5',
  backgroundColor: '#ffffff',
  padding: '14px 16px',
  fontSize: 14,
  color: '#132238',
  minHeight: 48,
} as const;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#eef3f8',
  },
  sidebar: {
    width: 300,
    backgroundColor: '#0f1a2b',
    paddingHorizontal: 24,
    paddingVertical: 28,
    gap: 12,
  },
  brandEyebrow: {
    color: '#7dd3fc',
    fontSize: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  brandTitle: {
    color: '#f8fafc',
    fontSize: 32,
    fontWeight: '800',
  },
  brandCopy: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 10,
  },
  navItem: {
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 16,
    backgroundColor: 'rgba(148, 163, 184, 0.08)',
    gap: 4,
  },
  navItemActive: {
    backgroundColor: '#e0f2fe',
  },
  navLabel: {
    color: '#f8fafc',
    fontWeight: '700',
    fontSize: 16,
  },
  navLabelActive: {
    color: '#0f172a',
  },
  navCaption: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 18,
  },
  navCaptionActive: {
    color: '#334155',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 28,
    gap: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 2,
    fontSize: 12,
    fontWeight: '700',
    color: '#f97316',
  },
  headerTitle: {
    fontSize: 34,
    fontWeight: '800',
    color: '#0f172a',
  },
  sectionStack: {
    gap: 20,
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  kpiCard: {
    minWidth: 180,
    flexGrow: 1,
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 20,
  },
  kpiLabel: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '600',
  },
  kpiValue: {
    color: '#0f172a',
    fontSize: 32,
    fontWeight: '800',
    marginTop: 10,
  },
  panelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
  },
  panel: {
    flexGrow: 1,
    minWidth: 320,
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 20,
    gap: 12,
  },
  priorityPanel: {
    shadowColor: '#0f172a',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  urgentPanel: {
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FFF7F7',
  },
  selectedShiftPanel: {
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  secondaryPanel: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  panelTitle: {
    color: '#0f172a',
    fontSize: 20,
    fontWeight: '800',
  },
  secondaryPanelTitle: {
    fontSize: 18,
    color: '#334155',
  },
  panelTitleInline: {
    marginTop: 12,
  },
  splitLayout: {
    flexDirection: 'row',
    gap: 20,
    alignItems: 'flex-start',
  },
  tableCard: {
    flex: 2,
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 20,
    gap: 10,
  },
  operationsBoardCard: {
    flex: 2.2,
    minWidth: 760,
  },
  operationsSideColumn: {
    flex: 1,
    minWidth: 320,
    gap: 18,
  },
  formCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 20,
    gap: 12,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toolbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  filterBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d6dce5',
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#132238',
    minWidth: 160,
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  textAreaSmall: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  formRow: {
    flexDirection: 'row',
    gap: 12,
  },
  formCell: {
    flex: 1,
  },
  inputGroup: {
    flex: 1,
    gap: 6,
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#e2e8f0',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  ghostButton: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
  },
  ghostButtonText: {
    color: '#dc2626',
    fontWeight: '700',
  },
  tableHeader: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  tableHeaderText: {
    flex: 1,
    color: '#64748b',
    fontWeight: '700',
    fontSize: 12,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  liveBoardRow: {
    cursor: 'pointer',
  },
  liveBoardRowHighlighted: {
    borderWidth: 2,
    borderColor: '#2563EB',
    borderRadius: 14,
  },
  tableRowSelected: {
    backgroundColor: '#f8fafc',
    borderRadius: 14,
    paddingHorizontal: 10,
  },
  tableCell: {
    flex: 1,
    color: '#334155',
  },
  tableCellStrong: {
    flex: 1,
    color: '#0f172a',
    fontWeight: '700',
  },
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  offerRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  offerRowSummary: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  offerRowActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  offerReassignBox: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  recordRow: {
    gap: 4,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#edf2f7',
  },
  recordTitle: {
    color: '#0f172a',
    fontWeight: '700',
  },
  recordMeta: {
    color: '#64748b',
    fontSize: 13,
  },
  helperText: {
    color: '#64748b',
    fontSize: 13,
  },
  urgentItemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  nextActionText: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '700',
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  subtleLabel: {
    color: '#475569',
    fontWeight: '700',
    fontSize: 13,
  },
  weekGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  dayCard: {
    width: '48%',
    minWidth: 320,
    backgroundColor: '#ffffff',
    borderRadius: 22,
    padding: 18,
    gap: 12,
  },
  dayCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dayCardTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '800',
  },
  dayCardMeta: {
    color: '#64748b',
    fontSize: 13,
  },
  plannerRow: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginTop: 16,
  },
  detailCard: {
    minWidth: 260,
    flexGrow: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 18,
    padding: 16,
    gap: 8,
  },
  detailTitle: {
    color: '#0f172a',
    fontWeight: '800',
    fontSize: 16,
  },
  closeOutCard: {
    backgroundColor: '#f1f5f9',
  },
  closeOutNotesSection: {
    gap: 8,
    marginTop: 8,
  },
  closeOutStatusGood: {
    color: '#166534',
  },
  closeOutStatusAttention: {
    color: '#b45309',
  },
  errorCard: {
    backgroundColor: '#fee2e2',
    borderRadius: 18,
    padding: 16,
    gap: 4,
  },
  errorTitle: {
    color: '#991b1b',
    fontWeight: '800',
  },
  errorText: {
    color: '#7f1d1d',
  },
  feedbackCard: {
    borderRadius: 18,
    padding: 16,
    gap: 4,
  },
  feedbackCardSuccess: {
    backgroundColor: '#dcfce7',
  },
  feedbackCardError: {
    backgroundColor: '#fee2e2',
  },
  feedbackTitle: {
    fontWeight: '800',
  },
  feedbackTitleSuccess: {
    color: '#166534',
  },
  feedbackTitleError: {
    color: '#991b1b',
  },
  feedbackText: {
    fontSize: 14,
  },
  feedbackTextSuccess: {
    color: '#166534',
  },
  feedbackTextError: {
    color: '#7f1d1d',
  },
  loadingShell: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#eef3f8',
  },
  loadingText: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '700',
  },
});

