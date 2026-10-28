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

## 5. Update, 27 Oct 2026 (about 11:45)

**USER-CONFIRMED:** the owner reports phone push notifications working on **both Android and iPhone**. Welfare Check and
shift-extension notifications were observed during live testing.

**OBSERVED (production records, read-only):**
- iOS: Guard 26 (user 37) reports S4 1.1.1 on an iPhone, so iOS 1.1.1 (18) reached a pilot Guard through TestFlight.
  One Welfare reminder to it (company 9) was provider_accepted, and its receipt is provider_delivery_ok.
- Shift offer push: guard notification dispatch 5, `shift_offered` for shift 69 (company 9, user 37), created
  10:28:55. It was provider_accepted, and its receipt is provider_delivery_ok. The Guard accepted the offer at 11:26:13
  (`shift.offer_accepted`).
- Extension push to the same iPhone: dispatch 6, `shift_amendment_requested` for shift 69, created 11:37:02, was
  provider_accepted.
- Totals since activation:
  - Welfare reminders: 9, all provider_delivery_ok.
  - Duplicates: 0.
  - Company or Guard mismatches: 0.
  - Revoked devices: 0.
- Inbox read: both `shift_amendment_requested` notices sent since activation have a `readAt`.

## 6. Manual attendance: first live result (28 Oct 2026)

Production backend baaefb7 (Part B manual attendance and the overlap fix), migration ledger 67. Company web 369e665 (`dpl_V9nCw5offPRBWSoLJ51hWwbCDMkK`).

**OBSERVED (production records, read-only) and USER-CONFIRMED (owner, 28 Oct): PASS on all eight checks.**
- Shift 69 (company 9, Guard 26, Totmonslow, scheduled 27 Oct 11:00–19:00):
  - **Book On:** app Book On (attendance event 54) at 27 Oct 11:26:19. Unchanged.
  - **Book Off:** manual Book Off (attendance event 55, `source = manual`) with actual time **27 Oct 19:00:00**. Recorded separately at **28 Oct 00:08:30** by user 32 (Owner), verification method `phone_call`, reason present. Audit `attendance.manual_book_off`.
  - **Shift status:** `completed`. The Missing Book Off alert 45446 was closed (`shift.missing_book_off_resolved`).
  - **Timesheet:** timesheet 39 created as a **draft** with actual times 11:26:19–19:00:00, **454 verified minutes**, `verifiedSource = manual`, unpaid, approved minutes empty. It is subject to the existing Guard submission and company approval.
- **Earlier evidence untouched:**
  - All 44 earlier attendance events are unchanged (fingerprint `d0474986e194ad0cf1763a63c164e52b`).
  - Shift 53 and its `shift.reconciled_without_book_off` audit are unchanged.
  - No duplicate effective attendance, and no manual records on any other shift.
- **Before this fix:** the same Book Off was refused with 409 "overlap … shift #53". A closed shift without a Book Off was being treated as open-ended; fixed in baaefb7 (PR #54).
- **Rollback note:** a manual record now exists, so the backend must not be restored to a build older than 671fb9f.
- **Still open, not part of this test:** missed Welfare Check alert 45371 on shift 69 (raised 13:08) is still open, for the control room.

## 7. Timesheet review end to end: timesheet 40 (28 Oct 2026)

Production backend bca5047, then 6d7dd3c (auth fix only); company web `dpl_7PRnbctsC1gxU6CKHWbzL34YyX3B`.

**OBSERVED (production records, read-only) and USER-CONFIRMED (owner): PASS.**

**Shift 71** (company 9, Guard 11, scheduled 28 Oct 00:30–10:00):
- Manual Book On, attendance event 56: actual 00:30:00, recorded 00:36:32 by user 32.
- App Book Off, event 57: 09:03:37.
- Verified time: **514 min (8h 34m)**.

**Timesheet 40 history:**

| Time | Event |
|---|---|
| 09:42:25 | Submitted, 9.50 h. Guard note "Site finished early". |
| 09:45:02 | Returned by user 32 with the old web default reason. Notice `timesheet_rejected` sent. |
| 13:14:03 | Resubmitted from the installed 1.1.1 app with **9.30 h**. Decimal entry, stored as 558 min = **9h 18m**. |
| 14:59:06 | **Approved** by user 32: approved minutes **570 (9h 30m)**, `overrideReason` "site finished early" (`overrideBy` 32, `overrideAt` 14:59:06). Audit `timesheet.approved` and `timesheet.approved_duration_overridden`. Notice `timesheet_approved` sent. |

- **State now:** unpaid, uninvoiced, `rejectionReason` cleared on approval.
- **Unchanged:** attendance events 56 and 57, verified minutes 514, and the Guard's claim (9.30 h, 558 min).

**What this proves:**
- verified attendance, the Guard's claim and the approved payable hours are kept separately;
- an approval that differs from verified attendance requires and records an override reason, the reviewer and the time;
- the review history (submission, return, resubmission, approval) is preserved;
- payroll and billing are untouched until their own processes run.

**Notes:**
- The approved 9h 30m is 56 min more than verified and 12 min more than the Guard's stored claim (9h 18m from "9.30").
- The resubmission came from 1.1.1, before Guard 11 updated to 1.1.2 at 14:56. So the 1.1.2 Hours/Minutes entry and the Guard-side return banner were **not** exercised in this run. They still need a live test on 1.1.2.

**1.1.2 rollout (Guard 11 Android):**
- Updated to 1.1.2 at 14:56 with exactly one push-device registration (cumulative push_devices writes 7,010 → 7,011). No registration loop.

## 8. Not yet verified

Nothing below has a production record yet. Each stays unverified until it does.

- Offer withdrawal or cancellation push (`shift_offer_withdrawn`).
- Re-acceptance push after a material change to an accepted shift (`shift_reacceptance_required`).
  The rota time change on 27 Oct (`rota_slot.time_changed`, slot 46, 10:02:53) happened before any Guard was assigned
  (10:28:57). So no Guard notice was expected, and it does not test this flow.
- The unread side of the inbox: a notice staying unread until it is opened, and the badge count.
- Guard 28 is still on 1.1.0.

## 9. Operational note

- missed_checkcall alert 45046 (shift 68, 22:05, before activation) was still open at 00:09. The control room is
  to resolve it under the normal procedure. It is not a push defect: it predates activation.

## 10. Known missing notification events at 88e8a27

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
