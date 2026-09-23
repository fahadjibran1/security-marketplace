import { AuthSession } from '../auth/entities/auth-session.entity';
import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { Assignment } from '../assignment/entities/assignment.entity';
import { Attachment } from '../attachment/entities/attachment.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { GuardAvailabilityOverride } from '../availability/entities/guard-availability-override.entity';
import { GuardAvailabilityRule } from '../availability/entities/guard-availability-rule.entity';
import { Client } from '../client/entities/client.entity';
import { ClientPortalUser } from '../client-portal-user/entities/client-portal-user.entity';
import { Company } from '../company/entities/company.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { ComplianceRecord } from '../compliance/entities/compliance-record.entity';
import { GuardDocument } from '../compliance/entities/guard-document.entity';
import { ContractPricingRule } from '../contract-pricing/entities/contract-pricing-rule.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { GuardBankDetails } from '../guard-personnel/entities/guard-bank-details.entity';
import { CompanyGuardPayroll } from '../guard-personnel/entities/company-guard-payroll.entity';
import { GuardDrivingProfile } from '../guard-personnel/entities/guard-driving-profile.entity';
import { GuardEmergencyContact } from '../guard-personnel/entities/guard-emergency-contact.entity';
import { CompanyGuardEmployment } from '../guard-personnel/entities/company-guard-employment.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Incident } from '../incident/entities/incident.entity';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { GuardLeave } from '../leave/entities/guard-leave.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JobMatch } from '../job-match/entities/job-match.entity';
import { JobSlot } from '../job-slot/entities/job-slot.entity';
import { Job } from '../job/entities/job.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { Notification } from '../notification/entities/notification.entity';
import { PaymentRecord } from '../payment-record/entities/payment-record.entity';
import { PayrollBatch } from '../payroll-batch/entities/payroll-batch.entity';
import { PayRuleConfig } from '../pay-rule/entities/pay-rule-config.entity';
import { User } from '../user/entities/user.entity';
import { GuardScreening, ScreeningAddress, ScreeningConsent, ScreeningEvidence, ScreeningException, ScreeningHistory, ScreeningReference } from '../screening/entities/screening.entities';
import { ClientWeeklyApprovalRequest } from '../client-weekly-approval/entities/client-weekly-approval-request.entity';
import { ClientWeeklyApprovalLine } from '../client-weekly-approval/entities/client-weekly-approval-line.entity';
import { ClientShiftDispute } from '../client-weekly-approval/entities/client-shift-dispute.entity';
import { CompanyMembership } from '../company-membership/entities/company-membership.entity';
import { CompanyInvitation } from '../company-membership/entities/company-invitation.entity';
import { RotaSlot } from '../rota-slot/entities/rota-slot.entity';

export const appEntities = [
  AuthSession,
  AttendanceEvent,
  Assignment,
  Attachment,
  AuditLog,
  GuardAvailabilityOverride,
  GuardAvailabilityRule,
  Client,
  ClientPortalUser,
  Company,
  CompanyGuard,
  ComplianceRecord,
  GuardDocument,
  ContractPricingRule,
  DailyLog,
  CompanyGuardPayroll,
  GuardBankDetails,
  GuardDrivingProfile,
  GuardEmergencyContact,
  CompanyGuardEmployment,
  GuardProfile,
  GuardLeave,
  Incident,
  InvoiceBatch,
  Job,
  JobApplication,
  JobMatch,
  JobSlot,
  Notification,
  PaymentRecord,
  PayrollBatch,
  PayRuleConfig,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
  User,
  GuardScreening,
  ScreeningHistory,
  ScreeningAddress,
  ScreeningReference,
  ScreeningEvidence,
  ScreeningConsent,
  ScreeningException,
  ClientWeeklyApprovalRequest,
  ClientWeeklyApprovalLine,
  ClientShiftDispute,
  CompanyMembership,
  CompanyInvitation,
  RotaSlot,
];
