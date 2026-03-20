import { AttendanceEvent } from '../attendance/entities/attendance.entity';
import { Assignment } from '../assignment/entities/assignment.entity';
import { Company } from '../company/entities/company.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Incident } from '../incident/entities/incident.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JobMatch } from '../job-match/entities/job-match.entity';
import { JobSlot } from '../job-slot/entities/job-slot.entity';
import { Job } from '../job/entities/job.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { User } from '../user/entities/user.entity';

export const appEntities = [
  AttendanceEvent,
  Assignment,
  Company,
  CompanyGuard,
  GuardProfile,
  Incident,
  Job,
  JobApplication,
  JobMatch,
  JobSlot,
  Shift,
  Timesheet,
  User,
];
