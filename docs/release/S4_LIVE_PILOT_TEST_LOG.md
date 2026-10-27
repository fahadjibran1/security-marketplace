# S4 live pilot: test log (push notifications on production)

Status: **RECORDED 27 Oct 2026.** Records only. Nothing in this document changes code, configuration or data.

Every fact below carries one of three labels, and they are not interchangeable:

| Label | Meaning |
| --- | --- |
| **OBSERVED** | Read from production records (database rows, audit log, push dispatch and receipt rows, health endpoints). |
| **USER-CONFIRMED** | The owner's report of real testing on devices. Not inspected from the build machine. |
| **NOT YET VERIFIED** | No production record and no owner report yet. Must not be presented as working. |

Identifiers only: companies, Guards, shifts, devices and records are named by id. No names, no tokens, no
credentials.

All times are UK local (GMT from 26 Oct 2026, so equal to UTC).

## 1. Activation (26 Oct 2026, about 23:36)

| Item | Value | Label |
| --- | --- | --- |
| Production backend | 88e8a27, code unchanged by activation | OBSERVED |
| Migration ledger | 66 | OBSERVED |
| `PUSH_WELFARE_REMINDERS_ENABLED` | `true` | OBSERVED (owner-applied on Render, owner-approved) |
| `PUSH_WELFARE_REMINDER_COMPANY_IDS` | `all` | OBSERVED (owner-applied on Render, owner-approved) |
| `PUSH_GUARD_NOTIFICATIONS_ENABLED` | `true` | OBSERVED (owner-applied on Render, owner-approved) |
| `/health` and `/health/ready` | 200 after the change | OBSERVED |

Pre-activation backup:

- File `s4_pilot_preactivation_20261026T231700Z.dump`
- SHA-256 `cd0c39ba1c78a49ac501a9b000693dd66a5cd1aafdd1dbb4f0223ebe776e2fe3`
- Restore-verified locally: migration ledger 66, table counts equal to production at the time of the dump.

## 2. Welfare Check push (shift 68, company 9, Guard 27, Android S4 1.1.1 (19))

| Step | Record | Label |
| --- | --- | --- |
| Reminder 1 | `window_open` for the window starting 26 Oct 23:00; sent 23:36:39; `provider_accepted`; receipt `provider_delivery_ok` | OBSERVED |
| I'm Safe 1 | Welfare check recorded as daily_log 114 at 23:38:49, source `welfare_notification` | OBSERVED |
| Reminder 2 | `window_open` for the window starting 27 Oct 00:00; sent 00:00:39; `provider_accepted`; receipt pending when recorded | OBSERVED |
| I'm Safe 2 | daily_log 115 at 00:00:51, source `welfare_notification` | OBSERVED |
| Follow-ups | None sent for the two met windows (correct: a met window gets no follow-up) | OBSERVED |
| Integrity | 0 duplicate reminders, 0 company / Guard mismatches, 0 sends to revoked devices | OBSERVED |
| Owner report | Welfare Check notifications work in real testing | USER-CONFIRMED |

## 3. Live Shift Amendment push (shift 68)

| Step | Record | Label |
| --- | --- | --- |
| Request | Amendment 2 requested 27 Oct 00:04:51 | OBSERVED |
| Guard push | Guard notification dispatch 4, `shift_amendment_requested`, `provider_accepted` (company 9) | OBSERVED |
| Guard answer | Accepted in the app at 00:05:32, `responseMethod` `guard_app` | OBSERVED |
| Audit | `shift.extended` at 00:05:31 | OBSERVED |
| Result | Shift end now 27 Oct 07:00 (was 06:00) | OBSERVED |
| Company | The proposer received the in-app `shift_amendment_responded` notification | OBSERVED |
| Owner report | Shift Extensions work | USER-CONFIRMED |

## 4. Push-registration loop fix (1.1.1)

| Item | Record | Label |
| --- | --- | --- |
| Devices on 1.1.1 | The Android devices of Guards 27 and 11 report `appVersion` 1.1.1 | OBSERVED |
| Registration writes | Total `push_devices` writes went from 6,990 to 6,992: one per app start, against about four per second before the fix | OBSERVED |

## 5. Not yet verified

None of the following has a production record or an owner report. Each stays unverified until it has one.

- Shift offer push.
- Offer withdrawal / cancellation push.
- Re-acceptance (material shift change) push.
- Inbox read / unread state on a device.
- Any iOS push. No iPhone on 1.1.1 is registered yet: Guard 26's iOS device still reports 1.1.0, and the owner's
  iPhone is not registered.
- Guard 28 is still on 1.1.0.
- TestFlight group assignment of iOS 1.1.1 (18). EAS submission `5118fcda-b1d0-4c6c-ae19-39fe1d2a6df2` uploaded it
  to App Store Connect on 26 Oct 2026; its assignment to a TestFlight group is not confirmed.

## 6. Operational note

- missed_checkcall alert 45046 (shift 68, 22:05, before activation) was still open at 00:09. The control room is
  to resolve it under the normal procedure. It is not a push defect: it predates activation.

## 7. Known missing notification events at 88e8a27

These events produce no push, no in-app notification and no email on the current production backend. They are
known gaps, not regressions from activation.

| Event | Gap |
| --- | --- |
| A Guard accepts or declines an offer | The company is not told. |
| A company cancels an `in_progress` shift, or DELETEs an accepted (ready) shift | Nobody is told. |
| PATCH reassigns a shift from Guard A to Guard B | Only B is told; A is not. |
| A shift extension is decided or expires | The Guard is not told (the company gets an in-app notification only). |
| A Guard is replaced | `shift_replaced` is not emitted until Replace Guard (#38) ships. |
| A rota slot is cancelled | No shift-level audit entry (issue #41). |
