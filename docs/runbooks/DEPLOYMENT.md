# S4 Production Deployment Runbook

Target: v1.0.0 pilot
Platform baseline: Render web service + managed PostgreSQL
Release branch after approval: `release/v1.0.0-rc1`
Approved RC1 SHA: `f1fd5620ec256586d1ba147fd2db5139eb85f531`

## Release policy

Production deployment is manual for the pilot. `render.yaml` sets `autoDeployTrigger: off` and pins the service to `release/v1.0.0-rc1`. Do not deploy `main`, feature branches or UAT branches.

Only deploy a commit that has:

- Green S4 Backend Release Gate.
- Green S4 Mobile Release Gate for the corresponding mobile release where relevant.
- No open Critical/High release defect.
- Approved UAT evidence for the release candidate.
- Recorded backup/recovery checkpoint before migration.

## Production prerequisites

- Paid Render web service capable of pre-deploy commands.
- Paid PostgreSQL instance with recovery enabled.
- Exactly one scheduler-active backend instance for the pilot.
- Production `DATABASE_URL`.
- Strong generated `JWT_SECRET`.
- Explicit `CORS_ORIGIN` containing only approved portal origins.
- `DATABASE_SYNCHRONIZE=false`.
- `DATABASE_SSL=true` (mandatory in production).
- `DATABASE_CA_CERT` set as a Render secret to the trusted CA PEM supplied by the PostgreSQL provider. Literal `\\n` newlines are supported; never commit the certificate.
- `ENABLE_SWAGGER=false` unless temporarily enabled for an approved diagnostic purpose.
- `TRUST_PROXY=1` behind the single Render edge-proxy hop. Do not use `true`, which trusts arbitrary forwarding chains.
- Authentication throttling uses the API instance's in-memory store. Keep `numInstances: 1` for the pilot; multi-instance deployment requires a distributed/shared rate-limit store.
- The authentication limiter uses the first `X-Forwarded-For` address, which Render sets to the real client IP. Do not expose the API process directly without a trusted proxy that overwrites this first address.

Never place production secrets in GitHub, Blueprint files, screenshots or support tickets.

Production startup, migrations and RB-009 preflight fail closed before connecting if TLS is disabled or `DATABASE_CA_CERT` is absent/malformed. Obtain the CA from the database provider, compare its documented fingerprint through an independent trusted channel, and configure it in Render. To rotate it, add the provider's replacement CA during an approved window, run migrations/preflight and readiness checks, then remove the retired CA after provider confirmation. Verify the deployed service reaches `/health/ready` and that logs contain no certificate material. Local development and disposable test PostgreSQL remain non-TLS by default when `NODE_ENV` is not `production` and `DATABASE_SSL` is unset/false.

## Pre-deployment checklist

1. Confirm PR/release SHA and record it in the change ticket.
2. Confirm CI gates are green for that SHA.
3. Review migration files added since the current production SHA.
4. Confirm migrations are additive/backward-compatible where possible.
5. Confirm no irreversible destructive migration is being introduced without an approved recovery plan.
6. Create/confirm a recoverable database checkpoint according to `BACKUP_RESTORE.md`.
7. Run `npm run release:preflight-data` against the deployment database and require `PASS`/exit 0.
8. Confirm `/health/live` and `/health/ready` are healthy on the existing release.
9. Confirm support/hypercare owner is available for the deployment window.

## Render deployment sequence

The Blueprint defines:

- Build: `npm ci --include=dev && npm run build`
- Pre-deploy: `npm run migration:run:prod`
- Start: `npm run start:prod`
- Readiness probe: `/health/ready`

Deployment procedure:

1. Confirm `release/v1.0.0-rc1` resolves to the approved release SHA recorded in the change ticket.
2. In Render, verify the service branch is `release/v1.0.0-rc1` and auto deploy is OFF.
3. Trigger a manual deploy for the exact approved commit.
4. Watch build logs. Any dependency-install or compile failure is a failed deployment.
5. Watch pre-deploy logs. Any migration failure is a failed deployment; do not bypass the migration command.
6. Verify the new instance reaches `/health/live`.
7. Verify `/health/ready` returns healthy only after database connectivity succeeds.
8. Run the production smoke checks below.
9. At the first failed health, migration or smoke criterion, stop and use the decision process in `ROLLBACK.md`; do not continue applying unrelated changes.

## Production smoke checks

Use dedicated pilot test accounts, never another customer's account.

- Platform login succeeds.
- Company login succeeds.
- Guard login succeeds for an approved guard.
- Company dashboard loads own tenant only.
- Guard shift list loads.
- Client portal loads authorized client data only.
- Health readiness is green.
- Create/read a harmless test record if the deployment window permits, then remove/close it through normal application workflows.
- Confirm logs contain request IDs and no passwords, JWTs, NFC secrets or password hashes.

## Mobile release

A web/backend deploy does not by itself certify a new native app. Guard Mobile must separately pass:

- locked dependency install;
- TypeScript build;
- Expo SDK compatibility;
- Android production bundle;
- physical-device GPS Book On UAT for GPS-required sites.

Do not enable `requireGpsCheckIn` on a pilot site until that physical-device case has passed on the app build being distributed.

## Deployment success criteria

- New release is serving traffic.
- `/health/live` and `/health/ready` are healthy.
- Migrations show no pending release migration.
- P0 production smoke tests pass.
- No new Critical/High error is observed during the initial hypercare window.

If any success criterion fails, follow `ROLLBACK.md`.
