# S4 Guard 1.1.0 — physical-device UAT (Android 15 / iOS 14)

Prepared 20 October 2026. **Not executed.** Covers Android `1.1.0 (15)` (EAS `8d1873a3`) and iOS `1.1.0 (14)`
(EAS `7333ba4d`), both built from `6b8e41b`.

## Which build for which test

The certified store artefacts are production-profile builds: their only API is
`https://security-marketplace-api.onrender.com`. Every signed-in Guard action in them writes **production**
attendance, welfare, alert, incident or shift records. So:

| Build | May be used for | Must not be used for |
|---|---|---|
| Store artefacts (vc15 / build 14) | Install, launch, upgrade over vc14 / build 13, app name / icon / version footer, sign-in screen layout and large text, the sign-in error for an email that has no account (a real account's failed attempt may be recorded), offline error on the sign-in screen | Anything after sign-in that writes: Accept / Decline, Book On, Welfare, Incident, Site Request, Book Off |
| UAT build against staging (see `STAGING_RESTORE_PLAN.md`, "UAT build") | Every row below | — |

Signing in to production creates a session (refresh token and audit entries). Even a sign-in-only check on the
store artefact is an owner decision; it uses a real account, so it is not part of this checklist.

Facts that shape the tests (from the source at `6b8e41b`):
- There are **no push notifications** (no `expo-notifications`). Welfare due / overdue is shown in the app only;
  the missed-Welfare alert is raised by the backend sweep and appears to control (web Live Operations), not as a
  phone notification.
- There is **no network-state library**. Offline is detected only by a request failing; check the wording.
- Location is used (`expo-location`) where a site requires GPS.

## Devices

- Android: one small phone (≤ 6.1", or 720×1280-class) and one current Pixel/Samsung; Android 10 or newer.
- iPhone: one small (SE / mini) and one current model; iOS 15.1 or newer.
- On each, run once at default text size and once at the **largest** system text size
  (Android Settings › Display › Font size + Display size; iOS Settings › Accessibility › Display & Text Size ›
  Larger Text).

Record for every row: device, OS version, build, PASS / FAIL, screenshot reference, notes.

## Checklist (staging UAT build)

### 1. Sign-in and session recovery
1. Sign in as test Guard A. Expected: Guard home, Current Shift card.
2. Wrong password. Expected: clear error, no crash, no account detail leaked.
3. Kill the app and reopen. Expected: still signed in (session restored), no second login.
4. Leave idle past the access-token lifetime (or ask control to revoke the session), then act. Expected: renews
   silently, or returns to sign-in with a clear message — never a blank screen.
5. Sign out. Expected: back to sign-in; reopening the app does not restore the session.

### 2. Offers — Accept and Decline
1. Control offers a shift to Guard A. Expected: Offers tab shows "1 pending".
2. Open the offer; Accept and Decline both visible without scrolling past the bottom navigation, on the small
   phone at largest text.
3. Decline with a reason. Expected: one decline recorded in web; offer leaves the list.
4. Control offers another; Accept. Expected: shift moves to the Guard's accepted shifts; one acceptance in web.
5. Double-tap Accept quickly. Expected: one acceptance only.

### 3. Book On
1. Before the start, more than 30 min early: tap Book On. Expected: "Book on early?" with the scheduled start
   and that shift times do not change; Cancel sends nothing; confirm books on once.
2. Within 30 min / on time / late: Book On proceeds without a question.
3. GPS-required site with location denied. Expected: a clear explanation, not a silent failure.
4. Web Live Operations shows the Guard booked on, at the right site time.

### 4. Hourly Welfare Checks
1. After Book On, the Welfare card shows the next due time.
2. Open Record Welfare Check, type a note: **with the keyboard open, Cancel and Record Welfare Check are both
   visible above the keyboard** (small phone, largest text — they may wrap to two rows).
3. One tap records one check (web shows one entry); the due time moves on.

### 5. Missed Welfare Check alert
1. Let a check go overdue on a staging shift (or use a short staging interval).
2. App: "Welfare Check overdue" status line.
3. Web Live Operations: a welfare alert for that Guard / shift, once (no duplicates on the next sweep).
4. Record the check in the app. Expected: overdue clears in the app; the alert follows the documented
   acknowledge / resolve flow in web.

### 6. Incident and Site Request
1. Report Incident with a description: keyboard open, Cancel and Submit Incident visible; one tap, one incident
   in web with the right site and time.
2. Raise Site Request: same checks.
3. Add a Log Book entry: same checks.
4. Cancel on each form sends nothing.

### 7. Book Off confirmation
1. Within 15 min of the scheduled end (or after it): Book Off asks "Book Off now?" with the scheduled end.
   "Stay on shift" sends nothing; "Book Off" completes the shift once.

### 8. Early Book Off
1. More than 15 min before the end: "Book Off early?" shows the scheduled end, how early (e.g. "2 hr 10 min"),
   and that control will see an early Book Off and it cannot be undone. Button styled as a warning.
2. Stay on shift: nothing sent, still live.
3. Book Off early: one check-out; web shows the early Book Off.

### 9. Offline and reconnect
1. Airplane mode on the Guard home. Pull to refresh. Expected: a clear "can't reach S4" style message, cached
   shift still visible, no crash.
2. Airplane mode, then Record Welfare Check. Expected: a failure message; the form keeps the typed note; nothing
   is shown as recorded.
3. Reconnect and retry. Expected: recorded **once** (check web for duplicates).
4. Background the app for 10+ minutes, return. Expected: data refreshes; session intact.

### 10. Large text and accessibility
1. Largest system text on the small phone: every Guard screen readable, no clipped buttons, all actions reachable
   (Home, Offers, Jobs, History, Profile, every form).
2. TalkBack (Android) / VoiceOver (iOS): Book On, Book Off, Record Welfare Check, Accept, Decline, Close are
   announced with their labels.
3. Wording: the Guard interface says **Book On / Book Off** throughout (no "check in", "clock in", "start shift").

## Exit criteria

All rows PASS on one Android and one iPhone at largest text, no duplicate records in web, and nothing written to
production. Any FAIL blocks the store upload until fixed and re-certified.
