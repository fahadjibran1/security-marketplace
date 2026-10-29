import type { TimesheetAttendanceDiscrepancy } from '../components/company/timesheetAttendance';

export type AppRole = 'admin' | 'company' | 'company_admin' | 'company_staff' | 'guard' | 'client_admin' | 'client_viewer';
export type TimesheetApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned';
export type TimesheetPayrollStatus = 'unpaid' | 'included' | 'paid';
export type PayrollBatchStatus = 'draft' | 'finalised' | 'paid';
export type TimesheetBillingStatus = 'uninvoiced' | 'included' | 'invoiced';
export type InvoiceBatchStatus = 'draft' | 'finalised' | 'issued' | 'paid';
export type InvoicePaymentStatus = 'unpaid' | 'partially_paid' | 'paid';
export type PaymentMethod = 'bank_transfer' | 'cash' | 'card' | 'other';
export type ContractPricingRuleStatus = 'active' | 'inactive';
export type ComplianceRecordType = 'SIA' | 'RIGHT_TO_WORK' | 'TRAINING' | 'OTHER';
export type ComplianceRecordStatus = 'valid' | 'expiring' | 'expired';
export type GuardComplianceStatus = 'valid' | 'expiring' | 'expired' | 'invalid';
export type GuardDocumentType = 'sia_licence' | 'right_to_work' | 'id_proof' | 'training';
export type AvailabilityOverrideStatus = 'available' | 'unavailable';
export type GuardLeaveType = 'annual_leave' | 'sick' | 'unavailable' | 'training' | 'suspension' | 'other';
export type GuardLeaveStatus = 'pending' | 'approved' | 'rejected';

export function isCompanyAppRole(role?: AppRole | null): boolean {
  return role === 'company' || role === 'company_admin' || role === 'company_staff';
}

export function isClientAppRole(role?: AppRole | null): boolean {
  return role === 'client_admin' || role === 'client_viewer';
}

export interface AuthUser {
  id: number;
  email: string;
  role: AppRole;
  status?: string;
  companyId?: number;
  guardId?: number;
  clientId?: number;
  /**
   * Effective Company permissions returned by the backend session.
   * Values are CompanyPermission enum strings (e.g. 'guards.manage').
   * Absent for non-Company users and for cached sessions pre-2D2.4.
   * Use role-based fallback when this field is undefined.
   */
  companyPermissions?: string[];
}

export interface AuthSession {
  accessToken: string;
  user: AuthUser;
  /** Present only for mobile logins; the server withholds it from web clients. */
  refreshToken?: string;
  refreshExpiresAt?: string;
}

/**
 * What is actually written to SecureStore. The access token is never persisted — only the
 * renewable refresh token is, and legacyAccessToken exists solely to carry a pre-v1.0.4 blob
 * through one upgrade.
 */
export interface StoredSession {
  user: AuthUser;
  refreshToken?: string;
  legacyAccessToken?: string;
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
  siaExpiryDate?: string | null;
  rightToWorkStatus?: string | null;
  rightToWorkExpiryDate?: string | null;
  phone: string;
  locationSharingEnabled: boolean;
  status: string;
  availability?: string;
  approvalStatus?: string;
  isApproved?: boolean;
  user?: AuthUser;
}

export interface GuardPersonnelIdentity {
  guardId: number;
  ninoSet: boolean;
  ninoMasked: string | null;
  utrSet: boolean;
  utrMasked: string | null;
}

export interface PersonnelRevealResponse {
  field: 'nino' | 'utr';
  maskedValue: string | null;
  revealedValue: string | null;
}

// P1D — Driving & Transport
export type DrivingLicenceStatus = 'NONE' | 'PROVISIONAL' | 'FULL' | 'OTHER_OR_FOREIGN';
export type PrimaryTravelMethod = 'CAR' | 'MOTORCYCLE' | 'PUBLIC_TRANSPORT' | 'BICYCLE' | 'WALK' | 'OTHER';

export interface GuardDrivingTransport {
  guardId: number;
  licenceStatus: DrivingLicenceStatus;
  licenceNumberSet: boolean;
  licenceNumberMasked: string | null;
  licenceCategories: string[] | null;
  licenceExpiryDate: string | null;
  willingToDriveToWork: boolean | null;
  ownsVehicle: boolean | null;
  hasVehicleAccess: boolean | null;
  primaryTravelMethod: PrimaryTravelMethod | null;
  maxTravelDistanceMiles: number | null;
}

export interface DrivingLicenceRevealResponse {
  field: 'licenceNumber';
  maskedValue: string | null;
  revealedValue: string | null;
}

export interface UpdateDrivingTransportPayload {
  licenceStatus?: DrivingLicenceStatus;
  licenceNumberPlaintext?: string;
  licenceCategories?: string[] | null;
  licenceExpiryDate?: string | null;
  willingToDriveToWork?: boolean | null;
  ownsVehicle?: boolean | null;
  hasVehicleAccess?: boolean | null;
  primaryTravelMethod?: PrimaryTravelMethod | null;
  maxTravelDistanceMiles?: number | null;
  confirmRemoveLicenceDetails?: boolean;
}

// P1E — Emergency Contact
export type EmergencyContactRelationship =
  | 'SPOUSE_PARTNER'
  | 'PARENT'
  | 'SIBLING'
  | 'CHILD'
  | 'RELATIVE'
  | 'FRIEND'
  | 'OTHER';

export interface GuardEmergencyContact {
  guardId: number;
  contactName: string;
  relationship: EmergencyContactRelationship;
  customRelationship: string | null;
  primaryPhone: string;
  alternatePhone: string | null;
  updatedAt: string;
}

export interface UpdateEmergencyContactPayload {
  contactName?: string;
  relationship?: EmergencyContactRelationship;
  customRelationship?: string | null;
  primaryPhone?: string;
  alternatePhone?: string | null;
}

// P1F — Employment & Engagement Record
export type GuardEngagementType =
  | 'EMPLOYEE'
  | 'SELF_EMPLOYED_CONTRACTOR'
  | 'AGENCY_WORKER'
  | 'SUBCONTRACTOR'
  | 'CASUAL_WORKER'
  | 'OTHER';

export type GuardJobRole =
  | 'SECURITY_OFFICER'
  | 'DOOR_SUPERVISOR'
  | 'CCTV_OPERATOR'
  | 'SITE_SUPERVISOR'
  | 'CONTROL_ROOM_OPERATOR'
  | 'MOBILE_PATROL_OFFICER'
  | 'OTHER';

export type GuardWorkingArrangement =
  | 'FULL_TIME'
  | 'PART_TIME'
  | 'ZERO_HOURS'
  | 'CASUAL'
  | 'TEMPORARY'
  | 'FIXED_TERM'
  | 'OTHER';

export type GuardPayBasis = 'HOURLY' | 'DAILY' | 'SALARY' | 'OTHER';

export interface GuardEmploymentRecord {
  companyGuardId: number;
  companyId: number;
  companyName: string;
  guardId: number;
  engagementType: GuardEngagementType;
  jobRole: GuardJobRole;
  customRole: string | null;
  workingArrangement: GuardWorkingArrangement;
  startDate: string;
  endDate: string | null;
  payBasis: GuardPayBasis;
  noticePeriodDays: number | null;
  updatedAt: string;
}

