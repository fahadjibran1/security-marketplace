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
 *   - any target: no Supabase or pooler host; the migration ledger must hold exactly 65 entries ending in
 *     AddWelfarePushReminders1720900000011 (Migration 65, Welfare push reminders) — the same head as this repository's own
 *     migrations, which is checked too, so the in-process app and the database always agree; the users table must be
 *     EMPTY (seed once; reset to re-seed). --recover-logins applies the same ledger check before it boots the app.
 * Logins are written only to a git-ignored file (~/.s4-pilot-secrets/staging-uat.env for staging) and are never
 * printed. Output is ids and counts only.
 *
 * Recoverability (21 Oct 2026, after a seed stopped part-way and its logins were lost):
 *   - the logins file is written as each account is created, before any later step can fail;
 *   - every line this process prints goes through redact(), so full stack traces are kept and secrets are not;
 *   - every HTTP request times out after 60 s; a state-changing request is never sent twice: after a failed or
 *     ambiguous response the seeder reads the state back (confirmOnce) and stops if it is not what was asked for;
 *   - --report prints what already exists in the target, READ ONLY, without starting the app:
 *       npx ts-node -r tsconfig-paths/register scripts/staging-uat-seed.ts --target staging --report
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
const CONFIRM = 's4-staging-db';
const EXPECTED_MIGRATIONS = 65;
const LAST_MIGRATION = 'AddWelfarePushReminders1720900000011';
const SECRETS = path.join(os.homedir(), '.s4-pilot-secrets');

const args = process.argv.slice(2);
const target = args[args.indexOf('--target') + 1];
const dryRun = args.includes('--dry-run');
const reportOnly = args.includes('--report');
const recoverLogins = args.includes('--recover-logins');
/** The only accounts --recover-logins will touch: the three fictional UAT accounts, nothing else in the database. */
export const UAT_ACCOUNT_EMAILS = ['uat-guard-a@example.com', 'uat-guard-b@example.com', 'uat-owner@example.com'];
/**
 * The one approved fictional S4 platform administrator on staging (owner approval, 23 Oct 2026), created with the
 * product's own admin:bootstrap to activate Live Shift Amendments for the UAT company. It is never touched by this
 * seeder: recovery resets only the three UAT accounts.
 */
export const UAT_PLATFORM_ADMIN_EMAIL = 'uat-s4-admin@example.com';

/**
 * Why the target's users are not exactly the staging UAT set, or null when they are: the three fictional UAT accounts
 * (all present), plus at most the approved platform administrator — exactly that email AND the platform-admin role.
 * Any other user, a second extra user, or that email with any other role is refused.
 */
export function recoveryUsersProblem(users: Array<{ email: string; role: string }>): string | null {
  const emails = users.map((u) => String(u.email).trim().toLowerCase());
  const missing = UAT_ACCOUNT_EMAILS.filter((e) => !emails.includes(e));
  if (missing.length) return `the ${missing.length} expected fictional UAT account(s) are not all present`;
  const extra = users.filter((u) => !UAT_ACCOUNT_EMAILS.includes(String(u.email).trim().toLowerCase()));
  if (extra.length === 0) return null;
  if (extra.length > 1) return `${extra.length} users besides the three UAT accounts (at most the approved platform administrator is allowed)`;
  const [admin] = extra;
  if (String(admin.email).trim().toLowerCase() !== UAT_PLATFORM_ADMIN_EMAIL) return 'a user that is not one of the approved staging accounts';
  if (admin.role !== 'admin') return 'the approved platform administrator email belongs to a non-administrator account';
  return null;
}
const RECOVER_CONFIRM = 's4-staging-db';

/** Every HTTP request the seeder makes (in-process API, live staging API, bucket PUT and GET) gives up after this. */
export const REQUEST_TIMEOUT_MS = 60_000;

// ─── secrets out of everything printed ───────────────────────────────────────────────────────────────────────

const knownSecrets = new Set<string>();
/** Values that must never be printed: passwords, tokens, keys. Registered as soon as they exist. */
export function registerSecret(value: string | undefined | null) {
  if (value && value.length >= 8) knownSecrets.add(value);
}

/**
 * Removes secrets from text while keeping everything else, stack frames included. Known values are replaced
 * wherever they appear; database URLs, bearer and JWT tokens, presigned-URL signatures and credentials, and any
 * JSON "password" / "token" / "secret" field are masked by shape, so an unregistered value is still caught.
 */
