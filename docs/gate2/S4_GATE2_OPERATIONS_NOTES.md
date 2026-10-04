# S4 Pilot Gate 2 — operations notes (email, monitoring, Play account, deployment preconditions)

Nothing in this file has been applied to production. No API key or DSN is recorded anywhere in Git.

## Resend (transactional authentication email)

**Existing support:** none before Gate 2 (no email SDK, SMTP or Resend code in the repository). Gate 2 calls
the Resend REST API (`POST https://api.resend.com/emails`) directly with `fetch`, so no new dependency.

| Variable | Required to send | Notes |
|---|---|---|
| `RESEND_API_KEY` | yes | Render dashboard secret (declared `sync: false` in `render.yaml`). Never in Git or chat. |
| `EMAIL_FROM` | yes | Must be on a domain verified in Resend (SPF + DKIM DNS records). Recommended: `S4 <no-reply@sfour.co.uk>`, or a dedicated subdomain such as `S4 <no-reply@mail.sfour.co.uk>` so marketing-site DNS stays separate. |
| `EMAIL_REPLY_TO` | no | e.g. a monitored support address. |
| `S4_WEB_APP_URL` | no | Defaults to `https://app.sfour.co.uk`; declared in `render.yaml`. |

**Behaviour without configuration:**
- Development / test: messages go to an in-memory outbox read by tests; nothing leaves the process.
- Production: nothing is sent; `transactional_email_not_configured` is logged (kind only, no recipient or link). Boot does not fail.

**Deployment precondition (important):** once Gate 2 is deployed, a **new self-registered account cannot sign
in until it verifies its email**. If Resend is not configured at that point, new registrations are stranded
(the account exists, but no link arrives). Configure and verify Resend **before** deploying the Gate 2
backend, or accept that new self-registration is paused until it is. Existing accounts are unaffected
(grandfathered by Migration 61).

**Pricing note (resend.com/pricing, read 2026-10-04):** the free plan states 3,000 emails/month and 100/day,
3 domains. Pilot volumes of reset and verification mail should fit; confirm before relying on it. Data region
was not stated on the pricing page — confirm with Resend for the privacy policy.

## Sentry (error monitoring) — prepared, not enabled

- Package: `@sentry/node` **10.76.0** (exact pin; backend only). Loaded only when `SENTRY_DSN` is set.
- Variables: `SENTRY_DSN` (enables), `SENTRY_ENVIRONMENT` (optional; defaults to `NODE_ENV`), `SENTRY_RELEASE`
  (optional; defaults to Render's `RENDER_GIT_COMMIT`).
- `SENTRY_DSN` is intentionally **not** declared in `render.yaml`; enabling is a deliberate manual step.
- Settings: errors only; `sendDefaultPii: false`; no tracing, profiling, session replay or analytics; no local
  variables; every event passes the S4 scrubber (see `src/monitoring/monitoring-scrub.ts`).
- Mobile/web: **no Sentry SDK** was added. `AppErrorBoundary` exposes an `onError` hook for a future client
  integration. A React Native SDK needs a native config plugin and a new native build, which Gate 2 excludes.
- **Privacy-policy disclosure needed** before enabling: Sentry as a sub-processor, data region, what an error
  report contains (scrubbed technical data, user id) and retention.
- **Pricing note (sentry.io/pricing, read 2026-10-04):** the free Developer plan states one user, 5k errors and
  a 30-day lookback; the Team plan is stated at $26/month (annual) with 50k errors. A single-user free plan
  limits who can triage. Data-region choice was not shown on the pricing page — confirm (EU vs US).

## Google Play developer account — owner decision recorded

The Google Play developer account is to be an **ORGANISATION** account under **Vesoft Services Limited**.
Not done in Gate 2: no Play Console app created, no package ID change (still `com.securitymarketplace.mobile`),
no version bump, no store build.

## Web app hosting for the emailed links

`security-mobile-app/vercel.json` rewrites `/reset-password` and `/verify-email` to the SPA and sends those
pages `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. **Unverified:** that
the `app.sfour.co.uk` Vercel project's root directory is `security-mobile-app` (otherwise the file is
ignored and the paths would 404). Confirm in Vercel before deploying the frontend. `CORS_ORIGIN` on the API
must include `https://app.sfour.co.uk` (it already must, for the web app to work at all).

## Naming residue (not changed in Gate 2)

`app.json` `expo.name` is "S4 Security"; the location permission text says "S4 Security"; the Guard surface
shows "S4 Guard" (`brand.guardAppName`, pinned by `pilot-build-provenance.spec.cjs`); the login eyebrow says
"S4 SECURITY". All Gate 2 surfaces and emails say "S4". Renaming the store/display identity is a Gate 3 item.

## Deployment order when approved (not performed)

1. Configure Resend (domain verified, `RESEND_API_KEY`, `EMAIL_FROM`) and confirm the Render region.
2. Deploy backend: Render's pre-deploy step runs Migration 61 (grandfathers every existing user).
3. Deploy the web app (account pages + vercel.json), then distribute the mobile build in Gate 3.
4. Old app builds keep working: login/refresh unchanged for existing accounts; an old build registering a
   new account receives `{ verificationRequired: true }` and no session, so it must be upgraded for a clean
   registration UX (the account is still created and the email still sent).
