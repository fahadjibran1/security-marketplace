# Patrol assignment correctness (production P-6)

Owner-approved 3 Nov 2026 after production patrol P-6: the Guard booked on before the site's setup was activated, the
phone's cached plan had no window, "Start patrol" sent no schedule, and the patrol was recorded ad hoc while the
10:10–10:40 window it was done in stayed owed. P-6 itself is not changed.

## Server-side window matching

`POST /patrols/runs` without a `scheduleId` (`patrol-guard.service.ts` `matchWindow`, rule in `patrol-window-match.ts`):

- Candidates are THIS shift's windows only: the site's clock windows overlapping the shift (every schedule version in
  force; scope `site`, or `sh{shift}` when per guard) and, when the setup is active and the shift must patrol, the shift's
  own shift-anchored windows (scope `sh{shift}`). Company-scoped; reads only.
- Start time: the drift-adjusted device start, exactly as for a start naming a schedule.
- A window that CONTAINS the start comes first: exactly one free window → linked; more than one → ad hoc,
  `window_match_ambiguous`; none free → ad hoc. Only when no window contains the start, a window that ended within the
  start grace is linked late in the same way.
- Never taken: a window that already has a run for its scope (covered), or one with a `patrol_missed` exception (a
  missed outcome is never overwritten or annotated). One run, at most one window; the existing unique index settles
  concurrent starts (the loser is recorded ad hoc).
- Linked runs carry `window_auto_assigned` (never a review reason) and the audit entry
  `patrol.run.window_auto_assigned`; unlinked starts `patrol.run.window_not_assigned` (the windows weighed, in words).
- The answer adds `windowAssignment { outcome, message }`, read from the stored run, so replays and concurrent
  duplicates answer identically. A replay without a schedule matches a run S4 linked.
- Compatibility safeguard (Guard app 1.2.1): the app keeps the route it sent at start and never learns a linked
  window's route from the answer, so on a QR or QR + photos site it would show the checkpoints as optional while S4
  judged the window's required ones. A QR window is therefore linked only when the phone sent that window's route
  (same route chain); otherwise the run stays ad hoc with `window_match_needs_route` (outcome `route_not_shown`,
  audited, explained on the Monitor). Photo-only sites are linked as described (their photo rule is the site policy,
  which the app shows).
- Post-shift (offline) starts follow the same matching, then the existing post-shift rules. Verification and evidence
  rules are unchanged. No migration (sync flags are validated in code).

## Patrol Monitor

- Ad-hoc patrols are placed in their lane and site-local hour (`otherRuns[].laneKey / hour / startedAt / explanation`),
  marked on the cell (`adHoc`, ◇) and on the window open when they were received (`adHocRunIds`); never counted.
- Cells count on the card's basis: verified of the windows due, and apart those still to come (`later`), e.g. "0/1 +1";
  the card reads "Verified 0/1 · 1 later".
- A window's detail explains why received evidence has not satisfied it (photos still needed or being checked, QR
  checkpoints not verified) and names ad-hoc patrols received during it.

## Photographic stamp

`patrol-evidence-stamp.ts`: a compact translucent panel in the photo's bottom-left corner — company, site, Guard and the
device capture time, then the patrol reference, photo number and sfour.co.uk — in Inter (OFL, `@fontsource/inter`) drawn
as paths with `opentype.js` (no system font). At most 10% of the photo and 45% of its width (62% on a portrait photo);
a photo too small for that gets the band below it instead. The original's bytes, SHA-256, retention, audit and access
rules are unchanged; the stamped copy is still made per request and never stored. Server receipt time, patrol window
and the SHA-256 fingerprint are in the evidence viewer beside each photo. No wording implies a person reviewed a photo.
