# S4 Production Deployment Runbook

Target: v1.0.0 pilot
Platform baseline: Render web service + managed PostgreSQL
Release branch after approval: `release/s4-pilot-rc1` (pilot release candidate, cut from the certified product commit; `release/v1.0.0-rc1` is the historical RC1 baseline and is not redeployed)
Approved RC1 SHA: `ccc23a425113322184e38f3477418347d227d763` (v1.0.0-rc1 tag)

## Release policy

Production deployment is manual for the pilot. `autoDeployTrigger` must remain `off` on the production service (`security-marketplace-api`). Do not deploy `main`, feature branches or UAT branches.

**Operational note (2026-08-31):** During the v1.0.0-rc1 controlled deployment the production Render service was found with `autoDeployTrigger: commit` (auto-deploy enabled), which did not match this policy. The setting was corrected to `off` via Render API PATCH before the main merge. Verify `autoDeployTrigger: off` on the Render dashboard before any future release window.

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
- `GUARD_DATA_ENCRYPTION_KEY` and `GUARD_DATA_HMAC_KEY` entered as Render secrets: two different 64-character hex strings (32 bytes each), e.g. `openssl rand -hex 32` run twice. The API refuses to start in production without them. Keep them out of GitHub and back them up in the secret store: losing the encryption key makes stored personnel data unreadable.
- `TZ=UTC` (set in the Blueprint). The server clock must be UTC because database timestamp columns carry no zone.
- `DATABASE_SSL=true` (mandatory in production).
- `DATABASE_CA_CERT` set as a Render secret to the trusted CA PEM supplied by the PostgreSQL provider. Literal `\\n` newlines are supported; never commit the certificate.
- `ENABLE_SWAGGER=false` unless temporarily enabled for an approved diagnostic purpose.
- `TRUST_PROXY=1` behind the single Render edge-proxy hop. Do not use `true`, which trusts arbitrary forwarding chains.
- Authentication throttling uses the API instance's in-memory store. Keep `numInstances: 1` for the pilot; multi-instance deployment requires a distributed/shared rate-limit store.
- The authentication limiter uses the first `X-Forwarded-For` address, which Render sets to the real client IP. Do not expose the API process directly without a trusted proxy that overwrites this first address.

Never place production secrets in GitHub, Blueprint files, screenshots or support tickets.

## HTTP security headers

The Nest application applies Helmet centrally before route handling. Production responses, including health endpoints, use one-year HSTS (`max-age=31536000`) without `includeSubDomains` or `preload`, deny framing, disable MIME sniffing, use `Referrer-Policy: no-referrer`, and apply a minimal API CSP (`default-src 'none'; frame-ancestors 'none'`). Helmet also supplies the COOP, CORP, Origin-Agent-Cluster, DNS-prefetch, download and cross-domain policies; `X-Powered-By` is disabled. The restrictive camera/microphone/geolocation `Permissions-Policy` remains application-specific.

HSTS assumes HTTPS termination at Render and `TRUST_PROXY=1` for the single trusted edge hop. The application does not add an HTTPS redirect. Helmet does not replace CORS: production origins remain explicitly controlled by `CORS_ORIGIN`, with credentials enabled and no wildcard. Non-production disables HSTS and CSP so localhost and Swagger remain usable; the remaining safe headers still apply.

After deployment, inspect both normal authenticated API responses and health endpoints, for example `curl -sS -D - -o /dev/null https://<approved-api-host>/health/ready`. Require HSTS, `nosniff`, frame protection, referrer policy and the production CSP, and confirm that no `X-Powered-By` header appears. Repeat with an approved and an unapproved `Origin` header to verify CORS independently. This verifies application output only; record any additional Render edge headers separately.

## Private compliance evidence

Guard compliance evidence must use a private, non-public S3-compatible bucket. Configure `EVIDENCE_STORAGE_ENDPOINT`, `EVIDENCE_STORAGE_REGION`, `EVIDENCE_STORAGE_BUCKET`, `EVIDENCE_STORAGE_ACCESS_KEY_ID`, and `EVIDENCE_STORAGE_SECRET_ACCESS_KEY` as Render secrets. `EVIDENCE_SIGNED_URL_TTL_SECONDS` defaults to 180 and must remain between 60 and 300 seconds. Production startup fails closed when this configuration is missing or the endpoint is not HTTPS.

