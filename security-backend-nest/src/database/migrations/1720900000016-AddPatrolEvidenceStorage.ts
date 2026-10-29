import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 70: Patrol evidence storage, integrity and retention (S4 Patrols Phase 1, package P1-C; owner-approved
 * 29 Oct 2026).
 *
 * Additive only. Nothing existing is backfilled, re-typed or removed; every new column is nullable or has a default that
 * keeps every existing row and INSERT valid. Varchar + CHECK, no PostgreSQL enum.
 *
 *   patrol_evidence           + "declaredSizeBytes"  bigint NULL     the size the Guard declared for the upload (≤ the cap)
 *                             + "detectedMimeType"   varchar(64)     what the server found the bytes to be
 *                             + "uploadUrlIssuedAt"  timestamptz     the last upload URL handed out (inside the sync window)
 *                             + "completionToken"    uuid NULL       the completion lease (one verifier at a time)
 *                             + "completionStartedAt" timestamptz
 *                             + "syncFlags"          jsonb '[]'      synced_after_book_off, evidence_after_alert, …
 *                             + "needsReview"        bool false
 *                             + "purgeAfter"         timestamptz     end of the quarantine (recoverable until then)
 *                             + "primaryDeletedAt"   timestamptz     the object under storageKey was confirmed removed
 *                             + "objectDeletedAt"    timestamptz     the quarantined copy was confirmed removed (tombstone)
 *                             + "deletionRequestedByUserId" int → users   a manual (Owner / Admin) deletion
 *                             CHECKs on the new values; IDX_patrol_evidence_lifecycle for the maintenance passes
 *   patrol_evidence_exports   NEW  bounded ZIP exports with an evidence manifest (status machine, hashes, 24 h object)
 *   patrol_storage_usage      NEW  live metering per (company, site) and one company row (siteId NULL) for exports
 *
 * Tenancy: an export and a usage row carry their company and reference it (RESTRICT); the site references are checked by
 * the service against the caller's company (as M68's holds are). Nothing references a new table from an existing one, so
 * the previous release (P1-B) is unaffected by them and never names a new column: a Render rollback over a migrated
 * database is safe.
 *
 * Runs in a transaction (no enum change). Every statement is guarded (IF NOT EXISTS / pg_constraint checks), so a
 * repeated run converges.
 */
