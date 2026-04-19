import Constants from 'expo-constants';
import {
  Attachment,
  AuditLog,
  AttendanceEvent,
  Assignment,
  AvailabilityOverridePayload,
  AvailabilityRulePayload,
  AuthSession,
  CompanyGuard,
  ComplianceRecord,
  ComplianceRecordPayload,
  CoverageShiftRow,
  CoverageSiteRow,
  ContractPricingRule,
  ContractPricingRulePayload,
  CompanyProfile,
  Client,
  ClientPortalDashboard,
  ClientPortalIncident,
  ClientPortalInvoiceSummary,
  ClientPortalServiceRecord,
  ClientPortalSite,
  ClientPortalWelfareRow,
  CreateInvoiceBatchPayload,
  CreatePayrollBatchPayload,
  CreateClientPayload,
  CreateIncidentPayload,
  CreateJobApplicationPayload,
  CreateJobPayload,
  CreateShiftPayload,
  GuardProfile,
  HireApplicationPayload,
  Incident,
  IncidentAnalyticsReport,
  Job,
  JobApplication,
  InvoiceBatch,
  InvoiceDocument,
  InvoiceSuggestion,
  MarginReport,
  ReviewJobApplicationPayload,
  DailyLog,
  EligibleGuardRow,
  GuardAvailabilityOverride,
  GuardAvailabilityRule,
  GuardLeave,
  GuardLeavePayload,
  Notification,
  PayrollBatch,
  PayrollSuggestion,
  PayRuleConfig,
  PayRuleConfigPayload,
  RegisterPayload,
  SafetyAlert,
  SiteRiskReport,
  Site,
  Shift,
  Timesheet,
  UpdateCompanyPayload,
  UpdateClientPayload,
  UpdateGuardPayload,
  UpdateShiftPayload,
  UpdateSitePayload,
  UpdateTimesheetPayrollPayload,
  UpdateTimesheetPayload,
  WelfareAnalyticsReport,
  RecordAttendancePayload,
  CreateSitePayload,
  CreateSafetyAlertPayload,
  CreateDailyLogPayload,
} from '../types/models';

const LIVE_API_BASE_URL = 'https://security-marketplace-api.onrender.com';
const hasBrowserWindow =
  typeof window !== 'undefined' &&
  typeof window.location !== 'undefined' &&
  typeof window.location.hostname === 'string';
const isWeb = hasBrowserWindow;
const isLocalWebHost =
  hasBrowserWindow && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const devFallbackApiBaseUrl = isLocalWebHost ? 'http://localhost:3000' : LIVE_API_BASE_URL;
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  (__DEV__ ? devFallbackApiBaseUrl : LIVE_API_BASE_URL);
let accessToken: string | null = null;
let unauthorizedHandler: ((message: string) => void | Promise<void>) | null = null;

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    const detail =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object'
          ? JSON.stringify(body)
          : '';
    super(`${status} ${statusText}${detail ? ` - ${detail}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export function setUnauthorizedHandler(handler: ((message: string) => void | Promise<void>) | null) {
  unauthorizedHandler = handler;
}

async function parseResponseBody(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

function normalizeSession(session: AuthSession | { accessToken: string; user: AuthSession['user'] }): AuthSession {
  return {
    accessToken: session.accessToken,
    user: session.user,
  };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers,
      ...options,
    });
  } catch (error) {
    throw new NetworkError(
      error instanceof Error && error.message
        ? `Unable to reach the live API at ${API_BASE_URL}. ${error.message}`
        : `Unable to reach the live API at ${API_BASE_URL}.`,
    );
  }

  const body = await parseResponseBody(response);

  if (!response.ok) {
    if (
      response.status === 401 &&
      accessToken &&
      !path.startsWith('/auth/login') &&
      !path.startsWith('/auth/register') &&
      unauthorizedHandler
    ) {
      await unauthorizedHandler('Your session expired. Please sign in again.');
    }

    throw new ApiError(response.status, response.statusText, body);
  }

  return body as T;
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}

