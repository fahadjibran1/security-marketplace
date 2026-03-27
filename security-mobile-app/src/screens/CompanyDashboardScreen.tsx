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
  createClient,
  createShift,
  formatApiErrorMessage,
  listCompanyAttachments,
  listCompanyAuditLogs,
  listCompanyDailyLogs,
  listCompanyGuards,
  listCompanyNotifications,
  listCompanySafetyAlerts,
  createJob,
  createSite,
  getMyCompany,
  hireJobApplication,
  listAssignments,
  listClients,
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
  updateClient,
  updateSite,
  updateTimesheet,
} from '../services/api';
import {
  Attachment,
  AuditLog,
  Assignment,
  AuthUser,
  Client,
  CompanyGuard,
  CompanyProfile,
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
} from '../types/models';

interface CompanyDashboardScreenProps {
  user: AuthUser;
}

type CompanySectionId =
  | 'overview'
  | 'clients'
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
  clientId: string;
  address: string;
  contactDetails: string;
  status: string;
  requiredGuardCount: string;
  operatingDays: string;
  operatingStartTime: string;
  operatingEndTime: string;
  welfareCheckIntervalMinutes: string;
  specialInstructions: string;
};

type ShiftDraft = {
  guardIds: number[];
  siteId: string;
  checkCallIntervalMinutes: string;
  shiftDate: string;
  additionalDates: string;
  startTime: string;
  endTime: string;
};

type ClientDraft = {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  status: string;
};

function defaultShiftStart() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  return start.toISOString().slice(0, 10);
}

function defaultShiftEnd() {
  return defaultShiftStart();
}

function defaultTime(hours: number, minutes = 0) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function createFallbackSiteDraft(): SiteDraft {
  return {
    name: '',
    clientId: '',
    address: '',
    contactDetails: '',
    status: 'active',
    requiredGuardCount: '1',
    operatingDays: 'Mon,Tue,Wed,Thu,Fri',
    operatingStartTime: '08:00',
    operatingEndTime: '18:00',
    welfareCheckIntervalMinutes: '60',
    specialInstructions: '',
  };
}

function createDefaultShiftDraft(): ShiftDraft {
  return {
    guardIds: [],
    siteId: '',
    checkCallIntervalMinutes: '60',
    shiftDate: defaultShiftStart(),
    additionalDates: '',
    startTime: defaultTime(20, 0),
    endTime: defaultTime(6, 0),
  };
}

function createClientDraft(client?: Client): ClientDraft {
  return {
    name: client?.name || '',
    contactName: client?.contactName || '',
    contactEmail: client?.contactEmail || '',
    contactPhone: client?.contactPhone || '',
    status: client?.status || 'active',
  };
}

function formatDateTimeRange(start: string, end: string) {
  return `${new Date(start).toLocaleString()} to ${new Date(end).toLocaleString()}`;
}

function combineDateAndTime(date: string, time: string) {
  return `${date}T${time}:00`;
}

function buildShiftDateTimes(date: string, startTime: string, endTime: string) {
  const startDate = new Date(combineDateAndTime(date, startTime));
  const endDate = new Date(combineDateAndTime(date, endTime));

  if (endDate <= startDate) {
    endDate.setDate(endDate.getDate() + 1);
  }

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

function parseDateList(primaryDate: string, extraDates: string) {
  return Array.from(
    new Set(
      [primaryDate, ...extraDates.split(',').map((value) => value.trim())].filter(Boolean),
    ),
  );
}

function weekdayOptions() {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
}

function toggleListValue(current: string[], value: string) {
  return current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function csvCell(value: string | number) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function toFiniteNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function showAlert(title: string, message: string) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(`${title}\n\n${message}`);
    return;
  }

  Alert.alert(title, message);
}

