/**
 * Performance P3 — dashboard query remediation certification.
 *
 * The S4 incident of 15 Oct 2026 (~22:04 UTC): one Company dashboard load sent its list requests, each a
 * single TypeORM statement joining the whole eager entity graph (57-71 JOINs, 100-145 KB of SQL). On the
 * production database those statements ran for minutes, connections piled up behind them, the pooler's
 * authentication timed out and the API answered 500/502/503.
 *
 * P3 reads those graphs in batches (database/eager-graph): the root rows without eager joins, then each
 * related entity type by primary key. Proven here, against a real local PostgreSQL, by comparing every
 * read with TypeORM's own `find` on the same rows:
 *
 *   P3-01  lists (by company, by Guard, nested where, order, pagination): identical entities, classes included
 *   P3-02  single-row reads (findOne, findOneBy, findOneOrFail, missing rows): identical
 *   P3-03  explicit relations, including a one-to-many (job applications -> assignments -> shifts): identical
 *   P3-04  no statement above 8 JOINs; the statement count does not grow with the rows (no N+1)
 *   P3-05  what is not modelled (locks, select, query builders) runs exactly as before
 *   P3-06  inside a transaction it reads on the transaction's own connection and sees its writes
 *   P3-07  tenant isolation: a company's graph never reaches another company's rows
 *   P3-08  scope: only the DataSource it is enabled on; small graphs stay one statement
 *   P3-09  the application's own DataSource has it (AppModule wiring)
 *
 * Requires PERF_P3_DATABASE_URL (localhost).
 */
import 'reflect-metadata';
import * as assert from 'assert';
import { DataSource, EntityManager, In, Logger as TypeOrmLogger } from 'typeorm';

