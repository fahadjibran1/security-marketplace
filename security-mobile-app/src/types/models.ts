export type AppRole = 'admin' | 'company' | 'company_admin' | 'company_staff' | 'guard';
export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
export type TimesheetPayrollStatus = 'unpaid' | 'included' | 'paid';
export type PayrollBatchStatus = 'draft' | 'finalised' | 'paid';
export type TimesheetBillingStatus = 'uninvoiced' | 'included' | 'invoiced';
export type InvoiceBatchStatus = 'draft' | 'finalised' | 'issued' | 'paid';
export type ContractPricingRuleStatus = 'active' | 'inactive';
export type ComplianceRecordType = 'SIA' | 'RIGHT_TO_WORK' | 'TRAINING' | 'OTHER';
export type ComplianceRecordStatus = 'valid' | 'expiring' | 'expired';
export type AvailabilityOverrideStatus = 'available' | 'unavailable';
export type GuardLeaveType = 'annual_leave' | 'sick' | 'unavailable' | 'training' | 'suspension' | 'other';
export type GuardLeaveStatus = 'pending' | 'approved' | 'rejected';

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
  billingRate?: number | null;
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

export interface ComplianceRecord {
  id: number;
  company?: CompanyProfile;
  guard?: GuardProfile;
  type: ComplianceRecordType | string;
  documentName: string;
  documentNumber?: string | null;
  issueDate?: string | null;
  expiryDate: string;
  status: ComplianceRecordStatus | string;
  reminderSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRecordPayload {
  guardId: number;
  type: ComplianceRecordType | string;
  documentName: string;
  documentNumber?: string | null;
  issueDate?: string | null;
  expiryDate: string;
}

export interface GuardAvailabilityRule {
  id: number;
  company?: CompanyProfile | null;
  guard?: GuardProfile;
  weekday: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuardAvailabilityOverride {
  id: number;
  guard?: GuardProfile;
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  status: AvailabilityOverrideStatus | string;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuardLeave {
  id: number;
  company?: CompanyProfile;
  guard?: GuardProfile;
  leaveType: GuardLeaveType | string;
  startAt: string;
  endAt: string;
  reason?: string | null;
  status: GuardLeaveStatus | string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityRulePayload {
  id?: number;
  guardId?: number;
  weekday: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface AvailabilityOverridePayload {
  id?: number;
  guardId?: number;
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  status: AvailabilityOverrideStatus | string;
  note?: string | null;
}

export interface GuardLeavePayload {
  id?: number;
  guardId?: number;
  leaveType: GuardLeaveType | string;
  startAt: string;
  endAt: string;
  reason?: string | null;
  status?: GuardLeaveStatus | string;
}

export interface CoverageShiftRow {
  shiftId: number;
  siteId?: number | null;
  siteName: string;
  clientId?: number | null;
  clientName: string;
  start: string;
  end: string;
  requiredGuardCount: number;
  assignedGuardCount: number;
  coverageGap: number;
  coverageStatus: string;
  guardId?: number | null;
  guardName?: string | null;
}

export interface CoverageSiteRow {
  siteId?: number | null;
  siteName: string;
  clientName: string;
  shifts: number;
  requiredGuards: number;
  assignedGuards: number;
  coverageGap: number;
  unfilled: number;
  partiallyCovered: number;
}

export interface EligibleGuardRow {
  guardId: number;
  fullName?: string;
  relationshipStatus?: string | null;
  isEligible: boolean;
  availabilityStatus: 'available' | 'unavailable' | 'no_rule' | string;
  hasShiftClash: boolean;
  hasApprovedLeave: boolean;
  complianceValid: boolean;
  reasons: string[];
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
  job?: Job | null;
  company?: CompanyProfile;
  guard?: GuardProfile;
  site?: Site | null;
}

export interface PayBreakdown {
  hourlyRate: number | null;
  baseHours: number;
  unpaidBreakHours: number;
  minimumPaidHoursApplied: number | null;
  regularHours: number;
  overtimeHours: number;
  nightHours: number;
  weekendHours: number;
  bankHolidayHours: number;
  regularAmount: number | null;
  overtimeAmount: number | null;
  nightPremiumAmount: number | null;
  weekendPremiumAmount: number | null;
  bankHolidayPremiumAmount: number | null;
  source: 'rule' | 'fallback' | string;
}

export interface PayRuleConfig {
  id: number;
  company?: CompanyProfile;
  overtimeThresholdHours?: number | null;
  overtimeMultiplier: number;
  nightStart?: string | null;
  nightEnd?: string | null;
  nightMultiplier: number;
  weekendMultiplier: number;
  bankHolidayMultiplier: number;
  minimumPaidHours?: number | null;
  unpaidBreakMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface PayRuleConfigPayload {
  overtimeThresholdHours?: number | null;
  overtimeMultiplier?: number;
  nightStart?: string | null;
  nightEnd?: string | null;
  nightMultiplier?: number;
  weekendMultiplier?: number;
  bankHolidayMultiplier?: number;
  minimumPaidHours?: number | null;
  unpaidBreakMinutes?: number;
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
  payrollStatus?: TimesheetPayrollStatus | string;
  payrollIncludedAt?: string | null;
  payrollPaidAt?: string | null;
  payrollBatch?: PayrollBatch | null;
  billingStatus?: TimesheetBillingStatus | string;
  invoiceIssuedAt?: string | null;
  invoicePaidAt?: string | null;
  invoiceBatch?: InvoiceBatch | null;
  billingRate?: number | null;
  effectiveBillingRate?: number | null;
  billableHours?: number | null;
  costAmount?: number | null;
  revenueAmount?: number | null;
  marginAmount?: number | null;
  marginPercent?: number | null;
  matchedContractRuleId?: number | null;
  matchedContractRuleName?: string | null;
  payableHours?: number | null;
  payableAmount?: number | null;
  payBreakdown?: PayBreakdown | null;
  payableHoursSnapshot?: number | null;
  payableAmountSnapshot?: number | null;
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

export interface UpdateTimesheetPayrollPayload {
  ids: number[];
  payrollStatus: TimesheetPayrollStatus | string;
}

export interface PayrollBatchTotals {
  recordsCount: number;
  approvedHours: number;
  payableHours?: number;
  approvedAmount: number;
  totalCostAmount?: number;
  missingRateCount: number;
}

export interface PayrollBatch {
  id: number;
  companyId?: number;
  periodStart: string;
  periodEnd: string;
  status: PayrollBatchStatus | string;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  finalisedAt?: string | null;
  paidAt?: string | null;
  createdByUserId?: number | null;
  totals: PayrollBatchTotals;
  timesheets?: Timesheet[];
}

export interface CreatePayrollBatchPayload {
  periodStart: string;
  periodEnd: string;
  notes?: string | null;
  timesheetIds: number[];
}

export interface InvoiceBatchTotals {
  recordsCount: number;
  approvedHours: number;
  invoiceAmount: number;
  totalRevenueAmount?: number;
  missingRateCount: number;
}

export interface InvoiceBatch {
  id: number;
  companyId?: number;
  clientId?: number;
  client?: Client;
  periodStart: string;
  periodEnd: string;
  status: InvoiceBatchStatus | string;
  invoiceReference?: string | null;
  invoiceNumber?: string | null;
  notes?: string | null;
  dueDate?: string | null;
  billingAddressSnapshot?: string | null;
  clientNameSnapshot?: string | null;
  companyNameSnapshot?: string | null;
  companyAddressSnapshot?: string | null;
  paymentTermsDays?: number | null;
  currency?: string | null;
  vatRate?: number | null;
  netAmountSnapshot?: number | null;
  vatAmountSnapshot?: number | null;
  grossAmountSnapshot?: number | null;
  createdAt: string;
  updatedAt: string;
  finalisedAt?: string | null;
  issuedAt?: string | null;
  paidAt?: string | null;
  createdByUserId?: number | null;
  totals: InvoiceBatchTotals;
  timesheets?: Timesheet[];
}

export interface CreateInvoiceBatchPayload {
  clientId: number;
  periodStart: string;
  periodEnd: string;
  invoiceReference?: string | null;
  notes?: string | null;
  paymentTermsDays?: number | null;
  vatRate?: number | null;
  timesheetIds: number[];
}

export interface PayrollSuggestion {
  companyId: number;
  companyName: string;
  periodStart: string;
  periodEnd: string;
  timesheetIds: number[];
  totalHours: number;
  totalCost: number;
}

export interface InvoiceSuggestion {
  companyId: number;
  companyName: string;
  clientId: number;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  timesheetIds: number[];
  totalHours: number;
  totalRevenue: number;
}

export interface InvoiceDocumentLineItem {
  timesheetId: number;
  site: string;
  guard: string;
  shiftDate: string;
  approvedHours: number;
  billableHours: number;
  billingRate: number | null;
  amount: number;
  companyNote?: string | null;
}

export interface InvoiceDocument {
  id: number;
  status: InvoiceBatchStatus | string;
  invoiceNumber: string;
  invoiceReference?: string | null;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  paymentTermsDays: number;
  vatRate: number;
  notes?: string | null;
  company: {
    name: string;
    address: string;
    contactDetails?: string | null;
  };
  client: {
    name: string;
    billingAddress?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
  };
  lineItems: InvoiceDocumentLineItem[];
  totals: {
    netAmount: number;
    vatRate: number;
    vatAmount: number;
    grossAmount: number;
  };
}

export interface CreateJobPayload {
  companyId?: number;
  siteId?: number;
  title: string;
  description?: string;
  guardsRequired: number;
  hourlyRate: number;
  billingRate?: number | null;
  status?: string;
}

export interface MarginReportBreakdown {
  clientId: number | null;
  clientName: string;
  siteId?: number | null;
  siteName?: string;
  contractRuleId?: number | null;
  contractRuleName?: string;
  approvedHours?: number;
  billableHours?: number;
  cost: number;
  revenue: number;
  margin: number;
  marginPercent: number | null;
}

export interface MarginReport {
  totalCost: number;
  totalRevenue: number;
  totalMargin: number;
  marginPercent: number | null;
  breakdown: MarginReportBreakdown[];
}

export interface ContractPricingRule {
  id: number;
  company?: CompanyProfile;
  client: Client;
  site?: Site | null;
  name: string;
  status: ContractPricingRuleStatus | string;
  priority: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  billingRate?: number | null;
  minimumBillableHours?: number | null;
  roundUpToMinutes?: number | null;
  graceMinutes?: number | null;
  appliesOnMonday: boolean;
  appliesOnTuesday: boolean;
  appliesOnWednesday: boolean;
  appliesOnThursday: boolean;
  appliesOnFriday: boolean;
  appliesOnSaturday: boolean;
  appliesOnSunday: boolean;
  startTime?: string | null;
  endTime?: string | null;
  appliesOnBankHoliday?: boolean | null;
  appliesOnWeekendOnly: boolean;
  appliesOnOvernightShift?: boolean | null;
  flatCallOutFee?: number | null;
  deductionHoursBeforeBilling?: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractPricingRulePayload {
  clientId: number;
  siteId?: number | null;
  name: string;
  status?: ContractPricingRuleStatus | string;
  priority?: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  billingRate?: number | null;
  minimumBillableHours?: number | null;
  roundUpToMinutes?: number | null;
  graceMinutes?: number | null;
  appliesOnMonday?: boolean;
  appliesOnTuesday?: boolean;
  appliesOnWednesday?: boolean;
  appliesOnThursday?: boolean;
  appliesOnFriday?: boolean;
  appliesOnSaturday?: boolean;
  appliesOnSunday?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  appliesOnBankHoliday?: boolean | null;
  appliesOnWeekendOnly?: boolean;
  appliesOnOvernightShift?: boolean | null;
  flatCallOutFee?: number | null;
  deductionHoursBeforeBilling?: number | null;
  notes?: string | null;
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
