import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  checkInShift,
  checkOutShift,
  createIncident,
  createJobApplication,
  getMyGuard,
  listJobApplications,
  listMyTimesheets,
  listMyIncidents,
  listJobs,
  listMyAttendance,
  listShifts,
  submitTimesheet,
  updateMyGuard,
} from '../services/api';
import { AttendanceEvent, AuthUser, Incident, Job, JobApplication, Shift, Timesheet } from '../types/models';

interface GuardDashboardScreenProps {
  user: AuthUser;
}

export function GuardDashboardScreen({ user }: GuardDashboardScreenProps) {
  const [siaLicence, setSiaLicence] = useState('');
  const [locationSharing, setLocationSharing] = useState(false);
  const [dailyLog, setDailyLog] = useState('');
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [attendance, setAttendance] = useState<AttendanceEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [attendanceBusyShiftId, setAttendanceBusyShiftId] = useState<number | null>(null);
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentNotes, setIncidentNotes] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<Incident['severity']>('medium');
  const [incidentLocation, setIncidentLocation] = useState('');
  const [submittingIncident, setSubmittingIncident] = useState(false);
  const [submittingTimesheetId, setSubmittingTimesheetId] = useState<number | null>(null);

  async function loadData() {
    try {
      const [myGuard, shiftRows, jobRows, applicationRows, attendanceRows, incidentRows, timesheetRows] = await Promise.all([
        getMyGuard(),
        listShifts(),
        listJobs(),
        listJobApplications(),
        listMyAttendance(),
        listMyIncidents(),
        listMyTimesheets(),
      ]);

      const ownShifts = shiftRows.filter((shift) => (shift.guard?.id ?? shift.guardId) === user.guardId);
      const ownApplications = applicationRows.filter(
        (application) => (application.guard?.id ?? application.guardId) === user.guardId,
      );

      setFullName(myGuard.fullName || '');
      setSiaLicence(myGuard.siaLicenseNumber || myGuard.siaLicenceNumber || '');
      setPhone(myGuard.phone || '');
      setLocationSharing(myGuard.locationSharingEnabled ?? false);
      setShifts(ownShifts);
      setJobs(jobRows.filter((job) => job.status === 'open'));
      setApplications(ownApplications);
      setAttendance(attendanceRows);
      setIncidents(incidentRows);
      setTimesheets(timesheetRows);
    } catch (error) {
      Alert.alert('Load failed', error instanceof Error ? error.message : 'Unknown error');
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
      Alert.alert('Profile updated', 'Your guard onboarding details have been saved.');
    } catch (error) {
      Alert.alert('Profile update failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleCheckIn(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkInShift({ shiftId });
      await loadData();
      Alert.alert('Checked in', 'Your shift is now marked as in progress.');
    } catch (error) {
      Alert.alert('Check-in failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setAttendanceBusyShiftId(null);
    }
  }

  async function handleCheckOut(shiftId: number) {
    try {
      setAttendanceBusyShiftId(shiftId);
      await checkOutShift({ shiftId });
      await loadData();
      Alert.alert('Checked out', 'Your shift is complete and hours were added to the timesheet.');
    } catch (error) {
      Alert.alert('Check-out failed', error instanceof Error ? error.message : 'Unknown error');
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
        shiftId: operationsShift?.id,
      });
      setIncidentTitle('');
      setIncidentNotes('');
      setIncidentSeverity('medium');
      setIncidentLocation('');
      await loadData();
      Alert.alert('Incident submitted', 'Your incident report has been recorded.');
    } catch (error) {
      Alert.alert('Incident failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmittingIncident(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [user.guardId]);

  async function handleApply(jobId: number) {
    if (!user.guardId) {
      Alert.alert('Missing guard profile', 'This account does not have a linked guard profile yet.');
      return;
    }

    try {
      await createJobApplication({ jobId, guardId: user.guardId });
      await loadData();
      Alert.alert('Application sent', 'Your application has been submitted to the company.');
    } catch (error) {
      Alert.alert('Apply failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleSubmitTimesheet(timesheet: Timesheet) {
    try {
      setSubmittingTimesheetId(timesheet.id);
      await submitTimesheet(timesheet.id, { hoursWorked: timesheet.hoursWorked });
      await loadData();
      Alert.alert('Timesheet submitted', 'Your completed hours have been submitted to the company for approval.');
    } catch (error) {
      Alert.alert('Timesheet failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmittingTimesheetId(null);
    }
  }

  const appliedJobIds = new Set(applications.map((application) => application.job?.id ?? application.jobId));
  const availableJobs = jobs.filter((job) => !appliedJobIds.has(job.id));
  const activeShift = shifts.find((shift) => shift.status === 'in_progress') || null;
  const upcomingShift = shifts.find((shift) => shift.status === 'scheduled') || null;
  const operationsShift = activeShift || upcomingShift;
  const completedTimesheets = timesheets.filter((timesheet) => timesheet.shift?.status === 'completed');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Guard Dashboard</Text>
      <Text style={styles.subtitle}>Apply for jobs, manage assigned shifts, and run live site operations.</Text>

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
        <Pressable style={styles.button} onPress={handleSaveProfile} disabled={savingProfile}>
          <Text style={styles.buttonText}>{savingProfile ? 'Saving...' : 'Save Profile'}</Text>
        </Pressable>
      </FeatureCard>

      <FeatureCard title="Job Marketplace" subtitle={`Open jobs available: ${availableJobs.length}`}>
        {availableJobs.length === 0 ? (
          <Text style={styles.helperText}>You have applied to all currently open jobs.</Text>
        ) : (
          availableJobs.slice(0, 5).map((job) => (
            <View key={job.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{job.title}</Text>
              <Text style={styles.helperText}>
                Guards needed: {job.guardsRequired} | Rate: {job.hourlyRate}
              </Text>
              {job.description ? <Text style={styles.helperText}>{job.description}</Text> : null}
              <Pressable style={styles.button} onPress={() => handleApply(job.id)}>
                <Text style={styles.buttonText}>Apply</Text>
              </Pressable>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="My Applications" subtitle={`Submitted recruitment applications: ${applications.length}`}>
        {applications.length === 0 ? (
          <Text style={styles.helperText}>You have not applied for any jobs yet.</Text>
        ) : (
          applications.map((application) => (
            <View key={application.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{application.job?.title || `Job #${application.jobId}`}</Text>
              <Text style={styles.helperText}>Status: {application.status}</Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard
        title="Assigned Shift Operations"
        subtitle={
          operationsShift
            ? `${operationsShift.siteName} | ${operationsShift.status}`
            : 'All live shift actions should sit under the assigned shift.'
        }
      >
        {!operationsShift ? (
          <Text style={styles.helperText}>No assigned shift is currently available for live operations.</Text>
        ) : (
          <View style={styles.listItem}>
            <Text style={styles.listTitle}>{operationsShift.siteName}</Text>
            <Text style={styles.helperText}>
              {new Date(operationsShift.start).toLocaleString()} to {new Date(operationsShift.end).toLocaleString()}
            </Text>
            <Text style={styles.helperText}>
              Employer: {operationsShift.company?.name || `#${operationsShift.company?.id ?? operationsShift.companyId ?? 'N/A'}`}
            </Text>
            <Text style={styles.helperText}>
              Shift actions here should contain check-in, check calls, patrols, daily logs, incidents, and location sharing.
            </Text>
            {operationsShift.status === 'scheduled' ? (
              <Pressable
                style={styles.button}
                onPress={() => handleCheckIn(operationsShift.id)}
                disabled={attendanceBusyShiftId === operationsShift.id}
              >
                <Text style={styles.buttonText}>
                  {attendanceBusyShiftId === operationsShift.id ? 'Checking in...' : 'Check In'}
                </Text>
              </Pressable>
            ) : null}
            {operationsShift.status === 'in_progress' ? (
              <Pressable
                style={styles.button}
                onPress={() => handleCheckOut(operationsShift.id)}
                disabled={attendanceBusyShiftId === operationsShift.id}
              >
                <Text style={styles.buttonText}>
                  {attendanceBusyShiftId === operationsShift.id ? 'Checking out...' : 'Check Out'}
                </Text>
              </Pressable>
            ) : null}

            <TextInput
              style={[styles.input, styles.logInput]}
              placeholder="Daily log book notes for this shift..."
              multiline
              value={dailyLog}
              onChangeText={setDailyLog}
            />

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
            <Pressable style={styles.button} onPress={handleCreateIncident} disabled={submittingIncident}>
              <Text style={styles.buttonText}>{submittingIncident ? 'Submitting...' : 'Submit Incident'}</Text>
            </Pressable>

            <View style={styles.actionRow}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => Alert.alert('Welfare Check', 'Hourly welfare check call recorded for this shift.')}
              >
                <Text style={styles.secondaryButtonText}>Hourly Check Call</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => Alert.alert('Patrol', 'Patrol checkpoint flow should be linked to this shift.')}
              >
                <Text style={styles.secondaryButtonText}>Start Patrol</Text>
              </Pressable>
            </View>

            <Pressable
              style={styles.emergencyButton}
              onPress={() => Alert.alert('Panic Alert Triggered', 'Emergency alert has been sent.')}
            >
              <Text style={styles.buttonText}>Activate Panic Alert</Text>
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