// P1G-A — Bank Details
export interface GuardBankDetailsSummary {
  guardId: number;
  bankSet: boolean;
  accountHolderNameMasked: string | null;
  sortCodeMasked: string | null;
  accountNumberMasked: string | null;
  updatedAt: string | null;
}

export interface GuardBankDetailsReveal {
  guardId: number;
  accountHolderName: string | null;
  sortCode: string | null;
  accountNumber: string | null;
}

export interface CompanyGuardBankSummary {
  guardId: number;
  bankSet: boolean;
  sortCodeMasked: string | null;
  accountNumberMasked: string | null;
  updatedAt: string | null;
}

export interface UpdateBankDetailsPayload {
  accountHolderName?: string;
  sortCode?: string;
  accountNumber?: string;
  confirmReplace?: boolean;
}

// P1G-B — Pay Administration (operational workforce evidence only; not a payroll execution system)
export type GuardPayFrequency = 'WEEKLY' | 'FORTNIGHTLY' | 'FOUR_WEEKLY' | 'MONTHLY' | 'IRREGULAR';
export type GuardPayrollStatus = 'ACTIVE' | 'ON_HOLD' | 'EXCLUDED';

// Guard read-only view (payFrequency, payrollStatus, dates only).
export interface GuardPayrollAdminSummary {
  companyGuardId: number;
  guardId: number;
  companyId: number;
  companyName: string;
  payFrequency: GuardPayFrequency | null;
  payrollStatus: GuardPayrollStatus;
  payrollStartDate: string | null;
  payrollEndDate: string | null;
  updatedAt: string;
}

