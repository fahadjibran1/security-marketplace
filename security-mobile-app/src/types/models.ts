export type AppRole = 'admin' | 'company' | 'company_admin' | 'company_staff' | 'guard';
export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';

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

export interface Client {
  id: number;
  companyId?: number;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactDetails?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  company?: CompanyProfile;
}

export interface GuardProfile {
  id: number;
  fullName: string;
  siaLicenseNumber?: string;
  siaLicenceNumber?: string;
  phone: string;
  locationSharingEnabled: boolean;
  status: string;
  approvalStatus?: string;
  isApproved?: boolean;
  user?: AuthUser;
}

export interface Site {
  id: number;
  companyId?: number;
  clientId?: number;
  name: string;
  clientName?: string;
  address: string;
  contactDetails?: string;
  status: string;
  requiredGuardCount: number;
  operatingDays?: string | null;
  operatingStartTime?: string | null;
  operatingEndTime?: string | null;
  welfareCheckIntervalMinutes: number;
  specialInstructions?: string | null;
  company?: CompanyProfile;
  client?: Client | null;
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
  assignments?: Assignment[];
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
  shifts?: Shift[];
}

export interface CompanyGuard {
  id: number;
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  relationshipType: 'EMPLOYEE' | 'PREFERRED' | 'APPROVED_CONTRACTOR';
  createdAt: string;
  company?: CompanyProfile;
  guard?: GuardProfile;
}

// Shift = planned work linked to assignment
export interface Shift {
  id: number;
  siteId?: number;
  siteName: string;
  start: string;
  end: string;
  checkCallIntervalMinutes?: number;
  status: string;
  instructions?: string | null;
  closeOutNotes?: string | null;
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
  approvalStatus: TimesheetApprovalStatus | string;
  createdAt: string;
  submittedAt?: string | null;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  actualCheckInAt?: string | null;
  actualCheckOutAt?: string | null;
  guardNote?: string | null;
  companyNote?: string | null;
  approvedHours?: number | null;
  workedMinutes?: number;
  breakMinutes?: number;
  roundedMinutes?: number;
  reviewedAt?: string | null;
  reviewedByUserId?: number | null;
  rejectionReason?: string | null;
  updatedAt?: string;
  shift?: Shift;
  guard?: GuardProfile;
  company?: CompanyProfile;
}

export interface UpdateTimesheetPayload {
  hoursWorked?: number;
  approvalStatus?: TimesheetApprovalStatus | string;
  submittedAt?: string | null;
  actualCheckInAt?: string | null;
  actualCheckOutAt?: string | null;
  guardNote?: string | null;
  companyNote?: string | null;
  approvedHours?: number | null;
  workedMinutes?: number;
  breakMinutes?: number;
  roundedMinutes?: number;
  reviewedAt?: string | null;
  reviewedByUserId?: number;
  rejectionReason?: string | null;
}

export interface CreateJobPayload {
  companyId?: number;
  siteId?: number;
  title: string;
  description?: string;
  guardsRequired: number;
  hourlyRate: number;
  status?: string;
}

export interface CreateShiftPayload {
  assignmentId?: number;
  companyId?: number;
  guardId?: number | null;
  jobId?: number;
  jobApplicationId?: number;
  createdByUserId?: number;
  siteId?: number;
  checkCallIntervalMinutes?: number;
  siteName?: string;
  start: string;
  end: string;
  status?: string;
  instructions?: string;
  closeOutNotes?: string;
}

export interface UpdateShiftPayload {
  siteId?: number;
  guardId?: number | null;
  start?: string;
  end?: string;
  checkCallIntervalMinutes?: number;
  status?: string;
  instructions?: string;
  closeOutNotes?: string | null;
}

export interface CreateJobApplicationPayload {
  jobId: number;
}

export interface HireApplicationPayload {
  createShift?: boolean;
  siteId?: number;
  siteName?: string;
  start?: string;
  end?: string;
}

export interface ReviewJobApplicationPayload {
  status: 'under_review' | 'accepted' | 'rejected';
}

export interface CreateSitePayload {
  name: string;
  clientId?: number;
  clientName?: string;
  address: string;
  contactDetails?: string;
  status?: string;
  requiredGuardCount?: number;
  operatingDays?: string;
  operatingStartTime?: string;
  operatingEndTime?: string;
  welfareCheckIntervalMinutes?: number;
  specialInstructions?: string;
  initialShiftDate?: string;
  initialShiftStartTime?: string;
  initialShiftEndTime?: string;
}

export interface UpdateSitePayload extends Partial<CreateSitePayload> {}

export interface CreateClientPayload {
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactDetails?: string;
  status?: string;
}

export interface UpdateClientPayload extends Partial<CreateClientPayload> {}

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
  category?: 'trespass' | 'theft' | 'damage' | 'violence' | 'fire' | 'health_safety' | 'access_control' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  locationText?: string | null;
  status: string;
  reportedAt?: string;
  reviewedAt?: string | null;
  reviewedByUserId?: number | null;
  closedAt?: string | null;
  closedByUserId?: number | null;
  updatedAt?: string;
  createdAt: string;
  shift?: Shift | null;
  site?: Site | null;
  company?: CompanyProfile;
  guard?: GuardProfile;
}

export interface CreateIncidentPayload {
  title: string;
  notes: string;
  severity: Incident['severity'];
  category?: Incident['category'];
  locationText?: string;
  shiftId?: number;
}

export interface SafetyAlert {
  id: number;
  type: 'check_call' | 'panic' | 'welfare' | 'late_checkin' | 'missed_checkcall' | 'other';
  priority: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  status: 'open' | 'acknowledged' | 'closed';
  acknowledgedAt?: string | null;
  closedAt?: string | null;
  createdAt: string;
  shift?: Shift | null;
  company?: CompanyProfile;
  guard?: GuardProfile;
}

export interface CreateSafetyAlertPayload {
  shiftId?: number;
  type?: SafetyAlert['type'];
  priority?: SafetyAlert['priority'];
  message: string;
}

export interface DailyLog {
  id: number;
  message: string;
  logType:
    | 'patrol'
    | 'observation'
    | 'check_call'
    | 'welfare_check'
    | 'visitor'
    | 'delivery'
    | 'maintenance'
    | 'other';
  createdAt: string;
  updatedAt: string;
  shift?: Shift;
  company?: CompanyProfile;
  guard?: GuardProfile;
}

export interface CreateDailyLogPayload {
  shiftId: number;
  message: string;
  logType?: DailyLog['logType'];
}

export interface UserSummary {
  id: number;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface Attachment {
  id: number;
  entityType: 'incident' | 'alert' | 'daily_log' | 'timesheet' | 'shift';
  entityId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  company?: CompanyProfile | null;
  uploadedBy?: UserSummary | null;
}

export interface Notification {
  id: number;
  type:
    | 'job_assigned'
    | 'shift_reminder'
    | 'check_call_missed'
    | 'incident_reported'
    | 'timesheet_submitted'
    | 'timesheet_approved'
    | 'timesheet_rejected'
    | 'alert_raised';
  title: string;
  message: string;
  status: 'unread' | 'read';
  sentAt?: string | null;
  readAt?: string | null;
  createdAt: string;
  user?: UserSummary | null;
  company?: CompanyProfile | null;
}

export interface AuditLog {
  id: number;
  action: string;
  entityType: string;
  entityId?: number | null;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  company?: CompanyProfile | null;
  user?: UserSummary | null;
}
