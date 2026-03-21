import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  createSite,
  createJob,
  getMyCompany,
  hireJobApplication,
  listAssignments,
  listCompanyIncidents,
  listSites,
  listCompanyTimesheets,
  listCompanies,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  updateIncidentStatus,
  updateMyCompany,
  updateSite,
  updateTimesheet,
} from '../services/api';
import {
  Assignment,
  AuthUser,
  CompanyProfile,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  Site,
  Shift,
  Timesheet,
} from '../types/models';

interface CompanyDashboardScreenProps {
  user: AuthUser;
}

type HireDraft = {
  siteId: string;
  siteName: string;
  start: string;
  end: string;
};

type SiteDraft = {
  name: string;
  clientName: string;
  address: string;
  contactDetails: string;
  status: string;
  welfareCheckIntervalMinutes: string;
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

function createFallbackSiteDraft(_siteId: number): SiteDraft {
  return {
    name: '',
    clientName: '',
    address: '',
    contactDetails: '',
    status: 'active',
    welfareCheckIntervalMinutes: '60',
  };
}

export function CompanyDashboardScreen({ user }: CompanyDashboardScreenProps) {
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [guards, setGuards] = useState<GuardProfile[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
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
  const [jobSiteId, setJobSiteId] = useState('');
  const [submittingJob, setSubmittingJob] = useState(false);
  const [hireDrafts, setHireDrafts] = useState<Record<number, HireDraft>>({});
  const [siteDrafts, setSiteDrafts] = useState<Record<number, SiteDraft>>({});
  const [siteName, setSiteName] = useState('');
  const [clientName, setClientName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteContactDetails, setSiteContactDetails] = useState('');
  const [siteStatus, setSiteStatus] = useState('active');
  const [welfareCheckIntervalMinutes, setWelfareCheckIntervalMinutes] = useState('60');
  const [submittingSite, setSubmittingSite] = useState(false);

  async function loadData() {
    try {
      const [
        myCompany,
        companiesData,
        sitesData,
        jobsData,
        guardsData,
        assignmentRows,
        shiftsData,
        applicationsData,
        incidentRows,
        timesheetRows,
      ] = await Promise.all([
        getMyCompany(),
        listCompanies(),
        listSites(),
        listJobs(),
        listGuards(),
        listAssignments(),
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
      setSites(sitesData.filter((site) => (site.company?.id ?? site.companyId) === companyId));
      setJobs(jobsData.filter((job) => (job.company?.id ?? job.companyId) === companyId));
      setGuards(guardsData);
      setAssignments(
        assignmentRows.filter((assignment) => (assignment.company?.id ?? assignment.companyId) === companyId),
      );
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
        siteId: '',
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

  function siteDraftFor(site: Site): SiteDraft {
    return (
      siteDrafts[site.id] || {
        name: site.name,
        clientName: site.clientName || '',
        address: site.address,
        contactDetails: site.contactDetails || '',
        status: site.status,
        welfareCheckIntervalMinutes: String(site.welfareCheckIntervalMinutes ?? 60),
      }
    );
  }

  function updateSiteDraft(siteId: number, field: keyof SiteDraft, value: string) {
    const existingSite = sites.find((site) => site.id === siteId);
    const baseDraft = existingSite ? siteDraftFor(existingSite) : createFallbackSiteDraft(siteId);

    setSiteDrafts((current) => ({
      ...current,
      [siteId]: {
        ...baseDraft,
        [field]: value,
      },
    }));
  }

  async function handleCreateSite() {
    try {
      setSubmittingSite(true);
      await createSite({
        name: siteName,
        clientName: clientName || undefined,
        address: siteAddress,
        contactDetails: siteContactDetails || undefined,
        status: siteStatus,
        welfareCheckIntervalMinutes: Number(welfareCheckIntervalMinutes) || 60,
      });
      setSiteName('');
      setClientName('');
      setSiteAddress('');
      setSiteContactDetails('');
      setSiteStatus('active');
      setWelfareCheckIntervalMinutes('60');
      await loadData();
      Alert.alert('Site created', 'The site is now available for jobs, shifts, and live operations.');
    } catch (error) {
      Alert.alert('Create site failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubmittingSite(false);
    }
  }

  async function handleUpdateSite(siteId: number) {
    const site = sites.find((entry) => entry.id === siteId);
    if (!site) {
      Alert.alert('Site not found', 'The selected site could not be loaded.');
      return;
    }

    const draft = siteDraftFor(site);

    try {
      await updateSite(siteId, {
        name: draft.name,
        clientName: draft.clientName || undefined,
        address: draft.address,
        contactDetails: draft.contactDetails || undefined,
        status: draft.status,
        welfareCheckIntervalMinutes: Number(draft.welfareCheckIntervalMinutes) || 60,
      });
      await loadData();
      Alert.alert('Site updated', 'Site details have been saved.');
    } catch (error) {
      Alert.alert('Update site failed', error instanceof Error ? error.message : 'Unknown error');
    }
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
        siteId: jobSiteId ? Number(jobSiteId) : undefined,
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
      setJobSiteId('');
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
        siteId: draft.siteId ? Number(draft.siteId) : undefined,
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
  const submittedTimesheets = timesheets.filter((timesheet) => timesheet.approvalStatus === 'submitted');
  const activeShifts = shifts.filter((shift) => shift.status === 'in_progress');
  const scheduledShifts = shifts.filter((shift) => shift.status === 'scheduled');
  const linkedGuardIds = new Set(assignments.map((assignment) => assignment.guard?.id ?? assignment.guardId));
  const linkedGuards = guards.filter((guard) => linkedGuardIds.has(guard.id));
  const siteSummaries = Array.from(
    shifts.reduce((map, shift) => {
      const key = shift.siteName || 'Unassigned Site';
      const entry = map.get(key) || {
        name: key,
        totalShifts: 0,
        liveShifts: 0,
        upcomingShifts: 0,
        incidents: 0,
        guardIds: new Set<number>(),
      };

      entry.totalShifts += 1;
      if (shift.status === 'in_progress') entry.liveShifts += 1;
      if (shift.status === 'scheduled') entry.upcomingShifts += 1;
      if (shift.guard?.id ?? shift.guardId) {
        entry.guardIds.add((shift.guard?.id ?? shift.guardId) as number);
      }
      map.set(key, entry);
      return map;
    }, new Map<string, { name: string; totalShifts: number; liveShifts: number; upcomingShifts: number; incidents: number; guardIds: Set<number> }>()),
  ).map(([name, summary]) => ({
    ...summary,
    incidents: incidents.filter((incident) => incident.shift?.siteName === name && incident.status !== 'resolved').length,
  }));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Company Dashboard</Text>
      <Text style={styles.subtitle}>Manage sites, guards, recruitment, live shifts, and client billing.</Text>

      <FeatureCard
        title="Company Setup"
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

      <FeatureCard
        title="Operations Overview"
        subtitle={`Live shifts: ${activeShifts.length} | Upcoming shifts: ${scheduledShifts.length}`}
      >
        <Text style={styles.helperText}>Sites under management: {siteSummaries.length}</Text>
        <Text style={styles.helperText}>Linked guards: {linkedGuards.length}</Text>
        <Text style={styles.helperText}>Pending recruitment applications: {pendingApplications.length}</Text>
        <Text style={styles.helperText}>
          Open incidents: {incidents.filter((incident) => incident.status === 'open').length}
        </Text>
        <Text style={styles.helperText}>
          Submitted timesheets: {submittedTimesheets.length}
        </Text>
      </FeatureCard>

      <FeatureCard title="Sites & Live Operations" subtitle={`Managed sites: ${sites.length}`}>
        <TextInput style={styles.input} placeholder="Site name" value={siteName} onChangeText={setSiteName} />
        <TextInput style={styles.input} placeholder="Client name" value={clientName} onChangeText={setClientName} />
        <TextInput style={styles.input} placeholder="Site address" value={siteAddress} onChangeText={setSiteAddress} />
        <TextInput
          style={styles.input}
          placeholder="Site contact details"
          value={siteContactDetails}
          onChangeText={setSiteContactDetails}
        />
        <TextInput style={styles.input} placeholder="Status" value={siteStatus} onChangeText={setSiteStatus} />
        <TextInput
          style={styles.input}
          placeholder="Welfare check interval minutes"
          keyboardType="number-pad"
          value={welfareCheckIntervalMinutes}
          onChangeText={setWelfareCheckIntervalMinutes}
        />
        <Pressable style={styles.button} onPress={handleCreateSite} disabled={submittingSite}>
          <Text style={styles.buttonText}>{submittingSite ? 'Creating site...' : 'Create Site'}</Text>
        </Pressable>

        {sites.length === 0 ? (
          <Text style={styles.helperText}>Create sites first so recruitment, shifts, logs, and incidents can live under them.</Text>
        ) : (
          sites.map((site) => {
            const draft = siteDraftFor(site);
            const siteSummary = siteSummaries.find((entry) => entry.name === site.name);

            return (
              <View key={site.id} style={styles.listItem}>
                <Text style={styles.listTitle}>{site.name}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Site name"
                  value={draft.name}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'name', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Client name"
                  value={draft.clientName}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'clientName', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Address"
                  value={draft.address}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'address', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Contact details"
                  value={draft.contactDetails}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'contactDetails', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Status"
                  value={draft.status}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'status', value)}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Welfare check interval minutes"
                  keyboardType="number-pad"
                  value={draft.welfareCheckIntervalMinutes}
                  onChangeText={(value: string) => updateSiteDraft(site.id, 'welfareCheckIntervalMinutes', value)}
                />
                <Text style={styles.helperText}>
                  Client: {site.clientName || 'Not set'} | Check calls every {site.welfareCheckIntervalMinutes} mins
                </Text>
                {siteSummary ? (
                  <Text style={styles.helperText}>
                    Guards assigned: {siteSummary.guardIds.size} | Live shifts: {siteSummary.liveShifts} | Open incidents: {siteSummary.incidents}
                  </Text>
                ) : null}
                <Pressable style={styles.button} onPress={() => handleUpdateSite(site.id)}>
                  <Text style={styles.buttonText}>Save Site</Text>
                </Pressable>
              </View>
            );
          })
        )}
      </FeatureCard>

      <FeatureCard title="Guard Team" subtitle={`Existing guards linked to your company: ${linkedGuards.length}`}>
        {linkedGuards.length === 0 ? (
          <Text style={styles.helperText}>Guards move into this pool after recruitment and shift assignment.</Text>
        ) : (
          linkedGuards.map((guard) => {
            const guardAssignments = assignments.filter(
              (assignment) => (assignment.guard?.id ?? assignment.guardId) === guard.id,
            );
            return (
              <View key={guard.id} style={styles.listItem}>
                <Text style={styles.listTitle}>{guard.fullName}</Text>
                <Text style={styles.helperText}>Status: {guard.status}</Text>
                <Text style={styles.helperText}>
                  Assigned jobs/shifts: {guardAssignments.length} | SIA: {guard.siaLicenseNumber || guard.siaLicenceNumber}
                </Text>
              </View>
            );
          })
        )}
      </FeatureCard>

      <FeatureCard title="Recruitment / Open Jobs" subtitle={`Open advertised jobs: ${openJobs.length}`}>
        {sites.length > 0 ? (
          <Text style={styles.helperText}>
            Site IDs: {sites.map((site) => `${site.id}=${site.name}`).join(' | ')}
          </Text>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder="Site ID for this job (optional)"
          keyboardType="number-pad"
          value={jobSiteId}
          onChangeText={setJobSiteId}
        />
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

      <FeatureCard title="Recruitment Pipeline" subtitle={`Pending applications: ${pendingApplications.length}`}>
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
                  placeholder="Site ID"
                  keyboardType="number-pad"
                  value={draft.siteId}
                  onChangeText={(value: string) => updateHireDraft(application.id, 'siteId', value)}
                />
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

      <FeatureCard
        title="Shift Operations / Compliance"
        subtitle="Track live shifts, check-ins, check calls, patrols, logs, and incident actions."
      >
        {shifts.length === 0 ? (
          <Text style={styles.helperText}>No live or scheduled shifts yet.</Text>
        ) : (
          shifts.slice(0, 6).map((shift) => (
            <View key={shift.id} style={styles.listItem}>
              <Text style={styles.listTitle}>{shift.siteName}</Text>
              <Text style={styles.helperText}>
                {new Date(shift.start).toLocaleString()} to {new Date(shift.end).toLocaleString()}
              </Text>
              <Text style={styles.helperText}>Status: {shift.status}</Text>
              <Text style={styles.helperText}>
                Guard: {shift.guard?.fullName || `#${shift.guard?.id ?? shift.guardId ?? 'N/A'}`}
              </Text>
            </View>
          ))
        )}
      </FeatureCard>

      <FeatureCard
        title="Hours Management"
        subtitle={`Awaiting approval: ${submittedTimesheets.length}`}
      >
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
              {timesheet.approvalStatus === 'submitted' ? (
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

      <FeatureCard
        title="Incident Reports"
        subtitle={`Open incidents: ${incidents.filter((incident) => incident.status === 'open').length}`}
      >
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
        title="Invoices"
        subtitle="Manage client invoices separately from sites, guards, and live shift operations."
        ctaLabel="Create Invoice"
        onPress={() => Alert.alert('Invoice', 'Invoice generation flow is next after timesheet approval.')}
      />
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
