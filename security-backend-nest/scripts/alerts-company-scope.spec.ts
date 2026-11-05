/**
 * Stage A (owner-approved 5 Nov 2026): GET /alerts/company's opt-in bounded scopes, over HTTP, on a disposable database
 * built from the repository's own migrations (no new migration).
 *
 *   ACS-01  without `scope` the response is exactly the existing list (an unknown key or a stray page= is still ignored)
 *   ACS-02  operational: every unresolved alert of any age, every alert of the board's shifts (closed and per-window
 *           evidence included; in-progress shifts of any age), the newest 20 — de-duplicated, newest first, the same item
 *           shape as the unscoped list; complete unresolved counts by type; old closed history left out
 *   ACS-03  operational caps: the unresolved list is capped with `more`, the counts stay complete
 *   ACS-04  a day-mode window ([since, until]) reads that day's shifts; bad windows are refused (400)
 *   ACS-05  history: raised or closed in [from, to), newest first, paginated (at most 100), pages never repeat or skip
 *   ACS-06  shift: one shift's whole record (historical), another company's shift 404
 *   ACS-07  member visibility per scope: compliance only, patrols only with the switch on, Finance 404; Platform Admin
 *           unchanged without a scope and refused with one
 *   ACS-08  cross-company isolation in every scope
 *   ACS-09  invalid input: unknown scope, a parameter of another scope, bad numbers and dates — 400 with the reason
 *   ACS-10  scoped reads write nothing
 *   ACS-11  the alert lifecycle is unchanged: acknowledging and closing are reflected, counts follow
 *   ACS-12  the WHOLE operational response is strictly bounded (unresolved + board + recent <= 2520) with thousands of
 *           each; a panic or critical alert is never left out for routine ones; every unresolved alert is listed or
 *           counted as omitted, per type; explicit more flags
 *   ACS-13  one shift's record is complete across pages (paginated, at most 500 per page)
 *
 * Needs ALERTS_COMPANY_SCOPE_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.ALERTS_COMPANY_SCOPE_DATABASE_URL;
if (!url) throw new Error('ALERTS_COMPANY_SCOPE_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Alerts scope database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'alerts-scope-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;

type Res = { status: number; body: any };
const PASSWORD = 'Spec-Password-123!';
const H = 3_600_000;
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
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const alertService = app.get(SafetyAlertService);
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
  const ok = (r: Res, what = '') => { assert.equal(r.status, 200, `${what} expected 200, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`); return r.body; };
  const login = async (email: string) => ((await auth.login({ email, password: PASSWORD } as never)) as any).accessToken as string;

  // ── Fixtures (synthetic) ──
  const hash = await bcrypt.hash(PASSWORD, 4);
  let seq = 0;
  const mkUser = async (email: string, role: string) =>
    Number((await one(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
       VALUES ($1,$2,$3,'active',true,false,'Spec','User') RETURNING id`, [email, hash, role])).id);
  const mkCompany = async (label: string, patrolsEnabled = true) => {
    seq += 1;
    const ownerEmail = `acs.${label}.owner@example.invalid`;
    const ownerId = await mkUser(ownerEmail, 'company_admin');
    const { id } = await one(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',$4) RETURNING id`,
      [ownerId, `ACS ${label} Ltd`, String(80000000 + seq), patrolsEnabled]);
    return { id: Number(id), ownerEmail };
  };
  const mkMember = async (companyId: number, label: string, role: string) => {
    const email = `acs.${label}.${role}.${(seq += 1)}@example.invalid`;
    const id = await mkUser(email, 'company_admin');
    await q(`INSERT INTO company_memberships ("userId","companyId","membershipRole",status) VALUES ($1,$2,$3,'active')`, [id, companyId, role]);
    return email;
  };
  const mkSite = async (companyId: number) => Number((await one(`INSERT INTO sites ("companyId",name,address,timezone) VALUES ($1,'Quay','3 Quay','Europe/London') RETURNING id`, [companyId])).id);
  const mkGuard = async (label: string) => {
    seq += 1;
    const userId = await mkUser(`acs.g.${label}@example.invalid`, 'guard');
    return Number((await one(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, `Guard ${label}`, `80${String(seq).padStart(14, '0')}`, `0780${String(seq).padStart(7, '0')}`])).id);
  };
  const NOW = Date.now();
  const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * H);
  const mkShift = async (companyId: number, siteId: number, guardId: number, startH: number, endH: number, status: string) =>
    Number((await one(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end") VALUES ($1,$2,'Quay',$3,$4,$5,$6) RETURNING id`,
      [companyId, siteId, guardId, status, at(startH), at(endH)])).id);
  const mkAlert = async (o: { companyId: number; guardId: number; shiftId?: number | null; type?: string; status?: string; createdH: number; closedH?: number | null; windowIndex?: number | null; extra?: Record<string, unknown> }) => {
    const cols: Record<string, unknown> = {
      companyId: o.companyId, guardId: o.guardId, shiftId: o.shiftId ?? null, type: o.type ?? 'missed_checkcall', priority: 'medium', message: 'Synthetic alert',
      status: o.status ?? 'open', createdAt: at(o.createdH), updatedAt: at(o.closedH ?? o.createdH), closedAt: o.closedH == null ? null : at(o.closedH),
      welfareWindowIndex: o.windowIndex ?? null, ...(o.extra ?? {}),
    };
    const keys = Object.keys(cols);
    return Number((await one(`INSERT INTO safety_alerts (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(cols))).id);
  };

  const A = await mkCompany('alpha');
  const B = await mkCompany('bravo');
  const siteA = await mkSite(A.id);
  const siteB = await mkSite(B.id);
  const g = await mkGuard('ava');
  const gB = await mkGuard('ben');
  // Shifts: ended 5 days ago (outside the window); ended 10 h ago (in it); in progress since 6 days ago (any age); starts in 2 h.
  const oldShift = await mkShift(A.id, siteA, g, -130, -120, 'completed');
  const recentShift = await mkShift(A.id, siteA, g, -22, -10, 'completed');
  const staleLive = await mkShift(A.id, siteA, g, -144, -134, 'in_progress');
  const upcoming = await mkShift(A.id, siteA, g, 2, 10, 'ready');
  const ids = {
    oldOpen: await mkAlert({ companyId: A.id, guardId: g, shiftId: oldShift, createdH: -125 }), // unresolved, 5 days old
    oldAcked: await mkAlert({ companyId: A.id, guardId: g, shiftId: oldShift, type: 'site_request', status: 'acknowledged', createdH: -124 }),
    oldClosed: await mkAlert({ companyId: A.id, guardId: g, shiftId: oldShift, type: 'panic', status: 'closed', createdH: -123, closedH: -122 }), // history only
    oldEvidence: await mkAlert({ companyId: A.id, guardId: g, shiftId: oldShift, status: 'closed', createdH: -121, closedH: -121, windowIndex: 3 }),
    noShiftOpen: await mkAlert({ companyId: A.id, guardId: g, shiftId: null, type: 'other', createdH: -300 }), // unresolved, no shift, 12 days
    recentClosed: await mkAlert({ companyId: A.id, guardId: g, shiftId: recentShift, type: 'missing_book_off', status: 'closed', createdH: -9, closedH: -8 }),
    recentEvidence: await mkAlert({ companyId: A.id, guardId: g, shiftId: recentShift, status: 'closed', createdH: -15, closedH: -15, windowIndex: 1 }),
    staleClosed: await mkAlert({ companyId: A.id, guardId: g, shiftId: staleLive, type: 'welfare', status: 'closed', createdH: -140, closedH: -139 }),
    upcomingOpen: await mkAlert({ companyId: A.id, guardId: g, shiftId: upcoming, type: 'late_checkin', createdH: -1 }),
    compliance: await mkAlert({ companyId: A.id, guardId: g, shiftId: recentShift, type: 'compliance_lapse', createdH: -12, extra: { complianceCategory: 'sia_licence', lapseKey: 'acs-1' } }),
    patrol: await mkAlert({ companyId: A.id, guardId: g, shiftId: recentShift, type: 'patrol_missed', createdH: -11 }),
    bOpen: await mkAlert({ companyId: B.id, guardId: gB, shiftId: await mkShift(B.id, siteB, gB, -5, -1, 'completed'), createdH: -2 }),
  };
  // Twenty-five newer closed alerts on the board's shift, so the newest 20 never reach the old closed history.
  const newer: number[] = [];
  for (let i = 0; i < 25; i += 1) newer.push(await mkAlert({ companyId: A.id, guardId: g, shiftId: recentShift, status: 'closed', createdH: -0.5 - i * 0.01, closedH: -0.4, windowIndex: 100 + i }));

  const tok = {
    owner: await login(A.ownerEmail), bOwner: await login(B.ownerEmail),
    hr: await login(await mkMember(A.id, 'alpha', 'hr_compliance')), viewer: await login(await mkMember(A.id, 'alpha', 'viewer')),
    finance: await login(await mkMember(A.id, 'alpha', 'finance')),
    admin: '',
  };
  const adminEmail = 'acs.platform.admin@example.invalid';
  await mkUser(adminEmail, 'admin');
  tok.admin = await login(adminEmail);
  const operational = (t: string, extra = '') => api('GET', `/alerts/company?scope=operational${extra}`, t);
  const idsOf = (list: any[]) => list.map((a) => a.id);

  await test('ACS-01-NO-SCOPE-IS-THE-EXISTING-LIST', async () => {
    const plain = ok(await api('GET', '/alerts/company', tok.owner));
    const direct = JSON.parse(JSON.stringify(await alertService.findForCompany(await (await one(`SELECT "userId" FROM companies WHERE id = $1`, [A.id])).userId)));
    assert.deepEqual(plain, direct, 'the route answers exactly findForCompany');
    assert.equal(plain.length, 12 + newer.length - 1, 'every alert of the company, any age and status');
    for (const stray of ['?foo=1', '?page=2&pageSize=5', '?scope=', '?since=2020-01-01T00:00:00Z']) {
      assert.deepEqual(ok(await api('GET', `/alerts/company${stray}`, tok.owner), stray), plain, `${stray}: ignored, as before`);
    }
    const admin = ok(await api('GET', '/alerts/company', tok.admin));
    assert.ok(admin.some((a: any) => a.id === ids.bOpen) && admin.some((a: any) => a.id === ids.oldOpen), 'Platform Admin: every company, unchanged');
  });

  await test('ACS-02-OPERATIONAL-CONTENT-COUNTS-AND-SHAPE', async () => {
    const r = ok(await operational(tok.owner));
    const got = new Set(idsOf(r.alerts));
    for (const k of ['oldOpen', 'oldAcked', 'noShiftOpen', 'upcomingOpen', 'compliance', 'patrol'] as const) assert.ok(got.has(ids[k]), `${k}: unresolved, any age`);
    for (const k of ['recentClosed', 'recentEvidence'] as const) assert.ok(got.has(ids[k]), `${k}: a board shift's record, closed and per-window evidence included`);
    assert.ok(got.has(ids.staleClosed), 'an in-progress shift of any age keeps its whole record (Needs Reconciliation)');
    for (const n of newer.slice(0, 20)) assert.ok(got.has(n), 'the newest alerts (Recent activity)');
    assert.ok(!got.has(ids.oldClosed) && !got.has(ids.oldEvidence), 'old closed history of a shift off the board is left out');
    assert.ok(!got.has(ids.bOpen), 'another company never');
    assert.equal(got.size, r.alerts.length, 'no alert twice');
    const order = r.alerts.map((a: any) => [new Date(a.createdAt).getTime(), a.id]);
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1][0] > order[i][0] || (order[i - 1][0] === order[i][0] && order[i - 1][1] > order[i][1]), 'newest first, id tie-break');
    assert.deepEqual([r.counts.unresolved, r.counts.unresolvedByType], [6, { compliance_lapse: 1, late_checkin: 1, missed_checkcall: 1, other: 1, patrol_missed: 1, site_request: 1 }], 'complete unresolved counts');
    assert.deepEqual([r.counts.unresolvedListed, r.counts.unresolvedOmittedByType, r.returned], [6, {}, r.alerts.length], 'all listed, nothing omitted');
    assert.deepEqual(r.more, { unresolved: false, window: false });
    const plain = ok(await api('GET', '/alerts/company', tok.owner));
    for (const a of r.alerts) assert.deepEqual(a, plain.find((p: any) => p.id === a.id), `alert ${a.id}: the same item as the unscoped list`);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < Buffer.byteLength(JSON.stringify(plain)), 'smaller than the full list');
  });

  await test('ACS-03-OPERATIONAL-CAPS-WITH-COMPLETE-COUNTS', async () => {
    const C = await mkCompany('charlie');
    const gc = await mkGuard('cal');
    await q(`INSERT INTO safety_alerts ("companyId","guardId",type,priority,message,status,"createdAt","updatedAt")
      SELECT $1, $2, 'other', 'medium', 'bulk', 'open', now() - (s || ' minutes')::interval, now() FROM generate_series(1, 505) s`, [C.id, gc]);
    const r = ok(await operational(await login(C.ownerEmail)));
    assert.deepEqual([r.alerts.length, r.counts.unresolved, r.more.unresolved, r.limits.unresolved], [500, 505, true, 500]);
  });

  await test('ACS-04-DAY-MODE-WINDOW-AND-BAD-WINDOWS', async () => {
    // The day the old shift worked: its whole record, closed history and evidence included.
    const since = new Date(NOW - 132 * H).toISOString();
    const until = new Date(NOW - 110 * H).toISOString();
    const r = ok(await operational(tok.owner, `&since=${since}&until=${until}`));
    const got = new Set(idsOf(r.alerts));
    assert.ok(got.has(ids.oldClosed) && got.has(ids.oldEvidence), 'that day\'s shift record');
    assert.deepEqual(r.window, { since, until });
    for (const [extra, why] of [
      [`&since=${until}&until=${since}`, 'until before since'],
      [`&since=${new Date(NOW - 10 * 24 * H).toISOString()}&until=${new Date(NOW).toISOString()}`, 'more than 7 days'],
      ['&since=yesterday', 'not a date-time'],
    ]) assert.equal((await operational(tok.owner, extra)).status, 400, why);
  });

  await test('ACS-05-HISTORY-PAGINATED-RAISED-OR-CLOSED-IN-THE-PERIOD', async () => {
    const all = ok(await api('GET', '/alerts/company', tok.owner));
    let seen: number[] = [];
    let total = -1;
    for (let page = 1; page < 10; page += 1) {
      const r = ok(await api('GET', `/alerts/company?scope=history&page=${page}&pageSize=7`, tok.owner));
      total = r.total;
      assert.equal(r.pageSize, 7);
      if (!r.items.length) break;
      seen = seen.concat(idsOf(r.items));
    }
    assert.equal(total, all.length, 'without a period: every alert');
    assert.deepEqual(seen, idsOf([...all].sort((x: any, y: any) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime() || y.id - x.id)), 'pages never repeat or skip');
    // A period: raised in it, or closed in it (the panic raised at -123 h and closed at -122 h counts for [-122.5, -121.5)).
    const from = new Date(NOW - 122.5 * H).toISOString();
    const to = new Date(NOW - 121.5 * H).toISOString();
    const period = ok(await api('GET', `/alerts/company?scope=history&from=${from}&to=${to}`, tok.owner));
    assert.deepEqual(idsOf(period.items).sort(), [ids.oldClosed].sort(), 'closed in the period');
    const typed = ok(await api('GET', '/alerts/company?scope=history&type=missed_checkcall&status=closed&pageSize=100', tok.owner));
    assert.ok(typed.items.every((a: any) => a.type === 'missed_checkcall' && a.status === 'closed') && typed.total === typed.items.length);
    assert.equal((await api('GET', '/alerts/company?scope=history&pageSize=101', tok.owner)).status, 400, 'at most 100 per page');
    assert.equal(ok(await api('GET', '/alerts/company?scope=history', tok.owner)).pageSize, 50, 'default page size');
  });

  await test('ACS-06-ONE-SHIFT-RECORD', async () => {
    const r = ok(await api('GET', `/alerts/company?scope=shift&shiftId=${oldShift}`, tok.owner));
    assert.deepEqual(idsOf(r.alerts).sort(), [ids.oldOpen, ids.oldAcked, ids.oldClosed, ids.oldEvidence].sort(), 'the whole record of an old shift');
    assert.deepEqual([r.more, r.total, r.page, r.pageSize], [false, 4, 1, 100]);
    const bShift = Number((await one(`SELECT "shiftId" FROM safety_alerts WHERE id = $1`, [ids.bOpen])).shiftId);
    assert.equal((await api('GET', `/alerts/company?scope=shift&shiftId=${bShift}`, tok.owner)).status, 404, 'another company\'s shift');
    assert.equal((await api('GET', '/alerts/company?scope=shift&shiftId=99999', tok.owner)).status, 404);
    assert.equal((await api('GET', '/alerts/company?scope=shift', tok.owner)).status, 400, 'shiftId required');
  });

  await test('ACS-07-MEMBER-VISIBILITY-AND-PLATFORM-ADMIN', async () => {
    for (const s of ['operational', 'history', `shift&shiftId=${recentShift}`]) {
      const hr = ok(await api('GET', `/alerts/company?scope=${s}`, tok.hr), `hr ${s}`);
      const list = hr.alerts ?? hr.items;
      assert.ok(list.length > 0 && list.every((a: any) => a.type === 'compliance_lapse'), `HR & Compliance, ${s}: compliance lapses only`);
      // A Viewer holds compliance.view and patrols.view: compliance lapses and patrol alerts, exactly as without a scope.
      const viewer = ok(await api('GET', `/alerts/company?scope=${s}`, tok.viewer), `viewer ${s}`);
      const viewerList = viewer.alerts ?? viewer.items;
      assert.ok(viewerList.every((a: any) => a.type === 'compliance_lapse' || a.type.startsWith('patrol') || a.type === 'checkpoint_missed'), `Viewer, ${s}: compliance and patrol alerts only`);
      for (const [member, list] of [['hr', hr.alerts ?? hr.items], ['viewer', viewerList]] as const) {
        const unscoped = new Set(ok(await api('GET', '/alerts/company', (tok as any)[member])).map((a: any) => a.id));
        assert.ok(list.every((a: any) => unscoped.has(a.id)), `${member}, ${s}: never more than the member sees without a scope`);
      }
      assert.equal((await api('GET', `/alerts/company?scope=${s}`, tok.finance)).status, 404, `Finance, ${s}: as without a scope`);
    }
    const hrCounts = ok(await operational(tok.hr)).counts;
    assert.deepEqual([hrCounts.unresolved, hrCounts.unresolvedByType], [1, { compliance_lapse: 1 }], 'counts only of what the member may see');
    await q(`UPDATE companies SET "patrolsEnabled" = false WHERE id = $1`, [A.id]);
    const off = ok(await operational(tok.viewer));
    assert.ok(off.alerts.length > 0 && off.alerts.every((a: any) => a.type === 'compliance_lapse'), 'Patrols off: a Viewer keeps compliance lapses, loses patrol alerts, as without a scope');
    await q(`UPDATE companies SET "patrolsEnabled" = true WHERE id = $1`, [A.id]);
    assert.equal((await operational(tok.admin)).status, 400, 'Platform Admin: scopes are for company accounts');
    assert.equal((await api('GET', '/alerts/company?scope=operational', null)).status, 401);
  });

  await test('ACS-08-CROSS-COMPANY-ISOLATION', async () => {
    const aIds = new Set(Object.entries(ids).filter(([k]) => k !== 'bOpen').map(([, v]) => v).concat(newer));
    for (const s of ['operational', 'history&pageSize=100']) {
      const r = ok(await api('GET', `/alerts/company?scope=${s}`, tok.bOwner));
      const list = r.alerts ?? r.items;
      assert.ok(list.every((a: any) => !aIds.has(a.id)) && list.some((a: any) => a.id === ids.bOpen), `${s}: only its own`);
    }
    assert.equal(ok(await operational(tok.bOwner)).counts.unresolved, 1);
  });

  await test('ACS-09-INVALID-INPUT-IS-REFUSED-WITH-THE-REASON', async () => {
    for (const [p, why] of [
      ['scope=everything', 'unknown scope'], ['scope=operational&page=2', 'a history parameter on operational'], ['scope=history&since=2026-01-01T00:00:00Z', 'an operational parameter on history'],
      ['scope=history&page=0', 'page 0'], ['scope=history&pageSize=abc', 'not a number'], ['scope=history&type=nonsense', 'not a type'], ['scope=history&status=gone', 'not a status'],
      ['scope=history&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'to before from'], ['scope=shift&shiftId=-3', 'negative shift'],
    ]) {
      const r = await api('GET', `/alerts/company?${p}`, tok.owner);
      assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
      assert.ok(typeof r.body.message === 'string' && r.body.message.length > 0, `${why}: says why`);
    }
  });

  await test('ACS-10-SCOPED-READS-WRITE-NOTHING', async () => {
    const snap = () => one(`SELECT (SELECT count(*) FROM audit_logs)::int audits,
      (SELECT md5(string_agg(id || ':' || status || ':' || xmin::text, ',' ORDER BY id)) FROM safety_alerts) alerts`);
    const before = await snap();
    for (const p of ['scope=operational', 'scope=history', `scope=shift&shiftId=${oldShift}`]) ok(await api('GET', `/alerts/company?${p}`, tok.owner));
    assert.deepEqual(await snap(), before);
  });

  await test('ACS-11-THE-LIFECYCLE-IS-UNCHANGED', async () => {
    assert.equal(ok(await api('PATCH', `/alerts/${ids.upcomingOpen}/ack`, tok.owner)).status, 'acknowledged');
    let r = ok(await operational(tok.owner));
    assert.equal(r.alerts.find((a: any) => a.id === ids.upcomingOpen).status, 'acknowledged');
    ok(await api('PATCH', `/alerts/${ids.upcomingOpen}/close`, tok.owner, { resolutionReason: 'other', resolutionNote: 'Checked with the site.' }));
    r = ok(await operational(tok.owner));
    assert.equal(r.counts.unresolved, 5, 'resolved: out of the unresolved count');
    assert.equal(r.alerts.find((a: any) => a.id === ids.upcomingOpen)?.status, 'closed', 'still in its board shift\'s record');
  });

  await test('ACS-12-THE-WHOLE-OPERATIONAL-RESPONSE-IS-STRICTLY-BOUNDED-AND-NOTHING-SAFETY-CRITICAL-IS-DROPPED', async () => {
    const D = await mkCompany('delta');
    const sd = await mkSite(D.id);
    const gd = await mkGuard('dee');
    const boardShift = await mkShift(D.id, sd, gd, -6, -2, 'completed');
    const oldShiftD = await mkShift(D.id, sd, gd, -800, -790, 'completed');
    // 1,200 routine unresolved alerts (newest), 2,300 closed records on a board shift, and — oldest of all — 3 open
    // panics and 2 critical Missing Book Off alerts.
    await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt","updatedAt")
      SELECT $1, $2, $3, 'other', 'medium', 'routine', 'open', now() - (s || ' seconds')::interval, now() FROM generate_series(1, 1200) s`, [D.id, gd, oldShiftD]);
    await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt","updatedAt","closedAt","welfareWindowIndex")
      SELECT $1, $2, $3, 'missed_checkcall', 'medium', 'window', 'closed', now() - interval '1 hour' - (s || ' seconds')::interval, now(), now(), s FROM generate_series(1, 2300) s`, [D.id, gd, boardShift]);
    const panics: number[] = [];
    for (let i = 0; i < 3; i += 1) panics.push(await mkAlert({ companyId: D.id, guardId: gd, shiftId: oldShiftD, type: 'panic', createdH: -700 - i, extra: { priority: 'critical' } }));
    const criticals: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const sh = await mkShift(D.id, sd, gd, -600 - i * 20, -590 - i * 20, 'completed');
      criticals.push(await mkAlert({ companyId: D.id, guardId: gd, shiftId: sh, type: 'missing_book_off', createdH: -580 - i, extra: { priority: 'critical' } }));
    }
    const r = ok(await operational(await login(D.ownerEmail)));
    assert.ok(r.alerts.length <= r.limits.total && r.limits.total === 2520, `strict bound: ${r.alerts.length} <= ${r.limits.total}`);
    assert.equal(r.returned, r.alerts.length);
    assert.equal(new Set(idsOf(r.alerts)).size, r.alerts.length, 'no alert twice');
    const got = new Set(idsOf(r.alerts));
    for (const id of [...panics, ...criticals]) assert.ok(got.has(id), `safety-critical alert ${id} is listed although it is the oldest`);
    assert.deepEqual([r.counts.unresolved, r.counts.unresolvedByType], [1205, { missing_book_off: 2, other: 1200, panic: 3 }], 'complete counts');
    const omitted = Object.values(r.counts.unresolvedOmittedByType as Record<string, number>).reduce((n, v) => n + v, 0);
    assert.equal(r.counts.unresolvedListed + omitted, r.counts.unresolved, 'every unresolved alert is listed or counted as omitted');
    assert.deepEqual(Object.keys(r.counts.unresolvedOmittedByType), ['other'], 'only routine alerts were left out');
    assert.equal(r.alerts.filter((a: any) => a.status !== 'closed').length, r.counts.unresolvedListed);
    assert.deepEqual([r.more.unresolved, r.more.window], [true, true], 'explicit more flags');
    assert.ok(r.alerts.filter((a: any) => a.shift?.id === boardShift).length <= 2000, 'the board part is capped');
  });

  await test('ACS-13-ONE-SHIFT-RECORD-IS-COMPLETE-ACROSS-PAGES', async () => {
    const E = await mkCompany('echo');
    const se = await mkSite(E.id);
    const ge = await mkGuard('eve');
    const long = await mkShift(E.id, se, ge, -900, -880, 'completed');
    await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt","updatedAt","closedAt","welfareWindowIndex")
      SELECT $1, $2, $3, 'missed_checkcall', 'medium', 'window', 'closed', now() - interval '880 hours' - (s || ' seconds')::interval, now(), now(), s FROM generate_series(1, 650) s`, [E.id, ge, long]);
    const t = await login(E.ownerEmail);
    let seen: number[] = [];
    let page = 1;
    let last: any = null;
    do {
      last = ok(await api('GET', `/alerts/company?scope=shift&shiftId=${long}&page=${page}&pageSize=100`, t));
      seen = seen.concat(idsOf(last.alerts));
      page += 1;
    } while (last.more && page < 20);
    const all = (await q(`SELECT id FROM safety_alerts WHERE "shiftId" = $1 ORDER BY "createdAt" DESC, id DESC`, [long])).map((x: any) => Number(x.id));
    assert.deepEqual([last.total, seen.length], [650, 650]);
    assert.deepEqual(seen, all, 'every alert of the shift, in order, none repeated or skipped');
    assert.equal(ok(await api('GET', `/alerts/company?scope=shift&shiftId=${long}&pageSize=500`, t)).alerts.length, 500);
    assert.equal((await api('GET', `/alerts/company?scope=shift&shiftId=${long}&pageSize=501`, t)).status, 400, 'at most 500 per page');
  });

  await app.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log(JSON.stringify({ event: 'alerts_company_scope_certified', tests: passed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
