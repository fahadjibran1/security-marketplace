# First Platform Admin Bootstrap and Recovery

These commands are trusted operator operations. They are not HTTP endpoints and must run only from a controlled Render Shell or equivalent one-off environment against the intended S4 database.

## First Platform Admin bootstrap

Prerequisites:

- Deploy the certified application version containing SEC-014.
- Confirm `NODE_ENV=production`, `DATABASE_SYNCHRONIZE=false`, strict database TLS, and the intended production database connection.
- Query the database through an approved read-only operator channel and confirm the Platform Admin count is exactly zero.
- Generate a unique password of at least 12 characters containing upper-case, lower-case, numeric, and special characters. Do not put it in a command argument, ticket, log, or source file.

Inject `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` only into the one-off process environment, then run:

```text
npm run admin:bootstrap
```

The command takes a transaction-level advisory lock, refuses any existing Platform Admin or email collision, creates one ACTIVE Platform Admin, and writes `platform_admin.bootstrapped`. A safe success response contains only user ID and normalized email. Every failure exits non-zero.

Immediately remove the temporary variables. Verify the admin count is one, inspect the audit event for `actorType=SYSTEM_OPERATOR` and `method=trusted_cli`, and perform normal `/auth/login`. Then run RB-009 and confirm `/health/live` and `/health/ready` return 200.

Do not rerun the command to recover access. Once any Platform Admin exists it always refuses.

## Platform Admin recovery

Recovery targets an existing Platform Admin only. It never creates or promotes a user.

Prerequisites:

- Confirm the target normalized email belongs to exactly one Platform Admin.
- Obtain change authorization and generate a new strong password using the same handling rules as bootstrap.
- Set the following values only for the one-off process:
  - `RECOVER_ADMIN_EMAIL`
  - `RECOVER_ADMIN_PASSWORD`
  - `RECOVER_ADMIN_CONFIRM=RECOVER_EXISTING_PLATFORM_ADMIN`

Run:

```text
npm run admin:recover
```

The command resets the bcrypt password hash, changes the existing Platform Admin to ACTIVE, and writes `platform_admin.recovered` in one transaction. Remove all temporary variables immediately. Verify the audit event, normal login, RB-009, and both health endpoints.

## Failure modes

- Missing or invalid input, weak password, wrong confirmation, non-production mode, or `DATABASE_SYNCHRONIZE` other than `false`: correct the operator environment; no record is created.
- Existing admin during bootstrap: stop and use recovery if access is lost.
- Email collision during bootstrap or a non-admin recovery target: investigate identity state; never promote automatically.
- Database, TLS, creation, or audit failure: the transaction rolls back. Resolve the underlying failure before a newly authorized attempt.

Never disclose passwords, password hashes, JWTs, database credentials, or TLS material while diagnosing a failure.
