import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import { GuardCompliancePanel } from '../components/guard/GuardCompliancePanel';
import { JobsScreen } from './JobsScreen';
import { GuardTimesheetsScreen } from './GuardTimesheetsScreen';
import { GuardAvailabilityScreen } from './GuardAvailabilityScreen';
import {
  checkInShift,
  checkOutShift,
  createDailyLog,
  createIncident,
  createSafetyAlert,
  formatApiErrorMessage,
  getMyGuard,
  listMyAttendance,
  listMyDailyLogs,
  listMyIncidents,
  listMyShifts,
  listMyTimesheets,
  logout,
  respondToShift,
  updateMyGuard,
} from '../services/api';
import { clearStoredSession } from '../services/session';
import {
  AttendanceEvent,
  AuthUser,
  DailyLog,
  Incident,
  Shift,
  Timesheet,
} from '../types/models';

interface GuardDashboardScreenProps {
  user: AuthUser;
}

type GuardTab = 'home' | 'offers' | 'jobs' | 'history' | 'profile';
type QuickActionModal = 'log' | 'checkCall' | 'incident' | 'welfare' | 'panic' | null;

type LocalTimelineEvent = {
  id: string;
  shiftId: number;
  title: string;
  message: string;
  occurredAt: string;
};

function normalizeShiftLifecycleStatus(status?: string | null) {
  const normalized = (status || '').trim().toLowerCase();
  switch (normalized) {
    case 'planned':
    case 'scheduled':
    case 'unassigned':
      return 'unfilled';
    case 'assigned':
      return 'offered';
    case 'accepted':
      return 'ready';
    default:
      return normalized || 'unfilled';
  }
}

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

