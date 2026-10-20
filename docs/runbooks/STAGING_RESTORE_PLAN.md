# S4 staging — restore plan (not executed)

Prepared 20 October 2026 for the Guard mobile release. **Nothing in this document has been done.** Every step
that changes hosting needs owner approval first. Production is not touched by any step.

## What exists today (read-only findings, 20 Oct 2026)

| Item | Finding |
|---|---|
| Service | Render web service `security-marketplace-api-staging` (`srv-da8t3d0ae00c73d7g5jg`), Oregon, **Free** plan, Docker, root `security-backend-nest`, Dockerfile `./Dockerfile`, auto-deploy **off** |
| Branch | `feature/p1hc-client-billing-reapproval` — an old feature branch, not `release/s4-pilot-rc1` |
| Health | Crash loop. Every start exits 1: `TypeOrmModule Unable to connect to the database … Connection terminated unexpectedly` (20 Oct 11:29–11:33Z; also 11 Oct and 28 Sep) |
| Database | Not identifiable without opening the service's secret environment variables (not done). No matching Render Postgres instance exists in the account (the only staging database listed is `d4drive-staging-db`, a different product). Most likely an expired free Render database or an external URL that no longer accepts connections. |
| Isolation from production | **Unproven.** It cannot be shown without inspecting its `DATABASE_URL`. |
| Mobile profile | `eas.json` `preview-staging` points at `https://security-marketplace-api-staging.onrender.com`, but signs with EAS-generated credentials (the Build 8 problem) — not usable as is. |

## Target

A staging API that runs the production release commit against its **own** database, with its **own** secrets,
that can never read or write production data, and a Guard test build that talks only to it.

## Plan

1. **Database (owner choice).**
   - Option A: a new Render Postgres in the same region (Oregon), named `s4-staging-db`. Free tier expires after
     30 days; the paid Basic tier does not.
   - Option B: a separate Supabase project (`s4-staging`), never the production project.
   Either way the database is new and empty. **No production dump is restored into it** (personal data).
2. **Service settings (owner, Render dashboard).**
   - Branch → `release/s4-pilot-rc1` (deploys are manual, auto-deploy stays off).
   - Plan: Free is acceptable for UAT but spins down; Starter avoids 50-second cold starts during device tests.
   - Environment, all **new staging-only values** — never copied from production:
     `DATABASE_URL` (the new database), `DATABASE_SSL=true`, `DATABASE_SYNCHRONIZE=false`, `NODE_ENV=production`,
     new random `JWT_SECRET`, `GUARD_DATA_ENCRYPTION_KEY`, `GUARD_DATA_HMAC_KEY`, `CORS_ORIGIN` set to the staging
     web origin only, evidence storage pointed at a separate bucket or left disabled, email sending disabled or
     sandboxed, `DB_POOL_DIAGNOSTICS` unset.
3. **Deploy** `a7b5b22` (or the release commit current at the time). The pre-deploy step runs the migrations on
   the empty database; expect all 63 to run and the ledger to read 63.
4. **Verify isolation before any test account exists.**
   - Owner confirms in the dashboard that the staging `DATABASE_URL` host is not the production host.
   - From the build machine, read-only: the staging `/health/ready` returns 200; the production read-only
     credential shows no new rows in production after the staging deploy (users, companies, shifts, audit).
   - A login on staging with a production account fails (separate users table, separate JWT secret).
5. **Seed test data on staging only.** One test company, one site (with and without GPS required), two test
   Guards with company checks recorded, offered / accepted / live shifts. Test logins are generated and kept in
   the git-ignored secrets folder, never in chat or Git.
6. **Guard UAT build pointing at staging (separate approval).** Recommended: a distinct application identity
   (`com.sfour.s4.uat`, iOS `com.sfour.s4.uat`) so it installs beside the real app and can never be mistaken for
   it, signed with the existing upload key (Android, `credentialsSource: local`) and an internal/ad hoc profile
   (iOS, test iPhone registered). Its `EXPO_PUBLIC_API_URL` is the staging URL, set explicitly in its own EAS
   profile; the store profiles keep the production URL.
7. **Retire or fix the old profile.** `preview-staging` (EAS-generated signing) is removed or replaced by the
   profile in step 6.

## What stays true

- Production (Render `a7b5b22`, Vercel, the production database) is not changed by any step.
- No migration is written for staging; it runs the same migrations production already ran.
- No production data, secret or credential is copied to staging.

## Rollback

Staging has no production dependency: suspending the staging service and deleting the staging database returns
to today's state (a broken, unused staging service).
