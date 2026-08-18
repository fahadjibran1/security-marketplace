import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { Company, CompanyStatus } from '../src/company/entities/company.entity';
import { GuardApprovalStatus, GuardAvailability, GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Client } from '../src/client/entities/client.entity';
import { Site } from '../src/site/entities/site.entity';
import { Assignment } from '../src/assignment/entities/assignment.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { Timesheet, TimesheetBillingStatus, TimesheetPayrollStatus, TimesheetStatus } from '../src/timesheet/entities/timesheet.entity';
import { PayrollBatch } from '../src/payroll-batch/entities/payroll-batch.entity';
import { InvoiceBatch } from '../src/invoice-batch/entities/invoice-batch.entity';
import { PaymentRecord } from '../src/payment-record/entities/payment-record.entity';
import { PayrollBatchService } from '../src/payroll-batch/payroll-batch.service';
import { InvoiceBatchService } from '../src/invoice-batch/invoice-batch.service';

function pairedBarrierCompanyService(company: Company) {
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {
    async findByUserId() {
      calls += 1;
      if (calls === 2) release();
      await barrier;
      return company;
    },
  };
}

function immediateCompanyService(company: Company) {
  return { findByUserId: async () => company };
}

function makeServices(dataSource: DataSource, company: Company, concurrent = false) {
  const companyService = concurrent ? pairedBarrierCompanyService(company) : immediateCompanyService(company);
  const auditLogService = { log: async (input: unknown) => input };
  const payRuleService = {
    getConfigForCompany: async () => null,
    calculatePay: (timesheet: Timesheet) => ({
      payableHours: Number(timesheet.approvedMinutes) / 60,
      payableAmount: null,
    }),
  };
  const contractPricingService = { applyFinancials: async <T>(value: T) => value };

  return {
    payroll: new PayrollBatchService(
      dataSource.getRepository(PayrollBatch),
      dataSource.getRepository(Timesheet),
      companyService as any,
      auditLogService as any,
      payRuleService as any,
      dataSource,
    ),
    invoice: new InvoiceBatchService(
      dataSource.getRepository(InvoiceBatch),
      dataSource.getRepository(Timesheet),
      dataSource.getRepository(Client),
      dataSource.getRepository(PaymentRecord),
      companyService as any,
      contractPricingService as any,
      auditLogService as any,
      dataSource,
    ),
  };
}

