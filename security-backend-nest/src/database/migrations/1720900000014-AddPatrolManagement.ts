import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 68: Patrol Management foundation (S4 Patrols Phase 1, package P1-A; owner-approved 28 Oct 2026).
 *
 * Additive only. One existing table gains one column; nothing existing is altered, backfilled or re-typed:
 *
 *   companies                    + "patrolsEnabled" boolean NOT NULL DEFAULT false   (the per-company feature switch;
 *                                  every existing company reads false, so Patrols stays invisible until an S4 platform
 *                                  administrator switches it on)
 *   patrol_policies              per company default (siteId NULL) and per site: methods, photo counts, order mode,
 *                                  start / duration / completion / sync grace, requirement scope, evidence retention
 *                                  (30 or 90 days), and the proximity fields (present, default off; the API refuses to
 *                                  enable location verification until the privacy assessment is approved)
 *   patrol_schedules             site-local active periods (HH:mm), days of week, frequency 15–1440 min, window length
 *   patrol_checkpoints           128-bit random publicId, label, tokenVersion (label rotation), optional location,
 *                                  photoRequired, active / revoked
 *   patrol_routes                named, ordered (or any-order) set of a site's checkpoints
 *   patrol_route_checkpoints     route ↔ checkpoint with position; composite FKs make a cross-site link impossible
 *   patrol_runs                  one patrol by one Guard on one shift (device and server times, clock offset, status
 *                                  and a separate verification status, client-generated idempotency id)
 *   patrol_checkpoint_visits     one label scan: what was scanned, the server's verification result and flags,
 *                                  provisional until the P1-B engine finalises it, client-generated idempotency id
 *   patrol_evidence              photo metadata, integrity hashes, retention and the full deletion state machine's
 *                                  columns (active → claimed → quarantined → purged → tombstone, restore) for P1-C
 *   patrol_exceptions            missed / incomplete / checkpoint missed …, one open row per (company, window, scope, type)
 *   patrol_evidence_holds        legal / incident holds that block deletion
 *   patrol_storage_usage_daily   metering snapshot per (company, site, day)
 *
 * Conventions: every new status / method column is varchar + a named CHECK (never a PostgreSQL enum), so adding a
 * value later is a plain transactional constraint swap, not a non-transactional ALTER TYPE. Every new time is
 * timestamptz (an absolute instant that does not depend on the process clock), unlike the older shift columns, which
 * are `timestamp` holding UTC wall time. Every row carries companyId; child rows are tied to their parent's company
 * (and site, for routes) by composite foreign keys, so a cross-tenant link cannot be written even by a bug.
 * Evidence-bearing references are ON DELETE RESTRICT.
 *
 * Runs in the normal transaction: no enum is changed. Every statement is guarded, so a repeated run converges.
 *
 * Backward compatible: code at 6d7dd3c never names the new tables or the new column (whose default keeps every existing
 * INSERT valid), so a Render rollback over a migrated database is safe.
 */
export class AddPatrolManagement1720900000014 implements MigrationInterface {
  name = 'AddPatrolManagement1720900000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const q = (sql: string) => queryRunner.query(sql);

