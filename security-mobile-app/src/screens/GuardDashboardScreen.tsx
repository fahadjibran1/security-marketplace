import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  checkInShift,
  checkOutShift,
  createDailyLog,
  createIncident,
  createSafetyAlert,
  formatApiErrorMessage,
  getMyGuard,
  listMyAttachments,
  listMyShifts,
  listMyNotifications,
  listMyDailyLogs,
  listMyIncidents,
  listMyTimesheets,
  listMyAttendance,
  submitTimesheet,
  updateMyGuard,
} from '../services/api';
import {
  Attachment,
  AttendanceEvent,
  AuthUser,
  DailyLog,
  Incident,
  Notification,
  Shift,
  Timesheet,
} from '../types/models';

interface GuardDashboardScreenProps {
  user: AuthUser;
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);

  async function loadData() {
    try {
      setLoading(true);
      setLoadError(null);
      const [myGuard, shiftRows, attendanceRows, incidentRows, dailyLogRows, timesheetRows, notificationRows, attachmentRows] = await Promise.all([
        getMyGuard(),
        listMyShifts(),
        listMyAttendance(),
        listMyIncidents(),
        listMyDailyLogs(),
        listMyTimesheets(),
        listMyNotifications(),
        listMyAttachments(),
      ]);
      setFullName(myGuard.fullName || '');
      setSiaLicence(myGuard.siaLicenseNumber || myGuard.siaLicenceNumber || '');
      setPhone(myGuard.phone || '');
      setLocationSharing(myGuard.locationSharingEnabled ?? false);
      setShifts(shiftRows);
      setAttendance(attendanceRows);
      setIncidents(incidentRows);
      setDailyLogs(dailyLogRows);
      setTimesheets(timesheetRows);
      setNotifications(notificationRows);
      setAttachments(attachmentRows);
    } catch (error) {
      setLoadError(formatApiErrorMessage(error, 'Failed to load guard dashboard.'));
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
      showAlert('Profile updated', 'Your guard onboarding details have been saved.');
    } catch (error) {
      showAlert('Profile update failed', formatApiErrorMessage(error, 'Unable to save your guard profile.'));
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleCheckIn(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkInShift({ shiftId });
      await loadData();
      showAlert('Checked in', 'Your shift is now marked as in progress.');
    } catch (error) {
      showAlert('Check-in failed', formatApiErrorMessage(error, 'Unable to check in to this shift.'));
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCheckOut(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkOutShift({ shiftId });
      await loadData();
      showAlert('Checked out', 'Your shift is complete and hours were added to the timesheet.');
    } catch (error) {
      showAlert('Check-out failed', formatApiErrorMessage(error, 'Unable to check out of this shift.'));
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCreateIncident() {
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
      await loadData();
      showAlert('Incident submitted', 'Your incident report has been recorded.');
    } catch (error) {
      showAlert('Incident failed', formatApiErrorMessage(error, 'Unable to submit this incident.'));
    } finally {
      setSubmittingIncident(false);
    }
  }

  async function handleCreateSafetyAlert(type: 'welfare' | 'panic') {
    if (!selectedShift?.id) {
      showAlert('No assigned shift', 'Safety alerts require an assigned or active shift.');
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
      await loadData();
      showAlert(
        type === 'panic' ? 'Emergency alert sent' : 'Welfare alert sent',
        'The company control room can now see this safety alert.',
      );
    } catch (error) {
      showAlert('Safety alert failed', formatApiErrorMessage(error, 'Unable to raise this safety alert.'));
    } finally {
      setSubmittingAlertType(null);
    }
  }

  useEffect(() => {
    loadData();
  }, [user.guardId]);

  async function handleSubmitTimesheet(timesheet: Timesheet) {
    try {
      setSubmittingTimesheetId(timesheet.id);
      await submitTimesheet(timesheet.id, { hoursWorked: timesheet.hoursWorked });
      await loadData();
      showAlert('Timesheet submitted', 'Your completed hours have been submitted to the company for approval.');
    } catch (error) {
      showAlert('Timesheet failed', formatApiErrorMessage(error, 'Unable to submit this timesheet.'));
    } finally {
      setSubmittingTimesheetId(null);
    }
  }

  async function handleCreateDailyLog(logType: DailyLog['logType']) {
    if (!selectedShift?.id) {
      showAlert('No assigned shift', 'Select an assigned shift before recording a log entry.');
      return;
    }

    if (!dailyLogMessage.trim()) {
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
      setDailyLogMessage('');
      await loadData();
      showAlert('Shift activity saved', 'The log book entry has been linked to the selected shift.');
    } catch (error) {
      showAlert('Shift log failed', formatApiErrorMessage(error, 'Unable to save this shift log entry.'));
    } finally {
      setSubmittingDailyLogType(null);
    }
  }

  const activeShift = shifts.find((shift) => shift.status === 'in_progress') || null;
  const upcomingShift =
    shifts.find((shift) => shift.status === 'assigned' || shift.status === 'scheduled') || null;
  const selectedShift =
    shifts.find((shift) => shift.id === selectedShiftId) || activeShift || upcomingShift || shifts[0] || null;
  const completedTimesheets = timesheets.filter((timesheet) => timesheet.shift?.status === 'completed');
  const unreadNotifications = notifications.filter((notification) => notification.status === 'unread');
  const selectedShiftLogs = dailyLogs.filter((entry) => entry.shift?.id === selectedShift?.id);

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Guard Dashboard</Text>
      <Text style={styles.subtitle}>Manage assigned site shifts, run live operations, and submit timesheets from one shift context.</Text>

      {loadError ? (
        <FeatureCard title="Load Issue" subtitle="The latest guard data could not be loaded.">
          <Text style={styles.errorText}>{loadError}</Text>
          <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={loadData} disabled={loading}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
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
            ? `${selectedShift.siteName} | ${selectedShift.status}`
            : 'All live shift actions should sit under the assigned shift.'
        }
      >
        {!selectedShift ? (
          <Text style={styles.helperText}>No assigned shift is currently available for live operations.</Text>
        ) : (
          <View style={styles.listItem}>
            <Text style={styles.listTitle}>{selectedShift.siteName}</Text>
            <Text style={styles.helperText}>
              {new Date(selectedShift.start).toLocaleString()} to {new Date(selectedShift.end).toLocaleString()}
            </Text>
            <Text style={styles.helperText}>
              Employer: {selectedShift.company?.name || `#${selectedShift.company?.id ?? selectedShift.companyId ?? 'N/A'}`}
            </Text>
            <Text style={styles.helperText}>
              Check calls every {selectedShift.checkCallIntervalMinutes || 60} minutes. Use this shift to check in, log activity, raise incidents, and submit the linked timesheet.
            </Text>
            {(selectedShift.status === 'scheduled' || selectedShift.status === 'assigned') ? (
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
            {selectedShift.status === 'in_progress' ? (
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
          </View>
        )}
      </FeatureCard>

      <FeatureCard title="My Shifts" subtitle={`Assigned shifts: ${shifts.length}`}>
        {shifts.length === 0 ? (
          <Text style={styles.helperText}>You do not have any assigned shifts yet.</Text>
        ) : (
          shifts.map((shift) => (
            <View key={shift.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{shift.siteName}</Text>
              <Text style={styles.helperText}>
                {new Date(shift.start).toLocaleString()} to {new Date(shift.end).toLocaleString()}
              </Text>
              <Text style={styles.helperText}>
                Company: {shift.company?.name || `#${shift.company?.id ?? shift.companyId ?? 'N/A'}`}
              </Text>
              <Text style={styles.helperText}>
                Status: {shift.status} | Check calls every {shift.checkCallIntervalMinutes || 60} mins
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
  errorText: {
    color: '#b91c1c',
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