export class AddPatrolEvidenceStorage1720900000016 implements MigrationInterface {
  name = 'AddPatrolEvidenceStorage1720900000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    const columns: Array<[string, string, string]> = [
      ['patrol_evidence', 'declaredSizeBytes', 'bigint'],
      ['patrol_evidence', 'detectedMimeType', 'character varying(64)'],
      ['patrol_evidence', 'uploadUrlIssuedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_evidence', 'completionToken', 'uuid'],
      ['patrol_evidence', 'completionStartedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_evidence', 'syncFlags', `jsonb NOT NULL DEFAULT '[]'`],
      ['patrol_evidence', 'needsReview', 'boolean NOT NULL DEFAULT false'],
      ['patrol_evidence', 'purgeAfter', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_evidence', 'primaryDeletedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_evidence', 'objectDeletedAt', 'TIMESTAMP WITH TIME ZONE'],
      ['patrol_evidence', 'deletionRequestedByUserId', 'integer'],
    ];
    for (const [table, column, definition] of columns) {
      await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`);
    }

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_evidence_exports" (
        "id"                 SERIAL NOT NULL,
        "companyId"          integer NOT NULL,
        "requestedByUserId"  integer NOT NULL,
        "status"             character varying(16) NOT NULL DEFAULT 'queued',
        "purpose"            character varying(32) NOT NULL,
        "siteId"             integer,
        "fromDate"           date,
        "toDate"             date,
        "runIds"             jsonb NOT NULL DEFAULT '[]',
        "itemCount"          integer NOT NULL DEFAULT 0,
        "includedCount"      integer NOT NULL DEFAULT 0,
        "excludedCount"      integer NOT NULL DEFAULT 0,
        "includedBytes"      bigint NOT NULL DEFAULT 0,
        "zipBytes"           bigint,
        "zipSha256"          character varying(64),
        "manifestSha256"     character varying(64),
        "storageKey"         character varying(512),
        "error"              character varying(500),
        "attempts"           integer NOT NULL DEFAULT 0,
        "claimToken"         uuid,
        "claimedAt"          TIMESTAMP WITH TIME ZONE,
        "startedAt"          TIMESTAMP WITH TIME ZONE,
        "completedAt"        TIMESTAMP WITH TIME ZONE,
        "expiresAt"          TIMESTAMP WITH TIME ZONE,
        "objectDeletedAt"    TIMESTAMP WITH TIME ZONE,
        "createdAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_evidence_exports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_evidence_exports_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "CHK_patrol_evidence_exports_status" CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
        CONSTRAINT "CHK_patrol_evidence_exports_purpose" CHECK ("purpose" IN ('incident', 'investigation', 'client_request', 'legal', 'audit', 'other')),
        CONSTRAINT "CHK_patrol_evidence_exports_run_ids" CHECK (jsonb_typeof("runIds") = 'array'),
        CONSTRAINT "CHK_patrol_evidence_exports_dates" CHECK ("fromDate" IS NULL OR "toDate" IS NULL OR "toDate" >= "fromDate"),
        CONSTRAINT "CHK_patrol_evidence_exports_counts" CHECK ("itemCount" >= 0 AND "includedCount" >= 0 AND "excludedCount" >= 0
          AND "includedBytes" >= 0 AND ("zipBytes" IS NULL OR "zipBytes" >= 0) AND "attempts" >= 0),
        CONSTRAINT "CHK_patrol_evidence_exports_hashes" CHECK (("zipSha256" IS NULL OR "zipSha256" ~ '^[0-9a-f]{64}$')
          AND ("manifestSha256" IS NULL OR "manifestSha256" ~ '^[0-9a-f]{64}$')),
        CONSTRAINT "CHK_patrol_evidence_exports_ready" CHECK ("status" <> 'ready'
          OR ("storageKey" IS NOT NULL AND "zipSha256" IS NOT NULL AND "manifestSha256" IS NOT NULL AND "expiresAt" IS NOT NULL AND "zipBytes" IS NOT NULL)),
        CONSTRAINT "CHK_patrol_evidence_exports_claim" CHECK ("status" <> 'running' OR ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL))
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_storage_usage" (
        "id"                  SERIAL NOT NULL,
        "companyId"           integer NOT NULL,
        "siteId"              integer,
        "activeObjects"       integer NOT NULL DEFAULT 0,
        "activeBytes"         bigint NOT NULL DEFAULT 0,
        "quarantinedObjects"  integer NOT NULL DEFAULT 0,
        "quarantinedBytes"    bigint NOT NULL DEFAULT 0,
        "exportObjects"       integer NOT NULL DEFAULT 0,
        "exportBytes"         bigint NOT NULL DEFAULT 0,
        "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_storage_usage" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_patrol_storage_usage_counts" CHECK ("activeObjects" >= 0 AND "activeBytes" >= 0 AND "quarantinedObjects" >= 0
          AND "quarantinedBytes" >= 0 AND "exportObjects" >= 0 AND "exportBytes" >= 0)
      )
    `);

