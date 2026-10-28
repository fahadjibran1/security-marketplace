/**
 * Migration 63 certification (AddComplianceLapseAlerts).
 *
 * Against a fresh, disposable PostgreSQL:
 *
 *   M63-01  a fresh database migrates 0 → 63 (the subject); the only migration after it is 64 (AddShiftAmendments)
 *   M63-02  down() (with no compliance lapse alerts) returns to 62 and removes the columns and indexes it
 *           added and nothing else; the enum label is deliberately kept (as migrations 58 / 59 do)
 *   M63-03  production-shaped alerts seeded at 62 (panic, welfare evidence + summary, missing Book Off,
 *           acknowledged and closed, with resolution evidence) survive 62 → 63 unchanged, new columns NULL
 *   M63-04  the approved schema: three nullable varchar columns, two partial unique indexes, one enum label
 *   M63-05  the partial unique indexes: one ACTIVE lapse per company + shift + category; one row per lapse key
 *   M63-06  a second migration run applies nothing; up() is safe to repeat statement by statement
 *   M63-07  re-applying after down() restores the identical schema
 *   M63-08  down() refuses while any compliance lapse alert exists, and changes nothing
 *   M63-09  rollback: the previous release's pre-deploy migration run against a 63 database is a no-op
 *   M63-10  no drift introduced by 63 (entity vs schema), and no enum / column changes elsewhere
 *
 * Needs M63_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M63_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M63_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('M63_MIGRATION_DATABASE_URL must point at a local disposable database');
}

const MIGRATION_63 = 'AddComplianceLapseAlerts1720900000009';
const MIGRATION_62 = 'AddGuardComplianceChecks1720900000008';
const NEW_COLUMNS = ['complianceCategory', 'complianceReason', 'lapseKey'];
const NEW_INDEXES = ['uq_safety_alerts_compliance_lapse_active', 'uq_safety_alerts_compliance_lapse_key'];

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

async function main() {
  const path = require('node:path');
  const fs = require('node:fs');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allFiles: string[] = fs.readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  // Migration 63 is the subject: the suite runs through 63 only, exactly as m62-migration.spec.ts runs through 62.
  // Migration 64 (AddShiftAmendments) is certified by m64-migration.spec.ts.
  const throughM63 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000009);
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true,
    migrations: throughM63.map((f) => path.join(migrationsDir, f)), migrationsTableName: 'typeorm_migrations', logging: false,
  });
  await ds.initialize();

  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await ds.query(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));
  const enumLabels = async () =>
    (await ds.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'safety_alerts_type_enum' ORDER BY enumsortorder`)).map((r: any) => r.enumlabel);
  /** Everything about safety_alerts, plus every other table's columns, constraints and indexes. */
  const schema = async () => ({
    alertColumns: await ds.query(`SELECT column_name, data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'safety_alerts' ORDER BY column_name`),
    alertIndexes: await ds.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'safety_alerts' ORDER BY indexname`),
    otherColumns: await ds.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT IN ('safety_alerts', 'typeorm_migrations') ORDER BY 1, 2`),
    constraints: await ds.query(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype IN ('p','f','u','c') ORDER BY 1, 2`),
    otherIndexes: await ds.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND tablename NOT IN ('safety_alerts', 'typeorm_migrations') ORDER BY 1, 2`),
    otherEnums: await ds.query(`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname <> 'safety_alerts_type_enum' GROUP BY 1 ORDER BY 1`),
  });
  const without63 = (s: Awaited<ReturnType<typeof schema>>) => ({
    ...s,
    alertColumns: s.alertColumns.filter((c: any) => !NEW_COLUMNS.includes(c.column_name)),
    alertIndexes: s.alertIndexes.filter((i: any) => !NEW_INDEXES.includes(i.indexname)),
  });
  const SEEDED = ['users', 'companies', 'guard_profiles', 'shifts', 'safety_alerts', 'audit_logs', 'notifications'];
  const dump = async () => {
    const out: Record<string, unknown[]> = {};
    for (const table of SEEDED) out[table] = await ds.query(`SELECT * FROM "${table}" ORDER BY id`);
    return out;
  };
  const stripNew = (rows: any[]) => rows.map(({ complianceCategory, complianceReason, lapseKey, ...rest }) => rest);

  try {
    const applied = await ds.runMigrations({ transaction: 'each' });
    await test('M63-01-FRESH-DATABASE-MIGRATES-TO-63-AND-ONLY-64-FOLLOWS', () => {
      assert.equal(applied.length, 63, `got ${applied.length}`);
      assert.equal(applied[61].name, MIGRATION_62);
      assert.equal(applied[62].name, MIGRATION_63);
      assert.equal(allFiles.length, 68);
      assert.equal(allFiles[62], '1720900000009-AddComplianceLapseAlerts.ts');
      assert.deepEqual(allFiles.slice(63), ['1720900000010-AddShiftAmendments.ts', '1720900000011-AddWelfarePushReminders.ts', '1720900000012-AddGuardNotificationDispatches.ts', '1720900000013-AddManualAttendance.ts', '1720900000014-AddPatrolManagement.ts'], 'after 63 come only 64 (AddShiftAmendments), 65 (AddWelfarePushReminders), 66 (AddGuardNotificationDispatches), 67 (AddManualAttendance) and 68 (AddPatrolManagement)');
    });
    const head = await schema();
    const headLabels = await enumLabels();
    const driftAt63 = (await ds.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);

    await ds.undoLastMigration({ transaction: 'each' });
    const at62 = await schema();
    await test('M63-02-DOWN-RETURNS-TO-62-AND-REMOVES-ONLY-WHAT-63-ADDED', async () => {
      assert.equal(await migrationCount(), 62);
      assert.equal(await scalar('SELECT name FROM typeorm_migrations ORDER BY id DESC LIMIT 1'), MIGRATION_62);
      assert.deepEqual(at62.alertColumns.map((c: any) => c.column_name).filter((c: string) => NEW_COLUMNS.includes(c)), []);
      assert.deepEqual(at62.alertIndexes.map((i: any) => i.indexname).filter((i: string) => NEW_INDEXES.includes(i)), []);
      assert.deepEqual(at62, without63(head), 'everything else is exactly as it was');
      assert.deepEqual(await enumLabels(), headLabels, 'the enum label is kept (PostgreSQL cannot drop one); no row uses it');
    });

    // Drift measured at 62 with the entity as it was before 63 (no compliance columns or indexes).
    const { SafetyAlert } = await import('../src/safety-alert/entities/safety-alert.entity');
    const { getMetadataArgsStorage } = await import('typeorm');
    const storage = getMetadataArgsStorage();
    const lapseColumns = storage.columns.filter((c) => c.target === SafetyAlert && NEW_COLUMNS.includes(c.propertyName));
    const lapseIndexes = storage.indices.filter((i) => i.target === SafetyAlert && NEW_INDEXES.includes(String(i.name)));
    storage.columns.splice(0, storage.columns.length, ...storage.columns.filter((c) => !lapseColumns.includes(c)));
    storage.indices.splice(0, storage.indices.length, ...storage.indices.filter((i) => !lapseIndexes.includes(i)));
    const at62Ds = new DataSource({ type: 'postgres', url, entities: appEntities, synchronize: false, logging: false });
    await at62Ds.initialize();
    const driftAt62 = (await at62Ds.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    await at62Ds.destroy();
    storage.columns.push(...lapseColumns);
    storage.indices.push(...lapseIndexes);

    // ── seed production-shaped alerts at 62 ─────────────────────────────────────────────────────────
    const [owner] = await ds.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m63.owner@example.invalid','x','company_admin','active') RETURNING id`);
    const [company] = await ds.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails") VALUES ($1,'M63 Ltd','63636363','1 Way','o@example.invalid') RETURNING id`, [owner.id]);
    const [gu] = await ds.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m63.guard@example.invalid','x','guard','active') RETURNING id`);
    const [guard] = await ds.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'M63 Guard','1000000000000063','07000000000') RETURNING id`, [gu.id]);
    const shiftIds: number[] = [];
    for (const status of ['in_progress', 'completed']) {
      const [s] = await ds.query(`INSERT INTO shifts ("companyId","guardId","siteName",status,start,"end","checkCallIntervalMinutes") VALUES ($1,$2,'Site',$3,now() - interval '2 hours', now() + interval '6 hours',60) RETURNING id`, [company.id, guard.id, status]);
      shiftIds.push(s.id);
    }
    const alert = (type: string, priority: string, status: string, extra: Record<string, unknown> = {}) =>
      ds.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"welfareWindowIndex","acknowledgedAt","acknowledgedByUserId","closedAt","closedByUserId","resolutionReason","resolutionNote")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [company.id, guard.id, extra.shiftId ?? shiftIds[0], type, priority, status, `${type} seeded`, extra.window ?? null,
          extra.ack ? new Date('2026-10-01T10:00:00Z') : null, extra.ack ? owner.id : null,
          extra.closed ? new Date('2026-10-01T11:00:00Z') : null, extra.closed ? owner.id : null,
          extra.reason ?? null, extra.note ?? null]);
    await alert('panic', 'critical', 'closed', { ack: true, closed: true, reason: 'guard_confirmed_safe', note: 'Called the guard.' });
    await alert('missed_checkcall', 'medium', 'closed', { window: 0, closed: true });
    await alert('missed_checkcall', 'high', 'acknowledged', { ack: true });
    await alert('missing_book_off', 'medium', 'open', { shiftId: shiftIds[1] });
    await alert('site_request', 'medium', 'open');
    await ds.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId") VALUES ($1,$2,'safety_alert.closed','safety_alert',1)`, [company.id, owner.id]);
    await ds.query(`INSERT INTO notifications ("userId","companyId",type,title,message) VALUES ($1,$2,'alert_raised','t','m')`, [owner.id, company.id]);
    const before = await dump();

    const forward = await ds.runMigrations({ transaction: 'each' });
    await test('M63-03-EXISTING-ALERTS-SURVIVE-UNCHANGED-WITH-NEW-COLUMNS-NULL', async () => {
      assert.deepEqual(forward.map((m) => m.name), [MIGRATION_63]);
      const after = await dump();
      assert.deepEqual({ ...after, safety_alerts: stripNew(after.safety_alerts as any[]) }, { ...before, safety_alerts: stripNew(before.safety_alerts as any[]) });
      for (const row of after.safety_alerts as any[]) {
        assert.equal(row.complianceCategory, null);
        assert.equal(row.complianceReason, null);
        assert.equal(row.lapseKey, null);
      }
    });

    await test('M63-04-APPROVED-SCHEMA', async () => {
      const s = await schema();
      const cols = s.alertColumns.filter((c: any) => NEW_COLUMNS.includes(c.column_name))
        .map((c: any) => `${c.column_name}:${c.data_type}:${c.is_nullable}:${c.character_maximum_length}:${c.column_default}`);
      assert.deepEqual(cols, [
        'complianceCategory:character varying:YES:32:null',
        'complianceReason:character varying:YES:32:null',
        'lapseKey:character varying:YES:120:null',
      ]);
      const def = (name: string) => s.alertIndexes.find((i: any) => i.indexname === name)?.indexdef ?? '';
      assert.match(def('uq_safety_alerts_compliance_lapse_active'), /CREATE UNIQUE INDEX .* \("companyId", "shiftId", "complianceCategory"\) WHERE \(\(type = 'compliance_lapse'::safety_alerts_type_enum\) AND \(status = ANY \(ARRAY\['open'::safety_alerts_status_enum, 'acknowledged'::safety_alerts_status_enum\]\)\)\)/);
      assert.match(def('uq_safety_alerts_compliance_lapse_key'), /CREATE UNIQUE INDEX .* \("shiftId", "complianceCategory", "lapseKey"\) WHERE \(type = 'compliance_lapse'::safety_alerts_type_enum\)/);
      assert.equal((await enumLabels()).at(-1), 'compliance_lapse', 'appended, existing labels and order unchanged');
      assert.deepEqual((await enumLabels()).slice(0, -1), headLabels.slice(0, -1));
    });

    await test('M63-05-ONE-ACTIVE-LAPSE-PER-COMPANY-SHIFT-CATEGORY-AND-ONE-ROW-PER-KEY', async () => {
      const lapse = (status: string, key: string, category = 'sia') =>
        ds.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"complianceCategory","complianceReason","lapseKey")
          VALUES ($1,$2,$3,'compliance_lapse','critical',$4,'m',$5,'expired',$6) RETURNING id`, [company.id, guard.id, shiftIds[0], status, category, key]);
      await lapse('open', 'sia:1:expired');
      await assert.rejects(() => lapse('acknowledged', 'sia:2:expired'), /uq_safety_alerts_compliance_lapse_active/);
      await assert.rejects(() => lapse('closed', 'sia:1:expired'), /uq_safety_alerts_compliance_lapse_key/);
      await lapse('closed', 'sia:2:not_confirmed');
      await lapse('open', 'right_to_work:none:missing', 'right_to_work');
      // Other alert types are untouched by both indexes.
      await alert('missed_checkcall', 'high', 'open');
      await alert('missed_checkcall', 'high', 'open');
      await ds.query(`DELETE FROM safety_alerts WHERE type::text = 'compliance_lapse' OR ("type" = 'missed_checkcall' AND status = 'open')`);
    });

    await test('M63-06-SECOND-RUN-IS-A-NO-OP-AND-UP-IS-REPEATABLE', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      const runner = ds.createQueryRunner();
      try {
        const { AddComplianceLapseAlerts1720900000009 } = await import('../src/database/migrations/1720900000009-AddComplianceLapseAlerts');
        await new AddComplianceLapseAlerts1720900000009().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await schema(), head);
      assert.equal(await migrationCount(), 63);
    });

    await test('M63-07-REAPPLY-RESTORES-THE-IDENTICAL-SCHEMA', async () => {
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.runMigrations({ transaction: 'each' });
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await enumLabels(), headLabels);
    });

    await test('M63-08-DOWN-REFUSES-WHILE-LAPSE-ALERTS-EXIST-AND-CHANGES-NOTHING', async () => {
      await ds.query(`INSERT INTO safety_alerts ("companyId","guardId","shiftId",type,priority,status,message,"complianceCategory","complianceReason","lapseKey")
        VALUES ($1,$2,$3,'compliance_lapse','critical','closed','evidence','right_to_work','expired','right_to_work:7:expired')`, [company.id, guard.id, shiftIds[0]]);
      const snapshot = await dump();
      await assert.rejects(() => ds.undoLastMigration({ transaction: 'each' }), /Refusing to revert AddComplianceLapseAlerts1720900000009: 1 compliance lapse alert/);
      assert.equal(await migrationCount(), 63);
      assert.deepEqual(await schema(), head);
      assert.deepEqual(await dump(), snapshot, 'the evidence is untouched');
    });

    await test('M63-09-PREVIOUS-RELEASE-PREDEPLOY-AGAINST-A-63-DATABASE-IS-A-NO-OP', async () => {
      const through62 = allFiles.filter((f) => Number(f.split('-')[0]) <= 1720900000008).map((f) => path.join(migrationsDir, f));
      const previous = new DataSource({
        type: 'postgres', url, entities: appEntities, synchronize: false, migrations: through62, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      const snapshot = await dump();
      try {
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0);
      } finally {
        await previous.destroy();
      }
      assert.equal(await migrationCount(), 63);
      assert.deepEqual(await dump(), snapshot, 'a rollback of the code keeps every alert, including lapse alerts');
      await ds.query(`DELETE FROM safety_alerts WHERE type::text = 'compliance_lapse'`);
    });

    await test('M63-10-NO-DRIFT-INTRODUCED-BY-63', () => {
      const ours = driftAt63.filter((q) => /compliance_lapse|complianceCategory|complianceReason|lapseKey/.test(q));
      assert.deepEqual(ours, [], `entity and migration 63 disagree:\n${ours.join('\n')}`);
      const added = driftAt63.filter((q) => !driftAt62.includes(q));
      assert.deepEqual(added, [], `Migration 63 introduced drift:\n${added.join('\n')}`);
      console.log(`      (pre-existing drift, unchanged by 63: ${driftAt62.length} statement(s))`);
    });
  } finally {
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'm63_migration_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
