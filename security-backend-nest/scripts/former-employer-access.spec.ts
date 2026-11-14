/**
 * SEC-001B Stage 2A — former-employer access, over real HTTP against a real Nest app and a LOCAL, disposable PostgreSQL.
 *
 * A company whose relationship with a guard has ended (INACTIVE) or been blocked (BLOCKED) keeps its own historical
 * records about that guard, but loses the guard's CURRENT personal data and may no longer change records about them.
 *
 *   CURRENT-AVAILABILITY  the guard's own (company-less) availability rules and overrides reach a company only while the
 *                         relationship is ACTIVE; the company's own rows for a former guard stay readable
 *   WRITES-DENIED         availability, leave, compliance records, compliance documents (upload, verify, complete) and
 *                         the employment record cannot be created or changed for INACTIVE, BLOCKED, rejected-applicant
 *                         or unrelated guards, by any company role
 *   SAME-REFUSAL          for each role and route, a former guard is refused exactly as an unrelated guard is (status
 *                         and message), so the response never reveals whether an unrelated guard exists
 *   NO-CHANGE             every refused write leaves the guard-related tables byte-for-byte unchanged
 *   EVIDENCE              compliance evidence download links are issued only for ACTIVE guards and eligible pre-hire
 *                         applicants, never after the relationship ends (Platform Admin unchanged)
 *   DASHBOARDS            live compliance and screening status lists contain ACTIVE guards only
 *   HISTORY               the company still reads its own leave, compliance records, document list, check history,
 *                         employment record, availability rows, shifts, timesheets and incidents for former guards
 *   ACTIVE / PRE-HIRE     the same writes still work for an ACTIVE guard and for an applicant under review
 *   GUARD-OWNED / ADMIN   a guard's own availability and Platform Admin evidence access are unchanged
 *
 * The spec collects every violation before failing, so a run against an unfixed build lists them all.
 *
 * Requires FORMER_EMPLOYER_DATABASE_URL; the host must be local. Migrations are applied, nothing is dropped. Every
 * account and record is synthetic. Evidence storage is configured with a dummy, unreachable endpoint: only URL signing
 * (local computation) is exercised.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';

const url = process.env.FORMER_EMPLOYER_DATABASE_URL;
if (!url) throw new Error('FORMER_EMPLOYER_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Former-employer database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'former-employer-local-certification-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
process.env.EVIDENCE_STORAGE_ENDPOINT = 'http://127.0.0.1:9';
process.env.EVIDENCE_STORAGE_REGION = 'eu-west-2';
process.env.EVIDENCE_STORAGE_BUCKET = 'former-employer-synthetic';
process.env.EVIDENCE_STORAGE_ACCESS_KEY_ID = 'synthetic-access-key';
process.env.EVIDENCE_STORAGE_SECRET_ACCESS_KEY = 'synthetic-secret-key';
process.env.EVIDENCE_SIGNED_URL_TTL_SECONDS = '180';

const RUN = Date.now().toString(36);
type Res = { status: number; body: any; text: string };
type Session = { token: string; userId: number; companyId?: number; guardId?: number };
const errText = (r: Res) => (Array.isArray(r.body?.message) ? r.body.message.join('; ') : r.body?.message) || '';
const ok2xx = (r: Res) => r.status >= 200 && r.status < 300;
const show = (r: Res) => `${r.status} ${JSON.stringify(errText(r))}`;

const failures: string[] = [];
let groupsPassed = 0;
async function group(name: string, run: (fail: (msg: string) => void) => void | Promise<void>) {
  const found: string[] = [];
  try {
    await run((msg) => found.push(msg));
  } catch (e: any) {
    found.push(`threw: ${e?.stack ?? e}`);
  }
  if (found.length === 0) {
    groupsPassed += 1;
    console.log(`PASS ${name}`);
  } else {
    const shown = [...new Set(found)];
    console.log(`FAIL ${name} (${shown.length})`);
    for (const f of shown.slice(0, 30)) console.log(`     - ${f}`);
    if (shown.length > 30) console.log(`     … ${shown.length - 30} more`);
    failures.push(name);
  }
}

async function main() {
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const migrator = new DataSource(
    buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' }),
  );
  await migrator.initialize();
  await migrator.runMigrations({ transaction: 'each' });
  await migrator.destroy();

  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const ds = app.get(DataSource);
  const expectedDatabase = new URL(url!).pathname.replace(/^\//, '');
  const [{ current_database: actualDatabase }] = await ds.query('SELECT current_database()');
  if (actualDatabase !== expectedDatabase) {
    throw new Error(`Refusing to run: the app is connected to "${actualDatabase}", not "${expectedDatabase}".`);
  }

  const api = async (method: string, path: string, token: string | null, body?: unknown): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, text };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];

  try {
    // ───────────────────────────── Synthetic fixtures ─────────────────────────────
    const auth = app.get(AuthService);
    const password = 'Str0ng-pass-1!';
    const session = async (email: string): Promise<Session> => {
      const s: any = await auth.login({ email, password });
      return { token: s.accessToken, userId: s.user.id, companyId: s.user.companyId, guardId: s.user.guardId };
    };
    const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
    const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
    const verifyEmail = async (email: string) => {
      const message = [...app.get(TransactionalEmailService).capturedMessages()].reverse()
        .find((m) => m.kind === 'email_verification' && m.to === email);
      const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
      assert.ok(token, `a verification email was sent to ${email}`);
      await app.get(AccountRecoveryService).verifyEmail(token);
    };
    const registerCompany = async (label: string) => {
      const email = `${label}.owner.${RUN}@former-employer.test`;
      await auth.register({
        email, password, role: 'company' as any, fullName: `${label} Owner`, phone: '02000000000',
        companyName: `${label} ${RUN} Security Ltd`, companyNumber: String(10000000 + Math.floor(Math.random() * 8999999)),
        address: '1 High St, London', contactDetails: `ops@${label}.test`,
      } as any);
      await verifyEmail(email);
      return session(email);
    };
    let siaSeq = Math.floor(Math.random() * 1e6);
    let phoneSeq = 300;
    const registerGuard = async (label: string): Promise<Session> => {
      const email = `${label}.${RUN}@former-employer.test`;
      const phone = `07700${String(800000 + (phoneSeq += 13))}`;
      const sia = String(6300000000000000 + (siaSeq += 7919));
      await auth.register({ email, password, role: 'guard' as any, fullName: `${label} FE Guard ${RUN}`, phone, siaLicenseNumber: sia } as any);
      await verifyEmail(email);
      return session(email);
    };
    const join = async (company: Session, guard: Session) => {
      const inv = await api('POST', '/company-guards/invitations', company.token, {});
      assert.equal(inv.status, 201, errText(inv));
      const acc = await api('POST', '/guards/me/invitations/accept', guard.token, { code: inv.body.code });
      assert.equal(acc.status, 201, errText(acc));
    };
    const relationId = async (companyId: number, guardId: number): Promise<number> =>
      (await one(`SELECT id FROM company_guards WHERE "companyId" = $1 AND "guardId" = $2`, [companyId, guardId])).id;

    const owner = await registerCompany('alpha');
    const ownerB = await registerCompany('beta');
    const A = owner.companyId!;
    const B = ownerB.companyId!;

    const staffHash = await bcrypt.hash(password, 10);
    const ROLES = ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'] as const;
    const sessions: Array<{ role: string; s: Session }> = [{ role: 'owner', s: owner }];
    for (const role of ROLES) {
      const email = `${role}.${RUN}@former-employer.test`;
      const [{ id }] = await q(
        `INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified", "firstName", "lastName")
         VALUES ($1, $2, 'company_staff', 'active', true, $3, 'Staff') RETURNING id`,
        [email, staffHash, role.replace('_', ' ')],
      );
      await q(
        `INSERT INTO company_memberships ("userId", "companyId", "membershipRole", status, "acceptedAt")
         VALUES ($1, $2, $3, 'active', now())`,
        [id, A, role],
      );
      sessions.push({ role, s: await session(email) });
    }

    const gActive = await registerGuard('active');
    const gInactive = await registerGuard('inactive');
    const gBlocked = await registerGuard('blocked');
    const gApplicant = await registerGuard('applicant');
    const gRejected = await registerGuard('rejected');
    const gOther = await registerGuard('other');
    for (const g of [gActive, gInactive, gBlocked]) await join(owner, g);
    await join(ownerB, gOther);

    const job = await one(
      `INSERT INTO jobs ("companyId", title, "guardsRequired", "hourlyRate", status) VALUES ($1, 'FE job', 3, 15, 'open') RETURNING id`,
      [A],
    );
    for (const g of [gApplicant, gRejected]) {
      const applied = await api('POST', '/job-applications/self', g.token, { jobId: job.id });
      assert.equal(applied.status, 201, errText(applied));
    }
    await q(`UPDATE job_applications SET status = 'under_review' WHERE "guardId" = $1 AND "jobId" = $2`, [gApplicant.guardId, job.id]);
    await q(`UPDATE job_applications SET status = 'rejected' WHERE "guardId" = $1 AND "jobId" = $2`, [gRejected.guardId, job.id]);

    // Records each company created while the relationship was ACTIVE (the history a former employer keeps).
    const NOTE = `EMPLOYMENT-NOTE-${RUN}`;
    type Seeded = { ruleId: number; overrideId: number; leaveId: number; docDone: number; docPending: number; shiftId: number };
    const seeded = new Map<number, Seeded>();
    const seedRecords = async (companyId: number, g: Session) => {
      const guardId = g.guardId!;
      // The guard's own (company-less) availability: current personal data.
      await q(`INSERT INTO guard_availability_rules ("companyId", "guardId", weekday, "startTime", "endTime", "isAvailable") VALUES (NULL, $1, 3, '07:00', '19:00', true)`, [guardId]);
      await q(`INSERT INTO guard_availability_overrides ("companyId", "guardId", date, status, note) VALUES (NULL, $1, '2031-03-03', 'unavailable', 'personal')`, [guardId]);
      // The company's own rows.
      const rule = await one(`INSERT INTO guard_availability_rules ("companyId", "guardId", weekday, "startTime", "endTime", "isAvailable") VALUES ($1, $2, 1, '08:00', '18:00', true) RETURNING id`, [companyId, guardId]);
      const override = await one(`INSERT INTO guard_availability_overrides ("companyId", "guardId", date, status, note) VALUES ($1, $2, '2031-04-04', 'available', 'company') RETURNING id`, [companyId, guardId]);
      const leave = await one(
        `INSERT INTO guard_leave ("companyId", "guardId", "leaveType", "startAt", "endAt", status)
         VALUES ($1, $2, 'annual_leave', now() + interval '10 days', now() + interval '12 days', 'approved') RETURNING id`,
        [companyId, guardId],
      );
      await q(`INSERT INTO compliance_records ("companyId", "guardId", type, "documentName", "expiryDate") VALUES ($1, $2, 'SIA', 'SIA licence', '2031-01-31')`, [companyId, guardId]);
      const doc = (completed: boolean) => one(
        `INSERT INTO guard_documents ("guardId", "companyId", type, "storageProvider", "storageKey", "originalFileName", "mimeType", "sizeBytes", "uploadCompletedAt", verified)
         VALUES ($1, $2, 'sia_licence', 's3-compatible', $3, 'sia.pdf', 'application/pdf', 2048, $4, false) RETURNING id`,
        [guardId, companyId, `compliance/company/${companyId}/${guardId}/${randomUUID()}`, completed ? new Date() : null],
      );
      const docDone = (await doc(true)).id;
      const docPending = (await doc(false)).id;
      const shift = await one(
        `INSERT INTO shifts ("companyId", "guardId", "siteName", start, "end", status)
         VALUES ($1, $2, 'FE Site', now() - interval '30 days', now() - interval '30 days' + interval '8 hours', 'completed') RETURNING id`,
        [companyId, guardId],
      );
      await q(`INSERT INTO timesheets ("shiftId", "guardId", "companyId") VALUES ($1, $2, $3)`, [shift.id, guardId, companyId]);
      await q(`INSERT INTO incidents ("companyId", "guardId", "shiftId", title, notes) VALUES ($1, $2, $3, 'FE incident', 'Synthetic')`, [companyId, guardId, shift.id]);
      seeded.set(guardId, { ruleId: rule.id, overrideId: override.id, leaveId: leave.id, docDone, docPending, shiftId: shift.id });
    };
    for (const g of [gActive, gInactive, gBlocked]) await seedRecords(A, g);
    await seedRecords(B, gOther);
    // A pre-hire evidence document company A holds for each applicant.
    for (const g of [gApplicant, gRejected]) {
      const d = await one(
        `INSERT INTO guard_documents ("guardId", "companyId", type, "storageProvider", "storageKey", "originalFileName", "mimeType", "sizeBytes", "uploadCompletedAt", verified)
         VALUES ($1, $2, 'right_to_work', 's3-compatible', $3, 'rtw.pdf', 'application/pdf', 2048, now(), false) RETURNING id`,
        [g.guardId, A, `compliance/company/${A}/${g.guardId}/${randomUUID()}`],
      );
      await q(`INSERT INTO guard_availability_rules ("companyId", "guardId", weekday, "startTime", "endTime", "isAvailable") VALUES (NULL, $1, 3, '07:00', '19:00', true)`, [g.guardId]);
      seeded.set(g.guardId!, { ruleId: 0, overrideId: 0, leaveId: 0, docDone: d.id, docPending: 0, shiftId: 0 });
    }

    // Employment records created while ACTIVE (through the API, so the internal note is encrypted as in production).
    const employmentBody = {
      engagementType: 'EMPLOYEE', jobRole: 'SECURITY_OFFICER', workingArrangement: 'FULL_TIME',
      startDate: '2026-01-05', payBasis: 'HOURLY', internalNote: NOTE,
    };
    for (const g of [gActive, gInactive, gBlocked]) {
      const created = await api('PATCH', `/guard-personnel/company/guard/${g.guardId}/employment`, owner.token, employmentBody);
      assert.ok(ok2xx(created), `employment created for ${g.guardId}: ${show(created)}`);
    }
    const createdB = await api('PATCH', `/guard-personnel/company/guard/${gOther.guardId}/employment`, ownerB.token, employmentBody);
    assert.ok(ok2xx(createdB), `employment created in company B: ${show(createdB)}`);

    // The relationships end only now: everything above is genuine history.
    assert.equal((await api('PATCH', `/company-guards/${await relationId(A, gInactive.guardId!)}`, owner.token, { status: 'INACTIVE' })).status, 200);
    assert.equal((await api('PATCH', `/company-guards/${await relationId(A, gBlocked.guardId!)}`, owner.token, { status: 'BLOCKED' })).status, 200);
    console.log('PASS SETUP: companies A and B, 7 company roles, ACTIVE/INACTIVE/BLOCKED/applicant/rejected/unrelated guards, history seeded');

    const adminEmail = 'platform.admin@former-employer.test';
    const adminPassword = 'Fe-Access-Admin-1!';
    const operator = new AdminOperatorService(ds);
    const adminCount = Number((await one(`SELECT count(*) n FROM users WHERE role = 'admin'`)).n);
    if (adminCount === 0) {
      await operator.bootstrap(adminEmail, adminPassword);
    } else if (Number((await one(`SELECT count(*) n FROM users WHERE role = 'admin' AND LOWER(email) = $1`, [adminEmail])).n) === 1) {
      await operator.recover(adminEmail, adminPassword, true);
    } else {
      throw new Error('This database already has a Platform Admin this spec did not create; use a disposable database.');
    }
    const adminLogin: any = await auth.login({ email: adminEmail, password: adminPassword });
    const admin: Session = { token: adminLogin.accessToken, userId: adminLogin.user.id };

    const FORMER = [
      { label: 'INACTIVE', g: gInactive },
      { label: 'BLOCKED', g: gBlocked },
    ];
    const rec = (g: Session) => seeded.get(g.guardId!)!;

    // ───────────────────────────── Checks ─────────────────────────────

    await group('CURRENT-AVAILABILITY: a guard\'s own availability reaches a company only while ACTIVE; company rows stay', async (fail) => {
      for (const { role, s } of sessions) {
        for (const kind of ['rules', 'overrides'] as const) {
          const all = await api('GET', `/availability/${kind}`, s.token);
          if (!ok2xx(all)) continue; // a role without shifts.view never sees availability at all
          const rows: any[] = Array.isArray(all.body) ? all.body : [];
          for (const { label, g } of [...FORMER, { label: 'APPLICANT', g: gApplicant }, { label: 'REJECTED', g: gRejected }, { label: 'UNRELATED', g: gOther }]) {
            const personal = rows.filter((r) => r.guard?.id === g.guardId && !r.company);
            if (personal.length) fail(`${role} GET /availability/${kind} returns ${personal.length} personal row(s) of the ${label} guard`);
          }
          for (const { label, g } of FORMER) {
            const scoped = await api('GET', `/availability/${kind}?guardId=${g.guardId}`, s.token);
            if (!ok2xx(scoped)) { fail(`${role} GET /availability/${kind}?guardId=${label}: ${show(scoped)} (company history must stay readable)`); continue; }
            const list: any[] = scoped.body;
            if (list.some((r) => !r.company)) fail(`${role} GET /availability/${kind}?guardId=${label} returns the guard's personal rows`);
            if (!list.some((r) => r.company?.id === A)) fail(`${role} GET /availability/${kind}?guardId=${label} lost the company's own row`);
          }
          if (role === 'owner') {
            const mine = rows.filter((r) => r.guard?.id === gActive.guardId);
            if (!mine.some((r) => !r.company)) fail(`owner GET /availability/${kind}: the ACTIVE guard's personal row is missing (positive control)`);
            if (!mine.some((r) => r.company?.id === A)) fail(`owner GET /availability/${kind}: the ACTIVE guard's company row is missing`);
          }
        }
      }
    });

    // Byte-for-byte fingerprint of every table a refused write could touch.
    const TABLES = [
      'guard_availability_rules', 'guard_availability_overrides', 'guard_leave', 'compliance_records',
      'guard_documents', 'company_guard_employment_records', 'company_guards',
    ];
    const fingerprint = async () => {
      const out: Record<string, string> = {};
      for (const t of TABLES) {
        out[t] = (await one(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x.id)), '') AS f FROM ${t} x`)).f;
      }
      return out;
    };

    type Attempt = { name: string; run: (token: string, g: Session, target: Seeded, companyId: number) => Promise<Res> };
    const ATTEMPTS: Attempt[] = [
      { name: 'POST /availability/rules', run: (t, g) => api('POST', '/availability/rules', t, { guardId: g.guardId, weekday: 2, startTime: '09:00', endTime: '17:00', isAvailable: false }) },
      { name: 'PUT /availability/rules', run: (t, g, r) => api('PUT', '/availability/rules', t, { id: r.ruleId, guardId: g.guardId, weekday: 1, startTime: '06:00', endTime: '07:00', isAvailable: false }) },
      { name: 'POST /availability/overrides', run: (t, g) => api('POST', '/availability/overrides', t, { guardId: g.guardId, date: '2031-05-05', status: 'unavailable' }) },
      { name: 'PUT /availability/overrides', run: (t, g, r) => api('PUT', '/availability/overrides', t, { id: r.overrideId, guardId: g.guardId, date: '2031-04-04', status: 'unavailable' }) },
      { name: 'POST /leave', run: (t, g) => api('POST', '/leave', t, { guardId: g.guardId, leaveType: 'sick', startAt: '2031-06-01T09:00:00Z', endAt: '2031-06-02T09:00:00Z' }) },
      { name: 'PUT /leave', run: (t, g, r) => api('PUT', '/leave', t, { id: r.leaveId, guardId: g.guardId, leaveType: 'sick', startAt: '2031-06-01T09:00:00Z', endAt: '2031-06-02T09:00:00Z', status: 'rejected' }) },
      { name: 'POST /compliance', run: (t, g) => api('POST', '/compliance', t, { guardId: g.guardId, type: 'TRAINING', documentName: 'First aid', expiryDate: '2031-01-01' }) },
      { name: 'PUT /compliance', run: (t, g) => api('PUT', '/compliance', t, { guardId: g.guardId, type: 'SIA', documentName: 'Edited SIA', expiryDate: '2032-01-01' }) },
      { name: 'POST /compliance/documents', run: (t, g) => api('POST', '/compliance/documents', t, { guardId: g.guardId, type: 'training', originalFileName: 'training.pdf', mimeType: 'application/pdf', sizeBytes: 1000 }) },
      { name: 'PATCH /compliance/documents/:id/verify', run: (t, _g, r) => api('PATCH', `/compliance/documents/${r.docDone}/verify`, t, { verified: true }) },
      { name: 'POST /compliance/documents/:id/complete-upload', run: (t, _g, r) => api('POST', `/compliance/documents/${r.docPending}/complete-upload`, t) },
      { name: 'PATCH employment', run: (t, g) => api('PATCH', `/guard-personnel/company/guard/${g.guardId}/employment`, t, { endDate: '2030-12-31', internalNote: 'changed after the relationship ended' }) },
    ];

    const before = await fingerprint();
    const refusals = new Map<string, Res>(); // role|attempt|case → response
    await group('WRITES-DENIED: no company role can create or change records for INACTIVE, BLOCKED, rejected or unrelated guards', async (fail) => {
      for (const { role, s } of sessions) {
        for (const a of ATTEMPTS) {
          for (const { label, g } of [...FORMER, { label: 'UNRELATED', g: gOther }]) {
            const res = await a.run(s.token, g, rec(g), A);
            refusals.set(`${role}|${a.name}|${label}`, res);
            if (ok2xx(res)) fail(`${role} ${a.name} for the ${label} guard succeeded (${res.status})`);
            if (res.status >= 500) fail(`${role} ${a.name} for the ${label} guard: server error ${show(res)}`);
          }
        }
        for (const name of ['POST /availability/rules', 'POST /availability/overrides', 'POST /leave', 'POST /compliance', 'POST /compliance/documents']) {
          const a = ATTEMPTS.find((x) => x.name === name)!;
          const res = await a.run(s.token, gRejected, rec(gRejected), A);
          if (ok2xx(res)) fail(`${role} ${name} for the REJECTED applicant succeeded (${res.status})`);
        }
      }
    });

    await group('SAME-REFUSAL: a former guard is refused exactly as an unrelated guard (status and message)', (fail) => {
      for (const { role } of sessions) {
        for (const a of ATTEMPTS) {
          const unrelated = refusals.get(`${role}|${a.name}|UNRELATED`);
          for (const { label } of FORMER) {
            const former = refusals.get(`${role}|${a.name}|${label}`);
            if (!former || !unrelated) continue;
            if (former.status !== unrelated.status || errText(former) !== errText(unrelated)) {
              fail(`${role} ${a.name}: ${label} → ${show(former)} but unrelated → ${show(unrelated)}`);
            }
          }
        }
      }
    });

    await group('NO-CHANGE: refused writes leave every guard-related table unchanged', async (fail) => {
      const after = await fingerprint();
      for (const t of TABLES) if (before[t] !== after[t]) fail(`${t} changed during refused writes`);
    });

    await group('EVIDENCE: download links only for ACTIVE guards and eligible pre-hire applicants', async (fail) => {
      const cases = [
        { label: 'INACTIVE', doc: rec(gInactive).docDone, allowed: false },
        { label: 'BLOCKED', doc: rec(gBlocked).docDone, allowed: false },
        { label: 'REJECTED applicant', doc: rec(gRejected).docDone, allowed: false },
        { label: 'UNRELATED (company B)', doc: rec(gOther).docDone, allowed: false },
        { label: 'ACTIVE', doc: rec(gActive).docDone, allowed: true },
        { label: 'APPLICANT under review', doc: rec(gApplicant).docDone, allowed: true },
      ];
      const managers = new Set(['owner', 'admin', 'hr_compliance']);
      for (const { role, s } of sessions) {
        const responses = new Map<string, Res>();
        for (const c of cases) {
          const res = await api('GET', `/compliance/documents/${c.doc}/access`, s.token);
          responses.set(c.label, res);
          if (!c.allowed && ok2xx(res)) fail(`${role} obtained evidence for the ${c.label} guard`);
          if (c.allowed && managers.has(role) && (!ok2xx(res) || !res.body?.url)) fail(`${role} could not obtain evidence for the ${c.label} guard: ${show(res)} (positive control)`);
        }
        const unrelated = responses.get('UNRELATED (company B)')!;
        for (const label of ['INACTIVE', 'BLOCKED', 'REJECTED applicant']) {
          const r = responses.get(label)!;
          if (r.status !== unrelated.status || errText(r) !== errText(unrelated)) fail(`${role} evidence ${label} → ${show(r)} but unrelated → ${show(unrelated)}`);
        }
      }
      const adminRes = await api('GET', `/compliance/documents/${rec(gInactive).docDone}/access`, admin.token);
      if (!ok2xx(adminRes) || !adminRes.body?.url) fail(`Platform Admin evidence access changed: ${show(adminRes)}`);
    });

    await group('DASHBOARDS: live compliance and screening status lists contain ACTIVE guards only', async (fail) => {
      for (const { role, s } of sessions) {
        for (const route of ['/compliance/statuses', '/screening/company/outcomes']) {
          const res = await api('GET', route, s.token);
          if (!ok2xx(res)) continue; // role lacks compliance.view / screening.view
          const ids = new Set((res.body as any[]).map((r) => r.guardId));
          for (const { label, g } of [...FORMER, { label: 'UNRELATED', g: gOther }]) {
            if (ids.has(g.guardId)) fail(`${role} GET ${route} lists the ${label} guard`);
          }
          if (!ids.has(gActive.guardId)) fail(`${role} GET ${route} is missing the ACTIVE guard (positive control)`);
        }
      }
    });

    await group('HISTORY: the company still reads its own records about former guards', async (fail) => {
      const expectIncludes = async (path: string, guardId: number, pick: (row: any) => number | undefined = (r) => r.guard?.id) => {
        const res = await api('GET', path, owner.token);
        if (!ok2xx(res)) return fail(`owner GET ${path}: ${show(res)}`);
        const rows: any[] = Array.isArray(res.body) ? res.body : res.body?.items ?? res.body?.data ?? [];
        if (!rows.some((r) => pick(r) === guardId)) fail(`owner GET ${path} no longer includes guard ${guardId}`);
      };
      for (const { g } of FORMER) {
        await expectIncludes('/leave', g.guardId!);
        await expectIncludes('/compliance', g.guardId!);
        await expectIncludes(`/compliance/documents?guardId=${g.guardId}`, g.guardId!);
        await expectIncludes('/shifts', g.guardId!);
        await expectIncludes('/timesheets/company', g.guardId!);
        await expectIncludes('/incidents/company', g.guardId!);
        const checks = await api('GET', `/compliance/checks?guardId=${g.guardId}`, owner.token);
        if (!ok2xx(checks)) fail(`owner GET /compliance/checks for a former guard: ${show(checks)}`);
        const employment = await api('GET', `/guard-personnel/company/guard/${g.guardId}/employment`, owner.token);
        if (!ok2xx(employment)) fail(`owner GET employment for a former guard: ${show(employment)}`);
        else if (employment.body?.internalNote !== NOTE || employment.body?.endDate) fail(`former guard employment record changed: ${JSON.stringify(employment.body)}`);
      }
    });

    await group('ACTIVE / PRE-HIRE: the same writes still work for an ACTIVE guard and an applicant under review', async (fail) => {
      const r = rec(gActive);
      for (const a of ATTEMPTS) {
        if (a.name.includes('complete-upload')) continue; // needs real storage; covered for the completed document below
        const res = await a.run(owner.token, gActive, r, A);
        if (!ok2xx(res)) fail(`owner ${a.name} for the ACTIVE guard: ${show(res)}`);
      }
      const done = await api('POST', `/compliance/documents/${r.docDone}/complete-upload`, owner.token);
      if (!ok2xx(done)) fail(`owner complete-upload of a completed ACTIVE document: ${show(done)}`);
      const upload = await api('POST', '/compliance/documents', owner.token, { guardId: gApplicant.guardId, type: 'training', originalFileName: 'training.pdf', mimeType: 'application/pdf', sizeBytes: 1000 });
      if (!ok2xx(upload)) fail(`owner pre-hire document upload for the applicant: ${show(upload)}`);
      const record = await api('POST', '/compliance', owner.token, { guardId: gApplicant.guardId, type: 'TRAINING', documentName: 'Pre-hire', expiryDate: '2031-01-01' });
      if (!ok2xx(record)) fail(`owner pre-hire compliance record for the applicant: ${show(record)}`);
      const verify = await api('PATCH', `/compliance/documents/${rec(gApplicant).docDone}/verify`, owner.token, { verified: true });
      if (!ok2xx(verify)) fail(`owner pre-hire verification for the applicant: ${show(verify)}`);
    });

    await group('GUARD-OWNED: guards keep their own availability, leave and profile', async (fail) => {
      for (const g of [gActive, gInactive, gBlocked]) {
        const rules = await api('GET', '/availability/mine/rules', g.token);
        if (!ok2xx(rules) || !(rules.body as any[]).some((row) => row.weekday === 3)) fail(`guard ${g.guardId} own rules: ${show(rules)}`);
        const me = await api('GET', '/guards/me', g.token);
        if (!ok2xx(me)) fail(`guard ${g.guardId} GET /guards/me: ${show(me)}`);
        const leave = await api('GET', '/leave/mine', g.token);
        if (!ok2xx(leave)) fail(`guard ${g.guardId} GET /leave/mine: ${show(leave)}`);
        const docs = await api('GET', '/compliance/documents/mine', g.token);
        if (!ok2xx(docs)) fail(`guard ${g.guardId} GET /compliance/documents/mine: ${show(docs)}`);
      }
    });
  } finally {
    await app.close();
  }

  console.log(`\n${groupsPassed} group(s) passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`FAILED: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ event: 'former_employer_access_tests_passed', groups: groupsPassed }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
