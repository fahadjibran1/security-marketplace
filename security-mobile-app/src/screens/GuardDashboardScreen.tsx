import { useEffect, useState } from 'react';
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
  listMyAttachments,
  listJobApplications,
  listJobs,
  listMyShifts,
  listMyNotifications,
  listMyDailyLogs,
  listMyIncidents,
  listMyTimesheets,
  listMyAttendance,
  respondToShift,
  submitTimesheet,
  updateMyGuard,
} from '../services/api';
import {
  Attachment,
  AttendanceEvent,
  AuthUser,
  DailyLog,
  Incident,
  Job,
  JobApplication,
  Notification,
  Shift,
  Timesheet,
} from '../types/models';

interface GuardDashboardScreenProps {
  user: AuthUser;
}

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

function getShiftStatusBadgeStyle(status: string) {
  switch (status) {
    case 'offered':
      return { backgroundColor: '#dbeafe', color: '#1d4ed8' };
    case 'ready':
      return { backgroundColor: '#ffedd5', color: '#c2410c' };
    case 'in_progress':
      return { backgroundColor: '#dcfce7', color: '#166534' };
    case 'completed':
      return { backgroundColor: '#e5e7eb', color: '#111827' };
    case 'rejected':
      return { backgroundColor: '#fee2e2', color: '#b91c1c' };
    case 'cancelled':
      return { backgroundColor: '#e5e7eb', color: '#7f1d1d' };
    case 'unfilled':
    default:
      return { backgroundColor: '#f3f4f6', color: '#4b5563' };
  }
}

function ShiftStatusBadge({ status }: { status?: string | null }) {
  const lifecycleStatus = normalizeShiftLifecycleStatus(status);
  const palette = getShiftStatusBadgeStyle(lifecycleStatus);

  return (
    <View style={[styles.statusBadge, { backgroundColor: palette.backgroundColor }]}>
      <Text style={[styles.statusBadgeText, { color: palette.color }]}>{lifecycleStatus.replace('_', ' ')}</Text>
    </View>
  );
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }

  Alert.alert(title, message);
}

