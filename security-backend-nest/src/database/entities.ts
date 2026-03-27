import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { Assignment } from '../assignment/entities/assignment.entity';
import { Attachment } from '../attachment/entities/attachment.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Client } from '../client/entities/client.entity';
import { Company } from '../company/entities/company.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { DailyLog } from '../daily-log/entities/daily-log.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Incident } from '../incident/entities/incident.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JobMatch } from '../job-match/entities/job-match.entity';
import { JobSlot } from '../job-slot/entities/job-slot.entity';
import { Job } from '../job/entities/job.entity';
import { SafetyAlert } from '../safety-alert/entities/safety-alert.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Site } from '../site/entities/site.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { Notification } from '../notification/entities/notification.entity';
import { User } from '../user/entities/user.entity';

export const appEntities = [
  AttendanceEvent,
  Assignment,
  Attachment,
  AuditLog,
  Client,
  Company,
  CompanyGuard,
  DailyLog,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  JobMatch,
  JobSlot,
  Notification,
  SafetyAlert,
  Shift,
  Site,
  Timesheet,
  User,
];