export function formatApiErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof NetworkError) {
    return 'The live backend is unreachable right now. Check internet access and server health, then retry.';
  }

  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Sign-in failed. Check your email and password, or contact support if access is restricted.';
    }

    if (error.status === 403) {
      if (typeof error.body === 'string' && error.body.trim()) {
        return error.body;
      }

      if (error.body && typeof error.body === 'object') {
        const body = error.body as { message?: unknown; error?: unknown };
        if (typeof body.message === 'string' && body.message.trim()) {
          return body.message;
        }
        if (Array.isArray(body.message) && body.message.length > 0) {
          return body.message.join(', ');
        }
      }

      return 'You are not allowed to perform this action.';
    }

    if (typeof error.body === 'string' && error.body.trim()) {
      return error.body;
    }

    if (error.body && typeof error.body === 'object') {
      const body = error.body as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string' && body.message.trim()) {
        return body.message;
      }
      if (Array.isArray(body.message) && body.message.length > 0) {
        return body.message.join(', ');
      }
      if (typeof body.error === 'string' && body.error.trim()) {
        return body.error;
      }
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallbackMessage;
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

export async function clientLogin(email: string, password: string) {
  const session = await request<AuthSession>('/auth/client-login', {
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

export function listCompanyGuards() {
  return request<CompanyGuard[]>('/company-guards');
}

export function listClients() {
  return request<Client[]>('/clients');
}

export function createClient(payload: CreateClientPayload) {
  return request<Client>('/clients', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateClient(id: number, payload: UpdateClientPayload) {
  return request<Client>(`/clients/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
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

export function approveGuard(id: number) {
  return request<GuardProfile>(`/guards/${id}/approve`, {
    method: 'PATCH',
  });
}

export function listJobs() {
  return request<Job[]>('/jobs');
}

export function listJobApplications() {
  return request<JobApplication[]>('/job-applications');
}

export function listMyJobApplications() {
  return request<JobApplication[]>('/job-applications/self');
}

export function listAssignments() {
  return request<Assignment[]>('/assignments');
}

export function listShifts() {
  return request<Shift[]>('/shifts');
}

export function listMyShifts() {
  return request<Shift[]>('/shifts/my');
}

export function createShift(payload: CreateShiftPayload) {
  return request<{
    shift: Shift;
    timesheet: Timesheet;
  }>('/shifts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateShift(id: number, payload: UpdateShiftPayload) {
  return request<Shift>(`/shifts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function respondToShift(id: number, payload: { response: 'accepted' | 'rejected'; reason?: string }) {
  return request<Shift>(`/shifts/${id}/respond`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deleteShift(id: number) {
  return request<{ success: true }>(`/shifts/${id}`, {
    method: 'DELETE',
  });
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

export function updateCompanyTimesheetPayroll(payload: UpdateTimesheetPayrollPayload) {
  return request<Timesheet[]>('/timesheets/company/payroll', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function createCompanyPayrollBatch(payload: CreatePayrollBatchPayload) {
  return request<PayrollBatch>('/payroll-batches', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listCompanyPayrollBatches() {
  return request<PayrollBatch[]>('/payroll-batches/company');
}

export function listComplianceRecords() {
  return request<ComplianceRecord[]>('/compliance');
}

export function listMyComplianceRecords() {
  return request<ComplianceRecord[]>('/compliance/mine');
}

export function saveComplianceRecord(payload: ComplianceRecordPayload) {
  return request<ComplianceRecord>('/compliance', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function listAvailabilityRules(guardId?: number) {
  return request<GuardAvailabilityRule[]>(`/availability/rules${guardId ? `?guardId=${guardId}` : ''}`);
}

export function listAvailabilityOverrides(guardId?: number) {
  return request<GuardAvailabilityOverride[]>(`/availability/overrides${guardId ? `?guardId=${guardId}` : ''}`);
}

export function listMyAvailabilityRules() {
  return request<GuardAvailabilityRule[]>('/availability/mine/rules');
}

export function listMyAvailabilityOverrides() {
  return request<GuardAvailabilityOverride[]>('/availability/mine/overrides');
}

export function saveAvailabilityRule(payload: AvailabilityRulePayload, mine = false) {
  return request<GuardAvailabilityRule>(mine ? '/availability/mine/rules' : '/availability/rules', {
    method: mine && !payload.id ? 'POST' : 'PUT',
    body: JSON.stringify(payload),
  });
}

export function saveAvailabilityOverride(payload: AvailabilityOverridePayload, mine = false) {
  return request<GuardAvailabilityOverride>(mine ? '/availability/mine/overrides' : '/availability/overrides', {
    method: mine && !payload.id ? 'POST' : 'PUT',
    body: JSON.stringify(payload),
  });
}

export function listGuardLeave() {
  return request<GuardLeave[]>('/leave');
}

export function listMyGuardLeave() {
  return request<GuardLeave[]>('/leave/mine');
}

export function saveGuardLeave(payload: GuardLeavePayload) {
  return request<GuardLeave>('/leave', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function saveMyGuardLeave(payload: GuardLeavePayload) {
  return request<GuardLeave>('/leave/mine', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listCoverageShifts(params: { from?: string; to?: string; siteId?: string; clientId?: string } = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<CoverageShiftRow[]>(`/coverage/shifts${suffix}`);
}

export function listCoverageSites(params: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<CoverageSiteRow[]>(`/coverage/sites${suffix}`);
}

export function listEligibleGuardsForShift(shiftId: number) {
  return request<EligibleGuardRow[]>(`/coverage/shifts/${shiftId}/eligible-guards`);
}

export function listPayrollSuggestions() {
  return request<PayrollSuggestion[]>('/payroll/suggestions');
}

export function getPayRuleConfig() {
  return request<PayRuleConfig | null>('/pay-rules');
}

export function savePayRuleConfig(payload: PayRuleConfigPayload) {
  return request<PayRuleConfig>('/pay-rules', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function getCompanyPayrollBatch(id: number) {
  return request<PayrollBatch>(`/payroll-batches/${id}`);
}

export function finaliseCompanyPayrollBatch(id: number) {
  return request<PayrollBatch>(`/payroll-batches/${id}/finalise`, {
    method: 'PATCH',
  });
}

export function payCompanyPayrollBatch(id: number) {
  return request<PayrollBatch>(`/payroll-batches/${id}/pay`, {
    method: 'PATCH',
  });
}

export function createCompanyInvoiceBatch(payload: CreateInvoiceBatchPayload) {
  return request<InvoiceBatch>('/invoice-batches', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listCompanyInvoiceBatches() {
  return request<InvoiceBatch[]>('/invoice-batches/company');
}

export function listInvoiceSuggestions() {
  return request<InvoiceSuggestion[]>('/invoices/suggestions');
}

export function getCompanyInvoiceBatch(id: number) {
  return request<InvoiceBatch>(`/invoice-batches/${id}`);
}

export function getCompanyInvoiceBatchDocument(id: number) {
  return request<InvoiceDocument>(`/invoice-batches/${id}/document`);
}

export function finaliseCompanyInvoiceBatch(id: number) {
  return request<InvoiceBatch>(`/invoice-batches/${id}/finalise`, {
    method: 'PATCH',
  });
}

export function issueCompanyInvoiceBatch(id: number) {
  return request<InvoiceBatch>(`/invoice-batches/${id}/issue`, {
    method: 'PATCH',
  });
}

export function payCompanyInvoiceBatch(id: number) {
  return request<InvoiceBatch>(`/invoice-batches/${id}/pay`, {
    method: 'PATCH',
  });
}

export function listContractPricingRules(filters: { clientId?: number; siteId?: number; status?: string } = {}) {
  const query = new URLSearchParams();
  if (filters.clientId) query.set('clientId', String(filters.clientId));
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  if (filters.status) query.set('status', filters.status);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<ContractPricingRule[]>(`/contract-pricing${suffix}`);
}

export function createContractPricingRule(payload: ContractPricingRulePayload) {
  return request<ContractPricingRule>('/contract-pricing', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateContractPricingRule(id: number, payload: Partial<ContractPricingRulePayload>) {
  return request<ContractPricingRule>(`/contract-pricing/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deactivateContractPricingRule(id: number) {
  return request<ContractPricingRule>(`/contract-pricing/${id}/deactivate`, {
    method: 'PATCH',
  });
}

export function getCompanyMarginReport(filters: { startDate?: string; endDate?: string; clientId?: number; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.clientId) query.set('clientId', String(filters.clientId));
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<MarginReport>(`/reports/margin${suffix}`);
}

export function getIncidentAnalyticsReport(filters: { startDate?: string; endDate?: string; clientId?: number; siteId?: number; guardId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.clientId) query.set('clientId', String(filters.clientId));
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  if (filters.guardId) query.set('guardId', String(filters.guardId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<IncidentAnalyticsReport>(`/reports/incidents${suffix}`);
}

export function getWelfareAnalyticsReport(filters: { startDate?: string; endDate?: string; clientId?: number; siteId?: number; guardId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.clientId) query.set('clientId', String(filters.clientId));
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  if (filters.guardId) query.set('guardId', String(filters.guardId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<WelfareAnalyticsReport>(`/reports/welfare${suffix}`);
}

export function getSiteRiskReport(filters: { startDate?: string; endDate?: string; clientId?: number; siteId?: number; guardId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.clientId) query.set('clientId', String(filters.clientId));
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  if (filters.guardId) query.set('guardId', String(filters.guardId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<SiteRiskReport>(`/reports/sites-risk${suffix}`);
}

export function getClientPortalDashboard() {
  return request<ClientPortalDashboard>('/client-portal/dashboard');
}

export function listClientPortalSites() {
  return request<ClientPortalSite[]>('/client-portal/sites');
}

export function listClientPortalServiceRecords(filters: { startDate?: string; endDate?: string; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<ClientPortalServiceRecord[]>(`/client-portal/service-records${suffix}`);
}

export function listClientPortalIncidents(filters: { startDate?: string; endDate?: string; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<ClientPortalIncident[]>(`/client-portal/incidents${suffix}`);
}

export function listClientPortalInvoices() {
  return request<ClientPortalInvoiceSummary[]>('/client-portal/invoices');
}

export function getClientPortalInvoiceDocument(id: number) {
  return request<InvoiceDocument>(`/client-portal/invoices/${id}/document`);
}

export function getClientPortalServiceHoursReport(filters: { startDate?: string; endDate?: string; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<Array<{ site: string; period: string; approvedHours: number }>>(`/client-portal/reports/service-hours${suffix}`);
}

export function getClientPortalIncidentReport(filters: { startDate?: string; endDate?: string; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<ClientPortalIncident[]>(`/client-portal/reports/incidents${suffix}`);
}

export function getClientPortalWelfareReport(filters: { startDate?: string; endDate?: string; siteId?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.startDate) query.set('startDate', filters.startDate);
  if (filters.endDate) query.set('endDate', filters.endDate);
  if (filters.siteId) query.set('siteId', String(filters.siteId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request<ClientPortalWelfareRow[]>(`/client-portal/reports/welfare${suffix}`);
}

export function listMyAttendance() {
  return request<AttendanceEvent[]>('/attendance/mine');
}

export function listCompanyAttendance() {
  return request<AttendanceEvent[]>('/attendance/company');
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
  return request<JobApplication>('/job-applications/self', {
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

export function reviewJobApplication(id: number, payload: ReviewJobApplicationPayload) {
  return request<JobApplication | {
    application: JobApplication;
    assignment?: Assignment;
    shiftBundle?: {
      shift: Shift;
      timesheet: Timesheet;
    } | null;
  }>(`/job-applications/${id}/review`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
