/**
 * S4 staging UAT seeder — fictional data for device UAT on the isolated staging API. Never production.
 *
 * It starts the real backend IN-PROCESS against the target database and creates everything through the
 * application's own services and HTTP routes (registration, email verification via the in-process outbox,
 * clients, sites, workforce links, company compliance checks, shift offers, acceptance, Book On), so the data
 * is exactly what the product would have created. The in-process scheduled jobs are stopped before anything is
 * written; the deployed staging service runs its own.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/staging-uat-seed.ts --target staging --dry-run
 *   S4_STAGING_SEED_CONFIRM=s4-staging-db npx ts-node -r tsconfig-paths/register scripts/staging-uat-seed.ts --target staging
 *   S4_SEED_LOCAL_DATABASE_URL=postgresql://user@127.0.0.1:5432/db npx ts-node ... --target local
 *
 * Guards (all must pass, or nothing is written):
 *   - staging: the database host must be exactly s4-staging-db's external host and the database s4_staging;
 *     it must differ from the production database host in production-read.env; strict TLS with the staging CA;
 *     S4_STAGING_SEED_CONFIRM must equal "s4-staging-db".
 *   - local: the host must be 127.0.0.1 / localhost.
 *   - any target: no Supabase or pooler host; the migration ledger must hold exactly 63 entries ending in
 *     AddComplianceLapseAlerts1720900000009; the users table must be EMPTY (seed once; reset to re-seed).
 * Logins are written only to a git-ignored file (~/.s4-pilot-secrets/staging-uat.env for staging) and are never
 * printed. Output is ids and counts only.
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
const CONFIRM = 's4-staging-db';
const EXPECTED_MIGRATIONS = 63;
const LAST_MIGRATION = 'AddComplianceLapseAlerts1720900000009';
const SECRETS = path.join(os.homedir(), '.s4-pilot-secrets');

const args = process.argv.slice(2);
const target = args[args.indexOf('--target') + 1];
const dryRun = args.includes('--dry-run');

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

type Target = { url: string; ssl: false | { rejectUnauthorized: true; ca: string }; appEnv: Record<string, string>; loginsFile: string };

function resolveTarget(): Target {
  if (target === 'staging') {
    const url = readEnvFile(path.join(SECRETS, 'staging-db.env')).S4_STAGING_DB_URL;
    const staging = readEnvFile(path.join(SECRETS, 'staging-render.env'));
    if (!url) fail('S4_STAGING_DB_URL missing');
    const u = new URL(url);
    if (u.hostname !== STAGING_HOST || u.pathname !== `/${STAGING_DB}` || u.search) fail(`not s4-staging-db (host ${u.hostname})`);
    const prodFile = path.join(SECRETS, 'production-read.env');
    if (fs.existsSync(prodFile)) {
      const prod = readEnvFile(prodFile).S4_PROD_READ_URL;
      if (prod && new URL(prod).hostname === u.hostname) fail('target host equals the production database host');
    }
    const ca = (staging.DATABASE_CA_CERT ?? '').replace(/\\n/g, '\n');
    if (!ca.startsWith('-----BEGIN CERTIFICATE-----')) fail('staging DATABASE_CA_CERT missing');
    return {
      url,
      ssl: { rejectUnauthorized: true, ca },
      // The staging service's own keys, so everything written here is readable by the deployed staging API.
      appEnv: {
        DATABASE_SSL: 'true',
        DATABASE_CA_CERT: staging.DATABASE_CA_CERT,
        JWT_SECRET: staging.JWT_SECRET,
        GUARD_DATA_ENCRYPTION_KEY: staging.GUARD_DATA_ENCRYPTION_KEY,
        GUARD_DATA_HMAC_KEY: staging.GUARD_DATA_HMAC_KEY,
        // The staging bucket's own key, exactly as configured on the staging service.
        EVIDENCE_STORAGE_ENDPOINT: staging.EVIDENCE_STORAGE_ENDPOINT,
        EVIDENCE_STORAGE_REGION: staging.EVIDENCE_STORAGE_REGION,
        EVIDENCE_STORAGE_BUCKET: staging.EVIDENCE_STORAGE_BUCKET,
        EVIDENCE_STORAGE_ACCESS_KEY_ID: staging.EVIDENCE_STORAGE_ACCESS_KEY_ID,
        EVIDENCE_STORAGE_SECRET_ACCESS_KEY: staging.EVIDENCE_STORAGE_SECRET_ACCESS_KEY,
        EVIDENCE_SIGNED_URL_TTL_SECONDS: staging.EVIDENCE_SIGNED_URL_TTL_SECONDS || '180',
      },
      loginsFile: path.join(SECRETS, 'staging-uat.env'),
    };
  }
  if (target === 'local') {
    const url = process.env.S4_SEED_LOCAL_DATABASE_URL ?? '';
    if (!url) fail('S4_SEED_LOCAL_DATABASE_URL missing');
    const host = new URL(url).hostname;
    if (!['127.0.0.1', 'localhost'].includes(host)) fail(`local target must be 127.0.0.1/localhost, got ${host}`);
    const hex = () => randomBytes(32).toString('hex');
    return {
      url,
      ssl: false,
      appEnv: { DATABASE_SSL: 'false', JWT_SECRET: randomBytes(48).toString('base64url'), GUARD_DATA_ENCRYPTION_KEY: hex(), GUARD_DATA_HMAC_KEY: hex() },
      loginsFile: path.join(os.tmpdir(), `s4-uat-local-logins-${Date.now()}.env`),
    };
  }
  return fail('use --target staging or --target local');
}

// ─── the fictional dataset, relative to the moment of seeding ───────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

/** An instant for a London wall-clock time `days` from today, with the correct BST/GMT offset. */
function londonInstant(days: number, hhmm: string): string {
  const day = new Date(Date.now() + days * 24 * HOUR);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
  for (const offset of ['+01:00', '+00:00']) {
    const candidate = `${ymd}T${hhmm}:00${offset}`;
    const back = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(candidate));
    if (back === hhmm) return candidate;
  }
  throw new Error(`no London offset for ${ymd} ${hhmm}`);
}
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

