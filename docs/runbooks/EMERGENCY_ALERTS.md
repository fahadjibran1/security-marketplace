# Runbook: Guard Emergency alerts (S4-EM-01)

What S4 does when a Guard presses Emergency, and how to tell whether the responsible people's phones were notified.
Read-only queries only; run them in a `BEGIN TRANSACTION READ ONLY` session.

## What happens
1. The Guard confirms on the full-screen Emergency (two taps, no typing). The app sends one request carrying an
   `Idempotency-Key` header. TRY AGAIN reuses that key; reopening the screen makes a new one.
2. In ONE transaction the server writes the alert (type `panic`, priority `critical`), its audit entry
   (`safety_alert.created`, with `requestKey`), an in-app notification for each responsible person, and the owed push
   (`safety_alert.emergency_push_pending`, with the number of registered phones).
3. Only after that commits is the Guard told "S4 received your Emergency". A retry with the same key, or a second
   press while the alert is still open and under 120 s old, is answered with the same alert
   (`safety_alert.emergency_repeat_press`, `matchedBy` = `request_key` or `window`).
4. After the commit, the push is sent to those phones (Android channel "Guard Emergencies"), and the outcome is recorded
   as `safety_alert.emergency_push_attempted`.
5. If the server stopped between steps 2 and 4, a job running every minute claims the alert once
   (`safety_alert.emergency_push_recovery`) and sends the push. It only does this while the alert is still OPEN and
   between 60 s and 10 min old. Otherwise the owed push stays visible as pending, with no attempt.

Responsible people: the company owner, plus ACTIVE members whose role carries alerts.manage (Admin, Operations,
Control Room), whose own account is active and not deleted. The web portal does not receive pushes; it shows the alert
in Live Operations and Notifications.

## Reading the outcome of one alert
```sql
SELECT action, "createdAt", "afterData"
  FROM audit_logs
 WHERE "entityType" = 'safety_alert' AND "entityId" = :alertId
 ORDER BY id;
```

| What the audit shows | Meaning | Action |
|---|---|---|
| `emergency_push_attempted` with `providerAccepted` = `devices` | Expo accepted every message. This is NOT proof the phone displayed it (no delivery receipt is read). | None. |
| `providerRejected` > 0 | Some tokens are invalid. `DeviceNotRegistered` devices are revoked automatically (`devicesRevoked`). | Ask that person to sign in to the app again and allow notifications. |
| `transportFailed: true` | Expo could not be reached. The alert and in-app notifications are unaffected. | Phone the responders; check Expo status. |
| `skipped: 'no_devices'` | No responsible person has a phone registered. | Responders must sign in on the app and allow notifications. |
| `skipped: 'disabled'` | `PUSH_EMERGENCY_ALERTS_ENABLED=false` on the service. | Re-enable unless that was intended. |
| `emergency_push_pending` with no `attempted` or `recovery` row | The push was owed and never sent (the process stopped, and recovery did not apply: the alert was closed or acknowledged first, or was older than 10 min). | Treat it as not pushed; phone the responders. |
| `emergency_push_recovery` then `attempted` | The push was sent late, by recovery. `ageSeconds` says how late. | Review why the process stopped. |

### All Emergencies in the last 7 days whose push did not fully succeed
```sql
SELECT a.id, a."companyId", a."createdAt", a.status,
       p."afterData" AS attempted
  FROM safety_alerts a
  LEFT JOIN audit_logs p ON p."entityType" = 'safety_alert' AND p."entityId" = a.id
                        AND p.action = 'safety_alert.emergency_push_attempted'
 WHERE a.type = 'panic' AND a."createdAt" > now() - interval '7 days'
   AND (p.id IS NULL
        OR (p."afterData"::jsonb ->> 'transportFailed')::boolean
        OR (p."afterData"::jsonb ->> 'providerRejected')::int > 0
        OR p."afterData"::jsonb ->> 'skipped' IS NOT NULL)
 ORDER BY a.id DESC;
```

## What the Guard is told
- "S4 received your Emergency": the alert committed. It never claims anyone saw it.
- "Emergency NOT confirmed": no answer from S4 (timeout, network, 5xx). It may have arrived. The screen checks the
  Guard's own alerts and switches to "received" if S4 has it. TRY AGAIN cannot create a duplicate.
- "Emergency NOT sent": S4 answered that it was not recorded (session ended, refused, or rate limited).
- "Acknowledged" appears only when an operator has acknowledged the alert.
Every failure message tells the Guard to call 999 if in immediate danger.

## Testing
Never use a genuine emergency as a test. Use a test session agreed in advance with the company. Close each test alert
with the reason `false_activation` and a note saying it was a test.
