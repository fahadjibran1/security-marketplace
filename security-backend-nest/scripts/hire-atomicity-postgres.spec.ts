import 'reflect-metadata';

import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';

import { AssignmentService } from '../src/assignment/assignment.service';
import { Assignment } from '../src/assignment/entities/assignment.entity';
import { CompanyGuardService } from '../src/company-guard/company-guard.service';
import { CompanyGuard } from '../src/company-guard/entities/company-guard.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { GuardApprovalStatus, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { JobApplication } from '../src/job-application/entities/job-application.entity';
import { JobApplicationService } from '../src/job-application/job-application.service';
import { Job } from '../src/job/entities/job.entity';
import { JobService } from '../src/job/job.service';
import { Shift } from '../src/shift/entities/shift.entity';
import { ShiftService } from '../src/shift/shift.service';
import { Site } from '../src/site/entities/site.entity';
import { Timesheet } from '../src/timesheet/entities/timesheet.entity';
import { TimesheetService } from '../src/timesheet/timesheet.service';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

type FailurePoint = 'application' | 'relationship' | 'assignment' | 'job' | 'shift' | 'timesheet';
type Fixture = { applicationId: number; jobId: number };
type DbState = {
  applicationStatus: string;
  companyGuards: number;
  assignments: number;
  jobStatus: string;
  shifts: number;
  timesheets: number;
};

const expectedRollback: DbState = {
  applicationStatus: 'under_review',
  companyGuards: 0,
  assignments: 0,
  jobStatus: 'open',
  shifts: 0,
  timesheets: 0,
};

