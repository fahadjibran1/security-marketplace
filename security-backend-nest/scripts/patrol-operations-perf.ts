/**
 * S3 Stage 2 benchmark (on demand; NOT in the release gate): GET /patrols/operations/attention and
 * GET /patrols/exceptions/:id/investigation on synthetic companies of 10, 25 and 50 sites with a year of history.
 *
 * Per site and day: one 08:00–20:00 shift, 12 hourly site-wide windows, a completed patrol for ~97 % of them and a missed
 * exception (with its one alert) for the rest; ~1 % of patrols also an incomplete exception. History is resolved; the
 * newest PERF_OPEN_PER_SITE cases per site are open or acknowledged. Every company also carries PERF_ALERT_HISTORY_PER_SITE
 * closed non-patrol alerts per site, so a query that walked the alert history would show. The last 3 days of patrols have
 * QR visits and photo evidence rows. Sites rotate London / New York / Kolkata.
 *
 * Prints per company: endpoint timings (median, p95, max over PERF_ITERATIONS), payload size, every SQL statement each
 * endpoint issues with EXPLAIN (ANALYZE, BUFFERS) execution time, plan nodes and whether it sequentially scans a large
 * table; then the same with each candidate index (created in this database only, then dropped).
 *
 *   PATROL_OPERATIONS_PERF_DATABASE_URL  disposable LOCAL database (the schema is dropped)
 *   PERF_DAYS=365  PERF_OPEN_PER_SITE=6  PERF_ALERT_HISTORY_PER_SITE=4000  PERF_ITERATIONS=20  PERF_SKIP_GENERATE=1 (reuse data)
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource, EntityManager } from 'typeorm';

const url = process.env.PATROL_OPERATIONS_PERF_DATABASE_URL;
if (!url) throw new Error('PATROL_OPERATIONS_PERF_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Perf database must be local');
process.env.DATABASE_URL = url;
delete process.env.DATABASE_POOLER_URL;
process.env.DATABASE_SSL = 'false';
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'patrol-operations-perf-secret-not-production';
process.env.GUARD_DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY ||= 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
delete process.env.RESEND_API_KEY;
delete process.env.EXPO_ACCESS_TOKEN;

const DAYS = Number(process.env.PERF_DAYS ?? 365);
const OPEN_PER_SITE = Number(process.env.PERF_OPEN_PER_SITE ?? 6);
const HISTORY_PER_SITE = Number(process.env.PERF_ALERT_HISTORY_PER_SITE ?? 4000);
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 20);
/** S3 Stage 4: the existing GET /alerts/company read Live Operations still polls (owner account: every alert of the company). */
const ALERT_ITERATIONS = Number(process.env.PERF_ALERT_ITERATIONS ?? 5);
const SKIP_CANDIDATES = Boolean(process.env.PERF_SKIP_CANDIDATES);
const SCALES = [10, 25, 50];
const CANDIDATES: Array<{ name: string; sql: string }> = [
  { name: 'cand_exceptions_missed_day', sql: `CREATE INDEX cand_exceptions_missed_day ON patrol_exceptions ("companyId", "windowStart") WHERE type = 'patrol_missed'` },
];

