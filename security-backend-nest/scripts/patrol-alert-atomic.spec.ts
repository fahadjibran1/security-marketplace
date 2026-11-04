/**
 * S3 Stage 1 — atomic patrol-alert acknowledgement and resolution (real PostgreSQL). Owner-approved 4 Nov 2026.
 *
 *   PAA-01  a patrol alert is resolved only after it has been acknowledged (409 PATROL_ALERT_NOT_ACKNOWLEDGED); nothing changes
 *   PAA-02  an invalid reason or a missing note is still refused with 400 before the acknowledgement rule
 *   PAA-03  the first acknowledger is kept: a second acknowledgement is refused (409, names who) and changes nothing
 *   PAA-04  five controllers acknowledge at once: exactly one wins; one alert audit, one exception audit
 *   PAA-05  five controllers resolve at once: exactly one wins; the winner's reason and note on alert and exception; one audit each
 *   PAA-06  the alert endpoint and the Patrols exception endpoint race each other: one resolution, never two
 *   PAA-07  a failure part-way through a resolution rolls everything back: alert, exception, annotations and audit unchanged
 *   PAA-08  a failure part-way through an acknowledgement rolls everything back
 *   PAA-09  late evidence arriving while a controller resolves: no deadlock (lock order exception → alert), both apply
 *   PAA-10  already resolved: 409 PATROL_ALERT_ALREADY_RESOLVED naming the resolver; the Patrols path keeps its code
 *   PAA-11  a reconciliation summary alert: acknowledge first, and resolving it resolves no patrol exception
 *   PAA-12  non-patrol alerts keep their lifecycle: close from open, re-acknowledge, legacy close, already-closed message
 *   PAA-13  a non-patrol alert closed by two controllers at once: one close, one audit entry
 *   PAA-14  tenancy unchanged: another company's alert is refused before anything is locked or written
 *
 * Needs PATROL_ALERT_ATOMIC_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource, Repository } from 'typeorm';
import { appEntities } from '../src/database/entities';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardProfile } from '../src/guard-profile/entities/guard-profile.entity';
import { Company } from '../src/company/entities/company.entity';
import { Site } from '../src/site/entities/site.entity';
import { Shift } from '../src/shift/entities/shift.entity';
import { AttendanceEvent } from '../src/attendance/entities/attendance.entity';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { SafetyAlert, SafetyAlertPriority, SafetyAlertStatus, SafetyAlertType } from '../src/safety-alert/entities/safety-alert.entity';

let passed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
}

/** The error a refused call throws: HTTP status, code and message. */
async function refusal(fn: () => Promise<unknown>, because: string): Promise<{ status: number; code: string | null; message: string; body: any }> {
  try {
    await fn();
  } catch (error: any) {
    const body = typeof error?.getResponse === 'function' ? error.getResponse() : null;
    return {
      status: typeof error?.getStatus === 'function' ? error.getStatus() : 500,
      code: body && typeof body === 'object' ? body.code ?? null : null,
      message: String(body && typeof body === 'object' ? body.message : error?.message),
      body,
    };
  }
  throw new Error(`expected refusal: ${because}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.PATROL_ALERT_ATOMIC_DATABASE_URL;
  if (!url) throw new Error('PATROL_ALERT_ATOMIC_DATABASE_URL is required (use a disposable database)');
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('patrol alert atomic database must be local');

  const ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: true, dropSchema: true, logging: false, extra: { max: 12 } });
  await ds.initialize();
  const repo = <T extends object>(entity: new () => T): Repository<T> => ds.getRepository(entity);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AuditLogService } = await import('../src/audit-log/audit-log.service');
  const { PatrolExceptionService } = await import('../src/patrol/patrol-exception.service');
  const { WelfareWindowService } = await import('../src/operations/welfare-window.service');
  const { OperationalWindowService } = await import('../src/operations/operational-window.service');
  const { DailyLog } = await import('../src/daily-log/entities/daily-log.entity');

  let seq = 0;
  const makeUser = (role: UserRole, firstName: string | null = null, lastName: string | null = null) =>
    repo(User).save(repo(User).create({ email: `paa.${(seq += 1)}@example.invalid`, passwordHash: 'x', role, status: UserStatus.ACTIVE, firstName, lastName } as Partial<User>));
  const makeCompany = async (name: string) => {
    const owner = await makeUser(UserRole.COMPANY_ADMIN, 'Olive', 'Owner');
    const company = await repo(Company).save(repo(Company).create({ user: owner, name, companyNumber: String(41000000 + seq), address: '1 Test Street', contactDetails: 'ops@paa.example.invalid' }));
    const site = await repo(Site).save(repo(Site).create({ company, name: `${name} Site`, address: '2 Test Street', timezone: 'Europe/London' }));
    return { owner, company, site };
  };
  const A = await makeCompany('Atomic Security Ltd');
  const B = await makeCompany('Other Security Ltd');
  const guardUser = await makeUser(UserRole.GUARD);
  const guard = await repo(GuardProfile).save(repo(GuardProfile).create({ user: guardUser, fullName: 'Test Guard', siaLicenseNumber: String(6300000000000000 + seq), phone: '07700000000' }));
  const controllers = await Promise.all(['Ava', 'Ben', 'Cara', 'Dev', 'Eli'].map((n) => makeUser(UserRole.COMPANY_ADMIN, n, 'Controller')));

  // Every caller acts as company A's owner account (the alertActor owner path); company B's alerts belong to someone else.
  const auditLogService = new AuditLogService(repo(AuditLog), {} as never);
  const windowEngine = new OperationalWindowService();
  const alertService = new SafetyAlertService(
    repo(SafetyAlert), repo(DailyLog), repo(AttendanceEvent), repo(Shift),
    {} as never, {} as never, { findByUserId: async () => A.company } as never, auditLogService,
    { createForUser: async () => undefined, createForUserUnlessRecentDuplicate: async () => undefined } as never,
    new WelfareWindowService(windowEngine), windowEngine, ds,
    { getGuardSummary: async () => { throw new Error('compliance lapse scan not exercised by this spec'); } } as never,
  );
  alertService.onModuleDestroy();
  const access = { companyActorAny: async (user: { sub: number }) => ({ companyId: A.company.id, userId: user.sub }) } as never;
  const exceptionService = new PatrolExceptionService(ds, access, auditLogService, alertService);
  const jwt = (userId: number) => ({ sub: userId }) as never;

  const shift = await repo(Shift).save(repo(Shift).create({
    company: A.company, guard, site: A.site, siteName: A.site.name, start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 3_600_000), status: 'in_progress',
  } as Partial<Shift>));

  let windowSeq = 0;
  /** A patrol exception and its linked alert, as the sweep raises them (both directions of the link set). */
  const makePatrolCase = async (opts: { company?: typeof A; type?: SafetyAlertType; exceptionType?: string } = {}) => {
    const co = opts.company ?? A;
    const type = opts.type ?? SafetyAlertType.PATROL_MISSED;
    const windowKey = `s1:site:20261104T${String(1000 + (windowSeq += 1)).padStart(4, '0')}Z:0`;
    const alert = await repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: co.company, guard, shift: co === A ? shift : null, type, priority: SafetyAlertPriority.HIGH, status: SafetyAlertStatus.OPEN, message: 'Patrol missed',
    }));
    const [exception] = await q(
      `INSERT INTO patrol_exceptions ("companyId", "siteId", "shiftId", "windowKey", "scopeKey", type, status, "safetyAlertId", "guardId", "windowStart", "windowEnd")
       VALUES ($1, $2, $3, $4, 'site', $5, 'open', $6, $7, now() - interval '1 hour', now() - interval '30 minutes') RETURNING *`,
      [co.company.id, co.site.id, co === A ? shift.id : null, windowKey, opts.exceptionType ?? 'patrol_missed', alert.id, guard.id],
    );
    await q(`UPDATE safety_alerts SET "patrolExceptionId" = $2, "patrolWindowKey" = $3 WHERE id = $1`, [alert.id, exception.id, windowKey]);
    return { alertId: alert.id, exceptionId: Number(exception.id), windowKey };
  };
  const alertRow = (id: number) => one(`SELECT status::text AS status, "acknowledgedByUserId" AS ack, "closedByUserId" AS closed, "resolutionReason" AS reason, "resolutionNote" AS note FROM safety_alerts WHERE id = $1`, [id]);
  const exceptionRow = (id: number) => one(`SELECT status, "acknowledgedByUserId" AS ack, "resolvedByUserId" AS resolved, resolution, annotations FROM patrol_exceptions WHERE id = $1`, [id]);
  const audits = (entityType: string, entityId: number, action: string) =>
    count(`SELECT count(*)::int n FROM audit_logs WHERE "entityType" = $1 AND "entityId" = $2 AND action = $3`, [entityType, entityId, action]);
  const auditTotal = () => count(`SELECT count(*)::int n FROM audit_logs`);
  const RESOLVE = { resolutionReason: 'guard_contacted', resolutionNote: 'Spoke to the Guard; gate was blocked.' };
  const [ava, ben, cara, dev, eli] = controllers.map((c) => c.id);

  await test('PAA-01-PATROL-ALERT-RESOLVED-ONLY-AFTER-ACKNOWLEDGEMENT', async () => {
    const c = await makePatrolCase();
    const before = await auditTotal();
    for (const attempt of [
      () => alertService.closeForCompany(ava, c.alertId, RESOLVE),
      () => alertService.closePatrolAlert(ava, A.company.id, c.alertId, RESOLVE),
      () => exceptionService.resolve(jwt(ava), c.exceptionId, RESOLVE as never),
    ]) {
      const r = await refusal(attempt, 'unacknowledged');
      assert.deepEqual([r.status, r.code], [409, 'PATROL_ALERT_NOT_ACKNOWLEDGED']);
      assert.equal(r.message, 'Acknowledge this patrol alert before resolving it.');
    }
    assert.deepEqual(await alertRow(c.alertId), { status: 'open', ack: null, closed: null, reason: null, note: null });
    assert.equal((await exceptionRow(c.exceptionId)).status, 'open');
    assert.equal(await auditTotal(), before, 'nothing audited');
    await alertService.acknowledgeForCompany(ava, c.alertId);
    await alertService.closeForCompany(ava, c.alertId, RESOLVE);
    assert.equal((await alertRow(c.alertId)).status, 'closed');
    assert.equal((await exceptionRow(c.exceptionId)).status, 'resolved');
  });

  await test('PAA-02-INVALID-RESOLUTION-STILL-400-BEFORE-THE-ACKNOWLEDGEMENT-RULE', async () => {
    const c = await makePatrolCase();
    assert.equal((await refusal(() => alertService.closeForCompany(ava, c.alertId, {}), 'no reason')).status, 400);
    assert.equal((await refusal(() => alertService.closeForCompany(ava, c.alertId, { resolutionReason: 'guard_contacted' }), 'no note')).status, 400);
    assert.equal((await refusal(() => alertService.closeForCompany(ava, c.alertId, { resolutionReason: 'not_a_reason', resolutionNote: 'x' }), 'bad reason')).status, 400);
    assert.equal((await alertRow(c.alertId)).status, 'open');
  });

  await test('PAA-03-THE-FIRST-ACKNOWLEDGER-IS-KEPT', async () => {
    const c = await makePatrolCase();
    await alertService.acknowledgeForCompany(ava, c.alertId);
    for (const attempt of [
      () => alertService.acknowledgeForCompany(ben, c.alertId),
      () => alertService.acknowledgeForCompany(ava, c.alertId),
      () => exceptionService.acknowledge(jwt(ben), c.exceptionId),
    ]) {
      const r = await refusal(attempt, 're-acknowledge');
      assert.deepEqual([r.status, r.code], [409, 'PATROL_ALERT_ALREADY_ACKNOWLEDGED']);
      assert.match(r.message, /already been acknowledged by Ava Controller/);
      assert.equal(r.body.details.acknowledgedByName, 'Ava Controller');
    }
    assert.equal(Number((await alertRow(c.alertId)).ack), ava);
    assert.equal(Number((await exceptionRow(c.exceptionId)).ack), ava);
    assert.equal(await audits('safety_alert', c.alertId, 'safety_alert.acknowledged'), 1);
    assert.equal(await audits('patrol_exception', c.exceptionId, 'patrol.exception_acknowledged'), 1);
    // Resolving by someone else keeps the acknowledger: "Acknowledged by" is not reassigned by the resolution.
    await alertService.closeForCompany(ben, c.alertId, RESOLVE);
    const after = await alertRow(c.alertId);
    assert.deepEqual([Number(after.ack), Number(after.closed)], [ava, ben]);
    const ex = await exceptionRow(c.exceptionId);
    assert.deepEqual([Number(ex.ack), Number(ex.resolved)], [ava, ben]);
  });

  await test('PAA-04-CONCURRENT-ACKNOWLEDGEMENTS-ONE-WINNER', async () => {
    for (let round = 0; round < 5; round += 1) {
      const c = await makePatrolCase();
      const results = await Promise.allSettled(controllers.map((u) => alertService.acknowledgeForCompany(u.id, c.alertId)));
      const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<SafetyAlert>[];
      assert.equal(won.length, 1, `round ${round}: exactly one acknowledgement`);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        assert.equal(r.reason.getResponse().code, 'PATROL_ALERT_ALREADY_ACKNOWLEDGED');
      }
      const winner = Number(won[0].value.acknowledgedByUserId);
      assert.equal(Number((await alertRow(c.alertId)).ack), winner);
      assert.equal(Number((await exceptionRow(c.exceptionId)).ack), winner, 'the exception names the same person');
      assert.equal(await audits('safety_alert', c.alertId, 'safety_alert.acknowledged'), 1);
      assert.equal(await audits('patrol_exception', c.exceptionId, 'patrol.exception_acknowledged'), 1);
    }
  });

  await test('PAA-05-CONCURRENT-RESOLUTIONS-ONE-WINNER-NOTHING-OVERWRITTEN', async () => {
    for (let round = 0; round < 5; round += 1) {
      const c = await makePatrolCase();
      await alertService.acknowledgeForCompany(ava, c.alertId);
      const results = await Promise.allSettled(controllers.map((u, i) =>
        alertService.closeForCompany(u.id, c.alertId, { resolutionReason: i % 2 ? 'guard_contacted' : 'patrol_completed_confirmed', resolutionNote: `Outcome recorded by controller ${u.id}` })));
      const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<SafetyAlert>[];
      assert.equal(won.length, 1, `round ${round}: exactly one resolution`);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        assert.equal(r.reason.getResponse().code, 'PATROL_ALERT_ALREADY_RESOLVED');
      }
      const winner = won[0].value;
      const alert = await alertRow(c.alertId);
      assert.deepEqual([Number(alert.closed), alert.reason, alert.note], [Number(winner.closedByUserId), winner.resolutionReason, `Outcome recorded by controller ${winner.closedByUserId}`]);
      const ex = await exceptionRow(c.exceptionId);
      assert.deepEqual([ex.status, Number(ex.resolved), ex.resolution], ['resolved', Number(winner.closedByUserId), winner.resolutionReason]);
      assert.equal(ex.annotations.filter((a: any) => a.kind === 'resolution_note').length, 1, 'one resolution note');
      assert.equal(await audits('safety_alert', c.alertId, 'safety_alert.closed'), 1);
      assert.equal(await audits('patrol_exception', c.exceptionId, 'patrol.exception_resolved'), 1);
    }
  });

  await test('PAA-06-ALERT-AND-EXCEPTION-ENDPOINTS-RACE-ONE-RESOLUTION', async () => {
    for (let round = 0; round < 4; round += 1) {
      const c = await makePatrolCase();
      await exceptionService.acknowledge(jwt(ava), c.exceptionId);
      const results = await Promise.allSettled([
        alertService.closeForCompany(ben, c.alertId, RESOLVE),
        exceptionService.resolve(jwt(cara), c.exceptionId, { resolutionReason: 'patrol_not_required', resolutionNote: 'Site closed.' } as never),
        alertService.closePatrolAlert(dev, A.company.id, c.alertId, RESOLVE),
        exceptionService.resolve(jwt(eli), c.exceptionId, { resolutionReason: 'patrol_not_required', resolutionNote: 'Site closed.' } as never),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}: one resolution`);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        assert.ok(['PATROL_ALERT_ALREADY_RESOLVED', 'PATROL_EXCEPTION_ALREADY_RESOLVED'].includes(r.reason.getResponse().code), 'a safe conflict');
      }
      const alert = await alertRow(c.alertId);
      const ex = await exceptionRow(c.exceptionId);
      assert.deepEqual([alert.status, ex.status, Number(ex.resolved), ex.resolution], ['closed', 'resolved', Number(alert.closed), alert.reason], 'alert and exception agree');
      assert.equal(await audits('safety_alert', c.alertId, 'safety_alert.closed'), 1);
      assert.equal(await audits('patrol_exception', c.exceptionId, 'patrol.exception_resolved'), 1);
    }
  });

  /** Makes the next audit write of `action` inside a transaction fail, as a crash part-way through would. */
  const failNextAudit = (action: string) => {
    const original = auditLogService.logInTransaction.bind(auditLogService);
    auditLogService.logInTransaction = (async (manager: any, input: any) => {
      if (input.action === action) {
        auditLogService.logInTransaction = original;
        throw new Error(`injected failure writing ${action}`);
      }
      return original(manager, input);
    }) as typeof auditLogService.logInTransaction;
  };

  await test('PAA-07-FAILURE-PART-WAY-THROUGH-A-RESOLUTION-ROLLS-BACK', async () => {
    for (const failing of ['patrol.exception_resolved', 'safety_alert.closed']) {
      const c = await makePatrolCase();
      await alertService.acknowledgeForCompany(ava, c.alertId);
      const alertBefore = await alertRow(c.alertId);
      const exBefore = await exceptionRow(c.exceptionId);
      const before = await auditTotal();
      failNextAudit(failing);
      const r = await refusal(() => alertService.closeForCompany(ben, c.alertId, RESOLVE), 'injected');
      assert.match(r.message, /injected failure/);
      assert.deepEqual(await alertRow(c.alertId), alertBefore, `${failing}: alert unchanged`);
      assert.deepEqual(await exceptionRow(c.exceptionId), exBefore, `${failing}: exception (and its annotations) unchanged`);
      assert.equal(await auditTotal(), before, `${failing}: no audit entry left behind`);
      await alertService.closeForCompany(ben, c.alertId, RESOLVE);
      assert.equal((await exceptionRow(c.exceptionId)).status, 'resolved', 'the retry succeeds');
    }
  });

  await test('PAA-08-FAILURE-PART-WAY-THROUGH-AN-ACKNOWLEDGEMENT-ROLLS-BACK', async () => {
    for (const failing of ['patrol.exception_acknowledged', 'safety_alert.acknowledged']) {
      const c = await makePatrolCase();
      const before = await auditTotal();
      failNextAudit(failing);
      await refusal(() => alertService.acknowledgeForCompany(ava, c.alertId), 'injected');
      assert.deepEqual(await alertRow(c.alertId), { status: 'open', ack: null, closed: null, reason: null, note: null }, `${failing}: alert still open`);
      assert.deepEqual([(await exceptionRow(c.exceptionId)).status, (await exceptionRow(c.exceptionId)).ack], ['open', null]);
      assert.equal(await auditTotal(), before);
      await alertService.acknowledgeForCompany(ava, c.alertId);
      assert.equal(Number((await alertRow(c.alertId)).ack), ava, 'the retry succeeds');
    }
  });

  await test('PAA-09-LATE-EVIDENCE-DURING-A-RESOLUTION-NO-DEADLOCK', async () => {
    const c = await makePatrolCase();
    await alertService.acknowledgeForCompany(ava, c.alertId);
    // The real late-evidence path inside a Guard sync's transaction, paused after it has updated (and so locked) the
    // exception and before it updates the alert — the moment a reversed lock order would deadlock.
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let closing: Promise<unknown> | null = null;
    const runner = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await qr.query(sql, params);
        if (/^\s*UPDATE "patrol_exceptions"/.test(sql) && !closing) {
          closing = alertService.closeForCompany(ben, c.alertId, RESOLVE).then(() => 'closed', (e) => e);
          await sleep(400);
        }
        return result;
      },
    };
    await exceptionService.recordLateEvidence(runner as never, {
      companyId: A.company.id, runId: 999, kind: 'run_completed_after_alert',
      match: { windowKey: c.windowKey, scopeKey: 'site', types: ['patrol_missed'] as never },
      deviceTime: new Date(), now: new Date(), userId: null,
    });
    await qr.commitTransaction();
    await qr.release();
    assert.equal(await closing, 'closed', 'the controller’s resolution completes after the sync, not deadlocked');
    const ex = await exceptionRow(c.exceptionId);
    assert.ok(ex.annotations.some((a: any) => a.kind === 'run_completed_after_alert'), 'the late evidence is recorded');
    assert.deepEqual([ex.status, (await alertRow(c.alertId)).status], ['resolved', 'closed']);
  });

  await test('PAA-10-ALREADY-RESOLVED-NAMES-THE-RESOLVER', async () => {
    const c = await makePatrolCase();
    await alertService.acknowledgeForCompany(ava, c.alertId);
    await alertService.closeForCompany(ben, c.alertId, RESOLVE);
    for (const attempt of [() => alertService.closeForCompany(cara, c.alertId, RESOLVE), () => alertService.acknowledgeForCompany(cara, c.alertId)]) {
      const r = await refusal(attempt, 'closed');
      assert.deepEqual([r.status, r.code], [409, 'PATROL_ALERT_ALREADY_RESOLVED']);
      assert.equal(r.message, 'This patrol alert has already been resolved by Ben Controller. Showing the latest decision.');
    }
    const viaPatrols = await refusal(() => exceptionService.resolve(jwt(cara), c.exceptionId, RESOLVE as never), 'resolved');
    assert.deepEqual([viaPatrols.status, viaPatrols.code], [409, 'PATROL_EXCEPTION_ALREADY_RESOLVED'], 'existing clients keep their code');
  });

  await test('PAA-11-RECONCILIATION-SUMMARY-RESOLVES-NO-EXCEPTION', async () => {
    const summary = await repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: A.company, guard, shift: null, type: SafetyAlertType.PATROL_MISSED, priority: SafetyAlertPriority.HIGH, status: SafetyAlertStatus.OPEN, message: '3 patrols missed during the outage',
    }));
    await q(`UPDATE safety_alerts SET "patrolWindowKey" = 'reconciliation:site:1' WHERE id = $1`, [summary.id]);
    const [underlying] = await q(`INSERT INTO patrol_exceptions ("companyId", "siteId", "windowKey", "scopeKey", type, status) VALUES ($1, $2, 's1:site:recon:0', 'site', 'patrol_missed', 'open') RETURNING id`, [A.company.id, A.site.id]);
    assert.equal((await refusal(() => alertService.closeForCompany(ava, summary.id, RESOLVE), 'unacknowledged')).code, 'PATROL_ALERT_NOT_ACKNOWLEDGED');
    await alertService.acknowledgeForCompany(ava, summary.id);
    await alertService.closeForCompany(ava, summary.id, RESOLVE);
    assert.equal((await alertRow(summary.id)).status, 'closed');
    assert.equal((await exceptionRow(Number(underlying.id))).status, 'open', 'its patrol windows stay open');
  });

  await test('PAA-12-NON-PATROL-ALERTS-KEEP-THEIR-LIFECYCLE', async () => {
    const make = (type: SafetyAlertType) => repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: A.company, guard, shift, type, priority: SafetyAlertPriority.MEDIUM, status: SafetyAlertStatus.OPEN, message: 'Original alert text',
    }));
    // Close straight from open, the acknowledgement backfilled (LIFE-03's rule).
    const panic = await make(SafetyAlertType.PANIC);
    const closed = await alertService.closeForCompany(ava, panic.id, { resolutionReason: 'false_activation', resolutionNote: 'Pocket press, Guard confirmed safe.' });
    assert.deepEqual([closed.status, Number(closed.acknowledgedByUserId), Number(closed.closedByUserId)], ['closed', ava, ava]);
    // Re-acknowledging still records the latest acknowledger for non-patrol types.
    const other = await make(SafetyAlertType.OTHER);
    await alertService.acknowledgeForCompany(ava, other.id);
    const again = await alertService.acknowledgeForCompany(ben, other.id);
    assert.deepEqual([again.status, Number(again.acknowledgedByUserId)], ['acknowledged', ben]);
    // The legacy no-payload close, and the already-closed message.
    await alertService.closeForCompany(ben, other.id);
    const r = await refusal(() => alertService.closeForCompany(cara, other.id), 'closed');
    assert.deepEqual([r.status, r.code, r.message], [409, null, 'This alert is already closed.']);
  });

  await test('PAA-13-NON-PATROL-ALERT-CLOSED-CONCURRENTLY-ONE-CLOSE', async () => {
    const other = await repo(SafetyAlert).save(repo(SafetyAlert).create({
      company: A.company, guard, shift, type: SafetyAlertType.OTHER, priority: SafetyAlertPriority.MEDIUM, status: SafetyAlertStatus.OPEN, message: 'x',
    }));
    const results = await Promise.allSettled(controllers.map((u) => alertService.closeForCompany(u.id, other.id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await audits('safety_alert', other.id, 'safety_alert.closed'), 1);
  });

  await test('PAA-14-TENANCY-UNCHANGED', async () => {
    const foreign = await makePatrolCase({ company: B });
    const before = await auditTotal();
    assert.equal((await refusal(() => alertService.acknowledgeForCompany(ava, foreign.alertId), 'other company')).status, 400);
    assert.equal((await refusal(() => alertService.closeForCompany(ava, foreign.alertId, RESOLVE), 'other company')).status, 400);
    assert.equal((await refusal(() => alertService.acknowledgePatrolAlert(ava, A.company.id, foreign.alertId), 'other company')).status, 404);
    assert.equal((await refusal(() => alertService.closePatrolAlert(ava, A.company.id, foreign.alertId, RESOLVE), 'other company')).status, 404);
    assert.equal((await refusal(() => alertService.acknowledgeForCompany(ava, 987654), 'missing')).status, 404);
    assert.equal((await alertRow(foreign.alertId)).status, 'open');
    assert.equal(await auditTotal(), before);
  });

  await ds.destroy();
  console.log(`\n${passed}/14 patrol alert atomic checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
