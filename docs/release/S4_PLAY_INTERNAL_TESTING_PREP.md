# S4 — Google Play Internal Testing preparation (Gate 4B)

Status: DRAFT FOR OWNER REVIEW. Nothing here has been submitted to Google Play. Every legal, privacy and
policy answer is the owner's to give; items marked **OWNER/LEGAL** must not be filled from this draft
without confirmation.

## Store listing draft

| Field | Draft |
|---|---|
| App name | S4 |
| Category | Business (alternative: Productivity) |
| Short description (≤ 80) | Security operations for UK security companies: sites, shifts, staff, Welfare and Log Book. |
| Contact email | **OWNER** — `support@sfour.co.uk` is published on sfour.co.uk; confirm the mailbox is monitored |
| Website | https://www.sfour.co.uk |
| Privacy policy URL | **OWNER/LEGAL** — must be an S4 policy. The current `sfour.co.uk/privacy` is PatrolSafe's and must not be used |
| Account-deletion URL | **OWNER** — `https://sfour.co.uk/account-deletion`, to be built in `s4-website` (spec: `docs/gate2/S4_ACCOUNT_DELETION_PAGE_SPEC.md`) |

Full description draft:

> S4 is a workspace for UK private security companies and the Guards they deploy.
>
> Guards see their upcoming shifts, accept shift offers, Book On and Book Off at site, complete Welfare
> Checks, keep the site Log Book, raise Site Requests and report incidents — all against the shift they
> are actually working.
>
> Companies plan rotas, manage clients and sites, link their own Guards, follow every live shift in Live
> Operations, and keep a truthful record of attendance, Welfare, Log Book entries and incidents, with Daily
> Site Logs and incident reports they can share with clients.
>
> S4 is for organisations already using S4. Guards join through their employing company. S4 is not an
> emergency service: in an emergency, call 999.

Do not claim certified lone-worker monitoring, guaranteed emergency response, or background tracking —
none of these exist.

**Feature graphic:** 1024 × 500 PNG/JPEG, no transparency. Suggest the approved S4 glyph on the brand
background `#05161C` with the word "S4" and the four pillars "Site · Shift · Staff · Security". NEEDS
CREATION from the approved brand pack — no new logo concept.

**Phone screenshots** (at least 2; plan 4–6, from the real app, real or clearly test data with no personal
data): sign-in; Guard Home with an upcoming shift; Guard current shift with Book On / Welfare / Log Book;
Company Live Operations (tablet/web if phone layout is not representative); Log Book / Daily Site Log.

**App icon:** `assets/branding/s4-app-icon-1024.png` scaled to 512 × 512. The faint residue in the brand
master was measured at 512 px (luminance ≈ 12–20 against a background of 18, out of 255) — not materially
visible at store sizes. Unchanged.

## App access (reviewer instructions)

S4 needs an account inside a real company workspace; a reviewer cannot meaningfully self-register (Guard
registration requires the person's own SIA licence). Provide in Play Console → App access:

- a dedicated reviewer **Company** login on the existing company workspace (owner creates it; never a real
  person's account), and, if Guard screens must be reviewed, a reviewer Guard identity only if one can be
  created truthfully — otherwise state that Guard access requires an SIA licence and an employing company;
- instructions: "Sign in → choose Company → Dashboard, Sites, Rota Planner, Live Operations, Log Book".

Credentials are entered by the owner in Play Console only — never in this repository or chat.

## Data Safety worksheet (factual input — OWNER/LEGAL to declare)

What the app collects or processes, as built (see `docs/gate2/S4_PRIVACY_POLICY_DRAFTING_PACK.md`):

| Play data type | Collected? | Notes |
|---|---|---|
| Location — precise | Yes | Only at Book On at sites that require it; one foreground reading; stored with the attendance record |
| Location — approximate | Yes (same reading) | |
| Personal info — name | Yes | Guard profile; company users |
| Personal info — email | Yes | Account sign-in, authentication email |
| Personal info — phone | Yes | Guard profile |
| Personal info — address | Yes | Company/site addresses; screening address history |
| Personal info — user IDs | Yes | Account identifiers |
| Personal info — other | Yes | SIA licence number; National Insurance number and UTR (company-held, encrypted) — **OWNER/LEGAL** to classify (government ID) |
| Financial info | Yes (company-held) | Guard bank details for payroll — **OWNER/LEGAL** to confirm declaration |
| Files and docs | Yes | Compliance and screening evidence uploads |
| App activity — in-app actions / user-generated content | Yes | Shifts, attendance, Welfare, Log Book, incidents, Site Requests |
| Health info | Possible | Only if a user writes it into free text (Welfare/incident) — **OWNER/LEGAL** |
| App info and performance (crash logs, diagnostics) | No | Sentry is not enabled |
| Device or other IDs | No | |
| Messages, contacts, photos/videos (camera), audio, calendar, web history | No | No such permissions |

- **Purposes:** app functionality, account management, security/fraud prevention. Not advertising, not
  analytics, not personalisation. **OWNER/LEGAL** to confirm.
- **Sharing:** no data is sold or shared for advertising. Service providers (Supabase, Render, Vercel,
  Resend) process data on S4's behalf — under Play's definitions this is generally not "sharing";
  **OWNER/LEGAL** to confirm. Data is visible to the user's own security company and, for client-portal
  content, that company's clients.
- **Encrypted in transit:** yes (HTTPS only in release builds).
- **Deletion:** users can request deletion in the app (Account → Delete account) and via the web URL
  (pending). Some operational records may be retained — see the retention register.
- **Optional vs required:** account and shift data are required to use the app; location is required only
  at sites that require it.

## Other declarations (OWNER)

- **Ads:** none — no advertising SDK in the app (dependencies checked).
- **Target audience:** adults (18+), workforce/business app; not designed for children.
- **Content rating:** business/utility; no violence, sexual content, gambling or purchases. User-generated
  text exists but is not shared publicly — it is visible only inside the user's company. Owner completes the
  questionnaire.
- **Government apps / financial features / health:** none of these app categories.
- **News, COVID, loans:** not applicable.

## What Internal Testing needs (current Google Play documentation, read for Gate 4B)

| | Create app | Upload AAB | Internal Testing release | Production/public release |
|---|---|---|---|---|
| Organisation developer account (verified) | required | required | required | required |
| Play App Signing (Google-held key) | — | enrolled on first upload | yes | yes |
| Target API 36 (since 31 Aug 2026) | — | yes (met) | yes | yes |
| Store listing, content rating, Data safety | — | — | Play docs: an internal release can be created while the app "is not fully configured" — Play Console shows what it requires | required |
| Privacy policy URL | — | — | may be requested by Play Console for an app that collects location/personal data — follow the Console | required |
| Account-deletion URL | — | — | declared in Data safety; required for apps with accounts | required |
| 12 testers × 14 days closed test | — | — | — | applies to **personal** accounts created after 13 Nov 2023, not organisation accounts |

Internal testing: up to 100 testers, added as an email list; first upload is available to testers within
minutes; internal tests may not go through full review.

Android developer verification (2026): Play Console developers are verified through the Play Console
account, and Google Play registers Play-distributed apps automatically; the first enforcement (from
30 Sep 2026) covers installs in Brazil, Indonesia, Singapore and Thailand, with global expansion from 2027.
Nothing here blocks an Internal Testing release from a verified organisation account.
