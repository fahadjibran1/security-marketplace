/**
 * S4 Patrol Monitor S1 — synthetic performance measurement (owner: "measure query performance on a synthetic dataset at
 * the proposed scale and report whether indexes are justified"). LOCAL, DISPOSABLE database only: it drops the schema.
 *
 *   PATROL_MONITOR_PERF_DATABASE_URL=postgresql://…@127.0.0.1:…/db  npx ts-node -r tsconfig-paths/register scripts/patrol-monitor-perf.ts
 *
 * Scale (env, defaults = the design's top of range): PERF_SITES=50 sites (half site-wide hourly, half per-guard hourly with
 * three day Guards and one night Guard), PERF_DAYS=730 days of history (≈ 1,800 patrols a day ⇒ ≈ 1.3 M patrol runs), 3 %
 * of windows missed (exception + alert), the last 30 days with 6 QR scans and 4 photos per patrol (≈ 216 k evidence rows,
 * 300 photos an hour), 200 k other safety alerts. Times are UTC hours (synthetic: in BST months the window keys do not
 * match the engine's local slots, which does not change the work a query does; the measured day is in GMT).
 *
 * It measures the monitor reads in-process (the service, at a fixed "now") and over HTTP (with serialisation and the
 * response size), prints EXPLAIN (ANALYZE, BUFFERS) of every monitor query, then repeats everything with each candidate
 * index created and finally drops them again — no migration, nothing outside this database.
 * PERF_SKIP_GENERATE=1 reuses an existing dataset.
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

const url = process.env.PATROL_MONITOR_PERF_DATABASE_URL;
if (!url) throw new Error('PATROL_MONITOR_PERF_DATABASE_URL is required (disposable local database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('The performance database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-monitor-perf-local-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
for (const k of ['RESEND_API_KEY', 'EXPO_ACCESS_TOKEN', 'PUSH_WELFARE_REMINDERS_ENABLED', 'PUSH_GUARD_NOTIFICATIONS_ENABLED', 'PATROL_QR_SIGNING_KEY', 'PATROL_QR_PREVIOUS_SIGNING_KEY']) delete process.env[k];

const SITES = Number(process.env.PERF_SITES ?? 50);
const DAYS = Number(process.env.PERF_DAYS ?? 730);
const TODAY = '2026-11-02';
const NOW = new Date(`${TODAY}T13:40:00Z`);
const PASSWORD = 'patrol-monitor-perf-only-password-1';
const ITER = Number(process.env.PERF_ITERATIONS ?? 20);

const CANDIDATES = [
  { name: 'IDX_perf_patrol_runs_company_site_window_start', sql: `CREATE INDEX "IDX_perf_patrol_runs_company_site_window_start" ON "patrol_runs" ("companyId", "siteId", "windowStart")` },
  { name: 'IDX_perf_patrol_exceptions_company_site_window_start', sql: `CREATE INDEX "IDX_perf_patrol_exceptions_company_site_window_start" ON "patrol_exceptions" ("companyId", "siteId", "windowStart")` },
  { name: 'IDX_perf_shifts_company_site_start', sql: `CREATE INDEX "IDX_perf_shifts_company_site_start" ON "shifts" ("companyId", "siteId", "start")` },
  { name: 'IDX_perf_safety_alerts_company_open', sql: `CREATE INDEX "IDX_perf_safety_alerts_company_open" ON "safety_alerts" ("companyId", "type") WHERE "status" <> 'closed'` },
];

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms · p95 ${pct(xs, 95).toFixed(1)} ms · max ${Math.max(...xs).toFixed(1)} ms`;

async function generate(ds: DataSource) {
  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p);
  const t0 = process.hrtime.bigint();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const [{ id: ownerId }] = await q(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
    VALUES ('perf.owner@example.invalid',$1,'company_admin','active',true,false,'Perf','Owner') RETURNING id`, [hash]);
  const [{ id: co }] = await q(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,'Perf Security Ltd','99000001','1 Way','ops@example.invalid',true) RETURNING id`, [ownerId]);
  await q(`INSERT INTO sites ("companyId",name,address,timezone,"clientName")
    SELECT $1, 'Site ' || lpad(s::text, 2, '0'), s || ' Quay', 'Europe/London', 'Client ' || ((s - 1) % 10 + 1) FROM generate_series(1, $2) s`, [co, SITES]);
  const sites: number[] = (await q(`SELECT id FROM sites WHERE "companyId" = $1 ORDER BY id`, [co])).map((r: any) => Number(r.id));
  const perGuard = sites.slice(Math.floor(SITES / 2));
  // Four Guards per site.
  await q(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
    SELECT 'perf.guard' || g || '@example.invalid', $1, 'guard', 'active', true, false, 'Guard', g::text FROM generate_series(1, $2 * 4) g`, [hash, SITES]);
  await q(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone)
    SELECT u.id, 'Guard ' || u."lastName", '99' || lpad(u."lastName", 14, '0'), '0799' || lpad(u."lastName", 7, '0') FROM users u WHERE u.email LIKE 'perf.guard%'`);
  await q(`INSERT INTO patrol_policies ("companyId","siteId","requirementScope") SELECT $1, unnest($2::int[]), 'per_guard'`, [co, perGuard]);
  await q(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label)
    SELECT $1, s.id, md5(s.id || ':' || c), 'Checkpoint ' || c FROM sites s CROSS JOIN generate_series(1, 6) c WHERE s."companyId" = $1`, [co]);
  await q(`INSERT INTO patrol_routes ("companyId","siteId",name) SELECT $1, id, 'Perimeter' FROM sites WHERE "companyId" = $1`, [co]);
  await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position)
    SELECT $1, r."siteId", r.id, c.id, row_number() OVER (PARTITION BY r.id ORDER BY c.id) FROM patrol_routes r JOIN patrol_checkpoints c ON c."siteId" = r."siteId" WHERE r."companyId" = $1`, [co]);
  await q(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"createdAt","updatedAt")
    SELECT $1, r."siteId", r.id, 'Hourly patrol', '[1,2,3,4,5,6,7]'::jsonb, '00:00', '00:00', 60, 60, true, '2020-01-01', '2020-01-01' FROM patrol_routes r WHERE r."companyId" = $1`, [co]);
  console.log(`  configuration: ${ms(t0).toFixed(0)} ms`);

  // Shifts: per site and day a day shift (07–19) and a night shift (19–07); per-guard sites two more day shifts.
  // Lane index k: 0 = day A, 1 = night B, 2/3 = day C/D (per-guard sites only).
  await q(`CREATE TEMP TABLE perf_site AS SELECT s.id AS "siteId", row_number() OVER (ORDER BY s.id) AS n, (s.id = ANY($2::int[])) AS "perGuard",
       (SELECT id FROM patrol_schedules WHERE "siteId" = s.id) AS "scheduleId", (SELECT id FROM patrol_routes WHERE "siteId" = s.id) AS "routeId"
     FROM sites s WHERE s."companyId" = $1`, [co, perGuard]);
  await q(`CREATE TEMP TABLE perf_guard AS SELECT g.id AS "guardId", g."userId", ((replace(g."fullName", 'Guard ', '')::int - 1) / 4) + 1 AS n,
       ((replace(g."fullName", 'Guard ', '')::int - 1) % 4) AS k FROM guard_profiles g WHERE g."fullName" ~ '^Guard [0-9]+$'`);
  await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end")
    SELECT $1, ps."siteId", 'Site', pg."guardId",
           CASE WHEN d.day + lane.s > $2::timestamptz THEN 'ready' WHEN d.day + lane.e > $2::timestamptz THEN 'in_progress' ELSE 'completed' END,
           d.day + lane.s, d.day + lane.e
      FROM perf_site ps
      CROSS JOIN generate_series($3::date - ($4::int - 1), $3::date, interval '1 day') d(day)
      JOIN (VALUES (0, interval '7 hours', interval '19 hours'), (1, interval '19 hours', interval '31 hours'),
                   (2, interval '7 hours', interval '19 hours'), (3, interval '7 hours', interval '19 hours')) lane(k, s, e) ON lane.k < 2 OR ps."perGuard"
      JOIN perf_guard pg ON pg.n = ps.n AND pg.k = lane.k`, [co, NOW, TODAY, DAYS]);
  await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified")
    SELECT id, "guardId", 'check-in', start, start, false FROM shifts WHERE "companyId" = $1 AND status IN ('completed','in_progress')`, [co]);
  await q(`INSERT INTO attendance_events ("shiftId","guardId",type,"occurredAt","recordedAt","gpsVerified")
    SELECT id, "guardId", 'check-out', "end", "end", false FROM shifts WHERE "companyId" = $1 AND status = 'completed'`, [co]);
  console.log(`  shifts + attendance: ${ms(t0).toFixed(0)} ms`);

  // Every hourly window owed so far, with who owes it: each shift's own hours (site-wide sites have exactly one shift on
  // duty each hour; per-guard sites owe each window once per on-duty shift).
  await q(`CREATE TEMP TABLE perf_window AS
    SELECT ps."siteId", ps."scheduleId", ps."routeId", ps."perGuard", sh.id AS "shiftId", sh."guardId", w.ws, w.ws + interval '1 hour' AS we,
           's' || ps."scheduleId" || ':' || to_char(w.ws, 'YYYY-MM-DD') || ':' || extract(hour FROM w.ws)::int AS "windowKey",
           CASE WHEN ps."perGuard" THEN 'sh' || sh.id ELSE 'site' END AS "scopeKey"
      FROM shifts sh JOIN perf_site ps ON ps."siteId" = sh."siteId"
      CROSS JOIN LATERAL generate_series(sh.start, sh."end" - interval '1 hour', interval '1 hour') w(ws)
     WHERE sh."companyId" = $2 AND sh.status IN ('completed','in_progress') AND w.ws + interval '75 minutes' <= $1::timestamptz`, [NOW, co]);
  await q(`ALTER TABLE perf_window ADD COLUMN missed boolean`);
  await q(`UPDATE perf_window SET missed = (abs(hashtext("windowKey" || "scopeKey")) % 33 = 0)`);
  const [{ windows, missed }] = await q(`SELECT count(*)::int windows, count(*) FILTER (WHERE missed)::int missed FROM perf_window`);
  console.log(`  windows owed so far: ${windows} (${missed} missed): ${ms(t0).toFixed(0)} ms`);

  await q(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
       status,"verificationStatus","verifiedAt","verificationFinalAt","startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId")
    SELECT $1, w."siteId", w."shiftId", w."guardId", pg."userId", w."scheduleId", w."routeId", w."windowKey", w.ws, w.we, w."scopeKey",
           'completed', 'verified', w.ws + interval '25 minutes', w.ws + interval '1 day', w.ws + interval '5 minutes', w.ws + interval '5 minutes',
           w.ws + interval '20 minutes', w.ws + interval '20 minutes', 'perf-' || md5(w."windowKey" || w."scopeKey")
      FROM perf_window w JOIN perf_guard pg ON pg."guardId" = w."guardId" WHERE NOT w.missed`, [co]);
  // The current hour: in progress.
  console.log(`  runs: ${ms(t0).toFixed(0)} ms`);
  await q(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","guardId","windowKey","scopeKey","windowStart","windowEnd",type,status,"resolvedAt","createdAt")
    SELECT $1, w."siteId", w."scheduleId", w."shiftId", w."guardId", w."windowKey", w."scopeKey", w.ws, w.we, 'patrol_missed',
           CASE WHEN w.ws >= $2::date THEN 'open' ELSE 'resolved' END, CASE WHEN w.ws >= $2::date THEN NULL ELSE w.we + interval '1 hour' END, w.we + interval '20 minutes'
      FROM perf_window w WHERE w.missed`, [co, TODAY]);
  await generateTail(ds, Number(co), t0);
}

/** The stages after the patrol runs and exceptions; each skipped when already done (PERF_RESUME_TAIL=1 resumes here). */
async function generateTail(ds: DataSource, co: number, t0: bigint) {
  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p);
  const has = async (sql: string) => Number((await q(sql, [co]))[0].n) > 0;
  if (!(await has(`SELECT count(*) n FROM safety_alerts WHERE "companyId" = $1 AND "patrolExceptionId" IS NOT NULL`))) {
  await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"patrolExceptionId","patrolWindowKey","createdAt")
    SELECT e."companyId", e."guardId", e."shiftId", 'patrol_missed', 'high', 'Patrol missed (synthetic)', (CASE WHEN e.status = 'resolved' THEN 'closed' ELSE 'open' END)::safety_alerts_status_enum,
           e.id, e."windowKey", e."createdAt" FROM patrol_exceptions e WHERE e."companyId" = $1`, [co]);
  await q(`UPDATE patrol_exceptions e SET "safetyAlertId" = a.id FROM safety_alerts a WHERE a."patrolExceptionId" = e.id AND e."companyId" = $1`, [co]);
  await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt")
    SELECT $1, s."guardId", s.id, 'missed_checkcall', 'medium', 'Welfare check missed (synthetic)', 'closed', s.start + interval '2 hours'
      FROM shifts s CROSS JOIN generate_series(1, 5) n WHERE s."companyId" = $1 AND s.status = 'completed' LIMIT 200000`, [co]);
  }
  console.log(`  exceptions + alerts: ${ms(t0).toFixed(0)} ms`);
  if (!(await has(`SELECT count(*) n FROM patrol_checkpoint_visits WHERE "companyId" = $1`))) {
  // The last 30 days: 6 QR scans and 4 photos per patrol.
  await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","receivedAtServer","clientVisitId")
    SELECT r."companyId", r.id, c.id, c."publicId", 'verified', '[]'::jsonb, r."startedAtDevice" + (c.n || ' minutes')::interval, r."startedAtServer" + (c.n || ' minutes')::interval,
           'pvisit-' || lpad(r.id::text, 8, '0') || '-' || c.n
      FROM patrol_runs r JOIN LATERAL (SELECT id, "publicId", row_number() OVER (ORDER BY id) n FROM patrol_checkpoints WHERE "siteId" = r."siteId") c ON true
     WHERE r."companyId" = $1 AND r."windowStart" >= $2::date - 29`, [co, TODAY]);
  await q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId",kind,"uploadStatus","retentionStatus","retentionDays","sha256Client","sha256Stored",
       "storageKey","mimeType","sizeBytes","capturedAtDevice","receivedAt","verifiedAt","expiresAt","clientEvidenceId")
    SELECT r."companyId", r."siteId", r.id, r."guardId", r."shiftId", 'run_photo', 'verified', 'active', 30, md5(r.id || '/' || p) || md5(p || '/' || r.id),
           md5(r.id || '/' || p) || md5(p || '/' || r.id), 'perf/' || r.id || '/' || p || '.jpg', 'image/jpeg', 200000, r."startedAtDevice" + (p || ' minutes')::interval,
           r."startedAtServer" + (p || ' minutes')::interval, r."startedAtServer" + interval '10 minutes', r."startedAtServer" + interval '30 days', 'pevid-' || lpad(r.id::text, 8, '0') || '-' || p
      FROM patrol_runs r CROSS JOIN generate_series(1, 4) p WHERE r."companyId" = $1 AND r."windowStart" >= $2::date - 29`, [co, TODAY]);
  }
  console.log(`  scans + evidence: ${ms(t0).toFixed(0)} ms`);
  await q(`INSERT INTO "patrol_sweep_watermarks" ("companyId","judgedThrough","updatedAt") VALUES ($1,$2,$2) ON CONFLICT ("companyId") DO UPDATE SET "judgedThrough" = EXCLUDED."judgedThrough"`, [co, NOW]);
  await q(`ANALYZE`);
  console.log(`  generated in ${(ms(t0) / 1000).toFixed(1)} s`);
}

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  if (process.env.PERF_RESUME_TAIL) {
    const tail = new DataSource({ ...buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: "false", DATABASE_SYNCHRONIZE: "false", NODE_ENV: "test" }), entities: [], migrations: [] } as never);
    await tail.initialize();
    const [{ id }] = await tail.query(`SELECT id FROM companies WHERE name = 'Perf Security Ltd'`);
    await generateTail(tail, Number(id), process.hrtime.bigint());
    await tail.destroy();
  } else if (!process.env.PERF_SKIP_GENERATE) {
    const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
    const files: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
    const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
    // Sessions in UTC, as production's database (date arithmetic in the generator must not cross a local DST change).
    const tz = new DataSource({ ...base, entities: [], migrations: [] } as never);
    await tz.initialize();
    await tz.query(`ALTER DATABASE "${new URL(url!).pathname.slice(1)}" SET timezone TO 'UTC'`);
    await tz.destroy();
    const migrate = new DataSource({ ...base, entities: [], migrations: files.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
    await migrate.initialize();
    const done = await migrate.runMigrations({ transaction: 'each' });
    assert.equal(done[done.length - 1]?.name, 'AddPatrolSiteSetup1720900000021');
    console.log(`Generating: ${SITES} sites, ${DAYS} days`);
    await generate(migrate);
    await migrate.destroy();
  }

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
  const { PatrolMonitorService } = await import('../src/patrol/patrol-monitor.service');
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const monitor = app.get(PatrolMonitorService);
  const q = (sql: string, p: unknown[] = []) => ds.query(sql, p);

  const volumes = (await q(`SELECT relname t, n_live_tup::bigint n FROM pg_stat_user_tables WHERE relname IN
    ('patrol_runs','patrol_checkpoint_visits','patrol_evidence','patrol_exceptions','safety_alerts','shifts','attendance_events','sites') ORDER BY relname`))
    .map((r: any) => `${r.t} ${Number(r.n).toLocaleString('en-GB')}`).join(' · ');
  console.log(`\nVolumes: ${volumes}`);
  const [owner] = await q(`SELECT u.id, u.email FROM users u WHERE u.email = 'perf.owner@example.invalid'`);
  const user = { sub: Number(owner.id), email: owner.email, role: 'company_admin', status: 'active' } as any;
  const token = ((await app.get(AuthService).login({ email: owner.email, password: PASSWORD } as never)) as any).accessToken as string;
  const sites = (await q(`SELECT s.id, (p."requirementScope" = 'per_guard') AS pg FROM sites s LEFT JOIN patrol_policies p ON p."siteId" = s.id ORDER BY s.id`));
  const siteWide = Number(sites.find((s: any) => !s.pg).id);
  const perGuard = Number(sites.find((s: any) => s.pg).id);

  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const capture = async (fn: () => Promise<unknown>) => {
    const original = ds.query.bind(ds);
    captured.length = 0;
    (ds as any).query = (sql: string, params?: unknown[]) => { captured.push({ sql, params: params ?? [] }); return (original as any)(sql, params); };
    try { await fn(); } finally { (ds as any).query = original; }
    return [...captured];
  };

  const bench = async (label: string) => {
    console.log(`\n── ${label} ──`);
    const run = async (name: string, fn: () => Promise<unknown>) => {
      await fn(); // warm
      const xs: number[] = [];
      for (let i = 0; i < ITER; i += 1) { const t0 = process.hrtime.bigint(); await fn(); xs.push(ms(t0)); }
      console.log(`  ${name.padEnd(46)} ${fmt(xs)}`);
      return xs;
    };
    await run('summary, all 50 sites (service)', () => monitor.summary(user, { date: TODAY }, NOW));
    await run('site day, site-wide site (service)', () => monitor.site(user, siteWide, { date: TODAY }, NOW));
    await run('site day, per-guard site (service)', () => monitor.site(user, perGuard, { date: TODAY }, NOW));
    await run('site live 36 h, per-guard site (service)', () => monitor.site(user, perGuard, { from: '2026-11-01T02:00:00Z', to: '2026-11-02T14:00:00Z' }, NOW));
    await run('site day 30 days ago, per-guard (service)', () => monitor.site(user, perGuard, { date: '2026-10-03' }, NOW));
    let bytes = 0;
    let gz = 0;
    await run('GET /patrols/monitor/summary (HTTP)', async () => {
      const r = await fetch(`${baseUrl}/patrols/monitor/summary`, { headers: { authorization: `Bearer ${token}` } });
      const text = await r.text();
      assert.equal(r.status, 200, text.slice(0, 200));
      bytes = Buffer.byteLength(text); gz = gzipSync(text).length;
    });
    console.log(`    summary response ${(bytes / 1024).toFixed(1)} KB JSON, ${(gz / 1024).toFixed(1)} KB gzipped`);
    await run('GET /patrols/monitor/sites/:id day (HTTP)', async () => {
      const r = await fetch(`${baseUrl}/patrols/monitor/sites/${perGuard}?date=${TODAY}`, { headers: { authorization: `Bearer ${token}` } });
      const text = await r.text();
      assert.equal(r.status, 200, text.slice(0, 200));
      bytes = Buffer.byteLength(text); gz = gzipSync(text).length;
    });
    console.log(`    site response ${(bytes / 1024).toFixed(1)} KB JSON, ${(gz / 1024).toFixed(1)} KB gzipped`);
  };

  const explain = async (label: string) => {
    console.log(`\n── EXPLAIN (${label}) ──`);
    const summaryQueries = await capture(() => monitor.summary(user, { date: TODAY }, NOW));
    const siteQueries = await capture(() => monitor.site(user, perGuard, { date: TODAY }, NOW));
    const interesting = [...summaryQueries, ...siteQueries].filter((x) => /FROM "(patrol_runs|patrol_exceptions|shifts|safety_alerts|attendance_events|patrol_checkpoint_visits|patrol_evidence)"/.test(x.sql));
    const seen = new Set<string>();
    for (const x of interesting) {
      const key = x.sql.replace(/\s+/g, ' ').slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const plan = (await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${x.sql}`, x.params))[0]['QUERY PLAN'][0];
      const nodes: string[] = [];
      const walk = (n: any) => { nodes.push(`${n['Node Type']}${n['Index Name'] ? ` ${n['Index Name']}` : n['Relation Name'] ? ` ${n['Relation Name']}` : ''}`); (n.Plans ?? []).forEach(walk); };
      walk(plan.Plan);
      const scanned = nodes.filter((n) => /Scan/.test(n)).join(', ');
      console.log(`  ${plan['Execution Time'].toFixed(2).padStart(8)} ms  buffers ${String((plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0)).padStart(6)}  ${key.slice(0, 70)}…\n             ${scanned}`);
    }
    console.log(`  queries per request: summary ${summaryQueries.length}, site ${siteQueries.length}`);
  };

  try {
    for (const c of CANDIDATES) await q(`DROP INDEX IF EXISTS "${c.name}"`);
    await explain('existing indexes only');
    await bench('existing indexes only');
    for (const c of CANDIDATES) await q(c.sql);
    await q('ANALYZE');
    await explain('with the candidate indexes');
    await bench('with the candidate indexes');
    const sizes = await q(`SELECT relname n, pg_size_pretty(pg_relation_size(oid)) s FROM pg_class WHERE relname = ANY($1::text[])`, [CANDIDATES.map((c) => c.name)]);
    console.log(`\nCandidate index sizes: ${sizes.map((r: any) => `${r.n} ${r.s}`).join(' · ')}`);
  } finally {
    for (const c of CANDIDATES) await q(`DROP INDEX IF EXISTS "${c.name}"`);
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