    await q(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "patrolsEnabled" boolean NOT NULL DEFAULT false`);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_policies" (
        "id"                        SERIAL NOT NULL,
        "companyId"                 integer NOT NULL,
        "siteId"                    integer,
        "methods"                   jsonb NOT NULL DEFAULT '["qr"]',
        "photosPerRun"              integer NOT NULL DEFAULT 0,
        "photosPerCheckpoint"       integer NOT NULL DEFAULT 0,
        "orderMode"                 character varying(16) NOT NULL DEFAULT 'any',
        "startGraceMinutes"         integer NOT NULL DEFAULT 15,
        "maxPatrolDurationMinutes"  integer NOT NULL DEFAULT 45,
        "completionGraceMinutes"    integer NOT NULL DEFAULT 30,
        "syncGraceMinutes"          integer NOT NULL DEFAULT 60,
        "requirementScope"          character varying(16) NOT NULL DEFAULT 'site',
        "retentionDays"             integer NOT NULL DEFAULT 30,
        "incompleteNeedsAction"     boolean NOT NULL DEFAULT true,
        "qrRequireProximity"        boolean NOT NULL DEFAULT false,
        "proximityMeters"           integer,
        "updatedByUserId"           integer,
        "createdAt"                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_policies" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_patrol_policies_methods" CHECK (jsonb_typeof("methods") = 'array' AND jsonb_array_length("methods") >= 1 AND "methods" <@ '["qr", "photo"]'::jsonb),
        CONSTRAINT "CHK_patrol_policies_photos" CHECK ("photosPerRun" BETWEEN 0 AND 20 AND "photosPerCheckpoint" BETWEEN 0 AND 5),
        CONSTRAINT "CHK_patrol_policies_order_mode" CHECK ("orderMode" IN ('any', 'strict')),
        CONSTRAINT "CHK_patrol_policies_grace" CHECK ("startGraceMinutes" BETWEEN 0 AND 240 AND "maxPatrolDurationMinutes" BETWEEN 5 AND 720
          AND "completionGraceMinutes" BETWEEN 0 AND 720 AND "syncGraceMinutes" BETWEEN 0 AND 1440),
        CONSTRAINT "CHK_patrol_policies_scope" CHECK ("requirementScope" IN ('site', 'per_guard')),
        CONSTRAINT "CHK_patrol_policies_retention" CHECK ("retentionDays" IN (30, 90)),
        CONSTRAINT "CHK_patrol_policies_proximity" CHECK ("proximityMeters" IS NULL OR "proximityMeters" BETWEEN 10 AND 1000)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_checkpoints" (
        "id"               SERIAL NOT NULL,
        "companyId"        integer NOT NULL,
        "siteId"           integer NOT NULL,
        "publicId"         character varying(32) NOT NULL,
        "label"            character varying(120) NOT NULL,
        "description"      character varying(500),
        "tokenVersion"     integer NOT NULL DEFAULT 1,
        "latitude"         double precision,
        "longitude"        double precision,
        "proximityMeters"  integer,
        "photoRequired"    boolean NOT NULL DEFAULT false,
        "active"           boolean NOT NULL DEFAULT true,
        "rotatedAt"        TIMESTAMP WITH TIME ZONE,
        "revokedAt"        TIMESTAMP WITH TIME ZONE,
        "revokedByUserId"  integer,
        "createdByUserId"  integer,
        "updatedByUserId"  integer,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_checkpoints" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_checkpoints_public_id" UNIQUE ("publicId"),
        CONSTRAINT "UQ_patrol_checkpoints_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "UQ_patrol_checkpoints_id_company_site" UNIQUE ("id", "companyId", "siteId"),
        CONSTRAINT "CHK_patrol_checkpoints_public_id" CHECK ("publicId" ~ '^[0-9a-f]{32}$'),
        CONSTRAINT "CHK_patrol_checkpoints_token_version" CHECK ("tokenVersion" >= 1),
        CONSTRAINT "CHK_patrol_checkpoints_label" CHECK (btrim("label") <> ''),
        CONSTRAINT "CHK_patrol_checkpoints_location" CHECK (("latitude" IS NULL) = ("longitude" IS NULL)
          AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180))),
        CONSTRAINT "CHK_patrol_checkpoints_proximity" CHECK ("proximityMeters" IS NULL OR "proximityMeters" BETWEEN 10 AND 1000),
        CONSTRAINT "CHK_patrol_checkpoints_revoked_inactive" CHECK ("revokedAt" IS NULL OR "active" = false)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_routes" (
        "id"               SERIAL NOT NULL,
        "companyId"        integer NOT NULL,
        "siteId"           integer NOT NULL,
        "name"             character varying(120) NOT NULL,
        "orderMode"        character varying(16) NOT NULL DEFAULT 'any',
        "active"           boolean NOT NULL DEFAULT true,
        "archivedAt"       TIMESTAMP WITH TIME ZONE,
        "createdByUserId"  integer,
        "updatedByUserId"  integer,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_routes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_routes_id_company_site" UNIQUE ("id", "companyId", "siteId"),
        CONSTRAINT "CHK_patrol_routes_order_mode" CHECK ("orderMode" IN ('any', 'strict')),
        CONSTRAINT "CHK_patrol_routes_name" CHECK (btrim("name") <> ''),
        CONSTRAINT "CHK_patrol_routes_archived_inactive" CHECK ("archivedAt" IS NULL OR "active" = false)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_route_checkpoints" (
        "id"            SERIAL NOT NULL,
        "companyId"     integer NOT NULL,
        "siteId"        integer NOT NULL,
        "routeId"       integer NOT NULL,
        "checkpointId"  integer NOT NULL,
        "position"      integer NOT NULL,
        "required"      boolean NOT NULL DEFAULT true,
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_route_checkpoints" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_route_checkpoints_position" UNIQUE ("routeId", "position"),
        CONSTRAINT "UQ_patrol_route_checkpoints_checkpoint" UNIQUE ("routeId", "checkpointId"),
        CONSTRAINT "CHK_patrol_route_checkpoints_position" CHECK ("position" >= 1)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_schedules" (
        "id"                SERIAL NOT NULL,
        "companyId"         integer NOT NULL,
        "siteId"            integer NOT NULL,
        "routeId"           integer,
        "name"              character varying(120) NOT NULL,
        "daysOfWeek"        jsonb NOT NULL DEFAULT '[1, 2, 3, 4, 5, 6, 7]',
        "activeFrom"        character varying(5) NOT NULL,
        "activeTo"          character varying(5) NOT NULL,
        "frequencyMinutes"  integer NOT NULL,
        "windowMinutes"     integer NOT NULL,
        "startsOn"          date,
        "endsOn"            date,
        "active"            boolean NOT NULL DEFAULT true,
        "archivedAt"        TIMESTAMP WITH TIME ZONE,
        "createdByUserId"   integer,
        "updatedByUserId"   integer,
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_schedules" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_schedules_id_company_site" UNIQUE ("id", "companyId", "siteId"),
        CONSTRAINT "CHK_patrol_schedules_frequency" CHECK ("frequencyMinutes" BETWEEN 15 AND 1440),
        CONSTRAINT "CHK_patrol_schedules_window" CHECK ("windowMinutes" BETWEEN 5 AND 1440 AND "windowMinutes" <= "frequencyMinutes"),
        CONSTRAINT "CHK_patrol_schedules_active_period" CHECK ("activeFrom" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "activeTo" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
        CONSTRAINT "CHK_patrol_schedules_days" CHECK (jsonb_typeof("daysOfWeek") = 'array' AND jsonb_array_length("daysOfWeek") BETWEEN 1 AND 7
          AND "daysOfWeek" <@ '[1, 2, 3, 4, 5, 6, 7]'::jsonb),
        CONSTRAINT "CHK_patrol_schedules_dates" CHECK ("startsOn" IS NULL OR "endsOn" IS NULL OR "endsOn" >= "startsOn"),
        CONSTRAINT "CHK_patrol_schedules_name" CHECK (btrim("name") <> ''),
        CONSTRAINT "CHK_patrol_schedules_archived_inactive" CHECK ("archivedAt" IS NULL OR "active" = false)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_runs" (
        "id"                 SERIAL NOT NULL,
        "companyId"          integer NOT NULL,
        "siteId"             integer NOT NULL,
        "shiftId"            integer NOT NULL,
        "guardId"            integer NOT NULL,
        "startedByUserId"    integer NOT NULL,
        "scheduleId"         integer,
        "routeId"            integer,
        "windowKey"          character varying(64),
        "scopeKey"           character varying(32) NOT NULL DEFAULT 'site',
        "windowStart"        TIMESTAMP WITH TIME ZONE,
        "windowEnd"          TIMESTAMP WITH TIME ZONE,
        "status"             character varying(24) NOT NULL DEFAULT 'in_progress',
        "verificationStatus" character varying(24) NOT NULL DEFAULT 'pending',
        "startedAtDevice"    TIMESTAMP WITH TIME ZONE NOT NULL,
        "startedAtServer"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completedAtDevice"  TIMESTAMP WITH TIME ZONE,
        "completedAtServer"  TIMESTAMP WITH TIME ZONE,
        "clockOffsetMs"      integer,
        "exceptionReason"    character varying(500),
        "clientRunId"        character varying(64) NOT NULL,
        "syncedLate"         boolean NOT NULL DEFAULT false,
        "verifiedAt"         TIMESTAMP WITH TIME ZONE,
        "createdAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_runs_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "CHK_patrol_runs_status" CHECK ("status" IN ('in_progress', 'completed', 'incomplete', 'closed_by_system')),
        CONSTRAINT "CHK_patrol_runs_verification_status" CHECK ("verificationStatus" IN ('pending', 'verified', 'unverified', 'flagged')),
        CONSTRAINT "CHK_patrol_runs_client_run_id" CHECK ("clientRunId" ~ '^[A-Za-z0-9_-]{8,64}$'),
        CONSTRAINT "CHK_patrol_runs_completion" CHECK (("status" = 'in_progress') = ("completedAtServer" IS NULL)),
        CONSTRAINT "CHK_patrol_runs_incomplete_reason" CHECK ("status" <> 'incomplete' OR ("exceptionReason" IS NOT NULL AND btrim("exceptionReason") <> '')),
        CONSTRAINT "CHK_patrol_runs_window" CHECK ("windowStart" IS NULL OR "windowEnd" IS NULL OR "windowEnd" > "windowStart")
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_checkpoint_visits" (
        "id"                   SERIAL NOT NULL,
        "companyId"            integer NOT NULL,
        "runId"                integer NOT NULL,
        "checkpointId"         integer,
        "scannedPublicId"      character varying(64),
        "scannedTokenVersion"  integer,
        "scannedKeyId"         character varying(32),
        "scanPayload"          character varying(256),
        "method"               character varying(16) NOT NULL DEFAULT 'qr',
        "result"               character varying(16) NOT NULL,
        "flags"                jsonb NOT NULL DEFAULT '[]',
        "provisional"          boolean NOT NULL DEFAULT true,
        "scannedAtDevice"      TIMESTAMP WITH TIME ZONE NOT NULL,
        "receivedAtServer"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "latitude"             double precision,
        "longitude"            double precision,
        "accuracyMeters"       double precision,
        "distanceMeters"       double precision,
        "coordinatesPurgedAt"  TIMESTAMP WITH TIME ZONE,
        "clientVisitId"        character varying(64) NOT NULL,
        "createdAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_checkpoint_visits" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_checkpoint_visits_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "CHK_patrol_checkpoint_visits_method" CHECK ("method" IN ('qr', 'nfc', 'manual')),
        CONSTRAINT "CHK_patrol_checkpoint_visits_result" CHECK ("result" IN ('verified', 'unverified', 'flagged')),
        CONSTRAINT "CHK_patrol_checkpoint_visits_flags" CHECK (jsonb_typeof("flags") = 'array'),
        CONSTRAINT "CHK_patrol_checkpoint_visits_client_visit_id" CHECK ("clientVisitId" ~ '^[A-Za-z0-9_-]{8,64}$'),
        CONSTRAINT "CHK_patrol_checkpoint_visits_scanned" CHECK ("scannedPublicId" IS NOT NULL OR "scanPayload" IS NOT NULL),
        CONSTRAINT "CHK_patrol_checkpoint_visits_location" CHECK (("latitude" IS NULL) = ("longitude" IS NULL))
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_evidence" (
        "id"                   SERIAL NOT NULL,
        "companyId"            integer NOT NULL,
        "siteId"               integer NOT NULL,
        "runId"                integer NOT NULL,
        "visitId"              integer,
        "guardId"              integer NOT NULL,
        "shiftId"              integer NOT NULL,
        "source"               character varying(16) NOT NULL DEFAULT 'camera',
        "kind"                 character varying(24) NOT NULL DEFAULT 'run_photo',
        "storageKey"           character varying(512),
        "quarantineKey"        character varying(512),
        "mimeType"             character varying(64),
        "sizeBytes"            bigint,
        "widthPx"              integer,
        "heightPx"             integer,
        "sha256Client"         character varying(64) NOT NULL,
        "sha256Stored"         character varying(64),
        "capturedAtDevice"     TIMESTAMP WITH TIME ZONE NOT NULL,
        "receivedAt"           TIMESTAMP WITH TIME ZONE,
        "verifiedAt"           TIMESTAMP WITH TIME ZONE,
        "uploadStatus"         character varying(24) NOT NULL DEFAULT 'pending',
        "rejectionReason"      character varying(64),
        "retentionDays"        integer,
        "expiresAt"            TIMESTAMP WITH TIME ZONE,
        "retentionStatus"      character varying(16) NOT NULL DEFAULT 'active',
        "claimToken"           uuid,
        "claimedAt"            TIMESTAMP WITH TIME ZONE,
        "quarantinedAt"        TIMESTAMP WITH TIME ZONE,
        "purgedAt"             TIMESTAMP WITH TIME ZONE,
        "restoredAt"           TIMESTAMP WITH TIME ZONE,
        "deletionAttempts"     integer NOT NULL DEFAULT 0,
        "lastDeletionError"    character varying(500),
        "deletionReason"       character varying(64),
        "latitude"             double precision,
        "longitude"            double precision,
        "accuracyMeters"       double precision,
        "coordinatesPurgedAt"  TIMESTAMP WITH TIME ZONE,
        "clientEvidenceId"     character varying(64) NOT NULL,
        "createdAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_evidence" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_evidence_id_company" UNIQUE ("id", "companyId"),
        CONSTRAINT "CHK_patrol_evidence_source" CHECK ("source" IN ('camera')),
        CONSTRAINT "CHK_patrol_evidence_kind" CHECK ("kind" IN ('run_photo', 'checkpoint_photo')),
        CONSTRAINT "CHK_patrol_evidence_upload_status" CHECK ("uploadStatus" IN ('pending', 'uploaded', 'verified', 'rejected', 'local_corrupt')),
        CONSTRAINT "CHK_patrol_evidence_retention_status" CHECK ("retentionStatus" IN ('active', 'claimed', 'quarantined', 'purged', 'tombstone')),
        CONSTRAINT "CHK_patrol_evidence_retention_days" CHECK ("retentionDays" IS NULL OR "retentionDays" IN (30, 90)),
        CONSTRAINT "CHK_patrol_evidence_sha256" CHECK ("sha256Client" ~ '^[0-9a-f]{64}$' AND ("sha256Stored" IS NULL OR "sha256Stored" ~ '^[0-9a-f]{64}$')),
        CONSTRAINT "CHK_patrol_evidence_size" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
        CONSTRAINT "CHK_patrol_evidence_deletion_attempts" CHECK ("deletionAttempts" >= 0),
        CONSTRAINT "CHK_patrol_evidence_claim" CHECK ("retentionStatus" <> 'claimed' OR ("claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL)),
        CONSTRAINT "CHK_patrol_evidence_purged" CHECK ("retentionStatus" NOT IN ('purged', 'tombstone') OR "purgedAt" IS NOT NULL),
        CONSTRAINT "CHK_patrol_evidence_client_evidence_id" CHECK ("clientEvidenceId" ~ '^[A-Za-z0-9_-]{8,64}$'),
        CONSTRAINT "CHK_patrol_evidence_location" CHECK (("latitude" IS NULL) = ("longitude" IS NULL))
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_exceptions" (
        "id"                SERIAL NOT NULL,
        "companyId"         integer NOT NULL,
        "siteId"            integer NOT NULL,
        "runId"             integer,
        "scheduleId"        integer,
        "shiftId"           integer,
        "windowKey"         character varying(64) NOT NULL,
        "scopeKey"          character varying(32) NOT NULL DEFAULT 'site',
        "type"              character varying(32) NOT NULL,
        "status"            character varying(16) NOT NULL DEFAULT 'open',
        "safetyAlertId"     integer,
        "note"              character varying(1000),
        "resolution"        character varying(64),
        "resolvedByUserId"  integer,
        "resolvedAt"        TIMESTAMP WITH TIME ZONE,
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_exceptions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_patrol_exceptions_type" CHECK ("type" IN ('patrol_missed', 'patrol_late', 'patrol_incomplete', 'checkpoint_missed', 'evidence_unverified')),
        CONSTRAINT "CHK_patrol_exceptions_status" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
        CONSTRAINT "CHK_patrol_exceptions_resolved" CHECK (("status" = 'resolved') = ("resolvedAt" IS NOT NULL))
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_evidence_holds" (
        "id"                SERIAL NOT NULL,
        "companyId"         integer NOT NULL,
        "scope"             character varying(24) NOT NULL,
        "evidenceId"        integer,
        "runId"             integer,
        "shiftId"           integer,
        "siteId"            integer,
        "fromDate"          date,
        "toDate"            date,
        "reason"            character varying(1000) NOT NULL,
        "source"            character varying(16) NOT NULL DEFAULT 'manual',
        "incidentId"        integer,
        "safetyAlertId"     integer,
        "exceptionId"       integer,
        "createdByUserId"   integer,
        "autoReleaseAfter"  TIMESTAMP WITH TIME ZONE,
        "releasedAt"        TIMESTAMP WITH TIME ZONE,
        "releasedByUserId"  integer,
        "releaseReason"     character varying(1000),
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_evidence_holds" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_patrol_evidence_holds_scope" CHECK ("scope" IN ('evidence', 'run', 'shift', 'site_date_range')),
        CONSTRAINT "CHK_patrol_evidence_holds_source" CHECK ("source" IN ('manual', 'incident', 'alert', 'exception')),
        CONSTRAINT "CHK_patrol_evidence_holds_reason" CHECK (btrim("reason") <> ''),
        CONSTRAINT "CHK_patrol_evidence_holds_target" CHECK (
          ("scope" = 'evidence' AND "evidenceId" IS NOT NULL) OR ("scope" = 'run' AND "runId" IS NOT NULL)
          OR ("scope" = 'shift' AND "shiftId" IS NOT NULL)
          OR ("scope" = 'site_date_range' AND "siteId" IS NOT NULL AND "fromDate" IS NOT NULL AND "toDate" IS NOT NULL AND "toDate" >= "fromDate")),
        CONSTRAINT "CHK_patrol_evidence_holds_manual_creator" CHECK ("source" <> 'manual' OR "createdByUserId" IS NOT NULL)
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS "patrol_storage_usage_daily" (
        "id"          SERIAL NOT NULL,
        "companyId"   integer NOT NULL,
        "siteId"      integer NOT NULL,
        "day"         date NOT NULL,
        "objects"     integer NOT NULL DEFAULT 0,
        "bytes"       bigint NOT NULL DEFAULT 0,
        "computedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_patrol_storage_usage_daily" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_patrol_storage_usage_daily_day" UNIQUE ("companyId", "siteId", "day"),
        CONSTRAINT "CHK_patrol_storage_usage_daily_counts" CHECK ("objects" >= 0 AND "bytes" >= 0)
      )
    `);

