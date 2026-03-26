import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FeatureCard } from '../components/FeatureCard';
import {
  acknowledgeSafetyAlert,
  approveGuard,
  closeSafetyAlert,
  listCompanyAttachments,
  listCompanyAuditLogs,
  listCompanyNotifications,
  listCompanySafetyAlerts,
  createJob,
  createSite,
  getMyCompany,
  hireJobApplication,
  listAssignments,
  listCompanies,
  listCompanyIncidents,
  listCompanyTimesheets,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  listSites,
  updateIncidentStatus,
  updateMyCompany,
  updateSite,
  updateTimesheet,
} from '../services/api';
import {
  Attachment,
  AuditLog,
  Assignment,
  AuthUser,
  CompanyProfile,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  Notification,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
} from '../types/models';

interface CompanyDashboardScreenProps {
  user: AuthUser;
}

type CompanySectionId =
  | 'overview'
  | 'sites'
  | 'guards'
  | 'recruitment'
  | 'shifts'
  | 'timesheets'
  | 'incidents'
  | 'alerts'
  | 'invoices';

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

function createFallbackSiteDraft(): SiteDraft {
  return {
    name: '',
    clientName: '',
    address: '',
    contactDetails: '',
    status: 'active',
    welfareCheckIntervalMinutes: '60',
  };
}

function formatDateTimeRange(start: string, end: string) {
  return `${new Date(start).toLocaleString()} to ${new Date(end).toLocaleString()}`;
}

function sectionLabel(section: CompanySectionId) {
  switch (section) {
    case 'overview':
      return 'Overview';
    case 'sites':
      return 'Sites';
    case 'guards':
      return 'Guards';
    case 'recruitment':
      return 'Recruitment';
    case 'shifts':
      return 'Shift Ops';
    case 'timesheets':
      return 'Timesheets';
    case 'incidents':
      return 'Incidents';
    case 'alerts':
      return 'Safety Alerts';
    case 'invoices':
      return 'Invoices';
    default:
      return section;
  }
}

function countUniqueGuards(shiftsForSite: Shift[]) {
  return new Set(
    shiftsForSite
      .map((shift) => shift.guard?.id ?? shift.guardId)
      .filter((guardId): guardId is number => typeof guardId === 'number'),
  ).size;
}

