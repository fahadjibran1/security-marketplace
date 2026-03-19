import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  createJob,
  getMyCompany,
  hireJobApplication,
  listCompanyIncidents,
  listCompanyTimesheets,
  listCompanies,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  updateIncidentStatus,
  updateMyCompany,
  updateTimesheet,
} from '../services/api';
import { AuthUser, CompanyProfile, GuardProfile, Incident, Job, JobApplication, Shift, Timesheet } from '../types/models';

interface CompanyDashboardScreenProps {
  user: AuthUser;
}

type HireDraft = {
  siteName: string;
  start: string;
  end: string;
};

function defaultShiftStart() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(20, 0, 0, 0);
  return start.toISOString();
}

function defaultShiftEnd() {
  const end = new Date();
  end.setDate(end.getDate() + 2);
  end.setHours(6, 0, 0, 0);
  return end.toISOString();
}

export function CompanyDashboardScreen({ user }: CompanyDashboardScreenProps) {
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [guards, setGuards] = useState<GuardProfile[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [companyName, setCompanyName] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [address, setAddress] = useState('');
  const [contactDetails, setContactDetails] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [guardsRequired, setGuardsRequired] = useState('1');
  const [hourlyRate, setHourlyRate] = useState('16.50');
  const [submittingJob, setSubmittingJob] = useState(false);
  const [hireDrafts, setHireDrafts] = useState<Record<number, HireDraft>>({});

  async function loadData() {
    try {
      const [myCompany, companiesData, jobsData, guardsData, shiftsData, applicationsData, incidentRows, timesheetRows] = await Promise.all([
        getMyCompany(),
        listCompanies(),
        listJobs(),
        listGuards(),
        listShifts(),
        listJobApplications(),
        listCompanyIncidents(),
        listCompanyTimesheets(),
      ]);

      const currentCompany =
        myCompany ||
        companiesData.find((entry) => entry.id === user.companyId || entry.user?.id === user.id) ||
        null;
      const companyId = currentCompany?.id;

      setCompany(currentCompany);
      setCompanyName(currentCompany?.name || '');
      setCompanyNumber(currentCompany?.companyNumber || '');
      setAddress(currentCompany?.address || '');
      setContactDetails(currentCompany?.contactDetails || '');
      setJobs(jobsData.filter((job) => (job.company?.id ?? job.companyId) === companyId));
      setGuards(guardsData);
      setShifts(shiftsData.filter((shift) => (shift.company?.id ?? shift.companyId) === companyId));
      setApplications(
        applicationsData.filter((application) => application.job?.company?.id === companyId),
      );
      setIncidents(incidentRows);
      setTimesheets(timesheetRows);
    } catch (error) {
      Alert.alert('Load failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  useEffect(() => {
    loadData();
  }, [user.companyId, user.id]);

  function draftFor(applicationId: number): HireDraft {
    return (
      hireDrafts[applicationId] || {
        siteName: 'Main Site',
        start: defaultShiftStart(),
        end: defaultShiftEnd(),
      }
    );
  }

  function updateHireDraft(applicationId: number, field: keyof HireDraft, value: string) {
    setHireDrafts((current) => ({
      ...current,
      [applicationId]: {
        ...draftFor(applicationId),
        [field]: value,
      },
    }));
  }

  async function handleCreateJob() {
    if (!company) {
      Alert.alert('Missing company', 'Your company profile was not found for this account.');
      return;
    }

    try {
      setSubmittingJob(true);
      await createJob({
        companyId: company.id,
        title: jobTitle,
        description: jobDescription || undefined,
        guardsRequired: Number(guardsRequired),
        hourlyRate: Number(hourlyRate),
        status: 'open',
      });
      setJobTitle('');
      setJobDescription('');
      setGuardsRequired('1');
      setHourlyRate('16.50');
      await loadData();
      Alert.alert('Job created', 'The job is now open for guard applications.');
    } catch (error) {
      Alert.alert('Create job failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmittingJob(false);
    }
  }

  async function handleSaveProfile() {
    try {
      const updatedCompany = await updateMyCompany({
        name: companyName,
        companyNumber,
        address,
        contactDetails,
      });
      setCompany(updatedCompany);
      Alert.alert('Profile updated', 'Your company onboarding details have been saved.');
    } catch (error) {
      Alert.alert('Profile update failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleHire(application: JobApplication) {
    const draft = draftFor(application.id);

    try {
      await hireJobApplication(application.id, {
        createShift: true,
        siteName: draft.siteName,
        start: draft.start,
        end: draft.end,
      });
      await loadData();
      Alert.alert('Guard hired', 'Assignment and first shift created successfully.');
    } catch (error) {
      Alert.alert('Hire failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleUpdateIncidentStatus(id: number, status: string) {
    try {
      await updateIncidentStatus(id, status);
      await loadData();
      Alert.alert('Incident updated', `Incident marked as ${status}.`);
    } catch (error) {
      Alert.alert('Incident update failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleUpdateTimesheet(id: number, approvalStatus: string) {
    try {
      await updateTimesheet(id, { approvalStatus });
      await loadData();
      Alert.alert('Timesheet updated', `Timesheet marked as ${approvalStatus}.`);
    } catch (error) {
      Alert.alert('Timesheet update failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  const pendingApplications = applications.filter((application) => application.status === 'submitted');
  const openJobs = jobs.filter((job) => job.status === 'open');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Company Dashboard</Text>
      <Text style={styles.subtitle}>Manage projects, guards, and client billing.</Text>

      <FeatureCard
        title="Company Profile"
        subtitle={
          company
            ? `${company.name}\nNo: ${company.companyNumber}\n${company.address}\n${company.contactDetails}`
            : 'Loading company profile...'
        }
      >
        <TextInput style={styles.input} placeholder="Company name" value={companyName} onChangeText={setCompanyName} />
        <TextInput
          style={styles.input}
          placeholder="Company number"
          value={companyNumber}
          onChangeText={setCompanyNumber}
        />
        <TextInput style={styles.input} placeholder="Address" value={address} onChangeText={setAddress} />
        <TextInput
          style={styles.input}
          placeholder="Contact details"
          value={contactDetails}
          onChangeText={setContactDetails}
        />
        <Pressable style={styles.button} onPress={handleSaveProfile}>
          <Text style={styles.buttonText}>Save Profile</Text>
        </Pressable>
      </FeatureCard>

      <FeatureCard title="Advertise Jobs" subtitle={`Open jobs: ${openJobs.length}`}>
        <TextInput style={styles.input} placeholder="Job title" value={jobTitle} onChangeText={setJobTitle} />
        <TextInput
          style={[styles.input, styles.multiLineInput]}
          placeholder="Job description"
          multiline
          value={jobDescription}
          onChangeText={setJobDescription}
        />
        <TextInput
          style={styles.input}
          placeholder="Guards required"
          keyboardType="number-pad"
          value={guardsRequired}
          onChangeText={setGuardsRequired}
        />
        <TextInput
          style={styles.input}
          placeholder="Hourly rate"
          keyboardType="decimal-pad"
          value={hourlyRate}
          onChangeText={setHourlyRate}
        />
        <Pressable style={styles.button} onPress={handleCreateJob} disabled={submittingJob}>
          <Text style={styles.buttonText}>{submittingJob ? 'Creating job...' : 'Create Job'}</Text>
        </Pressable>
      </FeatureCard>

      <FeatureCard title="Employ Guards on Projects" subtitle={`Pending applications: ${pendingApplications.length}`}>
        {pendingApplications.length === 0 ? (
          <Text style={styles.helperText}>New guard applications will appear here.</Text>
        ) : (
          pendingApplications.map((application) => {
            const draft = draftFor(application.id);

            return (
              <View key={application.id} style={styles.listItem}>
                <Text style={styles.listTitle}>
                  {application.guard?.fullName || `Guard #${application.guardId}`} to{' '}
                  {application.job?.title || `Job #${application.jobId}`}
                </Text>
                <Text style={styles.helperText}>Create the first shift while hiring this application.</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Site name"
                  value={draft.siteName}
                  onChangeText={(value: string) => updateHireDraft(application.id, 'siteName', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Shift start ISO"
                  value={draft.start}
                  onChangeText={(value: string) => updateHireDraft(application.id, 'start', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Shift end ISO"
                  value={draft.end}
                  onChangeText={(value: string) => updateHireDraft(application.id, 'end', value)}
                />
                <Pressable style={styles.button} onPress={() => handleHire(application)}>
                  <Text style={styles.buttonText}>Hire + Create Shift</Text>
                </Pressable>
              </View>
            );
          })
        )}
      </FeatureCard>

      <FeatureCard title="Hours Management" subtitle={`Pending approvals: ${timesheets.filter((timesheet) => timesheet.approvalStatus === 'pending').length}`}>
        {timesheets.length === 0 ? (
          <Text style={styles.helperText}>No timesheets are available yet.</Text>
        ) : (
          timesheets.slice(0, 6).map((timesheet) => (
            <View key={timesheet.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shift?.id ?? timesheet.shiftId}`}</Text>
              <Text style={styles.helperText}>
                Hours: {timesheet.hoursWorked} | Status: {timesheet.approvalStatus}
              </Text>
              <Text style={styles.helperText}>
                Guard: {timesheet.guard?.fullName || `#${timesheet.guard?.id ?? timesheet.guardId ?? 'N/A'}`}
              </Text>
              {timesheet.shift ? (
                <Text style={styles.helperText}>
                  {new Date(timesheet.shift.start).toLocaleString()} to {new Date(timesheet.shift.end).toLocaleString()}
                </Text>
              ) : null}
              {timesheet.approvalStatus === 'pending' ? (
                <View style={styles.actionRow}>
                  <Pressable style={styles.button} onPress={() => handleUpdateTimesheet(timesheet.id, 'approved')}>
                    <Text style={styles.buttonText}>Approve</Text>
                  </Pressable>
                  <Pressable style={styles.secondaryButton} onPress={() => handleUpdateTimesheet(timesheet.id, 'rejected')}>
                    <Text style={styles.secondaryButtonText}>Reject</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard title="Incident Reports" subtitle={`Open incidents: ${incidents.filter((incident) => incident.status === 'open').length}`}>
        {incidents.length === 0 ? (
          <Text style={styles.helperText}>No incident reports have been submitted yet.</Text>
        ) : (
          incidents.slice(0, 6).map((incident) => (
            <View key={incident.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{incident.title}</Text>
              <Text style={styles.helperText}>
                {incident.severity} | {incident.status} | Guard: {incident.guard?.fullName || 'Unknown'}
              </Text>
              <Text style={styles.helperText}>{incident.notes}</Text>
              {incident.status !== 'resolved' ? (
                <Pressable style={styles.button} onPress={() => handleUpdateIncidentStatus(incident.id, 'resolved')}>
                  <Text style={styles.buttonText}>Mark Resolved</Text>
                </Pressable>
              ) : null}
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard
        title="Client Invoicing"
        subtitle="Generate invoices from approved hours and send to clients."
        ctaLabel="Create Invoice"
        onPress={() => Alert.alert('Invoice', 'Invoice generation flow is next after timesheet approval.')}
      />

      <FeatureCard title="Guard Profiles" subtitle={`Available guards: ${guards.length}`}>
        {guards.slice(0, 5).map((guard) => (
          <View key={guard.id} style={styles.listItem}>
            <Text style={styles.listTitle}>{guard.fullName}</Text>
            <Text style={styles.helperText}>Status: {guard.status}</Text>
          </View>
        ))}
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
  multiLineInput: {
    minHeight: 80,
    textAlignVertical: 'top',
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
  },
  listTitle: {
    color: '#111827',
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
});