const PEOPLE = {
  owner: { email: 'uat-owner@example.com', fullName: 'UAT Test Owner' },
  alpha: { email: 'uat-guard-a@example.com', fullName: 'Test Guard Alpha', sia: '9900000000000001' },
  bravo: { email: 'uat-guard-b@example.com', fullName: 'Test Guard Bravo', sia: '9900000000000002' },
};
const COMPANY = { companyName: 'UAT Test Security Ltd', companyNumber: '99000001', address: 'Unit 1, Example Park, Testtown, ZZ99 9ZZ', contactDetails: 'uat-ops@example.com' };
const CLIENT = { name: 'UAT Example Client', contactName: 'UAT Client Contact', contactEmail: 'uat-client-contact@example.com', contactPhone: '01632960000' };
const SITES = {
  main: { name: 'UAT Test Site — Unit 1, Example Park', address: 'Unit 1, Example Park, Testtown, ZZ99 9ZZ', timezone: 'Europe/London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: false },
  // GPS required at a fixed fictional point: a tester elsewhere sees the geofence refusal (the denial test).
  gps: { name: 'UAT GPS Site — Unit 2, Example Park', address: 'Unit 2, Example Park, Testtown, ZZ99 9ZZ', timezone: 'Europe/London', welfareCheckIntervalMinutes: 60, requireGpsCheckIn: true, latitude: 51.4545, longitude: -2.5879, geofenceRadiusMeters: 150 },
};

type ShiftPlan = { key: string; guard: 'alpha' | 'bravo'; site: 'main' | 'gps'; start: () => string; end: () => string; then: 'offered' | 'accepted' | 'booked-on'; purpose: string };
const SHIFTS: ShiftPlan[] = [
  { key: 'A-offer-1', guard: 'alpha', site: 'main', start: () => londonInstant(1, '09:00'), end: () => londonInstant(1, '17:00'), then: 'offered', purpose: 'Accept test' },
  { key: 'A-offer-2', guard: 'alpha', site: 'main', start: () => londonInstant(2, '09:00'), end: () => londonInstant(2, '17:00'), then: 'offered', purpose: 'Decline test' },
  { key: 'A-live', guard: 'alpha', site: 'main', start: () => fromNow(-50 * MIN), end: () => fromNow(4 * HOUR), then: 'booked-on', purpose: 'hourly Welfare (first due ~10 min after seeding; missed-Welfare alert if not recorded), Incident, Site Request, EARLY Book Off' },
  { key: 'A-early-book-on', guard: 'alpha', site: 'main', start: () => fromNow(5 * HOUR), end: () => fromNow(13 * HOUR), then: 'accepted', purpose: 'early Book On confirmation (more than 30 min before start, after A-live ends)' },
  { key: 'B-live', guard: 'bravo', site: 'main', start: () => fromNow(-40 * MIN), end: () => fromNow(20 * MIN), then: 'booked-on', purpose: 'plain Book Off (within 15 min of the scheduled end, or after it)' },
  { key: 'B-offer', guard: 'bravo', site: 'main', start: () => londonInstant(1, '18:00'), end: () => londonInstant(2, '02:00'), then: 'offered', purpose: 'second Guard offer; Guard isolation (Alpha never sees it)' },
  { key: 'B-gps', guard: 'bravo', site: 'gps', start: () => londonInstant(3, '09:00'), end: () => londonInstant(3, '17:00'), then: 'accepted', purpose: 'GPS-required site: Book On refused away from the site' },
];

function describePlan() {
  console.log('Intended records (all fictional; @example.com is a reserved domain that never receives mail):');
  console.log(`  users 3: owner ${PEOPLE.owner.email}; guards ${PEOPLE.alpha.email} (${PEOPLE.alpha.fullName}), ${PEOPLE.bravo.email} (${PEOPLE.bravo.fullName}); all email-verified, passwords random`);
  console.log(`  company 1: ${COMPANY.companyName} (number ${COMPANY.companyNumber}); client 1: ${CLIENT.name}`);
  console.log(`  sites 2: "${SITES.main.name}" (GPS off, Welfare 60 min), "${SITES.gps.name}" (GPS required, fixed fictional point)`);
  console.log('  workforce links 2 (Alpha, Bravo); company compliance checks 4 (SIA + Right to Work confirmed for each, test values)');
  console.log(`  documents 4: a fictional SIA licence PDF and a fictional Right to Work PDF per Guard ("UAT-FICTIONAL-…-NOT-REAL.pdf",`);
  console.log(`    every line stating it is fictional), uploaded through the real presigned flow to the ${STAGING_EVIDENCE_BUCKET} bucket, server-checked, then verified`);
  console.log(`  shifts ${SHIFTS.length}:`);
  for (const s of SHIFTS) console.log(`    ${s.key.padEnd(16)} ${s.guard.padEnd(6)} ${s.site.padEnd(5)} ${s.start()} → ${s.end()}  ends ${s.then.padEnd(9)} — ${s.purpose}`);
  console.log('  Book On events 2 (A-live, B-live, at seeding time); no Welfare checks, incidents, site requests or alerts are seeded.');
  console.log('  Side effects inside the target only: audit entries, in-app notification rows and draft timesheets the product creates for these actions.');
}

// ─── fictional evidence ────────────────────────────────────────────────────────────────────────────────────

/** The staging evidence bucket. Anything else — above all the production bucket — is refused. */
const STAGING_EVIDENCE_BUCKET = 's4-staging-evidence';
const PRODUCTION_EVIDENCE_BUCKET = 's4-evidence-pilot';

/**
 * A real, minimal PDF whose every line says it is fictional. Uploaded through the product's own presigned flow, so
 * the server's HEAD check sees genuine bytes; it is never a stand-in record. It names no real person and carries
 * no real licence or immigration data.
 */
export function fictionalPdf(title: string, holder: string, reference: string): Buffer {
  const lines = [
    'FICTIONAL TEST DOCUMENT - S4 STAGING UAT ONLY',
    title,
    `Holder: ${holder} (fictional test person)`,
    `Reference: ${reference} (test value, not issued by any authority)`,
    'This is NOT an SIA licence and NOT evidence of identity or right to work.',
    'It must never be relied on for any real compliance decision.',
  ];
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

/** Why the configured evidence storage is not the staging bucket (placeholder, production, unnamed), or null. */
export function stagingEvidenceProblem(env: Record<string, string>, productionKeyId?: string): string | null {
  let endpoint: URL;
  try { endpoint = new URL(env.EVIDENCE_STORAGE_ENDPOINT ?? ''); } catch { return 'evidence endpoint missing'; }
  if (endpoint.hostname.endsWith('.invalid')) return 'staging evidence storage is still the placeholder; create and certify the staging bucket first';
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com')) return `evidence endpoint is not Cloudflare R2 over HTTPS (${endpoint.hostname})`;
  if (env.EVIDENCE_STORAGE_BUCKET === PRODUCTION_EVIDENCE_BUCKET) return 'evidence bucket is the PRODUCTION bucket';
  if (env.EVIDENCE_STORAGE_BUCKET !== STAGING_EVIDENCE_BUCKET) return `evidence bucket must be ${STAGING_EVIDENCE_BUCKET}`;
  if (productionKeyId && productionKeyId === env.EVIDENCE_STORAGE_ACCESS_KEY_ID) return 'evidence key is the PRODUCTION key';
  return null;
}

function assertStagingEvidence(env: Record<string, string>, report: (problem: string | null) => void) {
  const prodFile = path.join(SECRETS, 'evidence-storage.env');
  const productionKeyId = fs.existsSync(prodFile) ? readEnvFile(prodFile).EVIDENCE_STORAGE_ACCESS_KEY_ID : undefined;
  report(stagingEvidenceProblem(env, productionKeyId));
}

// ─── run ───────────────────────────────────────────────────────────────────────────────────────────────────

async function preflight(t: Target) {
  const host = new URL(t.url).hostname;
  if (/supabase|pooler/i.test(host)) fail('Supabase / pooler host');
  const c = new Client({ connectionString: t.url, ssl: t.ssl });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const ledger = await c.query(`select count(*)::int n, (select name from typeorm_migrations order by id desc limit 1) last from typeorm_migrations`);
    if (ledger.rows[0].n !== EXPECTED_MIGRATIONS || ledger.rows[0].last !== LAST_MIGRATION) {
      fail(`migration ledger is ${ledger.rows[0].n} ending ${ledger.rows[0].last}, expected ${EXPECTED_MIGRATIONS} ending ${LAST_MIGRATION}`);
    }
    const users = (await c.query(`select count(*)::int n from users`)).rows[0].n;
    if (users !== 0) fail(`the target already has ${users} user(s); seed only a fresh database (reset first)`);
    console.log(`preflight OK: ${host}/${new URL(t.url).pathname.slice(1)}, ${EXPECTED_MIGRATIONS} migrations, 0 users`);
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
}

async function seed(t: Target) {
  // The app must never alter the schema here, never load a pooler URL from anywhere, and keep email in-process.
  Object.assign(process.env, {
    NODE_ENV: 'test', TZ: 'UTC', DATABASE_URL: t.url, DATABASE_POOLER_URL: '', DATABASE_SYNCHRONIZE: 'false',
    RESEND_API_KEY: '', EMAIL_FROM: '', SENTRY_DSN: '', CORS_ORIGIN: 'http://127.0.0.1', ...t.appEnv,
  });
  const { NestFactory } = await import('@nestjs/core');
  const { ValidationPipe } = await import('@nestjs/common');
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // Stop this process's timers at once: only the deployed staging service runs the sweeps.
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AutomationSchedulerService } = await import('../src/scheduler/scheduler.service');
  for (const svc of [app.get(SafetyAlertService) as any, app.get(AutomationSchedulerService) as any]) {
    for (const k of ['welfareInterval', 'dailyInterval', 'weeklyInterval']) if (svc[k]) clearInterval(svc[k]);
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const api = async (method: string, route: string, token: string | null, body?: unknown) => {
    const res = await fetch(base.replace('[::1]', '127.0.0.1') + route, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) throw new Error(`${method} ${route} -> ${res.status} ${typeof json === 'object' ? JSON.stringify(json?.message ?? json) : ''}`);
    return json;
  };

  const { AuthService } = await import('../src/auth/auth.service');
  const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
  const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
  const auth: any = app.get(AuthService);
  const verify = async (email: string) => {
    const message: any = [...app.get(TransactionalEmailService).capturedMessages()].reverse().find((m: any) => m.kind === 'email_verification' && m.to === email);
    const token = message && /verify-email\?token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    if (!token) throw new Error('verification email not captured');
    await app.get(AccountRecoveryService).verifyEmail(token);
  };
  const logins: Record<string, string> = {};
  const password = () => `${randomBytes(12).toString('base64url')}Aa1!`;

  try {
    const ownerPass = password();
    await auth.register({ email: PEOPLE.owner.email, password: ownerPass, role: 'company', fullName: PEOPLE.owner.fullName, phone: '01632960001', ...COMPANY });
    await verify(PEOPLE.owner.email);
    logins.UAT_OWNER_EMAIL = PEOPLE.owner.email; logins.UAT_OWNER_PASSWORD = ownerPass;
    const owner = await auth.login({ email: PEOPLE.owner.email, password: ownerPass });
    const ownerToken: string = owner.accessToken;
    const companyId: number = owner.user.companyId;

    const client = await api('POST', '/clients', ownerToken, CLIENT);
    const siteIds: Record<string, number> = {};
    for (const [key, site] of Object.entries(SITES)) siteIds[key] = (await api('POST', '/sites', ownerToken, { ...site, clientId: client.id })).id;

    const guards: Record<'alpha' | 'bravo', { guardId: number; token: string }> = {} as any;
    const documents: Array<{ guard: string; type: string; id: number; bytes: number }> = [];
    for (const key of ['alpha', 'bravo'] as const) {
      const p = PEOPLE[key];
      const pass = password();
      await auth.register({ email: p.email, password: pass, role: 'guard', fullName: p.fullName, phone: '07700900000', siaLicenseNumber: p.sia });
      await verify(p.email);
      const g = await auth.login({ email: p.email, password: pass });
      guards[key] = { guardId: g.user.guardId, token: g.accessToken };
      logins[`UAT_GUARD_${key.toUpperCase()}_EMAIL`] = p.email; logins[`UAT_GUARD_${key.toUpperCase()}_PASSWORD`] = pass;
      await api('POST', '/company-guards', ownerToken, { companyId, guardId: g.user.guardId });
      const day = (n: number) => new Date(Date.now() + n * 24 * HOUR).toISOString().slice(0, 10);
      await api('POST', '/compliance/checks', ownerToken, { guardId: g.user.guardId, kind: 'sia', outcome: 'confirmed', method: 'sia_public_register', licenceNumber: p.sia, checkDate: day(0), expiryDate: day(365), checkedByName: 'UAT Checker', evidenceReference: 'UAT test record — not a real check' });
      await api('POST', '/compliance/checks', ownerToken, { guardId: g.user.guardId, kind: 'right_to_work', outcome: 'confirmed', method: 'manual_document', rightToWorkExcuse: 'continuous', checkDate: day(0), checkedByName: 'UAT Checker', evidenceReference: 'UAT test record — not a real check' });

      // The company's document evidence, through the product's real upload workflow: request a presigned PUT, upload
      // genuine PDF bytes to the staging bucket, let the server HEAD-check the stored object, then verify it. Never
      // the file-less legacy path (no fileUrl is ever sent).
      for (const doc of [
        { type: 'sia_licence', title: 'FICTIONAL SIA LICENCE (TEST)', file: 'UAT-FICTIONAL-SIA-LICENCE-NOT-REAL.pdf', reference: p.sia, expiryDate: day(365) },
        { type: 'right_to_work', title: 'FICTIONAL RIGHT TO WORK RECORD (TEST)', file: 'UAT-FICTIONAL-RIGHT-TO-WORK-NOT-REAL.pdf', reference: 'UAT-RTW-TEST', expiryDate: null },
      ]) {
        const pdf = fictionalPdf(doc.title, p.fullName, doc.reference);
        const created = await api('POST', '/compliance/documents', ownerToken, {
          guardId: g.user.guardId, type: doc.type, originalFileName: doc.file, mimeType: 'application/pdf', sizeBytes: pdf.length, expiryDate: doc.expiryDate,
        });
        if (!created?.upload?.url || created.upload.method !== 'PUT') throw new Error('no presigned upload returned');
        const put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers ?? { 'Content-Type': 'application/pdf' }, body: new Uint8Array(pdf) });
        if (!put.ok) throw new Error(`evidence PUT refused by the bucket (${put.status})`);
        await api('POST', `/compliance/documents/${created.id}/complete-upload`, ownerToken);
        await api('PATCH', `/compliance/documents/${created.id}/verify`, ownerToken, { verified: true });
        documents.push({ guard: key, type: doc.type, id: created.id, bytes: pdf.length });
      }
    }

    const created: Array<{ key: string; id: number; status: string }> = [];
    for (const s of SHIFTS) {
      const shift = await api('POST', '/shifts', ownerToken, {
        siteId: siteIds[s.site], guardId: guards[s.guard].guardId, start: s.start(), end: s.end(), checkCallIntervalMinutes: 60,
        instructions: `UAT scenario ${s.key}: ${s.purpose}. Fictional test data.`,
      });
      if (s.then !== 'offered') await api('PATCH', `/shifts/${shift.id}/respond`, guards[s.guard].token, { response: 'accepted' });
      if (s.then === 'booked-on') await api('POST', '/attendance/check-in', guards[s.guard].token, { shiftId: shift.id });
      created.push({ key: s.key, id: shift.id, status: s.then });
    }

    fs.writeFileSync(t.loginsFile, `# S4 STAGING UAT logins (fictional accounts). Generated ${new Date().toISOString()}. Never production.\n` +
      Object.entries(logins).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    console.log(`seeded: company ${companyId}, client ${client.id}, sites ${Object.values(siteIds).join(', ')}, guards ${guards.alpha.guardId} (Alpha), ${guards.bravo.guardId} (Bravo)`);
    for (const d of documents) console.log(`  document ${d.id} ${d.guard} ${d.type} uploaded (${d.bytes} bytes) and verified`);
    for (const c of created) console.log(`  shift ${c.id} ${c.key} -> ${c.status}`);
    console.log(`logins written to ${t.loginsFile} (not printed)`);
  } finally {
    await app.close();
  }
}

if (require.main === module) (async () => {
  const t = resolveTarget();
  if (target === 'staging' && !dryRun && process.env.S4_STAGING_SEED_CONFIRM !== CONFIRM) fail(`set S4_STAGING_SEED_CONFIRM=${CONFIRM} to write to staging`);
  // At a7b5b22 a Guard is assignable only with an uploaded AND verified SIA licence and Right to Work document, so the
  // seeder needs the real staging bucket. Until it exists and is configured (staging-render.env and the Render
  // service), this refuses before anything is written rather than stopping part-way at the first shift offer.
  if (target === 'staging') {
    assertStagingEvidence(t.appEnv, (problem) => {
      if (!problem) return console.log('evidence storage: the staging bucket is configured');
      if (dryRun) return console.log(`evidence storage NOT ready (a real run would refuse): ${problem}`);
      fail(problem);
    });
  }
  await preflight(t);
  describePlan();
  if (dryRun) { console.log('DRY RUN: nothing written.'); return; }
  await seed(t);
})().catch((e) => { console.error('FAILED', String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, '<url>')); process.exit(1); });
