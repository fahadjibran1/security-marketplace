import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { Assignment } from '../assignment/entities/assignment.entity';
import { Attachment } from '../attachment/entities/attachment.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Client } from '../client/entities/client.entity';
import { Company } from '../company/entities/company.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { ContractPricingRule } from '../contract-pricing/entities/contract-pricing-rule.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Incident } from '../incident/entities/incident.entity';
import { InvoiceBatch } from '../invoice-batch/entities/invoice-batch.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JobMatch } from '../job-match/entities/job-match.entity';
import { JobSlot } from '../job-slot/entities/job-slot.entity';
import { Job } from '../job/entities/job.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { Notification } from '../notification/entities/notification.entity';
import { PayrollBatch } from '../payroll-batch/entities/payroll-batch.entity';
import { User } from '../user/entities/user.entity';

export const appEntities = [
  AttendanceEvent,
  Assignment,
  Attachment,
  AuditLog,
  Client,
  Company,
  CompanyGuard,
  ContractPricingRule,
  DailyLog,
  GuardProfile,
  Incident,
  InvoiceBatch,
  Job,
  JobApplication,
  JobMatch,
  JobSlot,
  Notification,
  PayrollBatch,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
  User,
];
