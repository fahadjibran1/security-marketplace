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
