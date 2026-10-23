/**
 * Migration 62 certification (AddGuardComplianceChecks).
 *
 * Against a fresh, disposable PostgreSQL:
 *
 *   M62-01  a fresh database migrates 0 → 62 (this spec runs migrations up to 62 only), and the only
 *           migration after 62 is 63 (AddComplianceLapseAlerts, certified by m63-migration.spec.ts)
 *   M62-02  down() returns exactly to 61, the schema production is on today
 *   M62-03  down() removes the table, its indexes and constraints, and nothing else
 *   M62-04  production-shaped rows seeded at 61 (users, companies, Guards with declared SIA / Right to
 *           Work, company links, verified and unverified evidence, compliance records) survive 61 → 62
 *           byte for byte; nothing is backfilled into the new table
 *   M62-05  the approved schema, column by column, constraint by constraint
 *   M62-06  the partial unique index allows one current check per company, Guard and kind, and any
 *           amount of superseded history
 *   M62-07  foreign keys: company / Guard deletion cascades; evidence, author and superseding row are
 *           SET NULL so history survives
 *   M62-08  a second migration run applies nothing
 *   M62-09  re-applying after down() restores the identical schema
 *   M62-10  up() is safe to repeat statement by statement
 *   M62-11  no PostgreSQL enum types; no synchronize; the entity and the migration agree (no drift
 *           for guard_compliance_checks, and no drift added anywhere else)
 *   M62-12  rollback: the previous release's pre-deploy migration run against a 62 database applies
 *           nothing, fails nothing and keeps recorded checks
 *
 * Needs M62_MIGRATION_DATABASE_URL pointing at a DISPOSABLE local database — it drops the schema.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';
import { appEntities } from '../src/database/entities';

const url = process.env.M62_MIGRATION_DATABASE_URL;
if (!url) throw new Error('M62_MIGRATION_DATABASE_URL is required (disposable database)');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('M62_MIGRATION_DATABASE_URL must point at a local disposable database');
}

const MIGRATION_62 = 'AddGuardComplianceChecks1720900000008';
const MIGRATION_61 = 'AddAccountLifecycleAndVerificationTokens1720900000007';
const TABLE = 'guard_compliance_checks';

let passed = 0;
const test = async (id: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`PASS  ${id}`);
};

async function main() {
  const path = require('node:path');
  const migrationsDir = path.join(__dirname, '..', 'src', 'database', 'migrations');
  const allMigrationFiles: string[] = require('node:fs').readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f)).sort();
  // Migrations up to and including 62 (1720900000008). Later migrations are certified by their own specs
  // (m63-migration.spec.ts); excluding them keeps this one about 62.
  const throughM62 = allMigrationFiles
    .filter((f) => Number(f.split('-')[0]) <= 1720900000008)
    .map((f) => path.join(migrationsDir, f));
  const ds = new DataSource({
    type: 'postgres', url, entities: appEntities, synchronize: false, dropSchema: true,
    migrations: throughM62, migrationsTableName: 'typeorm_migrations', logging: false,
  });
  await ds.initialize();

  const scalar = async (sql: string, params: unknown[] = []) => Object.values((await ds.query(sql, params))[0] ?? {})[0];
  const migrationCount = async () => Number(await scalar('SELECT count(*)::int FROM typeorm_migrations'));
  const snapshot = async () => ({
    columns: await ds.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
       ORDER BY column_name`, [TABLE]),
    constraints: await ds.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = to_regclass('public.${TABLE}') AND contype IN ('p','f','u','c') ORDER BY conname`),
    indexes: await ds.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [TABLE]),
  });
  /** Every table except the new one and the migrations ledger: columns, constraints, indexes. */
  const restOfSchema = async () => ({
    columns: await ds.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name NOT IN ($1, 'typeorm_migrations') ORDER BY table_name, column_name`, [TABLE]),
    constraints: await ds.query(`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND contype IN ('p','f','u','c') AND conrelid <> COALESCE(to_regclass('public.${TABLE}'), 0)
       ORDER BY 1, 2`),
    indexes: await ds.query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename NOT IN ($1, 'typeorm_migrations') ORDER BY 1, 2`, [TABLE]),
    enums: await ds.query(`SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY 1`),
  });
  const SEEDED_TABLES = ['users', 'companies', 'guard_profiles', 'company_guards', 'guard_documents', 'compliance_records', 'audit_logs'];
  const dumpRows = async () => {
    const out: Record<string, unknown[]> = {};
    for (const table of SEEDED_TABLES) out[table] = await ds.query(`SELECT * FROM "${table}" ORDER BY id`);
    return out;
  };

  try {
    assert.equal(ds.options.synchronize, false, 'synchronize must stay off');

    // ── fresh database to the head ───────────────────────────────────────────────────────────────
    const applied = await ds.runMigrations({ transaction: 'each' });
    await test('M62-01-FRESH-DATABASE-MIGRATES-TO-62-AND-ONLY-63-FOLLOWS', () => {
      assert.equal(applied.length, 62, `62 migrations apply to a fresh database (got ${applied.length})`);
      assert.equal(applied[60].name, MIGRATION_61);
      assert.equal(applied[61].name, MIGRATION_62, 'Migration 62 is the subject');
      assert.equal(allMigrationFiles.length, 65, 'exactly 65 migration files');
      assert.deepEqual(
        allMigrationFiles.slice(62),
        ['1720900000009-AddComplianceLapseAlerts.ts', '1720900000010-AddShiftAmendments.ts', '1720900000011-AddWelfarePushReminders.ts'],
        'the only migrations after 62 are 63 (AddComplianceLapseAlerts), 64 (AddShiftAmendments) and 65 (AddWelfarePushReminders)',
      );
    });
    const head = await snapshot();
    const headRest = await restOfSchema();

    // Drift: what TypeORM would change to make the schema match the entities. Measured at 62, and
    // compared with the same measurement at 61 without the new entity, so only drift introduced by
    // this change can fail the test (older, unrelated drift is reported, not hidden).
    const driftAt62 = (await ds.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);

    // ── back to 61 ───────────────────────────────────────────────────────────────────────────────
    await ds.undoLastMigration({ transaction: 'each' });
    await test('M62-02-DOWN-RETURNS-TO-61', async () => {
      assert.equal(await migrationCount(), 61);
      assert.equal(await scalar('SELECT name FROM typeorm_migrations ORDER BY id DESC LIMIT 1'), MIGRATION_61);
    });

    await test('M62-03-DOWN-REMOVES-THE-TABLE-AND-NOTHING-ELSE', async () => {
      assert.equal(await scalar(`SELECT to_regclass('public.${TABLE}') IS NULL`), true);
      const gone = await snapshot();
      assert.deepEqual(gone.columns, []);
      assert.deepEqual(gone.constraints, []);
      assert.deepEqual(gone.indexes, []);
      assert.deepEqual(await restOfSchema(), headRest, 'every other table, constraint, index and enum is as it was');
    });

    const at61Ds = new DataSource({
      type: 'postgres', url, entities: appEntities.filter((e: any) => e.name !== 'GuardComplianceCheck'),
      synchronize: false, logging: false,
    });
    await at61Ds.initialize();
    const driftAt61 = (await at61Ds.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    await at61Ds.destroy();

    // ── seed production-shaped rows at 61 ────────────────────────────────────────────────────────
    const [owner] = await ds.query(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
      VALUES ('m62.owner@example.invalid','x','company_admin','active',true) RETURNING id`);
    const [company] = await ds.query(`INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails")
      VALUES ($1,'M62 Security Ltd','62626262','1 Way','ops@example.invalid') RETURNING id`, [owner.id]);
    const guards: number[] = [];
    for (const [i, declared] of [[1, true], [2, false], [3, true]] as const) {
      const [u] = await ds.query(`INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified")
        VALUES ($1,'x','guard','active',true) RETURNING id`, [`m62.guard${i}@example.invalid`]);
      const [g] = await ds.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","siaExpiryDate","rightToWorkStatus","rightToWorkExpiryDate",phone)
        VALUES ($1,$2,$3,$4,$5,NULL,'07000000000') RETURNING id`,
        [u.id, `Guard ${i}`, `100000000000000${i}`, declared ? '2030-01-31' : null, declared ? 'british' : null]);
      guards.push(g.id);
      await ds.query(`INSERT INTO company_guards ("companyId","guardId",status,"relationshipType") VALUES ($1,$2,'ACTIVE','EMPLOYEE')`, [company.id, g.id]);
    }
    for (const [guardId, type, verified] of [[guards[0], 'sia_licence', true], [guards[0], 'right_to_work', true], [guards[1], 'right_to_work', false]] as const) {
      await ds.query(`INSERT INTO guard_documents ("guardId","companyId",type,"storageProvider","storageKey","originalFileName","mimeType","sizeBytes","uploadCompletedAt","expiryDate",verified,"uploadedByUserId")
        VALUES ($1,$2,$3,'s3',$4,'evidence.pdf','application/pdf','1024',now(),'2030-01-31',$5,$6)`,
        [guardId, company.id, type, `compliance/company/${company.id}/${guardId}/${type}`, verified, owner.id]);
    }
    await ds.query(`INSERT INTO compliance_records ("companyId","guardId",type,"documentName","expiryDate",status)
      VALUES ($1,$2,'SIA','SIA licence','2030-01-31','valid')`, [company.id, guards[0]]);
    await ds.query(`INSERT INTO audit_logs ("companyId","userId",action,"entityType","entityId")
      VALUES ($1,$2,'guard_document.verified','guard_document',1)`, [company.id, owner.id]);
    const before = await dumpRows();

    // ── 61 → 62 ──────────────────────────────────────────────────────────────────────────────────
    const forward = await ds.runMigrations({ transaction: 'each' });
    await test('M62-04-EXISTING-ROWS-SURVIVE-UNTOUCHED-AND-NOTHING-IS-BACKFILLED', async () => {
      assert.deepEqual(forward.map((m) => m.name), [MIGRATION_62], 'exactly one migration: 62');
      assert.deepEqual(await dumpRows(), before, 'every seeded row is byte-for-byte unchanged');
      assert.equal(await scalar(`SELECT count(*)::int FROM ${TABLE}`), 0, 'declarations are not copied into company checks');
    });

    await test('M62-05-APPROVED-SCHEMA', async () => {
      const s = await snapshot();
      const cols = s.columns.map((c: any) => `${c.column_name}:${c.data_type}:${c.is_nullable}${c.character_maximum_length ? ':' + c.character_maximum_length : ''}`);
      assert.deepEqual(cols, [
        'changeReason:character varying:YES:500',
        'changeType:character varying:NO:32',
        'checkDate:date:NO',
        'checkedByName:character varying:NO:120',
        'companyId:integer:NO',
        'createdAt:timestamp with time zone:NO',
        'evidenceDocumentId:integer:YES',
        'evidenceReference:character varying:YES:200',
        'expiryDate:date:YES',
        'guardId:integer:NO',
        'id:integer:NO',
        'kind:character varying:NO:32',
        'licenceNumber:character varying:YES:16',
        'method:character varying:NO:40',
        'outcome:character varying:NO:32',
        'recordedByUserId:integer:YES',
        'rightToWorkExcuse:character varying:YES:32',
        'supersededAt:timestamp with time zone:YES',
        'supersededByCheckId:integer:YES',
        'workRestrictions:character varying:YES:500',
      ]);
      const fk = (name: string) => s.constraints.find((c: any) => c.conname === name)?.def ?? '';
      assert.match(fk('FK_guard_compliance_checks_company'), /FOREIGN KEY \("companyId"\) REFERENCES companies\(id\) ON DELETE CASCADE/);
      assert.match(fk('FK_guard_compliance_checks_guard'), /FOREIGN KEY \("guardId"\) REFERENCES guard_profiles\(id\) ON DELETE CASCADE/);
      assert.match(fk('FK_guard_compliance_checks_evidence_document'), /FOREIGN KEY \("evidenceDocumentId"\) REFERENCES guard_documents\(id\) ON DELETE SET NULL/);
      assert.match(fk('FK_guard_compliance_checks_recorded_by'), /FOREIGN KEY \("recordedByUserId"\) REFERENCES users\(id\) ON DELETE SET NULL/);
      assert.match(fk('FK_guard_compliance_checks_superseded_by'), /FOREIGN KEY \("supersededByCheckId"\) REFERENCES guard_compliance_checks\(id\) ON DELETE SET NULL/);
      assert.equal(s.constraints.length, 6, 'primary key and five foreign keys, nothing else');
      const index = (name: string) => s.indexes.find((i: any) => i.indexname === name)?.indexdef ?? '';
      assert.match(index('UQ_guard_compliance_checks_current'), /UNIQUE INDEX .* \("companyId", "guardId", kind\) WHERE \("supersededAt" IS NULL\)/);
      assert.match(index('IDX_guard_compliance_checks_company_guard'), /\("companyId", "guardId", "createdAt"\)/);
      assert.equal(s.indexes.length, 3, 'primary key, current-check and history indexes only');
    });

    const insertCheck = (companyId: number, guardId: number, kind: string, supersededAt: string | null = null) =>
      ds.query(`INSERT INTO ${TABLE} ("companyId","guardId",kind,outcome,method,"checkDate","checkedByName","supersededAt")
        VALUES ($1,$2,$3,'confirmed','manual_document','2026-10-01','Rehearsal',$4) RETURNING id`, [companyId, guardId, kind, supersededAt]);

    await test('M62-06-ONE-CURRENT-CHECK-PER-COMPANY-GUARD-KIND', async () => {
      await insertCheck(company.id, guards[0], 'right_to_work', '2026-10-01T10:00:00Z');
      await insertCheck(company.id, guards[0], 'right_to_work', '2026-10-02T10:00:00Z');
      await insertCheck(company.id, guards[0], 'right_to_work');
      await insertCheck(company.id, guards[0], 'sia');
      await assert.rejects(() => insertCheck(company.id, guards[0], 'right_to_work'), /UQ_guard_compliance_checks_current/);
      await ds.query(`DELETE FROM ${TABLE}`);
    });

    await test('M62-07-FOREIGN-KEYS-PRESERVE-HISTORY', async () => {
      const [doc] = await ds.query(`SELECT id FROM guard_documents WHERE "guardId" = $1 AND type = 'sia_licence'`, [guards[0]]);
      const [author] = await ds.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m62.author@example.invalid','x','company_staff','active') RETURNING id`);
      const [older] = await insertCheck(company.id, guards[0], 'sia', '2026-10-01T10:00:00Z');
      const [newer] = await insertCheck(company.id, guards[0], 'sia');
      await ds.query(`UPDATE ${TABLE} SET "evidenceDocumentId"=$1, "recordedByUserId"=$2 WHERE id=$3`, [doc.id, author.id, older.id]);
      await ds.query(`UPDATE ${TABLE} SET "supersededByCheckId"=$1 WHERE id=$2`, [newer.id, older.id]);
      // Exercise the SET NULL paths inside a transaction that is rolled back, so the seeded rows stay.
      await ds.transaction(async (m) => {
        await m.query(`DELETE FROM guard_documents WHERE id = $1`, [doc.id]);
        await m.query(`DELETE FROM users WHERE id = $1`, [author.id]);
        await m.query(`DELETE FROM ${TABLE} WHERE id = $1`, [newer.id]);
        const [row] = await m.query(`SELECT "evidenceDocumentId","recordedByUserId","supersededByCheckId" FROM ${TABLE} WHERE id = $1`, [older.id]);
        assert.deepEqual(row, { evidenceDocumentId: null, recordedByUserId: null, supersededByCheckId: null });
        // A Guard with any other history cannot be deleted (company_guards etc. restrict it); one that
        // can be deleted takes its checks with it.
        const [bareUser] = await m.query(`INSERT INTO users (email,"passwordHash",role,status) VALUES ('m62.bare@example.invalid','x','guard','active') RETURNING id`);
        const [bare] = await m.query(`INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber",phone) VALUES ($1,'Bare','1000000000000099','07000000000') RETURNING id`, [bareUser.id]);
        await m.query(`INSERT INTO ${TABLE} ("companyId","guardId",kind,outcome,method,"checkDate","checkedByName") VALUES ($1,$2,'sia','confirmed','sia_public_register','2026-10-01','Rehearsal')`, [company.id, bare.id]);
        await m.query(`DELETE FROM guard_profiles WHERE id = $1`, [bare.id]);
        assert.equal(Number((await m.query(`SELECT count(*)::int n FROM ${TABLE} WHERE "guardId" = $1`, [bare.id]))[0].n), 0, 'Guard deletion cascades');
        throw new Error('rollback');
      }).catch((error) => { if ((error as Error).message !== 'rollback') throw error; });
      await ds.query(`DELETE FROM ${TABLE}`);
      await ds.query(`DELETE FROM users WHERE id = $1`, [author.id]);
      assert.deepEqual(await dumpRows(), before, 'the rehearsal left the seeded rows as they were');
    });

    await test('M62-08-SECOND-RUN-APPLIES-NOTHING', async () => {
      assert.equal((await ds.runMigrations({ transaction: 'each' })).length, 0);
      assert.equal(await migrationCount(), 62);
    });

    await test('M62-09-REAPPLY-RESTORES-THE-IDENTICAL-SCHEMA', async () => {
      assert.deepEqual(await snapshot(), head);
      assert.deepEqual(await restOfSchema(), headRest);
    });

    await test('M62-10-UP-IS-SAFE-TO-REPEAT-STATEMENT-BY-STATEMENT', async () => {
      const runner = ds.createQueryRunner();
      try {
        const { AddGuardComplianceChecks1720900000008 } = await import('../src/database/migrations/1720900000008-AddGuardComplianceChecks');
        await new AddGuardComplianceChecks1720900000008().up(runner);
      } finally {
        await runner.release();
      }
      assert.deepEqual(await snapshot(), head);
      assert.deepEqual(await dumpRows(), before);
    });

    await test('M62-12-PREVIOUS-RELEASE-PREDEPLOY-AGAINST-A-62-DATABASE-IS-A-NO-OP', async () => {
      // A Render rollback redeploys the previous release, whose preDeployCommand runs migration:run with
      // migrations only up to 61. Against a database that already recorded 62 it must apply nothing,
      // fail nothing and leave the table and its rows alone.
      const files = require('node:fs').readdirSync(migrationsDir).filter((f: string) => /\.ts$/.test(f))
        .filter((f: string) => Number(f.split('-')[0]) <= 1720900000007).map((f: string) => path.join(migrationsDir, f));
      const previous = new DataSource({
        type: 'postgres', url, entities: appEntities.filter((e: any) => e.name !== 'GuardComplianceCheck'),
        synchronize: false, migrations: files, migrationsTableName: 'typeorm_migrations', logging: false,
      });
      await previous.initialize();
      try {
        const [{ id: keep }] = await ds.query(`INSERT INTO ${TABLE} ("companyId","guardId",kind,outcome,method,"checkDate","checkedByName") VALUES ($1,$2,'sia','confirmed','sia_public_register','2026-10-01','Rehearsal') RETURNING id`, [company.id, guards[1]]);
        assert.equal((await previous.runMigrations({ transaction: 'each' })).length, 0);
        assert.equal(await migrationCount(), 62);
        assert.equal(Number((await ds.query(`SELECT count(*)::int n FROM ${TABLE} WHERE id = $1`, [keep]))[0].n), 1, 'recorded checks survive a rollback');
        await ds.query(`DELETE FROM ${TABLE}`);
      } finally {
        await previous.destroy();
      }
      assert.deepEqual(await snapshot(), head);
    });

    await test('M62-11-NO-ENUMS-NO-SYNCHRONIZE-NO-DRIFT', async () => {
      assert.deepEqual(headRest.enums, (await restOfSchema()).enums);
      assert.equal(
        await scalar(`SELECT count(*)::int FROM information_schema.columns WHERE table_name = $1 AND data_type = 'USER-DEFINED'`, [TABLE]),
        0,
        'no column of the new table is a PostgreSQL enum',
      );
      const ours = driftAt62.filter((q) => q.includes(TABLE));
      assert.deepEqual(ours, [], `entity and migration disagree:\n${ours.join('\n')}`);
      const added = driftAt62.filter((q) => !driftAt61.includes(q));
      assert.deepEqual(added, [], `Migration 62 introduced drift elsewhere:\n${added.join('\n')}`);
      console.log(`      (pre-existing drift, unchanged by 62: ${driftAt61.length} statement(s))`);
    });
  } finally {
    await ds.destroy();
  }

  console.log(JSON.stringify({ event: 'm62_migration_certified', tests: passed }));
}

main().catch((error) => {
  console.error('FAIL ', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