    // ── Foreign keys. Evidence-bearing references RESTRICT (a run, a scan or a photo record never disappears because
    // something it points at was deleted). Composite keys tie a child to its parent's company (and a route link to
    // one site), so a cross-tenant or cross-site reference cannot be stored at all.
    const foreignKeys: Array<[string, string, string, string]> = [
      // [table, constraint, definition, on delete]
      ['patrol_policies', 'FK_patrol_policies_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_policies', 'FK_patrol_policies_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_policies', 'FK_patrol_policies_updated_by', '("updatedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_revoked_by', '("revokedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_created_by', '("createdByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_checkpoints', 'FK_patrol_checkpoints_updated_by', '("updatedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_routes', 'FK_patrol_routes_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_routes', 'FK_patrol_routes_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_routes', 'FK_patrol_routes_created_by', '("createdByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_routes', 'FK_patrol_routes_updated_by', '("updatedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_route_checkpoints', 'FK_patrol_route_checkpoints_route',
        '("routeId", "companyId", "siteId") REFERENCES "patrol_routes"("id", "companyId", "siteId")', 'CASCADE'],
      ['patrol_route_checkpoints', 'FK_patrol_route_checkpoints_checkpoint',
        '("checkpointId", "companyId", "siteId") REFERENCES "patrol_checkpoints"("id", "companyId", "siteId")', 'RESTRICT'],
      ['patrol_schedules', 'FK_patrol_schedules_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_schedules', 'FK_patrol_schedules_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_schedules', 'FK_patrol_schedules_route', '("routeId", "companyId", "siteId") REFERENCES "patrol_routes"("id", "companyId", "siteId")', 'RESTRICT'],
      ['patrol_schedules', 'FK_patrol_schedules_created_by', '("createdByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_schedules', 'FK_patrol_schedules_updated_by', '("updatedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_shift', '("shiftId") REFERENCES "shifts"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_guard', '("guardId") REFERENCES "guard_profiles"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_started_by', '("startedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_schedule', '("scheduleId", "companyId", "siteId") REFERENCES "patrol_schedules"("id", "companyId", "siteId")', 'RESTRICT'],
      ['patrol_runs', 'FK_patrol_runs_route', '("routeId", "companyId", "siteId") REFERENCES "patrol_routes"("id", "companyId", "siteId")', 'RESTRICT'],
      ['patrol_checkpoint_visits', 'FK_patrol_checkpoint_visits_run', '("runId", "companyId") REFERENCES "patrol_runs"("id", "companyId")', 'RESTRICT'],
      ['patrol_checkpoint_visits', 'FK_patrol_checkpoint_visits_checkpoint', '("checkpointId", "companyId") REFERENCES "patrol_checkpoints"("id", "companyId")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_run', '("runId", "companyId") REFERENCES "patrol_runs"("id", "companyId")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_visit', '("visitId", "companyId") REFERENCES "patrol_checkpoint_visits"("id", "companyId")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_guard', '("guardId") REFERENCES "guard_profiles"("id")', 'RESTRICT'],
      ['patrol_evidence', 'FK_patrol_evidence_shift', '("shiftId") REFERENCES "shifts"("id")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_run', '("runId", "companyId") REFERENCES "patrol_runs"("id", "companyId")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_schedule', '("scheduleId", "companyId", "siteId") REFERENCES "patrol_schedules"("id", "companyId", "siteId")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_shift', '("shiftId") REFERENCES "shifts"("id")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_safety_alert', '("safetyAlertId") REFERENCES "safety_alerts"("id")', 'RESTRICT'],
      ['patrol_exceptions', 'FK_patrol_exceptions_resolved_by', '("resolvedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_evidence', '("evidenceId", "companyId") REFERENCES "patrol_evidence"("id", "companyId")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_run', '("runId", "companyId") REFERENCES "patrol_runs"("id", "companyId")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_shift', '("shiftId") REFERENCES "shifts"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_incident', '("incidentId") REFERENCES "incidents"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_safety_alert', '("safetyAlertId") REFERENCES "safety_alerts"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_exception', '("exceptionId") REFERENCES "patrol_exceptions"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_created_by', '("createdByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_evidence_holds', 'FK_patrol_evidence_holds_released_by', '("releasedByUserId") REFERENCES "users"("id")', 'RESTRICT'],
      ['patrol_storage_usage_daily', 'FK_patrol_storage_usage_daily_company', '("companyId") REFERENCES "companies"("id")', 'RESTRICT'],
      ['patrol_storage_usage_daily', 'FK_patrol_storage_usage_daily_site', '("siteId") REFERENCES "sites"("id")', 'RESTRICT'],
    ];
    for (const [table, name, definition, onDelete] of foreignKeys) {
      await q(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ${definition} ON DELETE ${onDelete} ON UPDATE NO ACTION;
          END IF;
        END $$
      `);
    }

    const indexes: string[] = [
      // One company default (siteId NULL) and one row per site. Two partial indexes rather than NULLS NOT DISTINCT, which
      // needs PostgreSQL 15.
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_policies_company_default" ON "patrol_policies" ("companyId") WHERE "siteId" IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_policies_company_site" ON "patrol_policies" ("companyId", "siteId") WHERE "siteId" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_checkpoints_company_site" ON "patrol_checkpoints" ("companyId", "siteId")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_routes_company_site" ON "patrol_routes" ("companyId", "siteId")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_route_checkpoints_checkpoint" ON "patrol_route_checkpoints" ("checkpointId")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_schedules_company_site" ON "patrol_schedules" ("companyId", "siteId")`,
      // Idempotency: a client-generated id is unique per company; a replay returns the existing row.
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_runs_client_run_id" ON "patrol_runs" ("companyId", "clientRunId")`,
      // One run per (schedule, window, scope) once P1-B assigns windows (P1-A never sets windowKey).
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_runs_schedule_window_scope" ON "patrol_runs" ("scheduleId", "windowKey", "scopeKey")
         WHERE "scheduleId" IS NOT NULL AND "windowKey" IS NOT NULL`,
      // At most one open run per Guard per shift: two different runs started at once cannot both be open.
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_runs_one_open_per_guard_shift" ON "patrol_runs" ("shiftId", "guardId") WHERE "status" = 'in_progress'`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_runs_company_site_started" ON "patrol_runs" ("companyId", "siteId", "startedAtServer")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_runs_shift" ON "patrol_runs" ("shiftId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_checkpoint_visits_client_visit_id" ON "patrol_checkpoint_visits" ("companyId", "clientVisitId")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_checkpoint_visits_run" ON "patrol_checkpoint_visits" ("runId")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_checkpoint_visits_checkpoint" ON "patrol_checkpoint_visits" ("checkpointId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_evidence_client_evidence_id" ON "patrol_evidence" ("companyId", "clientEvidenceId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_evidence_storage_key" ON "patrol_evidence" ("storageKey") WHERE "storageKey" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_expiry" ON "patrol_evidence" ("expiresAt") WHERE "retentionStatus" = 'active' AND "expiresAt" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_run" ON "patrol_evidence" ("runId")`,
      // One open (not resolved) exception per (company, window, scope, type): concurrent sweeps raise one.
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_patrol_exceptions_open_window_type" ON "patrol_exceptions" ("companyId", "windowKey", "scopeKey", "type")
         WHERE "status" <> 'resolved'`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_exceptions_company_status" ON "patrol_exceptions" ("companyId", "status")`,
      `CREATE INDEX IF NOT EXISTS "IDX_patrol_evidence_holds_active" ON "patrol_evidence_holds" ("companyId") WHERE "releasedAt" IS NULL`,
    ];
    for (const sql of indexes) await q(sql);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Runs, scans, photo records, exceptions and holds are operational evidence. Rolling back would delete them, so it is
    // refused while any exist. Configuration (policies, schedules, checkpoints, routes) and the switch are not evidence
    // and go with the tables. A code rollback never needs this: older code ignores the tables and the column.
    const present = (await queryRunner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['patrol_runs', 'patrol_checkpoint_visits', 'patrol_evidence', 'patrol_exceptions', 'patrol_evidence_holds']],
    )) as Array<{ table_name: string }>;
    const blocking: string[] = [];
    for (const { table_name: table } of present) {
      const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM "${table}"`);
      if (Number(n) > 0) blocking.push(`${n} ${table}`);
    }
    if (blocking.length) {
      throw new Error(
        `Refusing to revert AddPatrolManagement1720900000014: ${blocking.join(', ')} exist. ` +
          'Export them (pg_dump of the patrol_* tables and audit_logs) and get explicit approval before removing them.',
      );
    }
    for (const table of [
      'patrol_storage_usage_daily', 'patrol_evidence_holds', 'patrol_exceptions', 'patrol_evidence', 'patrol_checkpoint_visits',
      'patrol_runs', 'patrol_schedules', 'patrol_route_checkpoints', 'patrol_routes', 'patrol_checkpoints', 'patrol_policies',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "patrolsEnabled"`);
  }
}
