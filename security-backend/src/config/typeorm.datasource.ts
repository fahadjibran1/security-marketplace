import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { User } from '../user/entities/user.entity';
import { Company } from '../company/entities/company.entity';
import { GuardProfile } from '../guard-profile/entities/guard-profile.entity';
import { Job } from '../job/entities/job.entity';
import { JobApplication } from '../job-application/entities/job-application.entity';
import { JobSlot } from '../job-slot/entities/job-slot.entity';
import { Assignment } from '../assignment/entities/assignment.entity';
import { Shift } from '../shift/entities/shift.entity';
import { Timesheet } from '../timesheet/entities/timesheet.entity';
import { CompanyGuard } from '../company-guard/entities/company-guard.entity';
import { AddUnifiedWorkforceModel1710000000000 } from '../migrations/1710000000000-AddUnifiedWorkforceModel';
import { AddCompanyGuardsAndTimesheetOneToOne1710000001000 } from '../migrations/1710000001000-AddCompanyGuardsAndTimesheetOneToOne';

loadEnv();

const databaseUrl = process.env.DATABASE_URL;
const sslEnabled = (process.env.DATABASE_SSL || 'false').toLowerCase() === 'true';

export default new DataSource({
  type: 'postgres',
  ...(databaseUrl
    ? { url: databaseUrl }
    : {
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || '5432'),
        username: process.env.DATABASE_USER || 'postgres',
        password: process.env.DATABASE_PASSWORD || 'postgres',
        database: process.env.DATABASE_NAME || 'security_mvp',
      }),
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  entities: [User, Company, GuardProfile, Job, JobApplication, JobSlot, Assignment, Shift, Timesheet, CompanyGuard],
  migrations: [AddUnifiedWorkforceModel1710000000000, AddCompanyGuardsAndTimesheetOneToOne1710000001000],
  synchronize: false,
});
