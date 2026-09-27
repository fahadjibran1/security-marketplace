/**
 * Migration rehearsal for 58 → 59 (AddWelfareWindowEvidence).
 *
 * Runs the repository's own migrations against a disposable PostgreSQL (16 or newer), rolls back to the schema
 * production is on today (58), seeds rows exactly as production holds them — a CompanyGuard
 * relationship established by invitation, a site, a daily log and a legacy rolling welfare alert —
 * then applies 59 and proves every one of them survives untouched, the new columns default to NULL,
 * the partial unique indexes and enum labels exist, a second run is a no-op, and down() is clean.
 *
 * Migration 59 deliberately runs outside a transaction, because it adds enum values and then creates
 * an index whose predicate uses one of them; this rehearsal is what proves that choice is safe.
 *
 * Needs WELFARE_MIGRATION_DATABASE_URL pointing at a DISPOSABLE database.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.WELFARE_MIGRATION_DATABASE_URL;
if (!url) throw new Error('WELFARE_MIGRATION_DATABASE_URL is required (disposable database)');
if (!/127\.0\.0\.1|localhost/.test(url)) {
  throw new Error('WELFARE_MIGRATION_DATABASE_URL must point at a local disposable database');
}

const migrationsGlob = require('node:path').join(__dirname, '..', 'src', 'database', 'migrations', '*.ts');
const base = {
  type: 'postgres' as const,
  url,
  entities: appEntities,
  synchronize: false,
  migrationsTableName: 'typeorm_migrations',
  logging: false,
};

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

const MIGRATION_59 = 'AddWelfareWindowEvidence1720900000005';

/** The oldest PostgreSQL this schema is run against anywhere: CI uses 16, production and local 17. */
const MINIMUM_POSTGRES_MAJOR = 16;

