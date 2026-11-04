/**
 * S3 Stage 4 — operational acceptance of Control Room patrol operations (owner-approved 4 Nov 2026). The whole application
 * over HTTP on a disposable database built from the repository's migrations; the REAL patrol sweep raises the alerts at
 * chosen instants (its timers stopped). Synthetic data only.
 *
 *   S3OA-01  the complete workflow: the sweep raises → a controller acknowledges → investigates → records the outcome and
 *            resolves; the queue, Missed Today and the audit history at every step
 *   S3OA-02  three controllers act on the same case at once (HTTP): exactly one acknowledgement and one resolution, the
 *            audit history consistent
 *   S3OA-03  missed, incomplete (checkpoint), late, flagged, pending and resolved patrols: only actionable findings are cases
 *   S3OA-04  a reconciliation summary: acknowledged and resolved, its patrol windows stay open, no exception audit
 *   S3OA-05  alert/exception mismatches in both directions: no normal action makes a record worse
 *   S3OA-06  permissions for Owner, Admin, Operations, Control Room, Viewer (and Finance without patrols.view), photos too
 *   S3OA-07  cross-company isolation on every read and action
 *   S3OA-08  overnight windows and site-local dates, the UK spring and autumn clock changes
 *   S3OA-09  the reads never return a photo, a link or a storage key, and never touch the evidence store
 *
 * Needs S3_ACCEPTANCE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.S3_ACCEPTANCE_DATABASE_URL;
if (!url) throw new Error('S3_ACCEPTANCE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('S3 acceptance database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 's3-acceptance-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;

type Res = { status: number; body: any };
const PASSWORD = 'Spec-Password-123!';
let passed = 0;
let failed = 0;
async function test(id: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${id}`);
    console.log(error);
  }
}

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  const migrate = new DataSource({ ...base, entities: [], migrations: allFiles.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
  await migrate.initialize();
  const migrated = await migrate.runMigrations({ transaction: 'each' });
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolMonitorIndexes1720900000022', 'no new migration: the head is still Migration 75');
  await migrate.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const [{ current_database: db }] = await ds.query('SELECT current_database()');
  if (db !== new URL(url!).pathname.slice(1)) throw new Error(`Refusing: connected to ${db}`);
  const { PatrolSweepService } = await import('../src/patrol/patrol-sweep.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AuthService } = await import('../src/auth/auth.service');
  const { PatrolOperationsService } = await import('../src/patrol/patrol-operations.service');
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const sweep = app.get(PatrolSweepService);
  const operations = app.get(PatrolOperationsService);
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures (synthetic) ──
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string, first: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, first])).id);
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `s3oa.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin', `Owner${label}`);
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `S3OA ${label} Ltd`, String(79000000 + seq)]);
    return { id: Number(id), ownerId, ownerEmail, user: { sub: ownerId, email: ownerEmail, role: 'company_admin', status: 'active' } as any };
  };
  const mkMember = async (companyId: number, label: string, role: string, first: string) => {
    const email = `s3oa.${label}.${role}.${(seq += 1)}@example.invalid`;
    const id = await mkUser(email, 'company_admin', first);
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return { id, email };
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone,"clientName") VALUES ($1,$2,'3 Quay',$3,'Harbour Estates') RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `s3oa.g.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard', label);
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `79${String(seq).padStart(14, '0')}`, `0779${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email };
  };
  const DAY = '2026-03-10';
  const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00Z`);
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status: string, bookOn?: Date) => {
    const id = Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
    if (bookOn) await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified") VALUES ($1,$2,'check-in',$3,$3,false)`, [id, guardId, bookOn]);
    return id;
  };
  const mkCheckpoint = (companyId: number, siteId: number, label: string) =>
    one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,$3,$4) RETURNING *`, [companyId, siteId, require('node:crypto').randomBytes(16).toString('hex'), label]);
  const mkRoute = async (companyId: number, siteId: number, cps: any[]) => {
    const route = await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Perimeter') RETURNING id`, [companyId, siteId]);
    for (const [i, cp] of cps.entries()) await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [companyId, siteId, route.id, cp.id, i + 1]);
    return Number(route.id);
  };
  const mkSchedule = async (companyId: number, siteId: number, routeId: number, from: string, to: string) =>
    Number((await one(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"createdAt","updatedAt")
       VALUES ($1,$2,$3,'Hourly patrol','[1,2,3,4,5,6,7]'::jsonb,$4,$5,60,60,true,'2026-01-01','2026-01-01') RETURNING id`, [companyId, siteId, routeId, from, to])).id);
  const insRun = (r: { companyId: number; siteId: number; shiftId: number; guard: { id: number; userId: number }; scheduleId: number; routeId: number; slot: number;
    startedAt: Date; completedAt?: Date | null; status?: string; lateStart?: boolean }) => {
    const ws = at(`${String(8 + r.slot).padStart(2, '0')}:00`);
    return one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
         status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId","lateStart")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'site',$11,$12,$12,$13,$13,$14,$15) RETURNING *`,
      [r.companyId, r.siteId, r.shiftId, r.guard.id, r.guard.userId, r.scheduleId, r.routeId, `s${r.scheduleId}:${DAY}:${r.slot}`, ws, new Date(ws.getTime() + 3_600_000),
        r.status ?? 'completed', r.startedAt, r.completedAt ?? null, `s3oa-run-${(seq += 1)}`, r.lateStart === true]);
  };
  const insVisit = (companyId: number, runId: number, cp: any, result: string, scannedAt: Date, flags: string[] = []) =>
    q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [companyId, runId, cp.id, cp.publicId, result, JSON.stringify(flags), scannedAt, `s3oa-visit-${(seq += 1)}`]);
  const audits = (where: string, params: unknown[]) => q(`SELECT action, "userId" FROM audit_logs WHERE ${where} ORDER BY id`, params);

  // Company A: one site, site-wide hourly patrols 08:00–16:00, QR on two checkpoints; a Guard on duty all day.
  const A = await mkCompany('alpha');
  const members = {
    admin: await mkMember(A.id, 'alpha', 'admin', 'Adam'),
    operations: await mkMember(A.id, 'alpha', 'operations', 'Opal'),
    control: await mkMember(A.id, 'alpha', 'control_room', 'Cara'),
    viewer: await mkMember(A.id, 'alpha', 'viewer', 'Vera'),
    finance: await mkMember(A.id, 'alpha', 'finance', 'Fay'),
  };
  const ava = await mkGuard('Ava');
  const quay = await mkSite(A.id, 'Quay');
  const cp1 = await mkCheckpoint(A.id, quay, 'Gate 1');
  const cp2 = await mkCheckpoint(A.id, quay, 'Gate 2');
  const route = await mkRoute(A.id, quay, [cp1, cp2]);
  const sched = await mkSchedule(A.id, quay, route, '08:00', '16:00');
  const shift = await mkShift(A.id, quay, ava.id, at('08:00'), at('16:00'), 'in_progress', at('07:55'));
  const run = (slot: number, o: Partial<Parameters<typeof insRun>[0]>) => insRun({ companyId: A.id, siteId: quay, shiftId: shift, guard: ava, scheduleId: sched, routeId: route, slot, startedAt: at('08:00'), ...o });
  // 08:00 verified on time; 09:00 late start; 10:00 nobody (missed); 11:00 Gate 2 never scanned; 12:00 a repeat scan
  // (flagged); 13:00 nobody (missed); 14:00 nobody (missed).
  const r08 = await run(0, { startedAt: at('08:05'), completedAt: at('08:20') });
  await insVisit(A.id, r08.id, cp1, 'verified', at('08:06')); await insVisit(A.id, r08.id, cp2, 'verified', at('08:10'));
  const r09 = await run(1, { startedAt: at('09:25'), completedAt: at('09:40'), lateStart: true });
  await insVisit(A.id, r09.id, cp1, 'verified', at('09:26')); await insVisit(A.id, r09.id, cp2, 'verified', at('09:30'));
  const r11 = await run(3, { startedAt: at('11:05'), completedAt: at('11:20') });
  await insVisit(A.id, r11.id, cp1, 'verified', at('11:06'));
  const r12 = await run(4, { startedAt: at('12:05'), completedAt: at('12:20') });
  await insVisit(A.id, r12.id, cp1, 'verified', at('12:06')); await insVisit(A.id, r12.id, cp1, 'flagged', at('12:08'), ['duplicate_in_run']); await insVisit(A.id, r12.id, cp2, 'verified', at('12:10'));
  await sweep.sweep(at('15:40'));
  // Pending: completed after the sweep ran, not yet judged.
  const r15 = await run(7, { startedAt: at('15:05'), completedAt: at('15:45') });
  await insVisit(A.id, r15.id, cp1, 'verified', at('15:06'));

  const tok = {
    owner: await login(A.ownerEmail), admin: await login(members.admin.email), operations: await login(members.operations.email),
    control: await login(members.control.email), viewer: await login(members.viewer.email), finance: await login(members.finance.email),
  };
  const exceptions = await q(`SELECT id, type, status, "runId", "windowKey", "safetyAlertId" FROM patrol_exceptions WHERE "companyId" = $1 ORDER BY id`, [A.id]);
  const byWindow = (slot: number, type: string) => exceptions.find((e: any) => e.windowKey === `s${sched}:${DAY}:${slot}` && e.type === type);
  const missed10 = byWindow(2, 'patrol_missed');
  const missed13 = byWindow(5, 'patrol_missed');
  const missed14 = byWindow(6, 'patrol_missed');
  const checkpoint11 = exceptions.find((e: any) => Number(e.runId) === Number(r11.id));
  console.log('      sweep raised:', exceptions.map((e: any) => `${e.type}@${e.windowKey.split(':').pop()}${e.safetyAlertId ? '+alert' : ''}`).join(', '));

  await test('S3OA-03-ONLY-ACTIONABLE-FINDINGS-ARE-CASES', async () => {
    assert.ok(missed10?.safetyAlertId && missed13?.safetyAlertId && missed14?.safetyAlertId, 'missed windows: an exception and an alert each');
    assert.ok(checkpoint11?.safetyAlertId, 'the patrol that missed Gate 2: an actionable finding with an alert');
    for (const r of [r08, r09, r12, r15]) {
      assert.equal(exceptions.some((e: any) => Number(e.runId) === Number(r.id)), false, `run ${r.id} (verified / late / flagged repeat / pending) raises no case`);
    }
    const flagged = await one(`SELECT "verificationStatus", "needsReview" FROM patrol_runs WHERE id = $1`, [r12.id]);
    console.log(`      flagged repeat scan: verification ${flagged.verificationStatus}, needsReview ${flagged.needsReview}; late start: no exception; pending: ${(await one(`SELECT "verificationStatus" FROM patrol_runs WHERE id = $1`, [r15.id])).verificationStatus}`);
    const att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    const actionable = exceptions.filter((e: any) => e.safetyAlertId);
    assert.deepEqual(att.cases.map((c: any) => c.exceptionId).sort((a: number, b: number) => a - b), actionable.map((e: any) => Number(e.id)).sort((a: number, b: number) => a - b),
      'every actionable finding is exactly one case; nothing else');
    assert.equal(att.counts.patrolAlerts, actionable.length);
    const day = await operations.attention(A.user, at('15:50'));
    assert.deepEqual([day.counts.missedToday, day.counts.missedTodayOpen], [3, 3], 'three missed windows on the site\'s day');
    const inv = expect(await api('GET', `/patrols/exceptions/${checkpoint11.id}/investigation`, tok.control), 200);
    assert.deepEqual(inv.run.missingCheckpoints.map((c: any) => c.label), ['Gate 2']);
    assert.ok(inv.run.verificationExplanation?.text, 'the verification outcome in words');
  });

  await test('S3OA-01-THE-COMPLETE-WORKFLOW-AND-ITS-AUDIT-HISTORY', async () => {
    const alertId = Number(missed10.safetyAlertId);
    const exceptionId = Number(missed10.id);
    // Raised by the sweep (system), as one case.
    let att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    assert.deepEqual(att.cases.find((c: any) => c.exceptionId === exceptionId)?.status, 'open');
    // Resolve before acknowledging: refused, nothing changes.
    expect(await api('POST', `/patrols/exceptions/${exceptionId}/resolve`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 409, 'PATROL_ALERT_NOT_ACKNOWLEDGED');
    // Acknowledge (Live Operations' alert action).
    expect(await api('PATCH', `/alerts/${alertId}/ack`, tok.control), 200);
    att = expect(await api('GET', '/patrols/operations/attention', tok.viewer), 200);
    const acked = att.cases.find((c: any) => c.exceptionId === exceptionId);
    assert.deepEqual([acked.status, acked.exceptionStatus, acked.acknowledgedByName], ['acknowledged', 'acknowledged', 'Cara Spec'], 'kept in the queue, Acknowledged by');
    // Investigate.
    const inv = expect(await api('GET', `/patrols/exceptions/${exceptionId}/investigation`, tok.control), 200);
    assert.deepEqual([inv.run, inv.site.name, inv.shift.id, inv.alert.acknowledgedByName], [null, 'Quay', shift, 'Cara Spec']);
    // Record the outcome and resolve (the panel's exception action).
    expect(await api('POST', `/patrols/exceptions/${exceptionId}/resolve`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'Guard was escorting a delivery; site walked at 10:40.' }), 200);
    const alert = await one(`SELECT status::text, "acknowledgedByUserId" ack, "closedByUserId" closed, "resolutionReason" reason, "resolutionNote" note FROM safety_alerts WHERE id = $1`, [alertId]);
    const exc = await one(`SELECT status, "acknowledgedByUserId" ack, "resolvedByUserId" resolved, resolution, annotations FROM patrol_exceptions WHERE id = $1`, [exceptionId]);
    assert.deepEqual([alert.status, Number(alert.ack), Number(alert.closed), alert.reason], ['closed', members.control.id, members.control.id, 'guard_contacted']);
    assert.deepEqual([exc.status, Number(exc.ack), Number(exc.resolved), exc.resolution], ['resolved', members.control.id, members.control.id, 'guard_contacted']);
    assert.equal(exc.annotations.filter((a: any) => a.kind === 'resolution_note').length, 1);
    att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    assert.equal(att.cases.some((c: any) => c.exceptionId === exceptionId), false, 'resolved: out of the queue');
    const day = await operations.attention(A.user, at('15:55'));
    assert.deepEqual([day.counts.missedToday, day.counts.missedTodayOpen, day.counts.missedTodayResolved], [3, 2, 1], 'Missed Today keeps it as history');
    assert.equal(day.resolvedMissedToday.items[0].resolvedByName, 'Cara Spec');
    // The audit history, in order: raised by the system; acknowledged and resolved once each, by the controller.
    const trail = await audits(`("entityType" = 'safety_alert' AND "entityId" = $1) OR ("entityType" = 'patrol_exception' AND "entityId" = $2)`, [alertId, exceptionId]);
    assert.deepEqual(trail.map((t: any) => t.action), [
      'patrol.exception_raised', 'patrol.alert_raised', 'patrol.exception_acknowledged', 'safety_alert.acknowledged', 'patrol.exception_resolved', 'safety_alert.closed',
    ]);
    assert.deepEqual(trail.slice(2).map((t: any) => Number(t.userId)), [members.control.id, members.control.id, members.control.id, members.control.id]);
  });

  await test('S3OA-02-THREE-CONTROLLERS-ON-ONE-CASE', async () => {
    for (const target of [missed13, checkpoint11]) {
      const alertId = Number(target.safetyAlertId);
      const exceptionId = Number(target.id);
      const acks = await Promise.all([
        api('PATCH', `/alerts/${alertId}/ack`, tok.control),
        api('POST', `/patrols/exceptions/${exceptionId}/acknowledge`, tok.operations),
        api('PATCH', `/alerts/${alertId}/ack`, tok.admin),
      ]);
      const winners = acks.filter((r) => r.status === 200);
      assert.equal(winners.length, 1, 'exactly one acknowledgement');
      for (const r of acks.filter((x) => x.status === 409)) assert.equal(r.body.code, 'PATROL_ALERT_ALREADY_ACKNOWLEDGED');
      const resolves = await Promise.all([
        api('PATCH', `/alerts/${alertId}/close`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'Control: spoke to the Guard.' }),
        api('POST', `/patrols/exceptions/${exceptionId}/resolve`, tok.operations, { resolutionReason: 'site_inaccessible', resolutionNote: 'Ops: gate blocked.' }),
        api('PATCH', `/alerts/${alertId}/close`, tok.admin, { resolutionReason: 'patrol_not_required', resolutionNote: 'Admin: client cancelled.' }),
      ]);
      const ok = resolves.filter((r) => r.status === 200);
      assert.equal(ok.length, 1, 'exactly one resolution');
      for (const r of resolves.filter((x) => x.status === 409)) assert.ok(['PATROL_ALERT_ALREADY_RESOLVED', 'PATROL_EXCEPTION_ALREADY_RESOLVED'].includes(r.body.code), `a safe conflict: ${r.body.code}`);
      const alert = await one(`SELECT "closedByUserId" closed, "resolutionReason" reason, "resolutionNote" note, "acknowledgedByUserId" ack FROM safety_alerts WHERE id = $1`, [alertId]);
      const exc = await one(`SELECT "resolvedByUserId" resolved, resolution, "acknowledgedByUserId" ack, annotations FROM patrol_exceptions WHERE id = $1`, [exceptionId]);
      assert.deepEqual([Number(exc.resolved), exc.resolution, Number(exc.ack)], [Number(alert.closed), alert.reason, Number(alert.ack)], 'alert and exception name the same people and outcome');
      assert.equal(exc.annotations.filter((a: any) => a.kind === 'resolution_note').length, 1);
      const trail = await audits(`("entityType" = 'safety_alert' AND "entityId" = $1) OR ("entityType" = 'patrol_exception' AND "entityId" = $2)`, [alertId, exceptionId]);
      const count = (a: string) => trail.filter((t: any) => t.action === a).length;
      assert.deepEqual(['safety_alert.acknowledged', 'patrol.exception_acknowledged', 'safety_alert.closed', 'patrol.exception_resolved'].map(count), [1, 1, 1, 1], 'one audit entry per transition');
      console.log(`      case ${exceptionId}: acknowledged by user ${alert.ack}, resolved by user ${alert.closed} (${alert.reason}); losers got ${acks.concat(resolves).filter((r) => r.status === 409).map((r) => r.body.code).join(', ')}`);
    }
  });

  await test('S3OA-04-RECONCILIATION-SUMMARY-NEVER-CLOSES-ITS-WINDOWS', async () => {
    const recon = Number((await one(`INSERT INTO patrol_reconciliation_runs ("companyId","fromAt","throughAt","targetAt","horizonDays",status,"completedAt") VALUES ($1,$2,$3,$3,7,'completed',now()) RETURNING id`,
      [A.id, at('16:00'), at('18:00')])).id);
    const windows: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      windows.push(Number((await one(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","windowKey","scopeKey",type,status,"windowStart","windowEnd","reconciliationRunId")
        VALUES ($1,$2,$3,$4,'site','patrol_missed','open',$5,$6,$7) RETURNING id`, [A.id, quay, sched, `s${sched}:recon:${i}`, at(`${16 + i}:00`), at(`${16 + i}:30`), recon])).id));
    }
    const summary = Number((await one(`INSERT INTO safety_alerts ("companyId",type,priority,message,status,"patrolReconciliationRunId","patrolWindowKey")
      VALUES ($1,'patrol_missed','high','3 patrol windows were missed at Quay during an outage','open',$2,$3) RETURNING id`, [A.id, recon, `reconciliation:site:${quay}`])).id);
    let att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    const c = att.cases.find((x: any) => x.alertId === summary);
    assert.deepEqual([c.kind, c.affectedWindows], ['reconciliation_summary', { total: 3, open: 3 }]);
    expect(await api('PATCH', `/alerts/${summary}/close`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 409, 'PATROL_ALERT_NOT_ACKNOWLEDGED');
    expect(await api('PATCH', `/alerts/${summary}/ack`, tok.control), 200);
    expect(await api('PATCH', `/alerts/${summary}/close`, tok.control, { resolutionReason: 'patrol_not_required', resolutionNote: 'Outage reviewed with the client.' }), 200);
    for (const id of windows) assert.equal((await one(`SELECT status FROM patrol_exceptions WHERE id = $1`, [id])).status, 'open', 'its windows stay open');
    assert.equal((await audits(`"entityType" = 'patrol_exception' AND "entityId" = ANY($1::int[])`, [windows])).length, 0, 'no exception was touched');
    att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    assert.equal(att.cases.some((x: any) => x.alertId === summary), false);
  });

  await test('S3OA-05-MISMATCHED-RECORDS-ARE-NEVER-MADE-WORSE', async () => {
    const mk = async (alertStatus: string, exceptionStatus: string) => {
      const e = await one(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","windowKey","scopeKey",type,status,"windowStart","windowEnd","resolvedAt","resolution")
        VALUES ($1,$2,$3,$4,'site','patrol_missed',$5,$6,$7,$8,$9) RETURNING id`,
        [A.id, quay, sched, `s${sched}:mm:${(seq += 1)}`, exceptionStatus, at('19:00'), at('19:30'), exceptionStatus === 'resolved' ? new Date() : null, exceptionStatus === 'resolved' ? 'guard_contacted' : null]);
      const a = await one(`INSERT INTO safety_alerts ("companyId",type,priority,message,status,"patrolExceptionId","closedAt","acknowledgedAt")
        VALUES ($1,'patrol_missed','high','Patrol missed',$2,$3,$4,$5) RETURNING id`,
        [A.id, alertStatus, e.id, alertStatus === 'closed' ? new Date() : null, alertStatus !== 'open' ? new Date() : null]);
      await q(`UPDATE patrol_exceptions SET "safetyAlertId" = $2 WHERE id = $1`, [e.id, a.id]);
      return { exceptionId: Number(e.id), alertId: Number(a.id) };
    };
    const state = async (m: any) => [
      (await one(`SELECT status::text s FROM safety_alerts WHERE id = $1`, [m.alertId])).s,
      (await one(`SELECT status s FROM patrol_exceptions WHERE id = $1`, [m.exceptionId])).s,
    ];
    const findings: string[] = [];
    // Alert closed, exception open (the queue shows "Data inconsistency").
    const a1 = await mk('closed', 'open');
    let att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    assert.equal(att.cases.find((c: any) => c.exceptionId === a1.exceptionId)?.stateMismatch, true);
    expect(await api('PATCH', `/alerts/${a1.alertId}/ack`, tok.control), 409, 'PATROL_ALERT_ALREADY_RESOLVED', 'alert endpoint refuses');
    expect(await api('PATCH', `/alerts/${a1.alertId}/close`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 409, 'PATROL_ALERT_ALREADY_RESOLVED');
    assert.deepEqual(await state(a1), ['closed', 'open'], 'unchanged by refused actions');
    expect(await api('POST', `/patrols/exceptions/${a1.exceptionId}/acknowledge`, tok.control), 200);
    assert.deepEqual(await state(a1), ['closed', 'acknowledged'], 'acknowledging the record is the controller\'s step towards settling it');
    expect(await api('POST', `/patrols/exceptions/${a1.exceptionId}/resolve`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'Settled after review.' }), 200);
    assert.deepEqual(await state(a1), ['closed', 'resolved'], 'resolving through Patrol Management makes the two agree');
    findings.push('alert closed / exception open: alert actions refused (409, nothing written); exception actions settle it (agree afterwards)');
    // Alert acknowledged, exception resolved (not in the queue: the exception is settled).
    const a2 = await mk('acknowledged', 'resolved');
    att = expect(await api('GET', '/patrols/operations/attention', tok.control), 200);
    assert.equal(att.cases.some((c: any) => c.alertId === a2.alertId), false, 'not listed (see the report: visible only in /alerts/company and Patrol Management)');
    expect(await api('POST', `/patrols/exceptions/${a2.exceptionId}/resolve`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 409, 'PATROL_EXCEPTION_ALREADY_RESOLVED');
    expect(await api('PATCH', `/alerts/${a2.alertId}/ack`, tok.control), 409, 'PATROL_ALERT_ALREADY_ACKNOWLEDGED', 'the first acknowledger is kept');
    const before = (await audits(`"entityType" = 'patrol_exception' AND "entityId" = $1`, [a2.exceptionId])).length;
    expect(await api('PATCH', `/alerts/${a2.alertId}/close`, tok.control, { resolutionReason: 'guard_contacted', resolutionNote: 'Closing the stray alert.' }), 200);
    assert.deepEqual(await state(a2), ['closed', 'resolved'], 'closing the alert makes the two agree');
    assert.equal((await audits(`"entityType" = 'patrol_exception' AND "entityId" = $1`, [a2.exceptionId])).length, before, 'the settled exception is not rewritten');
    findings.push('alert open / exception resolved: exception actions refused; closing the alert settles it without rewriting the exception');
    for (const f of findings) console.log(`      ${f}`);
  });

  await test('S3OA-06-PERMISSIONS-BY-ROLE-AND-PHOTOS', async () => {
    const target = Number(missed14.id);
    const run11 = Number(r11.id);
    const ev = Number((await one(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","clientEvidenceId","mimeType","sizeBytes","uploadStatus","storageKey")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'s3oa-ev-1','image/jpeg',1234,'verified','company/secret-object.jpg') RETURNING id`, [A.id, quay, run11, ava.id, shift, 'c'.repeat(64), at('11:07')])).id);
    const matrix: Record<string, { view: boolean; evidence: boolean; act: boolean }> = {
      owner: { view: true, evidence: true, act: true }, admin: { view: true, evidence: true, act: true }, operations: { view: true, evidence: true, act: true },
      control: { view: true, evidence: true, act: true }, viewer: { view: true, evidence: false, act: false }, finance: { view: false, evidence: false, act: false },
    };
    for (const [role, may] of Object.entries(matrix)) {
      const t = (tok as any)[role];
      const att = await api('GET', '/patrols/operations/attention', t);
      assert.equal(att.status, may.view ? 200 : 403, `${role}: attention`);
      const inv = await api('GET', `/patrols/exceptions/${Number(checkpoint11.id)}/investigation`, t);
      assert.equal(inv.status, may.view ? 200 : 403, `${role}: investigation`);
      if (may.view) assert.equal(inv.body.evidence.items === null, !may.evidence, `${role}: photo metadata ${may.evidence ? 'shown' : 'withheld'}`);
      for (const p of [`/patrols/evidence/${ev}/download?purpose=review`, `/patrols/evidence/${ev}/stamped`, `/patrols/runs/${run11}/evidence/thumbnails`, `/patrols/runs/${run11}/evidence`]) {
        const r = await api('GET', p, t);
        if (may.evidence) assert.notEqual(r.status, 403, `${role}: ${p} is allowed (storage may be unavailable in this test: ${r.status})`);
        else assert.equal(r.status, 403, `${role}: ${p} refused`);
      }
      const ack = await api('POST', `/patrols/exceptions/${target}/acknowledge`, t);
      if (!may.act) assert.equal(ack.status, 403, `${role}: cannot acknowledge`);
      else if (ack.status !== 200) assert.equal(ack.body.code, 'PATROL_ALERT_ALREADY_ACKNOWLEDGED', `${role}: may act (already acknowledged by an earlier role)`);
    }
    assert.equal((await one(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'patrol.evidence%' AND "userId" = ANY($1::int[])`, [[members.viewer.id, members.finance.id]])).n, 0, 'no evidence access recorded for Viewer or Finance');
  });

  await test('S3OA-07-CROSS-COMPANY-ISOLATION', async () => {
    const B = await mkCompany('bravo');
    const bTok = await login(B.ownerEmail);
    const att = expect(await api('GET', '/patrols/operations/attention', bTok), 200);
    assert.deepEqual([att.cases.length, att.counts.patrolAlerts, att.counts.missedToday], [0, 0, 0]);
    const ex = Number(missed14.id);
    const al = Number(missed14.safetyAlertId);
    expect(await api('GET', `/patrols/exceptions/${ex}/investigation`, bTok), 404, 'PATROL_NOT_FOUND');
    expect(await api('POST', `/patrols/exceptions/${ex}/acknowledge`, bTok), 404, 'PATROL_NOT_FOUND');
    expect(await api('POST', `/patrols/exceptions/${ex}/resolve`, bTok, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 404, 'PATROL_NOT_FOUND');
    expect(await api('PATCH', `/alerts/${al}/ack`, bTok), 400, undefined, 'another company\'s alert');
    expect(await api('PATCH', `/alerts/${al}/close`, bTok, { resolutionReason: 'guard_contacted', resolutionNote: 'x' }), 400);
    assert.equal(((await api('GET', '/alerts/company', bTok)).body as any[]).some((a) => a.id === al), false);
  });

  await test('S3OA-08-OVERNIGHT-AND-UK-CLOCK-CHANGES', async () => {
    const D = await mkCompany('dst');
    const site = await mkSite(D.id, 'Clock Yard');
    const g = await mkGuard('Dee');
    // An actionable missed window, as the sweep raises it: the exception and its one linked alert.
    const mkMissed = async (start: string) => {
      const e = await one(`INSERT INTO patrol_exceptions ("companyId","siteId","windowKey","scopeKey",type,status,"windowStart","windowEnd","guardId")
        VALUES ($1,$2,$3,'site','patrol_missed','open',$4,$4::timestamptz + interval '30 minutes',$5) RETURNING id`, [D.id, site, `w:${start}`, start, g.id]);
      const a = await one(`INSERT INTO safety_alerts ("companyId","guardId",type,priority,message,status,"patrolExceptionId") VALUES ($1,$2,'patrol_missed','high','Patrol missed','open',$3) RETURNING id`, [D.id, g.id, e.id]);
      await q(`UPDATE patrol_exceptions SET "safetyAlertId" = $2 WHERE id = $1`, [e.id, a.id]);
    };
    // Spring forward, Sunday 29 March 2026 (01:00 GMT → 02:00 BST): a 23-hour site day, 00:00 GMT to 23:00 UTC.
    const spring = ['2026-03-28T23:50:00Z' /* 23:50 the day before — overnight, belongs to the 28th */, '2026-03-29T00:30:00Z' /* 00:30 GMT */,
      '2026-03-29T01:10:00Z' /* 02:10 BST, just after the gap */, '2026-03-29T22:59:00Z' /* 23:59 BST */, '2026-03-29T23:00:00Z' /* 00:00 BST on the 30th */];
    for (const s of spring) await mkMissed(s);
    let r = await operations.attention(D.user, new Date('2026-03-29T12:00:00Z'));
    assert.equal(r.counts.missedToday, 3, 'spring: 00:30 GMT, 02:10 BST and 23:59 BST are the 29th; 23:50 on the 28th and 00:00 on the 30th are not');
    const date = (iso: string) => r.cases.find((c: any) => c.windowStart === new Date(iso).toISOString())?.siteDate;
    assert.deepEqual(spring.map(date), ['2026-03-28', '2026-03-29', '2026-03-29', '2026-03-29', '2026-03-30']);
    // Fall back, Sunday 25 October 2026 (02:00 BST → 01:00 GMT): a 25-hour site day, 23:00 UTC on the 24th to 00:00 UTC on the 26th.
    const autumn = ['2026-10-24T22:59:00Z' /* 23:59 BST on the 24th */, '2026-10-24T23:00:00Z' /* 00:00 BST on the 25th */, '2026-10-25T00:30:00Z' /* 01:30 BST (first) */,
      '2026-10-25T01:30:00Z' /* 01:30 GMT (repeated hour) */, '2026-10-25T23:59:00Z' /* 23:59 GMT */, '2026-10-26T00:00:00Z' /* the 26th */];
    for (const s of autumn) await mkMissed(s);
    r = await operations.attention(D.user, new Date('2026-10-25T12:00:00Z'));
    assert.equal(r.counts.missedToday, 4, 'autumn: both 01:30s count, and the day runs 25 hours');
    assert.deepEqual(autumn.map(date), ['2026-10-24', '2026-10-25', '2026-10-25', '2026-10-25', '2026-10-25', '2026-10-26']);
  });

  await test('S3OA-09-READS-NEVER-RETURN-OR-FETCH-A-PHOTO', async () => {
    const accessesBefore = (await one(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'patrol.evidence%'`)).n;
    for (const t of [tok.owner, tok.control, tok.viewer]) {
      const bodies = [
        expect(await api('GET', '/patrols/operations/attention', t), 200),
        expect(await api('GET', `/patrols/exceptions/${Number(checkpoint11.id)}/investigation`, t), 200),
      ];
      for (const b of bodies) assert.doesNotMatch(JSON.stringify(b), /storageKey|secret-object|https?:\/\/|signedUrl|uploadUrl|dataUri|base64/i);
    }
    assert.equal((await one(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'patrol.evidence%'`)).n, accessesBefore, 'no photo, preview or link was issued by a read');
  });

  await app.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log(JSON.stringify({ event: 's3_operational_acceptance_certified', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
