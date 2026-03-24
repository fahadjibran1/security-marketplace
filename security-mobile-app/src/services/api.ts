import Constants from 'expo-constants';
import {
  Attachment,
  AuditLog,
  AttendanceEvent,
  Assignment,
  AuthSession,
  CompanyProfile,
  CreateIncidentPayload,
  CreateJobApplicationPayload,
  CreateJobPayload,
  GuardProfile,
  HireApplicationPayload,
  Incident,
  Job,
  JobApplication,
  DailyLog,
  Notification,
  RegisterPayload,
  SafetyAlert,
  Site,
  Shift,
  Timesheet,
  UpdateCompanyPayload,
  UpdateGuardPayload,
  UpdateSitePayload,
  UpdateTimesheetPayload,
  RecordAttendancePayload,
  CreateSitePayload,
  CreateSafetyAlertPayload,
  CreateDailyLogPayload,
} from '../types/models';

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  'http://localhost:3000';
let accessToken: string | null = null;

function normalizeSession(session: AuthSession | { accessToken: string; user: AuthSession['user'] }): AuthSession {
  return {
    accessToken: session.accessToken,
    user: session.user,
  };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set('Content-Type', 'application/json');

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers,
    ...options,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText} - ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function login(email: string, password: string) {
  const session = await request<AuthSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  const normalizedSession = normalizeSession(session);
  accessToken = normalizedSession.accessToken;
  return normalizedSession;
}

export async function register(payload: RegisterPayload) {
  const session = await request<AuthSession>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const normalizedSession = normalizeSession(session);
  accessToken = normalizedSession.accessToken;
  return normalizedSession;
}

export function restoreSession(session: AuthSession) {
  accessToken = session.accessToken;
}

export function logout() {
  accessToken = null;
}

export function listCompanies() {
  return request<CompanyProfile[]>('/companies');
}

export function getMyCompany() {
  return request<CompanyProfile>('/companies/me');
}

export function updateMyCompany(payload: UpdateCompanyPayload) {
  return request<CompanyProfile>('/companies/me', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listGuards() {
  return request<GuardProfile[]>('/guards');
}

export function listSites() {
  return request<Site[]>('/sites');
}

export function createSite(payload: CreateSitePayload) {
  return request<Site>('/sites', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateSite(id: number, payload: UpdateSitePayload) {
  return request<Site>(`/sites/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getMyGuard() {
  return request<GuardProfile>('/guards/me');
}

export function updateMyGuard(payload: UpdateGuardPayload) {
  return request<GuardProfile>('/guards/me', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listJobs() {
  return request<Job[]>('/jobs');
}

export function listJobApplications() {
  return request<JobApplication[]>('/job-applications');
}

export function listAssignments() {
  return request<Assignment[]>('/assignments');
}

export function listShifts() {
  return request<Shift[]>('/shifts');
}

export function listTimesheets() {
  return request<Timesheet[]>('/timesheets');
}

export function listCompanyTimesheets() {
  return request<Timesheet[]>('/timesheets/company');
}

export function listMyTimesheets() {
  return request<Timesheet[]>('/timesheets/mine');
}

export function updateTimesheet(id: number, payload: UpdateTimesheetPayload) {
  return request<Timesheet>(`/timesheets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function submitTimesheet(id: number, payload: UpdateTimesheetPayload = {}) {
  return request<Timesheet>(`/timesheets/${id}/submit`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function listMyAttendance() {
  return request<AttendanceEvent[]>('/attendance/mine');
}

export function checkInShift(payload: RecordAttendancePayload) {
  return request<AttendanceEvent>('/attendance/check-in', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function checkOutShift(payload: RecordAttendancePayload) {
  return request<AttendanceEvent>('/attendance/check-out', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createIncident(payload: CreateIncidentPayload) {
  return request<Incident>('/incidents', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listMyIncidents() {
  return request<Incident[]>('/incidents/mine');
}

export function listCompanyIncidents() {
  return request<Incident[]>('/incidents/company');
}

export function updateIncidentStatus(id: number, status: string) {
  return request<Incident>(`/incidents/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function createSafetyAlert(payload: CreateSafetyAlertPayload) {
  return request<SafetyAlert>('/alerts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listMySafetyAlerts() {
  return request<SafetyAlert[]>('/alerts/mine');
}

export function listCompanySafetyAlerts() {
  return request<SafetyAlert[]>('/alerts/company');
}

export function acknowledgeSafetyAlert(id: number) {
  return request<SafetyAlert>(`/alerts/${id}/ack`, {
    method: 'PATCH',
  });
}

export function closeSafetyAlert(id: number) {
  return request<SafetyAlert>(`/alerts/${id}/close`, {
    method: 'PATCH',
  });
}

export function createDailyLog(payload: CreateDailyLogPayload) {
  return request<DailyLog>('/daily-logs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listMyDailyLogs() {
  return request<DailyLog[]>('/daily-logs/mine');
}

export function listCompanyDailyLogs() {
  return request<DailyLog[]>('/daily-logs/company');
}

export function listMyNotifications() {
  return request<Notification[]>('/notifications/mine');
}

export function listCompanyNotifications() {
  return request<Notification[]>('/notifications/company');
}

export function markNotificationRead(id: number) {
  return request<Notification>(`/notifications/${id}/read`, {
    method: 'PATCH',
  });
}

export function listMyAttachments() {
  return request<Attachment[]>('/attachments/mine');
}

export function listCompanyAttachments() {
  return request<Attachment[]>('/attachments/company');
}

export function listCompanyAuditLogs() {
  return request<AuditLog[]>('/audit-logs/company');
}

export function createJob(payload: CreateJobPayload) {
  return request<Job>('/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createJobApplication(payload: CreateJobApplicationPayload) {
  return request<JobApplication>('/job-applications', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function hireJobApplication(id: number, payload: HireApplicationPayload) {
  return request<{
    application: JobApplication;
    assignment: Assignment;
    shiftBundle?: {
      shift: Shift;
      timesheet: Timesheet;
    } | null;
  }>(`/job-applications/${id}/hire`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