function formatDateLabel(value?: string | null) {
  if (!value) return 'TBC';
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts) {
    return new Date(
      Number(literalParts.year),
      Number(literalParts.month) - 1,
      Number(literalParts.day),
    ).toLocaleDateString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeLabel(value?: string | null) {
  if (!value) return 'TBC';
  const literalParts = getLiteralDateTimeParts(value);
  if (literalParts?.hour && literalParts?.minute) {
    return `${literalParts.hour}:${literalParts.minute}`;
  }
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Plain-language urgency from booked start only (presentation). */
function getOfferShiftUrgencyLine(startAt: string, nowMs: number): string {
  const start = new Date(startAt).getTime();
  const diffMs = start - nowMs;
  if (!Number.isFinite(diffMs)) return '';
  if (diffMs <= 0) {
    return 'Booked start time has passed — check with control before you accept.';
  }
  const hourMs = 3600000;
  const dayMs = 86400000;
  if (diffMs < hourMs) return 'Starts within an hour — decide soon.';
  if (diffMs < 12 * hourMs) return 'Starts today — read the post carefully before you accept.';
  if (diffMs < 24 * hourMs) return 'Starts within 24 hours — confirm you can cover it.';
  if (diffMs < 2 * dayMs) return 'Starts tomorrow — you still have time to decide.';
  const days = Math.ceil(diffMs / dayMs);
  if (days <= 7) return `Starts in ${days} days.`;
  return `Starts ${formatDateLabel(startAt)} — respond before you are due on site.`;
}

/** Display-only labels for timesheet rows in History summary (matches guard-facing wording elsewhere). */
function formatHistoryTimesheetStatus(status?: string | null) {
  const s = (status || '').trim().toLowerCase();
  if (s === 'draft') return 'Draft';
  if (s === 'submitted') return 'Submitted';
  if (s === 'approved') return 'Approved';
  if (s === 'rejected') return 'Rejected';
  if (s === 'returned') return 'Returned';
  return (status || 'Unknown').replace(/_/g, ' ');
}

function formatSummaryAttendanceLine(iso?: string | null) {
  if (!iso) return 'Pending';
  return `${formatDateLabel(iso)} · ${formatTimeLabel(iso)}`;
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function getShiftStatusPalette(status?: string | null) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'offered':
      return { bg: '#DBEAFE', text: '#1D4ED8' };
    case 'ready':
      return { bg: '#FEF3C7', text: '#B45309' };
    case 'in_progress':
      return { bg: '#DCFCE7', text: '#15803D' };
    case 'completed':
      return { bg: '#E5E7EB', text: '#1F2937' };
    case 'missed':
      return { bg: '#FEE2E2', text: '#991B1B' };
    case 'rejected':
      return { bg: '#FEE2E2', text: '#B91C1C' };
    case 'cancelled':
      return { bg: '#E5E7EB', text: '#6B7280' };
    default:
      return { bg: '#F3F4F6', text: '#4B5563' };
  }
}

function ShiftStatusBadge({ status }: { status?: string | null }) {
  const normalized = normalizeShiftLifecycleStatus(status);
  const palette = getShiftStatusPalette(status);
  return (
    <View style={[styles.statusBadge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.statusBadgeText, { color: palette.text }]}>{normalized.replace('_', ' ')}</Text>
    </View>
  );
}

function getPrimaryActionLabel(status?: string | null) {
  switch (normalizeShiftLifecycleStatus(status)) {
    case 'offered':
      return 'Review Offer';
    case 'ready':
      return 'Start Shift';
    case 'in_progress':
      return 'End Shift';
    case 'completed':
      return 'View Summary';
    default:
      return null;
  }
}

function getReadOnlyHomeActionLabel(status?: string | null) {
  const normalized = normalizeShiftLifecycleStatus(status);
  if (normalized === 'completed') return 'View Summary';
  if (normalized === 'missed') return 'Missed Shift';
  if (normalized === 'rejected') return 'Offer Declined';
  if (normalized === 'cancelled') return 'Shift Cancelled';
  return 'View Shift';
}

function formatDurationLabel(startAt?: string | null, endAt?: string | null, nowMs?: number) {
  if (!startAt) return '0m';
  const start = new Date(startAt).getTime();
  const end = endAt ? new Date(endAt).getTime() : nowMs ?? Date.now();
  const totalMinutes = Math.max(0, Math.round((end - start) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** UI-only thresholds for check-call and shift-end guidance (no API impact). */
const CHECK_CALL_DUE_SOON_MINUTES = 10;
const SHIFT_ENDING_SOON_MINUTES = 30;

type GuardShiftPhase =
  | 'no_shift'
  | 'offer_pending'
  | 'before_shift'
  | 'shift_window_check_in'
  | 'on_shift'
  | 'check_call_due'
  | 'check_call_overdue'
  | 'shift_ending_soon'
  | 'shift_ended'
  | 'timesheet_pending';

function isTimesheetPendingGuard(timesheet: Timesheet): boolean {
  const s = String(timesheet.approvalStatus || '').toLowerCase();
  return ['draft', 'returned', 'submitted', 'rejected'].includes(s);
}

function getLastCheckCallLog(dailyLogsForShift: DailyLog[]): DailyLog | undefined {
  return [...dailyLogsForShift]
    .filter((entry) => entry.logType === 'check_call')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

function getNextCheckCallDueMs(shift: Shift, dailyLogsForShift: DailyLog[]): number | null {
  const interval = shift.checkCallIntervalMinutes;
  if (!interval || interval <= 0) return null;
  const last = getLastCheckCallLog(dailyLogsForShift);
  const anchorMs = (last ? new Date(last.createdAt) : new Date(shift.start)).getTime();
  return anchorMs + interval * 60 * 1000;
}

function deriveGuardShiftPhase(
  nowMs: number,
  shift: Shift | null,
  dailyLogsForShift: DailyLog[],
  timesheet: Timesheet | null,
): GuardShiftPhase {
  if (!shift) return 'no_shift';
  const status = normalizeShiftLifecycleStatus(shift.status);
  const startMs = new Date(shift.start).getTime();
  const endMs = new Date(shift.end).getTime();

  if (status === 'offered') return 'offer_pending';

  if (['completed', 'missed', 'cancelled', 'rejected'].includes(status)) {
    if (status === 'completed' && timesheet && isTimesheetPendingGuard(timesheet)) {
      return 'timesheet_pending';
    }
    return 'shift_ended';
  }

  if (status === 'ready') {
    if (nowMs < startMs) return 'before_shift';
    return 'shift_window_check_in';
  }

  if (status === 'in_progress') {
    const nextDueMs = getNextCheckCallDueMs(shift, dailyLogsForShift);
    if (nextDueMs !== null) {
      const minutesRemaining = Math.max(0, Math.round((nextDueMs - nowMs) / 60000));
      if (nowMs >= nextDueMs) return 'check_call_overdue';
      if (minutesRemaining > 0 && minutesRemaining <= CHECK_CALL_DUE_SOON_MINUTES) {
        return 'check_call_due';
      }
    }
    if (nowMs >= endMs - SHIFT_ENDING_SOON_MINUTES * 60 * 1000 && nowMs < endMs) {
      return 'shift_ending_soon';
    }
    return 'on_shift';
  }

  return 'shift_ended';
}

function getGuardPhaseStatusLine(
  phase: GuardShiftPhase,
  shift: Shift | null,
  nowMs: number,
  dailyLogsForShift: DailyLog[],
): string {
  if (!shift) {
    return phase === 'no_shift'
      ? "You're between shifts — nothing needs clocking in on Home right now."
      : 'No shift details.';
  }
  switch (phase) {
    case 'no_shift':
      return "You're between shifts — nothing needs clocking in on Home right now.";
    case 'offer_pending':
      return 'A shift is waiting on your answer — open Offers or use Main action below.';
    case 'before_shift':
      return `Next shift starts ${formatTimeLabel(shift.start)} on ${formatDateLabel(shift.start)}. You are early — check-in unlocks at that time.`;
    case 'shift_window_check_in': {
      if (nowMs >= new Date(shift.end).getTime()) {
        return 'This shift window has ended. Check in only if control has asked you to, or contact them.';
      }
      return 'You are within your shift window — check in to go live.';
    }
    case 'on_shift':
      return 'You are on shift.';
    case 'check_call_due': {
      const nextDueMs = getNextCheckCallDueMs(shift, dailyLogsForShift);
      if (nextDueMs === null) return 'Stay available for your next check call.';
      const m = Math.max(1, Math.round((nextDueMs - nowMs) / 60000));
      return `Check call due in ${m} min.`;
    }
    case 'check_call_overdue':
      return 'Check call overdue — record a check call as soon as you can.';
    case 'shift_ending_soon':
      return 'Your shift is ending soon — check out before end time unless instructed otherwise.';
    case 'timesheet_pending':
      return 'Hours for this shift still need a timesheet step — finish it so payroll can move.';
    case 'shift_ended': {
      const st = normalizeShiftLifecycleStatus(shift.status);
      if (st === 'missed') return 'This shift was marked missed — check History or your supervisor if that looks wrong.';
      if (st === 'cancelled') return 'This shift was cancelled — nothing more to clock here.';
      if (st === 'rejected') return 'You declined this offer — watch Offers if another slot appears.';
      return 'This shift is finished — recap below; timesheets and older posts sit under History.';
    }
    default:
      return '';
  }
}

function getGuardPhasePrimaryLabel(phase: GuardShiftPhase, shift: Shift | null): string | null {
  if (!shift) return null;
  switch (phase) {
    case 'no_shift':
      return null;
    case 'offer_pending':
      return 'Review Offer';
    case 'before_shift':
      return 'Check in at start';
    case 'shift_window_check_in':
      return 'Check in now';
    case 'on_shift':
    case 'check_call_due':
    case 'check_call_overdue':
    case 'shift_ending_soon':
      return getPrimaryActionLabel('in_progress');
    case 'timesheet_pending':
    case 'shift_ended':
      return getReadOnlyHomeActionLabel(shift.status);
    default:
      return getPrimaryActionLabel(shift.status);
  }
}

/** Short coaching copy under the phase status line (presentation only). */
function getPrimaryActionGuidance(phase: GuardShiftPhase): string | null {
  switch (phase) {
    case 'offer_pending':
      return 'Main action jumps to the Offers tab — same accept / reject flow as before.';
    case 'before_shift':
      return 'You cannot clock in yet. Use the time above to travel, sign in on site, and be ready at start.';
    case 'shift_ended':
      return 'View summary shows check-in, check-out, and incidents for this post. History holds timesheets and older shifts.';
    case 'shift_window_check_in':
      return 'Use this when you are on site and ready to work. You can still use Live shift actions below after you go live.';
    case 'on_shift':
      return 'End shift when your post is fully finished and signed off — not before.';
    case 'check_call_due':
      return 'Record your check call before the window passes. The same form is in Live shift actions below if you prefer.';
    case 'check_call_overdue':
      return 'Record check call is the priority when it is safe. End shift stays here for when you are completely done.';
    case 'shift_ending_soon':
      return 'Plan your handover now, then check out on time unless control tells you otherwise.';
    case 'timesheet_pending':
      return 'View summary is optional. The important step is your timesheet — use the follow-up block or History.';
    default:
      return null;
  }
}

function getSecondaryActionsHelper(
  phase: GuardShiftPhase,
  statusNorm: string,
  attendanceBusy: boolean,
): string {
  if (attendanceBusy) {
    return 'Wait until check-in or check-out finishes — these buttons unlock straight after.';
  }
  if (phase === 'offer_pending') {
    return 'Accept the offer first. After you are booked and checked in, incident and check call unlock here.';
  }
  if (phase === 'before_shift') {
    return 'You are before start time — reporting stays off until you check in and the shift goes live.';
  }
  if (statusNorm === 'in_progress') {
    if (phase === 'check_call_overdue') {
      return 'Control room sees the same check call whether you tap here or use Check call in Live shift actions below.';
    }
    if (phase === 'check_call_due') {
      return 'Quick access: same modals as the Live shift actions card further down the screen.';
    }
    return 'Available the whole time you are live — use if something changes on site.';
  }
  if (phase === 'timesheet_pending' || phase === 'shift_ended') {
    return 'Only for a live shift. This shift is finished — use timesheet follow-up or History for hours.';
  }
  return 'Unlocks after you check in and the shift shows as live.';
}

export function GuardDashboardScreen({ user }: GuardDashboardScreenProps) {
  const [activeTab, setActiveTab] = useState<GuardTab>('home');
  const [quickActionModal, setQuickActionModal] = useState<QuickActionModal>(null);
  const [liveNow, setLiveNow] = useState<number>(Date.now());
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [siaLicence, setSiaLicence] = useState('');
  const [availabilityStatus, setAvailabilityStatus] = useState('');
  const [locationSharing, setLocationSharing] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [attendance, setAttendance] = useState<AttendanceEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);
  const [historySummaryShiftId, setHistorySummaryShiftId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [attendanceBusyShiftId, setAttendanceBusyShiftId] = useState<number | null>(null);
  const [submittingDailyLogType, setSubmittingDailyLogType] = useState<DailyLog['logType'] | null>(null);
  const [submittingIncident, setSubmittingIncident] = useState(false);
  const [submittingAlertType, setSubmittingAlertType] = useState<'welfare' | 'panic' | null>(null);
  const [respondingShiftId, setRespondingShiftId] = useState<number | null>(null);
  const [offerRespondAction, setOfferRespondAction] = useState<'accepted' | 'rejected' | null>(null);
  const [dailyLogMessage, setDailyLogMessage] = useState('');
  const [incidentMessage, setIncidentMessage] = useState('');
  const [welfareMessage, setWelfareMessage] = useState('');
  const [panicConfirmation, setPanicConfirmation] = useState('');
  const [actionFeedback, setActionFeedback] = useState<{
    tone: 'success' | 'error' | 'info';
    title: string;
    message: string;
  } | null>(null);
  const [localTimelineEvents, setLocalTimelineEvents] = useState<LocalTimelineEvent[]>([]);

  function pushFeedback(tone: 'success' | 'error' | 'info', title: string, message: string) {
    setActionFeedback({ tone, title, message });
  }

  function pushTimelineEvent(shiftId: number, title: string, message: string) {
    setLocalTimelineEvents((current) => [
      {
        id: `${shiftId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        shiftId,
        title,
        message,
        occurredAt: new Date().toISOString(),
      },
      ...current,
    ].slice(0, 20));
  }

  function updateShiftStatusLocally(shiftId: number, nextStatus: string) {
    setShifts((current) =>
      current.map((shift) =>
        shift.id === shiftId ? { ...shift, status: normalizeShiftLifecycleStatus(nextStatus) } : shift,
      ),
    );
  }

  async function loadData() {
    try {
      setLoading(true);
      setLoadError(null);
      const [myGuard, shiftRows, attendanceRows, incidentRows, dailyLogRows, timesheetRows] = await Promise.all([
        getMyGuard(),
        listMyShifts(),
        listMyAttendance(),
        listMyIncidents(),
        listMyDailyLogs(),
        listMyTimesheets(),
      ]);

      setFullName(myGuard.fullName || '');
      setPhone(myGuard.phone || '');
      setSiaLicence(myGuard.siaLicenseNumber || myGuard.siaLicenceNumber || '');
      setAvailabilityStatus(myGuard.status || '');
      setLocationSharing(myGuard.locationSharingEnabled ?? false);
      setShifts(shiftRows.map((shift) => ({ ...shift, status: normalizeShiftLifecycleStatus(shift.status) })));
      setAttendance(attendanceRows);
      setIncidents(incidentRows);
      setDailyLogs(dailyLogRows);
      setTimesheets(timesheetRows);
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Failed to load guard dashboard.');
      setLoadError(message);
      pushFeedback('error', 'Load failed', message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveProfile() {
    try {
      setSavingProfile(true);
      await updateMyGuard({
        fullName,
        phone,
        siaLicenseNumber: siaLicence,
        locationSharingEnabled: locationSharing,
        status: availabilityStatus,
      });
      pushFeedback('success', 'Profile updated', 'Your profile changes have been saved.');
      showAlert('Profile updated', 'Your guard profile has been saved successfully.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to save your profile.');
      pushFeedback('error', 'Profile update failed', message);
      showAlert('Profile update failed', message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleLogout() {
    logout();
    await clearStoredSession();
    setSignedOut(true);
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  }

  async function handleCheckIn(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkInShift({ shiftId });
      updateShiftStatusLocally(shiftId, 'in_progress');
      pushTimelineEvent(shiftId, 'Shift started', 'Checked in successfully.');
      await loadData();
      pushFeedback('success', 'Checked in', 'Your shift is now live.');
      showAlert('Checked in', 'Your shift is now marked as in progress.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to start this shift.');
      pushFeedback('error', 'Start shift failed', message);
      showAlert('Start shift failed', message);
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCheckOut(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkOutShift({ shiftId });
      updateShiftStatusLocally(shiftId, 'completed');
      pushTimelineEvent(shiftId, 'Shift ended', 'Checked out successfully.');
      await loadData();
      pushFeedback('success', 'Checked out', 'Your shift is now completed.');
      showAlert('Shift ended', 'Your shift has been checked out successfully.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to end this shift.');
      pushFeedback('error', 'End shift failed', message);
      showAlert('End shift failed', message);
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleRespondToShift(shiftId: number, response: 'accepted' | 'rejected') {
    try {
      setRespondingShiftId(shiftId);
      setOfferRespondAction(response);
      await respondToShift(shiftId, { response });
      updateShiftStatusLocally(shiftId, response === 'accepted' ? 'ready' : 'rejected');
      pushTimelineEvent(
        shiftId,
        response === 'accepted' ? 'Shift accepted' : 'Shift rejected',
        response === 'accepted' ? 'Shift is ready to start.' : 'Company will need to re-cover this shift.',
      );
      await loadData();
      setActiveTab(response === 'accepted' ? 'home' : 'offers');
      pushFeedback(
        'success',
        response === 'accepted' ? 'Offer accepted' : 'Offer rejected',
        response === 'accepted' ? 'This shift is now ready for you to start.' : 'The company can now re-cover this shift.',
      );
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to update this shift response.');
      const isStaleOffer =
        message.toLowerCase().includes('only offered shifts can be accepted or rejected') ||
        message.toLowerCase().includes('only offered shifts');

      await loadData();

      if (isStaleOffer) {
        const staleMessage = 'This shift is no longer available. It may have been cancelled or reassigned.';
        pushFeedback('info', 'Offer updated', staleMessage);
        showAlert('Offer updated', staleMessage);
      } else {
        pushFeedback('error', response === 'accepted' ? 'Accept failed' : 'Reject failed', message);
        showAlert(response === 'accepted' ? 'Accept failed' : 'Reject failed', message);
      }
    } finally {
      setRespondingShiftId(null);
      setOfferRespondAction(null);
    }
  }

  async function handleCreateLog(logType: DailyLog['logType']) {
    if (!selectedShift?.id || selectedShiftStatus !== 'in_progress') {
      pushFeedback('info', 'Log unavailable', 'Logs are only available during an active shift.');
      return;
    }
    if (!dailyLogMessage.trim()) {
      pushFeedback('error', 'Note required', 'Write a short update before saving the log.');
      return;
    }
    try {
      setSubmittingDailyLogType(logType);
      await createDailyLog({
        shiftId: selectedShift.id,
        message: dailyLogMessage.trim(),
        logType,
      });
      pushTimelineEvent(
        selectedShift.id,
        logType === 'check_call' ? 'Check call recorded' : 'Log added',
        dailyLogMessage.trim(),
      );
      setDailyLogMessage('');
      setQuickActionModal(null);
      await loadData();
      pushFeedback(
        'success',
        logType === 'check_call' ? 'Check call recorded' : 'Log added',
        logType === 'check_call' ? 'Your check call was recorded.' : 'Your log entry was saved.',
      );
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to save this log.');
      pushFeedback('error', 'Log failed', message);
      showAlert('Log failed', message);
    } finally {
      setSubmittingDailyLogType(null);
    }
  }

  async function handleCreateIncident() {
    if (!selectedShift?.id || selectedShiftStatus !== 'in_progress') {
      pushFeedback('info', 'Incident unavailable', 'Incident reporting is only available during an active shift.');
      return;
    }
    if (!incidentMessage.trim()) {
      pushFeedback('error', 'Description required', 'Add a short incident description before submitting.');
      return;
    }
    try {
      setSubmittingIncident(true);
      await createIncident({
        title: 'Guard incident',
        notes: incidentMessage.trim(),
        severity: 'medium',
        shiftId: selectedShift.id,
      });
      pushTimelineEvent(selectedShift.id, 'Incident raised', incidentMessage.trim());
      setIncidentMessage('');
      setQuickActionModal(null);
      await loadData();
      pushFeedback('success', 'Incident reported', 'The company can now see this incident.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to submit this incident.');
      pushFeedback('error', 'Incident failed', message);
      showAlert('Incident failed', message);
    } finally {
      setSubmittingIncident(false);
    }
  }

  async function handleCreateWelfareAlert() {
    if (!selectedShift?.id || selectedShiftStatus !== 'in_progress') {
      pushFeedback('info', 'Welfare unavailable', 'Welfare actions are only available during an active shift.');
      return;
    }
    if (!welfareMessage.trim()) {
      pushFeedback('error', 'Update required', 'Add a short welfare update before sending it.');
      return;
    }
    try {
      setSubmittingAlertType('welfare');
      await createSafetyAlert({
        shiftId: selectedShift.id,
        type: 'welfare',
        priority: 'high',
        message: welfareMessage.trim(),
      });
      pushTimelineEvent(selectedShift.id, 'Welfare update recorded', welfareMessage.trim());
      setWelfareMessage('');
      setQuickActionModal(null);
      await loadData();
      pushFeedback('success', 'Welfare update sent', 'The control room can now see your welfare update.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to send this welfare update.');
      pushFeedback('error', 'Welfare failed', message);
      showAlert('Welfare failed', message);
    } finally {
      setSubmittingAlertType(null);
    }
  }

  async function handleCreatePanicAlert() {
    if (!selectedShift?.id || selectedShiftStatus !== 'in_progress') {
      pushFeedback('info', 'Panic unavailable', 'Panic alerts are only available during an active shift.');
      return;
    }
    if (panicConfirmation.trim().toUpperCase() !== 'PANIC') {
      pushFeedback('error', 'Confirmation required', 'Type PANIC to confirm sending this alert.');
      return;
    }
    try {
      setSubmittingAlertType('panic');
      await createSafetyAlert({
        shiftId: selectedShift.id,
        type: 'panic',
        priority: 'critical',
        message: 'Emergency alert raised by guard from the mobile app.',
      });
      pushTimelineEvent(selectedShift.id, 'Panic alert sent', 'Emergency alert sent to control room.');
      setPanicConfirmation('');
      setQuickActionModal(null);
      await loadData();
      pushFeedback('success', 'Panic alert sent', 'Emergency alert sent to control room.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to send the panic alert.');
      pushFeedback('error', 'Panic failed', message);
      showAlert('Panic failed', message);
    } finally {
      setSubmittingAlertType(null);
    }
  }

  useEffect(() => {
    loadData();
  }, [user.guardId]);

  const attendanceByShiftId = useMemo(() => {
    const map: Record<number, { checkInAt?: string; checkOutAt?: string }> = {};
    attendance.forEach((event) => {
      const shiftId = event.shift?.id;
      if (!shiftId) return;
      const current = map[shiftId] || {};
      if (event.type === 'check-in') current.checkInAt = event.occurredAt;
      if (event.type === 'check-out') current.checkOutAt = event.occurredAt;
      map[shiftId] = current;
    });
    return map;
  }, [attendance]);

  const sortedShifts = useMemo(
    () => [...shifts].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [shifts],
  );

  const currentHomeShift = useMemo(() => {
    const inProgressShift = sortedShifts.find(
      (shift) => normalizeShiftLifecycleStatus(shift.status) === 'in_progress',
    );
    if (inProgressShift) return inProgressShift;

    const readyShift = sortedShifts.find(
      (shift) => normalizeShiftLifecycleStatus(shift.status) === 'ready',
    );
    if (readyShift) return readyShift;

    const offeredShift = sortedShifts.find(
      (shift) => normalizeShiftLifecycleStatus(shift.status) === 'offered',
    );
    if (offeredShift) return offeredShift;

    const mostRecentCompletedShift = [...sortedShifts]
      .filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'completed')
      .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime())[0];

    return mostRecentCompletedShift ?? null;
  }, [sortedShifts]);

  useEffect(() => {
    if (activeTab !== 'home' || !currentHomeShift) {
      return;
    }
    const status = normalizeShiftLifecycleStatus(currentHomeShift.status);
    if (status !== 'in_progress' && status !== 'ready') {
      return;
    }

    setLiveNow(Date.now());
    const intervalId = setInterval(() => {
      setLiveNow(Date.now());
    }, 60000);

    return () => clearInterval(intervalId);
  }, [activeTab, currentHomeShift?.id, currentHomeShift?.status]);

  useEffect(() => {
    if (!selectedShiftId && currentHomeShift?.id) {
      setSelectedShiftId(currentHomeShift.id);
      return;
    }
    if (selectedShiftId && !sortedShifts.some((shift) => shift.id === selectedShiftId)) {
      setSelectedShiftId(currentHomeShift?.id ?? null);
    }
  }, [currentHomeShift?.id, selectedShiftId, sortedShifts]);

  const selectedShift = sortedShifts.find((shift) => shift.id === selectedShiftId) || currentHomeShift || null;
  const selectedShiftStatus = normalizeShiftLifecycleStatus(selectedShift?.status);
  const selectedShiftAttendance = selectedShift?.id ? attendanceByShiftId[selectedShift.id] : undefined;
  const selectedShiftLogs = dailyLogs
    .filter((entry) => entry.shift?.id === selectedShift?.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const selectedShiftIncidents = incidents
    .filter((entry) => entry.shift?.id === selectedShift?.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const selectedShiftTimesheet = timesheets.find((timesheet) => timesheet.shiftId === selectedShift?.id) || null;
  const activeShift =
    sortedShifts.find((shift) => normalizeShiftLifecycleStatus(shift.status) === 'in_progress') || null;
  const shiftOffers = sortedShifts.filter((shift) => normalizeShiftLifecycleStatus(shift.status) === 'offered');
  const offerUrgencyClock = useMemo(() => Date.now(), [shiftOffers, activeTab]);
  const historyShifts = [...sortedShifts]
    .filter((shift) =>
      ['completed', 'missed', 'cancelled', 'rejected'].includes(normalizeShiftLifecycleStatus(shift.status)),
    )
    .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
  const selectedShiftTimeline = [
    ...localTimelineEvents.filter((event) => event.shiftId === selectedShift?.id),
    ...selectedShiftLogs.map((entry) => ({
      id: `log-${entry.id}`,
      shiftId: entry.shift?.id ?? 0,
      title: entry.logType === 'check_call' ? 'Check call recorded' : 'Log added',
      message: entry.message,
      occurredAt: entry.createdAt,
    })),
    ...selectedShiftIncidents.map((entry) => ({
      id: `incident-${entry.id}`,
      shiftId: entry.shift?.id ?? 0,
      title: 'Incident raised',
      message: entry.notes,
      occurredAt: entry.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 4);
  const currentHomeShiftAttendance = currentHomeShift?.id ? attendanceByShiftId[currentHomeShift.id] : undefined;
  const currentHomeDailyLogs = useMemo(
    () => dailyLogs.filter((entry) => entry.shift?.id === currentHomeShift?.id),
    [dailyLogs, currentHomeShift?.id],
  );
  const currentHomeTimesheet = useMemo(
    () => (currentHomeShift?.id ? timesheets.find((t) => t.shiftId === currentHomeShift.id) ?? null : null),
    [timesheets, currentHomeShift?.id],
  );
  const guardShiftPhase = useMemo(
    () => deriveGuardShiftPhase(liveNow, currentHomeShift, currentHomeDailyLogs, currentHomeTimesheet),
    [liveNow, currentHomeShift, currentHomeDailyLogs, currentHomeTimesheet],
  );

  function handleCurrentShiftPrimaryPress() {
    if (!currentHomeShift || guardShiftPhase === 'before_shift') return;
    if (guardShiftPhase === 'shift_ended' || guardShiftPhase === 'timesheet_pending') {
      setHistorySummaryShiftId(currentHomeShift.id);
      const status = normalizeShiftLifecycleStatus(currentHomeShift.status);
      if (status === 'completed') {
        setActiveTab('history');
      }
      return;
    }
    handlePrimaryHomeAction();
  }

  const currentHomeShiftTimeline = [
    ...localTimelineEvents.filter((event) => event.shiftId === currentHomeShift?.id),
    ...dailyLogs
      .filter((entry) => entry.shift?.id === currentHomeShift?.id)
      .map((entry) => ({
        id: `home-log-${entry.id}`,
        title: entry.logType === 'check_call' ? 'Check call recorded' : 'Log added',
        message: entry.message,
        occurredAt: entry.createdAt,
      })),
    ...incidents
      .filter((entry) => entry.shift?.id === currentHomeShift?.id)
      .map((entry) => ({
        id: `home-incident-${entry.id}`,
        title: 'Incident raised',
        message: entry.notes || entry.title,
        occurredAt: entry.createdAt,
      })),
    ...(currentHomeShiftAttendance?.checkInAt
      ? [
          {
            id: `home-check-in-${currentHomeShift?.id}`,
            title: 'Checked in',
            message: 'Shift started successfully.',
            occurredAt: currentHomeShiftAttendance.checkInAt,
          },
        ]
      : []),
    ...(currentHomeShiftAttendance?.checkOutAt
      ? [
          {
            id: `home-check-out-${currentHomeShift?.id}`,
            title: 'Checked out',
            message: 'Shift completed.',
            occurredAt: currentHomeShiftAttendance.checkOutAt,
          },
        ]
      : []),
  ]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 4);

  function renderHomeQuickActions() {
    return (
      <FeatureCard
        title="Live Shift Actions"
        subtitle="Use these during the active shift without leaving Home."
        style={[styles.quickActionCard, styles.guardLiveActionsCard]}
      >
        <View style={styles.quickActionGrid}>
          <Pressable style={styles.quickActionButton} onPress={() => setQuickActionModal('log')}>
            <Text style={styles.quickActionIcon}>LOG</Text>
            <Text style={styles.quickActionText}>Add Log</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={() => setQuickActionModal('checkCall')}>
            <Text style={styles.quickActionIcon}>CALL</Text>
            <Text style={styles.quickActionText}>Check Call</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={() => setQuickActionModal('incident')}>
            <Text style={styles.quickActionIcon}>INC</Text>
            <Text style={styles.quickActionText}>Incident</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={() => setQuickActionModal('welfare')}>
            <Text style={styles.quickActionIcon}>CARE</Text>
            <Text style={styles.quickActionText}>Welfare</Text>
          </Pressable>
          <Pressable
            style={[styles.quickActionButton, styles.quickActionDanger]}
            onPress={() => setQuickActionModal('panic')}
          >
            <Text style={styles.quickActionIcon}>SOS</Text>
            <Text style={styles.quickActionDangerText}>Panic</Text>
          </Pressable>
        </View>
      </FeatureCard>
    );
  }

  function handlePrimaryHomeAction() {
    if (!currentHomeShift) return;
    const status = normalizeShiftLifecycleStatus(currentHomeShift.status);
    if (status === 'offered') {
      setSelectedShiftId(currentHomeShift.id);
      setActiveTab('offers');
      return;
    }
    if (status === 'ready') {
      handleCheckIn(currentHomeShift.id);
      return;
    }
    if (status === 'in_progress') {
      handleCheckOut(currentHomeShift.id);
      return;
    }
    if (status === 'completed') {
      setHistorySummaryShiftId(currentHomeShift.id);
      setActiveTab('history');
    }
  }

  const historySummaryShift =
    historySummaryShiftId !== null
      ? historyShifts.find((shift) => shift.id === historySummaryShiftId) || null
      : null;
  const historySummaryAttendance = historySummaryShift?.id ? attendanceByShiftId[historySummaryShift.id] : undefined;
  const historySummaryTimesheet = timesheets.find((timesheet) => timesheet.shiftId === historySummaryShift?.id) || null;

  if (signedOut) {
    return (
      <View style={styles.signedOutScreen}>
        <Text style={styles.headerTitle}>Signed out</Text>
        <Text style={styles.helperText}>Your session has been cleared. Reopen the app or refresh to sign in again.</Text>
      </View>
    );
  }

  if (loading && shifts.length === 0) {
    return (
      <View style={styles.signedOutScreen}>
        <Text style={styles.headerTitle}>Loading...</Text>
        <Text style={styles.helperText}>Preparing your mobile shift workspace.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {activeTab === 'home'
            ? 'Current Shift'
            : activeTab === 'offers'
              ? 'Shift Offers'
              : activeTab === 'jobs'
                ? 'Jobs'
                : activeTab === 'history'
                  ? 'History'
                  : 'Profile'}
        </Text>
      </View>

      <View style={styles.mainArea}>

      {actionFeedback ? (
        <View
          style={[
            styles.feedbackBanner,
            actionFeedback.tone === 'success'
              ? styles.feedbackSuccess
              : actionFeedback.tone === 'error'
                ? styles.feedbackError
                : styles.feedbackInfo,
          ]}
        >
          <Text style={styles.feedbackTitle}>{actionFeedback.title}</Text>
          <Text style={styles.feedbackMessage}>{actionFeedback.message}</Text>
        </View>
      ) : null}

      {loadError ? (
        <View style={[styles.feedbackBanner, styles.feedbackError]}>
          <Text style={styles.feedbackTitle}>Action required</Text>
          <Text style={styles.feedbackMessage}>{loadError}</Text>
        </View>
      ) : null}

      <View style={styles.contentArea}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {activeTab === 'home' ? (
          <View style={styles.guardHomeRoot}>
            <FeatureCard
              title="Current Shift"
              subtitle={
                guardShiftPhase === 'no_shift'
                  ? 'Between shifts — your Home hub for the next booking or paperwork.'
                  : guardShiftPhase === 'offer_pending'
                    ? 'A company has offered you work — your next step is to decide.'
                    : guardShiftPhase === 'before_shift'
                      ? 'Upcoming shift — get on site; check-in opens at the booked start time.'
                      : guardShiftPhase === 'timesheet_pending'
                        ? 'Last completed shift still needs a timesheet step from you.'
                        : guardShiftPhase === 'shift_ended'
                          ? 'Most recent finished shift — recap or follow-up only.'
                          : 'The single most important shift on your device right now.'
              }
              style={styles.guardCurrentShiftCard}
            >
              {guardShiftPhase === 'no_shift' ? (
                <>
                  <View style={styles.guardSection}>
                    <Text style={styles.guardSectionLabel}>What to do now</Text>
                    <Text style={[styles.helperText, styles.guardSectionBody]}>
                      You are not on a live shift. Use Offers when work is proposed to you, History for finished shifts
                      and timesheets, and Jobs if you are looking for extra cover — same tabs as before.
                    </Text>
                  </View>
                  <View style={[styles.guardSection, styles.guardSectionMuted]}>
                    <Text style={styles.guardSectionLabel}>Quick links</Text>
                    <View style={styles.guardLinkStack}>
                      <Pressable
                        style={[styles.secondarySummaryButton, styles.guardOutlineLink]}
                        onPress={() => setActiveTab('offers')}
                      >
                        <Text style={styles.secondarySummaryButtonText}>Review shift offers</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.secondarySummaryButton, styles.guardOutlineLink]}
                        onPress={() => setActiveTab('history')}
                      >
                        <Text style={styles.secondarySummaryButtonText}>Past shifts & timesheets</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.secondarySummaryButton, styles.guardOutlineLink]}
                        onPress={() => setActiveTab('jobs')}
                      >
                        <Text style={styles.secondarySummaryButtonText}>Browse jobs</Text>
                      </Pressable>
                    </View>
                  </View>
                </>
              ) : currentHomeShift ? (
                (() => {
                  const statusNorm = normalizeShiftLifecycleStatus(currentHomeShift.status);
                  const primaryLabel = getGuardPhasePrimaryLabel(guardShiftPhase, currentHomeShift);
                  const primaryDisabled =
                    guardShiftPhase === 'before_shift' || attendanceBusyShiftId === currentHomeShift.id;
                  const attendanceBusy = attendanceBusyShiftId === currentHomeShift.id;
                  const secondariesDisabled = statusNorm !== 'in_progress' || attendanceBusy;
                  const primaryGuidance = getPrimaryActionGuidance(guardShiftPhase);
                  const secondaryHelper = getSecondaryActionsHelper(
                    guardShiftPhase,
                    statusNorm,
                    attendanceBusy,
                  );

                  return (
                    <>
                      <View style={styles.guardSection}>
                        <Text style={styles.guardSectionLabel}>Shift details</Text>
                        <View style={styles.cardTopRow}>
                          <View style={styles.flexGrow}>
                            <Text style={[styles.siteName, styles.guardSiteTitle]}>{currentHomeShift.siteName}</Text>
                            <View style={styles.guardTimeStack}>
                              <Text style={styles.shiftDate}>{formatDateLabel(currentHomeShift.start)}</Text>
                              <Text style={styles.shiftTime}>
                                {formatTimeLabel(currentHomeShift.start)} – {formatTimeLabel(currentHomeShift.end)}
                              </Text>
                            </View>
                            {statusNorm === 'in_progress' ? (
                              <View style={styles.liveBanner}>
                                <View style={styles.liveDot} />
                                <Text style={styles.liveBannerText}>LIVE</Text>
                              </View>
                            ) : null}
                          </View>
                          <ShiftStatusBadge status={currentHomeShift.status} />
                        </View>
                      </View>

                      <View style={[styles.guardSection, styles.guardSectionMuted]}>
                        <Text style={styles.guardSectionLabel}>Status</Text>
                        <Text
                          style={[
                            styles.helperLine,
                            styles.guardStatusText,
                            guardShiftPhase === 'check_call_overdue' ? styles.helperLineUrgent : null,
                            guardShiftPhase === 'check_call_due' ||
                            guardShiftPhase === 'shift_ending_soon' ||
                            guardShiftPhase === 'offer_pending' ||
                            guardShiftPhase === 'timesheet_pending'
                              ? styles.helperLineWarning
                              : null,
                          ]}
                        >
                          {getGuardPhaseStatusLine(guardShiftPhase, currentHomeShift, liveNow, currentHomeDailyLogs)}
                        </Text>
                      </View>

                      {normalizeShiftLifecycleStatus(currentHomeShift.status) === 'in_progress' ? (
                        <View style={[styles.guardSection, styles.guardSectionLive]}>
                          <Text style={styles.guardSectionLabel}>Live clock</Text>
                          <View style={[styles.liveStatusBlock, styles.guardLiveStatusFlush]}>
                            <View style={styles.liveStatusItem}>
                              <Text style={styles.liveStatusLabel}>Checked in</Text>
                              <Text style={styles.liveStatusValue}>
                                {currentHomeShiftAttendance?.checkInAt
                                  ? formatTimeLabel(currentHomeShiftAttendance.checkInAt)
                                  : 'Pending'}
                              </Text>
                            </View>
                            <View style={styles.liveStatusItem}>
                              <Text style={styles.liveStatusLabel}>Duration</Text>
                              <Text style={styles.liveStatusValue}>
                                {formatDurationLabel(
                                  currentHomeShiftAttendance?.checkInAt || currentHomeShift.start,
                                  currentHomeShiftAttendance?.checkOutAt,
                                  liveNow,
                                )}
                              </Text>
                            </View>
                          </View>
                        </View>
                      ) : null}

                      {primaryLabel ? (
                        <View style={[styles.guardSection, styles.guardSectionMainAction]}>
                          <Text style={styles.guardSectionLabel}>Main action</Text>
                          {primaryGuidance ? (
                            <Text style={[styles.helperText, styles.guardSectionBody]}>{primaryGuidance}</Text>
                          ) : null}
                          <Pressable
                            style={[
                              styles.primaryActionButton,
                              styles.guardHomeCta,
                              primaryDisabled && styles.buttonDisabled,
                            ]}
                            onPress={handleCurrentShiftPrimaryPress}
                            disabled={primaryDisabled}
                          >
                            <Text style={[styles.primaryActionText, styles.guardHomeCtaText]}>
                              {attendanceBusy
                                ? statusNorm === 'ready'
                                  ? 'Starting...'
                                  : 'Ending...'
                                : primaryLabel}
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}

                      {guardShiftPhase === 'timesheet_pending' ? (
                        <View style={[styles.guardSection, styles.guardSectionMuted]}>
                          <Text style={styles.guardSectionLabel}>Timesheet follow-up</Text>
                          <Text style={[styles.helperText, styles.guardSectionBody]}>
                            Payroll still needs this timesheet completed or updated. Open History to the timesheets
                            list — same place you have always used — then submit or fix what your company asked for.
                          </Text>
                          <Pressable
                            style={[styles.secondarySummaryButton, styles.guardOutlineLink]}
                            onPress={() => setActiveTab('history')}
                          >
                            <Text style={styles.secondarySummaryButtonText}>Open History & timesheets</Text>
                          </Pressable>
                        </View>
                      ) : null}

                      {guardShiftPhase === 'shift_ended' && statusNorm === 'completed' ? (
                        <View style={[styles.guardSection, styles.guardSectionMuted]}>
                          <Text style={styles.guardSectionLabel}>Paperwork & history</Text>
                          <Text style={[styles.helperText, styles.guardSectionBody]}>
                            History still holds payslips, older shifts, and company notes even when nothing is flagged
                            here.
                          </Text>
                          <Pressable
                            style={[styles.secondarySummaryButton, styles.guardOutlineLink]}
                            onPress={() => setActiveTab('history')}
                          >
                            <Text style={styles.secondarySummaryButtonText}>Open History</Text>
                          </Pressable>
                        </View>
                      ) : guardShiftPhase === 'shift_ended' ? (
                        <View style={[styles.guardSection, styles.guardSectionMuted]}>
                          <Text style={[styles.helperText, styles.guardSectionBody]}>
                            If this outcome looks wrong, use History for related records and contact your supervisor
                            outside the app.
                          </Text>
                        </View>
                      ) : null}

                      <View style={[styles.guardSection, styles.guardSectionMuted]}>
                        <Text style={styles.guardSectionLabel}>On-shift reporting</Text>
                        <View style={styles.guardSecondaryRow}>
                          <Pressable
                            style={[styles.guardSecondaryBtn, secondariesDisabled && styles.buttonDisabled]}
                            disabled={secondariesDisabled}
                            onPress={() => setQuickActionModal('incident')}
                          >
                            <Text style={styles.guardSecondaryBtnText}>Report incident</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.guardSecondaryBtn, secondariesDisabled && styles.buttonDisabled]}
                            disabled={secondariesDisabled}
                            onPress={() => setQuickActionModal('checkCall')}
                          >
                            <Text style={styles.guardSecondaryBtnText}>Record check call</Text>
                          </Pressable>
                        </View>
                        <Text style={styles.guardSecondaryHint}>{secondaryHelper}</Text>
                      </View>
                    </>
                  );
                })()
              ) : (
                <Text style={styles.helperText}>No active shift requiring action.</Text>
              )}
            </FeatureCard>

            {normalizeShiftLifecycleStatus(currentHomeShift?.status) === 'in_progress'
              ? renderHomeQuickActions()
              : null}
          </View>
        ) : null}

        {activeTab === 'home' &&
        currentHomeShift &&
        [
          'on_shift',
          'check_call_due',
          'check_call_overdue',
          'shift_ending_soon',
          'shift_ended',
          'timesheet_pending',
        ].includes(guardShiftPhase) ? (
          <FeatureCard
            title="Recent Activity"
            subtitle="Background log only — use Current Shift actions above first when something needs doing."
            style={styles.guardRecentActivityCard}
          >
            {currentHomeShiftTimeline.length === 0 ? (
              <Text style={styles.helperText}>No activity recorded yet.</Text>
            ) : (
              currentHomeShiftTimeline.map((entry) => (
                <View key={entry.id} style={styles.activityRow}>
                  <View style={styles.activityBullet} />
                  <View style={styles.flexGrow}>
                    <Text style={styles.activityTitle}>{entry.title}</Text>
                    <Text style={styles.metaText}>{entry.message}</Text>
                  </View>
                  <Text style={styles.activityTime}>{formatTimeLabel(entry.occurredAt)}</Text>
                </View>
              ))
            )}
          </FeatureCard>
        ) : null}

        {activeTab === 'offers' ? (
          <View style={styles.guardOffersRoot}>
            <View style={styles.historyHandoff}>
              <Text style={styles.historyHandoffLabel}>How this tab fits in</Text>
              <Text style={styles.historyHandoffText}>
                Invitations land here before they are on your roster. Home is for the shift you are booked on next;
                History is for finished work and timesheets. Decide offers here so control always knows yes or no.
              </Text>
            </View>
            <FeatureCard
              title="Shift offers"
              subtitle={
                shiftOffers.length === 0
                  ? 'Nothing on this list needs a tap — your roster is unchanged until a new invite arrives.'
                  : `${shiftOffers.length} open invitation${shiftOffers.length === 1 ? '' : 's'} — read each site and time, then accept or reject.`
              }
              style={styles.guardOffersCard}
            >
              {shiftOffers.length === 0 ? (
                <View style={styles.historyEmptyState}>
                  <Text style={styles.historyEmptyTitle}>No open offers</Text>
                  <Text style={styles.historyEmptyBody}>
                    When a company sends you a post, it will appear in the list under this heading. Until then you do not
                    need to do anything here — check Home for shifts you have already accepted, or History when you need
                    a recap or timesheet.
                  </Text>
                </View>
              ) : (
                <View style={styles.offersListSection}>
                  {shiftOffers.map((shift, index) => {
                    const offerBusy = respondingShiftId === shift.id;
                    const urgency = getOfferShiftUrgencyLine(shift.start, offerUrgencyClock);
                    return (
                      <View
                        key={shift.id}
                        style={[styles.offerCardShell, index === 0 ? styles.offerCardShellFirst : null]}
                      >
                        <View style={styles.offerCardHeader}>
                          <Text style={styles.offerSite}>{shift.siteName}</Text>
                          <Text style={styles.offerDate}>{formatDateLabel(shift.start)}</Text>
                          <Text style={styles.offerTime}>
                            {formatTimeLabel(shift.start)} – {formatTimeLabel(shift.end)}
                          </Text>
                          {urgency ? <Text style={styles.offerUrgency}>{urgency}</Text> : null}
                        </View>
                        <Text style={styles.offerNextStepHint}>
                          Accept if you will cover this shift. Reject if you cannot — the company can offer it elsewhere.
                        </Text>
                        <View style={styles.offerActionsColumn}>
                          <Pressable
                            style={[styles.offerAcceptBtn, offerBusy && styles.buttonDisabled]}
                            onPress={() => handleRespondToShift(shift.id, 'accepted')}
                            disabled={offerBusy}
                          >
                            <Text style={styles.offerAcceptBtnText}>
                              {offerBusy && offerRespondAction === 'accepted' ? 'Accepting…' : 'Accept shift'}
                            </Text>
                          </Pressable>
                          <Pressable
                            style={[styles.offerRejectBtn, offerBusy && styles.buttonDisabled]}
                            onPress={() => handleRespondToShift(shift.id, 'rejected')}
                            disabled={offerBusy}
                          >
                            <Text style={styles.offerRejectBtnText}>
                              {offerBusy && offerRespondAction === 'rejected' ? 'Rejecting…' : 'Reject offer'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </FeatureCard>
            <View style={styles.offersWorkflowFooter}>
              <Text style={styles.offersWorkflowFooterLabel}>
                {shiftOffers.length ? 'After you accept' : 'Where to go next'}
              </Text>
              <Text style={styles.offersWorkflowFooterText}>
                {shiftOffers.length
                  ? 'The shift moves to Home under Current Shift — check in from there when you are on site. Rejecting keeps you off the roster for that post.'
                  : 'Home shows your next booked or live shift. History holds finished shifts and the Timesheets list for pay — same tabs as before.'}
              </Text>
            </View>
          </View>
        ) : null}

        {activeTab === 'jobs' ? <JobsScreen user={user} /> : null}

        {activeTab === 'history' ? (
          <View style={styles.guardHistoryRoot}>
            <FeatureCard
              title="Past shifts"
              subtitle={
                historyShifts.length === 0
                  ? 'Finished work and quick recaps — timesheets for pay are in the next section.'
                  : `Tap a row for a recap (${historyShifts.length} on file). Hours and company status stay in Timesheets below.`
              }
              style={styles.guardHistoryPastCard}
            >
              {historyShifts.length === 0 ? (
                <View style={styles.historyEmptyState}>
                  <Text style={styles.historyEmptyTitle}>Nothing in your history yet</Text>
                  <Text style={styles.historyEmptyBody}>
                    When shifts finish, they appear here so you can reopen a short summary. Payroll hours and company
                    replies always live in Timesheets underneath — same data as before.
                  </Text>
                </View>
              ) : (
                historyShifts.map((shift, index) => (
                  <Pressable
                    key={shift.id}
                    style={[styles.historyPastRow, index === 0 ? styles.historyPastRowFirst : null]}
                    onPress={() => setHistorySummaryShiftId(shift.id)}
                  >
                    <View style={styles.flexGrow}>
                      <Text style={styles.historyPastSite}>{shift.siteName}</Text>
                      <Text style={styles.historyPastDate}>{formatDateLabel(shift.start)}</Text>
                      <Text style={styles.historyPastTime}>
                        {formatTimeLabel(shift.start)} – {formatTimeLabel(shift.end)}
                      </Text>
                    </View>
                    <ShiftStatusBadge status={shift.status} />
                  </Pressable>
                ))
              )}
            </FeatureCard>
            <View style={styles.historyHandoff}>
              <Text style={styles.historyHandoffLabel}>Timesheets</Text>
              <Text style={styles.historyHandoffText}>
                Claims, drafts, and company decisions for each shift are in this list — scroll down. Past shifts above
                are for recap only.
              </Text>
            </View>
            <View style={styles.guardHistoryTimesheetsWrap}>
              <GuardTimesheetsScreen
                timesheets={timesheets}
                attendance={attendance}
                onReload={loadData}
                onNotify={pushFeedback}
                onTimesheetSubmitted={(shiftId) => {
                  pushTimelineEvent(shiftId, 'Timesheet submitted', 'Hours sent for company review.');
                }}
              />
            </View>
          </View>
        ) : null}

        {activeTab === 'profile' ? (
          <View style={styles.guardProfileRoot}>
            <FeatureCard
              title="Your profile"
              subtitle="What your company and payroll see. Save when you change anything below."
              style={styles.guardProfileCard}
            >
              <View style={styles.guardProfileBody}>
                <View style={styles.guardProfileSection}>
                  <Text style={styles.guardSectionLabel}>Contact & identity</Text>
                  <View style={styles.guardProfileFields}>
                    <TextInput
                      style={[styles.input, styles.guardProfileInput]}
                      placeholder="Name"
                      value={fullName}
                      onChangeText={setFullName}
                    />
                    <TextInput
                      style={[styles.input, styles.guardProfileInput]}
                      placeholder="SIA details"
                      value={siaLicence}
                      onChangeText={setSiaLicence}
                    />
                    <TextInput
                      style={[styles.input, styles.guardProfileInput]}
                      placeholder="Contact details"
                      value={phone}
                      onChangeText={setPhone}
                    />
                  </View>
                </View>
                <View style={styles.guardProfileSection}>
                  <Text style={styles.guardSectionLabel}>Availability note</Text>
                  <TextInput
                    style={[styles.input, styles.guardProfileInput]}
                    placeholder="Availability"
                    value={availabilityStatus}
                    onChangeText={setAvailabilityStatus}
                  />
                </View>
                <View style={[styles.guardProfileSection, styles.guardProfileSwitchSection]}>
                  <Text style={styles.guardSectionLabel}>On shift</Text>
                  <View style={styles.switchRow}>
                    <View style={styles.flexGrow}>
                      <Text style={styles.guardProfileSwitchTitle}>Live location sharing</Text>
                      <Text style={styles.guardProfileSwitchHint}>Keep on while you are deployed.</Text>
                    </View>
                    <Switch value={locationSharing} onValueChange={setLocationSharing} />
                  </View>
                </View>
                <View style={styles.guardProfileActions}>
                  <Pressable
                    style={[
                      styles.primaryActionButton,
                      styles.guardHomeCta,
                      styles.guardProfileSaveCta,
                      savingProfile && styles.buttonDisabled,
                    ]}
                    onPress={handleSaveProfile}
                    disabled={savingProfile}
                  >
                    <Text style={[styles.primaryActionText, styles.guardHomeCtaText]}>
                      {savingProfile ? 'Saving...' : 'Save profile'}
                    </Text>
                  </Pressable>
                  <Pressable style={[styles.offerRejectBtn, styles.guardProfileLogoutBtn]} onPress={handleLogout}>
                    <Text style={styles.offerRejectBtnText}>Log out</Text>
                  </Pressable>
                </View>
              </View>
            </FeatureCard>
            <View style={styles.guardProfileBelowStack}>
              <GuardCompliancePanel />
              <GuardAvailabilityScreen />
            </View>
          </View>
        ) : null}
      </ScrollView>
      </View>

      <View style={styles.bottomNav}>
        {([
          ['home', 'Home'],
          ['offers', 'Offers'],
          ['jobs', 'Jobs'],
          ['history', 'History'],
          ['profile', 'Profile'],
        ] as Array<[GuardTab, string]>).map(([tab, label]) => (
          <Pressable
            key={tab}
            style={[styles.bottomNavItem, activeTab === tab && styles.bottomNavItemActive]}
            onPress={() => setActiveTab(tab)}
          >
            <View style={[styles.bottomNavIndicator, activeTab === tab && styles.bottomNavIndicatorActive]} />
            <Text style={[styles.bottomNavLabel, activeTab === tab && styles.bottomNavLabelActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      </View>

      {quickActionModal === 'log' ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Log</Text>
              <Pressable style={styles.modalCloseButton} onPress={() => setQuickActionModal(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <TextInput
              style={[styles.input, styles.modalInput]}
              placeholder="Write a short operational update"
              value={dailyLogMessage}
              onChangeText={setDailyLogMessage}
              multiline
            />
            <Pressable
              style={[styles.primaryActionButton, submittingDailyLogType !== null && styles.buttonDisabled]}
              onPress={() => handleCreateLog('observation')}
              disabled={submittingDailyLogType !== null}
            >
              <Text style={styles.primaryActionText}>{submittingDailyLogType ? 'Saving...' : 'Submit Log'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {quickActionModal === 'incident' ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Incident</Text>
              <Pressable style={styles.modalCloseButton} onPress={() => setQuickActionModal(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <TextInput
              style={[styles.input, styles.modalInput]}
              placeholder="Short incident description"
              value={incidentMessage}
              onChangeText={setIncidentMessage}
              multiline
            />
            <Pressable
              style={[styles.primaryActionButton, submittingIncident && styles.buttonDisabled]}
              onPress={handleCreateIncident}
              disabled={submittingIncident}
            >
              <Text style={styles.primaryActionText}>{submittingIncident ? 'Submitting...' : 'Submit Incident'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {quickActionModal === 'welfare' ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Welfare</Text>
              <Pressable style={styles.modalCloseButton} onPress={() => setQuickActionModal(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <TextInput
              style={[styles.input, styles.modalInput]}
              placeholder="Quick welfare update"
              value={welfareMessage}
              onChangeText={setWelfareMessage}
              multiline
            />
            <Pressable
              style={[styles.primaryActionButton, submittingAlertType !== null && styles.buttonDisabled]}
              onPress={handleCreateWelfareAlert}
              disabled={submittingAlertType !== null}
            >
              <Text style={styles.primaryActionText}>{submittingAlertType ? 'Sending...' : 'Send Welfare Update'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {quickActionModal === 'panic' ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Panic</Text>
              <Pressable style={styles.modalCloseButton} onPress={() => setQuickActionModal(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <Text style={styles.helperText}>Type PANIC to confirm you want to send an emergency alert.</Text>
            <TextInput
              style={styles.input}
              placeholder="Type PANIC"
              value={panicConfirmation}
              onChangeText={setPanicConfirmation}
              autoCapitalize="characters"
            />
            <Pressable
              style={[styles.panicConfirmButton, submittingAlertType !== null && styles.buttonDisabled]}
              onPress={handleCreatePanicAlert}
              disabled={submittingAlertType !== null}
            >
              <Text style={styles.panicConfirmButtonText}>{submittingAlertType ? 'Sending...' : 'Confirm Panic Alert'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {historySummaryShift ? (
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.summaryBackdropTapZone} onPress={() => setHistorySummaryShiftId(null)} />
          <View style={styles.summarySheetWrap}>
            <Pressable style={[styles.modalCard, styles.summarySheetCard]} onPress={() => {}}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Shift summary</Text>
                <Pressable style={styles.modalCloseButton} onPress={() => setHistorySummaryShiftId(null)}>
                  <Text style={styles.modalClose}>Close</Text>
                </Pressable>
              </View>
              <View style={styles.summaryHero}>
                <Text style={styles.summaryHeroSite}>{historySummaryShift.siteName}</Text>
                <Text style={styles.summaryHeroDate}>{formatDateLabel(historySummaryShift.start)}</Text>
                <Text style={styles.summaryHeroTime}>
                  {formatTimeLabel(historySummaryShift.start)} – {formatTimeLabel(historySummaryShift.end)}
                </Text>
                <ShiftStatusBadge status={historySummaryShift.status} />
              </View>
              <View style={styles.summaryGrid}>
                <View style={styles.summaryBlock}>
                  <Text style={styles.summaryLabel}>Booked on</Text>
                  <Text style={styles.summaryValue}>{formatSummaryAttendanceLine(historySummaryAttendance?.checkInAt)}</Text>
                </View>
                <View style={styles.summaryBlock}>
                  <Text style={styles.summaryLabel}>Booked off</Text>
                  <Text style={styles.summaryValue}>{formatSummaryAttendanceLine(historySummaryAttendance?.checkOutAt)}</Text>
                </View>
                <View style={styles.summaryBlock}>
                  <Text style={styles.summaryLabel}>Incidents</Text>
                  <Text style={styles.summaryValue}>
                    {incidents.filter((incident) => incident.shift?.id === historySummaryShift.id).length}
                  </Text>
                </View>
                {historySummaryTimesheet ? (
                  <View style={[styles.summaryBlock, styles.summaryTimesheetBlock]}>
                    <Text style={styles.summaryLabel}>Timesheet (payroll)</Text>
                    <Text style={styles.summaryValue}>
                      {Number(historySummaryTimesheet.hoursWorked) || 0} h claimed
                    </Text>
                    <Text style={styles.summaryValueSecondary}>
                      Status: {formatHistoryTimesheetStatus(historySummaryTimesheet.approvalStatus)}
                    </Text>
                    {(() => {
                      const ts = (historySummaryTimesheet.approvalStatus || '').trim().toLowerCase();
                      if (ts === 'draft' || ts === 'returned') {
                        return (
                          <Text style={styles.summaryInlineHint}>
                            Scroll to this shift in Timesheets below to change hours or notes and submit again.
                          </Text>
                        );
                      }
                      if (ts === 'submitted') {
                        return (
                          <Text style={styles.summaryInlineHint}>
                            Company is reviewing — watch the same row in Timesheets for updates.
                          </Text>
                        );
                      }
                      if (ts === 'approved') {
                        return (
                          <Text style={styles.summaryInlineHint}>
                            Accepted on record — full detail stays in Timesheets if you need it later.
                          </Text>
                        );
                      }
                      if (ts === 'rejected') {
                        return (
                          <Text style={styles.summaryInlineHint}>
                            Not accepted — read the note in Timesheets and speak with your supervisor if you are unsure.
                          </Text>
                        );
                      }
                      return null;
                    })()}
                  </View>
                ) : (
                  <View style={[styles.summaryBlock, styles.summaryTimesheetBlock]}>
                    <Text style={styles.summaryLabel}>Timesheet (payroll)</Text>
                    <Text style={styles.summaryValueSecondary}>
                      No timesheet row on file for this shift yet — check Timesheets below after payroll creates one.
                    </Text>
                  </View>
                )}
              </View>
              <Pressable style={styles.summaryDoneButton} onPress={() => setHistorySummaryShiftId(null)}>
                <Text style={styles.summaryDoneButtonText}>Close summary</Text>
              </Pressable>
            </Pressable>
          </View>
        </View>
      ) : null}

      {quickActionModal === 'checkCall' ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Check Call</Text>
              <Pressable style={styles.modalCloseButton} onPress={() => setQuickActionModal(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <TextInput
              style={[styles.input, styles.modalInput]}
              placeholder="Short check call update"
              value={dailyLogMessage}
              onChangeText={setDailyLogMessage}
              multiline
            />
            <Pressable
              style={[styles.primaryActionButton, submittingDailyLogType !== null && styles.buttonDisabled]}
              onPress={() => handleCreateLog('check_call')}
              disabled={submittingDailyLogType !== null}
            >
              <Text style={styles.primaryActionText}>{submittingDailyLogType ? 'Saving...' : 'Record Check Call'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F1F5F9' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  headerTitle: { fontSize: 24, fontWeight: '800', color: '#111827', letterSpacing: -0.3 },
  mainArea: { flex: 1 },
  contentArea: { flex: 1 },
  scrollView: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 28, flexGrow: 1 },
  signedOutScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#F1F5F9', gap: 8 },
  feedbackBanner: { marginHorizontal: 16, marginBottom: 10, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackInfo: { backgroundColor: '#DBEAFE' },
  feedbackTitle: { fontWeight: '700', color: '#111827' },
  feedbackMessage: { color: '#374151', lineHeight: 20 },
  guardHomeRoot: {
    width: '100%',
    gap: 14,
    paddingBottom: 4,
  },
  guardCurrentShiftCard: {
    borderRadius: 22,
    padding: 16,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  guardSection: {
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#EDF0F5',
  },
  guardSectionMuted: {
    backgroundColor: '#FAFAFA',
    borderColor: '#F0F0F0',
  },
  guardSectionMainAction: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: '#F1F5F9',
    borderColor: '#E2E8EF',
  },
  guardSectionLive: {
    borderLeftWidth: 3,
    borderLeftColor: '#22C55E',
    paddingLeft: 13,
  },
  guardSectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: '#64748B',
    textTransform: 'uppercase',
  },
  guardSectionBody: {
    fontSize: 14,
    lineHeight: 22,
    color: '#475569',
  },
  guardSiteTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  guardTimeStack: {
    gap: 4,
    marginTop: 4,
  },
  guardStatusText: {
    fontSize: 15,
    lineHeight: 23,
  },
  guardHomeCta: {
    marginTop: 4,
    minHeight: 54,
    borderRadius: 16,
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  guardHomeCtaText: {
    fontSize: 17,
    letterSpacing: 0.2,
  },
  guardSecondaryRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  guardSecondaryBtn: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  guardSecondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    textAlign: 'center',
  },
  guardSecondaryHint: {
    fontSize: 13,
    lineHeight: 20,
    color: '#64748B',
    marginTop: 8,
  },
  guardLinkStack: {
    gap: 10,
  },
  guardOutlineLink: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D1D5DB',
  },
  guardLiveStatusFlush: {
    marginTop: 2,
  },
  guardRecentActivityCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E8EAEE',
    padding: 16,
    backgroundColor: '#FBFBFD',
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  guardLiveActionsCard: {
    borderRadius: 22,
    marginTop: 2,
    overflow: 'hidden',
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  flexGrow: { flex: 1 },
  siteName: { fontSize: 26, lineHeight: 30, fontWeight: '800', color: '#111827' },
  shiftDate: { color: '#4B5563', fontWeight: '600' },
  shiftTime: { color: '#111827', fontSize: 16, fontWeight: '700' },
  helperLine: { color: '#4B5563', lineHeight: 20 },
  helperLineWarning: { color: '#B45309', fontWeight: '700' },
  helperLineUrgent: { color: '#B91C1C', fontWeight: '800' },
  helperText: { color: '#4B5563', lineHeight: 20 },
  liveBanner: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#DCFCE7',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#16A34A',
  },
  liveBannerText: {
    color: '#166534',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  statusBadge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  statusBadgeText: { fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  primaryActionButton: { backgroundColor: '#111827', borderRadius: 18, minHeight: 56, paddingHorizontal: 16, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  primaryActionText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  liveStatusBlock: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  liveStatusItem: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 4,
  },
  liveStatusLabel: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  liveStatusValue: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
  },
  secondarySummaryButton: {
    alignSelf: 'stretch',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondarySummaryButtonText: { color: '#111827', fontWeight: '700', fontSize: 15 },
  quickActionCard: {
    borderRadius: 20,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#111827',
    padding: 16,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  quickActionTitle: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
  quickActionSubtitle: { color: '#D1D5DB', lineHeight: 18 },
  quickActionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickActionButton: {
    width: '48%',
    minHeight: 94,
    borderRadius: 18,
    backgroundColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  quickActionDanger: { backgroundColor: '#991B1B', borderColor: '#B91C1C' },
  quickActionIcon: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  quickActionText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  quickActionDangerText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  guardOffersRoot: { width: '100%', gap: 12, paddingBottom: 8 },
  offersListSection: { gap: 0, paddingTop: 2 },
  offersWorkflowFooter: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 6,
  },
  offersWorkflowFooterLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  offersWorkflowFooterText: { fontSize: 13, lineHeight: 20, color: '#475569', fontWeight: '600' },
  guardOffersCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 16,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  offerCardShell: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E8ECF2',
    backgroundColor: '#F8FAFC',
    gap: 12,
  },
  offerCardShellFirst: { marginTop: 4 },
  offerCardHeader: { gap: 4 },
  offerSite: { fontSize: 17, fontWeight: '800', color: '#0F172A', lineHeight: 22, letterSpacing: -0.2 },
  offerDate: { fontSize: 14, fontWeight: '700', color: '#334155', marginTop: 2 },
  offerTime: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  offerUrgency: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    color: '#B45309',
  },
  offerNextStepHint: { fontSize: 13, lineHeight: 20, color: '#475569', fontWeight: '500' },
  offerActionsColumn: { gap: 10, marginTop: 2 },
  offerAcceptBtn: {
    alignSelf: 'stretch',
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F172A',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  offerAcceptBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16, letterSpacing: 0.2 },
  offerRejectBtn: {
    alignSelf: 'stretch',
    minHeight: 46,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  offerRejectBtnText: { color: '#475569', fontWeight: '700', fontSize: 14 },
  secondaryActionButton: { alignSelf: 'flex-start', backgroundColor: '#E5E7EB', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryActionButtonText: { color: '#111827', fontWeight: '700' },
  cardTitle: { color: '#111827', fontWeight: '700', fontSize: 16 },
  metaText: { color: '#6B7280', fontSize: 13, lineHeight: 18 },
  activityRow: {
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    paddingTop: 12,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  activityBullet: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#16A34A',
    marginTop: 5,
  },
  activityTitle: { color: '#111827', fontWeight: '700' },
  activityTime: { color: '#6B7280', fontSize: 12, fontWeight: '700' },
  guardHistoryRoot: { width: '100%', gap: 12, paddingBottom: 8 },
  guardHistoryPastCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 16,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  guardProfileRoot: { width: '100%', gap: 12, paddingBottom: 8 },
  guardProfileCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: 16,
    marginBottom: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  guardProfileBody: { gap: 18, marginTop: 4 },
  guardProfileSection: { gap: 8 },
  guardProfileFields: { gap: 10 },
  guardProfileInput: {
    minHeight: 48,
    borderRadius: 14,
  },
  guardProfileSwitchSection: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#EDF0F5',
    gap: 10,
  },
  guardProfileSwitchTitle: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  guardProfileSwitchHint: { fontSize: 13, lineHeight: 19, color: '#64748B', marginTop: 2 },
  guardProfileActions: { gap: 10, marginTop: 4 },
  guardProfileSaveCta: { marginTop: 0 },
  guardProfileLogoutBtn: { minHeight: 48 },
  guardProfileBelowStack: { gap: 12, width: '100%' },
  historyEmptyState: { gap: 8, paddingVertical: 8 },
  historyEmptyTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  historyEmptyBody: { fontSize: 14, lineHeight: 22, color: '#475569' },
  historyPastRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    marginHorizontal: -4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#EEF2F7',
    backgroundColor: '#F8FAFC',
    marginTop: 10,
  },
  historyPastRowFirst: { marginTop: 4 },
  historyPastSite: { fontSize: 17, fontWeight: '800', color: '#0F172A', lineHeight: 22, letterSpacing: -0.2 },
  historyPastDate: { fontSize: 14, fontWeight: '700', color: '#334155', marginTop: 4 },
  historyPastTime: { fontSize: 13, fontWeight: '600', color: '#64748B', marginTop: 2 },
  historyHandoff: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#DBEAFE',
    gap: 6,
  },
  historyHandoffLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1D4ED8',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  historyHandoffText: { fontSize: 13, lineHeight: 20, color: '#1E3A8A', fontWeight: '600' },
  guardHistoryTimesheetsWrap: { marginTop: 2 },
  summaryHero: { gap: 8, marginBottom: 8 },
  summaryHeroSite: { fontSize: 20, fontWeight: '800', color: '#0F172A', lineHeight: 26, letterSpacing: -0.3 },
  summaryHeroDate: { fontSize: 15, fontWeight: '700', color: '#334155' },
  summaryHeroTime: { fontSize: 14, fontWeight: '600', color: '#64748B' },
  summaryGrid: { gap: 10 },
  summaryValueSecondary: { fontSize: 14, lineHeight: 21, color: '#475569', fontWeight: '600' },
  summaryInlineHint: { fontSize: 13, lineHeight: 20, color: '#64748B', marginTop: 8, fontWeight: '500' },
  summaryTimesheetBlock: {
    borderLeftWidth: 3,
    borderLeftColor: '#2563EB',
    paddingLeft: 12,
    backgroundColor: '#F8FAFC',
  },
  listCard: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 12, gap: 8 },
  applicationStatusBadge: {
    borderRadius: 999,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  applicationStatus: { color: '#1D4ED8', fontWeight: '700', textTransform: 'capitalize', fontSize: 12 },
  input: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#FFFFFF', color: '#111827' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  logoutButton: { borderRadius: 16, borderWidth: 1, borderColor: '#D1D5DB', minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  logoutButtonText: { color: '#111827', fontWeight: '700' },
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#D1D5DB',
    paddingBottom: 18,
    paddingTop: 8,
    paddingHorizontal: 8,
    shadowColor: '#111827',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 6,
  },
  bottomNavItem: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 56, gap: 6 },
  bottomNavItemActive: { opacity: 1 },
  bottomNavIndicator: {
    width: 28,
    height: 3,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  bottomNavIndicatorActive: {
    backgroundColor: '#111827',
  },
  bottomNavLabel: { color: '#6B7280', fontWeight: '700', fontSize: 13 },
  bottomNavLabelActive: { color: '#111827' },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(17,24,39,0.45)',
    justifyContent: 'flex-end',
    padding: 16,
    zIndex: 20,
  },
  summaryBackdropTapZone: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  summarySheetWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 18,
    gap: 12,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  summarySheetCard: {
    maxHeight: '78%',
  },
  summaryDoneButton: {
    marginTop: 8,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryDoneButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#111827' },
  modalCloseButton: {
    minHeight: 36,
    minWidth: 64,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
  },
  modalClose: { color: '#2563EB', fontWeight: '700' },
  modalInput: { minHeight: 120, textAlignVertical: 'top' },
  panicConfirmButton: { backgroundColor: '#991B1B', borderRadius: 18, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  panicConfirmButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  summaryBlock: { borderRadius: 14, backgroundColor: '#F9FAFB', padding: 12, gap: 6 },
  summaryLabel: { color: '#6B7280', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  summaryValue: { color: '#111827', fontWeight: '700', fontSize: 15, lineHeight: 22 },
  timelineItem: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 10, gap: 4 },
  buttonDisabled: { opacity: 0.7 },
});
