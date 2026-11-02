# Patrol Monitor S1: read model and API contract

Owner-approved 2 Nov 2026 (S1 only: backend model, summary endpoint, site-window endpoint, synthetic performance tests).
S1 adds no migration and no new stored data. It does not change patrol scheduling, verification, QR signing, evidence
retention or any existing route or payload. The Guard app 1.2.1 API is untouched.

Code:
- `security-backend-nest/src/patrol/patrol-monitor-model.ts`: pure rules.
- `patrol-monitor.service.ts`: one batch of reads per request.
- `patrol-monitor.controller.ts`: `GET /patrols/monitor/*`.
- Tests: `scripts/patrol-monitor.spec.ts` (release gate) and `scripts/patrol-monitor-perf.ts` (on demand, synthetic
  scale).

## Authority

The Monitor only presents what the existing engines and the sweep decide:

| Question | Source |
|---|---|
| Which windows exist | The clock engine (`windowsBetween`) and the shift-anchored engine (`shiftAnchoredWindows`), with schedule-version bounds |
| Who is on duty | `OperationalWindowService.isApplicable` over in-progress and completed shifts, as the sweep reads them |
| Which patrol covers a window | `runCoverageKey` (schedule, window key, scope, the window's actual start) |
| Verified | `patrol_runs.verificationStatus = 'verified'` only (written by the sweep) |
| Missed | A `patrol_missed` exception only (raised by the sweep) |
| Judged | The sweep watermark `patrol_sweep_watermarks.judgedThrough` |

## Window states

First match wins.

**With a covering patrol run:**

| Condition | State |
|---|---|
| In progress, before its completion deadline | `in_progress` |
| In progress past the completion deadline, or `incomplete` / `closed_by_system` | `incomplete` |
| Completed, verification `flagged` | `flagged` |
| Completed, verification `unverified` | `not_verified` |
| Completed, verification `verified`, late start | `late_verified` (amber, "Late · Verified") |
| Completed, verification `verified` | `verified` (the only green) |
| Completed, verification `pending` | `awaiting_verification` |

**Without one:**

| Condition | State |
|---|---|
| A `patrol_missed` exception exists for (window key, scope) | `missed` |
| now < start (a shift is scheduled) | `future` |
| Nobody on duty for it (scheduled but not booked on) | `not_on_duty` |
| start ≤ now < end | `due` |
| end ≤ now < end + start grace | `overdue` |
| Start deadline passed, watermark has not reached it | `awaiting_check` |
| Start deadline passed and judged, nothing raised | `not_judged` |

Windows that no shift was ever scheduled for are not shown.

**Hour cells.** A window belongs to the site-local hour in which it starts.
- Cells are `{state, total, owed, verified, windowKeys}`. The state is the most severe present, in this order: missed,
  incomplete, flagged, not_verified, overdue, late_verified, awaiting_check, awaiting_verification, in_progress, due,
  verified, not_judged, not_on_duty, future.
- An hour with no window is `none`.
- In shift lanes, an hour is `off_duty` outside the shift, and `not_required` when the shift owes no patrols.

**Hours.** Hour boundaries fall where the site's local minute is 00. An autumn day has 25 hours, with the repeated hour
labelled twice (`repeated: true`, its own `offset`). A spring day has 23 hours. Zones offset by 30 minutes work.

**Lanes.**
- Site-wide obligations (`requirementScope = 'site'`, clock schedules) appear as ONE `site` lane. The covering run's
  `runGuardId` names the Guard who did it.
- Per-guard clock schedules, and shift-based patrols under an active setup, give one `shift` lane per shift (a shift
  that is not cancelled or rejected). A lane carries the Rota Planner requirement view.
- Runs that satisfy no window shown go in `otherRuns`: unscheduled, `window_already_covered`, or unmatched. They are
  never counted as patrols, but their exceptions count.

**Site status:**

| Status | When |
|---|---|
| `attention` | A window is overdue now, or an exception in range is unresolved (open or acknowledged) |
| `watch` | A late-verified, flagged, not-verified or awaiting-check window, or verification pending past the sync deadline |
| `on_track` | At least one owed window has started and none of the above apply |
| `not_started` | Windows are still to come, but none has started yet |
| `no_patrols` | No windows in the range |

Resolved exceptions are history: they appear in the counts, not the status.

## `GET /patrols/monitor/summary`

Query: `date` (YYYY-MM-DD, site-local; defaults to each site's today), `clientId`, `siteId`. Requires `patrols.view`.
Returns 404 `PATROLS_NOT_ENABLED` while Patrols is off.

```
{ generatedAt, dateBasis: 'site_local', date|null,
  sweep: { judgedThrough|null },
  totals: { sites, byStatus: {attention, watch, on_track, not_started, no_patrols}, ...counts },
  liveOps: { openPatrolAlerts, missedToday, missedTodayOpen },
  sites: [{ siteId, siteName, clientId, clientName, timeZone, date, dayStart, dayEnd, status, counts, lanes, nextWindowStart }] }
```

`counts` = `windows, owed, verified, verifiedOnTime, lateVerified, inProgress, awaitingVerification, missed, missedOpen,
incomplete, flagged, notVerified, overdue, due, awaitingCheck, future, verificationOverdue, openExceptions, openAlerts`.

`sites` lists only sites with patrols configured, most severe first.

`liveOps` covers the whole company:
- `openPatrolAlerts`: patrol-type safety alerts that are not closed, exactly the items Attention Now lists. An
  exception and its alert are one item.
- `missedToday`: missed windows (one per window and scope) that started on today's site-local day, in any status.
- `missedTodayOpen`: the subset not yet resolved.

## `GET /patrols/monitor/sites/:siteId`

Query: either `date` (the site day, today by default), or `from` + `to` (instants, at most 36 h; `from` is floored to
the site hour), never both. Same permissions as the summary; another company's site returns 404
`PATROL_SITE_NOT_FOUND`.

```
{ generatedAt, siteId, siteName, clientId, clientName, timeZone, range: {from, to, date|null},
  sweep: { judgedThrough }, policy: { requirementScope, methods, startGraceMinutes, photoRequired },
  setup: { active, mode }, status, counts, nextWindowStart,
  hours: [{ index, start, end, label, offset, repeated, current }],
  lanes: [{ key, kind: 'site'|'shift', shiftId, guardId, guardName, shiftStart, shiftEnd, shiftStatus, requirement,
            windows: [{ key, scheduleId, windowKey, scopeKey, anchor, start, end, startDeadline, state, runId,
                        runGuardId, lateStart, verificationOverdue, exceptionId, exceptionStatus, exceptionIds,
                        alertId, alertStatus }],
            cells: [{ hour, state, total, owed, verified, windowKeys }] }],
  runs: { [id]: { id, guardId, guardName, shiftId, status, verificationStatus, lateStart, windowStart, windowEnd,
                  startedAtServer, startedAtDevice, completedAtServer,
                  checkpoints: { required|null, verified|null, scans, repeatScans, flaggedScans, qrRuleMissing },
                  photos: { taken, verified, missing } } },
  otherRuns: [{ runId, reason, exceptionIds }],
  exceptions: { [id]: { id, type, status, runId, alertId, alertStatus } } }
```

`checkpoints.required` is the run's route version's required, active, unrevoked checkpoints (`null` when QR is not
required). `verified` counts unique checkpoints, so a repeat scan never counts twice. `photos` are counts only. No
evidence object, storage key, hash or URL is read or returned. Thumbnails and original or stamped images keep using the
existing audited evidence endpoints.

## Performance

Each request runs a fixed batch of company-scoped queries, independent of the number of sites or hours:
- a summary of every site uses the same number of queries as one site (asserted in PMON-13);
- windows are computed in memory, each clock schedule's windows once per site. A request-scoped cache of site-local
  time conversions is kept per time zone (its keys are date and minute only, so zones never share one) and dropped
  with the request. Without it, a per-guard site recomputed the same windows for every shift lane at about 2 ms per
  conversion (the 50-site summary took about 63 s). PMON-14 and PMON-16 prove the output is identical to the original
  path; PMON-15 times it.

Known engine limit (unchanged by S1): `siteLocalToInstant` in `common/site-time.ts` resolves some times wrongly near a
clock change in zones more than about 2 hours from UTC (for example New York's change days, or Adelaide's evening before
its spring change). UK sites are unaffected. A fix belongs to the shared engine and needs its own approval.

`scripts/patrol-monitor-perf.ts` measures the reads on a synthetic dataset (50 sites, about 1.3 M patrol runs, 216 k
photos), with and without candidate indexes. Index decisions come from its output and need separate approval.