export function GuardDashboardScreen({ user }: GuardDashboardScreenProps) {
  const [siaLicence, setSiaLicence] = useState('');
  const [locationSharing, setLocationSharing] = useState(false);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [attendance, setAttendance] = useState<AttendanceEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [attendanceBusyShiftId, setAttendanceBusyShiftId] = useState<number | null>(null);
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentNotes, setIncidentNotes] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<Incident['severity']>('medium');
  const [incidentLocation, setIncidentLocation] = useState('');
  const [dailyLogMessage, setDailyLogMessage] = useState('');
  const [submittingDailyLogType, setSubmittingDailyLogType] = useState<DailyLog['logType'] | null>(null);
  const [submittingIncident, setSubmittingIncident] = useState(false);
  const [submittingTimesheetId, setSubmittingTimesheetId] = useState<number | null>(null);
  const [submittingAlertType, setSubmittingAlertType] = useState<'welfare' | 'panic' | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<number | null>(null);
  const [respondingShiftId, setRespondingShiftId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);
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
    ].slice(0, 30));
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
      const [
        myGuard,
        shiftRows,
        attendanceRows,
        incidentRows,
        dailyLogRows,
        timesheetRows,
        notificationRows,
        attachmentRows,
        jobRows,
        applicationRows,
      ] = await Promise.all([
        getMyGuard(),
        listMyShifts(),
        listMyAttendance(),
        listMyIncidents(),
        listMyDailyLogs(),
        listMyTimesheets(),
        listMyNotifications(),
        listMyAttachments(),
        listJobs(),
        listJobApplications(),
      ]);
      setFullName(myGuard.fullName || '');
      setSiaLicence(myGuard.siaLicenseNumber || myGuard.siaLicenceNumber || '');
      setPhone(myGuard.phone || '');
      setLocationSharing(myGuard.locationSharingEnabled ?? false);
      setShifts(
        shiftRows.map((shift) => ({
          ...shift,
          status: normalizeShiftLifecycleStatus(shift.status),
        })),
      );
      setAttendance(attendanceRows);
      setIncidents(incidentRows);
      setDailyLogs(dailyLogRows);
      setTimesheets(timesheetRows);
      setNotifications(notificationRows);
      setAttachments(attachmentRows);
      setJobs(jobRows.filter((job) => (job.status || '').toLowerCase() === 'open'));
      setApplications(applicationRows);
    } catch (error) {
      setLoadError(formatApiErrorMessage(error, 'Failed to load guard dashboard.'));
      pushFeedback('error', 'Load failed', formatApiErrorMessage(error, 'Failed to load guard dashboard.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveProfile() {
    try {
      setSavingProfile(true);
      await updateMyGuard({
        fullName,
        siaLicenseNumber: siaLicence,
        phone,
        locationSharingEnabled: locationSharing,
      });
      pushFeedback('success', 'Profile updated', 'Your guard onboarding details have been saved.');
      showAlert('Profile updated', 'Your guard onboarding details have been saved.');
    } catch (error) {
      pushFeedback('error', 'Profile update failed', formatApiErrorMessage(error, 'Unable to save your guard profile.'));
      showAlert('Profile update failed', formatApiErrorMessage(error, 'Unable to save your guard profile.'));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleCheckIn(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkInShift({ shiftId });
      updateShiftStatusLocally(shiftId, 'in_progress');
      pushTimelineEvent(
        shiftId,
        'Checked in',
        'Guard booked on successfully and the shift moved to in progress.',
      );
      await loadData();
      pushFeedback('success', 'Checked in successfully', 'You are now booked on and the shift is live for logs, incidents, check calls, welfare, panic, and timesheet actions.');
      showAlert('Checked in', 'Your shift is now marked as in progress.');
    } catch (error) {
      pushFeedback('error', 'Check-in failed', formatApiErrorMessage(error, 'Unable to check in to this shift.'));
      showAlert('Check-in failed', formatApiErrorMessage(error, 'Unable to check in to this shift.'));
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCheckOut(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkOutShift({ shiftId });
      updateShiftStatusLocally(shiftId, 'completed');
      pushTimelineEvent(
        shiftId,
        'Checked out',
        'Guard booked off successfully and the shift moved to completed.',
      );
      await loadData();
      pushFeedback('success', 'Checked out successfully', 'Your shift is now completed and worked hours were added to the timesheet.');
      showAlert('Checked out', 'Your shift is complete and hours were added to the timesheet.');
    } catch (error) {
      pushFeedback('error', 'Check-out failed', formatApiErrorMessage(error, 'Unable to check out of this shift.'));
      showAlert('Check-out failed', formatApiErrorMessage(error, 'Unable to check out of this shift.'));
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCreateIncident() {
    if (!selectedShift?.id || !selectedShiftLiveControlsEnabled) {
      pushFeedback('info', 'Incident unavailable', 'Incident reporting is only available while the selected shift is in progress.');
      showAlert('Shift not in progress', 'Incident reporting becomes available after you book on to the shift.');
      return;
    }

    try {
      setSubmittingIncident(true);
      await createIncident({
        title: incidentTitle,
        notes: incidentNotes,
        severity: incidentSeverity,
        locationText: incidentLocation || undefined,
        shiftId: selectedShift?.id,
      });
      setIncidentTitle('');
      setIncidentNotes('');
      setIncidentSeverity('medium');
      setIncidentLocation('');
      pushTimelineEvent(
        selectedShift.id,
        'Incident raised',
        `Incident "${incidentTitle.trim() || 'Untitled incident'}" was reported from this live shift.`,
      );
      await loadData();
      pushFeedback('success', 'Incident reported', 'Your incident report has been linked to the selected in-progress shift.');
      showAlert('Incident submitted', 'Your incident report has been recorded.');
    } catch (error) {
      pushFeedback('error', 'Incident failed', formatApiErrorMessage(error, 'Unable to submit this incident.'));
      showAlert('Incident failed', formatApiErrorMessage(error, 'Unable to submit this incident.'));
    } finally {
      setSubmittingIncident(false);
    }
  }

  async function handleCreateSafetyAlert(type: 'welfare' | 'panic') {
    if (!selectedShift?.id) {
      pushFeedback('info', 'No shift selected', 'Choose a valid shift before sending a welfare or panic update.');
      showAlert('No assigned shift', 'Safety alerts require an assigned or active shift.');
      return;
    }

    if (!selectedShiftLiveControlsEnabled) {
      pushFeedback('info', 'Safety action unavailable', 'Welfare updates and panic alerts are only available while the shift is in progress.');
      showAlert('Shift not in progress', 'Safety alerts become available after you book on to the shift.');
      return;
    }

    try {
      setSubmittingAlertType(type);
      await createSafetyAlert({
        shiftId: selectedShift.id,
        type,
        priority: type === 'panic' ? 'critical' : 'high',
        message:
          type === 'panic'
          ? 'Emergency alert raised by guard from the mobile app.'
          : 'Welfare alert raised by guard from the mobile app.',
      });
      pushTimelineEvent(
        selectedShift.id,
        type === 'panic' ? 'Panic alert sent' : 'Welfare update recorded',
        type === 'panic'
          ? 'Emergency alert sent to the company control room.'
          : 'Welfare status update was recorded for this live shift.',
      );
      await loadData();
      pushFeedback(
        'success',
        type === 'panic' ? 'Panic alert sent' : 'Welfare update sent',
        type === 'panic'
          ? 'Emergency alert sent to the company control room from this live shift.'
          : 'Welfare update recorded successfully for this live shift.',
      );
      showAlert(
        type === 'panic' ? 'Emergency alert sent' : 'Welfare alert sent',
        'The company control room can now see this safety alert.',
      );
    } catch (error) {
      pushFeedback('error', 'Safety alert failed', formatApiErrorMessage(error, 'Unable to raise this safety alert.'));
      showAlert('Safety alert failed', formatApiErrorMessage(error, 'Unable to raise this safety alert.'));
    } finally {
      setSubmittingAlertType(null);
    }
  }

  async function handleApplyToJob(jobId: number) {
    try {
      setApplyingJobId(jobId);
      await createJobApplication({ jobId });
      await loadData();
      pushFeedback('success', 'Application sent', 'Your application has been shared with the company for recruitment review.');
      showAlert('Application sent', 'Your application has been shared with the company.');
    } catch (error) {
      pushFeedback('error', 'Application failed', formatApiErrorMessage(error, 'Unable to apply for this job right now.'));
      showAlert('Application failed', formatApiErrorMessage(error, 'Unable to apply for this job right now.'));
    } finally {
      setApplyingJobId(null);
    }
  }

  useEffect(() => {
    loadData();
  }, [user.guardId]);

  async function handleSubmitTimesheet(timesheet: Timesheet) {
    if (!timesheet.shift || normalizeShiftLifecycleStatus(timesheet.shift.status) !== 'in_progress') {
      pushFeedback('info', 'Timesheet unavailable', 'Timesheet submission is only available while the linked shift is in progress.');
      showAlert('Shift not in progress', 'Timesheet progression is only available while the shift is in progress.');
      return;
    }

    try {
      setSubmittingTimesheetId(timesheet.id);
      await submitTimesheet(timesheet.id, { hoursWorked: timesheet.hoursWorked });
      if (timesheet.shift?.id) {
        pushTimelineEvent(
          timesheet.shift.id,
          'Timesheet submitted',
          'Hours were submitted successfully for company review.',
        );
      }
      await loadData();
      pushFeedback('success', 'Timesheet submitted', 'Your hours were submitted successfully for company review.');
      showAlert('Timesheet submitted', 'Your completed hours have been submitted to the company for approval.');
    } catch (error) {
      pushFeedback('error', 'Timesheet failed', formatApiErrorMessage(error, 'Unable to submit this timesheet.'));
      showAlert('Timesheet failed', formatApiErrorMessage(error, 'Unable to submit this timesheet.'));
    } finally {
      setSubmittingTimesheetId(null);
    }
  }

  async function handleCreateDailyLog(logType: DailyLog['logType']) {
    if (!selectedShift?.id) {
      pushFeedback('info', 'No shift selected', 'Select a shift before recording a log, check call, or welfare entry.');
      showAlert('No assigned shift', 'Select an assigned shift before recording a log entry.');
      return;
    }

    if (!selectedShiftLiveControlsEnabled) {
      pushFeedback('info', 'Log unavailable', 'Logs, check calls, and welfare entries are only available while the shift is in progress.');
      showAlert('Shift not in progress', 'Operational logs become available after you book on to the shift.');
      return;
    }

    if (!dailyLogMessage.trim()) {
      pushFeedback('error', 'Log message required', 'Enter a short note before saving a log, check call, or welfare entry.');
      showAlert('Log message required', 'Enter a short operational note before saving the log entry.');
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
        logType === 'check_call' ? 'Check call recorded' : logType === 'welfare_check' ? 'Welfare update recorded' : 'Log entry added',
        dailyLogMessage.trim(),
      );
      setDailyLogMessage('');
      await loadData();
      pushFeedback(
        'success',
        logType === 'check_call' ? 'Check call recorded' : logType === 'welfare_check' ? 'Welfare update recorded' : 'Log entry added',
        logType === 'observation'
          ? 'Your log entry was added to the selected live shift.'
          : logType === 'check_call'
            ? 'Your check call was recorded successfully for the selected live shift.'
            : 'Your welfare update was recorded successfully for the selected live shift.',
      );
      showAlert('Shift activity saved', 'The log book entry has been linked to the selected shift.');
    } catch (error) {
      pushFeedback('error', 'Shift log failed', formatApiErrorMessage(error, 'Unable to save this shift log entry.'));
      showAlert('Shift log failed', formatApiErrorMessage(error, 'Unable to save this shift log entry.'));
    } finally {
      setSubmittingDailyLogType(null);
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
        response === 'accepted'
          ? 'Guard accepted the shift offer and the shift is now ready.'
          : 'Guard rejected the shift offer and the company will need to reassign cover.',
      );
      await loadData();
      pushFeedback(
        'success',
        response === 'accepted' ? 'Shift accepted' : 'Shift rejected',
        response === 'accepted'
          ? 'This shift is now ready. Book on when you arrive on site.'
          : 'You rejected this shift offer. The company will now need to reassign cover.',
      );
      showAlert(
        response === 'accepted' ? 'Shift confirmed' : 'Shift rejected',
        response === 'accepted'
          ? 'The company can now see your confirmation. Check-in will unlock when the shift is ready to start.'
          : 'The company can now see that this shift needs new cover.',
      );
    } catch (error) {
      pushFeedback(
        'error',
        response === 'accepted' ? 'Accept failed' : 'Reject failed',
        formatApiErrorMessage(error, 'Unable to update this shift response.'),
      );
      showAlert(
        response === 'accepted' ? 'Accept failed' : 'Reject failed',
        formatApiErrorMessage(error, 'Unable to update this shift response.'),
      );
    } finally {
      setRespondingShiftId(null);
    }
  }

  const activeShift = shifts.find((shift) => normalizeShiftLifecycleStatus(shift.status) === 'in_progress') || null;
  const upcomingShift =
    shifts.find((shift) => ['offered', 'ready', 'unfilled'].includes(normalizeShiftLifecycleStatus(shift.status))) || null;
  const selectedShift =
    shifts.find((shift) => shift.id === selectedShiftId) || activeShift || upcomingShift || shifts[0] || null;
  const selectedShiftStatus = normalizeShiftLifecycleStatus(selectedShift?.status);
  const selectedShiftResponsePending = selectedShiftStatus === 'offered';
  const selectedShiftCanCheckIn = selectedShiftStatus === 'ready';
  const selectedShiftLiveControlsEnabled = selectedShiftStatus === 'in_progress';
  const completedTimesheets = timesheets.filter(
    (timesheet) => normalizeShiftLifecycleStatus(timesheet.shift?.status) === 'completed',
  );
  const unreadNotifications = notifications.filter((notification) => notification.status === 'unread');
  const selectedShiftLogs = dailyLogs.filter((entry) => entry.shift?.id === selectedShift?.id);
  const appliedJobIds = new Set(applications.map((application) => application.job?.id ?? application.jobId));
  const openJobs = jobs.filter((job) => !appliedJobIds.has(job.id));
  const myApplications = applications
    .slice()
    .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime());
  const applicationShiftOfferById = new Map(
    myApplications.map((application) => {
      const assignmentShifts =
        application.assignments?.flatMap((assignment) => assignment.shifts || []) || [];
      const latestShift =
        assignmentShifts.sort((left, right) => right.start.localeCompare(left.start))[0] || null;

      return [application.id, latestShift];
    }),
  );
  const shiftOffers = shifts
    .filter((shift) => ['offered', 'rejected'].includes(normalizeShiftLifecycleStatus(shift.status)))
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  const operationalShifts = shifts
    .filter((shift) => ['ready', 'in_progress', 'completed'].includes(normalizeShiftLifecycleStatus(shift.status)))
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

  useEffect(() => {
    const selectedStillExists = selectedShiftId ? shifts.some((shift) => shift.id === selectedShiftId) : false;
    if ((!selectedShiftId || !selectedStillExists) && selectedShift?.id) {
      setSelectedShiftId(selectedShift.id);
    }
  }, [selectedShift?.id, selectedShiftId, shifts]);

  if (loading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Guard Dashboard</Text>
        <Text style={styles.subtitle}>Loading your jobs, shifts, incidents, alerts, and timesheets...</Text>
      </ScrollView>
    );
  }

  const selectedShiftStateHelp =
    selectedShiftStatus === 'offered'
      ? 'Waiting for you to accept or reject this shift offer.'
      : selectedShiftStatus === 'ready'
        ? 'This shift is confirmed and ready. Book on when you arrive on site.'
        : selectedShiftStatus === 'in_progress'
          ? 'This shift is live. Logs, incidents, check calls, welfare, panic, and timesheet actions are enabled.'
          : selectedShiftStatus === 'completed'
            ? 'This shift is completed. Live controls are now read-only.'
            : selectedShiftStatus === 'rejected'
              ? 'You rejected this shift offer. The company will need to reassign cover.'
              : selectedShiftStatus === 'cancelled'
                ? 'This shift was cancelled by the company and is read-only.'
                : 'This shift is not yet live.';
  const selectedShiftTimeline = [
    ...localTimelineEvents
      .filter((event) => event.shiftId === selectedShift?.id)
      .map((event) => ({
        id: `local-${event.id}`,
        occurredAt: event.occurredAt,
        title: event.title,
        message: event.message,
      })),
    ...attendance
      .filter((event) => event.shift?.id === selectedShift?.id)
      .map((event) => ({
        id: `attendance-${event.id}`,
        occurredAt: event.occurredAt,
        title: event.type === 'check-in' ? 'Checked in' : 'Checked out',
        message: event.notes || `Attendance event recorded for ${event.shift?.siteName || 'this shift'}.`,
      })),
    ...selectedShiftLogs.map((entry) => ({
      id: `log-${entry.id}`,
      occurredAt: entry.createdAt,
      title:
        entry.logType === 'check_call'
          ? 'Check call recorded'
          : entry.logType === 'welfare_check'
            ? 'Welfare update recorded'
            : 'Log entry added',
      message: entry.message,
    })),
    ...incidents
      .filter((incident) => incident.shift?.id === selectedShift?.id)
      .map((incident) => ({
        id: `incident-${incident.id}`,
        occurredAt: incident.createdAt,
        title: 'Incident raised',
        message: incident.title,
      })),
    ...notifications
      .filter((notification) => selectedShift?.id && notification.message.includes(`shift #${selectedShift.id}`))
      .map((notification) => ({
        id: `notification-${notification.id}`,
        occurredAt: notification.createdAt,
        title: notification.title,
        message: notification.message,
      })),
  ]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 8);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Guard Dashboard</Text>
      <Text style={styles.subtitle}>Review shift offers, confirm readiness, and run live controls from one shift context.</Text>

      {loadError ? (
        <FeatureCard title="Load Issue" subtitle="The latest guard data could not be loaded.">
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={loadData} disabled={loading}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </FeatureCard>
      ) : null}

      {actionFeedback ? (
        <FeatureCard
          title={actionFeedback.title}
          subtitle={
            actionFeedback.tone === 'success'
              ? 'Latest shift action completed successfully.'
              : actionFeedback.tone === 'error'
                ? 'Latest shift action needs attention.'
                : 'Shift state guidance'
          }
        >
          <Text
            style={
              actionFeedback.tone === 'success'
                ? styles.successText
                : actionFeedback.tone === 'error'
                  ? styles.errorText
                  : styles.helperText
            }
          >
            {actionFeedback.message}
          </Text>
        </FeatureCard>
      ) : null}

      <FeatureCard
        title="Profile + SIA"
        subtitle="Complete onboarding details and keep your security profile up to date."
      >
        <TextInput style={styles.input} placeholder="Full name" value={fullName} onChangeText={setFullName} />
        <TextInput style={styles.input} placeholder="Phone number" value={phone} onChangeText={setPhone} />
        <TextInput
          style={styles.input}
          placeholder="SIA licence number"
          value={siaLicence}
          onChangeText={setSiaLicence}
        />
        <View style={styles.switchRow}>
          <Text style={styles.helperText}>Share live location on assigned shifts</Text>
          <Switch value={locationSharing} onValueChange={setLocationSharing} />
        </View>
        <Pressable style={[styles.button, savingProfile && styles.buttonDisabled]} onPress={handleSaveProfile} disabled={savingProfile}>
          <Text style={styles.buttonText}>{savingProfile ? 'Saving...' : 'Save Profile'}</Text>
        </Pressable>
      </FeatureCard>

      <FeatureCard
        title="Assigned Shift Operations"
        subtitle={
          selectedShift
            ? `${selectedShift.siteName} | ${selectedShiftStatus}`
            : 'All live shift actions should sit under the assigned shift.'
        }
      >
        {!selectedShift ? (
          <Text style={styles.helperText}>No assigned shift is currently available for live operations.</Text>
        ) : (
          <View style={styles.listItem}>
            <Text style={styles.listTitle}>{selectedShift.siteName}</Text>
            <ShiftStatusBadge status={selectedShift.status} />
            <Text style={styles.helperText}>
              {new Date(selectedShift.start).toLocaleString()} to {new Date(selectedShift.end).toLocaleString()}
            </Text>
            <Text style={styles.helperText}>
              Employer: {selectedShift.company?.name || `#${selectedShift.company?.id ?? selectedShift.companyId ?? 'N/A'}`}
            </Text>
            <Text style={styles.helperText}>{selectedShiftStateHelp}</Text>
            {selectedShiftResponsePending ? (
              <>
                <View style={styles.actionRow}>
                  <Pressable
                    style={styles.button}
                    onPress={() => handleRespondToShift(selectedShift.id, 'accepted')}
                    disabled={respondingShiftId === selectedShift.id}
                  >
                    <Text style={styles.buttonText}>
                      {respondingShiftId === selectedShift.id ? 'Updating...' : 'Accept Shift'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => handleRespondToShift(selectedShift.id, 'rejected')}
                    disabled={respondingShiftId === selectedShift.id}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {respondingShiftId === selectedShift.id ? 'Updating...' : 'Reject Shift'}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : null}
            <Text style={styles.helperText}>
              Check calls every {selectedShift.checkCallIntervalMinutes || 60} minutes. Live controls are enabled only while the shift is in progress.
            </Text>
            {selectedShiftCanCheckIn ? (
              <Pressable
                style={styles.button}
                onPress={() => handleCheckIn(selectedShift.id)}
                disabled={attendanceBusyShiftId === selectedShift.id}
              >
                <Text style={styles.buttonText}>
                  {attendanceBusyShiftId === selectedShift.id ? 'Checking in...' : 'Check In'}
                </Text>
              </Pressable>
            ) : null}
            {selectedShiftLiveControlsEnabled ? (
              <Pressable
                style={styles.button}
                onPress={() => handleCheckOut(selectedShift.id)}
                disabled={attendanceBusyShiftId === selectedShift.id}
              >
                <Text style={styles.buttonText}>
                  {attendanceBusyShiftId === selectedShift.id ? 'Checking out...' : 'Check Out'}
                </Text>
              </Pressable>
            ) : null}
            {!selectedShiftLiveControlsEnabled ? (
              <Text style={styles.helperText}>
                {selectedShiftStatus === 'ready'
                  ? 'Book on is the next valid action. Live controls unlock once the shift is in progress.'
                  : selectedShiftStatus === 'offered'
                    ? 'Accept this shift first. Live controls stay disabled until the shift reaches in progress.'
                    : 'Live controls are unavailable for this shift state.'}
              </Text>
            ) : (
              <>
                <TextInput
                  style={[styles.input, styles.logInput]}
                  placeholder="Shift log / handover / check-call note"
                  multiline
                  value={dailyLogMessage}
                  onChangeText={setDailyLogMessage}
                />
                <View style={styles.actionRow}>
                  <Pressable
                    style={[styles.secondaryButton, submittingDailyLogType !== null && styles.buttonDisabled]}
                    onPress={() => handleCreateDailyLog('observation')}
                    disabled={submittingDailyLogType !== null}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {submittingDailyLogType === 'observation' ? 'Saving...' : 'Add Log Entry'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.secondaryButton, submittingDailyLogType !== null && styles.buttonDisabled]}
                    onPress={() => handleCreateDailyLog('check_call')}
                    disabled={submittingDailyLogType !== null}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {submittingDailyLogType === 'check_call' ? 'Saving...' : 'Record Check Call'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.secondaryButton, submittingDailyLogType !== null && styles.buttonDisabled]}
                    onPress={() => handleCreateDailyLog('welfare_check')}
                    disabled={submittingDailyLogType !== null}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {submittingDailyLogType === 'welfare_check' ? 'Saving...' : 'Record Welfare Check'}
                    </Text>
                  </Pressable>
                </View>

                <TextInput style={styles.input} placeholder="Incident title" value={incidentTitle} onChangeText={setIncidentTitle} />
                <TextInput
                  style={styles.input}
                  placeholder="Severity: low, medium, high, critical"
                  value={incidentSeverity}
                  onChangeText={(value: string) => setIncidentSeverity((value as Incident['severity']) || 'medium')}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Location details"
                  value={incidentLocation}
                  onChangeText={setIncidentLocation}
                />
                <TextInput
                  style={[styles.input, styles.logInput]}
                  placeholder="Describe what happened..."
                  multiline
                  value={incidentNotes}
                  onChangeText={setIncidentNotes}
                />
                <Pressable style={[styles.button, submittingIncident && styles.buttonDisabled]} onPress={handleCreateIncident} disabled={submittingIncident}>
                  <Text style={styles.buttonText}>{submittingIncident ? 'Submitting...' : 'Submit Incident'}</Text>
                </Pressable>

                <View style={styles.actionRow}>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => handleCreateSafetyAlert('welfare')}
                    disabled={submittingAlertType !== null}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {submittingAlertType === 'welfare' ? 'Sending...' : 'Raise Welfare Alert'}
                    </Text>
                  </Pressable>
                </View>

                <Pressable
                  style={styles.emergencyButton}
                  onPress={() => handleCreateSafetyAlert('panic')}
                  disabled={submittingAlertType !== null}
                >
                  <Text style={styles.buttonText}>
                    {submittingAlertType === 'panic' ? 'Sending Emergency Alert...' : 'Activate Panic Alert'}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </FeatureCard>

      <FeatureCard title="Open Jobs" subtitle={`${openJobs.length} recruitment jobs available right now`}>
        {openJobs.length === 0 ? (
          <Text style={styles.helperText}>No open jobs are available at the moment. Check back soon.</Text>
        ) : (
          openJobs.map((job) => (
            <View key={job.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{job.title}</Text>
              <Text style={styles.helperText}>
                Company: {job.company?.name || `#${job.company?.id ?? job.companyId ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>
                Site: {job.site?.name || 'Site to be confirmed'}
              </Text>
              <Text style={styles.helperText}>
                Guards required: {job.guardsRequired ?? 1}
                {typeof job.hourlyRate === 'number' ? ` | Hourly rate: £${job.hourlyRate}` : ''}
              </Text>
              <Pressable
                style={[styles.button, applyingJobId === job.id && styles.buttonDisabled]}
                onPress={() => handleApplyToJob(job.id)}
                disabled={applyingJobId === job.id}
              >
                <Text style={styles.buttonText}>{applyingJobId === job.id ? 'Applying...' : 'Apply'}</Text>
              </Pressable>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="My Applications" subtitle={`${applications.length} recruitment applications submitted`}>
        {myApplications.length === 0 ? (
          <Text style={styles.helperText}>You have not applied to any jobs yet.</Text>
        ) : (
          myApplications.map((application) => (
            <View key={application.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{application.job?.title || `Job #${application.jobId}`}</Text>
              <Text style={styles.helperText}>
                Company:{' '}
                {application.job?.company?.name ||
                  `#${application.job?.company?.id ?? application.job?.companyId ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>
                Site: {application.job?.site?.name || 'Site to be confirmed'}
              </Text>
              <Text style={styles.helperText}>Status: {application.status}</Text>
              <Text style={styles.helperText}>Applied: {new Date(application.appliedAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Shift Offers" subtitle={`${shiftOffers.length} offered or decided shift offers`}>
        {shiftOffers.length === 0 ? (
          <Text style={styles.helperText}>No shift offers have been sent to you yet.</Text>
        ) : (
          shiftOffers.map((shift) => (
            <View key={shift.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{shift.siteName}</Text>
              <ShiftStatusBadge status={shift.status} />
              <Text style={styles.helperText}>
                {new Date(shift.start).toLocaleString()} to {new Date(shift.end).toLocaleString()}
              </Text>
              <Text style={styles.helperText}>
                Company: {shift.company?.name || `#${shift.company?.id ?? shift.companyId ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>
                Status: {normalizeShiftLifecycleStatus(shift.status)} | Check calls every {shift.checkCallIntervalMinutes || 60} mins
              </Text>
              {normalizeShiftLifecycleStatus(shift.status) === 'offered' ? (
                <View style={styles.actionRow}>
                  <Pressable
                    style={styles.button}
                    onPress={() => handleRespondToShift(shift.id, 'accepted')}
                    disabled={respondingShiftId === shift.id}
                  >
                    <Text style={styles.buttonText}>
                      {respondingShiftId === shift.id ? 'Updating...' : 'Accept'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => handleRespondToShift(shift.id, 'rejected')}
                    disabled={respondingShiftId === shift.id}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {respondingShiftId === shift.id ? 'Updating...' : 'Reject'}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.helperText}>
                  {normalizeShiftLifecycleStatus(shift.status) === 'rejected'
                    ? 'This offer was rejected and is now read-only.'
                    : 'This offer no longer needs a response.'}
                </Text>
              )}
              <Pressable style={styles.secondaryButton} onPress={() => setSelectedShiftId(shift.id)}>
                <Text style={styles.secondaryButtonText}>{selectedShift?.id === shift.id ? 'Open Shift' : 'View Shift'}</Text>
              </Pressable>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Operational Shifts" subtitle={`${operationalShifts.length} ready, live, or completed shifts`}>
        {operationalShifts.length === 0 ? (
          <Text style={styles.helperText}>No ready or live shifts are available for operations yet.</Text>
        ) : (
          operationalShifts.map((shift) => (
            <View key={shift.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{shift.siteName}</Text>
              <ShiftStatusBadge status={shift.status} />
              <Text style={styles.helperText}>
                {new Date(shift.start).toLocaleString()} to {new Date(shift.end).toLocaleString()}
              </Text>
              <Text style={styles.helperText}>
                Company: {shift.company?.name || `#${shift.company?.id ?? shift.companyId ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>
                Status: {normalizeShiftLifecycleStatus(shift.status)} | Check calls every {shift.checkCallIntervalMinutes || 60} mins
              </Text>
              <Pressable style={styles.secondaryButton} onPress={() => setSelectedShiftId(shift.id)}>
                <Text style={styles.secondaryButtonText}>{selectedShift?.id === shift.id ? 'Open Shift' : 'View Shift'}</Text>
              </Pressable>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Shift Log Book" subtitle={`${selectedShiftLogs.length} entries for the selected shift`}>
        {selectedShiftLogs.length === 0 ? (
          <Text style={styles.helperText}>No log book activity recorded for the selected shift yet.</Text>
        ) : (
          selectedShiftLogs.map((entry) => (
            <View key={entry.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{entry.logType}</Text>
              <Text style={styles.helperText}>{entry.message}</Text>
              <Text style={styles.helperText}>{new Date(entry.createdAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Selected Shift Timeline" subtitle={`${selectedShiftTimeline.length} recent events for the selected shift`}>
        {!selectedShift ? (
          <Text style={styles.helperText}>Choose a shift to view its recent activity timeline.</Text>
        ) : selectedShiftTimeline.length === 0 ? (
          <Text style={styles.helperText}>No recent activity recorded for this shift yet.</Text>
        ) : (
          selectedShiftTimeline.map((entry) => (
            <View key={entry.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{entry.title}</Text>
              <Text style={styles.helperText}>{entry.message}</Text>
              <Text style={styles.helperText}>{new Date(entry.occurredAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="My Timesheets" subtitle={`Completed/worked jobs: ${completedTimesheets.length}`}>
        {timesheets.length === 0 ? (
          <Text style={styles.helperText}>Timesheets will appear as you complete assigned shifts.</Text>
        ) : (
          timesheets.map((timesheet) => (
            <View key={timesheet.id} style={styles.listItem}>
              <Text style={styles.listTitle}>
                {timesheet.shift?.siteName || `Shift #${timesheet.shift?.id ?? timesheet.shiftId}`}
              </Text>
              <Text style={styles.helperText}>
                Hours: {timesheet.hoursWorked} | Status: {timesheet.approvalStatus}
              </Text>
              {timesheet.shift ? (
                <Text style={styles.helperText}>
                  {new Date(timesheet.shift.start).toLocaleString()} to {new Date(timesheet.shift.end).toLocaleString()}
                </Text>
              ) : null}
              {timesheet.approvalStatus === 'draft' ? (
                <Pressable
                  style={styles.button}
                  onPress={() => handleSubmitTimesheet(timesheet)}
                  disabled={submittingTimesheetId === timesheet.id}
                >
                  <Text style={styles.buttonText}>
                    {submittingTimesheetId === timesheet.id ? 'Submitting...' : 'Submit Timesheet'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="My Notifications" subtitle={`${unreadNotifications.length} unread alerts or workflow updates`}>
        {notifications.length === 0 ? (
          <Text style={styles.helperText}>No notifications yet. Shift reminders and approvals will appear here.</Text>
        ) : (
          notifications.slice(0, 5).map((notification) => (
            <View key={notification.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{notification.title}</Text>
              <Text style={styles.helperText}>{notification.message}</Text>
              <Text style={styles.helperText}>
                {notification.status} | {new Date(notification.createdAt).toLocaleString()}
              </Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Evidence & Attachments" subtitle={`${attachments.length} uploaded records linked to your work`}>
        {attachments.length === 0 ? (
          <Text style={styles.helperText}>No attachments available yet.</Text>
        ) : (
          attachments.slice(0, 5).map((attachment) => (
            <View key={attachment.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{attachment.fileName}</Text>
              <Text style={styles.helperText}>
                {attachment.entityType} #{attachment.entityId}
              </Text>
              <Text style={styles.helperText}>{new Date(attachment.createdAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Attendance History" subtitle={`Recorded attendance events: ${attendance.length}`}>
        {attendance.length === 0 ? (
          <Text style={styles.helperText}>No attendance events recorded yet.</Text>
        ) : (
          attendance.slice(0, 6).map((event) => (
            <View key={event.id} style={styles.listItem}>
              <Text style={styles.listTitle}>
                {event.type} for {event.shift?.siteName || `Shift #${event.shift?.id ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>{new Date(event.occurredAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Incident History" subtitle={`Submitted incidents: ${incidents.length}`}>
        {incidents.length === 0 ? (
          <Text style={styles.helperText}>No incident reports submitted yet.</Text>
        ) : (
          incidents.slice(0, 5).map((incident) => (
            <View key={incident.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{incident.title}</Text>
              <Text style={styles.helperText}>
                {incident.severity} | {incident.status} | {new Date(incident.createdAt).toLocaleString()}
              </Text>
              <Text style={styles.helperText}>{incident.notes}</Text>
            </View>
          ))
        )}
      </FeatureCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f3f4f6' },
  content: { padding: 16, paddingBottom: 24 },
  title: { fontSize: 24, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { color: '#374151', marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#fff',
  },
  logInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  helperText: {
    color: '#4b5563',
  },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  errorText: {
    color: '#b91c1c',
    fontWeight: '600',
  },
  successText: {
    color: '#166534',
    fontWeight: '600',
  },
  listItem: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 10,
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  listTitle: {
    color: '#111827',
    fontWeight: '600',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  button: {
    backgroundColor: '#111827',
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#e5e7eb',
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '600',
  },
  emergencyButton: {
    backgroundColor: '#991b1b',
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