    const constraints: Array<[string, string, string]> = [
      ['patrol_evidence', 'FK_patrol_evidence_deletion_requested_by', 'FOREIGN KEY ("deletionRequestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_evidence', 'CHK_patrol_evidence_sync_flags', `CHECK (jsonb_typeof("syncFlags") = 'array')`],
      ['patrol_evidence', 'CHK_patrol_evidence_declared_size', 'CHECK ("declaredSizeBytes" IS NULL OR "declaredSizeBytes" > 0)'],
      ['patrol_evidence', 'CHK_patrol_evidence_completion_lease', 'CHECK (("completionToken" IS NULL) = ("completionStartedAt" IS NULL))'],
      ['patrol_evidence', 'CHK_patrol_evidence_quarantine', `CHECK ("retentionStatus" <> 'quarantined' OR ("quarantinedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "quarantineKey" IS NOT NULL))`],
      ['patrol_evidence', 'CHK_patrol_evidence_tombstone', `CHECK ("retentionStatus" <> 'tombstone' OR "objectDeletedAt" IS NOT NULL)`],
      ['patrol_evidence_exports', 'FK_patrol_evidence_exports_company', 'FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_evidence_exports', 'FK_patrol_evidence_exports_site', 'FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_evidence_exports', 'FK_patrol_evidence_exports_requested_by', 'FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_storage_usage', 'FK_patrol_storage_usage_company', 'FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
      ['patrol_storage_usage', 'FK_patrol_storage_usage_site', 'FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE NO ACTION'],
    ];
    for (const [table, name, definition] of constraints) {
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }

    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_lifecycle" ON "patrol_evidence" ("companyId", "retentionStatus") WHERE "retentionStatus" <> 'tombstone'`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_pending_upload" ON "patrol_evidence" ("uploadUrlIssuedAt") WHERE "uploadStatus" IN ('pending', 'uploaded')`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_evidence_exports_storage_key" ON "patrol_evidence_exports" ("storageKey") WHERE "storageKey" IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_exports_company" ON "patrol_evidence_exports" ("companyId", "createdAt")`);
    await q(`CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_exports_open" ON "patrol_evidence_exports" ("status") WHERE "status" IN ('queued', 'running', 'ready')`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_storage_usage_site" ON "patrol_storage_usage" ("companyId", "siteId") WHERE "siteId" IS NOT NULL`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_storage_usage_company" ON "patrol_storage_usage" ("companyId") WHERE "siteId" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Photo evidence records (with their hashes and tombstones), holds and exports are evidence of what was stored, viewed,
    // held and deleted. Rolling back would drop that record, so it is refused while any exist: export them and decide
    // first. A code rollback never needs this (the previous release ignores every new column and table).
    const [{ evidence }] = await queryRunner.query(`SELECT count(*)::int AS evidence FROM "patrol_evidence"`);
    const [{ holds }] = await queryRunner.query(`SELECT count(*)::int AS holds FROM "patrol_evidence_holds"`);
    const [exportsTable] = await queryRunner.query(`SELECT to_regclass('public.patrol_evidence_exports') AS t`);
    const exportsCount = exportsTable?.t ? Number((await queryRunner.query(`SELECT count(*)::int AS n FROM "patrol_evidence_exports"`))[0].n) : 0;
    const blocking = [
      Number(evidence) ? `${evidence} patrol evidence record(s) (including tombstones)` : '',
      Number(holds) ? `${holds} evidence hold(s)` : '',
      exportsCount ? `${exportsCount} evidence export record(s)` : '',
    ].filter(Boolean);
    if (blocking.length) {
      throw new Error(
        `Refusing to revert AddPatrolEvidenceStorage1720900000016: ${blocking.join(', ')} exist. ` +
          'Export them (pg_dump of the patrol_* tables and audit_logs; the objects stay in the bucket) and get explicit approval before removing them.',
      );
    }
    const q = (sql: string) => queryRunner.query(sql);
    await q(`DROP TABLE IF EXISTS "patrol_storage_usage"`);
    await q(`DROP TABLE IF EXISTS "patrol_evidence_exports"`);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_evidence_pending_upload"`);
    await q(`DROP INDEX IF EXISTS "IDX_patrol_evidence_lifecycle"`);
    for (const name of [
      'CHK_patrol_evidence_tombstone', 'CHK_patrol_evidence_quarantine', 'CHK_patrol_evidence_completion_lease', 'CHK_patrol_evidence_declared_size',
      'CHK_patrol_evidence_sync_flags', 'FK_patrol_evidence_deletion_requested_by',
    ]) {
      await q(`ALTER TABLE "patrol_evidence" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    for (const column of [
      'deletionRequestedByUserId', 'objectDeletedAt', 'primaryDeletedAt', 'purgeAfter', 'needsReview', 'syncFlags', 'completionStartedAt',
      'completionToken', 'uploadUrlIssuedAt', 'detectedMimeType', 'declaredSizeBytes',
    ]) {
      await q(`ALTER TABLE "patrol_evidence" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