async function seed(dataSource: DataSource) {
  const userRepo = dataSource.getRepository(User);
  const companyUser = await userRepo.save(userRepo.create({
    email: 'company@m2.test', passwordHash: 'test', role: UserRole.COMPANY,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const guardUser = await userRepo.save(userRepo.create({
    email: 'guard@m2.test', passwordHash: 'test', role: UserRole.GUARD,
    status: UserStatus.ACTIVE, isEmailVerified: true,
  }));
  const companyRepo = dataSource.getRepository(Company);
  const company = await companyRepo.save(companyRepo.create({
    user: companyUser, name: 'M2 Test Company', companyNumber: 'M2-1', address: 'Test',
    contactDetails: 'test', status: CompanyStatus.ACTIVE,
  }));
  const guardRepo = dataSource.getRepository(GuardProfile);
  const guard = await guardRepo.save(guardRepo.create({
    user: guardUser, fullName: 'M2 Guard', siaLicenseNumber: 'M2-SIA', phone: '000',
    availability: GuardAvailability.AVAILABLE, approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true, status: 'active',
  }));
  const clientRepo = dataSource.getRepository(Client);
  const client = await clientRepo.save(clientRepo.create({ company, name: 'M2 Client', status: 'active' }));
  const siteRepo = dataSource.getRepository(Site);
  const site = await siteRepo.save(siteRepo.create({
    company, client, name: 'M2 Site', address: 'Test', status: 'active', requiredGuardCount: 1,
  }));
  const assignmentRepo = dataSource.getRepository(Assignment);
  const assignment = await assignmentRepo.save(assignmentRepo.create({ company, guard, status: 'assigned' }));
  const shiftRepo = dataSource.getRepository(Shift);
  const timesheetRepo = dataSource.getRepository(Timesheet);
  const timesheets: Timesheet[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const shift = await shiftRepo.save(shiftRepo.create({
      company, guard, assignment, site, siteName: 'M2 Site',
      start: new Date(`2026-01-${String(index).padStart(2, '0')}T09:00:00Z`),
      end: new Date(`2026-01-${String(index).padStart(2, '0')}T17:00:00Z`),
      status: 'completed', checkCallIntervalMinutes: 60,
    }));
    timesheets.push(await timesheetRepo.save(timesheetRepo.create({
      company, guard, shift, hoursWorked: 8, approvalStatus: TimesheetStatus.APPROVED,
      approvedHours: 8, approvedMinutes: 480, verifiedMinutes: 480,
      workedMinutes: 480, breakMinutes: 0, roundedMinutes: 480,
      payrollStatus: TimesheetPayrollStatus.UNPAID,
      billingStatus: TimesheetBillingStatus.UNINVOICED,
    })));
  }
  return { company, client, timesheets };
}

function batchDto(ids: number[]) {
  return { periodStart: '2026-01-01', periodEnd: '2026-01-31', timesheetIds: ids } as any;
}

function invoiceDto(clientId: number, ids: number[]) {
  return { ...batchDto(ids), clientId } as any;
}

function assertOneSuccessOneConflict(results: PromiseSettledResult<unknown>[]) {
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof ConflictException, 'losing transaction must return ConflictException');
}

async function main() {
  const url = process.env.FINANCIAL_CONCURRENCY_DATABASE_URL;
  if (!url) throw new Error('FINANCIAL_CONCURRENCY_DATABASE_URL is required');
  const dataSource = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false,
  });
  await dataSource.initialize();
  try {
    const [{ server_version: postgresVersion }] = await dataSource.query('SHOW server_version');
    const { company, client, timesheets } = await seed(dataSource);

    const payrollPair = makeServices(dataSource, company, true);
    const payrollRace = await Promise.allSettled([
      payrollPair.payroll.createForCompany(company.user.id, batchDto([timesheets[0].id])),
      payrollPair.payroll.createForCompany(company.user.id, batchDto([timesheets[0].id])),
    ]);
    assertOneSuccessOneConflict(payrollRace);
    assert.equal(await dataSource.getRepository(PayrollBatch).count(), 1);
    assert.ok((await dataSource.getRepository(Timesheet).findOneByOrFail({ id: timesheets[0].id })).payrollBatch);

    const invoicePair = makeServices(dataSource, company, true);
    const invoiceRace = await Promise.allSettled([
      invoicePair.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[1].id])),
      invoicePair.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[1].id])),
    ]);
    assertOneSuccessOneConflict(invoiceRace);
    assert.equal(await dataSource.getRepository(InvoiceBatch).count(), 1);
    assert.ok((await dataSource.getRepository(Timesheet).findOneByOrFail({ id: timesheets[1].id })).invoiceBatch);

    const payrollOverlap = makeServices(dataSource, company, true);
    const payrollOverlapResults = await Promise.allSettled([
      payrollOverlap.payroll.createForCompany(company.user.id, batchDto([timesheets[2].id, timesheets[3].id])),
      payrollOverlap.payroll.createForCompany(company.user.id, batchDto([timesheets[3].id, timesheets[4].id])),
    ]);
    assertOneSuccessOneConflict(payrollOverlapResults);
    assert.ok((await dataSource.getRepository(Timesheet).findOneByOrFail({ id: timesheets[3].id })).payrollBatch);

    const invoiceOverlap = makeServices(dataSource, company, true);
    const invoiceOverlapResults = await Promise.allSettled([
      invoiceOverlap.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[5].id, timesheets[6].id])),
      invoiceOverlap.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[6].id, timesheets[7].id])),
    ]);
    assertOneSuccessOneConflict(invoiceOverlapResults);
    assert.ok((await dataSource.getRepository(Timesheet).findOneByOrFail({ id: timesheets[6].id })).invoiceBatch);

    const retryServices = makeServices(dataSource, company);
    await retryServices.payroll.createForCompany(company.user.id, batchDto([timesheets[8].id]));
    await assert.rejects(
      retryServices.payroll.createForCompany(company.user.id, batchDto([timesheets[8].id])),
      ConflictException,
    );
    await retryServices.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[9].id]));
    await assert.rejects(
      retryServices.invoice.createForCompany(company.user.id, invoiceDto(client.id, [timesheets[9].id])),
      ConflictException,
    );

    await dataSource.query(`CREATE FUNCTION m2_fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."id" = ${timesheets[10].id} AND NEW."payrollBatchId" IS NOT NULL THEN RAISE EXCEPTION 'M2 injected failure'; END IF; RETURN NEW; END $$`);
    await dataSource.query(`CREATE TRIGGER m2_fail_claim BEFORE UPDATE ON "timesheets" FOR EACH ROW EXECUTE FUNCTION m2_fail_claim()`);
    const countBeforeFailure = await dataSource.getRepository(PayrollBatch).count();
    await assert.rejects(retryServices.payroll.createForCompany(company.user.id, batchDto([timesheets[10].id])));
    assert.equal(await dataSource.getRepository(PayrollBatch).count(), countBeforeFailure, 'failed transaction must roll back its batch');
    const rolledBack = await dataSource.getRepository(Timesheet).findOneByOrFail({ id: timesheets[10].id });
    assert.equal(rolledBack.payrollBatch, null);
    assert.equal(rolledBack.payrollStatus, TimesheetPayrollStatus.UNPAID);
    await dataSource.query('DROP TRIGGER m2_fail_claim ON "timesheets"');
    await dataSource.query('DROP FUNCTION m2_fail_claim()');

    // Negative control: both transactions read the old nullable membership before
    // either writes. Without FOR UPDATE, both batches survive and the second update
    // merely overwrites the single FK slot.
    const runnerA = dataSource.createQueryRunner();
    const runnerB = dataSource.createQueryRunner();
    await Promise.all([runnerA.connect(), runnerB.connect()]);
    await Promise.all([runnerA.startTransaction(), runnerB.startTransaction()]);
    const negativeId = timesheets[11].id;
    const [readA, readB] = await Promise.all([
      runnerA.query('SELECT "payrollBatchId" FROM "timesheets" WHERE "id" = $1', [negativeId]),
      runnerB.query('SELECT "payrollBatchId" FROM "timesheets" WHERE "id" = $1', [negativeId]),
    ]);
    assert.equal(readA[0].payrollBatchId, null);
    assert.equal(readB[0].payrollBatchId, null);
    const insertedA = await runnerA.query(`INSERT INTO "payroll_batches" ("companyId", "periodStart", "periodEnd", "status") VALUES ($1, NOW(), NOW(), 'draft') RETURNING "id"`, [company.id]);
    await runnerA.query('UPDATE "timesheets" SET "payrollBatchId" = $1 WHERE "id" = $2', [insertedA[0].id, negativeId]);
    await runnerA.commitTransaction();
    const insertedB = await runnerB.query(`INSERT INTO "payroll_batches" ("companyId", "periodStart", "periodEnd", "status") VALUES ($1, NOW(), NOW(), 'draft') RETURNING "id"`, [company.id]);
    await runnerB.query('UPDATE "timesheets" SET "payrollBatchId" = $1 WHERE "id" = $2', [insertedB[0].id, negativeId]);
    await runnerB.commitTransaction();
    await Promise.all([runnerA.release(), runnerB.release()]);
    assert.notEqual(insertedA[0].id, insertedB[0].id);

    console.log(JSON.stringify({
      event: 'financial_concurrency_tests_passed',
      postgres: postgresVersion, tests: 8,
      negativeControl: 'old unlocked read allowed two batches for one selected timesheet',
    }));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
