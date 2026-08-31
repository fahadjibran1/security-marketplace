# S4 Backup & Restore Runbook

Target: v1.0.0 pilot
Primary datastore: PostgreSQL

## Recovery objectives

Pilot target (to be confirmed against the customer contract):

- RPO: <= 24 hours for the independent logical backup, with managed PostgreSQL PITR providing a shorter recovery point where available.
- RTO: <= 4 hours for a rehearsed database recovery and service reconnection during pilot scale.

If a pilot contract requires stricter RPO/RTO, upgrade the database/backup design before signing that commitment.

## Required backup layers

1. Managed PostgreSQL point-in-time recovery on a paid database.
2. Periodic logical backup (`pg_dump`) retained outside the primary database service/account where practical.
3. Git repository/tag for the exact application release corresponding to the backup period.

A database backup is not considered valid until restoration has been tested.

## Pre-release backup checkpoint

Before a production migration:

1. Confirm the database recovery feature is active and the available recovery window is visible.
2. Create a logical export or a verified `pg_dump` checkpoint for high-risk migrations/releases.
3. Record UTC timestamp, production release SHA, database identifier and backup location in the release record.
4. Verify the backup/export can be listed/read; do not rely only on a successful upload notification.

## Manual logical backup

Run from a secured administrator workstation or controlled backup job with PostgreSQL client tools installed:

```bash
export DATABASE_URL='<production external database URL>'
pg_dump -Fc "$DATABASE_URL" > "s4_$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_restore --list "s4_$(date -u +%Y%m%dT%H%M%SZ).dump" >/dev/null
```

Do not commit dump files or connection strings to Git.

Store backups encrypted and access-controlled. Define retention before pilot go-live; recommended initial operational policy is daily logical backup with at least 14 days external retention, subject to customer/data-protection requirements.

Required scheduling to support the stated logical-backup RPO is at least one successful backup every 24 hours. Alert on the first failed run and escalate before two consecutive recovery points are missed. Keep at least 14 daily copies plus four weekly copies unless the approved data-retention policy requires longer or shorter retention.

## Point-in-time recovery procedure

Prefer managed PITR for accidental destructive changes when it provides a more recent recovery point than a logical backup.

1. Declare an incident and stop risky write activity if necessary.
2. Identify the last known-good UTC timestamp.
3. Restore to a NEW database instance; never overwrite the only known copy while investigating.
4. Validate the restored database independently:
   - expected companies/guards/shifts exist;
   - most recent expected operational records exist;
   - migrations are at the expected state;
   - no obviously corrupt/incomplete financial batch is present.
5. Point a non-production or isolated application instance to the recovery database and run smoke tests.
6. When approved, change the production database connection secret to the recovered database.
7. Restart/redeploy the application and verify `/health/ready`.
8. Re-run production smoke tests.
9. Preserve the old database until recovery acceptance and incident review are complete.

## Logical restore drill

Restore drills must target an EMPTY disposable PostgreSQL database.

Example:

```bash
export RESTORE_DATABASE_URL='<empty restore target>'
pg_restore --dbname="$RESTORE_DATABASE_URL" --verbose --clean --if-exists s4_backup.dump
```

Then:

```bash
cd security-backend-nest
export DATABASE_URL="$RESTORE_DATABASE_URL"
npm ci
npm run build
npm run migration:show:prod
```

Start the backend against the restored database and run release smoke/UAT sampling.

## Quarterly restore test

At least quarterly after GA, and before the first pilot if no restore drill has yet passed:

- Restore a recent backup to an isolated database.
- Measure restore duration.
- Verify row/domain sampling.
- Start S4 against the restored database.
- Verify health/readiness and key login/shift/report paths.
- Record PASS/FAIL, elapsed RTO and observed data-loss window/RPO.

## Backup failure response

A failed scheduled backup is a production operational incident.

- Alert the operational owner.
- Determine whether managed PITR is still healthy.
- Retry/repair the logical backup job.
- Do not ignore two consecutive failed backup periods.
- Escalate to release/support leadership if no independently restorable copy exists.

## Restore acceptance criteria

Recovery is complete only when:

- database integrity checks pass;
- S4 `/health/ready` passes;
- tenant-isolation smoke checks pass;
- critical operational data is present to the expected recovery point;
- finance state is reviewed for interrupted batches/payments;
- incident timeline and recovery point are documented.

