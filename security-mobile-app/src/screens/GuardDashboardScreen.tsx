import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  checkInShift,
  checkOutShift,
  createDailyLog,
  createIncident,
  createJobApplication,
  createSafetyAlert,
  formatApiErrorMessage,
  getMyGuard,
  listJobApplications,
  listJobs,
  listMyAttendance,
  listMyDailyLogs,
  listMyIncidents,
  listMyShifts,
  listMyTimesheets,
  logout,
  respondToShift,
  submitTimesheet,
  updateMyGuard,
} from '../services/api';
import { clearStoredSession } from '../services/session';
import {
  AttendanceEvent,
  AuthUser,
  DailyLog,
  Incident,
  Job,
  JobApplication,
  Shift,
  Timesheet,
} from '../types/models';

interface GuardDashboardScreenProps {
  user: AuthUser;
}

type GuardTab = 'home' | 'offers' | 'jobs' | 'history' | 'profile';
type QuickActionModal = 'log' | 'incident' | 'welfare' | 'panic' | null;

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

function formatDateLabel(value?: string | null) {
  if (!value) return 'TBC';
  return new Date(value).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatTimeLabel(value?: string | null) {
  if (!value) return 'TBC';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
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
  const [submittingTimesheetId, setSubmittingTimesheetId] = useState<number | null>(null);
  const [respondingShiftId, setRespondingShiftId] = useState<number | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<number | null>(null);
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
      const [myGuard, shiftRows, jobRows, applicationRows, attendanceRows, incidentRows, dailyLogRows, timesheetRows] =
        await Promise.all([
          getMyGuard(),
          listMyShifts(),
          listJobs(),
          listJobApplications(),
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
      setJobs(jobRows.filter((job) => (job.status || '').trim().toLowerCase() === 'open'));
      setApplications(applicationRows);
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
      pushFeedback('error', response === 'accepted' ? 'Accept failed' : 'Reject failed', message);
      showAlert(response === 'accepted' ? 'Accept failed' : 'Reject failed', message);
    } finally {
      setRespondingShiftId(null);
    }
  }

  async function handleApplyToJob(jobId: number) {
    try {
      setApplyingJobId(jobId);
      await createJobApplication({ jobId });
      await loadData();
      pushFeedback('success', 'Application sent', 'Your application has been submitted.');
      showAlert('Application sent', 'Your application has been submitted successfully.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to apply for this job.');
      pushFeedback('error', 'Application failed', message);
      showAlert('Application failed', message);
    } finally {
      setApplyingJobId(null);
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

  async function handleSubmitTimesheet(timesheet: Timesheet) {
    try {
      setSubmittingTimesheetId(timesheet.id);
      await submitTimesheet(timesheet.id, { hoursWorked: timesheet.hoursWorked });
      if (timesheet.shiftId) {
        pushTimelineEvent(timesheet.shiftId, 'Timesheet submitted', 'Hours sent for company review.');
      }
      await loadData();
      pushFeedback('success', 'Timesheet submitted', 'Your hours were submitted successfully.');
    } catch (error) {
      const message = formatApiErrorMessage(error, 'Unable to submit this timesheet.');
      pushFeedback('error', 'Timesheet failed', message);
      showAlert('Timesheet failed', message);
    } finally {
      setSubmittingTimesheetId(null);
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
    if (normalizeShiftLifecycleStatus(currentHomeShift?.status) !== 'in_progress') {
      return;
    }

    setLiveNow(Date.now());
    const intervalId = setInterval(() => {
      setLiveNow(Date.now());
    }, 60000);

    return () => clearInterval(intervalId);
  }, [currentHomeShift?.id, currentHomeShift?.status]);

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
  const myApplications = applications
    .filter((application) => application.guardId === user.guardId)
    .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime());
  const openJobs = jobs.filter(
    (job) => !myApplications.some((application) => application.jobId === job.id),
  );
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
        style={styles.quickActionCard}
      >
        <View style={styles.quickActionGrid}>
          <Pressable style={styles.quickActionButton} onPress={() => setQuickActionModal('log')}>
            <Text style={styles.quickActionIcon}>LOG</Text>
            <Text style={styles.quickActionText}>Add Log</Text>
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

  function getHelperLine(shift: Shift | null) {
    if (!shift) return 'No urgent actions.';
    const status = normalizeShiftLifecycleStatus(shift.status);
    if (status === 'offered') return 'Waiting for your response.';
    if (status === 'ready') return 'Ready to start.';
    if (status === 'in_progress') {
      if (!shift.checkCallIntervalMinutes) return 'Shift is live.';
      const lastCheckCall = dailyLogs
        .filter((entry) => entry.shift?.id === shift.id && entry.logType === 'check_call')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      const nextDueAt = new Date(
        (lastCheckCall ? new Date(lastCheckCall.createdAt) : new Date(shift.start)).getTime() +
          shift.checkCallIntervalMinutes * 60 * 1000,
      );
      const minutes = Math.max(0, Math.round((nextDueAt.getTime() - Date.now()) / 60000));
      if (minutes <= 0) return 'Check call overdue';
      if (minutes <= 10) return `Check call due in ${minutes} min.`;
      return 'All tasks up to date.';
    }
    if (status === 'completed') return 'No urgent actions.';
    if (status === 'missed') return 'Shift missed.';
    if (status === 'rejected') return 'Offer declined.';
    if (status === 'cancelled') return 'Shift cancelled.';
    return 'No urgent actions.';
  }

  function getReadOnlyHomeActionLabel(status?: string | null) {
    const normalized = normalizeShiftLifecycleStatus(status);
    if (normalized === 'completed') return 'View Summary';
    if (normalized === 'missed') return 'Missed Shift';
    if (normalized === 'rejected') return 'Offer Declined';
    if (normalized === 'cancelled') return 'Shift Cancelled';
    return 'View Shift';
  }

  function getTimesheetSubmissionState(timesheet: Timesheet) {
    const hours = Number(timesheet.hoursWorked);
    const hasValidHours = Number.isFinite(hours) && hours > 0;
    const attendanceState = attendanceByShiftId[timesheet.shiftId];
    const hasCheckedOut = Boolean(attendanceState?.checkOutAt || timesheet.actualCheckOutAt);

    if (!hasCheckedOut) {
      return { canSubmit: false, reason: 'Timesheet available after shift end' };
    }

    if (!hasValidHours) {
      return { canSubmit: false, reason: 'Worked hours not ready yet' };
    }

    return { canSubmit: true, reason: '' };
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
            ? 'My Shift'
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
          <>
            <FeatureCard
              title="My Shift"
              subtitle={currentHomeShift ? 'The single most important shift on your device right now.' : 'No active shift requiring action.'}
              style={styles.primaryCard}
            >
              {currentHomeShift ? (
                <>
                  <View style={styles.cardTopRow}>
                    <View style={styles.flexGrow}>
                      <Text style={styles.siteName}>{currentHomeShift.siteName}</Text>
                      <Text style={styles.shiftDate}>{formatDateLabel(currentHomeShift.start)}</Text>
                      <Text style={styles.shiftTime}>
                        {formatTimeLabel(currentHomeShift.start)} - {formatTimeLabel(currentHomeShift.end)}
                      </Text>
                      {normalizeShiftLifecycleStatus(currentHomeShift.status) === 'in_progress' ? (
                        <View style={styles.liveBanner}>
                          <View style={styles.liveDot} />
                          <Text style={styles.liveBannerText}>LIVE</Text>
                        </View>
                      ) : null}
                    </View>
                    <ShiftStatusBadge status={currentHomeShift.status} />
                  </View>
                  <Text
                    style={[
                      styles.helperLine,
                      normalizeShiftLifecycleStatus(currentHomeShift.status) === 'in_progress' &&
                      getHelperLine(currentHomeShift).includes('overdue')
                        ? styles.helperLineUrgent
                        : normalizeShiftLifecycleStatus(currentHomeShift.status) === 'in_progress' &&
                            getHelperLine(currentHomeShift).includes('due in')
                          ? styles.helperLineWarning
                          : null,
                    ]}
                  >
                    {getHelperLine(currentHomeShift)}
                  </Text>
                  {getPrimaryActionLabel(currentHomeShift.status) ? (
                    <Pressable
                      style={[styles.primaryActionButton, attendanceBusyShiftId === currentHomeShift.id && styles.buttonDisabled]}
                      onPress={handlePrimaryHomeAction}
                      disabled={attendanceBusyShiftId === currentHomeShift.id}
                    >
                      <Text style={styles.primaryActionText}>
                        {attendanceBusyShiftId === currentHomeShift.id
                          ? normalizeShiftLifecycleStatus(currentHomeShift.status) === 'ready'
                            ? 'Starting...'
                            : 'Ending...'
                          : getPrimaryActionLabel(currentHomeShift.status)}
                      </Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={styles.secondarySummaryButton}
                      onPress={() => {
                        setHistorySummaryShiftId(currentHomeShift.id);
                        if (normalizeShiftLifecycleStatus(currentHomeShift.status) === 'completed') {
                          setActiveTab('history');
                        }
                      }}
                    >
                      <Text style={styles.secondarySummaryButtonText}>
                        {getReadOnlyHomeActionLabel(currentHomeShift.status)}
                      </Text>
                    </Pressable>
                  )}

                  {normalizeShiftLifecycleStatus(currentHomeShift.status) === 'in_progress' ? (
                    <View style={styles.liveStatusBlock}>
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
                  ) : null}
                </>
              ) : (
                <Text style={styles.helperText}>No active shift requiring action.</Text>
              )}
            </FeatureCard>

            {normalizeShiftLifecycleStatus(currentHomeShift?.status) === 'in_progress'
              ? renderHomeQuickActions()
              : null}
          </>
        ) : null}

        {activeTab === 'home' && normalizeShiftLifecycleStatus(currentHomeShift?.status) === 'in_progress' ? (
          <FeatureCard
            title="Recent Activity"
            subtitle="Latest updates for this live shift."
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
          <FeatureCard title="Shift Offers" subtitle={shiftOffers.length ? 'Review each offer without live-shift clutter.' : 'No shift offers right now'}>
            {shiftOffers.length === 0 ? (
              <Text style={styles.helperText}>No shift offers right now.</Text>
            ) : (
              shiftOffers.map((shift) => (
                <View key={shift.id} style={styles.offerCard}>
                  <View style={styles.cardTopRow}>
                    <View style={styles.flexGrow}>
                      <Text style={styles.cardTitle}>{shift.siteName}</Text>
                      <Text style={styles.metaText}>{formatDateLabel(shift.start)}</Text>
                      <Text style={styles.metaText}>
                        {formatTimeLabel(shift.start)} - {formatTimeLabel(shift.end)}
                      </Text>
                    </View>
                    <ShiftStatusBadge status={shift.status} />
                  </View>
                  <View style={styles.offerActionRow}>
                    <Pressable
                      style={[styles.primaryHalfButton, respondingShiftId === shift.id && styles.buttonDisabled]}
                      onPress={() => handleRespondToShift(shift.id, 'accepted')}
                      disabled={respondingShiftId === shift.id}
                    >
                      <Text style={styles.primaryHalfButtonText}>{respondingShiftId === shift.id ? 'Updating...' : 'Accept'}</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryHalfButton, respondingShiftId === shift.id && styles.buttonDisabled]}
                      onPress={() => handleRespondToShift(shift.id, 'rejected')}
                      disabled={respondingShiftId === shift.id}
                    >
                      <Text style={styles.secondaryHalfButtonText}>{respondingShiftId === shift.id ? 'Updating...' : 'Reject'}</Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </FeatureCard>
        ) : null}

        {activeTab === 'jobs' ? (
          <>
            <FeatureCard title="Open Jobs" subtitle={openJobs.length ? 'Available jobs you can apply for.' : 'No open jobs right now'}>
              {openJobs.length === 0 ? (
                <Text style={styles.helperText}>No open jobs right now.</Text>
              ) : (
                openJobs.map((job) => (
                  <View key={job.id} style={styles.listCard}>
                    <Text style={styles.cardTitle}>{job.title}</Text>
                    <Text style={styles.metaText}>{job.site?.name || job.company?.name || 'Location pending'}</Text>
                    <Text style={styles.metaText} numberOfLines={2}>
                      {job.description?.trim() || 'Shift details available when you open the job.'}
                    </Text>
                    <Pressable
                      style={[styles.secondaryActionButton, applyingJobId === job.id && styles.buttonDisabled]}
                      onPress={() => handleApplyToJob(job.id)}
                      disabled={applyingJobId === job.id}
                    >
                      <Text style={styles.secondaryActionButtonText}>
                        {applyingJobId === job.id ? 'Applying...' : 'Apply'}
                      </Text>
                    </Pressable>
                  </View>
                ))
              )}
            </FeatureCard>

            <FeatureCard
              title="Applied Jobs"
              subtitle={
                myApplications.length
                  ? `${myApplications.length} application${myApplications.length === 1 ? '' : 's'} submitted`
                  : 'No applications yet'
              }
            >
              {myApplications.length === 0 ? (
                <Text style={styles.helperText}>Your submitted applications will appear here.</Text>
              ) : (
                myApplications.map((application) => (
                  <View key={application.id} style={styles.simpleRow}>
                    <View style={styles.flexGrow}>
                      <Text style={styles.cardTitle}>{application.job?.title || `Job #${application.jobId}`}</Text>
                      <Text style={styles.metaText}>
                        {application.job?.site?.name || application.job?.company?.name || 'Location pending'}
                      </Text>
                    </View>
                    <View style={styles.applicationStatusBadge}>
                      <Text style={styles.applicationStatus}>{application.status}</Text>
                    </View>
                  </View>
                ))
              )}
            </FeatureCard>
          </>
        ) : null}

        {activeTab === 'history' ? (
          <>
            <FeatureCard title="Past Shifts" subtitle={`${historyShifts.length} past shifts`}>
              {historyShifts.length === 0 ? (
                <Text style={styles.helperText}>Past shifts will appear here.</Text>
              ) : (
                historyShifts.map((shift) => (
                  <Pressable key={shift.id} style={styles.simpleRow} onPress={() => setHistorySummaryShiftId(shift.id)}>
                    <View style={styles.flexGrow}>
                      <Text style={styles.cardTitle}>{shift.siteName}</Text>
                      <Text style={styles.metaText}>
                        {formatDateLabel(shift.start)} - {formatTimeLabel(shift.start)} - {formatTimeLabel(shift.end)}
                      </Text>
                    </View>
                    <ShiftStatusBadge status={shift.status} />
                  </Pressable>
                ))
              )}
            </FeatureCard>
            <FeatureCard title="Timesheets" subtitle={`${timesheets.length} recorded`}>
              {timesheets.length === 0 ? (
                <Text style={styles.helperText}>Timesheets will appear here once shifts are completed.</Text>
              ) : (
                timesheets.map((timesheet) => (
                  <View key={timesheet.id} style={styles.listCard}>
                    <Text style={styles.cardTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shiftId}`}</Text>
                    <Text style={styles.metaText}>{timesheet.hoursWorked} hours</Text>
                    <Text style={styles.metaText}>Status: {timesheet.approvalStatus}</Text>
                    {timesheet.approvalStatus === 'draft' ? (() => {
                      const submissionState = getTimesheetSubmissionState(timesheet);
                      return (
                        <>
                          <Pressable
                            style={[
                              styles.secondaryActionButton,
                              (!submissionState.canSubmit || submittingTimesheetId === timesheet.id) && styles.buttonDisabled,
                            ]}
                            onPress={() => handleSubmitTimesheet(timesheet)}
                            disabled={!submissionState.canSubmit || submittingTimesheetId === timesheet.id}
                          >
                            <Text style={styles.secondaryActionButtonText}>
                              {submittingTimesheetId === timesheet.id ? 'Submitting...' : 'Submit Timesheet'}
                            </Text>
                          </Pressable>
                          {!submissionState.canSubmit ? (
                            <Text style={styles.timesheetHint}>{submissionState.reason}</Text>
                          ) : null}
                        </>
                      );
                    })() : null}
                  </View>
                ))
              )}
            </FeatureCard>
          </>
        ) : null}

        {activeTab === 'profile' ? (
          <>
            <FeatureCard title="Profile" subtitle="Personal and setup details only.">
              <TextInput style={styles.input} placeholder="Name" value={fullName} onChangeText={setFullName} />
              <TextInput style={styles.input} placeholder="SIA details" value={siaLicence} onChangeText={setSiaLicence} />
              <TextInput style={styles.input} placeholder="Contact details" value={phone} onChangeText={setPhone} />
              <TextInput
                style={styles.input}
                placeholder="Availability"
                value={availabilityStatus}
                onChangeText={setAvailabilityStatus}
              />
              <View style={styles.switchRow}>
                <View style={styles.flexGrow}>
                  <Text style={styles.cardTitle}>Live location sharing</Text>
                  <Text style={styles.metaText}>Keep on while actively deployed.</Text>
                </View>
                <Switch value={locationSharing} onValueChange={setLocationSharing} />
              </View>
              <Pressable
                style={[styles.primaryActionButton, savingProfile && styles.buttonDisabled]}
                onPress={handleSaveProfile}
                disabled={savingProfile}
              >
                <Text style={styles.primaryActionText}>{savingProfile ? 'Saving...' : 'Save Profile'}</Text>
              </Pressable>
              <Pressable style={styles.logoutButton} onPress={handleLogout}>
                <Text style={styles.logoutButtonText}>Logout</Text>
              </Pressable>
            </FeatureCard>
          </>
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
                <Text style={styles.modalTitle}>Shift Summary</Text>
                <Pressable style={styles.modalCloseButton} onPress={() => setHistorySummaryShiftId(null)}>
                  <Text style={styles.modalClose}>Close</Text>
                </Pressable>
              </View>
              <Text style={styles.cardTitle}>{historySummaryShift.siteName}</Text>
              <Text style={styles.metaText}>
                {formatDateLabel(historySummaryShift.start)} - {formatTimeLabel(historySummaryShift.start)} - {formatTimeLabel(historySummaryShift.end)}
              </Text>
              <ShiftStatusBadge status={historySummaryShift.status} />
              <View style={styles.summaryBlock}>
                <Text style={styles.summaryLabel}>Booked on</Text>
                <Text style={styles.summaryValue}>
                  {historySummaryAttendance?.checkInAt ? new Date(historySummaryAttendance.checkInAt).toLocaleString() : 'Pending'}
                </Text>
              </View>
              <View style={styles.summaryBlock}>
                <Text style={styles.summaryLabel}>Booked off</Text>
                <Text style={styles.summaryValue}>
                  {historySummaryAttendance?.checkOutAt ? new Date(historySummaryAttendance.checkOutAt).toLocaleString() : 'Pending'}
                </Text>
              </View>
              <View style={styles.summaryBlock}>
                <Text style={styles.summaryLabel}>Incidents</Text>
                <Text style={styles.summaryValue}>
                  {incidents.filter((incident) => incident.shift?.id === historySummaryShift.id).length}
                </Text>
              </View>
              {historySummaryTimesheet ? (
                <View style={styles.summaryBlock}>
                  <Text style={styles.summaryLabel}>Timesheet</Text>
                  <Text style={styles.summaryValue}>
                    {historySummaryTimesheet.hoursWorked} hours - {historySummaryTimesheet.approvalStatus}
                  </Text>
                </View>
              ) : null}
              <Pressable style={styles.summaryDoneButton} onPress={() => setHistorySummaryShiftId(null)}>
                <Text style={styles.summaryDoneButtonText}>Close Summary</Text>
              </Pressable>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F4F6' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { fontSize: 28, fontWeight: '800', color: '#111827' },
  mainArea: { flex: 1 },
  contentArea: { flex: 1 },
  scrollView: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 20, flexGrow: 1 },
  signedOutScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#F3F4F6', gap: 8 },
  feedbackBanner: { marginHorizontal: 16, marginBottom: 10, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  feedbackSuccess: { backgroundColor: '#DCFCE7' },
  feedbackError: { backgroundColor: '#FEE2E2' },
  feedbackInfo: { backgroundColor: '#DBEAFE' },
  feedbackTitle: { fontWeight: '700', color: '#111827' },
  feedbackMessage: { color: '#374151', lineHeight: 20 },
  primaryCard: { borderRadius: 20, padding: 18 },
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
  offerCard: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 12, gap: 12 },
  offerActionRow: { flexDirection: 'row', gap: 10 },
  primaryHalfButton: { flex: 1, backgroundColor: '#111827', borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  primaryHalfButtonText: { color: '#FFFFFF', fontWeight: '800' },
  secondaryHalfButton: { flex: 1, backgroundColor: '#E5E7EB', borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  secondaryHalfButtonText: { color: '#111827', fontWeight: '700' },
  secondaryActionButton: { alignSelf: 'flex-start', backgroundColor: '#E5E7EB', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryActionButtonText: { color: '#111827', fontWeight: '700' },
  timesheetHint: { color: '#6B7280', fontSize: 12, lineHeight: 18 },
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
  simpleRow: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 12, paddingBottom: 2, flexDirection: 'row', alignItems: 'center', gap: 12 },
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
  summaryBlock: { borderRadius: 14, backgroundColor: '#F9FAFB', padding: 12, gap: 4 },
  summaryLabel: { color: '#6B7280', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  summaryValue: { color: '#111827', fontWeight: '700' },
  timelineWrap: { gap: 8 },
  timelineItem: { borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 10, gap: 4 },
  buttonDisabled: { opacity: 0.7 },
});
