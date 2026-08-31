# S4 Deployment Rollback Runbook

## Principle

Application rollback and database rollback are different operations. Never blindly revert a database migration just because an application deploy is rolled back.

Prefer forward-compatible migrations so the prior application version can temporarily run against the migrated schema. If a migration is destructive or incompatible with the previous release, the release requires an explicit recovery plan before deployment.

For RC1, configuration commit `f1fd5620ec256586d1ba147fd2db5139eb85f531` contains the same application and database model as `083136ac52697fe5117909c48d74fed259975b42`. That application SHA is the oldest certified rollback boundary. `e6c1a8109e65f17bb1f1650dd2c57ce67f611fd4` was verified to start and read the RC1 schema, but it predates UAT2-HIRE-01 and must not be selected for pilot rollback because it restores the pre-hire compliance deadlock.

## Rollback triggers

Initiate rollback for any of the following after deployment:

- `/health/ready` cannot become healthy.
- authentication or tenant isolation materially fails.
- P0 guard attendance/operations cannot complete.
- data corruption or materially wrong finance calculations appear.
- sustained Critical/High runtime errors have no immediate safe fix.
- migration produced an unexpected schema/data state.

## Application-only rollback

Use when database migrations are backward-compatible and data is intact.

1. Declare release incident and record current/new SHA.
2. Stop further release changes.
3. In Render, deploy the last known-good production commit.
4. Do NOT automatically run `migration:revert:prod`.
5. Confirm `/health/live` and `/health/ready`.
6. Execute production smoke tests.
7. Confirm tenant access and core guard operations.
8. Keep the incident open until the cause is understood and a new RC is certified.

If no certified prior application remains compatible and free of closed Critical/High defects, declare application rollback unavailable and use a forward fix. Keep the current database intact, restrict writes if required, preserve evidence, certify the smallest corrective release, then deploy it through the normal release gate.

## Database-impacting rollback

Use when the new release has changed or corrupted persistent data/schema such that application-only rollback is unsafe.

1. Stop or restrict writes where operationally possible.
2. Capture the current broken database state for investigation before destroying anything.
3. Identify the last known-good recovery point.
4. Restore to a new database using `BACKUP_RESTORE.md`.
5. Validate the recovered database in isolation.
6. Deploy the matching last-known-good application SHA against the recovered database.
7. Switch production `DATABASE_URL` only after validation and release-owner approval.
8. Confirm readiness and full critical smoke tests.
9. Preserve the old database until incident closure.

## Migration revert command

A TypeORM revert exists for controlled cases:

```bash
npm run migration:revert:prod
```

Use it only when the specific migration's `down()` path has been reviewed and tested with representative data. Do not use a migration revert as a substitute for database recovery.

Never migration-revert merely to match an older application image. Prefer the newer forward-compatible schema, and restore a separately validated backup only when application-only rollback cannot protect data integrity.

## Rollback evidence

Record:

- incident ID;
- failed release SHA;
- restored application SHA;
- database recovery point if used;
- migrations present before/after;
- start/end UTC times;
- smoke/UAT evidence;
- estimated data loss window;
- customer communications required.

## Exit criteria

Rollback is complete only when:

- service is healthy and ready;
- P0 smoke tests pass;
- no continuing data-integrity issue is known;
- affected customer/support teams have been updated;
- follow-up defect is in the release backlog;
- failed release cannot automatically redeploy.