async function resetAndSeed(dataSource: DataSource, suffix: string): Promise<Fixture> {
  await dataSource.query(`
    TRUNCATE TABLE
      timesheets, shifts, assignments, company_guards, job_applications,
      jobs, sites, guard_screenings, guard_profiles, companies, users
    RESTART IDENTITY CASCADE
  `);
  const users = dataSource.getRepository(User);
  const companyUser = await users.save(users.create({
    email: `company-${suffix}@sec019.test`, passwordHash: 'not-used', role: UserRole.COMPANY_ADMIN,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const guardUser = await users.save(users.create({
    email: `guard-${suffix}@sec019.test`, passwordHash: 'not-used', role: UserRole.GUARD,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const companies = dataSource.getRepository(Company);
  const company = await companies.save(companies.create({
    user: companyUser, name: 'SEC-019 Test Company', companyNumber: `T-${suffix}`,
    address: 'Disposable database', contactDetails: 'test only', status: CompanyStatus.ACTIVE,
  }));
  const guards = dataSource.getRepository(GuardProfile);
  const guard = await guards.save(guards.create({
    user: guardUser, fullName: 'SEC-019 Test Guard', siaLicenseNumber: `99${suffix.padStart(14, '0').slice(-14)}`,
    phone: '07000000000', status: GuardApprovalStatus.APPROVED,
    approvalStatus: GuardApprovalStatus.APPROVED, isApproved: true,
  }));
  const sites = dataSource.getRepository(Site);
  const site = await sites.save(sites.create({
    company, name: 'SEC-019 Test Site', address: 'Disposable database', status: 'active',
    requiredGuardCount: 1, welfareCheckIntervalMinutes: 60,
  }));
  const jobs = dataSource.getRepository(Job);
  const job = await jobs.save(jobs.create({
    company, site, title: 'SEC-019 Test Job', guardsRequired: 1,
    hourlyRate: 15, billingRate: 25, status: 'open',
  }));
  const applications = dataSource.getRepository(JobApplication);
  const application = await applications.save(applications.create({
    job, guard, status: 'under_review',
  }));
  return { applicationId: application.id, jobId: job.id };
}

async function readState(dataSource: DataSource, fixture: Fixture): Promise<DbState> {
  const application = await dataSource.getRepository(JobApplication).findOneByOrFail({ id: fixture.applicationId });
  const job = await dataSource.getRepository(Job).findOneByOrFail({ id: fixture.jobId });
  return {
    applicationStatus: application.status,
    companyGuards: await dataSource.getRepository(CompanyGuard).count(),
    assignments: await dataSource.getRepository(Assignment).count(),
    jobStatus: job.status,
    shifts: await dataSource.getRepository(Shift).count(),
    timesheets: await dataSource.getRepository(Timesheet).count(),
  };
}

function services(dataSource: DataSource, failAt?: FailurePoint) {
  let activeManager: EntityManager | undefined;
  let lockSeen = false;
  const repositoryManagers = new Set<EntityManager>();
  const compliance = { assertGuardAssignable: async () => undefined };
  const companyService = {
    findOne: (id: number) => dataSource.getRepository(Company).findOneByOrFail({ id }),
  };
  const guardService = {
    findOne: (id: number) => dataSource.getRepository(GuardProfile).findOneByOrFail({ id }),
  };
  const siteService = {
    findOne: (id: number) => dataSource.getRepository(Site).findOneByOrFail({ id }),
  };

  const companyGuardService = new CompanyGuardService(
    dataSource.getRepository(CompanyGuard), companyService as any, guardService as any, compliance as any,
  );
  const originalRelationship = companyGuardService.ensureRelationship.bind(companyGuardService);
  companyGuardService.ensureRelationship = async (params: any, manager?: EntityManager) => {
    equal(manager, activeManager, 'CompanyGuard write escaped the transaction manager');
    const value = await originalRelationship(params, manager);
    if (failAt === 'relationship') throw new Error('injected relationship failure');
    return value;
  };

  const assignmentService = new AssignmentService(
    dataSource.getRepository(Assignment), {} as any, guardService as any, compliance as any,
  );
  const originalAssignment = assignmentService.createFromHire.bind(assignmentService);
  assignmentService.createFromHire = async (application: JobApplication, manager?: EntityManager) => {
    equal(manager, activeManager, 'Assignment write escaped the transaction manager');
    const value = await originalAssignment(application, manager);
    if (failAt === 'assignment') throw new Error('injected assignment failure');
    return value;
  };

  const identityFinancials = { applyFinancials: async (value: any) => value };
  const identityPay = { applyPayCalculations: async (value: any) => value };
  const timesheetService = new TimesheetService(
    dataSource.getRepository(Timesheet), {} as any, identityFinancials as any, guardService as any,
    {} as any, {} as any, identityPay as any,
  );
  const originalTimesheet = timesheetService.createForShift.bind(timesheetService);
  timesheetService.createForShift = async (shift: Shift, manager?: EntityManager) => {
    equal(manager, activeManager, 'Timesheet write escaped the transaction manager');
    return originalTimesheet(shift, manager);
  };

  const availability = { assertGuardCanTakeShift: async () => undefined };
  const shiftService = new ShiftService(
    dataSource.getRepository(Shift), dataSource.getRepository(Company), dataSource.getRepository(GuardProfile),
    dataSource.getRepository(Job), dataSource.getRepository(JobApplication), dataSource.getRepository(Timesheet),
    assignmentService, timesheetService, siteService as any, {} as any, guardService as any,
    companyGuardService, availability as any, compliance as any,
  );
  const originalShift = shiftService.create.bind(shiftService);
  shiftService.create = async (dto: any, manager?: EntityManager) => {
    equal(manager, activeManager, 'Shift write escaped the transaction manager');
    return originalShift(dto, manager);
  };

  const jobService = new JobService(dataSource.getRepository(Job), {} as any, siteService as any, {} as any);
  const originalJobSave = jobService.save.bind(jobService);
  jobService.save = async (job: Job, manager?: EntityManager) => {
    equal(manager, activeManager, 'Job write escaped the transaction manager');
    const value = await originalJobSave(job, manager);
    if (failAt === 'job') throw new Error('injected job failure');
    return value;
  };

  const transactionalDataSource = {
    transaction: (work: (manager: EntityManager) => Promise<any>) => dataSource.transaction(async (manager) => {
      activeManager = manager;
      repositoryManagers.add(manager);
      const originalGetRepository = manager.getRepository.bind(manager);
      manager.getRepository = (<T extends ObjectLiteral>(entity: EntityTarget<T>): Repository<T> => {
        repositoryManagers.add(manager);
        const repo = originalGetRepository(entity);
        if (entity === JobApplication && failAt === 'application') {
          const originalSave = repo.save.bind(repo);
          repo.save = (async (value: any) => {
            const saved = await originalSave(value);
            throw new Error('injected application failure');
          }) as typeof repo.save;
        }
        if (entity === Shift && failAt === 'shift') {
          const originalSave = repo.save.bind(repo);
          repo.save = (async (value: any) => {
            const saved = await originalSave(value);
            throw new Error('injected shift failure');
          }) as typeof repo.save;
        }
        if (entity === Timesheet && failAt === 'timesheet') {
          const originalSave = repo.save.bind(repo);
          repo.save = (async (value: any) => {
            const saved = await originalSave(value);
            throw new Error('injected timesheet failure');
          }) as typeof repo.save;
        }
        return repo;
      }) as typeof manager.getRepository;
      const runner = manager.queryRunner!;
      const originalQuery = runner.query.bind(runner);
      runner.query = (async (...args: any[]) => {
        if (/FOR UPDATE/i.test(String(args[0]))) lockSeen = true;
        return originalQuery(args[0], args[1], args[2]);
      }) as typeof runner.query;
      return work(manager);
    }),
  };

  const service = new JobApplicationService(
    dataSource.getRepository(JobApplication), jobService, guardService as any, assignmentService, shiftService,
    { log: async () => undefined } as any, { createForUser: async () => undefined } as any,
    companyService as any, siteService as any, companyGuardService, availability as any, compliance as any,
    transactionalDataSource as any,
  );
  return {
    service,
    evidence: () => ({ lockSeen, managerCount: repositoryManagers.size }),
  };
}

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('SEC-019 database must be localhost-only');
  if (parsed.port !== '55435') throw new Error('SEC-019 database must use the isolated port 55435');
  if (parsed.pathname !== '/s4_sec019_test') throw new Error('SEC-019 database identity mismatch');

  const dataSource = new DataSource(buildTypeOrmOptions({
    DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test',
  }));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
    const migrationRows = await dataSource.query('SELECT count(*)::int AS count FROM typeorm_migrations');
    equal(migrationRows[0].count, 40);

    for (const point of ['application', 'relationship', 'assignment', 'job', 'shift', 'timesheet'] as FailurePoint[]) {
      const fixture = await resetAndSeed(dataSource, point);
      const test = services(dataSource, point);
      await rejects(() => test.service.hire(fixture.applicationId, {
        createShift: true, siteId: 1,
        start: '2026-09-01T09:00:00Z', end: '2026-09-01T17:00:00Z',
      }), new RegExp(`injected ${point} failure`));
      deepEqual(await readState(dataSource, fixture), expectedRollback);
      ok(test.evidence().lockSeen, `${point}: PostgreSQL FOR UPDATE was not executed`);
      equal(test.evidence().managerCount, 1, `${point}: more than one transaction manager participated`);
      console.log(`PASS rollback:${point}`);
    }

    const fixture = await resetAndSeed(dataSource, 'success');
    const test = services(dataSource);
    await test.service.hire(fixture.applicationId, {
      createShift: true, siteId: 1,
      start: '2026-09-01T09:00:00Z', end: '2026-09-01T17:00:00Z',
    });
    deepEqual(await readState(dataSource, fixture), {
      applicationStatus: 'accepted', companyGuards: 1, assignments: 1,
      jobStatus: 'filled', shifts: 1, timesheets: 1,
    });
    ok(test.evidence().lockSeen, 'success: PostgreSQL FOR UPDATE was not executed');
    equal(test.evidence().managerCount, 1, 'success: more than one transaction manager participated');
    console.log('PASS success:all records committed together');
    console.log(JSON.stringify({ event: 'hire_atomicity_postgres_verified', tests: 7, migrations: 40 }));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
