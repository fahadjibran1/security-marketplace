# S4 Dashboard Operations V2 — release certification

Status: **integrated into `release/s4-pilot-rc1` locally. NOT PUSHED. NOT DEPLOYED.**
Certified 5 October 2026.

## 1. Baseline and integration

| Item | Value |
| --- | --- |
| Remote release baseline | `origin/release/s4-pilot-rc1` = `6cf29c8` |
| Local Gate 4B / 4C release commits (unchanged) | `caa5729` certified AAB record · `8bc9064` Play Internal Testing prep · `6a31a21` iOS privacy manifest and purpose strings · `3b7cc44` iOS/TestFlight readiness pack |
| Dashboard V2 commits | `ec100a9` feature · `db0eb60` tests · `a1618bc` Attention Now uncapped · `ab4c277` desktop density · `bf1212d` compliance card |
| Integration method | Fast-forward only (`git merge --ff-only`) of `release/s4-pilot-rc1` from `3b7cc44` to `bf1212d`. No merge commit, rebase, squash, cherry-pick or amend. |
| Integrated HEAD (before this record) | `bf1212d` |
| Development worktree | `security-marketplace-dashboard-v2`, branch `dashboard-operations-v2` (never pushed) |

Before integrating, the graph was proven: `3b7cc44` was the release HEAD and the merge base; it is an ancestor of `bf1212d`; all four local release commits are in `bf1212d`'s ancestry; and there are no merge commits in the range.

## 2. Owner approval

The owner visually approved Dashboard V2 on the 1440px fixture previews. This covers:
- compact desktop density, the 212px sidebar and header typography;
- 90px KPI cards and the KPI layout;
- Attention Required density, the five-item maximum and panic/SOS priority;
- KPI severity semantics;
- Live Operations, Today's Coverage, Upcoming Shifts and responsive behaviour;
- the S4 navy/teal identity.

The final corrections (production compliance subtitle, neutral Compliance card) are in `bf1212d`.

## 3. What Dashboard V2 contains

- **KPIs:** Active Sites, Live Shifts, Coverage Gaps, Open Incidents and Alerts, each defined in `dashboardOverview.ts`.
  - Live Shifts uses the Live Operations "in progress" policy, so accepted future shifts are no longer counted.
  - Alerts excludes per-window Welfare evidence rows.
  - Severity: coverage is amber; incidents are red only when one is recorded as critical; alerts are red only with an active SOS. Problem cards state their status in words.
- **Attention Required:**
  - At most five items are shown; the header gives the full count, with "View all N items in Live Operations".
  - Priority: panic, other safety, critical incident, incident, missed Welfare, missing Book On, missing Book Off, coverage, lower warnings.
