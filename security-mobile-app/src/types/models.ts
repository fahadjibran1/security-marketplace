export type AppRole = 'admin' | 'company' | 'company_admin' | 'company_staff' | 'guard';

export function isCompanyAppRole(role?: AppRole | null): boolean {
  return role === 'company' || role === 'company_admin' || role === 'company_staff';
}

export interface AuthUser {
  id: number;
  email: string;
  role: AppRole;
  status?: string;
  companyId?: number;
  guardId?: number;
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
}

export interface CompanyProfile {
  id: number;
  name: string;
  companyNumber: string;
  address: string;
  contactDetails: string;
  user?: AuthUser;
}

export interface GuardProfile {
  id: number;
  fullName: string;
  siaLicenseNumber?: string;
  siaLicenceNumber?: string;
  phone: string;
  locationSharingEnabled: boolean;
  status: string;
  user?: AuthUser;
}

export interface Site {
  id: number;
  companyId?: number;
  name: string;
  clientName?: string;
  address: string;
  contactDetails?: string;
  status: string;
  welfareCheckIntervalMinutes: number;
  company?: CompanyProfile;
}

// Job = company requirement
export interface Job {
  id: number;
  companyId: number;
  siteId?: number;
  title: string;
  description?: string;
  guardsRequired: number;
  hourlyRate: number;
  status: string;
  company?: CompanyProfile;
  site?: Site | null;
}

// JobApplication = guard applying to a job
export interface JobApplication {
  id: number;
  jobId: number;
  guardId: number;
  status: string;
  appliedAt: string;
  hiredAt?: string;
  job?: Job;
  guard?: GuardProfile;
}

// Assignment = hired guard linked to job
export interface Assignment {
  id: number;
  jobId: number;
  companyId: number;
  guardId: number;
  applicationId: number;
  status: string;
  hiredAt: string;
  job?: Job;
  company?: CompanyProfile;
  guard?: GuardProfile;
  application?: JobApplication;
}

// Shift = planned work linked to assignment
export interface Shift {
  id: number;
  siteId?: number;
  siteName: string;
  start: string;
  end: string;
  status: string;
  assignmentId?: number;
  companyId?: number;
  guardId?: number;
  assignment?: Assignment;
  company?: CompanyProfile;
  guard?: GuardProfile;
  site?: Site | null;
}

// Timesheet = payroll record linked to shift
export interface Timesheet {
  id: number;
  shiftId: number;
  guardId: number;
  companyId: number;
  hoursWorked: number;
  approvalStatus: string;
  createdAt: string;
  submittedAt?: string | null;
  shift?: Shift;
  guard?: GuardProfile;
  company?: CompanyProfile;
}

export interface UpdateTimesheetPayload {
  hoursWorked?: number;
  approvalStatus?: string;
  submittedAt?: string | null;
}

export interface CreateJobPayload {
  companyId: number;
  siteId?: number;
  title: string;
  description?: string;
  guardsRequired: number;
  hourlyRate: number;
  status?: string;
}

export interface CreateJobApplicationPayload {
  jobId: number;
  guardId: number;
}

export interface HireApplicationPayload {
  createShift?: boolean;
  siteId?: number;
  siteName?: string;
  start?: string;
  end?: string;
}

export interface CreateSitePayload {
  name: string;
  clientName?: string;
  address: string;
  contactDetails?: string;
  status?: string;
  welfareCheckIntervalMinutes?: number;
}

export interface UpdateSitePayload extends Partial<CreateSitePayload> {}

export interface RegisterPayload {
  email: string;
  password: string;
  role: AppRole;
  fullName?: string;
  siaLicenseNumber?: string;
  phone?: string;
  companyName?: string;
  companyNumber?: string;
  address?: string;
  contactDetails?: string;
}

export interface UpdateCompanyPayload {
  name?: string;
  companyNumber?: string;
  address?: string;
  contactDetails?: string;
}

export interface UpdateGuardPayload {
  fullName?: string;
  siaLicenseNumber?: string;
  phone?: string;
  locationSharingEnabled?: boolean;
  status?: string;
}

export interface AttendanceEvent {
  id: number;
  type: 'check-in' | 'check-out';
  nfcTag?: string | null;
  notes?: string | null;
  occurredAt: string;
  shift?: Shift;
  guard?: GuardProfile;
}

export interface RecordAttendancePayload {
  shiftId: number;
  nfcTag?: string;
  notes?: string;
}

export interface Incident {
  id: number;
  title: string;
  notes: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  locationText?: string | null;
  status: string;
  createdAt: string;
  shift?: Shift | null;
  company?: CompanyProfile;
  guard?: GuardProfile;
}

export interface CreateIncidentPayload {
  title: string;
  notes: string;
  severity: Incident['severity'];
  locationText?: string;
  shiftId?: number;
}
