/**
 * Patrol Management dashboard corrections (P1-D review, owner 29 Oct 2026; issues #76, #77, #78): the company reads the
 * dashboard relies on. The whole application over HTTP on a disposable database built from the repository's own
 * migrations (no new migration). The patrol and safety sweeps' timers are stopped.
 *
 *   PD-76-01  one checkpoint count: the History list and the run detail report the SAME checkpointsVisited /
 *             checkpointsTotal, computed by the server with the checkpoint_missed rule's definition (distinct
 *             checkpoints with an unflagged scan; a duplicate / off-route / other-site scan never counts)
 *   PD-77-01  site-local day bounds: 25 h on 26 Oct 2025, 23 h on 30 Mar 2025 (Europe/London), BST, GMT, another zone
 *   PD-77-02  History (dateBasis=site_local) across the 26 Oct 2025 clocks-back day; the UTC default is unchanged
 *   PD-77-03  History across the 30 Mar 2025 clocks-forward day; inclusive ranges
 *   PD-77-04  all sites: each run on its OWN site's day (New York vs London); tenant isolation; patrols.view; validation
 *   PD-77-05  the Overview on the site-local day (runs, flagged scans), the UTC default unchanged, today by default
 *
 * Needs PATROL_DASHBOARD_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_DASHBOARD_DATABASE_URL;
if (!url) throw new Error('PATROL_DASHBOARD_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Patrol dashboard database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-dashboard-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;
delete process.env.PUSH_WELFARE_REMINDERS_ENABLED;
delete process.env.PUSH_GUARD_NOTIFICATIONS_ENABLED;
delete process.env.PATROL_QR_SIGNING_KEY;
delete process.env.PATROL_QR_PREVIOUS_SIGNING_KEY;

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 10).join('\n      ')}`);
  }
};

type Res = { status: number; body: any };
const PASSWORD = 'patrol-dashboard-spec-only-password-1';
const Z = (s: string) => new Date(s);
let clientSeq = 0;
const cid = (p: string) => `${p}-${Date.now().toString(36)}-${(++clientSeq).toString().padStart(4, '0')}`;

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
  assert.equal(migrated[migrated.length - 1]?.name, 'AddPatrolEvidenceStorage1720900000016', 'the head is still Migration 70: these reads need no migration');
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
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const auth = app.get(AuthService);
  const S = await import('../src/patrol/patrol-state');
  const W = await import('../src/patrol/patrol-window.service');

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  const api = async (method: string, p: string, tok: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const expect = (r: Res, status: number, code?: string, what = '') => {
    assert.equal(r.status, status, `${what} expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.body)}`);
    if (code) assert.equal(r.body?.code, code, `${what} code: ${JSON.stringify(r.body)}`);
  };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    (await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,$4,'Spec') RETURNING id`, [email, hash, role, email.split('@')[0]])).id as number;
  const mkCompany = async (label: string) => {
    seq += 1;
    const ownerEmail = `pd.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
      [ownerId, `PD ${label} Ltd`, String(76000000 + seq)]);
    return { id: Number(id), ownerId, ownerEmail };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `pd.${label}.${role}@example.invalid`;
    const id = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return email;
  };
  const mkSite = async (companyId: number, name: string, tz = 'Europe/London') =>
    Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,$2,'3 Quay',$3) RETURNING id`, [companyId, name, tz])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const email = `pd.${label}@example.invalid`;
    const userId = await mkUser(email, 'guard');
    const { id } = await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `76${String(seq).padStart(14, '0')}`, `0772${String(seq).padStart(7, '0')}`]);
    return { id: Number(id), userId, email };
  };
  const mkShift = async (companyId: number, siteId: number, guardId: number, start: Date, end: Date, status = 'in_progress') =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Gate',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, start, end])).id);
  const mkCheckpoint = async (companyId: number, siteId: number, label: string) =>
    one(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, siteId, require('node:crypto').randomBytes(16).toString('hex'), label]);
  const mkRoute = async (companyId: number, siteId: number, checkpoints: any[]) => {
    const route = await one(`INSERT INTO patrol_routes ("companyId","siteId",name) VALUES ($1,$2,'Perimeter') RETURNING id`, [companyId, siteId]);
    for (const [i, cp] of checkpoints.entries()) {
      await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position) VALUES ($1,$2,$3,$4,$5)`, [companyId, siteId, route.id, cp.id, i + 1]);
    }
    return Number(route.id);
  };
  const insRun = async (r: {
    companyId: number; siteId: number; shiftId: number; guard: { id: number; userId: number }; scheduleId?: number | null; routeId?: number | null;
    windowKey?: string | null; windowStart?: Date | null; windowEnd?: Date | null; scopeKey?: string; status?: string; startedAt: Date;
  }) => one(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
       status,"startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$14,$15) RETURNING *`,
    [r.companyId, r.siteId, r.shiftId, r.guard.id, r.guard.userId, r.scheduleId ?? null, r.routeId ?? null, r.windowKey ?? null, r.windowStart ?? null,
      r.windowEnd ?? null, r.scopeKey ?? 'site', r.status ?? 'in_progress', r.startedAt, r.status && r.status !== 'in_progress' ? r.startedAt : null, cid('run')]);
  const insVisit = (companyId: number, runId: number, checkpoint: any, result: string, at: Date, flags: string[] = []) =>
    one(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","clientVisitId")
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`, [companyId, runId, checkpoint?.id ?? null, checkpoint?.publicId ?? null, result, JSON.stringify(flags), at, cid('visit')]);

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const aViewer = await mkMember(A.id, 'alpha', 'viewer');
  const aFinance = await mkMember(A.id, 'alpha', 'finance');
  const aSite = await mkSite(A.id, 'Alpha Quay');
  const bSite = await mkSite(B.id, 'Bravo Yard');
  const gA = await mkGuard('ava');
  const gB = await mkGuard('ben');
  const shiftA = await mkShift(A.id, aSite, gA.id, Z('2025-10-25T20:00:00Z'), Z('2025-10-26T08:00:00Z'));
  const shiftB = await mkShift(B.id, bSite, gB.id, Z('2025-10-25T20:00:00Z'), Z('2025-10-26T08:00:00Z'));
  const tokOwnerA = await login(A.ownerEmail);
  const tokViewerA = await login(aViewer);
  const tokFinanceA = await login(aFinance);
  const tokOwnerB = await login(B.ownerEmail);

  try {
    // ═══════════════════ #76 one checkpoint count ═══════════════════
    await test('PD-76-01-HISTORY-AND-DETAIL-REPORT-ONE-CHECKPOINT-COUNT', async () => {
      const cps = [];
      for (const n of [1, 2, 3, 4]) cps.push(await mkCheckpoint(A.id, aSite, `Gate ${n}`));
      const otherSite = await mkSite(A.id, 'Alpha Annex');
      const foreign = await mkCheckpoint(A.id, otherSite, 'Annex door');
      const routeId = await mkRoute(A.id, aSite, cps);
      const run = await insRun({ companyId: A.id, siteId: aSite, shiftId: shiftA, guard: gA, routeId, status: 'completed', startedAt: Z('2025-10-25T21:00:00Z') });
      const t = (m: number) => new Date(Z('2025-10-25T21:00:00Z').getTime() + m * 60_000);
      await insVisit(A.id, run.id, cps[0], 'verified', t(1));
      await insVisit(A.id, run.id, cps[0], 'flagged', t(2), ['duplicate_in_run']); // the second scan of Gate 1
      await insVisit(A.id, run.id, cps[1], 'unverified', t(3), ['unsigned_scan']); // counts, as for checkpoint_missed
      await insVisit(A.id, run.id, foreign, 'flagged', t(4), ['wrong_site', 'not_on_route']);
      await insVisit(A.id, run.id, cps[2], 'flagged', t(5), ['tampered_signature']); // proves nothing
      await insVisit(A.id, run.id, { id: null, publicId: 'f'.repeat(32) }, 'flagged', t(6), ['unknown_checkpoint']); // no checkpoint at all

      const list = await api('GET', `/patrols/runs?siteId=${aSite}`, tokViewerA);
      expect(list, 200);
      const item = list.body.items.find((r: any) => r.id === Number(run.id));
      const detail = await api('GET', `/patrols/runs/${run.id}`, tokViewerA);
      expect(detail, 200);
      assert.deepEqual([item.checkpointsVisited, item.checkpointsTotal], [2, 4], 'History: Gate 1 and Gate 2, of 4');
      assert.deepEqual([detail.body.run.checkpointsVisited, detail.body.run.checkpointsTotal], [2, 4], 'the detail: the same');
      assert.deepEqual([item.visitCount, item.flaggedVisitCount], [6, 4], 'raw scan counts stay as they were (not progress)');
      // It is the rule checkpoint_missed is judged by.
      const req = S.evaluateRequirements({
        requiredCheckpointIds: cps.map((c: any) => Number(c.id)), photoRequiredCheckpointIds: [], photosPerRun: 0, photosPerCheckpoint: 0,
        visits: detail.body.visits.map((v: any) => ({ visitId: v.id, checkpointId: v.checkpointId, result: v.result })), evidence: [],
      });
      assert.equal(cps.length - req.missingCheckpointIds.length, detail.body.run.checkpointsVisited);
      // A run with no route: a count with no total; another company's runs are not readable.
      const bare = await insRun({ companyId: A.id, siteId: aSite, shiftId: shiftA, guard: gA, status: 'completed', startedAt: Z('2025-10-25T22:00:00Z') });
      await insVisit(A.id, bare.id, cps[3], 'verified', Z('2025-10-25T22:01:00Z'));
      const bareDetail = await api('GET', `/patrols/runs/${bare.id}`, tokViewerA);
      assert.deepEqual([bareDetail.body.run.checkpointsVisited, bareDetail.body.run.checkpointsTotal], [1, null]);
      expect(await api('GET', `/patrols/runs/${run.id}`, tokOwnerB), 404, 'PATROL_NOT_FOUND', 'another company');
      await q(`DELETE FROM patrol_checkpoint_visits WHERE "runId" = ANY($1::int[])`, [[run.id, bare.id]]);
      await q(`DELETE FROM patrol_runs WHERE id = ANY($1::int[])`, [[run.id, bare.id]]);
    });

    // ═══════════════════ #77 site-local days ═══════════════════
    await test('PD-77-01-SITE-DAY-BOUNDS-ARE-23-OR-25-HOURS-ON-UK-DST-DAYS', () => {
      const span = (d: string, tz = 'Europe/London') => { const b = W.siteDayBounds(d, tz); return [b.start.toISOString(), b.end.toISOString()]; };
      assert.deepEqual(span('2025-10-26'), ['2025-10-25T23:00:00.000Z', '2025-10-27T00:00:00.000Z'], 'clocks back: 25 hours');
      assert.deepEqual(span('2025-03-30'), ['2025-03-30T00:00:00.000Z', '2025-03-30T23:00:00.000Z'], 'clocks forward: 23 hours');
      assert.deepEqual(span('2025-07-01'), ['2025-06-30T23:00:00.000Z', '2025-07-01T23:00:00.000Z'], 'BST');
      assert.deepEqual(span('2025-12-01'), ['2025-12-01T00:00:00.000Z', '2025-12-02T00:00:00.000Z'], 'GMT');
      assert.deepEqual(span('2025-10-26', 'UTC'), ['2025-10-26T00:00:00.000Z', '2025-10-27T00:00:00.000Z']);
      assert.deepEqual(span('2025-11-02', 'America/New_York'), ['2025-11-02T04:00:00.000Z', '2025-11-03T05:00:00.000Z'], 'another zone, its own DST');
    });

    const dstSite = await mkSite(A.id, 'Alpha DST Wharf');
    const nySite = await mkSite(A.id, 'Alpha Hudson Pier', 'America/New_York');
    const at = async (siteId: number, startedAt: string, status = 'completed') =>
      Number((await insRun({ companyId: A.id, siteId, shiftId: shiftA, guard: gA, status, startedAt: Z(startedAt) })).id);
    const ids = (r: Res) => r.body.items.map((x: any) => x.id).sort((a: number, b: number) => a - b);
    const runs = async (qs: string, tok = tokViewerA) => { const r = await api('GET', `/patrols/runs?pageSize=100&${qs}`, tok); expect(r, 200, undefined, qs); return ids(r); };

    await test('PD-77-02-HISTORY-SITE-LOCAL-DAYS-ACROSS-THE-26-OCT-2025-CLOCKS-BACK', async () => {
      const lateOn25 = await at(dstSite, '2025-10-25T22:59:59Z'); // 23:59:59 BST on the 25th
      const midnight = await at(dstSite, '2025-10-25T23:00:00Z'); // 00:00 BST on the 26th
      const repeated = await at(dstSite, '2025-10-26T01:30:00Z'); // 01:30 GMT, after the repeated hour
      const lateOn26 = await at(dstSite, '2025-10-26T23:30:00Z'); // 23:30 GMT on the 26th
      const on27 = await at(dstSite, '2025-10-27T00:00:00Z');
      const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-10-26&to=2025-10-26&dateBasis=site_local`), sorted([midnight, repeated, lateOn26]), 'the 25-hour London day');
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-10-25&to=2025-10-25&dateBasis=site_local`), [lateOn25]);
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-10-27&dateBasis=site_local`), [on27], 'open end');
      assert.deepEqual(await runs(`siteId=${dstSite}&to=2025-10-25&dateBasis=site_local`), [lateOn25], 'open start');
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-10-26&to=2025-10-26`), sorted([repeated, lateOn26]), 'the default UTC basis is unchanged');
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-10-27&to=2025-10-26&dateBasis=site_local`), [], 'from after to: nothing');
    });

    await test('PD-77-03-HISTORY-SITE-LOCAL-DAYS-ACROSS-THE-30-MAR-2025-CLOCKS-FORWARD', async () => {
      const on29 = await at(dstSite, '2025-03-29T23:59:00Z'); // 23:59 GMT on the 29th
      const first = await at(dstSite, '2025-03-30T00:00:00Z'); // 00:00 GMT on the 30th
      const last = await at(dstSite, '2025-03-30T22:59:00Z'); // 23:59 BST on the 30th
      const on31 = await at(dstSite, '2025-03-30T23:00:00Z'); // 00:00 BST on the 31st
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-03-30&to=2025-03-30&dateBasis=site_local`), [first, last], 'the 23-hour London day');
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-03-31&to=2025-03-31&dateBasis=site_local`), [on31]);
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-03-29&to=2025-03-30&dateBasis=site_local`), [on29, first, last], 'an inclusive range');
      assert.deepEqual(await runs(`siteId=${dstSite}&from=2025-03-30&to=2025-03-30`), [first, last, on31], 'UTC: 23:00Z is still the 30th');
    });

    await test('PD-77-04-ALL-SITES-EACH-RUN-ON-ITS-OWN-SITE-DAY-AND-TENANT-SCOPED', async () => {
      const ny = await at(nySite, '2025-10-26T03:30:00Z'); // 23:30 EDT on 25 Oct in New York (04:30 GMT on the 26th in London)
      const london = await runs(`from=2025-10-26&to=2025-10-26&dateBasis=site_local`);
      assert.ok(!london.includes(ny), 'New York is still on the 25th');
      assert.ok((await runs(`from=2025-10-25&to=2025-10-25&dateBasis=site_local`)).includes(ny));
      assert.ok((await runs(`from=2025-10-26&to=2025-10-26`)).includes(ny), 'a UTC day would have put it on the 26th');
      // Company B never sees A's runs, and A's site filter does not reach B's site.
      const bRun = Number((await insRun({ companyId: B.id, siteId: bSite, shiftId: shiftB, guard: gB, status: 'completed', startedAt: Z('2025-10-26T10:00:00Z') })).id);
      assert.ok(!(await runs(`from=2025-10-26&to=2025-10-26&dateBasis=site_local`)).includes(bRun));
      assert.deepEqual(await runs(`siteId=${bSite}&from=2025-10-26&to=2025-10-26&dateBasis=site_local`), [], "another company's site: nothing");
      assert.deepEqual(await runs(`from=2025-10-26&to=2025-10-26&dateBasis=site_local`, tokOwnerB), [bRun]);
      expect(await api('GET', `/patrols/runs?from=2025-10-26&dateBasis=site_local`, tokFinanceA), 403, 'PATROL_FORBIDDEN', 'no patrols.view');
      expect(await api('GET', `/patrols/runs?dateBasis=local`, tokViewerA), 400, undefined, 'an unknown basis');
    });

    await test('PD-77-05-OVERVIEW-ON-THE-SITE-LOCAL-DAY', async () => {
      const ov = async (qs: string) => { const r = await api('GET', `/patrols/overview?${qs}`, tokViewerA); expect(r, 200, undefined, qs); return r.body; };
      const runOn26 = (await q(`SELECT id FROM patrol_runs WHERE "siteId" = $1 AND "startedAtServer" = $2`, [dstSite, Z('2025-10-25T23:00:00Z')]))[0].id;
      const cp = await mkCheckpoint(A.id, dstSite, 'Wharf gate');
      const v = await insVisit(A.id, runOn26, cp, 'flagged', Z('2025-10-25T23:10:00Z'), ['tampered_signature']);
      await q(`UPDATE patrol_checkpoint_visits SET "receivedAtServer" = $2 WHERE id = $1`, [v.id, Z('2025-10-25T23:30:00Z')]);
      const local = await ov(`siteId=${dstSite}&date=2025-10-26&dateBasis=site_local`);
      assert.deepEqual([local.date, local.dateBasis, local.timeZone, local.runsStarted, local.runsByStatus.completed, local.flaggedScans],
        ['2025-10-26', 'site_local', 'Europe/London', 3, 3, 1], 'the 25-hour site day');
      const utc = await ov(`siteId=${dstSite}&date=2025-10-26`);
      assert.deepEqual([utc.dateBasis, utc.timeZone, utc.runsStarted, utc.flaggedScans], ['utc', null, 2, 0], 'the UTC default is unchanged');
      const spring = await ov(`siteId=${dstSite}&date=2025-03-30&dateBasis=site_local`);
      assert.equal(spring.runsStarted, 2, 'the 23-hour site day');
      const all = await ov(`date=2025-10-25&dateBasis=site_local`);
      assert.equal(all.timeZone, null, 'all sites: each on its own zone');
      assert.ok(all.runsStarted >= 2, 'London 23:59:59 BST and New York 23:30 EDT are both on the 25th');
      const today = await ov(`siteId=${dstSite}&dateBasis=site_local`);
      assert.equal(today.date, W.localDateOf(new Date(), 'Europe/London'), "today at the site by default");
      expect(await api('GET', `/patrols/overview?dateBasis=site_local`, tokFinanceA), 403, 'PATROL_FORBIDDEN');
    });
  } finally {
    await app.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`Failures: ${failures.join(', ')}`);
    process.exit(1);
  }
  void tokOwnerA; void tokFinanceA; void shiftB;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