const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const { buildTypeOrmOptions } = await import('../src/database/typeorm.config');
  const base = buildTypeOrmOptions({ DATABASE_URL: url!, DATABASE_SSL: 'false', DATABASE_SYNCHRONIZE: 'false', NODE_ENV: 'test' });
  if (!process.env.PERF_SKIP_GENERATE) {
    const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
    const files: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
    const migrate = new DataSource({ ...base, entities: [], migrations: files.map((f) => path.join(migrationsDir, f)), dropSchema: true } as never);
    await migrate.initialize();
    await migrate.runMigrations({ transaction: 'each' });
    await migrate.destroy();
  }
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const ds = app.get(DataSource);
  const { PatrolSweepService } = await import('../src/patrol/patrol-sweep.service');
  const { SafetyAlertService } = await import('../src/safety-alert/safety-alert.service');
  const { PatrolOperationsService } = await import('../src/patrol/patrol-operations.service');
  app.get(PatrolSweepService).onModuleDestroy();
  app.get(SafetyAlertService).onModuleDestroy();
  const operations = app.get(PatrolOperationsService);
  const alertService = app.get(SafetyAlertService);
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const companies: Array<{ sites: number; companyId: number; ownerId: number }> = [];
  if (!process.env.PERF_SKIP_GENERATE) {
    const genStart = process.hrtime.bigint();
    let seq = 0;
    for (const n of SCALES) {
      seq += 1;
      const [{ id: ownerId }] = await q(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
        VALUES ($1,'x','company_admin','active',true,false,'Perf','Owner') RETURNING id`, [`perf.ops.${n}@example.invalid`]);
      const [{ id: co }] = await q(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails","patrolsEnabled") VALUES ($1,$2,$3,'1 Way','ops@example.invalid',true) RETURNING id`,
        [ownerId, `Perf ${n} sites Ltd`, String(99100000 + seq)]);
      await q(`INSERT INTO sites ("companyId",name,address,timezone,"clientName")
        SELECT $1, 'Site ' || lpad(s::text, 2, '0'), s || ' Quay', (ARRAY['Europe/London','America/New_York','Asia/Kolkata'])[1 + (s % 3)], 'Client ' || ((s - 1) % 10 + 1)
          FROM generate_series(1, $2) s`, [co, n]);
      await q(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","emailVerificationRequired","firstName","lastName")
        SELECT 'perf.ops.' || $1 || '.g' || g || '@example.invalid', 'x', 'guard', 'active', true, false, 'Guard', g::text FROM generate_series(1, $2) g`, [n, n]);
      await q(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone)
        SELECT u.id, 'Guard ' || u."lastName" || ' (' || $1 || ')', lpad((u.id * 7919)::text, 16, '9'), '07' || lpad(u.id::text, 9, '0')
          FROM users u WHERE u.email LIKE 'perf.ops.' || $1 || '.g%'`, [n]);
      await q(`INSERT INTO patrol_policies ("companyId","siteId","methods") SELECT $1, id, '["qr","photo"]'::jsonb FROM sites WHERE "companyId" = $1`, [co]);
      await q(`INSERT INTO patrol_checkpoints ("companyId","siteId","publicId",label) SELECT $1, s.id, md5(s.id || ':' || c), 'Checkpoint ' || c FROM sites s CROSS JOIN generate_series(1, 4) c WHERE s."companyId" = $1`, [co]);
      await q(`INSERT INTO patrol_routes ("companyId","siteId",name) SELECT $1, id, 'Perimeter' FROM sites WHERE "companyId" = $1`, [co]);
      await q(`INSERT INTO patrol_route_checkpoints ("companyId","siteId","routeId","checkpointId",position)
        SELECT $1, c."siteId", r.id, c.id, row_number() OVER (PARTITION BY c."siteId" ORDER BY c.id) FROM patrol_checkpoints c JOIN patrol_routes r ON r."siteId" = c."siteId" WHERE c."companyId" = $1`, [co]);
      await q(`INSERT INTO patrol_schedules ("companyId","siteId","routeId",name,"daysOfWeek","activeFrom","activeTo","frequencyMinutes","windowMinutes",active,"createdAt","updatedAt")
        SELECT $1, s.id, r.id, 'Hourly', '[1,2,3,4,5,6,7]'::jsonb, '08:00', '20:00', 60, 60, true, now() - interval '400 days', now() - interval '400 days'
          FROM sites s JOIN patrol_routes r ON r."siteId" = s.id WHERE s."companyId" = $1`, [co]);
      // Sites and their Guards, paired by order.
      await q(`CREATE TEMP TABLE IF NOT EXISTS perf_pairs (co int, site int, guard int, guard_user int, sched int, route int)`);
      await q(`INSERT INTO perf_pairs SELECT $1, s.id, g.id, g."userId", sc.id, sc."routeId" FROM
          (SELECT id, row_number() OVER (ORDER BY id) rn FROM sites WHERE "companyId" = $1) s
          JOIN (SELECT gp.id, gp."userId", row_number() OVER (ORDER BY gp.id) rn FROM guard_profiles gp JOIN users u ON u.id = gp."userId" WHERE u.email LIKE 'perf.ops.' || $2 || '.g%') g ON g.rn = s.rn
          JOIN patrol_schedules sc ON sc."siteId" = s.id`, [co, n]);
      await q(`INSERT INTO shifts ("companyId","siteId","siteName","guardId",status,start,"end")
        SELECT p.co, p.site, 'Gate', p.guard, 'completed', d + interval '8 hours', d + interval '20 hours'
          FROM perf_pairs p CROSS JOIN generate_series(date_trunc('day', now()) - ($2::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') d
         WHERE p.co = $1`, [co, DAYS]);
      // Windows: 12 a day per site. hash < 3 => missed (no run); else a completed patrol.
      await q(`CREATE TEMP TABLE IF NOT EXISTS perf_windows (co int, site int, guard int, guard_user int, sched int, route int, shift int, ws timestamptz, wkey text, h int)`);
      await q(`INSERT INTO perf_windows
        SELECT p.co, p.site, p.guard, p.guard_user, p.sched, p.route, sh.id, w, 's' || p.sched || ':' || to_char(w, 'YYYYMMDD"T"HH24MI"Z"') || ':0',
               abs(hashtext(p.site || ':' || w::text)) % 100
          FROM perf_pairs p JOIN shifts sh ON sh."siteId" = p.site
          CROSS JOIN LATERAL generate_series(sh.start, sh."end" - interval '1 hour', interval '1 hour') w
         WHERE p.co = $1`, [co]);
      await q(`INSERT INTO patrol_runs ("companyId","siteId","shiftId","guardId","startedByUserId","scheduleId","routeId","windowKey","windowStart","windowEnd","scopeKey",
               status,"verificationStatus","startedAtDevice","startedAtServer","completedAtDevice","completedAtServer","clientRunId")
        SELECT co, site, shift, guard, guard_user, sched, route, wkey, ws, ws + interval '1 hour', 'site', 'completed', 'verified',
               ws + interval '5 minutes', ws + interval '5 minutes', ws + interval '20 minutes', ws + interval '20 minutes', 'perf-' || site || '-' || extract(epoch from ws)::bigint
          FROM perf_windows WHERE co = $1 AND h >= 3`, [co]);
      await q(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","guardId","windowKey","scopeKey","windowStart","windowEnd",type,status,"resolvedAt","createdAt")
        SELECT co, site, sched, shift, guard, wkey, 'site', ws, ws + interval '1 hour', 'patrol_missed', 'resolved', ws + interval '3 hours', ws + interval '80 minutes'
          FROM perf_windows WHERE co = $1 AND h < 3`, [co]);
      await q(`INSERT INTO patrol_exceptions ("companyId","siteId","scheduleId","shiftId","guardId","runId","windowKey","scopeKey","windowStart","windowEnd",type,status,"resolvedAt","createdAt")
        SELECT r."companyId", r."siteId", r."scheduleId", r."shiftId", r."guardId", r.id, r."windowKey", 'site', r."windowStart", r."windowEnd", 'patrol_incomplete', 'resolved',
               r."windowEnd" + interval '3 hours', r."windowEnd" + interval '20 minutes'
          FROM patrol_runs r WHERE r."companyId" = $1 AND abs(hashtext('inc' || r.id)) % 100 = 0`, [co]);
      // The newest cases per site are live: open, or acknowledged.
      await q(`UPDATE patrol_exceptions e SET status = CASE WHEN x.rn % 2 = 0 THEN 'acknowledged' ELSE 'open' END, "resolvedAt" = NULL,
                 "acknowledgedAt" = CASE WHEN x.rn % 2 = 0 THEN now() END, "acknowledgedByUserId" = CASE WHEN x.rn % 2 = 0 THEN $3::int END
          FROM (SELECT id, row_number() OVER (PARTITION BY "siteId" ORDER BY "windowStart" DESC, id DESC) rn FROM patrol_exceptions WHERE "companyId" = $1) x
         WHERE e.id = x.id AND x.rn <= $2`, [co, OPEN_PER_SITE, ownerId]);
      // One alert per exception, linked both ways; closed with the exception when resolved.
      await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt","acknowledgedAt","closedAt","patrolExceptionId","patrolWindowKey")
        SELECT e."companyId", e."guardId", e."shiftId", (CASE e.type WHEN 'patrol_missed' THEN 'patrol_missed' ELSE 'patrol_incomplete' END)::safety_alerts_type_enum, 'high',
               'Patrol ' || e.type, (CASE e.status WHEN 'resolved' THEN 'closed' ELSE e.status END)::safety_alerts_status_enum, e."createdAt",
               CASE WHEN e.status <> 'open' THEN e."createdAt" + interval '10 minutes' END, e."resolvedAt", e.id, e."windowKey"
          FROM patrol_exceptions e WHERE e."companyId" = $1`, [co]);
      await q(`UPDATE patrol_exceptions e SET "safetyAlertId" = a.id FROM safety_alerts a WHERE a."patrolExceptionId" = e.id AND e."companyId" = $1`, [co]);
      // Closed non-patrol alert history (Welfare Checks), spread over the year.
      await q(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"createdAt","closedAt")
        SELECT $1, p.guard, NULL, 'missed_checkcall', 'medium', 'Missed Welfare Check', 'closed', now() - (g % $3) * interval '1 day', now() - (g % $3) * interval '1 day'
          FROM perf_pairs p CROSS JOIN generate_series(1, $2) g WHERE p.co = $1`, [co, HISTORY_PER_SITE, DAYS]);
      // The last 3 days: QR visits (3 of 4 checkpoints) and two photos per patrol.
      await q(`INSERT INTO patrol_checkpoint_visits ("companyId","runId","checkpointId","scannedPublicId",result,flags,"scannedAtDevice","clientVisitId")
        SELECT r."companyId", r.id, c.id, c."publicId", 'verified', '[]'::jsonb, r."startedAtServer" + interval '2 minutes', 'pv-' || r.id || '-' || c.id
          FROM patrol_runs r JOIN patrol_checkpoints c ON c."siteId" = r."siteId" AND c.label <> 'Checkpoint 4'
         WHERE r."companyId" = $1 AND r."startedAtServer" > now() - interval '3 days'`, [co]);
      await q(`INSERT INTO patrol_evidence ("companyId","siteId","runId","guardId","shiftId","sha256Client","capturedAtDevice","receivedAt","clientEvidenceId","mimeType","sizeBytes","uploadStatus")
        SELECT r."companyId", r."siteId", r.id, r."guardId", r."shiftId", md5(r.id || ':' || k) || md5(k || ':' || r.id), r."startedAtServer" + interval '3 minutes',
               r."startedAtServer" + interval '4 minutes', 'pe-' || r.id || '-' || k, 'image/jpeg', 200000, 'verified'
          FROM patrol_runs r CROSS JOIN generate_series(1, 2) k WHERE r."companyId" = $1 AND r."startedAtServer" > now() - interval '3 days'`, [co]);
      companies.push({ sites: n, companyId: Number(co), ownerId: Number(ownerId) });
      console.log(`generated ${n} sites`);
    }
    await q('ANALYZE');
    console.log(`generation ${(ms(genStart) / 1000).toFixed(0)} s`);
  } else {
    for (const n of SCALES) {
      const [row] = await q(`SELECT c.id, c."userId" FROM companies c WHERE c.name = $1`, [`Perf ${n} sites Ltd`]);
      companies.push({ sites: n, companyId: Number(row.id), ownerId: Number(row.userId) });
    }
  }
  const [sizes] = await q(`SELECT (SELECT count(*) FROM patrol_runs)::int runs, (SELECT count(*) FROM patrol_exceptions)::int exceptions,
      (SELECT count(*) FROM safety_alerts)::int alerts, (SELECT count(*) FROM patrol_evidence)::int evidence, (SELECT count(*) FROM shifts)::int shifts`);
  console.log('table rows', JSON.stringify(sizes));

  // Record the SQL each endpoint issues (inside its read-only snapshot), to EXPLAIN it afterwards.
  let recording: Array<{ sql: string; params: unknown[] }> | null = null;
  const originalDs = DataSource.prototype.query;
  DataSource.prototype.query = function (this: DataSource, sql: string, params?: unknown[]) {
    if (recording && !/^SET TRANSACTION/.test(sql)) recording.push({ sql, params: params ?? [] });
    return originalDs.call(this, sql, params);
  } as typeof originalDs;
  const original = EntityManager.prototype.query;
  EntityManager.prototype.query = function (this: EntityManager, sql: string, params?: unknown[]) {
    if (recording && !/^SET TRANSACTION/.test(sql)) recording.push({ sql, params: params ?? [] });
    return original.call(this, sql, params);
  } as typeof original;
  const BIG = ['patrol_runs', 'patrol_exceptions', 'safety_alerts', 'patrol_evidence', 'shifts', 'patrol_checkpoint_visits'];
  const explain = async (label: string, statements: Array<{ sql: string; params: unknown[] }>) => {
    for (const [i, s] of statements.entries()) {
      const [{ 'QUERY PLAN': plan }] = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s.sql}`, s.params);
      const nodes: string[] = [];
      const seq: string[] = [];
      const walk = (n: any) => {
        nodes.push(`${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : ''}`);
        if (n['Node Type'] === 'Seq Scan' && BIG.includes(n['Relation Name'])) seq.push(`${n['Relation Name']} rows-removed=${n['Rows Removed by Filter'] ?? 0}`);
        (n.Plans ?? []).forEach(walk);
      };
      walk(plan[0].Plan);
      const firstLine = s.sql.replace(/\s+/g, ' ').trim().slice(0, 90);
      console.log(`    ${label} #${i + 1} ${plan[0]['Execution Time'].toFixed(2)} ms  shared-read=${plan[0].Plan['Shared Read Blocks'] ?? 0} hit=${plan[0].Plan['Shared Hit Blocks'] ?? 0}`
        + `  ${seq.length ? `SEQ SCAN ${seq.join('; ')}` : 'no large seq scan'}\n        ${firstLine}\n        ${[...new Set(nodes)].join(' > ').slice(0, 260)}`);
    }
  };

  const measure = async (tag: string) => {
    for (const c of companies) {
      const user = { sub: c.ownerId, email: 'x', role: 'company_admin', status: 'active' } as any;
      await operations.attention(user); // warm
      const at: number[] = [];
      let body: any = null;
      for (let i = 0; i < ITERATIONS; i += 1) { const t = process.hrtime.bigint(); body = await operations.attention(user); at.push(ms(t)); }
      const sample = await q(`SELECT e.id FROM patrol_exceptions e WHERE e."companyId" = $1 AND e.status <> 'resolved' ORDER BY (e."runId" IS NULL), e.id DESC LIMIT $2`, [c.companyId, ITERATIONS]);
      const inv: number[] = [];
      let invBody: any = null;
      for (const { id } of sample) { const t = process.hrtime.bigint(); invBody = await operations.investigation(user, Number(id)); inv.push(ms(t)); }
      const al: number[] = [];
      let alertBody: any[] = [];
      for (let i = 0; i < ALERT_ITERATIONS; i += 1) { const t = process.hrtime.bigint(); alertBody = await alertService.findForCompany(c.ownerId); al.push(ms(t)); }
      console.log(`[${tag}] ${c.sites} sites: existing /alerts/company ${JSON.stringify(stats(al))} ms, ${alertBody.length} alerts, ${(Buffer.byteLength(JSON.stringify(alertBody)) / 1e6).toFixed(1)} MB`);
      // Stage A scopes (GET /alerts/company?scope=…): live board, a day-mode board 3 days ago, a history page, one shift.
      const dayStart = new Date(Date.now() - 3 * 86_400_000);
      const scopes: Array<[string, any]> = [
        ['operational (live)', { scope: 'operational' }],
        ['operational (day mode)', { scope: 'operational', since: new Date(dayStart.getTime() - 36 * 3_600_000), until: new Date(dayStart.getTime() + 86_400_000) }],
        ['history page 1 (100)', { scope: 'history', page: 1, pageSize: 100 }],
        ['history page 50 (100)', { scope: 'history', page: 50, pageSize: 100 }],
      ];
      const [shiftRow] = await q(`SELECT "shiftId" FROM safety_alerts WHERE "companyId" = $1 AND "shiftId" IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.companyId]);
      if (shiftRow) scopes.push(['shift record', { scope: 'shift', shiftId: Number(shiftRow.shiftId) }]);
      for (const [label, query] of scopes) {
        const times: number[] = [];
        let res: any = null;
        for (let i = 0; i < ITERATIONS; i += 1) { const t = process.hrtime.bigint(); res = await alertService.scopedForCompany(c.ownerId, query); times.push(ms(t)); }
        const rows = (res.alerts ?? res.items).length;
        console.log(`[${tag}] ${c.sites} sites: scope ${label} ${JSON.stringify(stats(times))} ms, ${rows} alerts, ${(Buffer.byteLength(JSON.stringify(res)) / 1e6).toFixed(2)} MB${res.counts ? `, unresolved ${res.counts.unresolved}` : ''}${res.total != null ? `, total ${res.total}` : ''}`);
        if (c.sites === 50) {
          recording = [];
          await alertService.scopedForCompany(c.ownerId, query);
          const sqls = recording.filter((x) => /safety_alerts/.test(x.sql) && /SELECT a\."id"|count\(\*\)/.test(x.sql));
          recording = null;
          await explain(`scope ${label}`, sqls);
        }
      }
      console.log(`[${tag}] ${c.sites} sites: attention ${JSON.stringify(stats(at))} ms, ${Buffer.byteLength(JSON.stringify(body))} bytes, ${body.cases.length}/${body.counts.patrolAlerts} cases, missedToday ${body.counts.missedToday}`
        + ` | investigation ${JSON.stringify(stats(inv))} ms, ${Buffer.byteLength(JSON.stringify(invBody))} bytes`);
      if (c.sites === 50) {
        recording = [];
        await operations.attention(user);
        const attentionSql = recording;
        recording = [];
        const withRun = sample.find(() => true);
        await operations.investigation(user, Number(withRun.id));
        const investigationSql = recording;
        recording = null;
        await explain('attention', attentionSql);
        await explain('investigation', investigationSql);
      }
    }
  };

  await measure('baseline');
  // The existing Live Operations count reads the alert history directly, for comparison.
  const big = companies.find((c) => c.sites === 50)!;
  await explain('existing liveOps openPatrolAlerts', [{ sql: `SELECT count(*)::int AS n FROM "safety_alerts" WHERE "companyId" = $1 AND "type"::text = ANY($2::text[]) AND "status"::text <> 'closed'`,
    params: [big.companyId, ['patrol_missed', 'patrol_abandoned', 'patrol_incomplete', 'checkpoint_missed', 'patrol_unverified']] }]);
  for (const cand of SKIP_CANDIDATES ? [] : CANDIDATES) {
    await q(cand.sql);
    await q('ANALYZE patrol_exceptions');
    await measure(cand.name);
    await q(`DROP INDEX ${cand.name}`);
  }
  EntityManager.prototype.query = original;
  DataSource.prototype.query = originalDs;
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