export function redact(text: string): string {
  let out = text;
  for (const s of [...knownSecrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('<redacted>');
  return out
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<database-url>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/("(?:password|currentPassword|newPassword|accessToken|refreshToken|token|secret|secretAccessKey)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
}

/** Routes this process's stdout and stderr (our output, Nest's logger, uncaught stacks) through redact(). */
function installRedaction() {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: any, ...rest: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]) => write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? redact(chunk.toString()) : chunk, ...rest);
  }
}

// ─── logins, kept from the moment each account exists ────────────────────────────────────────────────────────

/** (Re)writes the logins file, owner-only. Called after EACH account is created, so a later failure never strands it. */
export function writeLogins(file: string, logins: Record<string, string>) {
  fs.writeFileSync(file, `# S4 STAGING UAT logins (fictional accounts). Updated ${new Date().toISOString()}. Never production.\n` +
    Object.entries(logins).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
}

// ─── one attempt, then read back ────────────────────────────────────────────────────────────────────────────

export type ConfirmOutcome = { outcome: 'done' } | { outcome: 'confirmed-after-error'; error: string };

/**
 * Sends a state-changing request exactly once. If it fails or times out, the result is ambiguous (the server may
 * have committed it, as the 21 Oct shift 4 acceptance did), so the state is READ BACK instead of resending: if it
 * already shows the requested change, carry on and say so; otherwise stop with both facts. Never retries.
 */
export async function confirmOnce(
  description: string,
  send: () => Promise<unknown>,
  readBack: () => Promise<string>,
  wanted: string,
): Promise<ConfirmOutcome> {
  try {
    await send();
    return { outcome: 'done' };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    let state: string;
    try { state = await readBack(); } catch (readError) {
      throw new Error(`${description}: request failed (${message}) and the read-back failed too (${String((readError as Error)?.message ?? readError)}); state UNKNOWN — not retried`);
    }
    if (state === wanted) return { outcome: 'confirmed-after-error', error: message };
    throw new Error(`${description}: request failed (${message}); read-back shows "${state}", not "${wanted}" — not retried`);
  }
}

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
/**
 * POST /shifts answers { shift, timesheet } (ShiftService.create), not the shift itself. Returns the created shift and
 * refuses any other shape, so a missing id stops the seed instead of becoming /shifts/undefined.
 */
export function createdShift(response: unknown): { id: number; status: string } {
  const shift = (response as { shift?: { id?: unknown; status?: unknown } } | null)?.shift;
  if (!shift || typeof shift.id !== 'number' || !Number.isInteger(shift.id)) {
    throw new Error('POST /shifts did not return { shift: { id } }');
  }
  return shift as { id: number; status: string };
}

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

/**
 * The migration head this repository's own code expects: the number of migration files and the class of the last.
 * The seeder boots this code in-process, so the expected ledger must be exactly this head — never a ledger the code
 * would not run on.
 */
export function repositoryMigrationHead(dir = path.join(__dirname, '..', 'src', 'database', 'migrations')): { count: number; last: string } {
  const files = fs.readdirSync(dir).filter((f) => /\.ts$/.test(f)).sort();
  const lastSource = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8');
  const last = /export class (\w+)/.exec(lastSource)?.[1] ?? '';
  return { count: files.length, last };
}

/** Refuses unless the constants, this repository's migrations and the target's ledger are all the same head. */
async function assertLedger(c: any) {
  const head = repositoryMigrationHead();
  if (head.count !== EXPECTED_MIGRATIONS || head.last !== LAST_MIGRATION) {
    fail(`this code's migration head is ${head.count} ending ${head.last}, but the seeder expects ${EXPECTED_MIGRATIONS} ending ${LAST_MIGRATION}`);
  }
  const ledger = await c.query(`select count(*)::int n, (select name from typeorm_migrations order by id desc limit 1) last from typeorm_migrations`);
  if (ledger.rows[0].n !== EXPECTED_MIGRATIONS || ledger.rows[0].last !== LAST_MIGRATION) {
    fail(`migration ledger is ${ledger.rows[0].n} ending ${ledger.rows[0].last}, expected ${EXPECTED_MIGRATIONS} ending ${LAST_MIGRATION}`);
  }
}

async function preflight(t: Target) {
  const host = new URL(t.url).hostname;
  if (/supabase|pooler/i.test(host)) fail('Supabase / pooler host');
  const c = new Client({ connectionString: t.url, ssl: t.ssl });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    await assertLedger(c);
    const users = (await c.query(`select count(*)::int n from users`)).rows[0].n;
    if (users !== 0) fail(`the target already has ${users} user(s); seed only a fresh database (reset first)`);
    console.log(`preflight OK: ${host}/${new URL(t.url).pathname.slice(1)}, ${EXPECTED_MIGRATIONS} migrations, 0 users`);
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
}

/** The real backend, in this process, against the target: no schema changes, no pooler, email captured in-process, no timers. */
async function bootApp(t: Target) {
  registerSecret(t.url);
  for (const v of Object.values(t.appEnv)) registerSecret(v);
  // The app must never alter the schema here, never load a pooler URL from anywhere, and keep email in-process.
  Object.assign(process.env, {
    NODE_ENV: 'test', TZ: 'UTC', DATABASE_URL: t.url, DATABASE_POOLER_URL: '', DATABASE_SYNCHRONIZE: 'false',
    RESEND_API_KEY: '', EMAIL_FROM: '', SENTRY_DSN: '', CORS_ORIGIN: 'http://127.0.0.1', ...t.appEnv,
  });
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // Stop this process's timers at once: only the deployed staging service runs the sweeps.
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { AutomationSchedulerService } = await import('../src/scheduler/scheduler.service');
  const { ShiftAmendmentService } = await import('../src/shift-amendment/shift-amendment.service');
  for (const svc of [app.get(SafetyAlertService) as any, app.get(AutomationSchedulerService) as any, app.get(ShiftAmendmentService) as any]) {
    for (const k of ['welfareInterval', 'dailyInterval', 'weeklyInterval', 'expiryInterval']) if (svc[k]) clearInterval(svc[k]);
  }
  // The shift amendment expiry job (Migration 64) must not run here either: it would expire proposals on the target.
  (app.get(ShiftAmendmentService) as any).expiryJob?.stop();
  // Nor the Welfare push reminder job (Migration 65): it would send reminders from this machine.
  const { WelfarePushService } = await import('../src/welfare-push/welfare-push.service');
  const push = app.get(WelfarePushService) as any;
  if (push.reminderInterval) clearInterval(push.reminderInterval);
  push.reminderJob?.stop();
  return app;
}

/**
 * Restores sign-in to the three fictional UAT accounts after their logins were lost, through the product's OWN
 * password-reset workflow: forgotPassword issues and audits a reset token; the reset email is captured in-process
 * (email delivery is disabled here, nothing leaves this machine); resetPassword consumes the token, sets a new random
 * password, audits it and revokes every existing session. No row is deleted and no other account is touched. Each
 * new login is then proved against the DEPLOYED staging API, and saved before the next account is started.
 */
async function recover(t: Target) {
  const c = new Client({ connectionString: t.url, ssl: t.ssl });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    // The app booted below is this code: it must run only on the migration head it was built for.
    await assertLedger(c);
    const users = (await c.query(`select lower(email) email, role::text role from users order by 1`)).rows as Array<{ email: string; role: string }>;
    await c.query('ROLLBACK');
    const problem = recoveryUsersProblem(users);
    if (problem) fail(`users are not the staging UAT set (${users.length} users): ${problem}; nothing recovered`);
  } finally {
    await c.end();
  }
  console.log('recovery preflight OK: the 3 fictional UAT accounts (and at most the approved staging platform administrator)');
  const app = await bootApp(t);
  try {
    const { AccountRecoveryService } = await import('../src/auth/account-recovery.service');
    const { TransactionalEmailService } = await import('../src/email/transactional-email.service');
    const recovery: any = app.get(AccountRecoveryService);
    const outbox: any = app.get(TransactionalEmailService);
    const logins: Record<string, string> = {};
    const keyFor: Record<string, string> = { 'uat-owner@example.com': 'UAT_OWNER', 'uat-guard-a@example.com': 'UAT_GUARD_ALPHA', 'uat-guard-b@example.com': 'UAT_GUARD_BRAVO' };
    for (const email of ['uat-owner@example.com', 'uat-guard-a@example.com', 'uat-guard-b@example.com']) {
      await recovery.forgotPassword(email);
      const message: any = [...outbox.capturedMessages()].reverse().find((m: any) => m.kind === 'password_reset' && m.to === email);
      const token = message && decodeURIComponent(/reset-password\?token=([^\s"'<>&]+)/.exec(message.text)?.[1] ?? '');
      if (!token) throw new Error(`no reset email captured for ${email} (rate limit, or the account is not eligible); stopped`);
      registerSecret(token);
      const pass = `${randomBytes(12).toString('base64url')}Aa1!`;
      registerSecret(pass);
      await recovery.resetPassword(token, pass);
      logins[`${keyFor[email]}_EMAIL`] = email; logins[`${keyFor[email]}_PASSWORD`] = pass;
      writeLogins(t.loginsFile, logins);
      // Proof on the deployed service, exactly as a tester or the app would sign in.
      const res = await fetch(`${STAGING_API}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pass }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body?.accessToken) throw new Error(`${email}: reset done but the staging API refused sign-in (HTTP ${res.status}); stopped`);
      registerSecret(body.accessToken);
      console.log(`  ${email}: reset through the product workflow (audited, sessions revoked); signs in to the deployed staging API`);
    }
    console.log(`logins written to ${t.loginsFile} (not printed)`);
  } finally {
    await app.close();
  }
}

async function seed(t: Target) {
  const { ValidationPipe } = await import('@nestjs/common');
  const app = await bootApp(t);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  // For staging, evidence goes through the DEPLOYED staging service (its signer, its HEAD check, its access URLs), so
  // seeding also proves the live evidence workflow. Tokens issued in-process are signed with the staging JWT secret
  // and resolve against the same database, so the live service accepts them.
  const liveBase = target === 'staging' ? STAGING_API : base;
  // One attempt per request, never retried here; a timeout surfaces as an error the caller must resolve by reading back.
  const call = async (root: string, method: string, route: string, token: string | null, body?: unknown) => {
    const res = await fetch(root + route, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) throw new Error(`${method} ${route} -> ${res.status} ${typeof json === 'object' ? JSON.stringify(json?.message ?? json) : ''}`);
    return json;
  };
  const api = (method: string, route: string, token: string | null, body?: unknown) => call(base, method, route, token, body);
  const liveApi = (method: string, route: string, token: string | null, body?: unknown) => call(liveBase, method, route, token, body);

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
    registerSecret(ownerPass);
    await auth.register({ email: PEOPLE.owner.email, password: ownerPass, role: 'company', fullName: PEOPLE.owner.fullName, phone: '01632960001', ...COMPANY });
    logins.UAT_OWNER_EMAIL = PEOPLE.owner.email; logins.UAT_OWNER_PASSWORD = ownerPass;
    writeLogins(t.loginsFile, logins);
    await verify(PEOPLE.owner.email);
    const owner = await auth.login({ email: PEOPLE.owner.email, password: ownerPass });
    const ownerToken: string = owner.accessToken;
    registerSecret(ownerToken);
    const companyId: number = owner.user.companyId;

    const client = await api('POST', '/clients', ownerToken, CLIENT);
    const siteIds: Record<string, number> = {};
    for (const [key, site] of Object.entries(SITES)) siteIds[key] = (await api('POST', '/sites', ownerToken, { ...site, clientId: client.id })).id;

    const guards: Record<'alpha' | 'bravo', { guardId: number; token: string }> = {} as any;
    const documents: Array<{ guard: string; type: string; id: number; bytes: number }> = [];
    for (const key of ['alpha', 'bravo'] as const) {
      const p = PEOPLE[key];
      const pass = password();
      registerSecret(pass);
      await auth.register({ email: p.email, password: pass, role: 'guard', fullName: p.fullName, phone: '07700900000', siaLicenseNumber: p.sia });
      logins[`UAT_GUARD_${key.toUpperCase()}_EMAIL`] = p.email; logins[`UAT_GUARD_${key.toUpperCase()}_PASSWORD`] = pass;
      writeLogins(t.loginsFile, logins);
      await verify(p.email);
      const g = await auth.login({ email: p.email, password: pass });
      registerSecret(g.accessToken);
      guards[key] = { guardId: g.user.guardId, token: g.accessToken };
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
        const created = await liveApi('POST', '/compliance/documents', ownerToken, {
          guardId: g.user.guardId, type: doc.type, originalFileName: doc.file, mimeType: 'application/pdf', sizeBytes: pdf.length, expiryDate: doc.expiryDate,
        });
        if (!created?.upload?.url || created.upload.method !== 'PUT') throw new Error('no presigned upload returned');
        const put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers ?? { 'Content-Type': 'application/pdf' }, body: new Uint8Array(pdf), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!put.ok) throw new Error(`evidence PUT refused by the bucket (${put.status})`);
        await liveApi('POST', `/compliance/documents/${created.id}/complete-upload`, ownerToken);
        await liveApi('PATCH', `/compliance/documents/${created.id}/verify`, ownerToken, { verified: true });
        documents.push({ guard: key, type: doc.type, id: created.id, bytes: pdf.length });
      }
    }

    // Retrieval through the live service: a signed GET it issues must return the exact fictional bytes.
    const access = await liveApi('GET', `/compliance/documents/${documents[0].id}/access`, ownerToken);
    const fetched = Buffer.from(await (await fetch(access.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).arrayBuffer());
    if (fetched.length !== documents[0].bytes || !fetched.toString('latin1').includes('FICTIONAL TEST DOCUMENT')) {
      throw new Error('live retrieval did not return the uploaded fictional document');
    }

    const created: Array<{ key: string; id: number; status: string }> = [];
    for (const s of SHIFTS) {
      const shift = createdShift(await api('POST', '/shifts', ownerToken, {
        siteId: siteIds[s.site], guardId: guards[s.guard].guardId, start: s.start(), end: s.end(), checkCallIntervalMinutes: 60,
        instructions: `UAT scenario ${s.key}: ${s.purpose}. Fictional test data.`,
      }));
      const token = guards[s.guard].token;
      // The Guard's own view of the shift; 'accepted' is the legacy name of 'ready'.
      const statusOf = async () => { const v = (await api('GET', `/shifts/${shift.id}`, token))?.status; return v === 'accepted' ? 'ready' : String(v); };
      const notes: string[] = [];
      if (s.then !== 'offered') {
        const r = await confirmOnce(`accept shift ${shift.id} (${s.key})`, () => api('PATCH', `/shifts/${shift.id}/respond`, token, { response: 'accepted' }), statusOf, 'ready');
        if (r.outcome === 'confirmed-after-error') notes.push(`accept answered "${r.error}" but the shift reads back as ready`);
      }
      if (s.then === 'booked-on') {
        const r = await confirmOnce(`Book On shift ${shift.id} (${s.key})`, () => api('POST', '/attendance/check-in', token, { shiftId: shift.id }), statusOf, 'in_progress');
        if (r.outcome === 'confirmed-after-error') notes.push(`Book On answered "${r.error}" but the shift reads back as in_progress`);
      }
      notes.forEach((n) => console.log(`  NOTE shift ${shift.id} ${s.key}: ${n}`));
      created.push({ key: s.key, id: shift.id, status: s.then });
    }

    console.log(`seeded: company ${companyId}, client ${client.id}, sites ${Object.values(siteIds).join(', ')}, guards ${guards.alpha.guardId} (Alpha), ${guards.bravo.guardId} (Bravo)`);
    for (const d of documents) console.log(`  document ${d.id} ${d.guard} ${d.type} uploaded (${d.bytes} bytes) and verified`);
    console.log(`  evidence via ${target === 'staging' ? 'the LIVE staging API' : 'the in-process API'}: upload, server check, verify and signed retrieval OK`);
    for (const c of created) console.log(`  shift ${c.id} ${c.key} -> ${c.status}`);
    console.log(`logins written to ${t.loginsFile} (not printed)`);
  } finally {
    await app.close();
  }
}

/**
 * READ ONLY: what already exists in the target. Same target guards as seeding (staging host only, never production,
 * strict TLS); one READ ONLY transaction, rolled back. Prints fictional names, ids, statuses and counts — no
 * passwords, hashes, tokens, storage keys or URLs. The logins file is reported by its keys only.
 */
async function report(t: Target) {
  const host = new URL(t.url).hostname;
  if (/supabase|pooler/i.test(host)) fail('Supabase / pooler host');
  const c = new Client({ connectionString: t.url, ssl: t.ssl });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const q = async (sql: string) => (await c.query(sql)).rows as any[];
    const [id] = await q(`select current_database() db, (select count(*)::int from typeorm_migrations) migrations, (select name from typeorm_migrations order by id desc limit 1) last`);
    console.log(`REPORT (read only) ${host}/${id.db}: ledger ${id.migrations}, last ${id.last}`);
    const users = await q(`select id, lower(email) email, role, "isEmailVerified" verified from users order by id`);
    const fictional = users.every((u) => /@example\.com$/.test(u.email));
    console.log(`users ${users.length}${fictional ? ' (all fictional @example.com)' : ' — NOT ALL FICTIONAL, emails withheld'}:`);
    for (const u of users) console.log(`  ${u.id} ${fictional ? u.email : '<withheld>'} ${u.role}${u.verified === undefined ? '' : u.verified ? ' verified' : ' unverified'}`);
    for (const r of await q(`select id, name from companies order by id`)) console.log(`company ${r.id}: ${r.name}`);
    for (const r of await q(`select id, name from clients order by id`)) console.log(`client ${r.id}: ${r.name}`);
    for (const r of await q(`select id, name, "requireGpsCheckIn" gps from sites order by id`)) console.log(`site ${r.id}: ${r.name}${r.gps ? ' (GPS required)' : ''}`);
    const shifts = await q(`select s.id, s.status, s."start"::text st, s."end"::text en, s."guardId" g, s.instructions i from shifts s order by s.id`);
    console.log(`shifts ${shifts.length} (times UTC):`);
    for (const s of shifts) console.log(`  ${s.id} ${(/^UAT scenario (\S+):/.exec(s.i ?? '') ?? [, '(untagged)'])[1].padEnd(16)} guard ${s.g ?? '-'} ${String(s.status).padEnd(11)} ${s.st} → ${s.en}`);
    const att = await q(`select "shiftId" sid, type, count(*)::int n from attendance_events group by 1, 2 order by 1, 2`);
    console.log(`attendance: ${att.length ? att.map((a) => `shift ${a.sid} ${a.type}×${a.n}`).join(', ') : 'none'}`);
    const logs = await q(`select "logType" t, count(*)::int n from daily_logs group by 1 order by 1`);
    console.log(`daily logs: ${logs.length ? logs.map((l) => `${l.t}×${l.n}`).join(', ') : 'none'}`);
    const alerts = await q(`select id, type, status, "shiftId" sid, "welfareWindowIndex" w from safety_alerts order by id`);
    console.log(`alerts ${alerts.length}: ${alerts.map((a) => `${a.id} ${a.type}/${a.status} shift ${a.sid}${a.w == null ? '' : ` window ${a.w}`}`).join('; ') || 'none'}`);
    const inc = await q(`select count(*)::int n from incidents`);
    console.log(`incidents: ${inc[0].n}`);
    // Live Shift Amendments (Migration 64). Read only, and tolerant of a database not yet migrated.
    const [m64] = await q(`select to_regclass('public.shift_amendments') is not null amendments, to_regclass('public.company_shift_policies') is not null policies`);
    if (m64.amendments && m64.policies) {
      const byStatus = await q(`select status, count(*)::int n from shift_amendments group by 1 order by 1`);
      const enabled = await q(`select "companyId" c from company_shift_policies where "amendmentsEnabled" order by 1`);
      console.log(`shift amendments: ${byStatus.length ? byStatus.map((r) => `${r.status}×${r.n}`).join(', ') : 'none'}; amendments enabled for: ${enabled.length ? enabled.map((r) => `company ${r.c}`).join(', ') : 'no company'}`);
    } else {
      console.log('shift amendments: Migration 64 not applied on this database');
    }
    const docs = await q(`select id, type, "originalFileName" f, ("uploadCompletedAt" is not null) up, verified from guard_documents order by id`);
    console.log(`evidence records ${docs.length}: ${docs.map((d) => `${d.id} ${d.type} ${d.up ? 'uploaded' : 'NOT uploaded'} ${d.verified ? 'verified' : 'unverified'} ${/^UAT-FICTIONAL-.*-NOT-REAL\.pdf$/.test(d.f ?? '') ? '(fictional file)' : '(NOT a UAT file)'}`).join('; ') || 'none'}`);
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  if (fs.existsSync(t.loginsFile)) {
    const keys = Object.keys(readEnvFile(t.loginsFile));
    console.log(`logins file present (${keys.length} keys: ${keys.filter((k) => k.endsWith('_EMAIL')).map((k) => k.replace(/_EMAIL$/, '')).join(', ')}); values not printed`);
  } else {
    console.log('logins file: ABSENT — these accounts cannot be signed in to with this file');
  }
}

if (require.main === module) (async () => {
  installRedaction();
  const t = resolveTarget();
  registerSecret(t.url);
  if (reportOnly) { await report(t); return; }
  if (recoverLogins) {
    if (target !== 'staging') fail('--recover-logins is for the staging UAT accounts only');
    if (process.env.S4_STAGING_RECOVER_CONFIRM !== RECOVER_CONFIRM) fail(`set S4_STAGING_RECOVER_CONFIRM=${RECOVER_CONFIRM} to reset the fictional UAT passwords`);
    await recover(t);
    return;
  }
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
})().catch((e) => { console.error('FAILED', redact(String(e?.stack ?? e?.message ?? e))); process.exit(1); });
