# Patrol Monitor S2: the compact Monitor on the company dashboard

Owner-approved 3 Nov 2026 (S2: web dashboard only). It reads the two S1 endpoints as they are
([patrol-monitor-s1.md](patrol-monitor-s1.md)). No backend, migration, shared time engine, verification rule or Guard
app change, and no mobile build: it ships with the web dashboard.

Code (`security-mobile-app/src/components/patrols/`):
- `patrolMonitorPresentation.ts`: pure rules (state labels, symbols and colours, site priority and filters, site-local
  clock, hour labels, grid sizes).
- `PatrolMonitorTab.tsx`: the section: day selector, Live Operations counts, client and status filters, grouped cards.
- `PatrolMonitorSiteCard.tsx`: one site card, its hour grid and cells.
- `PatrolMonitorCellDetail.tsx`: an opened cell.
- `PatrolMonitorMarks.tsx`: the state mark, palette and key.
- API: `getPatrolMonitorSummary`, `getPatrolMonitorSite` in `src/services/api.ts`; types in `src/types/patrols.ts`.
- Tests: `scripts/patrol-monitor-ui.spec.cjs` (PMUI-01…17, mobile release gate).

## Navigation

Patrol Management sections: **Monitor** (first, and the section the page opens on), Setup, Today, Evidence, Advanced.
The other four are unchanged. On Monitor the page-level site picker is hidden: the cards are the site list.

## Colours, labels and symbols

Every state has a text label and a symbol; colour is never the only signal.

| Colour | State | Label | Symbol |
|---|---|---|---|
| Green | `verified` (on time, server-verified) | Verified | ✓ |
| Amber | `late_verified` | Late · Verified | ◷ |
| Amber | `awaiting_verification` | Awaiting verification | … |
| Amber | `incomplete` | Incomplete | ◐ |
| Amber | `flagged`, `not_verified` | Needs review (the detail says which) | ⚑ |
| Amber | `overdue` | Overdue | ! |
| Amber | `awaiting_check` | Awaiting check | ? |
| Red | `missed` (a sweep-raised `patrol_missed` exception only) | Missed | ✕ |
| Blue | `in_progress`, `due` | In progress, Due now | ▶, ● |
| Grey | `future`, `not_on_duty`, `not_judged` | Upcoming, No guard on duty, Not assessed | ○, –, · |
| None | `none`, `off_duty`, `not_required` | No patrol window, Off duty, No patrol required | |

An unknown state is drawn blank, never green or red.

## Cards

- One card per site with patrols. Collapsed: site, client, status, **Verified x/y** (verified of those due so far, with
  the day's total), **Missed**, **Needs review** (flagged + not verified), and the next window. One line on desktop and
  tablet; stacked on a phone.
- Order: Needs attention (`attention`, `watch`), then On track, then No patrols due (`not_started`, `no_patrols`); within
  a status, most missed, then most needing review, then by name.
- Client and status filters work on the loaded summary (no extra request).

## Expanded site

- A shared **Site Patrol** row for site-wide obligations; one row per guard / shift, with its times in site time
  (an overnight shift reads "22:00 (−1 day) – 06:00").
- One cell per site-local hour: 25 on the autumn change day (the repeated hour reads "01 (2nd)", with its UTC offset),
  23 in spring. Several windows in an hour read as verified/total, e.g. "1/2", under the hour's most severe symbol.
- The row names stay fixed while the hours scroll sideways; the grid opens on the current hour. Cells are 44 px touch
  targets at every width.
- A cell opens its windows: times, state and its meaning, the Guard, start and completion times (received by S4), QR
  checkpoints (verified of required, scans, repeats, flagged), photo counts (taken, verified, missing) and the exception.
  It is built from the site read already on screen: no request, no evidence link, no image. "Open patrol record and
  photos" opens the existing audited patrol record (photos only with `patrols.evidence`); a missed window links to its
  exception and to Live Operations.
- On a phone the opened cell is a full-screen sheet.

## Loading and refresh

| Read | When | Refreshed |
|---|---|---|
| Summary (about 28 KB for 50 sites) | Once when Monitor opens, and on a day change | Every 30 s while the page is on screen and showing today |
| One site (about 48 KB) | When its card is expanded | Every 30 s while it stays expanded, on screen and on today |

A past day is read once and never refreshed. Collapsing a card stops its refresh and drops its data. A refusal (403,
Patrols switched off) stops refreshing. Without `patrols.view` nothing mounts and nothing is requested.

## Day selector

Today (each site's own local day) by default; Previous day / Next day step through site-local days (never past today);
"Back to today" returns to live. The Live Operations counts (open patrol alerts, missed today) show only on today.
