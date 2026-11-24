/**
 * S4-EM-01 staging seed — the fictional accounts for the physical-device Emergency test. Staging only, never production.
 *
 * Owner approval (24 Nov 2026): "Creating clearly labelled synthetic staging companies, Guards and Control Room accounts."
 *
 * Adds, beside the existing staging data and touching none of it:
 *   - EM01 SYNTHETIC Responders Ltd (approved): Owner, a Control Room member, a client, one site (no GPS rule) and a
 *     Guard who joined through the product's invitation, with fictional SIA / Right to Work checks and documents, and
 *     one shift that is accepted and booked on (in progress) for the test.
 *   - EM01 SYNTHETIC Decoy Ltd (approved): Owner and a Control Room member, the cross-company isolation witnesses.
 *
 * Everything goes through the application's own services and routes, in this process, against the staging database,
 * except the two Control Room memberships: the product has no route that adds company staff, so those two users and
 * memberships are inserted directly (bcrypt hash, status active, email verified), exactly as the specs do.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/staging-em01-seed.ts --dry-run
 *   S4_STAGING_EM01_CONFIRM=s4-staging-em01 npx ts-node -r tsconfig-paths/register scripts/staging-em01-seed.ts
 *   npx ts-node -r tsconfig-paths/register scripts/staging-em01-seed.ts --new-shift   (another booked-on shift later)
 *
 * Guards: the database host must be s4-staging-db's (and differ from production-read.env's host), database s4_staging,
 * strict TLS with the staging CA, the ledger must equal this repository's migrations, and none of the EM01 emails may
 * exist yet (except with --new-shift). Logins go to ~/.s4-pilot-secrets/staging-em01.env only; nothing secret is printed.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg') as { Client: new (config: object) => any };

const STAGING_HOST = 'dpg-dbbq13afngtc73a5ls20-a.oregon-postgres.render.com';
const STAGING_DB = 's4_staging';
const STAGING_API = 'https://security-marketplace-api-staging.onrender.com';
const CONFIRM = 's4-staging-em01';
const SECRETS = path.join(os.homedir(), '.s4-pilot-secrets');
const LOGINS = path.join(SECRETS, 'staging-em01.env');
const PLATFORM_ADMIN_EMAIL = 'uat-s4-admin@example.com';
const TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const newShift = args.includes('--new-shift');

const EMAILS = {
  owner: 'em01-owner@example.com',
  controlRoom: 'em01-control-room@example.com',
  guard: 'em01-guard@example.com',
  decoyOwner: 'em01-decoy-owner@example.com',
  decoyControlRoom: 'em01-decoy-control-room@example.com',
};
const COMPANY = { companyName: 'EM01 SYNTHETIC Responders Ltd', companyNumber: '99000101', address: 'Unit 101, Example Park, Testtown, ZZ99 9ZZ', contactDetails: 'em01-ops@example.com' };
const DECOY = { companyName: 'EM01 SYNTHETIC Decoy Ltd', companyNumber: '99000102', address: 'Unit 102, Example Park, Testtown, ZZ99 9ZZ', contactDetails: 'em01-decoy-ops@example.com' };
const CLIENT = { name: 'EM01 SYNTHETIC Client', contactName: 'EM01 Client Contact', contactEmail: 'em01-client@example.com', contactPhone: '01632960101' };
const SITE = { name: 'EM01 SYNTHETIC Site — Unit 101, Example Park', address: 'Unit 101, Example Park, Testtown, ZZ99 9ZZ', timezone: 'Europe/London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false };
const GUARD = { fullName: 'EM01 Synthetic Guard', sia: '9900000000000101' };

const secrets: string[] = [];
const registerSecret = (v: string | null | undefined) => { if (v && v.length >= 6) secrets.push(v); };
const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text).replace(/postgres(ql)?:\/\/[^\s@]*@/g, 'postgresql://[redacted]@');
const log = (...parts: unknown[]) => console.log(redact(parts.map(String).join(' ')));
function fail(message: string): never {
  console.error(redact(`REFUSED: ${message}`));
  process.exit(2);
}
function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
function writeLogins(values: Record<string, string>) {
  const existing = fs.existsSync(LOGINS) ? readEnv(LOGINS) : {};
  const merged = { ...existing, ...values };
  fs.writeFileSync(LOGINS, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
}
const password = () => { const p = `${randomBytes(12).toString('base64url')}Aa1!`; registerSecret(p); return p; };

function fictionalPdf(title: string, holder: string, reference: string): Buffer {
  const lines = ['FICTIONAL TEST DOCUMENT - S4 STAGING EM01 ONLY', title, `Holder: ${holder} (fictional test person)`, `Reference: ${reference} (test value)`, 'NOT a real licence or right to work record.'];
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = ['BT', '/F1 14 Tf', '50 780 Td', '18 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function target() {
  const url = readEnv(path.join(SECRETS, 'staging-db.env')).S4_STAGING_DB_URL;
  const staging = readEnv(path.join(SECRETS, 'staging-render.env'));
  if (!url) fail('S4_STAGING_DB_URL missing');
  registerSecret(url);
  const u = new URL(url);
  if (u.hostname !== STAGING_HOST || u.pathname !== `/${STAGING_DB}` || u.search) fail(`not s4-staging-db (host ${u.hostname})`);
  if (/supabase|pooler/i.test(u.hostname)) fail('Supabase / pooler host');
  const prodFile = path.join(SECRETS, 'production-read.env');
  if (fs.existsSync(prodFile)) {
    const prod = readEnv(prodFile).S4_PROD_READ_URL;
    if (prod && new URL(prod).hostname === u.hostname) fail('target host equals the production database host');
  }
  const ca = (staging.DATABASE_CA_CERT ?? '').replace(/\\n/g, '\n');
  if (!ca.startsWith('-----BEGIN CERTIFICATE-----')) fail('staging DATABASE_CA_CERT missing');
  for (const v of Object.values(staging)) registerSecret(v);
  return {
    url,
    ssl: { rejectUnauthorized: true, ca },
    appEnv: {
      DATABASE_SSL: 'true', DATABASE_CA_CERT: staging.DATABASE_CA_CERT, JWT_SECRET: staging.JWT_SECRET,
      GUARD_DATA_ENCRYPTION_KEY: staging.GUARD_DATA_ENCRYPTION_KEY, GUARD_DATA_HMAC_KEY: staging.GUARD_DATA_HMAC_KEY,
      EVIDENCE_STORAGE_ENDPOINT: staging.EVIDENCE_STORAGE_ENDPOINT, EVIDENCE_STORAGE_REGION: staging.EVIDENCE_STORAGE_REGION,
      EVIDENCE_STORAGE_BUCKET: staging.EVIDENCE_STORAGE_BUCKET, EVIDENCE_STORAGE_ACCESS_KEY_ID: staging.EVIDENCE_STORAGE_ACCESS_KEY_ID,
      EVIDENCE_STORAGE_SECRET_ACCESS_KEY: staging.EVIDENCE_STORAGE_SECRET_ACCESS_KEY,
      EVIDENCE_SIGNED_URL_TTL_SECONDS: staging.EVIDENCE_SIGNED_URL_TTL_SECONDS || '180',
    },
  };
}
type Target = ReturnType<typeof target>;

async function preflight(t: Target) {
  const dir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+-.*\.ts$/.test(f)).sort();
  const last = /export class (\w+)/.exec(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'))?.[1];
  const c = new Client({ connectionString: t.url, ssl: t.ssl });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const ledger = (await c.query(`select count(*)::int n, (select name from typeorm_migrations order by id desc limit 1) last from typeorm_migrations`)).rows[0];
    if (ledger.n !== files.length || ledger.last !== last) fail(`ledger ${ledger.n}/${ledger.last} differs from this code's ${files.length}/${last}`);
    const existing = (await c.query(`select email from users where lower(email) = any($1)`, [Object.values(EMAILS)])).rows.map((r: any) => r.email);
    const admin = (await c.query(`select count(*)::int n from users where lower(email) = $1 and role = 'admin' and status = 'active'`, [PLATFORM_ADMIN_EMAIL])).rows[0].n;
    const totals = (await c.query(`select (select count(*)::int from users) u, (select count(*)::int from companies) c`)).rows[0];
    await c.query('ROLLBACK');
    if (admin !== 1) fail('the staging platform administrator is missing');
    if (newShift ? existing.length !== Object.keys(EMAILS).length : existing.length) {
      fail(newShift ? 'the EM01 accounts are not all present; seed first' : `EM01 accounts already exist (${existing.join(', ')})`);
    }
    log(`preflight OK: ${STAGING_HOST}/${STAGING_DB}, ${ledger.n} migrations (= this code), ${totals.u} users, ${totals.c} companies, platform admin present`);
  } finally {
    await c.end();
  }
}

async function bootApp(t: Target) {
  Object.assign(process.env, {
    NODE_ENV: 'test', TZ: 'UTC', DATABASE_URL: t.url, DATABASE_POOLER_URL: '', DATABASE_SYNCHRONIZE: 'false',
    RESEND_API_KEY: '', EMAIL_FROM: '', SENTRY_DSN: '', CORS_ORIGIN: 'http://127.0.0.1', PUSH_EMERGENCY_ALERTS_ENABLED: 'false', ...t.appEnv,
  });
  const { NestFactory } = await import('@nestjs/core');
  const { ValidationPipe } = await import('@nestjs/common');
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // This process runs no background job against staging: only the deployed service does.
  const stop = async (p: string, name: string) => { const mod = await import(p); const svc: any = app.get(mod[name]); svc.onModuleDestroy?.(); };
  await stop('../src/safety-alert/safety-alert.service', 'SafetyAlertService');
  await stop('../src/safety-alert/emergency-push.service', 'EmergencyPushService');
  await stop('../src/welfare-push/welfare-push.service', 'WelfarePushService');
  await stop('../src/patrol/patrol-sweep.service', 'PatrolSweepService');
  await stop('../src/patrol/evidence/patrol-evidence-maintenance.service', 'PatrolEvidenceMaintenanceService');
  const { AutomationSchedulerService } = await import('../src/scheduler/scheduler.service');
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  for (const svc of [app.get(AutomationSchedulerService) as any, app.get(ShiftAmendmentService) as any]) {
    for (const k of ['dailyInterval', 'weeklyInterval', 'expiryInterval']) if (svc[k]) clearInterval(svc[k]);
    svc.expiryJob?.stop?.();
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  return app;
}

async function main() {
  const t = target();
  if (!dryRun && !newShift && process.env.S4_STAGING_EM01_CONFIRM !== CONFIRM) fail(`set S4_STAGING_EM01_CONFIRM=${CONFIRM} to write to staging`);
  await preflight(t);
  if (dryRun) { log('DRY RUN: nothing written.'); return; }

  const app = await bootApp(t);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call = async (root: string, method: string, route: string, token: string | null, body?: unknown) => {
    const res = await fetch(root + route, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json?.message ?? '')}`);
    return json;
  };
  const api = (m: string, r: string, tok: string | null, b?: unknown) => call(base, m, r, tok, b);
  const live = (m: string, r: string, tok: string | null, b?: unknown) => call(STAGING_API, m, r, tok, b);
  const { DataSource } = await import('typeorm');
  const ds = app.get(DataSource);
  const { AuthService } = await import('../src/auth/auth.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
  const { CompanyVerificationService } = await import('../src/company/verification/company-verification.service');
  const auth: any = app.get(AuthService);
  const signIn = async (email: string, pass: string) => { const r = await auth.login({ email, password: pass }); registerSecret(r.accessToken); return r; };
  const verify = async (email: string) => {
    const message: any = [...app.get(TransactionalEmailService).capturedMessages()].reverse().find((m: any) => m.kind === 'email_verification' && m.to === email);
    const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    if (!token) throw new Error(`verification email for ${email} not captured`);
    registerSecret(token);
    await app.get(AccountRecoveryService).verifyEmail(token);
  };
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  try {
    if (newShift) {
      const logins = readEnv(LOGINS);
      for (const v of Object.values(logins)) registerSecret(v);
      const owner = await signIn(EMAILS.owner, logins.EM01_OWNER_PASSWORD);
      const guard = await signIn(EMAILS.guard, logins.EM01_GUARD_PASSWORD);
      const [site] = await ds.query(`select id from sites where "companyId" = $1 order by id limit 1`, [owner.user.companyId]);
      await bookedOnShift(api, owner.accessToken, guard.accessToken, Number(site.id), guard.user.guardId);
      return;
    }

    const [{ id: adminId }] = await ds.query(`select id from users where lower(email) = $1 and role = 'admin'`, [PLATFORM_ADMIN_EMAIL]);
    const approve = async (companyId: number) => {
      const decided = await app.get(CompanyVerificationService).decide({ sub: Number(adminId), role: 'admin' } as any, companyId, 'approved' as any, null);
      if (decided.verificationStatus !== 'approved') throw new Error(`company ${companyId} not approved`);
    };
    const registerOwner = async (email: string, key: string, company: typeof COMPANY, fullName: string) => {
      const pass = password();
      await auth.register({ email, password: pass, role: 'company', fullName, phone: '01632960100', ...company });
      writeLogins({ [`${key}_EMAIL`]: email, [`${key}_PASSWORD`]: pass });
      await verify(email);
      const r = await signIn(email, pass);
      await approve(Number(r.user.companyId));
      return { token: r.accessToken as string, companyId: Number(r.user.companyId) };
    };
    // No product route adds company staff: inserted as the specs do (bcrypt hash, active, verified), in one transaction.
    const addControlRoom = async (email: string, key: string, companyId: number, firstName: string) => {
      const bcrypt = await import('bcrypt');
      const pass = password();
      const hash = await bcrypt.hash(pass, 12);
      await ds.transaction(async (m) => {
        const [{ id }] = await m.query(
          `insert into users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName") values ($1,$2,'company_staff','active',true,false,$3,'(EM01 synthetic)') returning id`,
          [email, hash, firstName],
        );
        await m.query(`insert into company_memberships ("userId","companyId","membershipRole",status) values ($1,$2,'control_room','active')`, [id, companyId]);
      });
      writeLogins({ [`${key}_EMAIL`]: email, [`${key}_PASSWORD`]: pass });
      const r = await signIn(email, pass);
      return Number(r.user.id);
    };

    const owner = await registerOwner(EMAILS.owner, 'EM01_OWNER', COMPANY, 'EM01 Synthetic Owner');
    log(`company ${owner.companyId} "${COMPANY.companyName}" registered, email verified, approved`);
    const crId = await addControlRoom(EMAILS.controlRoom, 'EM01_CONTROL_ROOM', owner.companyId, 'EM01 Control Room');
    log(`control room user ${crId} added to company ${owner.companyId}`);

    const client = await api('POST', '/clients', owner.token, CLIENT);
    const site = await api('POST', '/sites', owner.token, { ...SITE, clientId: client.id });

    const gPass = password();
    await auth.register({ email: EMAILS.guard, password: gPass, role: 'guard', fullName: GUARD.fullName, phone: '07700900101', siaLicenseNumber: GUARD.sia });
    writeLogins({ EM01_GUARD_EMAIL: EMAILS.guard, EM01_GUARD_PASSWORD: gPass });
    await verify(EMAILS.guard);
    const guard = await signIn(EMAILS.guard, gPass);
    const invitation = await api('POST', '/company-guards/invitations', owner.token, {});
    registerSecret(invitation?.code);
    await api('POST', '/guards/me/invitations/accept', guard.accessToken, { code: invitation.code });
    const guardId = Number(guard.user.guardId);
    await api('POST', '/compliance/checks', owner.token, { guardId, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', licenceNumber: GUARD.sia, checkDate: day(0), expiryDate: day(365), checkedByName: 'EM01 Checker', evidenceReference: 'EM01 test record — not a real check' });
    await api('POST', '/compliance/checks', owner.token, { guardId, kind: 'right_to_work', outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'continuous', checkDate: day(0), checkedByName: 'EM01 Checker', evidenceReference: 'EM01 test record — not a real check' });
    for (const doc of [
      { type: 'sia_licence', title: 'FICTIONAL SIA LICENCE (TEST)', file: 'EM01-FICTIONAL-SIA-LICENCE-NOT-REAL.pdf', reference: GUARD.sia, expiryDate: day(365) },
      { type: 'right_to_work', title: 'FICTIONAL RIGHT TO WORK RECORD (TEST)', file: 'EM01-FICTIONAL-RIGHT-TO-WORK-NOT-REAL.pdf', reference: 'EM01-RTW-TEST', expiryDate: null },
    ]) {
      const pdf = fictionalPdf(doc.title, GUARD.fullName, doc.reference);
      const created = await live('POST', '/compliance/documents', owner.token, { guardId, type: doc.type, originalFileName: doc.file, mimeType: 'application/pdf', sizeBytes: pdf.length, expiryDate: doc.expiryDate });
      if (!created?.upload?.url || created.upload.method !== 'PUT') throw new Error('no presigned upload returned');
      registerSecret(created.upload.url);
      const put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers ?? { 'Content-Type': 'application/pdf' }, body: new Uint8Array(pdf), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!put.ok) throw new Error(`evidence PUT refused (${put.status})`);
      await live('POST', `/compliance/documents/${created.id}/complete-upload`, owner.token);
      await live('PATCH', `/compliance/documents/${created.id}/verify`, owner.token, { verified: true });
    }
    log(`guard ${guardId} joined company ${owner.companyId} by invitation; fictional SIA and Right to Work checks and documents verified`);
    await bookedOnShift(api, owner.token, guard.accessToken, Number(site.id), guardId);

    const decoy = await registerOwner(EMAILS.decoyOwner, 'EM01_DECOY_OWNER', DECOY, 'EM01 Decoy Owner');
    const decoyCr = await addControlRoom(EMAILS.decoyControlRoom, 'EM01_DECOY_CONTROL_ROOM', decoy.companyId, 'EM01 Decoy Control Room');
    log(`decoy company ${decoy.companyId} "${DECOY.companyName}" approved, control room user ${decoyCr}`);

    // Proof on the DEPLOYED staging API: every EM01 login signs in there.
    const logins = readEnv(LOGINS);
    for (const key of ['EM01_OWNER', 'EM01_CONTROL_ROOM', 'EM01_GUARD', 'EM01_DECOY_OWNER', 'EM01_DECOY_CONTROL_ROOM']) {
      const r = await live('POST', '/auth/login', null, { email: logins[`${key}_EMAIL`], password: logins[`${key}_PASSWORD`] });
      registerSecret(r?.accessToken);
      if (!r?.accessToken) throw new Error(`${key} cannot sign in to the deployed staging API`);
    }
    log('all five EM01 logins sign in to the deployed staging API');
    log(`logins written to ${LOGINS} (not printed)`);
  } finally {
    await app.close();
  }
}

/** One shift, now until 23:00 London tomorrow at the latest 20 h, accepted by the Guard and booked on: Emergency is live. */
async function bookedOnShift(api: (m: string, r: string, t: string | null, b?: unknown) => Promise<any>, ownerToken: string, guardToken: string, siteId: number, guardId: number) {
  const start = new Date(Date.now() - 5 * 60_000).toISOString();
  const end = new Date(Date.now() + 20 * 3_600_000).toISOString();
  const created = await api('POST', '/shifts', ownerToken, { siteId, guardId, start, end, checkCallIntervalMinutes: 60, instructions: 'EM01 SYNTHETIC: physical-device Emergency test. Fictional.' });
  const shift = created?.shift ?? created;
  if (!shift?.id) throw new Error('no shift id returned');
  await api('PATCH', `/shifts/${shift.id}/respond`, guardToken, { response: 'accepted' });
  await api('POST', '/attendance/check-in', guardToken, { shiftId: shift.id });
  const status = (await api('GET', `/shifts/${shift.id}`, guardToken))?.status;
  log(`shift ${shift.id}: ${start} to ${end}, status ${status}`);
  if (status !== 'in_progress') throw new Error(`shift ${shift.id} is ${status}, not in_progress`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(redact(`FAILED ${e?.stack ?? e?.message ?? e}`)); process.exit(1); });