S4 generates random object keys under the authenticated owner namespace. Normal document lists expose metadata only. Authorized upload and retrieval operations issue exact-object, read/write-specific SigV4 URLs for three minutes; they grant no bucket listing permission and are never written to audit logs. Configure bucket CORS only for approved portal origins and required `PUT`/`Content-Type` use. Keep all public-access settings disabled and give the S4 credential only object read/write access under the compliance prefix.

Before deployment, run RB-009. Any `guardDocumentsUsingLegacyExternalUrl` or inconsistent private-storage metadata is a blocker: export and classify those records, copy verified evidence into the private bucket through an approved migration process, validate ownership and hashes, populate the new metadata, and only then retire the legacy URL. Never infer an object key from an arbitrary URL. Database backups contain object metadata, not object bytes, so enable independent versioning/backup and retention for the private bucket.

After deployment, verify that normal compliance lists contain no `fileUrl`, `storageKey`, credentials, or signed URL. Request access as the owning company and guard, then prove another company and Client Portal receive denial before signing. Rotate storage keys by adding a replacement credential, verifying signed upload/download, switching the service secret, and revoking the old credential. A signed URL can remain usable until its short expiry after session revocation; avoid logging or sharing it. Malware scanning and provider-side enforcement of declared upload size remain post-pilot hardening items.

Production startup, migrations and RB-009 preflight fail closed before connecting if TLS is disabled or `DATABASE_CA_CERT` is absent/malformed. Obtain the CA from the database provider, compare its documented fingerprint through an independent trusted channel, and configure it in Render. To rotate it, add the provider's replacement CA during an approved window, run migrations/preflight and readiness checks, then remove the retired CA after provider confirmation. Verify the deployed service reaches `/health/ready` and that logs contain no certificate material. Local development and disposable test PostgreSQL remain non-TLS by default when `NODE_ENV` is not `production` and `DATABASE_SSL` is unset/false.

### Provisioning the pilot evidence bucket

The application signs **AWS SigV4 presigned URLs** and is the only storage architecture; do not introduce a second
one. A provider is compatible when it offers:

| Requirement | Value |
|---|---|
| Protocol | S3 API, SigV4, **path-style** URLs (`https://<host>/<bucket>/<key>`) |
| Scope service name | `s3` |
| Endpoint | **HTTPS** — production refuses plain HTTP |
| Operations used | `PUT` (signed `content-type`), `GET`, `HEAD`. Never `LIST` |
| Bucket access | **private**, no public read, no anonymous access, no public bucket URL |

Cloudflare R2, Backblaze B2, Supabase Storage (S3 protocol), Wasabi, DigitalOcean Spaces and self-hosted MinIO all
satisfy this. Plain AWS S3 works but is the weakest choice because AWS has deprecated path-style addressing.

Provisioning steps, using Cloudflare R2 as the reference provider:

1. Create a bucket (for the pilot: `s4-evidence-pilot`) in an EU location for UK/EU personal data. Leave public
   access **disabled**; do not attach a custom domain and do not enable the provider's public development URL.
2. Create an API token scoped to **that bucket only**, with object read and write. Do not issue account-wide
   storage administration. Record the Access Key ID, the Secret Access Key (usually shown once) and the S3 API
   endpoint.
3. Set the bucket CORS policy to the approved dashboard origins only — the same values as `CORS_ORIGIN`. The
   browser performs the signed upload directly, so `PUT` is required; `GET` covers in-page viewing:

   ```json
   [
     {
       "AllowedOrigins": ["https://dashboard.<approved-domain>"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 300
     }
   ]
   ```

   A wildcard origin is not acceptable. Until CORS is configured the API certification below still passes, because
   all signing is server-side, but the dashboard cannot upload evidence.
4. Store the credentials outside the repository, in a file readable only by the deploying operator (for example
   `%USERPROFILE%\.s4-pilot-secrets\evidence-storage.env`), and enter them into Render as secrets. Never commit
   them and never paste them into chat, tickets or screenshots.

### Certifying a bucket before it holds evidence

Run the repository's own certification against the **real hosted bucket** — never against a local MinIO stand-in as
a substitute for the hosted check:

```bash
cd security-backend-nest
EVIDENCE_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
EVIDENCE_STORAGE_REGION=auto \
EVIDENCE_STORAGE_BUCKET=s4-evidence-pilot \
EVIDENCE_STORAGE_ACCESS_KEY_ID=<id> \
EVIDENCE_STORAGE_SECRET_ACCESS_KEY=<secret> \
EVIDENCE_STORAGE_TEST_WAIT_EXPIRY=true \
npm run test:evidence-storage
```

`EVIDENCE_STORAGE_REGION` must be the provider's signing region — **R2 uses `auto`**; a wrong region produces
`SignatureDoesNotMatch`. The spec writes only synthetic PDFs under `compliance/guard/999999/<uuid>`, never real
identity evidence, and deletes them afterwards; without delete permission it prints the leftover keys instead of
failing. It certifies signed PUT, HEAD-based completion, signed GET returning the exact bytes, refusal of tampered
signatures, unsigned permanent URLs, anonymous listing and cross-object URLs, and signed-URL expiry.

Refusal status codes differ by provider — AWS and MinIO answer 401/403, R2 answers 400 `InvalidArgument` for a
missing `Authorization` header — so the spec asserts that the request fails **and** that no object content is
returned, rather than a particular status code.

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

1. Confirm `release/s4-pilot-rc1` resolves to the approved release SHA recorded in the change ticket.
2. In Render, verify the service branch is `release/s4-pilot-rc1` and auto deploy is OFF.
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

### Android release signing key

Android identifies an app by **package name + signing key**. Every update must be signed with the same key as the
installed build. If the keystore or its password is lost there is no recovery: devices already carrying the pilot
app cannot be updated (users must uninstall and reinstall, losing local app data), and a Play listing published
under that key without Play App Signing can never be updated.

The pilot key is held outside the repository by the release owner, in an ACL-protected directory (for example
`%USERPROFILE%\.s4-pilot-secrets\`). Its properties:

| Item | Value |
|---|---|
| Format | PKCS12 |
| Alias | `s4-pilot-release` |
| Key | RSA 4096, SHA384withRSA |
| Validity | 30 years from creation |
| Certificate DN | `CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB` |
| SHA-256 fingerprint | `0D:58:94:49:33:5F:91:54:E0:4A:6B:97:3E:B1:86:E8:8F:D6:17:58:1A:98:43:FB:62:AC:C2:E8:EC:76:31:1B` |

PKCS12 does not support a key password that differs from the store password: `keytool` silently protects the key
with the store password and Gradle then fails with `Get Key failed: Given final block not properly padded`. Keep
the two passwords identical.

Rules:

- Never commit the keystore or its password file, and never place either under `src/`.
- Never paste the password into chat, CI logs, screenshots or tickets.
- Back the key up before any APK leaves the build machine: at least one copy in a company password manager and one
  offline encrypted copy, with the alias and password stored as separate fields, and the fingerprint above recorded
  in the change ticket. Verify a restored copy with
  `keytool -list -v -keystore <file> -storetype PKCS12` and confirm the fingerprint matches.
- The key cannot be rotated for an already-distributed app. If the app is later published to Google Play, enrol in
  **Play App Signing** and keep this key as the upload key, so Google can reset it if it is ever lost.
- Increment `versionCode` in `app.json` for every distributed build; local Gradle builds do not auto-increment
  and Android refuses to install a build whose `versionCode` does not exceed the installed one.

### Building the pilot APK

`security-mobile-app/scripts/build-pilot-apk.ps1` produces the release-signed APK. It builds from `git archive`
of the current commit, so untracked working-copy files can never enter the bundle; it requires an HTTPS API URL; it
clears the Metro cache so a previously inlined API URL is not reused; and it loads the signing values from the
operator's local properties file into `ORG_GRADLE_PROJECT_*` environment variables for that build process only.
The injected Gradle `signingConfig` references the property **names**, so no credential reaches a Gradle file,
version control or the build log. The generated `android/` directory is gitignored.

Build the client APK only **after** the pilot backend is deployed, so the final HTTPS API URL is embedded, and
verify the result with `apksigner verify --print-certs` against the fingerprint above.

## Deployment success criteria

- New release is serving traffic.
- `/health/live` and `/health/ready` are healthy.
- Migrations show no pending release migration.
- P0 production smoke tests pass.
- No new Critical/High error is observed during the initial hypercare window.

If any success criterion fails, follow `ROLLBACK.md`.