const url = process.env.PERF_P3_DATABASE_URL ?? '';
if (!url) throw new Error('PERF_P3_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('database must be local');

process.env.DATABASE_URL = url;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'perf-p3-local-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.DATABASE_POOLER_URL;
delete process.env.DB_POOL_DIAGNOSTICS;

let passed = 0;
const pass = (name: string) => {
  passed += 1;
  console.log(`PASS ${name}`);
};

/** Records the JOIN count of every statement while `on`. */
class StatementCapture implements TypeOrmLogger {
  on = false;
  statements: number[] = [];
  logQuery(query: string) {
    if (this.on && !/^(START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(query)) this.statements.push((query.match(/\bJOIN\b/g) ?? []).length);
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number; maxJoins: number }> {
    this.statements = [];
    this.on = true;
    try {
      const value = await fn();
      return { value, statements: this.statements.length, maxJoins: Math.max(0, ...this.statements) };
    } finally {
      this.on = false;
    }
  }
}

/** Plain data with every object's class name, keys sorted: what must match between the two loads. */
function typed(value: unknown, sortManyById = false): unknown {
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (Array.isArray(value)) {
    const items = value.map((v) => typed(v, sortManyById));
    return sortManyById && items.every((i: any) => i && typeof i === 'object' && 'id' in i)
      ? [...items].sort((a: any, b: any) => Number(a.id) - Number(b.id))
      : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = { __class: (value as object).constructor?.name };
    for (const key of Object.keys(value as object).sort()) out[key] = typed((value as any)[key], sortManyById);
    return out;
  }
  return value;
}

/** Every company id anywhere in a graph. */
function companyIdsIn(value: unknown, acc = new Set<number>(), seen = new Set<unknown>()): Set<number> {
  if (!value || typeof value !== 'object' || seen.has(value)) return acc;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((v) => companyIdsIn(v, acc, seen)); return acc; }
  if ((value as object).constructor?.name === 'Company' && typeof (value as any).id === 'number') acc.add((value as any).id);
  for (const v of Object.values(value as object)) companyIdsIn(v, acc, seen);
  return acc;
}

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const { enableGraphLoading, graphPlan, GRAPH_LOADING_MIN_JOINS } = await import('../src/database/eager-graph');
  const options = buildTypeOrmOptions({ DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });

  const migrator = new DataSource(options);
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  // The same database through two DataSources: TypeORM as it is, and with graph loading.
  const plainLog = new StatementCapture();
  const graphLog = new StatementCapture();
  const plain = await new DataSource({ ...options, logging: true, logger: plainLog } as any).initialize();
  const graph = await enableGraphLoading(new DataSource({ ...options, logging: true, logger: graphLog } as any)).initialize();

  const { User, UserRole, UserStatus } = await import('../src/user/entities/user.entity');
  const { Company } = await import('../src/company/entities/company.entity');
  const { Client } = await import('../src/client/entities/client.entity');
  const { Site } = await import('../src/site/entities/site.entity');
  const { Job } = await import('../src/job/entities/job.entity');
  const { JobApplication } = await import('../src/job-application/entities/job-application.entity');
  const { Assignment } = await import('../src/assignment/entities/assignment.entity');
  const { GuardProfile } = await import('../src/guard-profile/entities/guard-profile.entity');
  const { CompanyGuard } = await import('../src/company-guard/entities/company-guard.entity');
  const { Shift } = await import('../src/shift/entities/shift.entity');
  const { AttendanceEvent, AttendanceEventType } = await import('../src/attendance/entities/attendance.entity');
  const { DailyLog, DailyLogType } = await import('../src/daily-log/entities/daily-log.entity');
  const { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } = await import('../src/safety-alert/entities/safety-alert.entity');
  const { Incident } = await import('../src/incident/entities/incident.entity');
  const { Timesheet } = await import('../src/timesheet/entities/timesheet.entity');

  // ── fixtures: two tenants, every relation path populated and every nullable one left empty somewhere ──
  const RUN = Date.now().toString(36);
  let seq = 0;
  const base = Date.UTC(2026, 9, 1, 8, 0, 0);
  const at = (minutes: number) => new Date(base + minutes * 60_000);
  const save = <T extends object>(entity: new () => T, data: any): Promise<T> => plain.getRepository(entity).save(plain.getRepository(entity).create(data) as any) as any;

  async function tenant(label: string) {
    const owner = await save(User, { email: `${label}.${RUN}@p3.invalid`, passwordHash: 'x', role: UserRole.COMPANY_ADMIN, status: UserStatus.ACTIVE });
    const company: any = await save(Company, { user: owner, name: `${label} Security Ltd`, companyNumber: String(40000000 + ++seq), address: '1 Test St', contactDetails: 'ops@p3.invalid' });
    const client = await save(Client, { company, name: `${label} Retail` });
    const siteA = await save(Site, { company, client, name: `${label} Store`, address: '2 Test St', status: 'active', requiredGuardCount: 2, timezone: 'Europe/London' });
    const siteB = await save(Site, { company, name: `${label} Depot`, address: '3 Test St', status: 'active', requiredGuardCount: 1, timezone: 'Europe/London' });
    const job = await save(Job, { company, site: siteA, title: 'Static', guardsRequired: 2, hourlyRate: 14 });
    const guards: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      const user = await save(User, { email: `${label}.g${i}.${RUN}@p3.invalid`, passwordHash: 'x', role: UserRole.GUARD, status: UserStatus.ACTIVE });
      const guard = await save(GuardProfile, { user, fullName: `${label} Guard ${i}`, siaLicenseNumber: String(6400000000000000 + ++seq), phone: '07700000000' });
      await save(CompanyGuard, { company, guard });
      guards.push(guard);
    }
    const hired = await save(JobApplication, { job, guard: guards[0], status: 'hired', appliedAt: at(-5000 - seq), hiredAt: at(-4900) });
    await save(JobApplication, { job, guard: guards[1], status: 'applied', appliedAt: at(-4000 - seq) });
    const assignment = await save(Assignment, { job, company, guard: guards[0], application: hired, status: 'assigned', assignedAt: at(-4800) });
    const shifts: any[] = [];
    for (let i = 0; i < 12; i += 1) {
      const site = i % 3 === 2 ? siteB : siteA;
      const guard = i % 4 === 3 ? null : guards[i % 3];
      const viaAssignment = i % 4 === 0;
      shifts.push(await save(Shift, {
        company, site, siteName: site.name, guard: viaAssignment ? guards[0] : guard,
        assignment: viaAssignment ? assignment : null, job: viaAssignment ? job : null, jobApplication: viaAssignment ? hired : null,
        start: at(i * 600 + seq), end: at(i * 600 + 480 + seq), status: guard || viaAssignment ? 'completed' : 'unfilled', checkCallIntervalMinutes: 60,
      }));
    }
    for (const [i, shift] of shifts.entries()) {
      if (!shift.guard) continue;
      await save(AttendanceEvent, { shift, guard: shift.guard, type: AttendanceEventType.CHECK_IN, occurredAt: at(i * 600 + 1 + seq) });
      if (i % 2 === 0) await save(AttendanceEvent, { shift, guard: shift.guard, type: AttendanceEventType.CHECK_OUT, occurredAt: at(i * 600 + 470 + seq) });
      const logEntry: any = await save(DailyLog, { company, guard: shift.guard, shift, message: 'entry', logType: DailyLogType.CHECK_CALL });
      await plain.query('UPDATE daily_logs SET "createdAt" = $1 WHERE id = $2', [at(i * 600 + 60 + seq), logEntry.id]);
      const alertRow: any = await save(SafetyAlert, { company, guard: i % 5 === 0 ? null : shift.guard, shift, type: SafetyAlertType.MISSED_CHECKCALL, priority: SafetyAlertPriority.HIGH, status: SafetyAlertStatus.OPEN, welfareWindowIndex: i, message: 'alert' });
      await plain.query('UPDATE safety_alerts SET "createdAt" = $1 WHERE id = $2', [at(i * 600 + 90 + seq), alertRow.id]);
      const timesheet: any = await save(Timesheet, { shift, guard: shift.guard, company });
      await plain.query('UPDATE timesheets SET "createdAt" = $1 WHERE id = $2', [at(i * 600 + 500 + seq), timesheet.id]);
    }
    for (let i = 0; i < 4; i += 1) {
      const incident: any = await save(Incident, { company, guard: guards[i % 3], shift: i === 2 ? null : shifts[i * 2], site: i === 1 ? siteB : siteA, title: `Incident ${i}`, notes: 'notes' });
      await plain.query('UPDATE incidents SET "createdAt" = $1 WHERE id = $2', [at(i * 300 + seq), incident.id]);
    }
    return { company, guards, shifts, job, assignment, hired, siteA };
  }
  const A = await tenant('p3a');
  const B = await tenant('p3b');

  const both = async <T>(read: (m: EntityManager) => Promise<T>, sortManyById = false) => {
    const p = await plainLog.measure(() => read(plain.manager));
    const g = await graphLog.measure(() => read(graph.manager));
    assert.deepStrictEqual(typed(g.value, sortManyById), typed(p.value, sortManyById));
    return { plain: p, graph: g };
  };
  const shapes: Array<{ name: string; plainJoins: number; graphJoins: number; graphStatements: number }> = [];
  const record = (name: string, r: Awaited<ReturnType<typeof both>>) => shapes.push({ name, plainJoins: r.plain.maxJoins, graphJoins: r.graph.maxJoins, graphStatements: r.graph.statements });

  // ── P3-01 lists ───────────────────────────────────────────────────────────────────────────────────
  const lists: Array<[string, (m: EntityManager) => Promise<unknown[]>]> = [
    ['shifts by company (GET /shifts)', (m) => m.find(Shift, { where: { company: { id: A.company.id } }, relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'], order: { start: 'DESC' } })],
    ['shifts by Guard (GET /shifts/my)', (m) => m.find(Shift, { where: { guard: { id: A.guards[0].id } }, relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'], order: { start: 'DESC' } })],
    ['attendance by company via shift (GET /attendance/company)', (m) => m.find(AttendanceEvent, { where: { shift: { company: { id: A.company.id } } }, order: { occurredAt: 'DESC' } })],
    ['attendance by Guard', (m) => m.find(AttendanceEvent, { where: { guard: { id: A.guards[1].id } }, order: { occurredAt: 'DESC' } })],
    ['incidents by company', (m) => m.find(Incident, { where: { company: { id: A.company.id } }, order: { createdAt: 'DESC' } })],
    ['alerts by company', (m) => m.find(SafetyAlert, { where: { company: { id: A.company.id } }, order: { createdAt: 'DESC' } })],
    ['alerts by company and type', (m) => m.find(SafetyAlert, { where: { company: { id: A.company.id }, type: SafetyAlertType.MISSED_CHECKCALL }, order: { createdAt: 'DESC' } })],
    ['daily logs by company', (m) => m.find(DailyLog, { where: { company: { id: A.company.id } }, order: { createdAt: 'DESC' } })],
    ['timesheets by company', (m) => m.find(Timesheet, { where: { company: { id: A.company.id } }, order: { createdAt: 'DESC' } })],
    ['findBy', (m) => m.findBy(Incident, { company: { id: A.company.id } }).then((rows) => rows.sort((x, y) => x.id - y.id))],
    ['OR conditions', (m) => m.find(Shift, { where: [{ site: { id: A.siteA.id } }, { guard: { id: B.guards[0].id } }], order: { id: 'ASC' } })],
    ['pagination (take/skip)', (m) => m.find(Shift, { where: { company: { id: A.company.id } }, order: { start: 'ASC' }, take: 3, skip: 2 })],
  ];
  for (const [name, read] of lists) {
    const r = await both(read);
    assert.ok((r.plain.value as unknown[]).length > 0, `${name}: the fixture has rows`);
    record(name, r);
  }
  pass(`P3-01 ${lists.length} list reads identical to TypeORM's own find, nested classes included`);

  // ── P3-02 single rows ─────────────────────────────────────────────────────────────────────────────
  const shiftId = A.shifts[4].id;
  const singles: Array<[string, (m: EntityManager) => Promise<unknown>]> = [
    ['findOne shift (ShiftService.findOne)', (m) => m.findOne(Shift, { where: { id: shiftId }, relations: ['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'] })],
    ['findOne alert', (m) => m.findOne(SafetyAlert, { where: { shift: { id: shiftId } } })],
    ['findOneBy incident', (m) => m.findOneBy(Incident, { company: { id: A.company.id }, title: 'Incident 1' })],
    ['findOneOrFail timesheet', (m) => m.findOneOrFail(Timesheet, { where: { shift: { id: shiftId } } })],
    ['latest attendance (order + take 1)', (m) => m.findOne(AttendanceEvent, { where: { shift: { id: shiftId } }, order: { occurredAt: 'DESC', id: 'DESC' } })],
    ['missing row', (m) => m.findOne(Shift, { where: { id: 2_000_000_000 } })],
  ];
  for (const [name, read] of singles) record(name, await both(read));
  await assert.rejects(graph.manager.findOneByOrFail(Shift, { id: 2_000_000_000 }), /Could not find any entity/);
  pass('P3-02 single-row reads identical (findOne, findOneBy, findOneOrFail, ordered take-1, missing rows)');

  // ── P3-03 explicit relations, one-to-many ─────────────────────────────────────────────────────────
  // A one-to-many array has no defined order in a joined load, so it is compared by id.
  const apps = await both((m) => m.find(JobApplication, { where: { job: { company: { id: A.company.id } } }, relations: { assignments: { shifts: true } }, order: { appliedAt: 'DESC' } }), true);
  const hiredApp: any = (apps.graph.value as any[]).find((a) => a.id === A.hired.id);
  assert.equal(hiredApp.assignments.length, 1);
  assert.ok(hiredApp.assignments[0].shifts.length >= 3, 'the assignment carries its shifts');
  assert.ok(hiredApp.assignments[0].job && hiredApp.assignments[0].application, 'an explicit relation brings its direct eager relations');
  assert.equal(hiredApp.assignments[0].application.guard, undefined, '...one level deep, as TypeORM does');
  const ids = hiredApp.assignments[0].shifts.map((s: any) => s.id);
  assert.deepEqual(ids, [...ids].sort((x: number, y: number) => x - y), 'and in primary-key order');
  record('job applications with assignments.shifts', apps);
  const nested = await both((m) => m.find(Shift, { where: { id: In(A.shifts.map((s) => s.id)) }, relations: { site: { client: true } }, order: { id: 'ASC' } }));
  record('explicit nested relations', nested);
  pass('P3-03 explicit relations, nested and one-to-many: identical (one-to-many compared by id; returned in primary-key order)');

  // ── P3-04 statement shape ─────────────────────────────────────────────────────────────────────────
  for (const s of shapes) {
    assert.ok(s.graphJoins <= 8, `${s.name}: ${s.graphJoins} JOINs in one statement`);
    assert.ok(s.graphStatements <= 14, `${s.name}: ${s.graphStatements} statements`);
  }
  const heaviest = shapes.reduce((m, s) => (s.plainJoins > m.plainJoins ? s : m));
  assert.ok(heaviest.plainJoins >= 57, `before: ${heaviest.name} was one statement of ${heaviest.plainJoins} JOINs`);
  // No N+1: one row or all of them, the same number of statements.
  const one = await graphLog.measure(() => graph.manager.find(SafetyAlert, { where: { id: In([A.shifts[1].id]) } }));
  const oneAlert = await graphLog.measure(() => graph.manager.find(SafetyAlert, { where: { company: { id: A.company.id } }, take: 1, order: { createdAt: 'ASC' } }));
  const allAlerts = await graphLog.measure(() => graph.manager.find(SafetyAlert, { where: { company: { id: In([A.company.id, B.company.id]) } } }));
  assert.ok((allAlerts.value as any[]).length >= 16 && one.statements >= 1);
  assert.ok(allAlerts.statements <= oneAlert.statements + 1, `rows do not add statements (${oneAlert.statements} for one alert, ${allAlerts.statements} for ${(allAlerts.value as any[]).length})`);
  pass(`P3-04 every read at most 8 JOINs per statement (was up to ${heaviest.plainJoins}); ${oneAlert.statements} statements for 1 alert, ${allAlerts.statements} for ${(allAlerts.value as any[]).length}: no N+1`);

  // ── P3-05 not modelled: unchanged ─────────────────────────────────────────────────────────────────
  {
    const shiftMeta = graph.getMetadata(Shift);
    for (const lock of [{ mode: 'pessimistic_read' }, { mode: 'pessimistic_write' }, { mode: 'for_no_key_update' }]) {
      assert.equal(graphPlan(shiftMeta, { where: { id: shiftId }, lock } as any, GRAPH_LOADING_MIN_JOINS), null, `a ${lock.mode} read is never batched`);
    }
    const strategy = await both((m) => m.find(Shift, { where: { id: shiftId }, relationLoadStrategy: 'join' }));
    assert.equal(strategy.graph.statements, strategy.plain.statements, 'an explicit relationLoadStrategy runs the original statement');
    assert.equal(strategy.graph.maxJoins, strategy.plain.maxJoins);
    const selected = await both((m) => m.find(Shift, { where: { id: shiftId }, select: { id: true, status: true } }));
    assert.equal(selected.graph.maxJoins, selected.plain.maxJoins);
    const qb = await graphLog.measure(() => graph.getRepository(Shift).createQueryBuilder('s').leftJoinAndSelect('s.site', 'site').where('s.id = :id', { id: shiftId }).getOne());
    assert.ok(qb.value && qb.statements === 1, 'query builders are untouched');
    pass('P3-05 locking reads, an explicit relationLoadStrategy, custom select and query builders run exactly as before');
  }

  // ── P3-06 transactions ────────────────────────────────────────────────────────────────────────────
  {
    const pool: any = (graph.driver as any).master;
    await graph.transaction(async (m) => {
      const inserted: any = await m.save(m.create(Incident, { company: A.company, guard: A.guards[0], shift: A.shifts[0], site: A.siteA, title: 'In-transaction', notes: 'n' } as any));
      const before = pool.totalCount;
      const seen: any = await m.findOne(Incident, { where: { id: inserted.id } });
      assert.equal(seen?.title, 'In-transaction', 'the transaction sees its own write');
      assert.equal(seen.shift.site.client.company.id, A.company.id, 'with the whole graph');
      assert.equal(pool.totalCount, before, 'and opens no other connection');
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch((e) => { if (!e.rollback) throw e; });
    assert.equal(await graph.manager.count(Incident, { where: { title: 'In-transaction' } }), 0);
    pass('P3-06 inside a transaction: reads on the transaction connection, sees its own uncommitted rows, opens nothing else');
  }

  // ── P3-07 tenant isolation ────────────────────────────────────────────────────────────────────────
  for (const [entity, where] of [[Shift, { company: { id: A.company.id } }], [SafetyAlert, { company: { id: A.company.id } }], [Incident, { company: { id: A.company.id } }], [Timesheet, { company: { id: A.company.id } }], [AttendanceEvent, { shift: { company: { id: A.company.id } } }], [DailyLog, { company: { id: A.company.id } }]] as const) {
    const rows = await graph.manager.find(entity as any, { where: where as any });
    assert.ok(rows.length > 0);
    assert.deepEqual([...companyIdsIn(rows)], [A.company.id], `${(entity as any).name}: only company A anywhere in the graph`);
  }
  pass('P3-07 tenant isolation: company A\'s graphs contain company A and nothing else, at every depth');

  // ── P3-08 scope ───────────────────────────────────────────────────────────────────────────────────
  {
    const plainShift = await plainLog.measure(() => plain.manager.findOne(Shift, { where: { id: shiftId } }));
    assert.ok(plainShift.maxJoins >= 57, 'a DataSource it is not enabled on is untouched');
    const site = await graphLog.measure(() => graph.manager.find(Site, { where: { company: { id: A.company.id } } }));
    assert.equal(site.statements, 1, `a graph below ${GRAPH_LOADING_MIN_JOINS} JOINs stays one statement`);
    pass(`P3-08 only the DataSource it is enabled on; graphs under ${GRAPH_LOADING_MIN_JOINS} JOINs (Site: ${site.maxJoins}) stay one statement`);
  }

  // ── P3-09 application wiring ──────────────────────────────────────────────────────────────────────
  {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../src/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const appDs = app.get(DataSource);
    const capture = new StatementCapture();
    (appDs as any).logger = capture;
    (appDs as any).options = { ...appDs.options, logging: true };
    const r = await capture.measure(() => appDs.getRepository(Shift).find({ where: { company: { id: A.company.id } } }));
    assert.ok((r.value as any[]).length === 12);
    assert.ok(r.maxJoins <= 8 && r.statements > 1, `the application's DataSource reads graphs in batches (${r.statements} statements, max ${r.maxJoins} JOINs)`);
    await app.close();
    pass(`P3-09 AppModule's DataSource has graph loading (GET /shifts: ${r.statements} statements, max ${r.maxJoins} JOINs)`);
  }

  console.log('\nshape before -> after (max JOINs per statement, statements):');
  for (const s of shapes) console.log(`  ${s.name.padEnd(52)} ${String(s.plainJoins).padStart(3)} -> ${s.graphJoins} JOINs, ${s.graphStatements} statements`);
  await plain.destroy();
  await graph.destroy();
  console.log(`\nperf-dashboard-p3: ${passed} passed`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
