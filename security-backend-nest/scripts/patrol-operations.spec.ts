/**
 * S3 Stage 2 (owner-approved 4 Nov 2026): the read-only Control Room patrol reads, over HTTP, on a disposable database
 * built from the repository's own migrations (no new migration).
 *
 *   POPS-01  an exception and its linked alert are ONE case; counts agree with the list; no case or alert listed twice
 *   POPS-02  several cases for one window (missed + checkpoint) are separate cases, and each investigation names the other
 *   POPS-03  resolved missed patrols leave the queue but stay in Missed Today (resolved list: who, when, why); yesterday's never
 *   POPS-04  a reconciliation summary is one case with its affected windows; resolving it leaves its windows open; horizon alert
 *   POPS-05  site-local dates: London / New York / Kolkata days at one instant, overnight windows count on the day they start
 *   POPS-06  permissions and isolation: no patrols.view 403, Patrols off 404, a Guard 403, another company's case 404 / unseen
 *   POPS-07  evidence restriction: without patrols.evidence, counts only (no photo metadata); never a file, link or storage key
 *   POPS-08  the investigation: client, site, Guard, shift, window, patrol status and explanation, QR progress and missing
 *            checkpoints, photo counts, delayed evidence, a nearby ad-hoc patrol
 *   POPS-09  the queue is capped at 200, newest first, with `more` and the full count
 *   POPS-10  reads write nothing (rows, audit trail and row versions unchanged)
 *   POPS-11  controllers acknowledging and resolving concurrently with reads: every read is internally consistent, the last
 *            read equals the database
 *   POPS-12  a pre-Stage-1 record whose alert is closed but exception open is listed as a state mismatch, not hidden
 *
 * Needs PATROL_OPERATIONS_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_OPERATIONS_DATABASE_URL;
if (!url) throw new Error('PATROL_OPERATIONS_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol operations database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-operations-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;

type Res = { status: number; body: any };
const PASSWORD = 'Spec-Password-123!';
const MIN = 60_000;

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
  const { localDateOf, wallMinutesToInstant } = await import('../src/patrol/patrol-window.service');
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const alerts = app.get(SafetyAlertService);
  const operations = app.get(PatrolOperationsService);
  const auth = app.get(AuthService);

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string | null): Promise<Res> => {
    const res = await fetch(baseUrl + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
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

  // ── Fixtures ──
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string, first: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, first])).id);
  const mkCompany = async (label: string, patrolsEnabled = true) => {
    seq += 1;
    const ownerEmail = `pops.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin', `Owner${label}`);
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',$4) RETURNING id`,
      [ownerId, `POPS ${label} Ltd`, String(78000000 + seq), patrolsEnabled]);
    return { id: Number(id), ownerId, ownerEmail, user: { sub: ownerId, email: ownerEmail, role: 'company_admin', status: 'active' } as any };
  };
  const mkMember = async (companyId: number, label: string, role: string, first: string) => {
    const email = `pops.${label}.${role}.${(seq += 1)}@example.invalid`;
    const id = await mkUser(email, 'company_admin', first);
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return { id, email, user: { sub: id, email, role: 'company_admin', status: 'active' } as any };
  };
  const mkClient = async (companyId: number, name: string) =>
    Number((await one(`INSERT INTO clients ("companyId",name) VALUES ($1,$2) RETURNING id`, [companyId, name])).id);
  const mkSite = async (companyId: number, name: string, tz: string, clientId: number | null = null) =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone,"clientId") VALUES ($1,$2,'3 Quay',$3,$4) RETURNING id`, [companyId, name, tz, clientId])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pops.g.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard', label);
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `78${String(seq).padStart(14, '0')}`, `0778${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status = 'completed') =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
  let windowSeq = 0;
  /** A patrol exception as the sweep raises it, with (actionable) or without its one linked alert. */
  const mkCase = async (o: { companyId: number; siteId: number; shiftId?: number | null; guardId?: number | null; start: Date; minutes?: number;
    type?: string; alertType?: string; alert?: boolean; windowKey?: string; scopeKey?: string; runId?: number | null; reconciliationRunId?: number | null; createdAt?: Date }) => {
    const windowKey = o.windowKey ?? `s1:${o.siteId}:${(windowSeq += 1)}`;
    const scopeKey = o.scopeKey ?? (o.shiftId ? `sh${o.shiftId}` : 'site');
    const end = new Date(o.start.getTime() + (o.minutes ?? 30) * MIN);
    const e = await one(`INSERT INTO patrol_exceptions ("companyId","siteId","shiftId","guardId","runId","windowKey","scopeKey",type,status,"windowStart","windowEnd","reconciliationRunId","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12) RETURNING *`,
      [o.companyId, o.siteId, o.shiftId ?? null, o.guardId ?? null, o.runId ?? null, windowKey, scopeKey, o.type ?? 'patrol_missed', o.start, end, o.reconciliationRunId ?? null, o.createdAt ?? new Date()]);
    let alertId: number | null = null;
    if (o.alert !== false) {
      const a = await one(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"patrolExceptionId","patrolWindowKey","createdAt")
         VALUES ($1,$2,$3,$4,'high','Patrol missed','open',$5,$6,$7) RETURNING id`,
        [o.companyId, o.guardId ?? null, o.shiftId ?? null, o.alertType ?? (o.type === 'checkpoint_missed' ? 'checkpoint_missed' : 'patrol_missed'), e.id, windowKey, o.createdAt ?? new Date()]);
      alertId = Number(a.id);
      await q(`UPDATE patrol_exceptions SET "safetyAlertId" = $2 WHERE id = $1`, [e.id, alertId]);
    }
    return { exceptionId: Number(e.id), alertId, windowKey, scopeKey };
  };
  const ackAndResolve = async (actor: any, alertId: number, reason = 'guard_contacted') => {
    await alerts.acknowledgeForCompany(actor.sub, alertId);
    await alerts.closeForCompany(actor.sub, alertId, { resolutionReason: reason, resolutionNote: 'Spoke to the Guard.' });
  };
  const dayStart = (tz: string, at = new Date()) => new Date(wallMinutesToInstant(localDateOf(at, tz), 0, tz));

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const C = await mkCompany('charlie', false);
  const aViewer = await mkMember(A.id, 'alpha', 'viewer', 'Vera');
  const aControl = await mkMember(A.id, 'alpha', 'control_room', 'Cara');
  const aControl2 = await mkMember(A.id, 'alpha', 'control_room', 'Cole');
  const aFinance = await mkMember(A.id, 'alpha', 'finance', 'Fay');
  const harbour = await mkClient(A.id, 'Harbour Estates');
  const quay = await mkSite(A.id, 'Quay', 'Europe/London', harbour);
  const ava = await mkGuard('Ava');
  const LONDON = dayStart('Europe/London');
  const shift = await mkShift(A.id, quay, ava.id, new Date(LONDON.getTime() + 60 * MIN), new Date(LONDON.getTime() + 600 * MIN));
  const tok = {
    owner: await login(A.ownerEmail), viewer: await login(aViewer.email), control: await login(aControl.email), finance: await login(aFinance.email),
    bOwner: await login(B.ownerEmail), cOwner: await login(C.ownerEmail), guard: await login(ava.email),
  };
  const attention = async (t = tok.control) => expect(await api('GET', '/patrols/operations/attention', t), 200);

  // Quay today: two missed windows (one also has a checkpoint case), one missed resolved, one from yesterday (resolved).
  const w1 = await mkCase({ companyId: A.id, siteId: quay, shiftId: shift, guardId: ava.id, start: new Date(LONDON.getTime() + 70 * MIN), createdAt: new Date(Date.now() - 50 * MIN) });
  const w1cp = await mkCase({ companyId: A.id, siteId: quay, shiftId: shift, guardId: ava.id, start: new Date(LONDON.getTime() + 70 * MIN), type: 'checkpoint_missed', windowKey: w1.windowKey, scopeKey: w1.scopeKey, createdAt: new Date(Date.now() - 40 * MIN) });
  const w2 = await mkCase({ companyId: A.id, siteId: quay, shiftId: shift, guardId: ava.id, start: new Date(LONDON.getTime() + 130 * MIN), createdAt: new Date(Date.now() - 30 * MIN) });
  const w3 = await mkCase({ companyId: A.id, siteId: quay, shiftId: shift, guardId: ava.id, start: new Date(LONDON.getTime() + 190 * MIN), createdAt: new Date(Date.now() - 20 * MIN) });
  const yesterday = await mkCase({ companyId: A.id, siteId: quay, guardId: ava.id, start: new Date(LONDON.getTime() - 300 * MIN), createdAt: new Date(Date.now() - 26 * 60 * MIN) });
  await ackAndResolve(A.user, w3.alertId!);
  await ackAndResolve(A.user, yesterday.alertId!);

  await test('POPS-01-ONE-CASE-PER-EXCEPTION-AND-ALERT-COUNTS-AGREE', async () => {
    const r = await attention();
    const keys = r.cases.map((c: any) => c.caseKey);
    assert.equal(new Set(keys).size, keys.length, 'no case twice');
    assert.equal(new Set(r.cases.map((c: any) => c.alertId)).size, r.cases.length, 'no alert twice');
    assert.deepEqual(keys.sort(), [`exception:${w1.exceptionId}`, `exception:${w1cp.exceptionId}`, `exception:${w2.exceptionId}`].sort());
    assert.deepEqual([r.counts.patrolAlerts, r.counts.openPatrolAlerts, r.counts.acknowledged, r.counts.stateMismatches], [3, 3, 0, 0]);
    assert.equal(r.more, false);
    const c = r.cases.find((x: any) => x.exceptionId === w1.exceptionId);
    assert.deepEqual([c.kind, c.status, c.exceptionStatus, c.type, c.site.name, c.site.clientName, c.guardName, c.shiftId, c.siteDate],
      ['exception', 'open', 'open', 'patrol_missed', 'Quay', 'Harbour Estates', 'Guard Ava', shift, localDateOf(new Date(), 'Europe/London')]);
    // Acknowledged: the case stays, with who acknowledged it.
    await alerts.acknowledgeForCompany(aControl.id, w2.alertId!);
    const after = await attention();
    const acked = after.cases.find((x: any) => x.exceptionId === w2.exceptionId);
    assert.deepEqual([acked.status, acked.exceptionStatus, acked.acknowledgedByName, after.counts.acknowledged], ['acknowledged', 'acknowledged', 'Cara Spec', 1]);
  });

  await test('POPS-02-SEVERAL-CASES-FOR-ONE-WINDOW', async () => {
    const r = await attention();
    const same = r.cases.filter((c: any) => c.windowKey === w1.windowKey);
    assert.deepEqual(same.map((c: any) => c.type).sort(), ['checkpoint_missed', 'patrol_missed']);
    const inv = expect(await api('GET', `/patrols/exceptions/${w1.exceptionId}/investigation`, tok.control), 200);
    assert.deepEqual(inv.otherCasesForWindow.map((x: any) => [x.exceptionId, x.type, x.alertStatus]), [[w1cp.exceptionId, 'checkpoint_missed', 'open']]);
    assert.equal(r.counts.missedToday, 3, 'a window with two cases is still one missed window');
  });

  await test('POPS-03-RESOLVED-MISSED-STAYS-IN-MISSED-TODAY', async () => {
    const r = await attention();
    assert.deepEqual([r.counts.missedToday, r.counts.missedTodayOpen, r.counts.missedTodayResolved], [3, 2, 1]);
    assert.equal(r.cases.some((c: any) => c.exceptionId === w3.exceptionId), false, 'resolved: not in the queue');
    assert.deepEqual(r.resolvedMissedToday.items.map((x: any) => [x.exceptionId, x.resolution, x.resolvedByName, x.acknowledgedByName]),
      [[w3.exceptionId, 'guard_contacted', 'Owneralpha Spec', 'Owneralpha Spec']]);
    assert.equal(r.resolvedMissedToday.items.some((x: any) => x.exceptionId === yesterday.exceptionId), false, 'yesterday is not today');
    assert.equal(r.resolvedMissedToday.more, false);
  });

  // An outage: reconciliation found three missed windows at Quay (no alert each), one summary alert for the site, one horizon.
  const recon = Number((await one(`INSERT INTO patrol_reconciliation_runs ("companyId","fromAt","throughAt","targetAt","horizonDays",status,"completedAt") VALUES ($1,$2,$3,$3,7,'completed',now()) RETURNING id`,
    [A.id, new Date(LONDON.getTime() + 200 * MIN), new Date(LONDON.getTime() + 290 * MIN)])).id);
  const reconWindows: Array<{ exceptionId: number }> = [];
  for (let i = 0; i < 3; i += 1) {
    reconWindows.push(await mkCase({ companyId: A.id, siteId: quay, start: new Date(LONDON.getTime() + (200 + 30 * i) * MIN), alert: false, reconciliationRunId: recon }));
  }
  const summary = Number((await one(`INSERT INTO safety_alerts ("companyId",type,priority,message,status,"patrolReconciliationRunId","patrolWindowKey","createdAt")
     VALUES ($1,'patrol_missed','high','3 patrol windows were missed at Quay during an outage','open',$2,$3,now()) RETURNING id`, [A.id, recon, `reconciliation:site:${quay}`])).id);
  const horizon = Number((await one(`INSERT INTO safety_alerts ("companyId",type,priority,message,status,"patrolReconciliationRunId","patrolWindowKey","createdAt")
     VALUES ($1,'patrol_missed','high','Patrol checks were NOT run for part of the outage','open',$2,'reconciliation:horizon',now()) RETURNING id`, [A.id, recon])).id);

  await test('POPS-04-RECONCILIATION-SUMMARY-IS-ONE-CASE', async () => {
    const r = await attention();
    const s = r.cases.find((c: any) => c.caseKey === `alert:${summary}`);
    assert.deepEqual([s.kind, s.exceptionId, s.site?.id, s.affectedWindows], ['reconciliation_summary', null, quay, { total: 3, open: 3 }]);
    const h = r.cases.find((c: any) => c.caseKey === `alert:${horizon}`);
    assert.deepEqual([h.kind, h.site, h.affectedWindows], ['reconciliation_summary', null, null]);
    for (const w of reconWindows) assert.equal(r.cases.some((c: any) => c.exceptionId === w.exceptionId), false, 'its windows are not separate cases');
    assert.equal(r.counts.patrolAlerts, 5, '3 exception cases + summary + horizon');
    assert.equal(r.counts.missedToday, 6, 'the outage windows are missed windows of the day');
    await ackAndResolve(aControl.user, summary);
    const after = await attention();
    assert.equal(after.cases.some((c: any) => c.caseKey === `alert:${summary}`), false, 'the summary is resolved');
    assert.equal(after.counts.missedTodayOpen, r.counts.missedTodayOpen, 'its windows stay open');
    for (const w of reconWindows) assert.equal((await one(`SELECT status FROM patrol_exceptions WHERE id = $1`, [w.exceptionId])).status, 'open');
    await ackAndResolve(aControl.user, horizon);
  });

  await test('POPS-05-SITE-LOCAL-DATES-AND-OVERNIGHT', async () => {
    const D = await mkCompany('delta');
    const ldn = await mkSite(D.id, 'London Yard', 'Europe/London');
    const ny = await mkSite(D.id, 'New York Pier', 'America/New_York');
    const kol = await mkSite(D.id, 'Kolkata Depot', 'Asia/Kolkata');
    const g = await mkGuard('Dee');
    // 03:00 UTC on 4 Nov 2026: London 03:00 on the 4th (GMT), New York 22:00 on the 3rd (EST), Kolkata 08:30 on the 4th.
    const now = new Date('2026-11-04T03:00:00Z');
    const cases = [
      ['ldn-today', ldn, '2026-11-04T01:00:00Z', true],
      ['ldn-overnight-from-yesterday', ldn, '2026-11-03T23:50:00Z', false], // starts 23:50 on the 3rd: yesterday's window
      ['ny-today-evening', ny, '2026-11-04T02:30:00Z', true], // 21:30 on the 3rd in New York: today there
      ['ny-tomorrow-utc-already', ny, '2026-11-03T03:30:00Z', false], // 22:30 on the 2nd in New York
      ['kol-today', kol, '2026-11-03T19:00:00Z', true], // 00:30 on the 4th in Kolkata
      ['kol-yesterday', kol, '2026-11-03T18:00:00Z', false], // 23:30 on the 3rd in Kolkata
    ] as const;
    for (const [, siteId, start] of cases) await mkCase({ companyId: D.id, siteId, guardId: g.id, start: new Date(start) });
    const r = await operations.attention(D.user, now);
    assert.equal(r.counts.missedToday, cases.filter((c) => c[3]).length, 'each site\'s own day');
    const dates = new Map(r.cases.map((c: any) => [c.windowStart, c.siteDate]));
    assert.equal(dates.get('2026-11-04T02:30:00.000Z'), '2026-11-03', 'New York date');
    assert.equal(dates.get('2026-11-03T19:00:00.000Z'), '2026-11-04', 'Kolkata date');
    assert.equal(dates.get('2026-11-03T23:50:00.000Z'), '2026-11-03', 'an overnight window belongs to the day it starts');
    assert.equal(r.counts.patrolAlerts, cases.length, 'the queue is every unresolved case, whatever its day');
  });

  await test('POPS-06-PERMISSIONS-AND-ISOLATION', async () => {
    expect(await api('GET', '/patrols/operations/attention', tok.finance), 403, 'PATROL_FORBIDDEN', 'no patrols.view');
    expect(await api('GET', `/patrols/exceptions/${w1.exceptionId}/investigation`, tok.finance), 403, 'PATROL_FORBIDDEN');
    expect(await api('GET', '/patrols/operations/attention', tok.cOwner), 404, 'PATROLS_NOT_ENABLED', 'Patrols off');
    expect(await api('GET', '/patrols/operations/attention', tok.guard), 403, undefined, 'a Guard account');
    expect(await api('GET', '/patrols/operations/attention', null), 401);
    const b = expect(await api('GET', '/patrols/operations/attention', tok.bOwner), 200);
    assert.deepEqual([b.cases, b.counts.patrolAlerts, b.counts.missedToday, b.resolvedMissedToday.items], [[], 0, 0, []], 'another company sees nothing of A');
    expect(await api('GET', `/patrols/exceptions/${w1.exceptionId}/investigation`, tok.bOwner), 404, 'PATROL_NOT_FOUND', 'another company\'s case');
    expect(await api('GET', '/patrols/exceptions/999999/investigation', tok.owner), 404, 'PATROL_NOT_FOUND');
    expect(await api('GET', '/patrols/exceptions/abc/investigation', tok.owner), 400);
    const v = expect(await api('GET', '/patrols/operations/attention', tok.viewer), 200, undefined, 'a Viewer reads the queue');
    assert.equal(v.counts.patrolAlerts > 0, true);
  });

  // A covering run for w2 (completed late, QR route with one checkpoint missed, photos), plus an ad-hoc patrol nearby.
  const cpGate = await one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,$3,'Gate 1') RETURNING *`, [A.id, quay, 'a'.repeat(32)]);
  const cpRoof = await one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,$3,'Roof') RETURNING *`, [A.id, quay, 'b'.repeat(32)]);
  const route = Number((await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Perimeter') RETURNING id`, [A.id, quay])).id);
  for (const [i, cp] of [cpGate, cpRoof].entries()) await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [A.id, quay, route, cp.id, i + 1]);
  await q(`INSERT INTO patrol_policies ("companyId","siteId","methods") VALUES ($1,$2,'["qr","photo"]'::jsonb)`, [A.id, quay]);
  const w2Start = new Date(LONDON.getTime() + 130 * MIN);
  const mkRun = async (o: { windowKey: string | null; scopeKey: string; startedAt: Date; status?: string }) => one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","routeId","windowKey","windowStart","windowEnd","scopeKey",
       status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId","syncedLate")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$13,$14,$15) RETURNING *`,
    [A.id, quay, shift, ava.id, ava.userId, route, o.windowKey, o.windowKey ? w2Start : null, o.windowKey ? new Date(w2Start.getTime() + 30 * MIN) : null, o.scopeKey,
      o.status ?? 'completed', o.startedAt, new Date(o.startedAt.getTime() + 10 * MIN), `pops-run-${(seq += 1)}`, o.windowKey != null]);
  const covering = await mkRun({ windowKey: w2.windowKey, scopeKey: w2.scopeKey, startedAt: new Date(w2Start.getTime() + 25 * MIN) });
  await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","clientVisitId") VALUES ($1,$2,$3,$4,'verified','[]'::jsonb,$5,'pops-visit-1')`,
    [A.id, covering.id, cpGate.id, cpGate.publicId, new Date(w2Start.getTime() + 27 * MIN)]);
  const adhoc = await mkRun({ windowKey: null, scopeKey: 'site', startedAt: new Date(w2Start.getTime() + 45 * MIN) });
  for (const [i, status] of ['verified', 'verified', 'pending'].entries()) {
    await q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","receivedAt","clientEvidenceId","mimeType","sizeBytes","uploadStatus","storageKey")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'image/jpeg',1234,$10,$11)`,
      [A.id, quay, covering.id, ava.id, shift, String(i).repeat(64), new Date(w2Start.getTime() + 26 * MIN), new Date(w2Start.getTime() + (i === 2 ? 50 : 28) * MIN),
        `pops-evidence-${i}`, status, `company-${A.id}/patrol/secret-object-${i}.jpg`]);
  }
  await q(`UPDATE patrol_exceptions SET "lateEvidenceAt" = $2, annotations = annotations || '[{"kind":"run_completed_after_alert","text":"evidence received after alert"}]'::jsonb WHERE id = $1`,
    [w2.exceptionId, new Date(w2Start.getTime() + 35 * MIN)]);
  const FORBIDDEN_IN_RESPONSES = /storageKey|secret-object|https?:\/\/|uploadUrl|signedUrl|quarantineKey/i;

  await test('POPS-07-EVIDENCE-RESTRICTED-TO-PATROLS-EVIDENCE', async () => {
    const viewer = expect(await api('GET', `/patrols/exceptions/${w2.exceptionId}/investigation`, tok.viewer), 200);
    assert.deepEqual([viewer.evidence.restricted, viewer.evidence.items], [true, null], 'no photo metadata without patrols.evidence');
    assert.deepEqual(viewer.evidence.counts, { total: 3, verified: 2, pending: 1, rejected: 0 }, 'counts, as the Monitor shows them');
    assert.doesNotMatch(JSON.stringify(viewer), /sha256|clientEvidenceId/i, 'no hashes or photo ids for a Viewer');
    const control = expect(await api('GET', `/patrols/exceptions/${w2.exceptionId}/investigation`, tok.control), 200);
    assert.equal(control.evidence.restricted, false);
    assert.equal(control.evidence.items.length, 3);
    for (const body of [viewer, control, await attention(tok.viewer), await attention(tok.control)]) {
      assert.doesNotMatch(JSON.stringify(body), FORBIDDEN_IN_RESPONSES, 'never a file, link or storage key');
    }
  });

  await test('POPS-08-INVESTIGATION-CONTENT', async () => {
    const inv = expect(await api('GET', `/patrols/exceptions/${w2.exceptionId}/investigation`, tok.control), 200);
    assert.deepEqual([inv.site.name, inv.site.clientName, inv.guard.name, inv.shift.id, inv.shift.guardName], ['Quay', 'Harbour Estates', 'Guard Ava', shift, 'Guard Ava']);
    assert.deepEqual([inv.scheduledWindow.windowKey, inv.scheduledWindow.start], [w2.windowKey, w2Start.toISOString()]);
    assert.deepEqual([inv.exception.type, inv.exception.status, inv.alert.status, inv.alert.acknowledgedByName], ['patrol_missed', 'acknowledged', 'acknowledged', 'Cara Spec']);
    assert.equal(inv.run.id, Number(covering.id), 'the patrol that covered the window');
    assert.deepEqual([inv.run.status, inv.run.syncedLate, inv.run.unscheduled], ['completed', true, false]);
    assert.ok(inv.run.verificationExplanation, 'the verification explanation');
    assert.deepEqual([inv.run.checkpoints.required, inv.run.checkpoints.verified], [2, 1], 'QR progress');
    assert.deepEqual(inv.run.missingCheckpoints, [{ id: Number(cpRoof.id), label: 'Roof' }], 'the missing checkpoint by name');
    assert.equal(inv.run.photos.taken, 3);
    assert.deepEqual([Boolean(inv.delayedEvidence.exceptionLateEvidenceAt), inv.delayedEvidence.runSyncedLate, inv.delayedEvidence.receivedAfterWindow], [true, true, 1]);
    assert.deepEqual(inv.relatedPatrols.map((r: any) => [r.id, r.unscheduled]), [[Number(adhoc.id), true]], 'the ad-hoc patrol near the window');
    assert.ok(inv.exception.annotations.some((a: any) => a.kind === 'run_completed_after_alert'));
    // A missed window with no patrol at all.
    const bare = expect(await api('GET', `/patrols/exceptions/${w1.exceptionId}/investigation`, tok.control), 200);
    assert.deepEqual([bare.run, bare.evidence.counts, bare.delayedEvidence.receivedAfterWindow], [null, null, null]);
  });

  await test('POPS-09-QUEUE-CAPPED-AT-200-NEWEST-FIRST', async () => {
    const E = await mkCompany('echo');
    const site = await mkSite(E.id, 'Busy Site', 'Europe/London');
    const g = await mkGuard('Eli');
    const t0 = Date.now() - 300 * MIN;
    for (let i = 0; i < 205; i += 1) await mkCase({ companyId: E.id, siteId: site, guardId: g.id, start: new Date(dayStart('Europe/London').getTime() + i * MIN), createdAt: new Date(t0 + i * MIN) });
    const r = await operations.attention(E.user);
    assert.deepEqual([r.cases.length, r.counts.patrolAlerts, r.more, r.limit], [200, 205, true, 200]);
    const raised = r.cases.map((c: any) => c.raisedAt);
    assert.deepEqual(raised, [...raised].sort().reverse(), 'newest first');
  });

  await test('POPS-10-READS-WRITE-NOTHING', async () => {
    const snapshot = async () => one(`SELECT
      (SELECT count(*) FROM audit_logs)::int AS audits,
      (SELECT md5(string_agg(id || ':' || status || ':' || coalesce("acknowledgedByUserId", 0) || ':' || coalesce("closedByUserId", 0) || ':' || xmin::text, ',' ORDER BY id)) FROM safety_alerts) AS alerts,
      (SELECT md5(string_agg(id || ':' || status || ':' || annotations::text || ':' || xmin::text, ',' ORDER BY id)) FROM patrol_exceptions) AS exceptions,
      (SELECT md5(string_agg(id || ':' || xmin::text, ',' ORDER BY id)) FROM patrol_runs) AS runs,
      (SELECT md5(string_agg(id || ':' || xmin::text, ',' ORDER BY id)) FROM patrol_evidence) AS evidence`);
    const before = await snapshot();
    for (const t of [tok.owner, tok.viewer, tok.control]) {
      await attention(t);
      for (const id of [w1.exceptionId, w2.exceptionId, w3.exceptionId]) expect(await api('GET', `/patrols/exceptions/${id}/investigation`, t), 200);
    }
    assert.deepEqual(await snapshot(), before, 'no row changed (xmin), no audit entry');
  });

  await test('POPS-11-CONCURRENT-CONTROLLERS-AND-READS-STAY-CONSISTENT', async () => {
    const F = await mkCompany('foxtrot');
    const site = await mkSite(F.id, 'Ops Site', 'Europe/London');
    const g = await mkGuard('Fin');
    const c1 = await mkMember(F.id, 'foxtrot', 'control_room', 'Fox');
    const c2 = await mkMember(F.id, 'foxtrot', 'operations', 'Flo');
    const made: Array<{ alertId: number | null }> = [];
    for (let i = 0; i < 12; i += 1) made.push(await mkCase({ companyId: F.id, siteId: site, guardId: g.id, start: new Date(dayStart('Europe/London').getTime() + (i + 1) * 20 * MIN) }));
    const reads: any[] = [];
    const reader = (async () => { for (let i = 0; i < 12; i += 1) reads.push(await operations.attention(F.user)); })();
    const actions = made.flatMap((m, i) => [c1, c2].map(async (c) => {
      try {
        await alerts.acknowledgeForCompany(c.id, m.alertId!);
      } catch { /* the other controller acknowledged first */ }
      if (i % 2 === 0) {
        try { await alerts.closeForCompany(c.id, m.alertId!, { resolutionReason: 'guard_contacted', resolutionNote: 'Checked.' }); } catch { /* resolved by the other */ }
      }
    }));
    await Promise.all([reader, ...actions]);
    for (const r of [...reads, await operations.attention(F.user)]) {
      assert.equal(new Set(r.cases.map((c: any) => c.caseKey)).size, r.cases.length, 'no case twice in any read');
      assert.equal(r.cases.length, r.counts.patrolAlerts, 'list and count agree (under the cap)');
      assert.equal(r.counts.stateMismatches, 0, 'alert and exception never disagree (Stage 1 atomicity)');
      assert.equal(r.counts.missedTodayOpen + r.counts.missedTodayResolved, r.counts.missedToday);
      assert.ok(r.cases.every((c: any) => c.status === c.exceptionStatus));
    }
    const final = await operations.attention(F.user);
    const [db] = await q(`SELECT count(*)::int AS open, count(*) FILTER (WHERE e.status = 'acknowledged')::int AS acked FROM patrol_exceptions e JOIN safety_alerts a ON a.id = e."safetyAlertId"
      WHERE e."companyId" = $1 AND e.status <> 'resolved'`, [F.id]);
    assert.deepEqual([final.counts.patrolAlerts, final.counts.acknowledged, final.counts.missedTodayResolved], [db.open, db.acked, 6]);
    assert.deepEqual([db.open, db.acked], [6, 6], 'six resolved, six acknowledged once each');
  });

  await test('POPS-12-PRE-STAGE-1-MISMATCH-LISTED-NOT-HIDDEN', async () => {
    const G = await mkCompany('golf');
    const site = await mkSite(G.id, 'Legacy Site', 'Europe/London');
    const g = await mkGuard('Gus');
    const m = await mkCase({ companyId: G.id, siteId: site, guardId: g.id, start: new Date(dayStart('Europe/London').getTime() + 30 * MIN) });
    await q(`UPDATE safety_alerts SET status = 'closed', "closedAt" = now() WHERE id = $1`, [m.alertId]);
    const r = await operations.attention(G.user);
    assert.deepEqual([r.cases.length, r.cases[0].stateMismatch, r.cases[0].status, r.counts.stateMismatches, r.counts.openPatrolAlerts], [1, true, 'closed', 1, 0]);
  });

  await app.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log(JSON.stringify({ event: 'patrol_operations_certified', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