async function main() {
  const ds = new DataSource({ ...base, migrations: [migrationsGlob] });
  await ds.initialize();

  const scalar = async (sql: string, params: unknown[] = []) =>
    Object.values((await ds.query(sql, params))[0] ?? {})[0];
  const columnExists = (table: string, column: string) =>
    scalar(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS present`,
      [table, column],
    );
  const indexDef = (name: string) =>
    scalar(`SELECT indexdef FROM pg_indexes WHERE indexname=$1`, [name]).catch(() => undefined);
  const enumHas = (type: string, label: string) =>
    scalar(
      `SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
         WHERE t.typname=$1 AND e.enumlabel=$2) AS present`,
      [type, label],
    );
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int n FROM typeorm_migrations'));

  try {
    assert.equal(ds.options.synchronize, false, 'DATABASE_SYNCHRONIZE must remain false');

    const applied = await ds.runMigrations({ transaction: 'each' });
    // Located by name rather than by a total, so a later migration does not break this rehearsal the
    // way a hard-coded count broke the Phase B one.
    const subjectIndex = applied.findIndex((migration) => migration.name === MIGRATION_59);
    await test('M59-APPLIES-ON-A-SUPPORTED-POSTGRES', async () => {
      const version = String(await scalar('SHOW server_version'));
      // A compatibility floor, not an exact version. Migration 59 needs nothing newer than
      // PostgreSQL 12 — ALTER TYPE ... ADD VALUE IF NOT EXISTS, partial unique indexes and running
      // outside a transaction are all long-standing — so requiring exactly 17 turned the local
      // rehearsal environment into a release requirement and failed CI, which runs PostgreSQL 16 by
      // deliberate choice. The dedicated local rehearsal on 17.x remains the PostgreSQL 17 evidence.
      const major = Number(/^(\d+)/.exec(version)?.[1]);
      console.log(`      server_version = ${version} (major ${major})`);
      assert.ok(Number.isInteger(major), `could not parse a major version from ${version}`);
      assert.ok(major >= MINIMUM_POSTGRES_MAJOR, `PostgreSQL ${MINIMUM_POSTGRES_MAJOR}+ required, found ${version}`);
      assert.ok(subjectIndex >= 0, `${MIGRATION_59} must be among the ${applied.length} applied migrations`);
    });

    // ── down() ────────────────────────────────────────────────────────────────────────────────────
    for (let index = applied.length - 1; index >= subjectIndex; index -= 1) {
      await ds.undoLastMigration({ transaction: 'each' });
    }
    await test('M59-ROLLS-BACK-TO-BEFORE-SUBJECT', async () => {
      assert.equal(await migrationCount(), subjectIndex, 'back to the schema immediately before it');
    });

    await test('M59-DOWN-REMOVES-EVERYTHING-IT-ADDED', async () => {
      assert.equal(await columnExists('safety_alerts', 'welfareWindowIndex'), false);
      assert.equal(await columnExists('sites', 'logBookIntervalMinutes'), false);
      for (const index of [
        'uq_safety_alerts_shift_welfare_window',
        'uq_safety_alerts_shift_missing_book_off',
        'idx_attendance_events_shift_occurred',
        'idx_daily_logs_shift_created',
        'idx_daily_logs_company_type_created',
      ]) {
        assert.equal(await indexDef(index), undefined, `${index} must be gone after down()`);
      }
      // Enum labels deliberately survive: PostgreSQL cannot drop one, and both types are shared with
      // existing rows. Migration 58 leaves its shared enum in place for the same reason.
      assert.equal(await enumHas('safety_alerts_type_enum', 'missing_book_off'), true);
      assert.equal(await enumHas('daily_logs_logtype_enum', 'log_book'), true);
    });

    // ── seed production-shaped rows at 58 ─────────────────────────────────────────────────────────
    const ownerId = Number(
      await scalar(
        `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
         VALUES ('w2.owner@example.invalid','x','company_admin','active',true) RETURNING id`,
      ),
    );
    const companyId = Number(
      await scalar(
        `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails")
         VALUES ($1,'W2 Security Ltd','55443322','1 Rehearsal Way','ops@example.invalid') RETURNING id`,
        [ownerId],
      ),
    );
    const guardUserId = Number(
      await scalar(
        `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
         VALUES ('w2.guard@example.invalid','x','guard','active',true) RETURNING id`,
      ),
    );
    const guardId = Number(
      await scalar(
        `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone)
         VALUES ($1,'Rehearsal Guard','7300000000000055','07700000000') RETURNING id`,
        [guardUserId],
      ),
    );
    const invitationId = Number(
      await scalar(
        `INSERT INTO company_guard_invitations
           ("companyId","relationshipType","tokenDigest","expiresAt","usedAt","invitedByUserId")
         VALUES ($1,'EMPLOYEE',repeat('a',64), now() + interval '7 days', now(), $2) RETURNING id`,
        [companyId, ownerId],
      ),
    );
    await ds.query(
      `INSERT INTO company_guards ("companyId","guardId",status,"relationshipType","acceptedAt","invitationId")
       VALUES ($1,$2,'ACTIVE','EMPLOYEE', now(), $3)`,
      [companyId, guardId, invitationId],
    );
    const siteId = Number(
      await scalar(
        `INSERT INTO sites ("companyId",name,address,"welfareCheckIntervalMinutes",timezone)
         VALUES ($1,'Rehearsal Site','2 Rehearsal Way',60,'Europe/London') RETURNING id`,
        [companyId],
      ),
    );
    const shiftId = Number(
      await scalar(
        `INSERT INTO shifts ("companyId","guardId","siteId","siteName",start,"end",status,"checkCallIntervalMinutes")
         VALUES ($1,$2,$3,'Rehearsal Site', now() - interval '3 hours', now() + interval '9 hours','in_progress',60)
         RETURNING id`,
        [companyId, guardId, siteId],
      ),
    );
    await ds.query(
      `INSERT INTO daily_logs ("companyId","guardId","shiftId",message,"logType")
       VALUES ($1,$2,$3,'historical observation','observation')`,
      [companyId, guardId, shiftId],
    );
    // A welfare alert exactly as the old rolling sweep wrote it, and a historical Site Request.
    await ds.query(
      `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
       VALUES ($1,$2,$3,'missed_checkcall','high','Welfare check overdue by more than 60 minutes.','open'),
              ($1,$2,$3,'welfare','medium','Bathroom light out','open')`,
      [companyId, guardId, shiftId],
    );

    const before = {
      relationship: (await ds.query(`SELECT * FROM company_guards WHERE "companyId"=$1`, [companyId]))[0],
      invitations: Number(await scalar('SELECT count(*)::int n FROM company_guard_invitations')),
      sites: Number(await scalar('SELECT count(*)::int n FROM sites')),
      logs: Number(await scalar('SELECT count(*)::int n FROM daily_logs')),
      alerts: Number(await scalar('SELECT count(*)::int n FROM safety_alerts')),
    };

    // ── forward again ─────────────────────────────────────────────────────────────────────────────
    const reapplied = await ds.runMigrations({ transaction: 'each' });
    await test('M59-REAPPLIES-OVER-EXISTING-DATA', async () => {
      assert.ok(reapplied.length >= 1, 'the subject migration must be pending again');
      assert.equal(reapplied[0].name, MIGRATION_59, 'and it must be the first one re-applied');
      assert.equal(await migrationCount(), applied.length, 'back to the full set');
    });

    await test('M59-EXISTING-ROWS-SURVIVE-UNCHANGED', async () => {
      const after = (await ds.query(`SELECT * FROM company_guards WHERE "companyId"=$1`, [companyId]))[0];
      assert.deepEqual(after, before.relationship, 'the invited CompanyGuard relationship is untouched');
      assert.equal(Number(await scalar('SELECT count(*)::int n FROM company_guard_invitations')), before.invitations);
      assert.equal(Number(await scalar('SELECT count(*)::int n FROM sites')), before.sites);
      assert.equal(Number(await scalar('SELECT count(*)::int n FROM daily_logs')), before.logs);
      assert.equal(Number(await scalar('SELECT count(*)::int n FROM safety_alerts')), before.alerts);
      assert.equal(
        await scalar(`SELECT "logType" FROM daily_logs WHERE message='historical observation'`),
        'observation',
        'an observation is still an observation',
      );
      assert.equal(
        Number(await scalar(`SELECT count(*)::int n FROM safety_alerts WHERE type='welfare'`)),
        1,
        'the historical Site Request keeps type welfare',
      );
    });

    await test('M59-LEGACY-ALERT-IS-NOT-BACKFILLED', async () => {
      const legacy = Number(
        await scalar(
          `SELECT count(*)::int n FROM safety_alerts
             WHERE type='missed_checkcall' AND "welfareWindowIndex" IS NULL`,
        ),
      );
      assert.equal(legacy, 1, 'the old rolling alert keeps a NULL window index');
      assert.equal(
        Number(await scalar(`SELECT count(*)::int n FROM safety_alerts WHERE "welfareWindowIndex" IS NOT NULL`)),
        0,
        'nothing was invented as per-window evidence',
      );
    });

    await test('M59-NEW-COLUMNS-ARE-NULLABLE-AND-DEFAULT-NULL', async () => {
      const alertCol = (
        await ds.query(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_name='safety_alerts' AND column_name='welfareWindowIndex'`,
        )
      )[0];
      assert.equal(alertCol.data_type, 'integer');
      assert.equal(alertCol.is_nullable, 'YES');
      assert.equal(alertCol.column_default, null);

      const siteCol = (
        await ds.query(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_name='sites' AND column_name='logBookIntervalMinutes'`,
        )
      )[0];
      assert.equal(siteCol.data_type, 'integer');
      assert.equal(siteCol.is_nullable, 'YES');
      assert.equal(siteCol.column_default, null, 'no default, so no site acquires an obligation');
      assert.equal(
        await scalar(`SELECT "logBookIntervalMinutes" FROM sites WHERE id=$1`, [siteId]),
        null,
        'the pre-existing site is left as "as required"',
      );
    });

    await test('M59-ENUM-LABELS-EXIST', async () => {
      assert.equal(await enumHas('daily_logs_logtype_enum', 'log_book'), true);
      assert.equal(await enumHas('safety_alerts_type_enum', 'site_request'), true);
      assert.equal(await enumHas('safety_alerts_type_enum', 'missing_book_off'), true);
      assert.equal(await enumHas('safety_alerts_type_enum', 'welfare'), true, 'and welfare still exists');
    });

    await test('M59-PARTIAL-UNIQUE-INDEXES-EXIST-AND-BITE', async () => {
      const welfareIdx = String(await indexDef('uq_safety_alerts_shift_welfare_window'));
      assert.match(welfareIdx, /UNIQUE/);
      assert.match(welfareIdx, /"welfareWindowIndex" IS NOT NULL/);
      const bookOffIdx = String(await indexDef('uq_safety_alerts_shift_missing_book_off'));
      assert.match(bookOffIdx, /UNIQUE/);
      assert.match(bookOffIdx, /missing_book_off/);

      // Prove they actually constrain, rather than merely existing.
      await ds.query(
        `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"welfareWindowIndex")
         VALUES ($1,$2,$3,'missed_checkcall','high','w0','closed',0)`,
        [companyId, guardId, shiftId],
      );
      await assert.rejects(
        ds.query(
          `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status,"welfareWindowIndex")
           VALUES ($1,$2,$3,'missed_checkcall','high','w0 again','closed',0)`,
          [companyId, guardId, shiftId],
        ),
        /duplicate key|unique/i,
        'a second row for the same window must be refused',
      );
      await ds.query(
        `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
         VALUES ($1,$2,$3,'missing_book_off','medium','no book off','open')`,
        [companyId, guardId, shiftId],
      );
      await assert.rejects(
        ds.query(
          `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
           VALUES ($1,$2,$3,'missing_book_off','medium','again','open')`,
          [companyId, guardId, shiftId],
        ),
        /duplicate key|unique/i,
        'a second missing_book_off for the same shift must be refused',
      );
      // And the summary/legacy shape stays unconstrained: several NULL-index rows are allowed.
      await ds.query(
        `INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,message,status)
         VALUES ($1,$2,$3,'missed_checkcall','high','another summary-shaped row','closed')`,
        [companyId, guardId, shiftId],
      );
    });

    await test('M59-OPERATIONS-LOG-RANGE-INDEXES-EXIST', async () => {
      assert.match(String(await indexDef('idx_attendance_events_shift_occurred')), /"shiftId", "occurredAt"/);
      assert.match(String(await indexDef('idx_daily_logs_shift_created')), /"shiftId", "createdAt"/);
      assert.match(
        String(await indexDef('idx_daily_logs_company_type_created')),
        /"companyId", "logType", "createdAt"/,
      );
    });

    await test('M59-SECOND-RUN-IS-A-NO-OP', async () => {
      const again = await ds.runMigrations({ transaction: 'each' });
      assert.equal(again.length, 0, 'nothing pending on a second run');
      assert.equal(await migrationCount(), applied.length);
    });

    console.log(JSON.stringify({ event: 'welfare_evidence_migration_certified', tests: passed }));
  } finally {
    await ds.destroy();
  }
}

main().catch((error) => {
  console.error(`\nFAIL  ${error?.message || error}`);
  console.error(error);
  process.exit(1);
});