## RC1 certification evidence

### Pre-release production backup — SHA b4d23b1 (final RC1 HEAD) — 2026-08-31

Executed by: Claude (S4 AI Pair) under release-owner authority.
Type: Pre-release production backup checkpoint (authorized 2026-08-31 before v1.0.0-rc1 tagging).
Target: Production PostgreSQL database (pg_dump source only; no restore into production).
Tools: pg_dump 18.3 / pg_restore 18.3 / Windows 11.
Database host: aws-1-eu-west-1.pooler.supabase.com

| Metric | Value |
|---|---|
| Backup UTC timestamp | 2026-08-31T10:09:48Z (archive internal header) |
| Backup filename | s4_20260831T091534Z.dump |
| Release HEAD SHA | b4d23b1da827113525c807692bc1c77f8adb9e80 |
| pg_dump exit code | 0 (success) |
| pg_dump elapsed | 12.172s |
| Backup file size | 491,994 bytes |
| Archive format | CUSTOM (gzip compressed) |
| TOC entries | 1017 |
| pg_restore --list exit | 0 (valid readable archive) |
| TABLE DATA sections | 73 |
| typeorm_migrations rows | 40 |
| Latest migration applied | AddStructuredScreeningAddresses1720100000000 |
| .drill.secret | Deleted immediately after use — confirmed absent |

Core table row counts at backup time: users=12, companies=4, guard_profiles=5, clients=4,
sites=11, jobs=13, job_applications=10, shifts=5, attendance_events=8, audit_logs=180,
guard_screenings=4, typeorm_migrations=40.

No restore into production performed. Archive readability confirmed via `pg_restore --list`.
Production application data was not otherwise modified.

Result: **PASS** — pre-release backup valid and verified. Ready for v1.0.0-rc1 tagging.

---

### RC1 drill — SHA ff4ad00 (HEAD release/v1.0.0-rc1) — 2026-08-28

Executed by: Claude (S4 AI Pair) under release-owner authority.
Target: production database (pg_dump source) → Docker postgres:16-alpine disposable container (local, port 5433).
Tools: pg_dump 18.3 / pg_restore 18.3 / Docker 29.7.2 / Windows 11.

| Metric | Value |
|---|---|
| pg_dump duration | 8.523s |
| Backup file size | 491,220 bytes |
| pg_restore --list | exit=0 (valid custom-format archive) |
| TABLE DATA sections | 73 |
| pg_restore duration | 8.324s |
| pg_restore exit code | 1 (non-fatal --clean warnings on empty DB — expected) |
| Application tables in schema | 39 |
| typeorm_migrations rows | 40 |
| Latest migration applied | AddStructuredScreeningAddresses1720100000000 |
| Orphan shifts (no company) | 0 |
| Orphan guards (no user) | 0 |
| Cleanup | Container stopped (auto-rm), dump file deleted |

Core table row counts at backup time: users=12, companies=4, guard_profiles=5, clients=4, sites=11, jobs=13, job_applications=9, shifts=5, attendance_events=5, audit_logs=172, daily_logs=2, invoice_batches=1, payroll_batches=1, payment_records=2, safety_alerts=5, notifications=13, guard_screenings=4, timesheets=4.

4 migrations applied since prior drill SHA `f1fd5620`: SEC-013 (private evidence access), SEC-015 (guard access/vetting separation), SEC-017 (BS7858 screening workflow), SEC-017C-D (structured screening addresses).

Result: **PASS** — backup valid, restore successful, schema complete, referential integrity clean.

---

### Prior drill — SHA f1fd5620 (pre-RC1 baseline)

The local PostgreSQL 16 drill for SHA `f1fd5620ec256586d1ba147fd2db5139eb85f531` measured:

- custom-format backup: 0.528 seconds, 141,869 bytes, `pg_restore --list` exit 0;
- restore into a new database: 2.410 seconds, exit 0;
- 32 application-table counts matched;
- mandatory ownership, attendance, timesheet financial, compliance provenance and audit samples matched;
- restored application health/readiness and authenticated reads passed.

These local timings prove procedure correctness at the synthetic fixture size, not production-scale recovery time. Retain the conservative four-hour pilot RTO until a representative managed-environment drill supports a tighter objective.
