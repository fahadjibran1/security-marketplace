import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  approveGuard,
  createClient,
  createJob,
  createShift,
  createSite,
  deleteShift,
  formatApiErrorMessage,
  listClients,
  listCompanyDailyLogs,
  listCompanyGuards,
  listCompanyIncidents,
  listCompanySafetyAlerts,
  listCompanyTimesheets,
  listGuards,
  listJobApplications,
  listJobs,
  listShifts,
  listSites,
  reviewJobApplication,
  updateClient,
  updateShift,
  updateSite,
} from '../services/api';
import {
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

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', caption: 'Control-room overview and KPIs.' },
  { id: 'clients', label: 'Clients', caption: 'Client accounts and contacts.' },
  { id: 'sites', label: 'Sites', caption: 'Site setup, instructions, and coverage.' },
  { id: 'rota-planner', label: 'Rota Planner', caption: 'Plan weekly cover and assignments.' },
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
  { label: 'Planned', value: 'planned' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'Offered', value: 'offered' },
  { label: 'Accepted', value: 'accepted' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Missed', value: 'missed' },
  { label: 'No Show', value: 'no_show' },
];

const UK_LOCALE = 'en-GB';

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

function formatDateLabel(value?: string | null) {
  if (!value) {
    return 'Not set';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}/${month}/${year}`;
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

function buildIsoDateTime(date: string, time: string) {
  return `${date}T${time}:00`;
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

  if (endTime <= startTime) {
    return 'End time must be after start time for the selected date.';
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
  const base = raw ? new Date(`${raw}T00:00:00`) : new Date();
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(base, mondayOffset);
  return monday.toISOString().slice(0, 10);
}

function buildWeekDays(weekCommencing: string) {
  const start = new Date(`${weekCommencing}T00:00:00`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString([], { weekday: 'long' }),
      shortLabel: date.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }),
    };
  });
}

function normalizePlannerStatus(status: string, assignedGuardId: string) {
  if (status) {
    return status;
  }

  return assignedGuardId ? 'offered' : 'planned';
}

function buildPlannerRow(date: string): PlannerRow {
  return {
    localId: `${date}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    startTime: '08:00',
    endTime: '18:00',
    guardsRequired: '1',
    assignedGuardId: '',
    status: 'planned',
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
  const [timesheets, setTimesheets] = React.useState<Timesheet[]>([]);
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [alerts, setAlerts] = React.useState<SafetyAlert[]>([]);
  const [dailyLogs, setDailyLogs] = React.useState<DailyLog[]>([]);
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
  const [showArchivedClients, setShowArchivedClients] = React.useState(false);

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
              latestShifts = value;
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
            { label: 'timesheets', run: listCompanyTimesheets, apply: (value: Timesheet[]) => setTimesheets(value) },
            { label: 'incidents', run: listCompanyIncidents, apply: (value: Incident[]) => setIncidents(value) },
            { label: 'alerts', run: listCompanySafetyAlerts, apply: (value: SafetyAlert[]) => setAlerts(value) },
            { label: 'daily logs', run: listCompanyDailyLogs, apply: (value: DailyLog[]) => setDailyLogs(value) },
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

  const activeClients = React.useMemo(
    () => clients.filter((client) => (client.status || 'active').toLowerCase() !== 'archived'),
    [clients],
  );

  const activeSites = React.useMemo(
    () => sites.filter((site) => (site.status || 'active').toLowerCase() !== 'archived'),
    [sites],
  );

  const todayIso = new Date().toISOString().slice(0, 10);
  const shiftsToday = React.useMemo(
    () => shifts.filter((shift) => shift.start.slice(0, 10) === todayIso),
    [shifts, todayIso],
  );
  const liveShifts = React.useMemo(
    () => shifts.filter((shift) => ['accepted', 'in_progress'].includes((shift.status || '').toLowerCase())),
    [shifts],
  );
  const pendingTimesheets = React.useMemo(
    () => timesheets.filter((timesheet) => (timesheet.approvalStatus || '').toLowerCase() !== 'approved'),
    [timesheets],
  );
  const openIncidents = React.useMemo(
    () => incidents.filter((incident) => (incident.status || '').toLowerCase() !== 'closed'),
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
      status: shift.status || 'planned',
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
      date: addDays(new Date(`${row.date}T00:00:00`), 7).toISOString().slice(0, 10),
      sourceShiftIds: [],
    }));

    setPlannerWeekCommencing(weekCommencingFor(addDays(new Date(`${plannerWeekCommencing}T00:00:00`), 7).toISOString().slice(0, 10)));
    setPlannerRows(nextRows);
    setPlannerRemovedShiftIds([]);
  };

  const handleSaveRota = async () => {
    try {
      if (!plannerSite || !plannerSiteId) {
        throw new Error('Choose a site before saving the rota.');
      }

      setSavingRota(true);

      for (const shiftId of plannerRemovedShiftIds) {
        await deleteShift(shiftId);
      }

      for (const row of plannerRows) {
        const validationError = validateSameDayShiftTiming(row.date, row.startTime, row.endTime);
        if (validationError) {
          throw new Error(`${formatDateLabel(row.date)}: ${validationError}`);
        }

        const guardsRequired = Math.max(1, toNumber(row.guardsRequired) || 1);
        const startAt = buildIsoDateTime(row.date, row.startTime);
        const endAt = buildIsoDateTime(row.date, row.endTime);
        const plannedStatus = normalizePlannerStatus(row.status, row.assignedGuardId);
        const existingIds = [...row.sourceShiftIds];

        for (let index = 0; index < guardsRequired; index += 1) {
          const assignedGuardId = index === 0 ? toNumber(row.assignedGuardId) ?? null : null;
          const payload: CreateShiftPayload & UpdateShiftPayload = {
            siteId: Number(plannerSiteId),
            guardId: assignedGuardId,
            start: startAt,
            end: endAt,
            status: assignedGuardId ? plannedStatus : plannedStatus === 'assigned' ? 'unassigned' : plannedStatus,
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
          await deleteShift(extraId);
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

  const liveOperationRows = React.useMemo(() => {
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
      .sort((left, right) => right.start.localeCompare(left.start));
  }, [liveFilters, shifts]);
  const guardsNotBookedOn = React.useMemo(
    () =>
      liveOperationRows.filter((shift) => {
        const timesheet = timesheetByShiftId.get(shift.id);
        return ['offered', 'accepted'].includes((shift.status || '').toLowerCase()) && !timesheet?.actualCheckInAt;
      }),
    [liveOperationRows, timesheetByShiftId],
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
            <Text style={styles.subtleLabel}>Starter planned shift</Text>
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
                  {formatDateLabel(shift.start)} · {formatTimeLabel(shift.start)}-{formatTimeLabel(shift.end)} · {formatStatusLabel(shift.status)}
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
        <View style={[styles.tableCard, styles.operationsBoardCard]}>
          <Text style={styles.panelTitle}>Live Shift Board</Text>
          {renderTableHeader([
            'Shift',
            'Site',
            'Guard',
            'Status',
            'Book On',
            'Book Off',
            'Last Check Call',
            'Logs',
            'Incidents',
            'Panic / Welfare',
            'Timesheet',
          ])}
          {liveOperationRows.map((shift) => {
            const timesheet = timesheetByShiftId.get(shift.id);
            const shiftLogs = logsByShiftId.get(shift.id) || [];
            const shiftIncidents = incidentsByShiftId.get(shift.id) || [];
            const shiftAlerts = alertsByShiftId.get(shift.id) || [];
            const lastCheckCall = lastCheckCallByShiftId.get(shift.id);
            const panicOrWelfareCount = shiftAlerts.filter((alert) =>
              ['panic', 'welfare', 'late_checkin'].includes((alert.type || '').toLowerCase()),
            ).length;

            return (
              <Pressable
                key={shift.id}
                style={[styles.tableRow, selectedShiftId === shift.id && styles.tableRowSelected]}
                onPress={() => setSelectedShiftId(shift.id)}
              >
                <Text style={styles.tableCellStrong}>#{shift.id}</Text>
                <Text style={styles.tableCell}>{shift.site?.name || shift.siteName || 'Unknown site'}</Text>
                <Text style={styles.tableCell}>{shift.guard?.fullName || 'Unassigned'}</Text>
                <Text style={styles.tableCell}>{formatStatusLabel(shift.status)}</Text>
                <Text style={styles.tableCell}>
                  {timesheet?.actualCheckInAt ? formatTimeLabel(timesheet.actualCheckInAt) : 'Pending'}
                </Text>
                <Text style={styles.tableCell}>
                  {timesheet?.actualCheckOutAt ? formatTimeLabel(timesheet.actualCheckOutAt) : 'Pending'}
                </Text>
                <Text style={styles.tableCell}>
                  {lastCheckCall ? formatTimeLabel(lastCheckCall.createdAt) : 'No check call'}
                </Text>
                <Text style={styles.tableCell}>{String(shiftLogs.length)}</Text>
                <Text style={styles.tableCell}>{String(shiftIncidents.length)}</Text>
                <Text style={styles.tableCell}>{String(panicOrWelfareCount)}</Text>
                <Text style={styles.tableCell}>{formatStatusLabel(timesheet?.approvalStatus || 'pending')}</Text>
              </Pressable>
            );
          })}
          {liveOperationRows.length === 0 ? (
            <Text style={styles.helperText}>No shifts match the current live operations filters.</Text>
          ) : null}
        </View>

        <View style={styles.operationsSideColumn}>
          <View style={styles.panel}>
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

          <View style={styles.panel}>
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

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Recent Log Activity</Text>
            {recentActivity.map((log) => (
              <View key={log.id} style={styles.recordRow}>
                <Text style={styles.recordTitle}>{log.message}</Text>
                <Text style={styles.recordMeta}>
                  {log.shift?.site?.name || log.shift?.siteName || 'Unknown shift'} | {formatDateTimeLabel(log.createdAt)}
                </Text>
              </View>
            ))}
            {recentActivity.length === 0 ? <Text style={styles.helperText}>No recent log activity.</Text> : null}
          </View>
        </View>
      </View>

      {selectedShift ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Shift #{selectedShift.id} Operations</Text>
          <Text style={styles.recordMeta}>
            {selectedShift.site?.client?.name || clientMap.get(selectedShift.site?.clientId || 0)?.name || 'No client'} | {selectedShift.site?.name || selectedShift.siteName}
          </Text>
          <Text style={styles.recordMeta}>
            {selectedShift.guard?.fullName || 'No guard assigned'} | {formatDateLabel(selectedShift.start)} | {formatTimeLabel(selectedShift.start)}-{formatTimeLabel(selectedShift.end)}
          </Text>
          <Text style={styles.recordMeta}>
            Status: {formatStatusLabel(selectedShift.status)} | Check calls: {selectedShift.checkCallIntervalMinutes || 60} mins
          </Text>
          {selectedShift.status === 'offered' ? (
            <Text style={styles.recordMeta}>Waiting for guard confirmation before live controls are used.</Text>
          ) : null}
          {selectedShift.status === 'rejected' ? (
            <Text style={styles.recordMeta}>Guard rejected this shift. New cover is still required.</Text>
          ) : null}
          <Text style={styles.recordMeta}>
            Instructions: {selectedShift.instructions || 'No instructions recorded.'}
          </Text>

          <View style={styles.detailGrid}>
            <View style={styles.detailCard}>
              <Text style={styles.detailTitle}>Attendance & Timesheet</Text>
              <Text style={styles.recordMeta}>
                Book on: {formatDateTimeLabel(timesheetByShiftId.get(selectedShift.id)?.actualCheckInAt)}
              </Text>
              <Text style={styles.recordMeta}>
                Book off: {formatDateTimeLabel(timesheetByShiftId.get(selectedShift.id)?.actualCheckOutAt)}
              </Text>
              <Text style={styles.recordMeta}>
                Timesheet: {formatStatusLabel(timesheetByShiftId.get(selectedShift.id)?.approvalStatus || 'pending')}
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
  panelTitle: {
    color: '#0f172a',
    fontSize: 20,
    fontWeight: '800',
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