- **Live Operations Attention Now** is no longer capped at 10, so its count and the dashboard's N agree.
- **Live Operations summary:** Book On time, Welfare (the Live Operations board's own wording), last activity and open items.
- **Today's Coverage** and **Upcoming Shifts** (Today / Tomorrow on the site clock, UNASSIGNED marked).
- **Compliance Overview** uses the Compliance screen's own metrics, with the subtitle "Guard document and certification status." The outer card is neutral; Expiring is amber and Needs attention is red.
- **Recent Activity** is removed from the dashboard. Its data and its use in Live Operations are unchanged.
- **Freshness:** "Updated" only moves after a fully successful load. Each section has its own error and stale-data notice.

Dashboard V2 changed only dashboard and Live Operations UI files, their tests, and one `package.json` test-script line. No API, backend, database, store or signing file changed.

## 4. Density and responsive certification

Measured in Chrome on the fixture previews, rendered in the real app shell, at 1440×800:

| Measure | Value |
| --- | --- |
| KPI cards | 90px tall |
| Attention rows | 58px |
| Card padding | 16px |
| Section gap | 14px |
| Headings | 16px |
| Page title / subtitle | 26 / 14px |
| Status pills | 11px |

The five KPIs, all five Attention items and the Live Operations / Today's Coverage headings (y = 745) are above the fold.

Compact density applies from 1024px; tablet and phone keep touch sizes (44px link targets). All 20 previews (5 scenarios × 1440 / 1024 / 768 / 390px):
- have no horizontal overflow and no text spill;
- keep the heading order intact;
- use no text under 11px apart from the sidebar's existing labels.

## 5. Release gate on the integrated branch (`bf1212d`)

| Check | Result |
| --- | --- |
| `npm run build` (backend syntax + typecheck) | pass |
| `tsc --noEmit` | pass |
| `expo install --check` | dependencies up to date |
| Spec suite (`scripts/*.spec.cjs`) | 51 / 55 files pass (1,714 passing checks); Dashboard V2 37/37 |
| Android production export | pass. Hermes bundle includes the Dashboard V2 copy and the production API URL. |
| Web production export | pass. Same checks as Android. |
| Store identity, signer provenance, pilot-build provenance specs | pass |
| Secret scan, `6cf29c8..bf1212d` | clean. No keystores, keys, env files or binaries. |

Passing specs include:
- auth refresh, session expiry, account lifecycle, role routing and API base URL;
- company compliance, Guard navigation and Guard actions;
- Book On and GPS transport;
- site time / DST and day boundary;
- shift offers;
- Live Operations policy, entry and Welfare;
- Log Book, Daily Site Log, incidents, alert resolution;
- operations report, export and timeline;
- Error Boundary, render initialisation and the dashboard runtime.

Identity: S4 · `com.sfour.s4` (Android and iOS) · 1.1.0 · versionCode 13 · iOS build 13 · API `https://security-marketplace-api.onrender.com` · OTA updates disabled · iOS privacy manifest present. The pinned Android upload certificate is unchanged.

Backend: unchanged since `6cf29c8`; 61 migrations; no Migration 62.

## 6. Known pre-existing test failures (not caused by Dashboard V2)

These four spec files fail identically, assertion by assertion, on pristine `3b7cc44` and on `bf1212d`. Each is a stale check that looks for source text whose shape changed in earlier phases:

| Spec | Failing assertions |
| --- | --- |
| `guard-personnel-p1a` | 1. Expects role constants `COMPANY_ADMIN_ROLES` / `COMPANY_VIEW_ROLES` to be absent from a backend controller. |
| `guard-personnel-p1gb` | 7. Payroll-admin enum, DTO, models, route and "payroll admin panel" text assertions. |
| `phys007-screening-remediation` | 1. Screening stage scroll uses `stageRef…measureLayout`. |
| `post-phys007-uat-remediation` | 1. Upload error markup pattern. |

Recommendation:
- Not a blocker for **internal testing**.
- Repair, or re-baseline with evidence, before the **external pilot**: a permanently red file hides new failures.
- Must be resolved before **public release**.

## 7. Live Operations side effect (pre-existing, recorded, not changed)

While the Company user has **Live Operations** open, the screen automatically writes `status: 'missed'` to shifts that are past the Book On grace (15 minutes) with no Book On. This predates Dashboard V2. Opening the Dashboard does not trigger it, but Dashboard links lead to Live Operations.

**Classification: pilot risk, not a release blocker.**
- It is not a blocker because it is existing, certified behaviour and implements the intended "missed" semantics.
- It is a risk because a status change is caused by a viewer opening a screen, not by a backend rule. Whether and when it happens depends on someone having the page open, and it writes to real operational records.

Mitigation for the pilot: brief company operators. Post-pilot: move the rule to a backend sweep.

## 8. Android AAB provenance

The certified store-candidate AAB (S4 1.1.0 (13), EAS production profile, status `certified-awaiting-play`) was built from **`6cf29c8`**. **That AAB does NOT contain Dashboard V2.**

Dashboard V2 is the Company workspace dashboard. The Company workspace is used through the web app and on tablets; the native app shows no Company workspace below 768px wide, so Guards on phones are unaffected.

Recommendation: **keep the existing certified AAB for the first Google Play internal-testing upload.** Deliver Dashboard V2 to companies through the web app once the release branch is approved, and include it naturally in the next Android build (versionCode 14). Rebuilding now would discard a certified, signer-verified artefact for a change that does not reach its primary (Guard) users.

## 9. iOS

Not built. Signing status `not-created`; artefact `not-built`; TestFlight and App Store: NOT SUBMITTED. Apple organisation conversion (Vesoft Services Limited) and the updated agreement remain pending with the owner. No Apple credentials were created.

## 10. Status

- Push: **NOT PUSHED** (`release/s4-pilot-rc1` and `dashboard-operations-v2`).
- Production deployment: **NOT DEPLOYED** (no Vercel, Render, EAS build, store upload, migrations or production writes).