// Company full view (includes payrollNote).
export interface CompanyGuardPayrollRecord {
  companyGuardId: number;
  guardId: number;
  companyId: number;
  payrollReference: string | null;
  payFrequency: GuardPayFrequency | null;
  payrollStatus: GuardPayrollStatus;
  payrollStartDate: string | null;
  payrollEndDate: string | null;
  payrollNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPayrollAdminPayload {
  payrollReference?: string | null;
  payFrequency?: GuardPayFrequency | null;
  payrollStatus?: GuardPayrollStatus;
  payrollStartDate?: string | null;
  payrollEndDate?: string | null;
  payrollNote?: string | null;
}

// Company's view of a guard's P1F employment (minimal — for engagement-aware label selection).
export interface CompanyGuardEmploymentSummary {
  companyGuardId: number;
  guardId: number;
  engagementType: GuardEngagementType;
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
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number | null;
  requireGpsCheckIn?: boolean | null;
  requireNfcCheckIn?: boolean | null;
  timezone?: string | null;
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

export interface GuardDocument {
  id: number;
  guard?: GuardProfile;
  type: GuardDocumentType | string;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  uploadCompletedAt?: string | null;
  expiryDate?: string | null;
  verified: boolean;
  uploadedAt: string;
  uploadedByUserId?: number | null;
  verifiedByUserId?: number | null;
  verifiedAt?: string | null;
}

export interface GuardDocumentPayload {
  guardId?: number;
  /** Guard self-upload only: the Company the evidence is submitted to (required by the backend). */
  companyId?: number;
  type: GuardDocumentType | string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  expiryDate?: string | null;
}

/** Company screening STATUS only — no readiness or personal detail. */
export interface CompanyScreeningOutcome {
  guardId: number;
  status: string;
  vetted: boolean;
}

export interface GuardDocumentUploadCompany {
  companyId: number;
  name: string;
}

export interface GuardDocumentUpload extends GuardDocument {
  upload: { url: string; expiresAt: string; method: 'PUT'; headers: Record<string, string> };
}

export interface GuardDocumentAccess {
  documentId: number;
  url: string;
  expiresAt: string;
  method: 'GET';
}

export interface GuardComplianceSummary {
  guardId: number;
  fullName: string;
  siaLicenceNumber?: string | null;
  siaExpiryDate?: string | null;
  rightToWorkStatus?: string | null;
  rightToWorkExpiryDate?: string | null;
  complianceStatus: GuardComplianceStatus | string;
  assignable: boolean;
  blockingReasons: string[];
  expiringReasons: string[];
  missingDocuments: string[];
  documents: GuardDocument[];
  /**
   * Company view: this company's current SIA and Right to Work checks. These, not the Guard's own
   * declarations above, decide eligibility. Absent from older API responses and from the Guard's own view.
   */
  companyChecks?: { sia: CompanyCheckSummary | null; rightToWork: CompanyCheckSummary | null } | null;
  /** Company view: each requirement for this company and whether it is met. */
  requirements?: ComplianceRequirement[];
  /** Company view: non-blocking notices (for example recorded work restrictions S4 does not enforce). */
  warnings?: string[];
}

export type ComplianceCheckKind = 'sia' | 'right_to_work';

/** The current company check of one kind, as carried on the compliance summary (no evidence reference). */
export interface CompanyCheckSummary {
  id: number;
  outcome: 'confirmed' | 'not_confirmed' | string;
  method: string;
  rightToWorkExcuse: 'continuous' | 'time_limited' | 'time_limited_pvn' | string | null;
  licenceNumber: string | null;
  checkDate: string;
  expiryDate: string | null;
  workRestrictions: string | null;
  checkedByName: string;
  recordedByUserId: number | null;
  createdAt: string;
}

export interface ComplianceRequirement {
  key: 'sia_check' | 'right_to_work_check' | 'sia_document' | 'right_to_work_document' | string;
  label: string;
  state: 'met' | 'expiring' | 'missing' | 'expired' | 'not_confirmed' | 'unverified' | string;
  detail: string;
}

/** One row of a company's check history (GET /compliance/checks). Evidence fields are null without compliance.manage. */
export interface ComplianceCheck extends Omit<CompanyCheckSummary, 'createdAt'> {
  guardId: number;
  kind: ComplianceCheckKind | string;
  evidenceReference: string | null;
  evidenceDocumentId: number | null;
  changeType: 'new_check' | 'correction' | string;
  changeReason: string | null;
  supersededAt: string | null;
  supersededByCheckId: number | null;
  createdAt: string;
}

export interface RecordComplianceCheckPayload {
  guardId: number;
  kind: ComplianceCheckKind;
  outcome: 'confirmed' | 'not_confirmed';
  method: string;
  rightToWorkExcuse?: string | null;
  licenceNumber?: string | null;
  checkDate: string;
  expiryDate?: string | null;
  workRestrictions?: string | null;
  checkedByName: string;
  evidenceReference?: string | null;
  evidenceDocumentId?: number | null;
  replacesCheckId?: number | null;
  changeType?: 'new_check' | 'correction';
  changeReason?: string | null;
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

/**
 * Live Operations monitoring, computed by the backend.
 *
 * Every value here is presented as given. The window boundaries, applicability, counts and status are
 * decided server-side by the operational window engine, so the board must never recompute them — two
 * implementations of the same arithmetic would eventually disagree, and the backend is authoritative.
 */
export interface OperationalWindowView {
  index: number;
  start: string;
  end: string;
  /**
   * The engine's own verdict, published from Phase 4A for the timeline markers and the export rows.
   * Optional because the Log Book windows and the narrowed Guard view do not carry it.
   */
  state?: 'completed' | 'due' | 'overdue' | 'missed' | 'not_applicable' | 'ended_at_book_off';
  applicable?: boolean;
  completedAt?: string | null;
  completionCount?: number;
  /**
   * Welfare history, only on GET /coverage/operations (Welfare Phase 2): when the sweep recorded this
   * window as missed, and the actionable alert that carried it (null when none did).
   */
  missRecordedAt?: string | null;
  alert?: WelfareWindowAlertView | null;
}

/** The control-room alert a missed window was raised under, as it stands now. */
export interface WelfareWindowAlertView {
  id: number;
  status: 'open' | 'acknowledged' | 'closed';
  acknowledged: boolean;
  closedAt: string | null;
  /** Closed by the previous sweep rule (a later window was met), not by a person. */
  closedBySystem: boolean;
  resolutionReason: string | null;
}

/**
 * GET /reports/shift-attendance and /reports/welfare-monitoring (Welfare Phase 3): one report as a sheet —
 * headings, string rows and a summary — built from the database. The web app writes it to CSV or XLSX as is.
 */
export interface OperationsReportSheet {
  report: 'shift-attendance' | 'welfare-monitoring';
  title: string;
  company: string;
  period: { from: string; to: string; fromUtc: string; toUtc: string; days: number };
  site: string | null;
  generatedAtUtc: string;
  timezoneNote: string;
  columns: string[];
  rows: string[][];
  summary: string[][];
}

/**
 * An early Book Off and the coverage that remained (Welfare Phase 4), on GET /coverage/operations only. The
 * Book Off and scheduled end are recorded instants; nothing here is invented.
 */
export interface EarlyBookOffView {
  bookOffAt: string;
  scheduledEnd: string;
  minutesEarly: number;
  remainingMinutes: number;
  coverage: {
    status: 'maintained' | 'partial' | 'uncovered' | 'undetermined';
    coveredMinutes: number;
    uncoveredMinutes: number;
    unknownMinutes: number;
    reliesOnSchedule: boolean;
    coveringShiftIds: number[];
    segments: Array<{ from: string; to: string; kind: 'present' | 'planned' | 'unknown' | 'none'; shiftIds: number[] }>;
  };
  /**
   * Welfare Phase 5: against the Rota Planner slot's required Guards; null when the shift has no rota slot
   * (no genuine requirement is stored, so none is assumed).
   */
  staffing?: {
    rotaSlotId: number;
    required: number;
    status: 'fully_staffed' | 'partially_staffed' | 'unstaffed' | 'undetermined';
    fullMinutes: number;
    shortMinutes: number;
    unstaffedMinutes: number;
    unknownMinutes: number;
    minOnDuty: number;
    reliesOnSchedule: boolean;
  } | null;
}

/** One row of GET /coverage/operations. */
export interface ShiftOperationsRow {
  shiftId: number;
  operations: ShiftOperationsView | null;
}

export type WelfarePresentationStatus =
  | 'not_applicable'
  | 'no_book_on'
  | 'current'
  | 'due'
  | 'overdue'
  | 'missed'
  | 'shift_complete';

export interface WelfareOperationsView {
  enabled: boolean;
  intervalMinutes: number | null;
  status: WelfarePresentationStatus;
  currentWindow: OperationalWindowView | null;
  /**
   * Every resolved Welfare window for the shift, in order, published from Phase 4A.
   *
   * The control-room timeline draws one marker per window and the operations export emits one row per
   * window. Neither rebuilds the grid — this IS the engine's grid, the same array the counts above were
   * derived from. Empty when the shift carries no Welfare obligation.
   */
  windows: OperationalWindowView[];
  lastWelfareAt: string | null;
  nextDueAt: string | null;
  overdueByMinutes: number | null;
  requiredCount: number;
  completedCount: number;
  missedCount: number;
  consecutiveMissed: number;
}

export interface LogBookOperationsView {
  required: boolean;
  intervalMinutes: number | null;
  currentWindow: OperationalWindowView | null;
  currentWindowSubmitted: boolean;
  /**
   * The engine's verdict for every Log Book period, exactly as Welfare publishes its own.
   *
   * The counts below have always been derived from these; the windows themselves were simply never
   * sent, so a register could say "2 missing" but never which periods. Reading them is the only way
   * to show periods without building a second scheduling grid here that could disagree with the
   * backend. Empty for an "as required" site — there is no period to report on.
   */
  windows: OperationalWindowView[];
  requiredCount: number;
  submittedCount: number;
  missingCount: number;
  lastEntryAt: string | null;
}

/** The single actionable Welfare alert. Indexed evidence rows never appear here. */
export interface WelfareSummaryView {
  id: number;
  status: string;
  message: string;
  acknowledged: boolean;
  createdAt: string;
}

/** What the push provider said about one Welfare Check reminder. Never proof the Guard saw it or is safe. */
export interface WelfareReminderView {
  id: number;
  windowIndex: number;
  kind: 'window_open' | 'follow_up';
  status: 'sending' | 'provider_accepted' | 'provider_rejected' | 'no_device' | 'failed';
  receiptStatus: 'provider_delivery_ok' | 'provider_delivery_error' | null;
  deviceCount: number;
  attempts: number;
  sentAt: string | null;
}

export interface WelfareConfirmResult {
  result: 'recorded' | 'already_recorded';
  shiftId: number;
  windowIndex: number;
  windowStart: string;
  windowEnd: string;
  recordedAt: string | null;
}

export interface WelfareHelpResult {
  result: 'raised' | 'already_raised';
  alertId: number;
  shiftId: number;
  raisedAt: string;
}

export interface ShiftOperationsView {
  bookOnAt: string | null;
  bookOffAt: string | null;
  /** Welfare Phase 4: the early Book Off and its coverage, or null when not early (monitoring endpoint only). */
  earlyBookOff?: EarlyBookOffView | null;
  /** Welfare push reminders per window (monitoring endpoint only). Provider status, never a Welfare Check. */
  welfareReminders?: WelfareReminderView[];
  timezone: string;
  welfare: WelfareOperationsView;
  logBook: LogBookOperationsView;
  welfareSummary: WelfareSummaryView | null;
  welfareEvidenceCount: number;
  missingBookOff: boolean;
  /**
   * Manual attendance (Part B): where the effective Book On / Book Off came from, whether either was corrected, and
   * when S4 started monitoring Welfare. Absent on a backend without manual attendance.
   */
  attendance?: OperationsAttendanceView;
}

export interface OperationsAttendanceView {
  bookOnSource: AttendanceSource | null;
  bookOffSource: AttendanceSource | null;
  bookOnCorrected: boolean;
  bookOffCorrected: boolean;
  monitoredFrom: string | null;
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
  coverageState?: 'uncovered' | 'waiting_response' | 'confirmed';
  guardId?: number | null;
  guardName?: string | null;
  /** Null for a shift whose obligation is over, or before the backend has a projection for it. */
  operations?: ShiftOperationsView | null;
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
  /** Live Shift Amendments: the end before the first agreed extension; null/absent when never extended. */
  originalEnd?: string | null;
  checkCallIntervalMinutes?: number;
  status: string;
  instructions?: string | null;
  closeOutNotes?: string | null;
  assignmentId?: number;
  companyId?: number;
  guardId?: number;
  rotaSlotId?: number | null;
  assignment?: Assignment | null;
  /**
   * The marketplace job application this shift came from, when it is a hire. GET /shifts loads this relation with
   * `assignment`; either one makes it a marketplace hire, which Replace Guard refuses (REPLACE_GUARD_HIRE_LINKED).
   */
  jobApplication?: { id: number } | null;
  jobApplicationId?: number | null;
  job?: Job | null;
  company?: CompanyProfile;
  guard?: GuardProfile;
  site?: Site | null;
  /**
   * The operational obligations that apply to this shift, computed by the backend's window engine.
   *
   * Present on GET /shifts/my from Phase 3D, and null for a shift outside the operational window — which
   * means "nothing owed here", not "zero of everything". The Guard app PRESENTS these values and never
   * recomputes a window, a due time or a count: this is the same projection the company board reads, so
   * the two surfaces cannot disagree about whether a Welfare Check is due.
   */
  operations?: GuardShiftOperations | null;
}

/** One operational window as the engine resolved it. Instants; rendered in the site's zone. */
export interface GuardOperationalWindow {
  index: number;
  start: string;
  end: string;
  /**
   * The engine's own verdict for this window, published from Phase 4A so the control-room timeline can
   * draw one marker per window and the operations export can emit one row per window. Absent on the
   * narrowed Guard view, which only needs the current window.
   */
  state?: 'completed' | 'due' | 'overdue' | 'missed' | 'not_applicable' | 'ended_at_book_off';
  applicable?: boolean;
  completedAt?: string | null;
  completionCount?: number;
}

export interface GuardShiftOperations {
  /** The site's zone, so every instant above renders on the clock the Guard works to. */
  timezone: string;
  welfare: {
    enabled: boolean;
    intervalMinutes: number | null;
    /** The engine's own status word, passed through unchanged so it cannot drift from the board's. */
    status: WelfarePresentationStatus;
    currentWindow: GuardOperationalWindow | null;
    lastWelfareAt: string | null;
    nextDueAt: string | null;
    overdueByMinutes: number | null;
    requiredCount: number;
    completedCount: number;
    missedCount: number;
    consecutiveMissed: number;
  };
  logBook: {
    required: boolean;
    intervalMinutes: number | null;
    currentWindow: GuardOperationalWindow | null;
    currentWindowSubmitted: boolean;
    lastEntryAt: string | null;
  };
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
  /** Informational (Part B): where the attendance-verified actuals came from. No approval rule depends on it. */
  verifiedSource?: 'guard_app' | 'manual' | 'corrected' | null;
  /**
   * Read-only, from the shift's effective attendance (servers with verified-attendance sync; absent on older ones).
   * actualCheckInAt / actualCheckOutAt / hoursWorked are the Guard's claim; these are what attendance verified.
   */
  verifiedCheckInAt?: string | null;
  verifiedCheckOutAt?: string | null;
  verifiedAttendanceMinutes?: number | null;
  attendanceDiscrepancy?: TimesheetAttendanceDiscrepancy | null;
  /** The attendance-verified duration stamped at Book Off: the approval default and the server's override baseline. */
  verifiedMinutes?: number | null;
  approvedMinutes?: number | null;
  /** Why the approved (payable) minutes differ from verifiedMinutes, when they do. */
  overrideReason?: string | null;
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
  companyApprovedStartAt?: string | null;
  companyApprovedEndAt?: string | null;
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
  /** Company approval: the payable minutes, and the reason when they differ from the verified attendance. */
  approvedMinutes?: number;
  overrideReason?: string | null;
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
  paidAmount?: number;
  outstandingAmount?: number;
  paymentStatus?: InvoicePaymentStatus | string;
  createdAt: string;
  updatedAt: string;
  finalisedAt?: string | null;
  issuedAt?: string | null;
  paidAt?: string | null;
  createdByUserId?: number | null;
  totals: InvoiceBatchTotals;
  paymentRecords?: PaymentRecord[];
  timesheets?: Timesheet[];
}

export interface PaymentRecord {
  id: number;
  amount: number;
  paymentDate: string;
  method: PaymentMethod | string;
  reference?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClientPortalDashboard {
  client: {
    id: number;
    name: string;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
  };
  activeSites: number;
  recentIncidents: ClientPortalIncident[];
  approvedHoursThisPeriod: number;
  invoicesSummary: {
    total: number;
    outstanding: number;
    issued: number;
  };
  welfareSummary: ClientPortalWelfareRow[];
}

export interface ClientPortalSite {
  id: number;
  name: string;
  address: string;
  status: string;
  requiredGuardCount: number;
  welfareCheckIntervalMinutes: number;
  recentIncidents: number;
  openIncidents: number;
  upcomingShifts: number;
}

export interface ClientPortalServiceRecord {
  id: number;
  siteId?: number | null;
  siteName: string;
  shiftDate: string;
  periodKey: string;
  approvedHours: number;
  status: 'approved' | string;
}

export interface ClientPortalIncident {
  id: number;
  title: string;
  summary: string;
  category: string;
  severity: string;
  status: string;
  siteName: string;
  reportedAt: string;
}

export interface ClientPortalWelfareRow {
  shiftId: number;
  site: string;
  period: string;
  expectedCheckCalls: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  complianceRate: number;
  welfareAlerts: number;
}

export interface ClientPortalInvoiceSummary {
  id: number;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string | null;
  amount: number;
  currency: string;
  status: string;
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
  payments?: PaymentRecord[];
  totals: {
    netAmount: number;
    vatRate: number;
    vatAmount: number;
    grossAmount: number;
    paidAmount?: number;
    outstandingAmount?: number;
    paymentStatus?: InvoicePaymentStatus | string;
  };
}

export interface RecordInvoicePaymentPayload {
  amount: number;
  paymentDate: string;
  method: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
}

export interface FinanceSummaryResponse {
  filters: {
    startDate?: string | null;
    endDate?: string | null;
    clientId?: number | null;
    siteId?: number | null;
  };
  revenueSummary: {
    totalRevenue: number;
    totalInvoiced: number;
    totalPaid: number;
    outstandingRevenue: number;
  };
  costSummary: {
    totalCost: number;
    totalPaidToGuards: number;
    pendingPayroll: number;
  };
  profitSummary: {
    totalProfit: number;
    realisedProfit: number;
    unrealisedProfit: number;
  };
  monthly: FinanceMonthlyPoint[];
}

export interface FinanceMonthlyPoint {
  month: string;
  revenue: number;
  cost: number;
  profit: number;
}

export interface FinanceReconciliationRow {
  invoiceBatchId: number;
  invoiceNumber?: string | null;
  invoiceReference?: string | null;
  clientId?: number | null;
  clientName: string;
  siteNames: string[];
  issuedDate?: string | null;
  dueDate?: string | null;
  amount: number;
  paid: number;
  outstanding: number;
  paymentStatus: InvoicePaymentStatus | string;
  ageDays: number;
  ageBucket: '0-30' | '31-60' | '61-90' | '90+';
  payments: PaymentRecord[];
}

export interface FinanceReceivablesResponse {
  filters: FinanceSummaryResponse['filters'];
  totals: {
    invoiced: number;
    paid: number;
    outstanding: number;
  };
  buckets: {
    '0-30': number;
    '31-60': number;
    '61-90': number;
    '90+': number;
  };
  rows: FinanceReconciliationRow[];
}

export interface FinanceReconciliationResponse {
  filters: FinanceSummaryResponse['filters'];
  rows: FinanceReconciliationRow[];
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

export interface IncidentAnalyticsBucket {
  key: string;
  count: number;
}

export interface IncidentAnalyticsSite {
  siteId: number | null;
  site: string;
  client: string;
  count: number;
  highSeverityCount: number;
}

export interface IncidentAnalyticsClient {
  clientId: number | null;
  client: string;
  count: number;
  highSeverityCount: number;
}

export interface IncidentAnalyticsGuard {
  guardId: number | null;
  guard: string;
  count: number;
  highSeverityCount: number;
}

export interface IncidentAnalyticsTrend {
  period: string;
  count: number;
}

export interface IncidentReportRow {
  id: number;
  reportedAt: string;
  site: string;
  client: string;
  guard: string;
  category: string;
  severity: string;
  notes: string;
}

export interface IncidentAnalyticsReport {
  totalIncidents: number;
  byCategory: IncidentAnalyticsBucket[];
  bySeverity: IncidentAnalyticsBucket[];
  bySite: IncidentAnalyticsSite[];
  byClient: IncidentAnalyticsClient[];
  byGuard: IncidentAnalyticsGuard[];
  trends: IncidentAnalyticsTrend[];
  highRiskSites: IncidentAnalyticsSite[];
  records: IncidentReportRow[];
}

export interface WelfareSiteBreakdown {
  siteId: number | null;
  site: string;
  client: string;
  expected: number;
  completed: number;
  missed: number;
  complianceRate: number;
  lateCheckIns: number;
}

export interface WelfareGuardBreakdown {
  guardId: number | null;
  guard: string;
  expected: number;
  completed: number;
  missed: number;
  complianceRate: number;
  lateCheckIns: number;
}

export interface WelfareTrend {
  period: string;
  panicAlerts: number;
  welfareAlerts: number;
  missedCheckCalls: number;
  lateCheckIns: number;
}

export interface WelfareReportRow {
  shiftId: number;
  shiftDate: string;
  site: string;
  client: string;
  guard: string;
  expectedCheckCalls: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  complianceRate: number;
  lateCheckIn: boolean;
  welfareAlerts: number;
  panicAlerts: number;
}

export interface WelfareAnalyticsReport {
  expectedCheckCalls: number;
  completedCheckCalls: number;
  missedCheckCalls: number;
  checkCallComplianceRate: number;
  panicAlerts: number;
  welfareAlerts: number;
  lateCheckIns: number;
  bySite: WelfareSiteBreakdown[];
  byGuard: WelfareGuardBreakdown[];
  trends: WelfareTrend[];
  records: WelfareReportRow[];
}

export interface SiteRiskRow {
  siteId: number | null;
  site: string;
  client: string;
  incidents: number;
  highSeverityIncidents: number;
  missedCheckCalls: number;
  welfareAlerts: number;
  panicAlerts: number;
  lateCheckIns: number;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | string;
}

export interface SiteRiskReport {
  sites: SiteRiskRow[];
  summary: {
    lowRisk: number;
    mediumRisk: number;
    highRisk: number;
    totalIncidents: number;
    totalAlerts: number;
    totalMissedCheckCalls: number;
  };
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
  /** Why the shift is being marked missed; sent only with `status: 'missed'` (backend: optional, at most 500 chars). */
  reason?: string;
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
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number;
  requireGpsCheckIn?: boolean;
  timezone?: string;
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
  phone?: string;
  locationSharingEnabled?: boolean;
}

export interface AttendanceEvent {
  id: number;
  type: 'check-in' | 'check-out';
  nfcTag?: string | null;
  notes?: string | null;
  occurredAt: string;
  shift?: Shift;
  guard?: GuardProfile;
  /** Manual attendance (Part B). Absent on a backend without it: every row is then a Guard app row and effective. */
  source?: AttendanceSource;
  /** False for a row a later correction superseded. Absent (old backend) means effective. */
  effective?: boolean;
  correctionOfEventId?: number | null;
}

/** Who recorded an attendance event: the Guard in the app, or authorised company staff on the Guard's behalf. */
export type AttendanceSource = 'guard_app' | 'manual';

export type AttendanceVerificationMethod =
  | 'phone_call' | 'supervisor_on_site' | 'cctv' | 'client_confirmation' | 'radio' | 'other';

/** One raw attendance row as GET /attendance/shifts/:id/history returns it (append-only chain, oldest first). */
export interface AttendanceEventView {
  id: number;
  shiftId: number;
  guardId: number;
  type: 'check-in' | 'check-out';
  occurredAt: string;
  recordedAt: string | null;
  source: AttendanceSource;
  recordedByUserId: number | null;
  recordedByName: string | null;
  reason: string | null;
  verificationMethod: AttendanceVerificationMethod | null;
  verificationNote: string | null;
  correctionOfEventId: number | null;
  correctedByEventId: number | null;
  isCorrection: boolean;
  effective: boolean;
  gpsVerified: boolean;
  nfcVerified: boolean;
}

export interface AttendanceHistory {
  shiftId: number;
  status: string;
  guardId: number | null;
  scheduledStart: string;
  scheduledEnd: string;
  effective: { bookOn: AttendanceEventView | null; bookOff: AttendanceEventView | null; monitoredFrom: string | null };
  events: AttendanceEventView[];
}

/** GET /attendance/manual/capabilities: the feature-detection endpoint (404 on a backend without manual attendance). */
export interface ManualAttendanceCapabilities {
  manualAttendance: true;
  verificationMethods: AttendanceVerificationMethod[];
  windowBeforeStartHours: number;
  windowAfterEndHours: number;
  ownerAdminOnlyOlderThanHours: number;
  canManage: boolean;
  canRecordOlderThan24h: boolean;
}

export interface ManualAttendancePayload {
  occurredAt: string;
  reason: string;
  verificationMethod: AttendanceVerificationMethod;
  verificationNote?: string | null;
}

export interface ManualAttendanceResult {
  event: AttendanceEventView;
  shift: { id: number; status: string };
  /** Book Off on servers with verified-attendance sync: a settled (approved / batched) timesheet is left unchanged. */
  timesheet?: { approvalStatus: string; leftUnchanged: boolean };
}

export interface AttendanceCorrectionResult {
  event: AttendanceEventView;
  correctedEventId: number;
  timesheet: { restamped: boolean; approvalStatus: string | null };
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
  /**
   * Why this incident was resolved, and what Control established. (Migration 60.)
   *
   * `resolutionReason` is a stable machine value from the incident reason set, never display text.
   * Both are null on every incident raised before the resolution workflow existed, so every reader
   * must treat them as absent rather than empty.
   *
   * Neither is `notes`: that field is the guard's original report and is never written over.
   */
  resolutionReason?: string | null;
  resolutionNote?: string | null;
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
  type:
    | 'check_call'
    | 'panic'
    | 'welfare'
    | 'site_request'
    | 'late_checkin'
    | 'missed_checkcall'
    | 'missing_book_off'
    | 'other'
    /** Patrols (Migration 69): raised by S4 only, for an ACTIONABLE patrol exception. */
    | 'patrol_missed'
    | 'patrol_abandoned'
    | 'patrol_incomplete'
    | 'checkpoint_missed'
    | 'patrol_unverified'
    /** Migration 63: a company SIA / Right to Work check lapsed while the Guard was on shift. Raised by S4 only. */
    | 'compliance_lapse';
  /** Patrol alerts only: the records this alert is about (Patrol Management links to them). */
  patrolExceptionId?: number | null;
  patrolRunId?: number | null;
  patrolWindowKey?: string | null;
  /** Set once patrol evidence reached the server after the alert: "completed — late sync" may then be chosen. */
  patrolLateSyncAt?: string | null;
  patrolAnnotation?: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  status: 'open' | 'acknowledged' | 'closed';
  /**
   * Which Welfare Check window this row is evidence for, counted from the scheduled shift start.
   *
   * NULL identifies the one actionable shift-level summary; a number identifies durable per-window
   * evidence. The backend returns both from the company alert list, and a control room needs the
   * summary: twenty-four missed windows are twenty-four records but a single thing to act on.
   */
  welfareWindowIndex?: number | null;
  /** compliance_lapse only: which mandatory check, and why it lapsed. */
  complianceCategory?: 'sia' | 'right_to_work' | null;
  complianceReason?: 'expired' | 'not_confirmed' | 'missing' | null;
  acknowledgedAt?: string | null;
  closedAt?: string | null;
  /** Who closed it; null for a row the system closed (or wrote closed, as missed-window history). */
  closedByUserId?: number | null;
  resolutionReason?: string | null;
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
    /**
     * A periodic written Log Book entry, distinct from a voluntary `observation`. Persisted from
     * Migration 59; written by the Guard app's Log Book action from Phase 3C.
     */
    | 'log_book'
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
    | 'compliance_alert'
    | 'alert_raised'
    | 'shift_amendment_requested'
    | 'shift_amendment_responded'
    | 'shift_amendment_disputed'
    | 'shift_amendment_expired'
    | 'shift_offered'
    | 'shift_offer_withdrawn'
    | 'shift_reacceptance_required'
    | 'shift_replaced'
    // A newer server may add types; the Guard inbox shows them with the server's own title and message.
    | (string & {});
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

// P1H — Weekly Client Timesheet Approval
export type ClientWeeklyApprovalStatus = 'pending_approval' | 'client_approved' | 'disputed' | 'resolved' | 'locked';
export type ClientShiftDisputeStatus = 'open' | 'resolved' | 'withdrawn';

export interface ClientWeeklyApprovalSummary {
  id: number;
  site: { id: number; name: string; timezone?: string };
  client: { id: number; name?: string };
  company: { id: number; name?: string };
  weekCommencing: string;
  weekEnding: string;
  status: ClientWeeklyApprovalStatus;
  totalApprovedHours: number | null;
  clientSubmissionNote: string | null;
  submittedAt: string | null;
  clientRespondedAt: string | null;
  currentVersion: number;
}

export interface ClientWeeklyApprovalLine {
  id: number;
  timesheetId: number;
  guardName: string | null;
  shiftDate: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualCheckIn: string | null;
  actualCheckOut: string | null;
  verifiedMinutes: number | null;
  verifiedHours: number | null;
  approvedHoursAtSubmission: number;
  hasOverride: boolean;
  companyApprovedStart?: string | null;
  companyApprovedEnd?: string | null;
}

export interface ClientShiftDisputeSummary {
  id: number;
  timesheetId: number;     // returned by client portal (flat, from toClientDetailDto)
  line?: { id: number };   // returned by company endpoint (eager entity relation)
  disputeReason: string;
  status: ClientShiftDisputeStatus;
  resolutionMessage: string | null;
  disputedAt: string;
  resolvedAt: string | null;
}

export interface ClientWeeklyApprovalDetail extends ClientWeeklyApprovalSummary {
  lines: ClientWeeklyApprovalLine[];
  disputes: ClientShiftDisputeSummary[];
  weekTotalApprovedHours: number;
}

export interface CompanyApprovalLine {
  id: number;
  timesheetId?: number;
  guardName: string | null;
  shiftDate: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualCheckIn: string | null;
  actualCheckOut: string | null;
  verifiedMinutes: number | null;
  verifiedHours?: number | null;
  approvedHoursAtSubmission: number;
  hasOverride: boolean;
  companyApprovedStartAtSubmission?: string | null;
  companyApprovedEndAtSubmission?: string | null;
  // Layer 5: pending billing correction fields (set by P1H-C, cleared at resubmit)
  clientBillingApprovedMinutes?: number | null;
  clientBillingApprovedStartAt?: string | null;
  clientBillingApprovedEndAt?: string | null;
  clientBillingCorrectionReason?: string | null;
  timesheet?: {
    id?: number;
    hoursWorked?: number;
    overrideReason?: string | null;
    scheduledStartAt?: string | null;
    scheduledEndAt?: string | null;
    companyApprovedStartAt?: string | null;
    companyApprovedEndAt?: string | null;
    approvedMinutes?: number | null;
    clientBillingApprovedMinutes?: number | null;
    clientBillingApprovedStartAt?: string | null;
    clientBillingApprovedEndAt?: string | null;
    clientBillingCorrectionReason?: string | null;
  };
}

export interface CompanyApprovalDetail extends ClientWeeklyApprovalSummary {
  lines: CompanyApprovalLine[];
  disputes: ClientShiftDisputeSummary[];
  weekTotalApprovedHours: number;
}

export interface EligibleTimesheetRow {
  id: number;
  hoursWorked: number;
  approvedHours?: number | null;
  approvedMinutes?: number | null;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  actualCheckInAt?: string | null;
  actualCheckOutAt?: string | null;
  overrideReason?: string | null;
  approvalStatus: string;
  companyApprovedStartAt?: string | null;
  companyApprovedEndAt?: string | null;
  guard?: { id: number; fullName?: string } | null;
  shift?: { start?: string; end?: string; site?: { id: number; name?: string }; guard?: { fullName?: string } } | null;
}

export interface CreateWeeklyApprovalPayload {
  clientId: number;
  siteId: number;
  weekCommencing: string;
  timesheetIds: number[];
  companyInternalNote?: string;
  clientSubmissionNote?: string;
}

export interface ClientDisputeItem {
  timesheetId: number;
  disputeReason: string;
}

export type ScreeningStatus = 'NOT_STARTED'|'IN_PROGRESS'|'READY_FOR_REVIEW'|'UNDER_REVIEW'|'VETTED'|'REQUIRES_ATTENTION'|'REJECTED'|'EXPIRED';
/** Compact reviewer-queue row. Deliberately carries no application content — see ScreeningService.queueRow. */
export type ScreeningQueueBucket = 'AWAITING_REVIEW'|'UNDER_REVIEW'|'NEEDS_GUARD_ACTION'|'READY_TO_COMPLETE'|'VETTED'|'NOT_SUBMITTED'|'CLOSED';
export type ScreeningQueueFilter = 'needs_review'|'awaiting_review'|'under_review'|'needs_guard_action'|'ready_to_complete'|'vetted'|'not_submitted'|'all';
export interface ScreeningQueueRow {
  id: number; guardId: number|null; guardName: string|null; guardEmail: string|null;
  status: ScreeningStatus; submittedAt: string|null; updatedAt: string;
  progress: number; verificationCompleted: number; verificationTotal: number;
  reviewerActions: number; guardActions: number; bucket: ScreeningQueueBucket; ready: boolean;
}
export interface ScreeningQueueCounts { awaitingReview:number; underReview:number; needsGuardAction:number; readyToComplete:number; vetted:number; notSubmitted:number; closed:number; needsReview:number; all:number }
export interface ScreeningQueueResponse { rows: ScreeningQueueRow[]; counts: ScreeningQueueCounts; total: number; limit: number; offset: number; filter: ScreeningQueueFilter }

export interface GuardScreening {
  id?: number; status: ScreeningStatus; screeningPeriodYears?: number; progress: number;
  legalFullName?: string; previousNames?: string; dateOfBirth?: string; nationality?: string; currentAddress?: string; siaLicenceType?: string;
  identityVerification?: string; siaRegisterVerification?: string; rightToWorkVerification?: string;
  submittedAt?: string|null; reviewedAt?: string|null; vettedAt?: string|null; retentionReviewAt?: string|null;
  reviewReadiness?: {ready:boolean;blockers:Array<{key:string;label:string;detail:string;action?:'references'|'identity'|'address'|'sia'|'rtw'}>;verificationSummary:{completed:number;total:number;checks:Array<{key:string;label:string;complete:boolean}>};addressVerificationScope:'CURRENT_ADDRESS_ONLY'};
  /** The same classification the queue row was built from, so the two views cannot disagree. */
  reviewClassification?: {
    checklist:Array<{key:string;label:string;complete:boolean;owner:'reviewer'|'guard'|'none';actionable:boolean;message:string}>;
    reviewerActions:Array<{key:string;label:string;message:string}>;
    guardActions:Array<{key:string;label:string;message:string}>;
    bucket:ScreeningQueueBucket; ready:boolean; reviewerActionable:boolean; checksRemaining:number;
    referenceDiscrepancy:boolean; informationRequestOutstanding:boolean;
  };
  reviewNotes?: string|null;
  requirements?: { missing: string[]; remediation?: Array<{key:string;label:string;status:'COMPLETE'|'ACTION_REQUIRED'|'AWAITING_VERIFICATION'|'VERIFIED';message:string;step:string}>; chronology: { continuous:boolean; gaps:Array<{from:string;to:string}>; overlaps:Array<{from:string;to:string}>; periodStart?:string; periodEnd?:string }; addressChronology?: { continuous:boolean; gaps:Array<{from:string;to:string}>; overlaps:Array<{from:string;to:string}>; periodStart?:string; periodEnd?:string } };
  history?: Array<{id:number;type:string;startDate:string;endDate?:string|null;isCurrent:boolean;organisation?:string;description?:string;verificationState?:string}>;
  addresses?: Array<{id:number;address:string;addressLine1?:string|null;addressLine2?:string|null;townCity?:string|null;postcode?:string|null;startDate:string;endDate?:string|null;isCurrent:boolean;verificationState:string}>;
  references?: Array<{id:number;history?:{id:number;type?:string;organisation?:string;startDate?:string;endDate?:string|null;isCurrent?:boolean};historyId?:number;organisation:string;contactPerson?:string;relationship?:string;businessEmail?:string;phone?:string|null;postalDetails?:string|null;status:string;sourceVerified:boolean;requestedAt?:string|null;receivedAt?:string|null;verificationMethod?:string|null;verifiedAt?:string|null}>;
  // originalFileName/uploadedAt/verifiedAt are returned to authorised reviewers only; storage
  // keys and signed URLs are never part of either projection.
  evidence?: Array<{id:number;category:string;mimeType:string;sizeBytes:number;uploadCompleted:boolean;verificationState:string;originalFileName?:string;uploadedAt?:string;verifiedAt?:string|null;verifiedByUserId?:number|null}>;
  consents?: Array<{id:number;consentVersion:string;acceptedAt:string;withdrawnAt?:string|null}>;
}

// ── RotaSlot read model (R4B3 response contract) ──────────────────────────────

export type RotaCoveragePhase = 'future' | 'live' | 'past';

export type RotaCoverageState =
  | 'fully_planned' | 'offered_pending' | 'under_planned' | 'fully_open' | 'has_problems'
  | 'live_fully_staffed' | 'live_partial' | 'live_none_on_site' | 'live_has_problems'
  | 'outcome_completed' | 'outcome_shortfall' | 'outcome_failed' | 'outcome_has_problems' | 'outcome_cancelled'
  | 'cancelled';

export interface RotaPositionCounts {
  required: number;
  assigned: number;
  confirmed: number;
  offered: number;
  open: number;
  problem: number;
  onShift: number;
  completed: number;
}

export interface RotaSlotPositionSummary {
  shiftId: number;
  guardId: number | null;
  guardName: string | null;
  status: string;
}

export interface RotaSlotSummary {
  id: number;
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  jobId: number | null;
  title: string | null;
  startAt: string;
  endAt: string;
  requiredGuardCount: number;
  checkCallIntervalMinutes: number;
  instructions: string | null;
  status: string;
  coveragePhase: RotaCoveragePhase;
  coverageState: RotaCoverageState;
  counts: RotaPositionCounts;
  createdAt: string;
  updatedAt: string;
}

export interface RotaSlotDetail extends RotaSlotSummary {
  positions: RotaSlotPositionSummary[];
}

export interface RotaSlotCell {
  slotId: number;
  title: string | null;
  startAt: string;
  endAt: string;
  isNightShift: boolean;
  coveragePhase: RotaCoveragePhase;
  coverageState: RotaCoverageState;
  counts: RotaPositionCounts;
  positions: RotaSlotPositionSummary[];
}

export interface RotaDayCells {
  slots: RotaSlotCell[];
}

export interface RotaSiteWeekRow {
  siteId: number;
  siteName: string;
  clientId: number | null;
  clientName: string | null;
  days: {
    monday: RotaDayCells;
    tuesday: RotaDayCells;
    wednesday: RotaDayCells;
    thursday: RotaDayCells;
    friday: RotaDayCells;
    saturday: RotaDayCells;
    sunday: RotaDayCells;
  };
}

export interface RotaWeekSnapshot {
  totalSlots: number;
  totalPositions: number;
  futureConfirmed: number;
  offeredPending: number;
  openPositions: number;
  onShiftNow: number;
  completedPositions: number;
  missedPositions: number;
  problems: number;
  sitesFullyCovered: number;
  sitesNeedAttention: number;
  nightSlots: number;
}

export interface RotaWeekResponse {
  weekCommencing: string;
  weekEnding: string;
  snapshot: RotaWeekSnapshot;
  sites: RotaSiteWeekRow[];
}

// ── RotaSlot write model (R4C2 frontend payloads) ─────────────────────────────

export interface RotaCreatePayload {
  siteId: number;
  startAt: string;
  endAt: string;
  requiredGuardCount?: number;
  checkCallIntervalMinutes?: number;
  title?: string;
  instructions?: string;
}

export interface RotaUpdateMetadataPayload {
  title?: string | null;
  instructions?: string | null;
}

/** Diff bag sent by the workspace when saving slot edits. Parent calls appropriate ops. */
export interface RotaSlotChanges {
  startAt?: string;
  endAt?: string;
  requiredGuardCount?: number;
  checkCallIntervalMinutes?: number;
  title?: string | null;
  instructions?: string | null;
}

export interface RotaAssignMultipleResult {
  assigned: Array<{ shiftId: number; guardId: number }>;
  failed: Array<{ shiftId: number; guardId: number; reason: string }>;
}

// ─── Phase C: company workforce invitations ───────────────────────────────────

export type CompanyGuardRelationshipType = 'EMPLOYEE' | 'PREFERRED' | 'APPROVED_CONTRACTOR';

/** Derived by the backend from the invitation's terminal timestamps — not a stored enum. */
export type CompanyGuardInvitationState =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'REVOKED'
  | 'EXPIRED';

/** Safe company-facing projection. Deliberately carries no token material. */
export interface CompanyGuardInvitation {
  id: number;
  relationshipType: CompanyGuardRelationshipType;
  targetSiaLicenceNumber: string | null;
  state: CompanyGuardInvitationState;
  createdAt: string;
  expiresAt: string;
  invitedByUserId: number;
  resolvedAt: string | null;
}

/** The plaintext code is present only here, in the creation response, and is never retrievable again. */
export interface CompanyGuardInvitationCreated {
  invitation: CompanyGuardInvitation;
  code: string;
  responsibilityStatement: string;
}

export interface CreateCompanyGuardInvitationPayload {
  relationshipType?: CompanyGuardRelationshipType;
  targetSiaLicenceNumber?: string;
}

/** What a guard is shown before consenting — company name and terms, nothing internal. */
export interface GuardInvitationPreview {
  companyName: string;
  relationshipType: CompanyGuardRelationshipType;
  expiresAt: string;
  alreadyInWorkforce: boolean;
}

export interface GuardInvitationAccepted {
  companyGuardId: number;
  status: 'ACTIVE';
  relationshipType: CompanyGuardRelationshipType;
  acceptedAt: string | null;
  alreadyInWorkforce: boolean;
}

/** One row of the signed-in guard's own "My Companies" list. */
export interface GuardCompanyMembership {
  companyId: number;
  companyName: string;
  relationshipType: CompanyGuardRelationshipType;
  acceptedAt: string | null;
  since: string;
}

// ─── Live Shift Amendments (company web, Phase 2; API: security-backend-nest/src/shift-amendment) ──────────

export type AmendmentStatus =
  | 'awaiting_approval' | 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired' | 'voided'
  | 'disputed' | 'dispute_upheld' | 'dispute_corrected';
export type AmendmentWarning = 'LONG_SHIFT' | 'SHORT_REST' | 'WEEKLY_HOURS' | 'LAST_MINUTE';
/** Never "delivered": S4 only knows whether its email provider accepted the message. */
export type ConfirmationEmailStatus = 'provider_accepted' | 'captured_outbox' | 'not_configured' | 'failed' | 'no_address';
export type VerbalContactMethod = 'telephone' | 'in_person' | 'radio' | 'other';

export interface ShiftPolicy {
  amendmentsEnabled: boolean;
  fatigueWarningHours: number;
  approvalRequiredHours: number;
  hardLimitHours: number | null;
  minRestHours: number;
  weeklyReviewHours: number;
  lastMinuteWarningMinutes: number;
  source: 'default' | 'company';
}

export interface ShiftAmendment {
  id: number;
  shiftId: number;
  guardId: number;
  sequence: number;
  status: AmendmentStatus;
  /** 'expired' as soon as an open proposal's deadline has passed, even before the sweep records it. */
  effectiveStatus: AmendmentStatus;
  originalEnd: string | null;
  previousEnd: string | null;
  proposedEnd: string | null;
  agreedEnd: string | null;
  additionalMinutes: number;
  reason: string;
  proposedByUserId: number | null;
  proposedAt: string | null;
  expiresAt: string | null;
  fatigue: {
    basis: 'scheduled_hours';
    totalScheduledHours: number | null;
    warnings: AmendmentWarning[];
    restHoursBeforeNextShift: number | null;
    sevenDayScheduledHours: number | null;
    /** Company view: the rest gap was decided by another company's shift and is not shown (the warning stays). */
    restFiguresWithheld?: boolean;
    /** Company view: the 7-day figure is this company's hours only; the Guard has other scheduled work. */
    sevenDayIncludesOtherWork?: boolean;
  };
  approvalRequired: boolean;
  approvedByUserId: number | null;
  approvedAt: string | null;
  selfApproved: boolean;
  responseMethod: 'guard_app' | 'staff_recorded_verbal' | null;
  staffReported: boolean;
  respondedByUserId: number | null;
  respondedAt: string | null;
  verbalContactMethod: VerbalContactMethod | null;
  verbalContactAt: string | null;
  verbalConfirmation: string | null;
  confirmationEmailStatus: ConfirmationEmailStatus | null;
  withdrawnAt: string | null;
  voidedReason: string | null;
  voidedAt: string | null;
  expiredAt: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  disputeResolution: 'upheld' | 'corrected' | null;
  disputeResolutionNote: string | null;
  disputeResolvedAt: string | null;
  timesheetSync: string | null;
  payrollReviewRequired: boolean;
  billingReviewRequired: boolean;
  complianceReviewRequired: boolean;
}

export interface ShiftAmendmentList {
  shiftId: number;
  originalEnd: string;
  currentEnd: string;
  extended: boolean;
  amendments: ShiftAmendment[];
}

/** POST /shifts/:id/amendments/assessment — a dry run of a proposal. Figures come only from the company's own shifts. */
export interface ShiftAmendmentAssessment {
  shiftId: number;
  timeZone: string;
  currentEnd: string;
  proposedEnd: string;
  currentEndLocal: string;
  proposedEndLocal: string;
  additionalMinutes: number;
  basis: 'scheduled_hours';
  totalScheduledHours: number;
  warnings: AmendmentWarning[];
  approvalRequired: boolean;
  approvalReasons: Array<'LONG_SHIFT' | 'SHORT_REST'>;
  hardLimitExceeded: boolean;
  complianceReviewRequired: boolean;
  /** Null when the Guard's next shift belongs to another company: its time is never disclosed. */
  restHoursBeforeNextShift: number | null;
  restFiguresWithheld: boolean;
  companySevenDayScheduledHours: number;
  sevenDayIncludesOtherWork: boolean;
  thresholds: Omit<ShiftPolicy, 'amendmentsEnabled' | 'source'>;
  blockedBy: Array<{ code: string; message: string }>;
  canPropose: boolean;
}

/** GET /shift-amendments/staff — names for the history; Control Room authorisation for Owner/Admin only. */
export interface ShiftAmendmentStaffDirectory {
  canManageControlRoom: boolean;
  staff: Array<{ userId: number; displayName: string; role: string; isYou: boolean; canAmendShifts?: boolean; canManageAttendance?: boolean }>;
}