function sectionLabel(section: CompanySectionId) {
  switch (section) {
    case 'overview':
      return 'Overview';
    case 'clients':
      return 'Clients';
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

function createTextDownload(filename: string, contents: string, mimeType = 'text/plain;charset=utf-8') {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  const blob = new Blob([contents], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
  return true;
}

export function CompanyDashboardScreen({ user }: CompanyDashboardScreenProps) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const isDesktopWeb = width >= 1180;

  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [guards, setGuards] = useState<GuardProfile[]>([]);
  const [companyGuards, setCompanyGuards] = useState<CompanyGuard[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [alerts, setAlerts] = useState<SafetyAlert[]>([]);
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>([]);
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
  const [clientDrafts, setClientDrafts] = useState<Record<number, ClientDraft>>({});
  const [siteDrafts, setSiteDrafts] = useState<Record<number, SiteDraft>>({});
  const [clientDraftName, setClientDraftName] = useState('');
  const [clientDraftContactName, setClientDraftContactName] = useState('');
  const [clientDraftContactEmail, setClientDraftContactEmail] = useState('');
  const [clientDraftContactPhone, setClientDraftContactPhone] = useState('');
  const [clientDraftStatus, setClientDraftStatus] = useState('active');
  const [submittingClient, setSubmittingClient] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [siteClientId, setSiteClientId] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteContactDetails, setSiteContactDetails] = useState('');
  const [siteStatus, setSiteStatus] = useState('active');
  const [siteRequiredGuardCount, setSiteRequiredGuardCount] = useState('1');
  const [siteOperatingDays, setSiteOperatingDays] = useState<string[]>(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const [siteOperatingStartTime, setSiteOperatingStartTime] = useState('08:00');
  const [siteOperatingEndTime, setSiteOperatingEndTime] = useState('18:00');
  const [welfareCheckIntervalMinutes, setWelfareCheckIntervalMinutes] = useState('60');
  const [siteSpecialInstructions, setSiteSpecialInstructions] = useState('');
  const [submittingSite, setSubmittingSite] = useState(false);
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft>(createDefaultShiftDraft());
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);
  const [submittingShift, setSubmittingShift] = useState(false);
  const [savingCompanyProfile, setSavingCompanyProfile] = useState(false);
  const [savingSiteId, setSavingSiteId] = useState<number | null>(null);
  const [savingClientId, setSavingClientId] = useState<number | null>(null);
  const [hiringApplicationId, setHiringApplicationId] = useState<number | null>(null);
  const [approvingGuardId, setApprovingGuardId] = useState<number | null>(null);
  const [updatingIncidentId, setUpdatingIncidentId] = useState<number | null>(null);
  const [updatingAlertId, setUpdatingAlertId] = useState<number | null>(null);
  const [updatingTimesheetId, setUpdatingTimesheetId] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState<CompanySectionId>('overview');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  function pressHandlers(action: () => void) {
    return {
      onPress: action,
      onClick: action,
    } as const;
  }

  async function loadData() {
    try {
      setLoading(true);
      setLoadError(null);
      const [
        myCompanyResult,
        companiesResult,
        clientsResult,
        sitesResult,
        jobsResult,
        guardsResult,
        companyGuardsResult,
        assignmentsResult,
        shiftsResult,
        applicationsResult,
        incidentsResult,
        alertsResult,
        dailyLogsResult,
        timesheetsResult,
        notificationsResult,
        attachmentsResult,
        auditLogsResult,
      ] = await Promise.allSettled([
        getMyCompany(),
        listCompanies(),
        listClients(),
        listSites(),
        listJobs(),
        listGuards(),
        listCompanyGuards(),
        listAssignments(),
        listShifts(),
        listJobApplications(),
        listCompanyIncidents(),
        listCompanySafetyAlerts(),
        listCompanyDailyLogs(),
        listCompanyTimesheets(),
        listCompanyNotifications(),
        listCompanyAttachments(),
        listCompanyAuditLogs(),
      ]);

      const myCompany = myCompanyResult.status === 'fulfilled' ? myCompanyResult.value : null;
      const companiesData = companiesResult.status === 'fulfilled' ? companiesResult.value : [];
      const sitesData = sitesResult.status === 'fulfilled' ? sitesResult.value : [];
      const clientsData = clientsResult.status === 'fulfilled' ? clientsResult.value : [];
      const jobsData = jobsResult.status === 'fulfilled' ? jobsResult.value : [];
      const guardsData = guardsResult.status === 'fulfilled' ? guardsResult.value : [];
      const companyGuardRows = companyGuardsResult.status === 'fulfilled' ? companyGuardsResult.value : [];
      const assignmentRows = assignmentsResult.status === 'fulfilled' ? assignmentsResult.value : [];
      const shiftsData = shiftsResult.status === 'fulfilled' ? shiftsResult.value : [];
      const applicationsData = applicationsResult.status === 'fulfilled' ? applicationsResult.value : [];
      const incidentRows = incidentsResult.status === 'fulfilled' ? incidentsResult.value : [];
      const alertRows = alertsResult.status === 'fulfilled' ? alertsResult.value : [];
      const dailyLogRows = dailyLogsResult.status === 'fulfilled' ? dailyLogsResult.value : [];
      const timesheetRows = timesheetsResult.status === 'fulfilled' ? timesheetsResult.value : [];
      const notificationRows = notificationsResult.status === 'fulfilled' ? notificationsResult.value : [];
      const attachmentRows = attachmentsResult.status === 'fulfilled' ? attachmentsResult.value : [];
      const auditRows = auditLogsResult.status === 'fulfilled' ? auditLogsResult.value : [];

      const currentCompany =
        myCompany ||
        companiesData.find((entry) => entry.id === user.companyId || entry.user?.id === user.id) ||
        null;

      if (!currentCompany) {
        throw new Error('Company profile was not found for this account.');
      }

      const companyId = currentCompany?.id;

      setCompany(currentCompany);
      setCompanyName(currentCompany?.name || '');
      setCompanyNumber(currentCompany?.companyNumber || '');
      setAddress(currentCompany?.address || '');
      setContactDetails(currentCompany?.contactDetails || '');
      setClients(clientsData);
      setCompanyGuards(companyGuardRows);
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
      setDailyLogs(dailyLogRows);
      setTimesheets(timesheetRows);
      setNotifications(notificationRows);
      setAttachments(attachmentRows);
      setAuditLogs(auditRows);
    } catch (error) {
      setLoadError(formatApiErrorMessage(error, 'Failed to load the company dashboard.'));
    } finally {
      setLoading(false);
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

  function clientDraftFor(client: Client): ClientDraft {
    return clientDrafts[client.id] || createClientDraft(client);
  }

  function updateClientDraft(clientId: number, field: keyof ClientDraft, value: string) {
    const existingClient = clients.find((client) => client.id === clientId);
    const baseDraft = existingClient ? clientDraftFor(existingClient) : createClientDraft();
    setClientDrafts((current) => ({
      ...current,
      [clientId]: {
        ...baseDraft,
        [field]: value,
      },
    }));
  }

  function siteDraftFor(site: Site): SiteDraft {
    return (
      siteDrafts[site.id] || {
        name: site.name,
        clientId: site.client?.id ? String(site.client.id) : '',
        address: site.address,
        contactDetails: site.contactDetails || '',
        status: site.status,
        requiredGuardCount: String(site.requiredGuardCount ?? 1),
        operatingDays: site.operatingDays || '',
        operatingStartTime: site.operatingStartTime || '',
        operatingEndTime: site.operatingEndTime || '',
        welfareCheckIntervalMinutes: String(site.welfareCheckIntervalMinutes ?? 60),
        specialInstructions: site.specialInstructions || '',
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
    if (!siteClientId) {
      showAlert('Client required', 'Select a saved client before creating a site.');
      return;
    }

    try {
      setSubmittingSite(true);
      await createSite({
        name: siteName,
        clientId: Number(siteClientId),
        address: siteAddress,
        contactDetails: siteContactDetails || undefined,
        status: siteStatus,
        requiredGuardCount: Number(siteRequiredGuardCount) || 1,
        operatingDays: siteOperatingDays.join(','),
        operatingStartTime: siteOperatingStartTime || undefined,
        operatingEndTime: siteOperatingEndTime || undefined,
        welfareCheckIntervalMinutes: Number(welfareCheckIntervalMinutes) || 60,
        specialInstructions: siteSpecialInstructions || undefined,
      });
      setSiteName('');
      setSiteClientId('');
      setSiteAddress('');
      setSiteContactDetails('');
      setSiteStatus('active');
      setSiteRequiredGuardCount('1');
      setSiteOperatingDays(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
      setSiteOperatingStartTime('08:00');
      setSiteOperatingEndTime('18:00');
      setWelfareCheckIntervalMinutes('60');
      setSiteSpecialInstructions('');
      await loadData();
      showAlert('Site created', 'The site is now available for jobs, shifts, and live operations.');
    } catch (error) {
      showAlert('Create site failed', formatApiErrorMessage(error, 'Unable to create this site.'));
    } finally {
      setSubmittingSite(false);
    }
  }

  async function handleCreateClient() {
    try {
      setSubmittingClient(true);
      await createClient({
        name: clientDraftName,
        contactName: clientDraftContactName || undefined,
        contactEmail: clientDraftContactEmail || undefined,
        contactPhone: clientDraftContactPhone || undefined,
        status: clientDraftStatus,
      });
      setClientDraftName('');
      setClientDraftContactName('');
      setClientDraftContactEmail('');
      setClientDraftContactPhone('');
      setClientDraftStatus('active');
      await loadData();
      showAlert('Client created', 'The client is now available to link to company sites.');
    } catch (error) {
      showAlert('Create client failed', formatApiErrorMessage(error, 'Unable to create this client.'));
    } finally {
      setSubmittingClient(false);
    }
  }

  async function handleUpdateClient(clientId: number) {
    const client = clients.find((entry) => entry.id === clientId);
    if (!client) {
      showAlert('Client not found', 'The selected client could not be loaded.');
      return;
    }

    const draft = clientDraftFor(client);
    try {
      setSavingClientId(clientId);
      await updateClient(clientId, {
        name: draft.name,
        contactName: draft.contactName || undefined,
        contactEmail: draft.contactEmail || undefined,
        contactPhone: draft.contactPhone || undefined,
        status: draft.status,
      });
      await loadData();
      showAlert('Client updated', 'Client details have been saved.');
    } catch (error) {
      showAlert('Update client failed', formatApiErrorMessage(error, 'Unable to save this client.'));
    } finally {
      setSavingClientId(null);
    }
  }

  async function handleUpdateSite(siteId: number) {
    const site = sites.find((entry) => entry.id === siteId);
    if (!site) {
      showAlert('Site not found', 'The selected site could not be loaded.');
      return;
    }
    const draft = siteDraftFor(site);
    try {
      setSavingSiteId(siteId);
      await updateSite(siteId, {
        name: draft.name,
        clientId: draft.clientId ? Number(draft.clientId) : undefined,
        address: draft.address,
        contactDetails: draft.contactDetails || undefined,
        status: draft.status,
        requiredGuardCount: Number(draft.requiredGuardCount) || 1,
        operatingDays: draft.operatingDays || undefined,
        operatingStartTime: draft.operatingStartTime || undefined,
        operatingEndTime: draft.operatingEndTime || undefined,
        welfareCheckIntervalMinutes: Number(draft.welfareCheckIntervalMinutes) || 60,
        specialInstructions: draft.specialInstructions || undefined,
      });
      await loadData();
      showAlert('Site updated', 'Site details have been saved.');
    } catch (error) {
      showAlert('Update site failed', formatApiErrorMessage(error, 'Unable to save this site.'));
    } finally {
      setSavingSiteId(null);
    }
  }

  async function handleCreateJob() {
    try {
      setSubmittingJob(true);
      await createJob({
        companyId: company?.id,
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
      showAlert('Job created', 'The job is now open for guard applications.');
    } catch (error) {
      showAlert('Create job failed', formatApiErrorMessage(error, 'Unable to create this job.'));
    } finally {
      setSubmittingJob(false);
    }
  }

  async function handleCreateShift() {
    if (!shiftDraft.siteId) {
      showAlert('Site required', 'Choose a site ID before creating a shift.');
      return;
    }

    const selectedSite = sites.find((site) => site.id === Number(shiftDraft.siteId));

    if (!Number.isFinite(Number(shiftDraft.siteId)) || !selectedSite) {
      showAlert(
        'Invalid site ID',
        siteOptionsText
          ? `Use one of the listed site IDs.\n\n${siteOptionsText}`
          : 'Create a site first before scheduling shifts.',
      );
      return;
    }

    if (shiftDraft.guardIds.length === 0) {
      showAlert(
        'Guard required',
        linkedGuardOptionsText
          ? `Choose one or more linked guards.\n\n${linkedGuardOptionsText}`
          : 'Link a guard to the company before creating site shifts.',
      );
      return;
    }

    const shiftDates = parseDateList(shiftDraft.shiftDate, shiftDraft.additionalDates);
    if (shiftDates.length === 0) {
      showAlert('Shift date required', 'Enter at least one valid shift date.');
      return;
    }

    try {
      setSubmittingShift(true);
      let createdCount = 0;
      for (const date of shiftDates) {
        const { start, end } = buildShiftDateTimes(date, shiftDraft.startTime, shiftDraft.endTime);
        for (const guardId of shiftDraft.guardIds) {
          await createShift({
            guardId,
            siteId: selectedSite.id,
            checkCallIntervalMinutes: Number(shiftDraft.checkCallIntervalMinutes) || undefined,
            start,
            end,
            status: 'assigned',
          });
          createdCount += 1;
        }
      }
      setShiftDraft(createDefaultShiftDraft());
      await loadData();
      showAlert('Shift created', `${createdCount} site-based shift record(s) have been created.`);
    } catch (error) {
      showAlert('Create shift failed', formatApiErrorMessage(error, 'Unable to create this shift.'));
    } finally {
      setSubmittingShift(false);
    }
  }

  async function handleCreateInvoice() {
    if (!invoiceDraft) {
      showAlert('Invoice unavailable', 'Approve at least one timesheet before generating a client invoice.');
      return;
    }

    const downloaded = createTextDownload(invoiceDraft.fileName, invoiceDraft.csv, 'text/csv;charset=utf-8');
    showAlert(
      'Invoice created',
      `${downloaded ? 'Invoice CSV downloaded' : 'Invoice draft prepared'} for ${invoiceDraft.periodLabel}.\n\nTotal: ${formatCurrency(invoiceDraft.total)}`,
    );
  }

  async function handleSaveProfile() {
    try {
      setSavingCompanyProfile(true);
      const updatedCompany = await updateMyCompany({
        name: companyName,
        companyNumber,
        address,
        contactDetails,
      });
      setCompany(updatedCompany);
      showAlert('Profile updated', 'Your company onboarding details have been saved.');
    } catch (error) {
      showAlert('Profile update failed', formatApiErrorMessage(error, 'Unable to save the company profile.'));
    } finally {
      setSavingCompanyProfile(false);
    }
  }

  async function handleHire(application: JobApplication) {
    const draft = draftFor(application.id);
    try {
      setHiringApplicationId(application.id);
      await hireJobApplication(application.id, {
        createShift: true,
        siteId: draft.siteId ? Number(draft.siteId) : undefined,
        siteName: draft.siteName,
        start: draft.start,
        end: draft.end,
      });
      await loadData();
      showAlert('Guard hired', 'Assignment and first shift created successfully.');
    } catch (error) {
      showAlert('Hire failed', formatApiErrorMessage(error, 'Unable to hire this applicant.'));
    } finally {
      setHiringApplicationId(null);
    }
  }

  async function handleUpdateIncidentStatus(id: number, status: string) {
    try {
      setUpdatingIncidentId(id);
      await updateIncidentStatus(id, status);
      await loadData();
      showAlert('Incident updated', `Incident marked as ${status}.`);
    } catch (error) {
      showAlert('Incident update failed', formatApiErrorMessage(error, 'Unable to update this incident.'));
    } finally {
      setUpdatingIncidentId(null);
    }
  }

  async function handleApproveGuard(guardId: number) {
    try {
      setApprovingGuardId(guardId);
      await approveGuard(guardId);
      await loadData();
      showAlert('Guard linked', 'The guard has been added to your active company roster.');
    } catch (error) {
      showAlert('Approval failed', formatApiErrorMessage(error, 'Unable to approve this guard.'));
    } finally {
      setApprovingGuardId(null);
    }
  }

  async function handleAcknowledgeAlert(id: number) {
    try {
      setUpdatingAlertId(id);
      await acknowledgeSafetyAlert(id);
      await loadData();
      showAlert('Alert acknowledged', 'The safety alert is now acknowledged.');
    } catch (error) {
      showAlert('Acknowledge failed', formatApiErrorMessage(error, 'Unable to acknowledge this alert.'));
    } finally {
      setUpdatingAlertId(null);
    }
  }

  async function handleCloseAlert(id: number) {
    try {
      setUpdatingAlertId(id);
      await closeSafetyAlert(id);
      await loadData();
      showAlert('Alert resolved', 'The safety alert has been closed.');
    } catch (error) {
      showAlert('Resolve failed', formatApiErrorMessage(error, 'Unable to resolve this alert.'));
    } finally {
      setUpdatingAlertId(null);
    }
  }

  async function handleUpdateTimesheet(id: number, approvalStatus: string) {
    try {
      setUpdatingTimesheetId(id);
      await updateTimesheet(id, { approvalStatus });
      await loadData();
      showAlert('Timesheet updated', `Timesheet marked as ${approvalStatus}.`);
    } catch (error) {
      showAlert('Timesheet update failed', formatApiErrorMessage(error, 'Unable to update this timesheet.'));
    } finally {
      setUpdatingTimesheetId(null);
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
  const approvedTimesheets = useMemo(
    () => timesheets.filter((timesheet) => timesheet.approvalStatus === 'approved'),
    [timesheets],
  );
  const openAlerts = useMemo(() => alerts.filter((alert) => alert.status !== 'closed'), [alerts]);
  const completedShifts = useMemo(() => shifts.filter((shift) => shift.status === 'completed'), [shifts]);
  const pendingGuardApprovals = useMemo(
    () =>
      guards.filter((guard) => {
        const isPending = guard.approvalStatus === 'pending' || guard.status === 'pending';
        const alreadyLinked = companyGuards.some((companyGuard) => companyGuard.guard?.id === guard.id);
        return isPending && !alreadyLinked;
      }),
    [companyGuards, guards],
  );
  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => notification.status === 'unread'),
    [notifications],
  );
  const recentDailyLogs = useMemo(() => dailyLogs.slice(0, 8), [dailyLogs]);
  const recentNotifications = useMemo(() => notifications.slice(0, 5), [notifications]);
  const recentAttachments = useMemo(() => attachments.slice(0, 5), [attachments]);
  const recentAuditLogs = useMemo(() => auditLogs.slice(0, 5), [auditLogs]);
  const activeShifts = useMemo(() => shifts.filter((shift) => shift.status === 'in_progress'), [shifts]);
  const scheduledShifts = useMemo(
    () => shifts.filter((shift) => ['draft', 'scheduled', 'assigned'].includes(shift.status)),
    [shifts],
  );
  const linkedGuardIds = useMemo(
    () =>
      new Set([
        ...assignments.map((assignment) => assignment.guard?.id ?? assignment.guardId),
        ...companyGuards.map((companyGuard) => companyGuard.guard?.id),
      ]),
    [assignments, companyGuards],
  );
  const linkedGuards = useMemo(
    () => guards.filter((guard) => linkedGuardIds.has(guard.id)),
    [guards, linkedGuardIds],
  );
  const assignableGuards = useMemo(() => {
    const approvedGuardIds = new Set(
      companyGuards
        .filter((companyGuard) => companyGuard.status === 'ACTIVE')
        .map((companyGuard) => companyGuard.guard?.id)
        .filter((guardId): guardId is number => typeof guardId === 'number'),
    );

    return linkedGuards.filter((guard) => approvedGuardIds.has(guard.id));
  }, [companyGuards, linkedGuards]);
  const openIncidentCount = useMemo(
    () => incidents.filter((incident) => incident.status === 'open').length,
    [incidents],
  );
  const siteOptionsText = useMemo(
    () =>
      sites.length === 0
        ? ''
        : sites.map((site) => `${site.id}=${site.name}`).join(' | '),
    [sites],
  );
  const linkedGuardOptionsText = useMemo(
    () =>
      assignableGuards.length === 0
        ? ''
        : assignableGuards.map((guard) => `${guard.id}=${guard.fullName}`).join(' | '),
    [assignableGuards],
  );
  const selectedShift =
    shifts.find((shift) => shift.id === selectedShiftId) ||
    activeShifts[0] ||
    scheduledShifts[0] ||
    shifts[0] ||
    null;
  const selectedShiftDailyLogs = dailyLogs.filter((entry) => entry.shift?.id === selectedShift?.id);
  const selectedShiftIncidents = incidents.filter((incident) => incident.shift?.id === selectedShift?.id);
  const selectedShiftTimesheets = timesheets.filter((timesheet) => timesheet.shift?.id === selectedShift?.id);

  useEffect(() => {
    const selectedStillExists = selectedShiftId ? shifts.some((shift) => shift.id === selectedShiftId) : false;
    if ((!selectedShiftId || !selectedStillExists) && selectedShift?.id) {
      setSelectedShiftId(selectedShift.id);
    }
  }, [selectedShift?.id, selectedShiftId, shifts]);

  const invoiceDraft = useMemo(() => {
    if (!company || approvedTimesheets.length === 0) {
      return null;
    }

    const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
    const assignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
    const siteById = new Map(sites.map((site) => [site.id, site]));
    const periodStart = approvedTimesheets
      .map((timesheet) => new Date(timesheet.submittedAt || timesheet.createdAt))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const periodEnd = approvedTimesheets
      .map((timesheet) => new Date(timesheet.submittedAt || timesheet.createdAt))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const rows = approvedTimesheets.map((timesheet) => {
      const shift = timesheet.shift || shiftById.get(timesheet.shiftId);
      const assignment = shift?.assignmentId ? assignmentById.get(shift.assignmentId) : shift?.assignment;
      const linkedSite =
        (shift?.siteId ? siteById.get(shift.siteId) : undefined) ||
        shift?.site ||
        sites.find((site) => site.name === shift?.siteName);
      const siteName = linkedSite?.name || shift?.siteName || 'Unassigned Site';
      const explicitHoursWorked = toFiniteNumber(timesheet.hoursWorked);
      const workedMinutes = toFiniteNumber(timesheet.roundedMinutes ?? timesheet.workedMinutes);
      const hoursWorked =
        explicitHoursWorked > 0
          ? explicitHoursWorked
          : Math.max(0, workedMinutes / 60);
      const hourlyRate = toFiniteNumber(assignment?.job?.hourlyRate);
      const total = Number((hoursWorked * hourlyRate).toFixed(2));

      return {
        timesheetId: timesheet.id,
        siteName,
        guardName: timesheet.guard?.fullName || shift?.guard?.fullName || `Guard #${timesheet.guardId}`,
        shiftWindow:
          shift && shift.start && shift.end ? formatDateTimeRange(shift.start, shift.end) : 'Shift details unavailable',
        hoursWorked,
        hourlyRate,
        total,
      };
    });

    const siteTotals = Array.from(
      rows.reduce((map, row) => {
        const current = map.get(row.siteName) || { siteName: row.siteName, hours: 0, total: 0 };
        current.hours += row.hoursWorked;
        current.total += row.total;
        map.set(row.siteName, current);
        return map;
      }, new Map<string, { siteName: string; hours: number; total: number }>()),
    ).map(([, summary]) => summary);

    const invoiceTotal = siteTotals.reduce((sum, summary) => sum + summary.total, 0);
    const today = new Date();
    const invoiceNumber = `INV-${company.id}-${today.toISOString().slice(0, 10)}`;
    const periodLabel =
      periodStart && periodEnd
        ? `${periodStart.toLocaleDateString('en-GB')} to ${periodEnd.toLocaleDateString('en-GB')}`
        : today.toLocaleDateString('en-GB');

    const summaryLines = [
      `Invoice Number,${csvCell(invoiceNumber)}`,
      `Company,${csvCell(company.name)}`,
      `Billing Period,${csvCell(periodLabel)}`,
      '',
      'Site,Hours,Amount',
      ...siteTotals.map((summary) => `${csvCell(summary.siteName)},${summary.hours.toFixed(2)},${summary.total.toFixed(2)}`),
      '',
      'Timesheet ID,Site,Guard,Shift Window,Hours,Hourly Rate,Amount',
      ...rows.map(
        (row) =>
          `${row.timesheetId},${csvCell(row.siteName)},${csvCell(row.guardName)},${csvCell(row.shiftWindow)},${row.hoursWorked.toFixed(2)},${row.hourlyRate.toFixed(2)},${row.total.toFixed(2)}`,
      ),
    ].join('\n');

    return {
      invoiceNumber,
      periodLabel,
      total: invoiceTotal,
      siteTotals,
      csv: summaryLines,
      fileName: `${invoiceNumber}.csv`,
    };
  }, [approvedTimesheets, assignments, company, shifts, sites]);

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
    { id: 'clients', label: 'Clients', description: 'Create and maintain operational client records.' },
    { id: 'sites', label: 'Sites', description: 'Manage client-linked sites, staffing targets, and operating windows.' },
    { id: 'guards', label: 'Guards', description: 'View linked guards and operational status.' },
    { id: 'recruitment', label: 'Legacy Recruitment', description: 'Keep older job hiring available without driving daily operations.' },
    { id: 'shifts', label: 'Shift Ops', description: 'Plan site-based shifts and review live operational activity.' },
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
          <FeatureCard title="Company Setup" subtitle={company ? company.name : 'Loading company profile...'} style={styles.desktopPanel}>
            <TextInput style={styles.input} placeholder="Company name" value={companyName} onChangeText={setCompanyName} />
            <TextInput style={styles.input} placeholder="Company number" value={companyNumber} onChangeText={setCompanyNumber} />
            <TextInput style={styles.input} placeholder="Address" value={address} onChangeText={setAddress} />
            <TextInput style={styles.input} placeholder="Contact details" value={contactDetails} onChangeText={setContactDetails} />
            <Pressable style={[styles.button, savingCompanyProfile && styles.buttonDisabled]} {...pressHandlers(handleSaveProfile)} disabled={savingCompanyProfile}>
              <Text style={styles.buttonText}>{savingCompanyProfile ? 'Saving...' : 'Save Profile'}</Text>
            </Pressable>
          </FeatureCard>

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
              <Text style={styles.helperText}>Legacy guard approvals: {pendingGuardApprovals.length}</Text>
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

  function renderClientsSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Clients</Text>
          <Text style={styles.sectionSubtitle}>
            Keep client records separate from sites so shift planning always starts with a real operational account.
          </Text>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Create Client" subtitle={`${clients.length} client records`} style={styles.desktopPanel}>
            <TextInput style={styles.input} placeholder="Client name" value={clientDraftName} onChangeText={setClientDraftName} />
            <TextInput style={styles.input} placeholder="Contact name" value={clientDraftContactName} onChangeText={setClientDraftContactName} />
            <TextInput style={styles.input} placeholder="Contact email" value={clientDraftContactEmail} onChangeText={setClientDraftContactEmail} />
            <TextInput style={styles.input} placeholder="Contact phone" value={clientDraftContactPhone} onChangeText={setClientDraftContactPhone} />
            <TextInput style={styles.input} placeholder="Status" value={clientDraftStatus} onChangeText={setClientDraftStatus} />
            <Pressable style={[styles.button, submittingClient && styles.buttonDisabled]} {...pressHandlers(handleCreateClient)} disabled={submittingClient}>
              <Text style={styles.buttonText}>{submittingClient ? 'Creating client...' : 'Create Client'}</Text>
            </Pressable>
          </FeatureCard>

          <FeatureCard title="Client Directory" subtitle="Operational client contacts for sites and shifts." style={styles.desktopPanel}>
            {clients.length === 0 ? (
              <Text style={styles.helperText}>No clients yet. Create your first client before setting up sites.</Text>
            ) : (
              clients.map((client) => {
                const draft = clientDraftFor(client);
                const clientSites = sites.filter((site) => (site.client?.id ?? site.clientId) === client.id);
                return (
                  <View key={client.id} style={styles.sectionRecord}>
                    <View style={styles.recordHeader}>
                      <View style={styles.recordCopy}>
                        <Text style={styles.recordTitle}>{client.name}</Text>
                        <Text style={styles.helperText}>{client.status} | Sites: {clientSites.length}</Text>
                      </View>
                    </View>
                    <View style={[styles.formGrid, isDesktopWeb && styles.formGridDesktop]}>
                      <TextInput style={styles.input} placeholder="Client name" value={draft.name} onChangeText={(value: string) => updateClientDraft(client.id, 'name', value)} />
                      <TextInput style={styles.input} placeholder="Contact name" value={draft.contactName} onChangeText={(value: string) => updateClientDraft(client.id, 'contactName', value)} />
                      <TextInput style={styles.input} placeholder="Contact email" value={draft.contactEmail} onChangeText={(value: string) => updateClientDraft(client.id, 'contactEmail', value)} />
                      <TextInput style={styles.input} placeholder="Contact phone" value={draft.contactPhone} onChangeText={(value: string) => updateClientDraft(client.id, 'contactPhone', value)} />
                      <TextInput style={styles.input} placeholder="Status" value={draft.status} onChangeText={(value: string) => updateClientDraft(client.id, 'status', value)} />
                    </View>
                    <Pressable
                      style={[styles.button, savingClientId === client.id && styles.buttonDisabled]}
                      {...pressHandlers(() => handleUpdateClient(client.id))}
                      disabled={savingClientId === client.id}
                    >
                      <Text style={styles.buttonText}>{savingClientId === client.id ? 'Saving...' : 'Save Client'}</Text>
                    </Pressable>
                  </View>
                );
              })
            )}
          </FeatureCard>
        </View>
      </View>
    );
  }

  function renderSitesSection() {
    return (
      <View style={styles.sectionStack}>
        <View style={styles.sectionBanner}>
          <Text style={styles.sectionTitle}>Site Management</Text>
          <Text style={styles.sectionSubtitle}>
            Create and manage client-linked sites with staffing requirements, operating windows, and special instructions.
          </Text>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Create Site" subtitle="Register a site under a saved client before assigning shifts." style={styles.desktopPanel}>
            {clients.length === 0 ? (
              <Text style={styles.helperText}>Create a client first. Site setup now requires selecting a saved client.</Text>
            ) : null}
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Linked client</Text>
              <View style={styles.actionRow}>
                {clients.map((client) => {
                  const selected = siteClientId === String(client.id);
                  return (
                    <Pressable
                      key={client.id}
                      style={[styles.secondaryButton, selected && styles.button]}
                      {...pressHandlers(() => setSiteClientId(String(client.id)))}
                    >
                      <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{client.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <TextInput style={styles.input} placeholder="Site name" value={siteName} onChangeText={setSiteName} />
            <TextInput style={styles.input} placeholder="Site address" value={siteAddress} onChangeText={setSiteAddress} />
            <TextInput style={styles.input} placeholder="Site contact details" value={siteContactDetails} onChangeText={setSiteContactDetails} />
            <TextInput style={styles.input} placeholder="Required security guards" keyboardType="number-pad" value={siteRequiredGuardCount} onChangeText={setSiteRequiredGuardCount} />
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Operating days</Text>
              <View style={styles.actionRow}>
                {weekdayOptions().map((day) => {
                  const selected = siteOperatingDays.includes(day);
                  return (
                    <Pressable
                      key={day}
                      style={[styles.secondaryButton, selected && styles.button]}
                      {...pressHandlers(() => setSiteOperatingDays((current) => toggleListValue(current, day)))}
                    >
                      <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{day}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <TextInput style={styles.input} placeholder="Operating start time (HH:MM)" value={siteOperatingStartTime} onChangeText={setSiteOperatingStartTime} />
            <TextInput style={styles.input} placeholder="Operating end time (HH:MM)" value={siteOperatingEndTime} onChangeText={setSiteOperatingEndTime} />
            <TextInput
              style={styles.input}
              placeholder="Check call interval minutes"
              keyboardType="number-pad"
              value={welfareCheckIntervalMinutes}
              onChangeText={setWelfareCheckIntervalMinutes}
            />
            <TextInput style={styles.input} placeholder="Status" value={siteStatus} onChangeText={setSiteStatus} />
            <TextInput style={styles.input} placeholder="Special instructions / site notes" value={siteSpecialInstructions} onChangeText={setSiteSpecialInstructions} multiline />
            <Pressable
              style={[styles.button, submittingSite && styles.buttonDisabled]}
              {...pressHandlers(handleCreateSite)}
              disabled={submittingSite || clients.length === 0}
            >
              <Text style={styles.buttonText}>{submittingSite ? 'Creating site...' : 'Create Site'}</Text>
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
                    <View style={styles.recordCopy}>
                      <Text style={styles.recordTitle}>{site.name}</Text>
                      <Text style={styles.helperText}>
                        {site.client?.name || site.clientName || 'Client not set'} | {site.status}
                      </Text>
                    </View>
                    <View style={styles.inlineStats}>
                      <Text style={styles.helperText}>Required guards: {site.requiredGuardCount ?? 1}</Text>
                      <Text style={styles.helperText}>Guards: {countUniqueGuards(siteShifts)}</Text>
                      <Text style={styles.helperText}>Live shifts: {siteShifts.filter((shift) => shift.status === 'in_progress').length}</Text>
                      <Text style={styles.helperText}>Incidents: {siteIncidents.length}</Text>
                    </View>
                  </View>
                  <View style={[styles.formGrid, isDesktopWeb && styles.formGridDesktop]}>
                    <TextInput style={styles.input} placeholder="Site name" value={draft.name} onChangeText={(value: string) => updateSiteDraft(site.id, 'name', value)} />
                    <View style={styles.kpiList}>
                      <Text style={styles.helperText}>Linked client</Text>
                      <View style={styles.actionRow}>
                        {clients.map((client) => {
                          const selected = draft.clientId === String(client.id);
                          return (
                            <Pressable
                              key={client.id}
                              style={[styles.secondaryButton, selected && styles.button]}
                              {...pressHandlers(() => updateSiteDraft(site.id, 'clientId', String(client.id)))}
                            >
                              <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{client.name}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                    <TextInput style={styles.input} placeholder="Address" value={draft.address} onChangeText={(value: string) => updateSiteDraft(site.id, 'address', value)} />
                    <TextInput style={styles.input} placeholder="Contact details" value={draft.contactDetails} onChangeText={(value: string) => updateSiteDraft(site.id, 'contactDetails', value)} />
                    <TextInput style={styles.input} placeholder="Required security guards" keyboardType="number-pad" value={draft.requiredGuardCount} onChangeText={(value: string) => updateSiteDraft(site.id, 'requiredGuardCount', value)} />
                    <TextInput style={styles.input} placeholder="Operating days (Mon,Tue,...)" value={draft.operatingDays} onChangeText={(value: string) => updateSiteDraft(site.id, 'operatingDays', value)} />
                    <TextInput style={styles.input} placeholder="Operating start time (HH:MM)" value={draft.operatingStartTime} onChangeText={(value: string) => updateSiteDraft(site.id, 'operatingStartTime', value)} />
                    <TextInput style={styles.input} placeholder="Operating end time (HH:MM)" value={draft.operatingEndTime} onChangeText={(value: string) => updateSiteDraft(site.id, 'operatingEndTime', value)} />
                    <TextInput style={styles.input} placeholder="Status" value={draft.status} onChangeText={(value: string) => updateSiteDraft(site.id, 'status', value)} />
                    <TextInput
                      style={styles.input}
                      placeholder="Check call interval minutes"
                      keyboardType="number-pad"
                      value={draft.welfareCheckIntervalMinutes}
                      onChangeText={(value: string) => updateSiteDraft(site.id, 'welfareCheckIntervalMinutes', value)}
                    />
                    <TextInput style={styles.input} placeholder="Special instructions / site notes" value={draft.specialInstructions} onChangeText={(value: string) => updateSiteDraft(site.id, 'specialInstructions', value)} multiline />
                  </View>
                  <Pressable
                    style={[styles.button, savingSiteId === site.id && styles.buttonDisabled]}
                    {...pressHandlers(() => handleUpdateSite(site.id))}
                    disabled={savingSiteId === site.id}
                  >
                    <Text style={styles.buttonText}>{savingSiteId === site.id ? 'Saving...' : 'Save Site'}</Text>
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

        <FeatureCard title="Legacy Guard Approvals" subtitle={`${pendingGuardApprovals.length} older records still available to link`} style={styles.desktopPanel}>
          {pendingGuardApprovals.length === 0 ? (
            <Text style={styles.helperText}>No legacy pending guard records are waiting right now.</Text>
          ) : (
            pendingGuardApprovals.map((guard) => (
              <View key={guard.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View style={styles.recordCopy}>
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
                <Pressable
                  style={[styles.button, approvingGuardId === guard.id && styles.buttonDisabled]}
                  {...pressHandlers(() => handleApproveGuard(guard.id))}
                  disabled={approvingGuardId === guard.id}
                >
                  <Text style={styles.buttonText}>{approvingGuardId === guard.id ? 'Linking...' : 'Link Guard'}</Text>
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
                    <View style={styles.recordCopy}>
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
              <Pressable style={[styles.button, submittingJob && styles.buttonDisabled]} {...pressHandlers(handleCreateJob)} disabled={submittingJob}>
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
                    <View style={styles.recordCopy}>
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
                  <Pressable
                    style={[styles.button, hiringApplicationId === application.id && styles.buttonDisabled]}
                    {...pressHandlers(() => handleHire(application))}
                    disabled={hiringApplicationId === application.id}
                  >
                    <Text style={styles.buttonText}>{hiringApplicationId === application.id ? 'Hiring...' : 'Hire + Create Shift'}</Text>
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
            Schedule work by site, assign a guard directly, and manage all live activity from the shift context.
          </Text>
        </View>

        <View style={[styles.sectionColumns, isDesktopWeb && styles.sectionColumnsDesktop]}>
          <FeatureCard title="Schedule Shift" subtitle="Primary workflow: site -> shift -> assigned guard." style={styles.desktopPanel}>
            {assignableGuards.length > 0 ? (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>Select one site, choose one or more linked guards, then create the shift plan.</Text>
              </View>
            ) : (
              <Text style={styles.helperText}>Link a guard to the company roster first, then schedule that guard onto a site shift.</Text>
            )}
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Select site</Text>
              <View style={styles.actionRow}>
                {sites.map((site) => {
                  const selected = shiftDraft.siteId === String(site.id);
                  return (
                    <Pressable
                      key={site.id}
                      style={[styles.secondaryButton, selected && styles.button]}
                      {...pressHandlers(() => setShiftDraft((current) => ({ ...current, siteId: String(site.id) })))}
                    >
                      <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{site.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.kpiList}>
              <Text style={styles.helperText}>Assign guards</Text>
              <View style={styles.actionRow}>
                {assignableGuards.map((guard) => {
                  const selected = shiftDraft.guardIds.includes(guard.id);
                  return (
                    <Pressable
                      key={guard.id}
                      style={[styles.secondaryButton, selected && styles.button]}
                      {...pressHandlers(() =>
                        setShiftDraft((current) => ({
                          ...current,
                          guardIds: selected
                            ? current.guardIds.filter((id) => id !== guard.id)
                            : [...current.guardIds, guard.id],
                        }))
                      )}
                    >
                      <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{guard.fullName}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Shift date (YYYY-MM-DD)"
              value={shiftDraft.shiftDate}
              onChangeText={(value: string) => setShiftDraft((current) => ({ ...current, shiftDate: value }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Additional dates (comma separated YYYY-MM-DD)"
              value={shiftDraft.additionalDates}
              onChangeText={(value: string) => setShiftDraft((current) => ({ ...current, additionalDates: value }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Start time (HH:MM)"
              value={shiftDraft.startTime}
              onChangeText={(value: string) => setShiftDraft((current) => ({ ...current, startTime: value }))}
            />
            <TextInput
              style={styles.input}
              placeholder="End time (HH:MM)"
              value={shiftDraft.endTime}
              onChangeText={(value: string) => setShiftDraft((current) => ({ ...current, endTime: value }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Check call interval minutes"
              keyboardType="number-pad"
              value={shiftDraft.checkCallIntervalMinutes}
              onChangeText={(value: string) => setShiftDraft((current) => ({ ...current, checkCallIntervalMinutes: value }))}
            />
            <Pressable style={[styles.button, submittingShift && styles.buttonDisabled]} {...pressHandlers(handleCreateShift)} disabled={submittingShift}>
              <Text style={styles.buttonText}>{submittingShift ? 'Creating shift...' : 'Create Shift'}</Text>
            </Pressable>
          </FeatureCard>

          <FeatureCard title="Approved Guard Pool" subtitle={`${assignableGuards.length} active guards available for shift planning`} style={styles.desktopPanel}>
            {assignableGuards.length === 0 ? (
              <Text style={styles.helperText}>Linked guards will appear here after you add them to the company roster.</Text>
            ) : (
              assignableGuards.map((guard) => (
                <View key={guard.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{guard.fullName}</Text>
                  <Text style={styles.helperText}>Ready for direct site assignment</Text>
                </View>
              ))
            )}
          </FeatureCard>
        </View>

        <FeatureCard title="Shift Schedule" subtitle={`${scheduledShifts.length} scheduled | ${activeShifts.length} live | ${completedShifts.length} completed`} style={styles.desktopPanel}>
          {shifts.length === 0 ? (
            <Text style={styles.helperText}>No shifts are currently scheduled.</Text>
          ) : (
            ([
              { title: 'Scheduled Shifts', rows: scheduledShifts },
              { title: 'Live / In Progress', rows: activeShifts },
              { title: 'Completed Shifts', rows: completedShifts },
            ] as const).map((group) => (
              <View key={group.title} style={styles.sectionRecord}>
                <Text style={styles.recordTitle}>{group.title}</Text>
                {group.rows.length === 0 ? (
                  <Text style={styles.helperText}>No shifts in this state.</Text>
                ) : (
                  group.rows.map((shift) => {
                    const linkedSite = shift.site || sites.find((site) => site.id === shift.siteId) || null;
                    const linkedClient = linkedSite?.client || clients.find((client) => client.id === linkedSite?.clientId) || null;
                    return (
                      <View key={shift.id} style={styles.rowCard}>
                        <Text style={styles.listTitle}>{linkedSite?.name || shift.siteName || `Shift #${shift.id}`}</Text>
                        <Text style={styles.helperText}>{linkedClient?.name || 'Client not linked'} | {formatDateTimeRange(shift.start, shift.end)}</Text>
                        <Text style={styles.helperText}>Guard: {shift.guard?.fullName || `#${shift.guard?.id ?? shift.guardId ?? 'N/A'}`}</Text>
                        <Text style={styles.helperText}>Check call interval: {shift.checkCallIntervalMinutes || linkedSite?.welfareCheckIntervalMinutes || 60} minutes</Text>
                        <Text style={styles.helperText}>Status: {shift.status}</Text>
                        <Pressable style={styles.secondaryButton} {...pressHandlers(() => setSelectedShiftId(shift.id))}>
                          <Text style={styles.secondaryButtonText}>{selectedShift?.id === shift.id ? 'Open Shift' : 'View Shift'}</Text>
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </View>
            ))
          )}
        </FeatureCard>

        <FeatureCard
          title="Selected Shift Context"
          subtitle={selectedShift ? `${selectedShift.siteName} | ${selectedShift.status}` : 'Select a shift to inspect activity and timesheets.'}
          style={styles.desktopPanel}
        >
          {!selectedShift ? (
            <Text style={styles.helperText}>No shift is selected yet.</Text>
          ) : (
            <View style={styles.sectionRecord}>
              {(() => {
                const linkedSite = selectedShift.site || sites.find((site) => site.id === selectedShift.siteId) || null;
                const linkedClient =
                  linkedSite?.client || clients.find((client) => client.id === linkedSite?.clientId) || null;

                return (
                  <>
              <View style={styles.recordHeader}>
                <View style={styles.recordCopy}>
                  <Text style={styles.recordTitle}>{linkedSite?.name || selectedShift.siteName}</Text>
                  <Text style={styles.helperText}>{formatDateTimeRange(selectedShift.start, selectedShift.end)}</Text>
                </View>
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{selectedShift.status}</Text>
                </View>
              </View>
              <View style={styles.inlineStats}>
                <Text style={styles.helperText}>Client: {linkedClient?.name || 'Client not linked'}</Text>
                <Text style={styles.helperText}>Guard: {selectedShift.guard?.fullName || `#${selectedShift.guard?.id ?? selectedShift.guardId ?? 'N/A'}`}</Text>
                <Text style={styles.helperText}>Site: {linkedSite?.name || selectedShift.site?.name || selectedShift.siteName}</Text>
                <Text style={styles.helperText}>Check calls: every {selectedShift.checkCallIntervalMinutes || linkedSite?.welfareCheckIntervalMinutes || 60} mins</Text>
                <Text style={styles.helperText}>Logs: {selectedShiftDailyLogs.length}</Text>
                <Text style={styles.helperText}>Incidents: {selectedShiftIncidents.length}</Text>
                <Text style={styles.helperText}>Timesheets: {selectedShiftTimesheets.length}</Text>
              </View>
              {selectedShiftDailyLogs.slice(0, 3).map((entry) => (
                <View key={entry.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{entry.logType}</Text>
                  <Text style={styles.helperText}>{entry.message}</Text>
                  <Text style={styles.helperText}>{new Date(entry.createdAt).toLocaleString()}</Text>
                </View>
              ))}
              {selectedShiftIncidents.slice(0, 2).map((incident) => (
                <View key={incident.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>{incident.title}</Text>
                  <Text style={styles.helperText}>{incident.status} | {incident.severity}</Text>
                </View>
              ))}
              {selectedShiftTimesheets.map((timesheet) => (
                <View key={timesheet.id} style={styles.rowCard}>
                  <Text style={styles.listTitle}>Timesheet #{timesheet.id}</Text>
                  <Text style={styles.helperText}>
                    {timesheet.approvalStatus} | {timesheet.hoursWorked} hours
                  </Text>
                </View>
              ))}
              {selectedShiftDailyLogs.length === 0 && selectedShiftIncidents.length === 0 && selectedShiftTimesheets.length === 0 ? (
                <Text style={styles.helperText}>No activity has been recorded for this shift yet.</Text>
              ) : null}
                  </>
                );
              })()}
            </View>
          )}
        </FeatureCard>

        <FeatureCard title="Recent Shift Log Book" subtitle={`${recentDailyLogs.length} recent entries`} style={styles.desktopPanel}>
          {recentDailyLogs.length === 0 ? (
            <Text style={styles.helperText}>No shift log entries recorded yet.</Text>
          ) : (
            recentDailyLogs.map((entry) => (
              <View key={entry.id} style={styles.sectionRecord}>
                <View style={styles.recordHeader}>
                  <View style={styles.recordCopy}>
                    <Text style={styles.recordTitle}>{entry.shift?.siteName || `Shift #${entry.shift?.id ?? entry.id}`}</Text>
                    <Text style={styles.helperText}>{entry.logType} | {new Date(entry.createdAt).toLocaleString()}</Text>
                  </View>
                </View>
                <Text style={styles.helperText}>{entry.message}</Text>
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
                  <View style={styles.recordCopy}>
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
                    <Pressable
                      style={[styles.button, updatingTimesheetId === timesheet.id && styles.buttonDisabled]}
                      {...pressHandlers(() => handleUpdateTimesheet(timesheet.id, 'approved'))}
                      disabled={updatingTimesheetId === timesheet.id}
                    >
                      <Text style={styles.buttonText}>{updatingTimesheetId === timesheet.id ? 'Updating...' : 'Approve'}</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, updatingTimesheetId === timesheet.id && styles.buttonDisabled]}
                      {...pressHandlers(() => handleUpdateTimesheet(timesheet.id, 'rejected'))}
                      disabled={updatingTimesheetId === timesheet.id}
                    >
                      <Text style={styles.secondaryButtonText}>{updatingTimesheetId === timesheet.id ? 'Updating...' : 'Reject'}</Text>
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
                    <View style={styles.recordCopy}>
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
                  <Pressable
                    style={[styles.button, updatingIncidentId === incident.id && styles.buttonDisabled]}
                    {...pressHandlers(() => handleUpdateIncidentStatus(incident.id, 'resolved'))}
                    disabled={updatingIncidentId === incident.id}
                  >
                    <Text style={styles.buttonText}>{updatingIncidentId === incident.id ? 'Updating...' : 'Mark Resolved'}</Text>
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
                  <View style={styles.recordCopy}>
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
                    <Pressable
                      style={[styles.button, updatingAlertId === alert.id && styles.buttonDisabled]}
                      {...pressHandlers(() => handleAcknowledgeAlert(alert.id))}
                      disabled={updatingAlertId === alert.id}
                    >
                      <Text style={styles.buttonText}>{updatingAlertId === alert.id ? 'Updating...' : 'Acknowledge'}</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.secondaryButton, updatingAlertId === alert.id && styles.buttonDisabled]}
                      {...pressHandlers(() => handleCloseAlert(alert.id))}
                      disabled={updatingAlertId === alert.id}
                    >
                      <Text style={styles.secondaryButtonText}>{updatingAlertId === alert.id ? 'Updating...' : 'Resolve'}</Text>
                    </Pressable>
                  </View>
                ) : null}
                {alert.status === 'acknowledged' ? (
                  <Pressable
                    style={[styles.button, updatingAlertId === alert.id && styles.buttonDisabled]}
                    {...pressHandlers(() => handleCloseAlert(alert.id))}
                    disabled={updatingAlertId === alert.id}
                  >
                    <Text style={styles.buttonText}>{updatingAlertId === alert.id ? 'Updating...' : 'Resolve Alert'}</Text>
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
          onPress={handleCreateInvoice}
        >
          <View style={styles.kpiList}>
            <Text style={styles.helperText}>Approved timesheets available: {approvedTimesheets.length}</Text>
            <Text style={styles.helperText}>Managed sites: {sites.length}</Text>
            <Text style={styles.helperText}>Current live shifts: {activeShifts.length}</Text>
            <Text style={styles.helperText}>
              Invoice total ready: {invoiceDraft ? formatCurrency(invoiceDraft.total) : 'Approve timesheets to unlock billing'}
            </Text>
            {invoiceDraft ? (
              <Text style={styles.helperText}>Billing period: {invoiceDraft.periodLabel}</Text>
            ) : null}
          </View>
        </FeatureCard>
      </View>
    );
  }

  function renderActiveSection() {
    switch (activeSection) {
      case 'clients':
        return renderClientsSection();
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

  if (loading && !company) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.pageShell}>
          <Text style={styles.mainPanelTitle}>Company Dashboard</Text>
          <Text style={styles.mainPanelSubtitle}>
            Loading company jobs, applicants, shifts, incidents, alerts, and timesheets...
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={[styles.pageShell, isDesktopWeb && styles.pageShellDesktop]}>
        <View style={[styles.adminLayout, isDesktopWeb && styles.adminLayoutDesktop]}>
          <View style={[styles.sidebar, isDesktopWeb ? styles.sidebarDesktop : styles.sidebarMobile]}>
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
                    {...pressHandlers(() => setActiveSection(section.id))}
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

          <View style={[styles.mainPanel, isDesktopWeb && styles.mainPanelDesktop]}>
            <View style={styles.mainPanelHeader}>
              <View style={styles.mainPanelHeaderCopy}>
                <Text style={styles.mainPanelTitle}>{sectionLabel(activeSection)}</Text>
                <Text style={styles.mainPanelSubtitle}>
                  {sectionItems.find((section) => section.id === activeSection)?.description}
                </Text>
              </View>
              <Pressable style={styles.refreshButton} {...pressHandlers(loadData)}>
                <Text style={styles.refreshButtonText}>{loading ? 'Refreshing...' : 'Refresh'}</Text>
              </Pressable>
            </View>
            {loadError ? (
              <View style={styles.loadErrorBanner}>
                <Text style={styles.loadErrorText}>{loadError}</Text>
                <Pressable style={styles.button} {...pressHandlers(loadData)}>
                  <Text style={styles.buttonText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
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
  sidebarDesktop: {
    width: 320,
    flexShrink: 0,
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
  sidebarSubtitle: { color: '#cbd5e1', lineHeight: 20, flexShrink: 1 },
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
  mainPanel: { flex: 1, gap: 16, minWidth: 0 },
  mainPanelDesktop: {
    flexBasis: 0,
    width: 0,
  },
  mainPanelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  mainPanelHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  mainPanelTitle: { color: '#0f172a', fontSize: 30, fontWeight: '700', lineHeight: 36 },
  mainPanelSubtitle: { color: '#475569', marginTop: 4, lineHeight: 20 },
  refreshButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  refreshButtonText: {
    color: '#111827',
    fontWeight: '600',
  },
  loadErrorBanner: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  loadErrorText: {
    color: '#b91c1c',
    fontWeight: '600',
    lineHeight: 20,
  },
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
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 24,
  },
  sectionHeaderCopy: { flex: 1, gap: 8, minWidth: 320 },
  sectionEyebrow: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  sectionTitle: { fontSize: 30, fontWeight: '700', color: '#0f172a', lineHeight: 36 },
  sectionTitleOnDark: { color: '#fff' },
  sectionSubtitle: { color: '#475569', lineHeight: 22, flexShrink: 1 },
  sectionSubtitleOnDark: { color: '#d1d5db' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, flex: 1, minWidth: 320, maxWidth: 720 },
  metricCard: {
    minWidth: 140,
    flexGrow: 1,
    flexBasis: 140,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#dbe4f0',
    gap: 4,
  },
  metricValue: { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  metricLabel: { color: '#374151', fontWeight: '600', lineHeight: 18, flexShrink: 1 },
  sectionColumns: { gap: 16 },
  sectionColumnsDesktop: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap' },
  desktopPanel: { marginBottom: 0, borderRadius: 20, padding: 20, flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 320 },
  kpiList: { gap: 8 },
  sectionRecord: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 14,
    gap: 10,
    minWidth: 0,
  },
  recordHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    minWidth: 0,
  },
  recordCopy: { flex: 1, minWidth: 0, gap: 4 },
  recordTitle: { color: '#111827', fontWeight: '700', fontSize: 16, lineHeight: 22, flexShrink: 1 },
  statusPill: {
    borderRadius: 999,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexShrink: 0,
    alignSelf: 'flex-start',
  },
  statusPillText: { color: '#1d4ed8', fontWeight: '700', fontSize: 12, textTransform: 'capitalize' },
  inlineStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, width: '100%', minWidth: 0 },
  rowCard: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
    gap: 4,
    minWidth: 0,
  },
  tableRowCard: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
    gap: 8,
    minWidth: 0,
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
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  helperText: { color: '#4b5563', lineHeight: 18, flexShrink: 1, minWidth: 0 },
  listTitle: { color: '#111827', fontWeight: '600', lineHeight: 20, flexShrink: 1 },
  infoBox: {
    borderWidth: 1,
    borderColor: '#dbe4f0',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  infoBoxText: { color: '#334155', lineHeight: 18, flexShrink: 1 },
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
