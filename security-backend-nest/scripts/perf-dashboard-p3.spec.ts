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
 * Final safety remediation (S4 P3 safety review, 16 Oct 2026):
 *   P3-10  one snapshot: a row deleted or changed by another connection between the batches is seen as
 *          the first statement saw it (never an attendance event whose shift is null); one connection,
 *          one REPEATABLE READ, READ ONLY transaction per read, none inside the caller's transaction
 *   P3-11  a failure part-way through (an error, a connection killed mid-read) surfaces, is rolled back,
 *          leaves no connection held and no transaction open, and the next read works
 *   P3-12  a page of rows (take/skip, findOne) ordered by a related column: identical to TypeORM (read
 *          as TypeORM reads it); unpaged relation order and paged relation filters stay batched
 *   P3-13  cross-company isolation under 200 concurrent interleaved reads
 *   P3-14  a read that cannot complete raises an error; it never returns a graph with relations missing
 *   P3-15  large reads: 66,000 related rows (past PostgreSQL's 65,535 bind parameters) and 6,000
 *          one-to-many parents are read in bounded IN lists, complete, nothing truncated, deterministic
 *
 * Requires PERF_P3_DATABASE_URL (localhost).
 */
import 'reflect-metadata';
import * as assert from 'assert';
import { DataSource, EntityManager, In, Like, Logger as TypeOrmLogger, SelectQueryBuilder } from 'typeorm';

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
  /** Every statement while `on`, transaction control included. */
  raw: string[] = [];
  /** The most bind parameters any one statement carried while `on`. */
  maxParams = 0;
  logQuery(query: string, parameters?: unknown[]) {
    if (this.on) this.raw.push(query);
    if (this.on) this.maxParams = Math.max(this.maxParams, parameters?.length ?? 0);
    if (this.on && !/^(START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(query)) this.statements.push((query.match(/\bJOIN\b/g) ?? []).length);
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; statements: number; maxJoins: number; raw: string[]; maxParams: number }> {
    this.statements = [];
    this.raw = [];
    this.maxParams = 0;
    this.on = true;
    try {
      const value = await fn();
      return { value, statements: this.statements.length, maxJoins: Math.max(0, ...this.statements), raw: this.raw, maxParams: this.maxParams };
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

/**
 * A one-shot action run right after the next `getMany` of `entity` (a find's root rows) returns, before
 * any batch that follows it: the window in which another connection's write lands between statements.
 */
const between: { entity: string | null; run: (() => Promise<void>) | null } = { entity: null, run: null };
const getMany = SelectQueryBuilder.prototype.getMany;
(SelectQueryBuilder.prototype as any).getMany = async function (this: any) {
  const rows = await getMany.call(this);
  if (between.run && this.expressionMap?.mainAlias?.metadata?.name === between.entity) {
    const run = between.run;
    between.run = null;
    await run();
  }
  return rows;
};
const after = (entity: string, run: () => Promise<void>) => Object.assign(between, { entity, run });

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const { enableGraphLoading, graphPlan, GRAPH_LOADING_MIN_JOINS, GraphAssembler, IN_CHUNK } = await import('../src/database/eager-graph');
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
      const read = await graphLog.measure(() => m.findOne(Incident, { where: { id: inserted.id } }));
      const seen: any = read.value;
      assert.equal(seen?.title, 'In-transaction', 'the transaction sees its own write');
      assert.equal(seen.shift.site.client.company.id, A.company.id, 'with the whole graph');
      assert.equal(pool.totalCount, before, 'and opens no other connection');
      assert.ok(read.statements > 1 && !read.raw.some((q) => /START TRANSACTION|SAVEPOINT|COMMIT/i.test(q)), 'and leaves the caller\'s transaction exactly as it was');
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
    assert.deepEqual(site.raw.filter((q) => /TRANSACTION|COMMIT/i.test(q)), [], '...with no transaction around it');
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

  const pool: any = (graph.driver as any).master;
  const held = () => pool.totalCount - pool.idleCount;
  const openTransactions = async () =>
    Number((await plain.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`))[0].n);

  // ── P3-10 one snapshot ────────────────────────────────────────────────────────────────────────────
  {
    const connect = pool.connect;
    let checkouts = 0;
    pool.connect = function (this: unknown, ...args: unknown[]) { checkouts += 1; return connect.apply(this, args); };
    const victimFor = async (minutes: number) => {
      const shift: any = await save(Shift, { company: A.company, site: A.siteA, siteName: 'victim', guard: A.guards[1], start: at(minutes), end: at(minutes + 480), status: 'completed', checkCallIntervalMinutes: 60 });
      const event: any = await save(AttendanceEvent, { shift, guard: A.guards[1], type: AttendanceEventType.CHECK_IN, occurredAt: at(minutes + 1) });
      return { shift, event, expected: await plain.manager.find(AttendanceEvent, { where: { id: event.id } }) };
    };

    // (a) the shift is deleted (its attendance cascades) once the root rows are read.
    const v = await victimFor(90_000);
    after('AttendanceEvent', async () => { await plain.query('DELETE FROM shifts WHERE id = $1', [v.shift.id]); });
    checkouts = 0;
    const read = await graphLog.measure(() => graph.manager.find(AttendanceEvent, { where: { id: v.event.id } }));
    assert.equal(between.run, null, 'the deletion ran between the batches');
    assert.equal(await plain.manager.count(Shift, { where: { id: v.shift.id } }), 0, '...and was committed');
    assert.equal((read.value as any[])[0].shift?.id, v.shift.id, 'the event is returned with its shift, never shift = null');
    assert.deepStrictEqual(typed(read.value), typed(v.expected), 'the whole graph is the snapshot its first statement saw');
    assert.equal(read.raw[0], 'START TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    assert.equal(read.raw[read.raw.length - 1], 'COMMIT');
    assert.ok(read.statements > 1 && checkouts === 1, `${read.statements} statements on ${checkouts} pooled connection(s)`);

    // (b) control: the same deletion on a connection the caller manages (outside any transaction) is not
    // given a snapshot, and tears exactly as the review found: this test detects the defect.
    const w = await victimFor(91_000);
    const runner = graph.createQueryRunner();
    after('AttendanceEvent', async () => { await plain.query('DELETE FROM shifts WHERE id = $1', [w.shift.id]); });
    const torn: any[] = await runner.manager.find(AttendanceEvent, { where: { id: w.event.id } });
    await runner.release();
    assert.equal(torn[0].shift, null, 'without one snapshot the event comes back with shift = null');

    // (c) a related row changed meanwhile is read as it was when the read began.
    const expected = await plain.manager.find(Incident, { where: { company: { id: A.company.id } }, order: { id: 'ASC' } });
    after('Incident', async () => {
      await plain.query('UPDATE sites SET name = $1 WHERE id = $2', ['Renamed meanwhile', A.siteA.id]);
      await plain.query('UPDATE clients SET name = $1 WHERE "companyId" = $2', ['Renamed meanwhile', A.company.id]);
    });
    const changed = await graph.manager.find(Incident, { where: { company: { id: A.company.id } }, order: { id: 'ASC' } });
    await plain.query('UPDATE sites SET name = $1 WHERE id = $2', [A.siteA.name, A.siteA.id]);
    await plain.query('UPDATE clients SET name = $1 WHERE "companyId" = $2', ['p3a Retail', A.company.id]);
    assert.equal(between.run, null);
    assert.deepStrictEqual(typed(changed), typed(expected), 'rows changed meanwhile are read as of the snapshot, at every depth');
    pool.connect = connect;
    assert.equal(held(), 0);
    assert.equal(await openTransactions(), 0, 'no transaction is left open');
    pass(`P3-10 one snapshot per read: a shift deleted mid-read is still there with its event (control without the snapshot: shift = null); rows changed mid-read read as of the snapshot; ${read.statements} statements, 1 connection, REPEATABLE READ READ ONLY, committed`);
  }

  // ── P3-11 failure part-way through ────────────────────────────────────────────────────────────────
  {
    const read = () => graph.manager.find(Incident, { where: { company: { id: A.company.id } }, order: { id: 'ASC' } });
    const expected = await plain.manager.find(Incident, { where: { company: { id: A.company.id } }, order: { id: 'ASC' } });
    const outcome = (p: Promise<unknown>) => p.then(() => 'no error', (e) => String(e?.message ?? e));

    after('Incident', async () => { throw new Error('injected failure between batches'); });
    const failed = await graphLog.measure(() => outcome(read()));
    assert.match(failed.value, /injected failure between batches/, 'the error surfaces');
    assert.equal(failed.raw[failed.raw.length - 1], 'ROLLBACK', 'the snapshot transaction is rolled back');
    assert.equal(held(), 0, 'no connection is held');
    assert.equal(await openTransactions(), 0);

    after('Incident', async () => { throw new Error('injected failure in the caller transaction'); });
    const inTx = await outcome(graph.transaction((m) => m.find(Incident, { where: { company: { id: A.company.id } } })));
    assert.match(inTx, /injected failure in the caller transaction/, 'inside a transaction the error surfaces to the caller, who rolls back');
    assert.equal(held(), 0);
    assert.equal(await openTransactions(), 0);

    // The snapshot's own connection killed between batches (a pooler or database restart).
    after('Incident', async () => {
      await plain.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`);
      await new Promise((r) => setTimeout(r, 200));
    });
    const killed = await outcome(read());
    assert.notEqual(killed, 'no error', 'a read whose connection died fails, it does not return part of a graph');
    assert.equal(held(), 0, 'the dead connection is not held');
    assert.equal(await openTransactions(), 0);
    assert.deepStrictEqual(typed(await read()), typed(expected), 'the pool recovers: the next read is complete');
    pass(`P3-11 failures part-way through: error surfaced and rolled back (outside and inside a transaction), connection killed mid-read fails cleanly ("${killed.slice(0, 50)}"), 0 connections held, 0 transactions open, next read complete`);
  }

  // ── P3-12 pages ordered by a related column ───────────────────────────────────────────────────────
  {
    const eventMeta = graph.getMetadata(AttendanceEvent);
    const byShiftStart = { shift: { start: 'DESC' as const } };
    assert.equal(graphPlan(eventMeta, { order: byShiftStart, take: 3 }, GRAPH_LOADING_MIN_JOINS), null);
    assert.equal(graphPlan(eventMeta, { order: byShiftStart, skip: 1 }, GRAPH_LOADING_MIN_JOINS), null);
    assert.equal(graphPlan(eventMeta, { order: byShiftStart }, GRAPH_LOADING_MIN_JOINS, true), null, 'findOne is a page of one');
    assert.notEqual(graphPlan(eventMeta, { order: byShiftStart }, GRAPH_LOADING_MIN_JOINS), null, 'unpaged, it is batched');
    const paged: Array<[string, (m: EntityManager) => Promise<unknown>]> = [
      ['take/skip ordered by a related column', (m) => m.find(AttendanceEvent, { where: { shift: { company: { id: A.company.id } } }, order: { shift: { start: 'DESC' }, id: 'ASC' }, take: 3, skip: 1 })],
      ['take ordered by a related column', (m) => m.find(Shift, { where: { company: { id: A.company.id } }, order: { site: { name: 'DESC' }, id: 'ASC' }, take: 4 })],
      ['findOne ordered by a related column', (m) => m.findOne(AttendanceEvent, { where: { guard: { id: A.guards[1].id } }, order: { shift: { start: 'DESC' }, id: 'DESC' } })],
      ['findOneOrFail ordered by a related column', (m) => m.findOneOrFail(Incident, { where: { company: { id: A.company.id } }, order: { site: { name: 'ASC' }, id: 'ASC' } })],
    ];
    for (const [name, read] of paged) {
      const r = await both(read);
      assert.ok(r.plain.value && (!Array.isArray(r.plain.value) || r.plain.value.length), `${name}: the fixture has rows`);
      assert.equal(r.graph.statements, r.plain.statements, `${name}: read exactly as TypeORM reads it`);
    }
    const batched: Array<[string, (m: EntityManager) => Promise<unknown>]> = [
      ['unpaged, ordered by a related column', (m) => m.find(Shift, { where: { company: { id: In([A.company.id, B.company.id]) } }, order: { site: { name: 'DESC' }, id: 'ASC' } })],
      ['paged, filtered on a related column, own order', (m) => m.find(AttendanceEvent, { where: { shift: { company: { id: A.company.id } } }, order: { occurredAt: 'DESC', id: 'ASC' }, take: 3, skip: 2 })],
      ['findOne filtered on a nested related column', (m) => m.findOne(Incident, { where: { shift: { site: { company: { id: A.company.id } } } }, order: { createdAt: 'DESC', id: 'DESC' } })],
    ];
    for (const [name, read] of batched) {
      const r = await both(read);
      assert.ok(r.graph.statements > 1 && r.graph.maxJoins <= 8, `${name}: batched (${r.graph.statements} statements, max ${r.graph.maxJoins} JOINs)`);
    }
    pass(`P3-12 ${paged.length} pages ordered by a related column (take/skip, findOne, findOneOrFail) identical to TypeORM and read as it reads them; ${batched.length} unpaged-order / related-filter reads identical and still batched`);
  }

  // ── P3-13 cross-company isolation under concurrency ───────────────────────────────────────────────
  {
    const expectedA = await plain.manager.find(Shift, { where: { company: { id: A.company.id } }, order: { id: 'ASC' } });
    const expectedB = await plain.manager.find(Shift, { where: { company: { id: B.company.id } }, order: { id: 'ASC' } });
    const out = await Promise.all(Array.from({ length: 200 }, (_, i) => {
      const t = i % 2 ? B : A;
      const read = i % 3 === 0
        ? graph.manager.find(Shift, { where: { company: { id: t.company.id } }, order: { id: 'ASC' } })
        : i % 3 === 1
          ? graph.manager.find(AttendanceEvent, { where: { shift: { company: { id: t.company.id } } }, order: { id: 'ASC' } })
          : graph.manager.findOne(Incident, { where: { company: { id: t.company.id }, title: 'Incident 3' } });
      return read.then((value) => ({ i, t, value }));
    }));
    for (const { i, t, value } of out) {
      assert.deepEqual([...companyIdsIn(value)], [t.company.id], `read ${i}: only its own company anywhere in the graph`);
      if (i % 3 === 0) assert.deepStrictEqual(typed(value), typed(t === A ? expectedA : expectedB), `read ${i}: identical to TypeORM`);
    }
    assert.equal(held(), 0);
    assert.equal(await openTransactions(), 0);
    pass('P3-13 200 concurrent interleaved reads for two companies: no row of the other company at any depth; every list identical to TypeORM; nothing held afterwards');
  }

  // ── P3-14 never a partial graph ───────────────────────────────────────────────────────────────────
  {
    // The batches assembled straight onto fully read rows, with a limit on how many waves they may take.
    const finders = { find: EntityManager.prototype.find, findOne: EntityManager.prototype.findOne } as any;
    const summary: string[] = [];
    for (const entity of [Shift, AttendanceEvent, Incident] as any[]) {
      const meta = graph.getMetadata(entity);
      const tree = graphPlan(meta, {}, GRAPH_LOADING_MIN_JOINS)!;
      const where = { company: { id: A.company.id } };
      const read = () => plain.manager.find(entity, { where: meta.name === 'AttendanceEvent' ? { shift: where } : where, order: { id: 'ASC' } });
      const expected = await read();
      let needed = -1;
      for (let waves = 0; waves <= 33 && needed < 0; waves += 1) {
        const rows = await read();
        const outcome = await new GraphAssembler(plain.manager, finders, waves).run(meta, rows, tree).then(() => null, (e: Error) => e.message);
        if (outcome === null) {
          needed = waves;
          assert.deepStrictEqual(typed(rows), typed(expected), `${meta.name}: within ${waves} waves the assembly is complete`);
        } else {
          assert.match(outcome, new RegExp(`^Entity graph read of ${meta.name} did not complete within ${waves} batches \\(unread: .+\\)$`));
        }
      }
      assert.ok(needed >= 1, `${meta.name} completes`);
      summary.push(`${meta.name} ${needed}`);
    }
    pass(`P3-14 a graph read that runs out of batches raises an error naming what is unread, at every limit short of complete (waves needed: ${summary.join(', ')}); it never returns relations as null or []`);
  }

  // ── P3-15 large reads ─────────────────────────────────────────────────────────────────────────────
  {
    const C = await tenant('p3c');
    const N = 66_000;
    await plain.query(
      `INSERT INTO shifts ("companyId", "siteId", "siteName", "guardId", start, "end", status)
       SELECT $1, $2, 'bulk', $3, $5::timestamptz - make_interval(mins => g), $5::timestamptz - make_interval(mins => g) + interval '8 hours', 'completed'
       FROM generate_series(1, $4) g`,
      [C.company.id, C.siteA.id, C.guards[1].id, N, at(0)],
    );
    await plain.query(`INSERT INTO attendance_events ("shiftId", "guardId", type, "occurredAt") SELECT id, "guardId", 'check-in', start FROM shifts WHERE "companyId" = $1 AND "siteName" = 'bulk'`, [C.company.id]);
    const truth: Array<{ id: number; shiftId: number; siteId: number; clientId: number | null; guardId: number }> = await plain.query(
      `SELECT a.id, a."shiftId", s."siteId", st."clientId", a."guardId" FROM attendance_events a JOIN shifts s ON s.id = a."shiftId" JOIN sites st ON st.id = s."siteId" WHERE s."companyId" = $1 ORDER BY a.id`, [C.company.id]);
    assert.ok(truth.length > N && new Set(truth.map((t) => t.shiftId)).size > 65_535, 'more distinct shifts than PostgreSQL allows bind parameters');

    const read = () => graph.manager.find(AttendanceEvent, { where: { shift: { company: { id: C.company.id } } }, order: { id: 'ASC' } });
    const started = Date.now();
    const big = await graphLog.measure(read);
    const ms = Date.now() - started;
    const rows = big.value as any[];
    assert.equal(rows.length, truth.length, 'every row, nothing truncated');
    rows.forEach((row, i) => {
      const t = truth[i];
      assert.ok(row.id === t.id && row.shift?.id === t.shiftId && row.shift.site?.id === t.siteId && row.guard?.id === t.guardId, `row ${i}: complete and correct`);
      assert.ok(row.shift.company?.user?.id === C.company.user.id && (row.shift.site.client?.id ?? null) === t.clientId, `row ${i}: complete at depth`);
      if (t.clientId !== null) assert.equal(row.shift.site.client.company?.user?.id, C.company.user.id, `row ${i}: complete at depth`);
    });
    assert.ok(big.maxParams <= IN_CHUNK, `at most ${IN_CHUNK} keys per statement (largest: ${big.maxParams})`);
    const shiftBatches = Math.ceil(new Set(truth.map((t) => t.shiftId)).size / IN_CHUNK);
    assert.ok(big.statements <= 14 + shiftBatches, `${big.statements} statements: bounded by entity types plus ceil(rows / ${IN_CHUNK})`);
    assert.equal(held(), 0);
    const again = (await read()) as any[];
    assert.deepEqual(again.map((r) => [r.id, r.shift.id, r.shift.site.id]), rows.map((r) => [r.id, r.shift.id, r.shift.site.id]), 'deterministic');
    const sample = truth.filter((_, i) => i % 220 === 0).map((t) => t.id);
    await both((m) => m.find(AttendanceEvent, { where: { id: In(sample) }, order: { id: 'ASC' } }));

    // One-to-many with more parents than one IN list holds: 6,000 shifts, each at its own Site of its own
    // Client, read with each Client's Sites.
    await plain.query(
      `WITH c AS (INSERT INTO clients ("companyId", name) SELECT $1, 'bulk client ' || g FROM generate_series(1, 6000) g RETURNING id, name),
            st AS (INSERT INTO sites ("companyId", "clientId", name, address, status, timezone) SELECT $1, id, name || ' site', 'a', 'active', 'Europe/London' FROM c RETURNING id, name)
       INSERT INTO shifts ("companyId", "siteId", "siteName", "guardId", start, "end", status)
       SELECT $1, id, 'bulk2', $2, $3::timestamptz, $3::timestamptz + interval '8 hours', 'completed' FROM st`,
      [C.company.id, C.guards[2].id, at(0)],
    );
    const withSites = { where: { company: { id: C.company.id }, siteName: 'bulk2' }, relations: { site: { client: { sites: true } } }, order: { id: 'ASC' as const } };
    assert.notEqual(graphPlan(graph.getMetadata(Shift), withSites, GRAPH_LOADING_MIN_JOINS), null, 'this read is batched');
    const sites = await both((m) => m.find(Shift, withSites), true);
    const shifts = sites.graph.value as any[];
    assert.equal(shifts.length, 6000);
    assert.ok(shifts.every((x) => x.site.client.sites.length === 1 && x.site.client.sites[0].id === x.site.id), 'every Client has its Site');
    assert.ok(sites.graph.maxParams <= IN_CHUNK, `one-to-many: at most ${IN_CHUNK} parents per statement (largest: ${sites.graph.maxParams})`);
    pass(`P3-15 large reads: ${rows.length.toLocaleString('en-GB')} attendance events over ${new Set(truth.map((t) => t.shiftId)).size.toLocaleString('en-GB')} distinct shifts in ${big.statements} statements, ${ms} ms, at most ${big.maxParams} keys per statement, every row complete; 6,000 one-to-many parents identical to TypeORM; deterministic`);
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
