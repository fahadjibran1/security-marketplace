# S4 Pilot Hypercare Runbook

## Ownership

Before pilot deployment record the release manager, application engineer, database owner, security contact and support escalation route. Keep the approved SHA, change ticket, dashboards and incident channel immediately available.

## First 24 hours

- Continuously monitor `/health/live` and `/health/ready`, deployment restarts, HTTP 5xx, database connectivity/pool saturation and routine API latency.
- Review authentication failures and HTTP 429 rates without treating valid throttling as an outage.
- Watch Book On/Book Off failures, GPS/NFC validation, duplicate attendance attempts and timesheet creation.
- Confirm panic alerts reach the owning company and acknowledgement/closure remains attributable.
- Review compliance upload/verification failures and tenant-denial signals.
- Review payroll/invoice batch failures, duplicate-consumption conflicts and unexplained value differences.
- Sample logs for request IDs and confirm no secrets, tokens, hashes or evidence contents are exposed.
- Hold scheduled checkpoints at deployment +1 hour, +4 hours and end of day.

## First seven days

- Review daily health, 5xx, p50/p95 latency, authentication/429, database, attendance, alert, compliance and finance summaries.
- Confirm the daily logical backup succeeded and the managed recovery facility remains healthy.
- Review every P0/P1 and recurring P2 with named corrective owners.
- Maintain one scheduler-active instance and verify scheduled finance/reminder activity is not duplicated.
- Check support volume and tenant-specific patterns without combining tenant data in reports.

## Escalation thresholds

- Any authentication bypass, cross-tenant disclosure, financial corruption or material data loss: P0 and immediate containment.
- Sustained readiness failure, critical guard workflow outage, panic-alert failure, or repeated database outage: P1 unless impact requires P0.
- Routine endpoint p95 above two seconds: investigate; above five seconds for operational screens is a candidate pilot blocker.
- Two consecutive failed backup periods: P1 operational escalation.

Use `INCIDENT_RESPONSE.md`, `ROLLBACK.md`, and `BACKUP_RESTORE.md` for containment and recovery. Hypercare completion does not itself approve wider production rollout; record a formal pilot review after day seven.

## Control-room fallback when the Guard app fails (S4 1.1.0, 21 Oct 2026)

S4 never records a Guard action on the Guard's behalf: the backend refuses accept, Book On, Welfare Check and
Book Off from a company account. Control's job is to keep the Guard safe, keep the site covered, and leave an
honest record. In every case: phone the Guard first, note the time and what they report, and send the device
model, OS, app version (footer) and a screenshot to the S4 owner.

| Failure | Control does | In S4 (web) | Do not |
|---|---|---|---|
| **Cannot accept an offer** | Phone the Guard; ask them to fully close and reopen S4, check signal, sign out and in, then retry. If still failing and the shift is soon, cover it with another Guard | Live board / Planner: cancel the offer or reassign the shift to another Guard (a reassigned shift is a new offer the Guard must accept). Accepting for the Guard is refused by design | Leave the site uncovered waiting for the fix |
| **Cannot Book On** | Confirm by phone the Guard is on site; log the call time. Guard keeps retrying (signal, reopen app). For a GPS site, check location permission is "While using" | Nothing to record on their behalf. If the start grace passes, the shift shows Missed; use "Re-cover" only if the Guard is genuinely not there | Ask the Guard to share their password or sign in for them |
| **Cannot record a Welfare Check** | Phone the Guard at each due time until fixed; confirm they are safe | When the missed-Welfare alert appears: **Acknowledge**, then **Resolve** with `control_contacted_guard` (or `app_technical_issue` / `phone_device_issue`) and a note: time of call, Guard confirmed safe | Resolve an alert without having actually spoken to the Guard |
| **Cannot Book Off** | Phone the Guard to confirm they have left site and the time they left | After the scheduled end + 15 min: Live Operations › **Close without Book Off** › reason + note (state the reported leaving time). Then, in Timesheets, set approved hours with an override reason if they differ | Expect a Book Off time to be created — none is; the note and timesheet override are the record |

Escalate to the S4 owner if the same failure hits two Guards, or one Guard twice in a shift. If S4 is down
(`/health/ready` not 200), switch the whole site to phone welfare checks every hour and record them in the
company's paper/incident log until service returns.