export function CompanyDashboardScreen({ user }: CompanyDashboardScreenProps) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const isDesktopWeb = width >= 1180;

  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [guards, setGuards] = useState<GuardProfile[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [alerts, setAlerts] = useState<SafetyAlert[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
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
  const [activeSection, setActiveSection] = useState<CompanySectionId>('overview');

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
        alertRows,
        timesheetRows,
        notificationRows,
        attachmentRows,
        auditRows,
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
        listCompanySafetyAlerts(),
        listCompanyTimesheets(),
        listCompanyNotifications(),
        listCompanyAttachments(),
        listCompanyAuditLogs(),
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
      setApplications(applicationsData.filter((application) => application.job?.company?.id === companyId));
      setIncidents(incidentRows);
      setAlerts(alertRows);
      setTimesheets(timesheetRows);
      setNotifications(notificationRows);
      setAttachments(attachmentRows);
      setAuditLogs(auditRows);
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
    const baseDraft = existingSite ? siteDraftFor(existingSite) : createFallbackSiteDraft();
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

  async function handleApproveGuard(guardId: number) {
    try {
      await approveGuard(guardId);
      await loadData();
      Alert.alert('Guard approved', 'The guard is now active and can log in.');
    } catch (error) {
      Alert.alert('Approval failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleAcknowledgeAlert(id: number) {
    try {
      await acknowledgeSafetyAlert(id);
      await loadData();
      Alert.alert('Alert acknowledged', 'The safety alert is now acknowledged.');
    } catch (error) {
      Alert.alert('Acknowledge failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async function handleCloseAlert(id: number) {
    try {
      await closeSafetyAlert(id);
      await loadData();
      Alert.alert('Alert resolved', 'The safety alert has been closed.');
    } catch (error) {
      Alert.alert('Resolve failed', error instanceof Error ? error.message : 'Unknown error');
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

  const pendingApplications = useMemo(
    () => applications.filter((application) => application.status === 'submitted'),
    [applications],
  );
  const openJobs = useMemo(() => jobs.filter((job) => job.status === 'open'), [jobs]);
  const filledJobs = useMemo(() => jobs.filter((job) => job.status === 'filled'), [jobs]);
  const submittedTimesheets = useMemo(
    () => timesheets.filter((timesheet) => timesheet.approvalStatus === 'submitted'),
    [timesheets],
  );
  const openAlerts = useMemo(() => alerts.filter((alert) => alert.status !== 'closed'), [alerts]);
  const pendingGuardApprovals = useMemo(
    () => guards.filter((guard) => guard.approvalStatus === 'pending' || guard.status === 'pending'),
    [guards],
  );
  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => notification.status === 'unread'),
    [notifications],
  );
  const recentNotifications = useMemo(() => notifications.slice(0, 5), [notifications]);
  const recentAttachments = useMemo(() => attachments.slice(0, 5), [attachments]);
  const recentAuditLogs = useMemo(() => auditLogs.slice(0, 5), [auditLogs]);
  const activeShifts = useMemo(() => shifts.filter((shift) => shift.status === 'in_progress'), [shifts]);
  const scheduledShifts = useMemo(() => shifts.filter((shift) => shift.status === 'scheduled'), [shifts]);
  const linkedGuardIds = useMemo(
    () => new Set(assignments.map((assignment) => assignment.guard?.id ?? assignment.guardId)),
    [assignments],
  );
  const linkedGuards = useMemo(
    () => guards.filter((guard) => linkedGuardIds.has(guard.id)),
    [guards, linkedGuardIds],
  );
  const openIncidentCount = useMemo(
    () => incidents.filter((incident) => incident.status === 'open').length,
    [incidents],
  );

  const siteSummaries = useMemo(
    () =>
      Array.from(
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
      })),
    [incidents, shifts],
  );

  const statItems = [
    { label: 'Managed Sites', value: sites.length, tone: '#0f766e' },
    { label: 'Linked Guards', value: linkedGuards.length, tone: '#1d4ed8' },
    { label: 'Live Shifts', value: activeShifts.length, tone: '#7c3aed' },
    { label: 'Open Alerts', value: openAlerts.length, tone: '#b91c1c' },
    { label: 'Submitted Timesheets', value: submittedTimesheets.length, tone: '#b45309' },
  ];

  const sectionItems: Array<{ id: CompanySectionId; label: string; description: string }> = [
    { id: 'overview', label: 'Overview', description: 'Command center, metrics, and live activity.' },
    { id: 'sites', label: 'Sites', description: 'Manage client sites and welfare settings.' },
    { id: 'guards', label: 'Guards', description: 'View linked guards and operational status.' },
    { id: 'recruitment', label: 'Recruitment', description: 'Advertise jobs and hire applicants.' },
    { id: 'shifts', label: 'Shift Ops', description: 'Track live shifts, patrols, and compliance.' },
    { id: 'timesheets', label: 'Timesheets', description: 'Review submitted hours and approvals.' },
    { id: 'incidents', label: 'Incidents', description: 'Monitor site issues and resolutions.' },
    { id: 'alerts', label: 'Safety Alerts', description: 'Respond to welfare and panic alerts from guards.' },
    { id: 'invoices', label: 'Invoices', description: 'Prepare client billing by site and work period.' },
  ];

  function renderOverviewSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={[styles.sectionHeaderCard, isDesktopWeb && styles.sectionHeaderCardDesktop]}>
          <View style={styles.sectionHeaderCopy}>
            <Text style={styles.sectionEyebrow}>Operations Control</Text>
            <Text style={[styles.sectionTitle, isDesktopWeb && styles.sectionTitleOnDark]}>Company Dashboard</Text>
            <Text style={[styles.sectionSubtitle, isDesktopWeb && styles.sectionSubtitleOnDark]}>
              Monitor sites, guards, live shifts, incidents, and client billing from one desktop view.
            </Text>
          </View>
          <View style={styles.metricGrid}>
            {statItems.map((item) => (
              <View key={item.label} style={styles.metricCard}>
                <Text style={[styles.metricValue, { color: item.tone }]}>{item.value}</Text>
                <Text style={styles.metricLabel}>{item.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard
            title="Operations Overview"
            subtitle={`Live shifts: ${activeShifts.length} | Upcoming shifts: ${scheduledShifts.length}`}
            style={styles.desktopPanel}
          >
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Sites under management: {siteSummaries.length}</Text>
              <Text style={styles.helperText}>Linked guards: {linkedGuards.length}</Text>
              <Text style={styles.helperText}>Pending recruitment applications: {pendingApplications.length}</Text>
              <Text style={styles.helperText}>Open incidents: {openIncidentCount}</Text>
              <Text style={styles.helperText}>Open safety alerts: {openAlerts.length}</Text>
              <Text style={styles.helperText}>Submitted timesheets: {submittedTimesheets.length}</Text>
            </View>
          </FeatureCard>

          <FeatureCard title="Guard Team Snapshot" subtitle={`Linked guards: ${linkedGuards.length}`} style={styles.desktopPanel}>
            {linkedGuards.length === 0 ? (
              <Text style={styles.helperText}>No guards have been linked yet.</Text>
            ) : (
              linkedGuards.slice(0, 4).map((guard) => {
                const guardAssignments = assignments.filter((assignment) => (assignment.guard?.id ?? assignment.guardId) === guard.id);
                return (
                  <View key={guard.id} style={styles.rowCard}>
                    <Text style={styles.listTitle}>{guard.fullName}</Text>
                    <Text style={styles.helperText}>Status: {guard.status}</Text>
                    <Text style={styles.helperText}>Assignments: {guardAssignments.length}</Text>
                  </View>
                );
              })
            )}
          </FeatureCard>

          <FeatureCard title="Safety Alerts" subtitle={`${openAlerts.length} open or acknowledged`} style={styles.desktopPanel}>
            {alerts.length === 0 ? (
              <Text style={styles.helperText}>No manual safety alerts have been raised yet.</Text>
            ) : (
              openAlerts.slice(0, 4).map((alert) => (
                <View key={alert.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{alert.type.toUpperCase()}</Text>
                  <Text style={styles.helperText}>{alert.message}</Text>
                  <Text style={styles.helperText}>
                    {alert.status} | {alert.guard?.fullName || 'Unknown guard'} | {alert.shift?.siteName || 'Unknown site'}
                  </Text>
                </View>
              ))
            )}
          </FeatureCard>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Site Activity" subtitle="Every live operation should belong to a site." style={styles.desktopPanel}>
            {siteSummaries.length === 0 ? (
              <Text style={styles.helperText}>Create a site to start running controlled operations.</Text>
            ) : (
              siteSummaries.map((siteSummary) => (
                <View key={siteSummary.name} style={styles.tableRowCard}>
                  <Text style={styles.listTitle}>{siteSummary.name}</Text>
                  <View style={styles.inlineStats}>
                    <Text style={styles.helperText}>Live shifts: {siteSummary.liveShifts}</Text>
                    <Text style={styles.helperText}>Upcoming: {siteSummary.upcomingShifts}</Text>
                    <Text style={styles.helperText}>Guards: {siteSummary.guardIds.size}</Text>
                    <Text style={styles.helperText}>Open incidents: {siteSummary.incidents}</Text>
                  </View>
                </View>
              ))
            )}
          </FeatureCard>

          <FeatureCard title="Urgent Items" subtitle="What needs action right now." style={styles.desktopPanel}>
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Pending hires: {pendingApplications.length}</Text>
              <Text style={styles.helperText}>Pending guard approvals: {pendingGuardApprovals.length}</Text>
              <Text style={styles.helperText}>Submitted timesheets to approve: {submittedTimesheets.length}</Text>
              <Text style={styles.helperText}>Open incidents to resolve: {openIncidentCount}</Text>
              <Text style={styles.helperText}>Open safety alerts: {openAlerts.length}</Text>
              <Text style={styles.helperText}>Shifts currently in progress: {activeShifts.length}</Text>
            </View>
          </FeatureCard>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard
            title="Control Room Notifications"
            subtitle={`${unreadNotifications.length} unread across company operations`}
            style={styles.desktopPanel}
          >
            {recentNotifications.length === 0 ? (
              <Text style={styles.helperText}>No notifications yet. Alerts, timesheets, and incidents will appear here.</Text>
            ) : (
              recentNotifications.map((notification) => (
                <View key={notification.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{notification.title}</Text>
                  <Text style={styles.helperText}>{notification.message}</Text>
                  <Text style={styles.helperText}>
                    {notification.status} | {new Date(notification.createdAt).toLocaleString()}
                  </Text>
                </View>
              ))
            )}
          </FeatureCard>

          <FeatureCard
            title="Evidence & Attachments"
            subtitle={`${attachments.length} uploaded records across incidents, logs, and shifts`}
            style={styles.desktopPanel}
          >
            {recentAttachments.length === 0 ? (
              <Text style={styles.helperText}>No evidence uploaded yet.</Text>
            ) : (
              recentAttachments.map((attachment) => (
                <View key={attachment.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{attachment.fileName}</Text>
                  <Text style={styles.helperText}>
                    {attachment.entityType} #{attachment.entityId}
                  </Text>
                  <Text style={styles.helperText}>{new Date(attachment.createdAt).toLocaleString()}</Text>
                </View>
              ))
            )}
          </FeatureCard>
        </View>

        <FeatureCard
          title="Audit Trail"
          subtitle={`${auditLogs.length} company audit events recorded`}
          style={styles.desktopPanel}
        >
          {recentAuditLogs.length === 0 ? (
            <Text style={styles.helperText}>No audit entries available yet.</Text>
          ) : (
            recentAuditLogs.map((entry) => (
              <View key={entry.id} style={styles.tableRowCard}>
                <Text style={styles.listTitle}>{entry.action}</Text>
                <Text style={styles.helperText}>
                  {entry.entityType}
                  {entry.entityId ? ` #${entry.entityId}` : ''}
                </Text>
                <Text style={styles.helperText}>{new Date(entry.createdAt).toLocaleString()}</Text>
              </View>
            ))
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderSitesSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Site Management</Text>
          <Text style={styles.sectionSubtitle}>
            Create and manage client sites. Jobs, shifts, patrols, incidents, and welfare checks should all live under a site.
          </Text>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Create Site" subtitle="Register a client site before assigning jobs or shifts." style={styles.desktopPanel}>
            <TextInput style={styles.input} placeholder="Site name" value={siteName} onChangeText={setSiteName} />
            <TextInput style={styles.input} placeholder="Client name" value={clientName} onChangeText={setClientName} />
            <TextInput style={styles.input} placeholder="Site address" value={siteAddress} onChangeText={setSiteAddress} />
            <TextInput style={styles.input} placeholder="Site contact details" value={siteContactDetails} onChangeText={setSiteContactDetails} />
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
          </FeatureCard>

          <FeatureCard title="Company Setup" subtitle={company ? company.name : 'Loading company profile...'} style={styles.desktopPanel}>
            <TextInput style={styles.input} placeholder="Company name" value={companyName} onChangeText={setCompanyName} />
            <TextInput style={styles.input} placeholder="Company number" value={companyNumber} onChangeText={setCompanyNumber} />
            <TextInput style={styles.input} placeholder="Address" value={address} onChangeText={setAddress} />
            <TextInput style={styles.input} placeholder="Contact details" value={contactDetails} onChangeText={setContactDetails} />
            <Pressable style={styles.button} onPress={handleSaveProfile}>
              <Text style={styles.buttonText}>Save Profile</Text>
            </Pressable>
          </FeatureCard>
        </View>

        <FeatureCard title="Managed Sites" subtitle={`${sites.length} configured`} style={styles.desktopPanel}>
          {sites.length === 0 ? (
            <Text style={styles.helperText}>No sites yet. Start with your first active client site.</Text>
          ) : (
            sites.map((site) => {
              const draft = siteDraftFor(site);
              const siteShifts = shifts.filter((shift) => (shift.siteId ?? shift.site?.id) === site.id || shift.siteName === site.name);
              const siteIncidents = incidents.filter((incident) => incident.shift?.siteName === site.name && incident.status !== 'resolved');
              return (
                <View key={site.id} style={styles.sectionRecord}>
                  <View style={styles.recordHeader}>
                    <View>
                      <Text style={styles.recordTitle}>{site.name}</Text>
                      <Text style={styles.helperText}>{site.clientName || 'Client not set'} | {site.status}</Text>
                    </View>
                    <View style={styles.inlineStats}>
                      <Text style={styles.helperText}>Guards: {countUniqueGuards(siteShifts)}</Text>
                      <Text style={styles.helperText}>Live shifts: {siteShifts.filter((shift) => shift.status === 'in_progress').length}</Text>
                      <Text style={styles.helperText}>Incidents: {siteIncidents.length}</Text>
                    </View>
                  </View>
                  <View style={[styles.formGrid, isDesktopWeb && styles.formGridDesktop]}>
                    <TextInput style={styles.input} placeholder="Site name" value={draft.name} onChangeText={(value: string) => updateSiteDraft(site.id, 'name', value)} />
                    <TextInput style={styles.input} placeholder="Client name" value={draft.clientName} onChangeText={(value: string) => updateSiteDraft(site.id, 'clientName', value)} />
                    <TextInput style={styles.input} placeholder="Address" value={draft.address} onChangeText={(value: string) => updateSiteDraft(site.id, 'address', value)} />
                    <TextInput style={styles.input} placeholder="Contact details" value={draft.contactDetails} onChangeText={(value: string) => updateSiteDraft(site.id, 'contactDetails', value)} />
                    <TextInput style={styles.input} placeholder="Status" value={draft.status} onChangeText={(value: string) => updateSiteDraft(site.id, 'status', value)} />
                    <TextInput
                      style={styles.input}
                      placeholder="Welfare check interval minutes"
                      keyboardType="number-pad"
                      value={draft.welfareCheckIntervalMinutes}
                      onChangeText={(value: string) => updateSiteDraft(site.id, 'welfareCheckIntervalMinutes', value)}
                    />
                  </View>
                  <Pressable style={styles.button} onPress={() => handleUpdateSite(site.id)}>
                    <Text style={styles.buttonText}>Save Site</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderGuardsSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Guard Team</Text>
          <Text style={styles.sectionSubtitle}>
            Existing guards should be tied to sites, shifts, and live operational activity.
          </Text>
        </View>

        <FeatureCard title="Pending Guard Approvals" subtitle={`${pendingGuardApprovals.length} awaiting activation`} style={styles.desktopPanel}>
          {pendingGuardApprovals.length === 0 ? (
            <Text style={styles.helperText}>No guard approvals are waiting right now.</Text>
          ) : (
            pendingGuardApprovals.map((guard) => (
              <View key={guard.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View>
                    <Text style={styles.recordTitle}>{guard.fullName}</Text>
                    <Text style={styles.helperText}>
                      SIA: {guard.siaLicenseNumber || guard.siaLicenceNumber || 'Not supplied'}
                    </Text>
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>{guard.approvalStatus || guard.status}</Text>
                  </View>
                </View>
                <Text style={styles.helperText}>Phone: {guard.phone || 'Not supplied'}</Text>
                <Pressable style={styles.button} onPress={() => handleApproveGuard(guard.id)}>
                  <Text style={styles.buttonText}>Approve Guard</Text>
                </Pressable>
              </View>
            ))
          )}
        </FeatureCard>

        <FeatureCard title="Linked Guards" subtitle={`${linkedGuards.length} linked to this company`} style={styles.desktopPanel}>
          {linkedGuards.length === 0 ? (
            <Text style={styles.helperText}>Guards will appear here after recruitment and assignment.</Text>
          ) : (
            linkedGuards.map((guard) => {
              const guardAssignments = assignments.filter((assignment) => (assignment.guard?.id ?? assignment.guardId) === guard.id);
              const guardShifts = shifts.filter((shift) => (shift.guard?.id ?? shift.guardId) === guard.id);
              const guardTimesheets = timesheets.filter((timesheet) => (timesheet.guard?.id ?? timesheet.guardId) === guard.id);
              return (
                <View key={guard.id} style={styles.sectionRecord}>
                  <View style={styles.recordHeader}>
                    <View>
                      <Text style={styles.recordTitle}>{guard.fullName}</Text>
                      <Text style={styles.helperText}>SIA: {guard.siaLicenseNumber || guard.siaLicenceNumber || 'Not supplied'}</Text>
                    </View>
                    <View style={styles.statusPill}>
                      <Text style={styles.statusPillText}>{guard.status}</Text>
                    </View>
                  </View>
                  <View style={styles.inlineStats}>
                    <Text style={styles.helperText}>Assignments: {guardAssignments.length}</Text>
                    <Text style={styles.helperText}>Shifts: {guardShifts.length}</Text>
                    <Text style={styles.helperText}>Timesheets: {guardTimesheets.length}</Text>
                  </View>
                  {guardAssignments.length > 0 ? (
                    <Text style={styles.helperText}>
                      Sites: {guardAssignments
                        .map((assignment) => assignment.job?.site?.name || assignment.job?.title || 'Assigned')
                        .join(' | ')}
                    </Text>
                  ) : null}
                </View>
              );
            })
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderRecruitmentSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Recruitment & Open Jobs</Text>
          <Text style={styles.sectionSubtitle}>
            Use jobs only for recruitment. Once accepted, guards move into site-based shift operations.
          </Text>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Advertise Job" subtitle={`Open jobs: ${openJobs.length}`} style={styles.desktopPanel}>
            <View style={styles.stackedForm}>
              {sites.length > 0 ? <Text style={styles.helperText}>Site IDs: {sites.map((site) => `${site.id}=${site.name}`).join(' | ')}</Text> : null}
              <TextInput
                style={styles.stackedInput}
                placeholder="Site ID for this job (optional)"
                keyboardType="number-pad"
                value={jobSiteId}
                onChangeText={setJobSiteId}
              />
              <TextInput style={styles.stackedInput} placeholder="Job title" value={jobTitle} onChangeText={setJobTitle} />
              <TextInput
                style={[styles.stackedInput, styles.multiLineInput]}
                placeholder="Job description"
                multiline
                value={jobDescription}
                onChangeText={setJobDescription}
              />
              <TextInput
                style={styles.stackedInput}
                placeholder="Guards required"
                keyboardType="number-pad"
                value={guardsRequired}
                onChangeText={setGuardsRequired}
              />
              <TextInput
                style={styles.stackedInput}
                placeholder="Hourly rate"
                keyboardType="decimal-pad"
                value={hourlyRate}
                onChangeText={setHourlyRate}
              />
              <Pressable style={styles.button} onPress={handleCreateJob} disabled={submittingJob}>
                <Text style={styles.buttonText}>{submittingJob ? 'Creating job...' : 'Create Job'}</Text>
              </Pressable>
            </View>
          </FeatureCard>

          <FeatureCard title="Open Jobs" subtitle={`${jobs.length} total`} style={styles.desktopPanel}>
            {jobs.length === 0 ? (
              <Text style={styles.helperText}>No jobs have been advertised yet.</Text>
            ) : (
              jobs.map((job) => (
                <View key={job.id} style={styles.tableRowCard}>
                  <Text style={styles.listTitle}>{job.title}</Text>
                  <Text style={styles.helperText}>{job.description || 'No description provided'}</Text>
                  <View style={styles.inlineStats}>
                    <Text style={styles.helperText}>Status: {job.status}</Text>
                    <Text style={styles.helperText}>Rate: {job.hourlyRate}</Text>
                    <Text style={styles.helperText}>Site: {job.site?.name || 'Not linked'}</Text>
                  </View>
                </View>
              ))
            )}
          </FeatureCard>
        </View>

        <FeatureCard title="Recruitment Pipeline" subtitle={`Pending applications: ${pendingApplications.length}`} style={styles.desktopPanel}>
          {pendingApplications.length === 0 ? (
            <Text style={styles.helperText}>New applications will appear here for review and hiring.</Text>
          ) : (
            pendingApplications.map((application) => {
              const draft = draftFor(application.id);
              return (
                <View key={application.id} style={styles.sectionRecord}>
                  <View style={styles.recordHeader}>
                    <View>
                      <Text style={styles.recordTitle}>{application.guard?.fullName || `Guard #${application.guardId}`}</Text>
                      <Text style={styles.helperText}>Applied for {application.job?.title || `Job #${application.jobId}`}</Text>
                    </View>
                    <View style={styles.statusPill}>
                      <Text style={styles.statusPillText}>{application.status}</Text>
                    </View>
                  </View>
                  <View style={[styles.formGrid, isDesktopWeb && styles.formGridDesktop]}>
                    <TextInput style={styles.input} placeholder="Site ID" keyboardType="number-pad" value={draft.siteId} onChangeText={(value: string) => updateHireDraft(application.id, 'siteId', value)} />
                    <TextInput style={styles.input} placeholder="Site name" value={draft.siteName} onChangeText={(value: string) => updateHireDraft(application.id, 'siteName', value)} />
                    <TextInput style={styles.input} placeholder="Shift start ISO" value={draft.start} onChangeText={(value: string) => updateHireDraft(application.id, 'start', value)} />
                    <TextInput style={styles.input} placeholder="Shift end ISO" value={draft.end} onChangeText={(value: string) => updateHireDraft(application.id, 'end', value)} />
                  </View>
                  <Pressable style={styles.button} onPress={() => handleHire(application)}>
                    <Text style={styles.buttonText}>Hire + Create Shift</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderShiftSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Shift Operations</Text>
          <Text style={styles.sectionSubtitle}>
            Every live shift should become the operational container for check-in, welfare calls, patrols, logs, incidents, and attendance.
          </Text>
        </View>

        <FeatureCard title="Live & Upcoming Shifts" subtitle={`${activeShifts.length} live | ${scheduledShifts.length} upcoming`} style={styles.desktopPanel}>
          {shifts.length === 0 ? (
            <Text style={styles.helperText}>No shifts are currently scheduled.</Text>
          ) : (
            shifts.map((shift) => (
              <View key={shift.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View>
                    <Text style={styles.recordTitle}>{shift.siteName || 'Unassigned site'}</Text>
                    <Text style={styles.helperText}>{formatDateTimeRange(shift.start, shift.end)}</Text>
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>{shift.status}</Text>
                  </View>
                </View>
                <View style={styles.inlineStats}>
                  <Text style={styles.helperText}>Guard: {shift.guard?.fullName || `#${shift.guard?.id ?? shift.guardId ?? 'N/A'}`}</Text>
                  <Text style={styles.helperText}>Check calls: hourly</Text>
                  <Text style={styles.helperText}>Patrol/logs: tracked inside shift</Text>
                </View>
              </View>
            ))
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderTimesheetSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Timesheets</Text>
          <Text style={styles.sectionSubtitle}>
            Guards submit worked time after completed shifts. Company admins review and approve submitted hours.
          </Text>
        </View>

        <FeatureCard title="Submitted & Completed Timesheets" subtitle={`${submittedTimesheets.length} awaiting approval`} style={styles.desktopPanel}>
          {timesheets.length === 0 ? (
            <Text style={styles.helperText}>No timesheets are available yet.</Text>
          ) : (
            timesheets.map((timesheet) => (
              <View key={timesheet.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View>
                    <Text style={styles.recordTitle}>{timesheet.shift?.siteName || `Shift #${timesheet.shift?.id ?? timesheet.shiftId}`}</Text>
                    <Text style={styles.helperText}>
                      {timesheet.shift ? formatDateTimeRange(timesheet.shift.start, timesheet.shift.end) : 'Shift details unavailable'}
                    </Text>
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>{timesheet.approvalStatus}</Text>
                  </View>
                </View>
                <View style={styles.inlineStats}>
                  <Text style={styles.helperText}>Guard: {timesheet.guard?.fullName || `#${timesheet.guard?.id ?? timesheet.guardId ?? 'N/A'}`}</Text>
                  <Text style={styles.helperText}>Hours: {timesheet.hoursWorked}</Text>
                  <Text style={styles.helperText}>Submitted: {timesheet.submittedAt ? new Date(timesheet.submittedAt).toLocaleString() : 'Not yet'}</Text>
                </View>
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
      </View>
    );
  }

  function renderIncidentsSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Incident Reports</Text>
          <Text style={styles.sectionSubtitle}>
            Review incident activity by site, guard, and shift, then resolve issues from the operations desk.
          </Text>
        </View>

        <FeatureCard title="Open & Resolved Incidents" subtitle={`${openIncidentCount} open`} style={styles.desktopPanel}>
          {incidents.length === 0 ? (
            <Text style={styles.helperText}>No incident reports have been submitted yet.</Text>
          ) : (
            incidents.map((incident) => (
              <View key={incident.id} style={styles.sectionRecord}>
                  <View style={styles.recordHeader}>
                    <View>
                      <Text style={styles.recordTitle}>{incident.title}</Text>
                      <Text style={styles.helperText}>{incident.shift?.siteName || 'Unknown site'} | {incident.severity}</Text>
                    </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>{incident.status}</Text>
                  </View>
                </View>
                <Text style={styles.helperText}>{incident.notes}</Text>
                <View style={styles.inlineStats}>
                  <Text style={styles.helperText}>Guard: {incident.guard?.fullName || 'Unknown'}</Text>
                  <Text style={styles.helperText}>Location: {incident.locationText || 'Not supplied'}</Text>
                </View>
                {incident.status !== 'resolved' ? (
                  <Pressable style={styles.button} onPress={() => handleUpdateIncidentStatus(incident.id, 'resolved')}>
                    <Text style={styles.buttonText}>Mark Resolved</Text>
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderAlertsSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Safety Alerts</Text>
          <Text style={styles.sectionSubtitle}>
            Manual welfare and panic alerts raised by guards should be visible here for acknowledgement and closure.
          </Text>
        </View>

        <FeatureCard title="Open & Resolved Alerts" subtitle={`${openAlerts.length} open or acknowledged`} style={styles.desktopPanel}>
          {alerts.length === 0 ? (
            <Text style={styles.helperText}>No safety alerts have been raised yet.</Text>
          ) : (
            alerts.map((alert) => (
              <View key={alert.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View>
                    <Text style={styles.recordTitle}>{alert.type.toUpperCase()}</Text>
                    <Text style={styles.helperText}>
                      {alert.guard?.fullName || 'Unknown guard'} | {alert.shift?.siteName || 'Unknown site'}
                    </Text>
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>{alert.status}</Text>
                  </View>
                </View>
                <Text style={styles.helperText}>{alert.message}</Text>
                <View style={styles.inlineStats}>
                  <Text style={styles.helperText}>Priority: {alert.priority}</Text>
                  <Text style={styles.helperText}>Raised: {new Date(alert.createdAt).toLocaleString()}</Text>
                </View>
                {alert.status === 'open' ? (
                  <View style={styles.actionRow}>
                    <Pressable style={styles.button} onPress={() => handleAcknowledgeAlert(alert.id)}>
                      <Text style={styles.buttonText}>Acknowledge</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => handleCloseAlert(alert.id)}>
                      <Text style={styles.secondaryButtonText}>Resolve</Text>
                    </Pressable>
                  </View>
                ) : null}
                {alert.status === 'acknowledged' ? (
                  <Pressable style={styles.button} onPress={() => handleCloseAlert(alert.id)}>
                    <Text style={styles.buttonText}>Resolve Alert</Text>
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
        </FeatureCard>
      </View>
    );
  }

  function renderInvoicesSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Client Invoices</Text>
          <Text style={styles.sectionSubtitle}>
            Keep billing separate from recruitment and daily operations. Roll up approved hours by site and client period.
          </Text>
        </View>

        <FeatureCard
          title="Invoice Preparation"
          subtitle="Use approved timesheets and site activity to raise client invoices."
          style={styles.desktopPanel}
          ctaLabel="Create Invoice"
          onPress={() => Alert.alert('Invoice', 'Invoice generation flow is the next dedicated browser workflow.')}
        >
          <View style={styles.kpiList}>
            <Text style={styles.helperText}>Approved timesheets available: {timesheets.filter((row) => row.approvalStatus === 'approved').length}</Text>
            <Text style={styles.helperText}>Managed sites: {sites.length}</Text>
            <Text style={styles.helperText}>Current live shifts: {activeShifts.length}</Text>
          </View>
        </FeatureCard>
      </View>
    );
  }

  function renderActiveSection() {
    switch (activeSection) {
      case 'sites':
        return renderSitesSection();
      case 'guards':
        return renderGuardsSection();
      case 'recruitment':
        return renderRecruitmentSection();
      case 'shifts':
        return renderShiftSection();
      case 'timesheets':
        return renderTimesheetSection();
      case 'incidents':
        return renderIncidentsSection();
      case 'alerts':
        return renderAlertsSection();
      case 'invoices':
        return renderInvoicesSection();
      case 'overview':
      default:
        return renderOverviewSection();
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={[styles.pageShell, isDesktopWeb && styles.pageShellDesktop]}>
        <View style={[styles.adminLayout, isDesktopWeb && styles.adminLayoutDesktop]}>
          <View style={[styles.sidebar, !isDesktopWeb && styles.sidebarMobile]}>
            <View style={styles.sidebarHeader}>
              <Text style={styles.sidebarEyebrow}>Observant Security</Text>
              <Text style={styles.sidebarTitle}>Company Admin</Text>
              <Text style={styles.sidebarSubtitle}>
                Sites, recruitment, live operations, timesheets, and billing in one browser portal.
              </Text>
            </View>
            <View style={[styles.sidebarNav, !isDesktopWeb && styles.sidebarNavMobile]}>
              {sectionItems.map((section) => {
                const selected = section.id === activeSection;
                return (
                  <Pressable
                    key={section.id}
                    onPress={() => setActiveSection(section.id)}
                    style={[styles.sidebarLink, selected && styles.sidebarLinkActive, !isDesktopWeb && styles.sidebarLinkMobile]}
                  >
                    <Text style={[styles.sidebarLinkTitle, selected && styles.sidebarLinkTitleActive]}>{section.label}</Text>
                    {isDesktopWeb ? (
                      <Text style={[styles.sidebarLinkSubtitle, selected && styles.sidebarLinkSubtitleActive]}>{section.description}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.mainPanel}>
            <View style={styles.mainPanelHeader}>
              <Text style={styles.mainPanelTitle}>{sectionLabel(activeSection)}</Text>
              <Text style={styles.mainPanelSubtitle}>
                {sectionItems.find((section) => section.id === activeSection)?.description}
              </Text>
            </View>
            {renderActiveSection()}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#eef2f7' },
  content: { padding: 16, paddingBottom: 28 },
  pageShell: { gap: 16 },
  pageShellDesktop: {
    width: '100%',
    maxWidth: 1520,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  adminLayout: { gap: 16 },
  adminLayoutDesktop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 24,
  },
  sidebar: {
    backgroundColor: '#0f172a',
    borderRadius: 28,
    padding: 20,
    gap: 16,
  },
  sidebarMobile: {
    borderRadius: 22,
  },
  sidebarHeader: { gap: 8 },
  sidebarEyebrow: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  sidebarTitle: { color: '#fff', fontSize: 28, fontWeight: '700' },
  sidebarSubtitle: { color: '#cbd5e1', lineHeight: 20 },
  sidebarNav: { gap: 10 },
  sidebarNavMobile: { flexDirection: 'row', flexWrap: 'wrap' },
  sidebarLink: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    gap: 4,
  },
  sidebarLinkMobile: {
    minWidth: 120,
    flexGrow: 1,
  },
  sidebarLinkActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
  },
  sidebarLinkTitle: { color: '#f9fafb', fontWeight: '700', fontSize: 15 },
  sidebarLinkTitleActive: { color: '#1d4ed8' },
  sidebarLinkSubtitle: { color: '#94a3b8', fontSize: 12, lineHeight: 18 },
  sidebarLinkSubtitleActive: { color: '#475569' },
  mainPanel: { flex: 1, gap: 16 },
  mainPanelHeader: {
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  mainPanelTitle: { color: '#0f172a', fontSize: 30, fontWeight: '700' },
  mainPanelSubtitle: { color: '#475569', marginTop: 4 },
  sectionStack: { gap: 18 },
  sectionBanner: {
    backgroundColor: '#fff',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 20,
    gap: 6,
  },
  sectionHeaderCard: { gap: 16 },
  sectionHeaderCardDesktop: {
    backgroundColor: '#111827',
    borderRadius: 28,
    padding: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 24,
  },
  sectionHeaderCopy: { flex: 1, gap: 8 },
  sectionEyebrow: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  sectionTitle: { fontSize: 30, fontWeight: '700', color: '#0f172a' },
  sectionTitleOnDark: { color: '#fff' },
  sectionSubtitle: { color: '#475569', lineHeight: 22 },
  sectionSubtitleOnDark: { color: '#d1d5db' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metricCard: {
    minWidth: 160,
    flexGrow: 1,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#dbe4f0',
    gap: 4,
  },
  metricValue: { fontSize: 28, fontWeight: '700' },
  metricLabel: { color: '#374151', fontWeight: '600' },
  sectionColumns: { gap: 16 },
  sectionColumnsDesktop: { flexDirection: 'row', alignItems: 'flex-start' },
  desktopPanel: { marginBottom: 0, borderRadius: 20, padding: 20, flex: 1 },
  kpiList: { gap: 8 },
  sectionRecord: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 14,
    gap: 10,
  },
  recordHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  recordTitle: { color: '#111827', fontWeight: '700', fontSize: 16 },
  statusPill: {
    borderRadius: 999,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPillText: { color: '#1d4ed8', fontWeight: '700', fontSize: 12, textTransform: 'capitalize' },
  inlineStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  rowCard: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
    gap: 4,
  },
  tableRowCard: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
    gap: 8,
  },
  formGrid: { gap: 10 },
  formGridDesktop: { flexDirection: 'row', flexWrap: 'wrap' },
  stackedForm: { gap: 10, width: '100%' },
  stackedInput: {
    width: '100%',
    minWidth: 0,
    flexGrow: 0,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 10,
    backgroundColor: '#fff',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 10,
    backgroundColor: '#fff',
    flexGrow: 1,
    minWidth: 180,
  },
  multiLineInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  button: {
    backgroundColor: '#111827',
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  helperText: { color: '#4b5563' },
  listTitle: { color: '#111827', fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 8 },
  secondaryButton: {
    backgroundColor: '#e5e7eb',
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryButtonText: { color: '#111827', fontWeight: '600' },
});
