# S4 staging — configuration and restoration record

Prepared 20 October 2026; **sections 2–3 were executed on 20 October 2026 with the owner's approval** (status below).
Production is not touched by any step.

## Status (20 Oct 2026, 21:07Z)

| Item | State |
|---|---|
| Branch | `staging/s4-uat` created on GitHub at `a7b5b22` (no new code; `release/s4-pilot-rc1` unchanged) |
| Database | `s4-staging-db` = `dpg-dbbq13afngtc73a5ls20-a`, PostgreSQL 17.11, Oregon, `0.1c-256mb`, 1 GB — $6.30/month |
| Service | `srv-da8t3d0ae00c73d7g5jg` on Starter `0.5c-512mb` ($7/month), branch `staging/s4-uat`, auto-deploy Off, pre-deploy `npm run migration:run:prod`, health `/health/ready` |
| Environment | 20 staging-only variables (19 generated + `DATABASE_URL` = the database's **External** URL); verified by hash; no pooler, email or production values |
| Deploy | `dep-dbbtau2fngtc73a47atg`, `a7b5b22`, manual; pre-deploy ran 63 migrations; live 21:58 BST |
| Data | 63 migrations ending `AddComplianceLapseAlerts1720900000009`; **0 rows** in every operational table |
| Production | `srv-d6ttvdea2pns7391pa0g` unchanged (last deploy 08:49, `a7b5b22`); 14 tables identical before/after |
| Incident | The Starter upgrade auto-redeployed the old Free build (`a1c7a11`) with the new environment for ~5 minutes before `a7b5b22` replaced it. It connected only to the then-empty `s4-staging-db` and wrote nothing (0 tables before and after). |

## Seeding is blocked on one owner decision: Guard document evidence

At `a7b5b22` a Guard is assignable only with the company's SIA and Right to Work **checks** AND an **uploaded and
verified** SIA licence document and Right to Work document. Uploads need real evidence storage; staging has the
deliberate placeholder (`https://s4-staging-evidence-disabled.invalid`). So no Guard can be offered a shift on
staging today, and Offers, Book On, Welfare, Incident, Site Request and Book Off cannot be exercised.
`scripts/staging-uat-seed.ts` therefore refuses to write to staging until one of these is chosen:

1. **Separate staging evidence bucket** (e.g. a new Cloudflare R2 bucket `s4-staging-evidence` with its own key;
   R2 free tier). The seeder uploads small, clearly fictional PDF test files through the real presigned flow and
   verifies them through the API. Full fidelity; evidence uploads become testable too.
2. **Product's legacy test path** (`fileUrl` only, no file): documents are recorded as uploaded with no stored
   file, then verified. No new resource, but it is simulated evidence — excluded by the owner's current instruction.

The owner approved option 1 in principle on 20 Oct 2026 (design below; nothing created yet).

## Staging evidence storage — design for approval (not executed)

### Why the document is required (code at `a7b5b22`)
`ComplianceService.assertGuardAssignable` (called by shift creation and availability) refuses a Guard unless
`GuardComplianceService.getBlockingReasons(companyId, guardId)` is empty. For a company that is: the company's own
current **SIA check** and **Right to Work check** (confirmed, unexpired) AND, for each of `sia_licence` and
`right_to_work`, a document **uploaded** (`uploadCompletedAt`) and **verified** by that company. Every read is scoped
to the company. This is **employer compliance** (the company's own file). **S4 screening is not consulted** —
`compliance.service.ts` says so explicitly and has no ScreeningService dependency. No policy change is proposed.

### Architecture
| Part | Choice |
|---|---|
| Account | The existing Cloudflare account (production evidence is R2 bucket `s4-evidence-pilot` there, 16 real documents) |
| Bucket | **`s4-staging-evidence`**, Standard storage, location hint Western Europe, public access **off**, no custom domain, no r2.dev URL |
| Credentials | A new R2 API token **"S4 staging evidence (UAT only)"**: Object Read & Write, **Apply to specific buckets only = `s4-staging-evidence`**, no TTL needed (revoked at teardown). Never account-wide, never admin |
| CORS | Only `http://localhost:8098` (local web control room against staging), methods PUT/GET, header `content-type`. Mobile and the seeder need none |
| App config | No code change: the S3-compatible signer is path-style SigV4 with a configurable endpoint/region/bucket; R2 uses region `auto` (DEPLOYMENT.md "Private evidence storage") |
| Staging env | Replace the five placeholders: `EVIDENCE_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `_REGION=auto`, `_BUCKET=s4-staging-evidence`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` (in Render and in `staging-render.env`) |

### Cost
R2 Standard free tier per account per month: 10 GB-month storage, 1 million Class A (writes/lists), 10 million
Class B (reads/HEAD); egress free; deletes free. Beyond it: $0.015/GB-month, $4.50 per million Class A, $0.36 per
million Class B. The free tier is shared with production's tiny usage. UAT uses well under 1 MB and a few hundred
operations: **expected $0.00/month**. The account already has R2 enabled (production uses it); nothing new to subscribe.

### Isolation
- The staging token is bucket-scoped: it cannot list, read, write or delete `s4-evidence-pilot`.
- `scripts/staging-evidence-isolation-probe.cjs` proves it after creation with the staging key only: read-only list,
  HEAD and GET against the production bucket must all be 401/403 with no data; a staging list must succeed (control).
  It never sends PUT or DELETE to production.
- `npm run test:evidence-storage` (existing spec) certifies the staging bucket: signed PUT/HEAD/GET, refusal of
  tampered and unsigned access and anonymous listing, expiry. It writes only synthetic PDFs and deletes them.
- The seeder refuses the placeholder, any non-R2 endpoint, the production bucket, any bucket but
  `s4-staging-evidence`, and the production access key (compared with `evidence-storage.env`).
- Production's own key is not touched. (Owner may confirm in the token list that it too is bucket-scoped.)

### Fictional documents
The seeder generates real PDFs whose every line states "FICTIONAL TEST DOCUMENT - S4 STAGING UAT ONLY … NOT an SIA
licence and NOT evidence of identity or right to work", named `UAT-FICTIONAL-SIA-LICENCE-NOT-REAL.pdf` /
`UAT-FICTIONAL-RIGHT-TO-WORK-NOT-REAL.pdf`, for the fictional Test Guards, uploaded through the real workflow
(`POST /compliance/documents` → PUT bytes to the presigned URL → `complete-upload`, where the server HEAD-checks the
stored object's size and type → `PATCH verify`). It never sends `fileUrl` and never writes evidence rows directly
(`staging-uat-seed.spec.ts` SEED-03). The company checks carry "UAT test record — not a real check". All of it exists
only in `s4_staging` and `s4-staging-evidence`.

### Setup (owner in Cloudflare and Render; Claude verifies)
1. Cloudflare › R2 › Create bucket `s4-staging-evidence` (Standard, Western Europe hint). Confirm public access off.
2. Bucket › Settings › CORS: `[{"AllowedOrigins":["http://localhost:8098"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["content-type"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":300}]`.
3. R2 › Manage API tokens › Create token "S4 staging evidence (UAT only)": Object Read & Write, specific bucket
   `s4-staging-evidence` only. Copy Access Key ID and Secret (shown once).
4. Replace the five `EVIDENCE_STORAGE_*` lines in `~/.s4-pilot-secrets/staging-render.env` (keep TTL 180).
5. Claude: `node scripts/staging-evidence-isolation-probe.cjs` (must PASS) and `npm run test:evidence-storage` against
   the staging bucket (must PASS).
6. Render staging service › Environment › Edit: replace the same five values; **Save and deploy** (a restart is needed
   for the new values; it redeploys `a7b5b22`, migrations are a no-op).
7. Claude: health, isolation, production unchanged; then (separate approval) the seeder dry run and real run.

### Rollback / teardown
- Seed data: suspend staging service → drop/recreate schema on `s4_staging` → redeploy → (re-seed if wanted).
- Evidence: R2 › `s4-staging-evidence` › delete all objects, then delete the bucket (deletes are free).
- Credential: R2 › Manage API tokens › revoke "S4 staging evidence (UAT only)"; restore the placeholder values in
  Render staging and `staging-render.env` (the app then boots with uploads failing explicitly).
- Production bucket, token and service are never part of any step.

## 1. What exists today (read-only, Render dashboard, 20 Oct 2026)

| Item | Finding |
|---|---|
| Service | `security-marketplace-api-staging` (`srv-da8t3d0ae00c73d7g5jg`), Oregon (US West), **Free** compute ($0; 0.1 CPU / 512 MB), Docker, Dockerfile and context `security-backend-nest/` |
| Branch | `feature/p1hc-client-billing-reapproval` (an old feature branch) |
| Auto-deploy | Off. PR previews off. Health check path `/health/ready` |
| Pre-deploy command | Empty — and **locked on Free** (Free has no pre-deploy, shell, one-off jobs or disks) |
| Health | Crash loop: the database it is configured for refuses connections (28 Sep, 11 Oct, 20 Oct) |
| Database | Unknown (secret env not opened). No matching Render Postgres exists. Isolation from production **unproven** |
| Workspace | Hobby plan; 7 of 25 services; bandwidth 2.92 of 5 GB included this month; October projected $20.30 |

Production for comparison: Render web service `security-marketplace-api` (Starter, `render.yaml`) + **Supabase**
Postgres 17 (pooler). Production is not edited by anything below.

**Reuse verdict:** the existing staging service can be reused — same repo, Dockerfile, health path, auto-deploy
off, its own `onrender.com` URL — but every one of its environment variables is replaced (its current
`DATABASE_URL` is unknown and must not survive), its branch is changed and its compute is upgraded.

## 2. Proposed Render configuration

| Setting | Value |
|---|---|
| Web service | Reuse `srv-da8t3d0ae00c73d7g5jg`; compute **Starter `0.5c-512mb`** (same size as production) |
| Why not Free | Free cannot run the pre-deploy migration step, spins down (≈50 s cold start in the middle of a device test), and has no shell |
| Source | Dedicated branch **`staging/s4-uat`**, created at certified commit **`a7b5b22`** (the production release; the backend is byte-identical at `6b8e41b`). Auto-deploy stays **off**; deploys are manual. It never tracks `release/s4-pilot-rc1`. Creating the branch is a push of an existing commit and needs approval; the no-push alternative is "Deploy a specific commit" `a7b5b22` from the current branch setting |
| Pre-deploy command | `npm run migration:run:prod` (as production) |
| Health check | `/health/ready` (runs `SELECT 1`) |
| Database | **New Render Postgres `s4-staging-db`**, PostgreSQL **17** (production runs 17), compute **`0.1c-256mb`**, storage **1 GB**, region **Oregon** (same private network as the service), no HA, no storage autoscaling |
| URL | `https://security-marketplace-api-staging.onrender.com` (unchanged; no custom domain — the workspace's 2 included domains are both used) |

### Exact monthly cost (Render dashboard prices, 20 Oct 2026; billed per second)

| Item | Monthly |
|---|---|
| Web service Starter `0.5c-512mb` | $7.00 |
| Postgres `0.1c-256mb` | $6.00 |
| Postgres storage 1 GB × $0.30/GB | $0.30 |
| **Total** | **$13.30** |

Not included / limits: the form defaults to 15 GB ($4.50) — choose **1 GB** (it can grow later, never shrink;
one increase per 6 h). Bandwidth comes out of the workspace's 5 GB included (UAT traffic is a few MB). Evidence
storage (below) uses Cloudflare R2's free tier or a placeholder: $0. A Free Postgres ($0) is possible but expires
after 30 days.

## 3. Environment (all new, staging-only; never copied from production)

Production mode (`NODE_ENV=production`) is kept so staging runs the same checks as production.

| Variable | Staging value |
|---|---|
| `NODE_ENV` | `production` |
| `TZ` | `UTC` (boot refuses any other zone; the Dockerfile does not set it) |
| `DATABASE_URL` | The **internal** URL of `s4-staging-db` |
| `DATABASE_POOLER_URL` | **Must not exist** — it overrides `DATABASE_URL` |
| `DATABASE_SSL` | `true` (production mode refuses `false`) |
| `DATABASE_CA_CERT` | The CA that signs `s4-staging-db`'s certificate (verified from the build machine with a TLS handshake before the first deploy; certificate verification is always strict) |
| `DATABASE_SYNCHRONIZE` | `false` |
| `JWT_SECRET` | New random, 64+ characters |
| `GUARD_DATA_ENCRYPTION_KEY`, `GUARD_DATA_HMAC_KEY` | New random, 64 hex each, different from each other |
| `CORS_ORIGIN` | `http://localhost:8098` (the S4 web app run locally against staging for control-room checks); no production origin |
| `S4_WEB_APP_URL` | `http://localhost:8098` — never the production web app |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | **Unset** → email disabled; nothing can be sent |
| `EVIDENCE_STORAGE_*` (5) | A separate R2 bucket `s4-staging-evidence` with its own key, **or** a placeholder HTTPS endpoint (the app boots; evidence uploads fail). Never the production bucket |
| `SENTRY_DSN` | Unset |
| `ENABLE_SWAGGER` | `false` |
| `TRUST_PROXY` | `1` |
| `DB_POOL_DIAGNOSTICS` | Unset |

All existing variables on the staging service are deleted first.

## 4. Security and isolation (backend audit, `6b8e41b`)

- **Database:** a different provider from production (Render, not Supabase). The staging service holds only
  `s4-staging-db`'s credentials; no Supabase URL, pooler URL or production key exists in its environment.
  Advisory locks and scheduled jobs act only on the connected database.
- **Tokens:** access tokens are HS256 with `JWT_SECRET`; a different secret means production tokens are
  rejected on staging and vice versa. Refresh, reset and verification tokens are random and stored hashed in the
  database that issued them, so they work nowhere else.
- **Notifications:** the backend has **no SMS or push**. Its only outbound messages are password-reset and
  verify-email emails via Resend, sent only when `RESEND_API_KEY` and `EMAIL_FROM` are both set — unset on
  staging. Test accounts use `@example.com` (a reserved domain). The mobile app has no push either.
- **Jobs:** the welfare sweep and compliance-lapse scan (every 5 min), daily reminders and weekly suggestions are
  in-process timers that read and write only the connected database; they make no external calls. Notifications
  are database rows.
- **Outbound calls:** only Resend (off), the evidence store (separate or placeholder) and Sentry (off). No
  payments, SIA lookups, maps or webhooks exist in the backend.
- **Logs:** one JSON line per request (method, path, status, duration, request id) — no bodies, headers or tokens;
  database connection errors log a category and code, never a host or URL; email logs never include recipients or
  links. Synthetic data only, so names in notification rows are fictional.
- **Production unchanged:** `render.yaml` (the production service) is not edited; production domains, the Vercel
  app and both store builds' API (`security-marketplace-api.onrender.com`) are unchanged.
- **Do not run** `scripts/pilot-journey.spec.ts` (or other `scripts/*.spec.ts` that drop or truncate) against
  staging: several drop the whole schema of whatever database they are given.

## 5. Accounts and test data (after isolation is proven)

Email verification is required to sign in and email is disabled on staging, so accounts are created by a
**staging seed runner** (new script, separate review): it runs on the build machine, starts the backend's own
services in-process against `s4-staging-db` (external URL, TLS), creates verified accounts through the real
registration code (the in-process outbox stands in for email) and the real API, and refuses to start unless the
database host is the staging host and `S4_STAGING_SEED_CONFIRM=s4-staging-db` is set. Logins are written only to
`~/.s4-pilot-secrets/staging-uat.env`.

Fictional dataset:

| Record | Detail |
|---|---|
| Company | **UAT Test Security Ltd** (owner `uat-owner@example.com`, control-room user `uat-control@example.com`) |
| Client | **UAT Example Client** |
| Site | **UAT Test Site — Unit 1, Example Park** (Europe/London), GPS required; a second, GPS-free site for the denial test |
| Guards | **Test Guard Alpha** (`uat-guard-a@example.com`), **Test Guard Bravo** (`uat-guard-b@example.com`); company SIA and Right to Work checks recorded with obvious test values |
| Shifts (relative to the test day) | 1 offered to Alpha (Accept / Decline); 1 accepted, starting in 2 h (early Book On); 1 accepted, starting now (on-time Book On, hourly welfare); 1 live with a welfare check about to fall due (missed-welfare alert); 1 live ending in 10 min (plain Book Off); 1 live ending in 4 h (early Book Off); 1 for Bravo for company isolation and a second-Guard view |
| Incidents / site requests | None seeded — created by testers |

Reset: suspend the service → `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on `s4-staging-db` only
(host confirmed) → manual deploy of the same commit (pre-deploy re-runs all 63 migrations) → seed runner.
About 10 minutes.

## 6. Certification after the infrastructure is approved and created

1. TLS handshake to `s4-staging-db` verifies with `DATABASE_CA_CERT`.
2. Deploy `a7b5b22`; pre-deploy log shows 63 migrations; `GET /health/ready` = 200.
3. Ledger read-only: `typeorm_migrations` = 63, last `AddComplianceLapseAlerts1720900000009`.
4. Isolation: a production account cannot sign in on staging; production read-only counts (users, companies,
   shifts, audit) unchanged across the staging deploy and seed.
5. Seed; then over the staging API: sign-in for each role; Alpha cannot see Bravo's company data and a second
   test company cannot see the first (tenant isolation).
6. Book On (early with confirmation, on time) and Book Off (plain and early) for Alpha.
7. Let a welfare check lapse; within one 5-minute sweep one welfare alert exists; acknowledge and resolve it.
8. Incident and site request created and visible to control.
9. A UAT build (separate approval) against staging: install, sign in, one full Guard journey.

## 7. UAT mobile build (prepared in Git, not built)

- `app.config.js`: with `APP_VARIANT=uat` → name **S4 UAT**, Android **`com.sfour.s4.uat`**, iOS
  **`com.sfour.s4.uat`**, scheme `s4security-uat`, amber icon / adaptive icon / splash (`assets/uat/`, generated
  by `scripts/make-uat-icons.cjs`), `extra.apiBaseUrl` = staging. Without it, `app.json` is returned unchanged.
- In-app: the signed-in top bar reads **"S4 UAT · STAGING"** in amber; the build footer reads "UAT".
- EAS profile **`uat`**: `distribution: internal`, Android APK with the local key, env `APP_VARIANT=uat`,
  `EXPO_PUBLIC_API_URL` = staging, `EXPO_PUBLIC_BUILD_LABEL=UAT`. The `production` profile is unchanged.
- `scripts/uat-variant.spec.cjs` (in the release gate) proves the store config is `app.json` unchanged and that
  only the `uat` profile can set the variant.
- iOS distribution: ad hoc — each test iPhone registered (`eas device:create`), EAS creates the `com.sfour.s4.uat`
  App ID and an ad hoc profile with an interactive Apple sign-in by the owner (the EAS-held App Store Connect API
  key is currently rejected).
- Expo usage: about $1 per Android and $2 per iOS medium build from the Starter build credit ($18 of $45 used in
  the period ending 28 Oct 2026).
- The old `preview-staging` profile (EAS-generated signing) stays as recorded history for now; it is not used.
  Since 21 Oct 2026 it cannot produce an app at all: `app.config.js` fails any EAS build that pairs the store
  identity with a staging URL, or the UAT identity with anything but staging (UAT-08).

### Build readiness (certified 21 Oct 2026, not built)

- Release gate 57/57 (including `tsc`), `expo install --check` clean. Exports with `--clear`: store Android / iOS
  bundles carry no staging URL; UAT Android / iOS bundles carry the staging URL (the one production string in them
  is the unused fallback constant in `api-base-url.ts`). Both configs keep `updates.enabled: false`, 1.1.0 (15 / 14).
- No EAS dashboard environment variables in development / preview / production, so nothing overrides the profiles.
- Android: `uat` signs with `credentials.json` — the permanent S4 key (`0d589449…`, the Play upload key for
  `com.sfour.s4`). Different package, so it cannot update or replace the store app; no key material enters the APK.
- iOS: no devices are registered on team `SXH4TLU2B5`, and no `com.sfour.s4.uat` App ID or ad hoc profile exists.
  Before the iOS build: `eas device:create` (open the link on each test iPhone, install the profile), then the
  build itself is run interactively by the owner with an Apple sign-in. The existing Apple Distribution certificate
  (`c1f9c5b6…`) can sign ad hoc; the App Store profile for `com.sfour.s4` is not touched.
- Commands (from `security-mobile-app`, owner-approved only):
  `npx eas-cli build --platform android --profile uat` and `npx eas-cli build --platform ios --profile uat`.
  Never `--auto-submit`; no `eas update`.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Editing the wrong Render service | Only `srv-da8t3d0ae00c73d7g5jg` is touched; production `security-marketplace-api` is checked unchanged (plan, branch, deploy id) before and after |
| An old staging secret points at production | Every existing env var is deleted before the new ones are set; certification step 4 proves no production change |
| CA certificate mismatch blocks boot | Verified by a TLS handshake from the build machine before the first deploy. If the internal URL does not offer verifiable TLS, use the database's external URL (TLS) instead — still staging-only |
| Staging emails a real person | Email unset; `@example.com` addresses only |
| Test data mistaken for real | "UAT" / "Test" / "Example" in every name; amber UAT app |
| Cost overrun | $13.30/month; billed per second; suspend or delete at any time |

## 9. Shutdown and deletion

- **Pause:** suspend the web service (Settings › Suspend) and, if wanted, downgrade it to Free — about $0 for the
  service; the database keeps billing until deleted.
- **Delete:** delete `s4-staging-db` (irreversible; synthetic data only), delete or suspend the service, delete the
  `staging/s4-uat` branch, revoke the R2 staging key and delete its bucket if created. Nothing in production
  depends on any of it.
