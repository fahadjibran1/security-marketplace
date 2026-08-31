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
