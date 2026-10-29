# Patrols P1-E — device test plan (Guard app)

**Status: device-test evidence is PENDING a separately approved native build.** Nothing in P1-E has run on a phone.
The automated evidence is `security-mobile-app/scripts/guard-patrols.spec.cjs` (pure modules executed against device
and backend fakes, the SQLite statements on a real SQLite engine) plus type-check and Android / iOS / web bundle
exports. Camera, image manipulator, file system, SQLite and crypto native behaviour is only proven by this plan.

## The build this needs

* A **new native build** — P1-E adds native modules (expo-camera, expo-sqlite, expo-file-system, expo-image-manipulator,
  expo-crypto) and a camera permission. It cannot be delivered over the air (and OTA is off).
* Built from a branch that **combines the live Guard line 1.1.2** (`release-prep/guard-app-1.1.2`, PR #59) **with P1-E**;
  the version / build number is the owner's decision (this branch keeps 1.1.0 / versionCode 17 / build 16).
* Identity unchanged: `com.sfour.s4` on Android and iOS; distributed only through the existing Play Internal testing
  track and TestFlight, after the owner approves the build and its signing conditions.
* For development testing, the app pointed at the **staging** backend per the earlier owner decision (the store-identity
  app may not be *built on EAS* against staging — `app.config.js` refuses it — so use the approved path for that: the
  `uat` variant or a local dev-client build, as the owner decides). The staging backend must run P1-A…P1-E with
  `PATROL_QR_SIGNING_KEY` set, the evidence bucket configured (`PATROL_EVIDENCE_STORAGE_*`, non-production R2) and
  Patrols switched on for one test company only.

## Devices and fixtures

| Item | Requirement |
| --- | --- |
| iPhone | iOS 17 or later, **camera set to High Efficiency (HEIC)** (Settings → Camera → Formats), Location Services on for the Camera app (so a leak would show) |
| Android | Android 12+ (a mid-range device), and if possible a second Android 10–11 device |
| Accounts | Staging Guard A and Guard B (same company, both assigned), a company Owner / Control Room account on the web dashboard |
| Site | One staging site with 3 checkpoints (one with *photo required*), one route with them, a schedule every 30 minutes covering the test shift, policy `photosPerRun = 1`, `postShiftSyncHours = 24` (and a second site / company for foreign labels) |
| Labels | Printed from the staging dashboard (P1-D label sheet): the 3 current labels; one label printed **before a rotate** (old version); one label of a **revoked** checkpoint; one label of **another site**; one of **another company**; a non-S4 QR (e.g. a URL) |
| Tools | Airplane mode; the OS app switcher (to kill the app); the dashboard's run detail / evidence list / audit to verify server state |

Record for every case: device, OS, app build, time, what the screen said, and the server-side record (run id, visit
result/flags, evidence status, sync flags) — screenshots of both.

## Cases

### A. Camera and permissions
1. First scan → rationale shown before the system prompt; **Allow** → scanner opens.
2. **Don't allow** → "Camera access is off" with *Allow camera*; tap again (Android: prompt again).
3. Deny permanently (iOS: deny once; Android: "Don't ask again") → "Turn on the camera in Settings" with *Open Settings*;
   change it there; come back → works.
4. Camera in use by another app / no camera (Android emulator without camera if available) → "Camera not available".
5. Confirm no photo-library or microphone prompt ever appears; Settings → S4 lists Camera (and Location for Book On)
   only.

### B. Scanning
6. Scan each current label → "scanned", checkpoint ticked; on the server the visit is `verified`.
7. Scan the same label again in the same patrol → "Already scanned", nothing new on the server.
8. Non-S4 QR → "Not a checkpoint label", nothing recorded on the server.
9. Old (pre-rotate) label → recorded; after sync "replaced by a newer one"; server flag `revoked_label`.
10. Revoked checkpoint label → recorded with the "not on this site's list" notice; after sync "withdrawn"; flag
    `checkpoint_revoked`.
11. Another site's label → after sync "belongs to another site" (`wrong_site`); another company's → "not one of your
    company's checkpoints" (`unknown_checkpoint`).
12. Poor light / angled label — note scan reliability.

### C. Photos (issue #72)
13. iPhone with HEIC on: take the run photo and a checkpoint photo. On the server: `mimeType image/jpeg`,
    `uploadStatus verified`, `sha256Stored == sha256Client`. Download it from the dashboard (patrols.evidence) and check
    with an EXIF viewer (e.g. `exiftool`): **no EXIF, no GPS, no XMP, no device make/model**; long edge ≤ 2048 px.
14. Same on Android.
15. Fill the phone until < 50 MB free → taking a photo says "almost out of storage"; nothing queued; scanning still works.
16. Confirm the photo is **not** in the Photos / Gallery app.

### D. Offline, restart, Book Off, sign-out
17. Airplane mode on → start a patrol, scan 3, take 2 photos, complete → every step shows "waiting to send".
18. Kill the app (swipe away) and reopen (still offline) → everything is still listed as waiting.
19. Reboot the phone, reopen → still there.
20. Airplane mode off → within about two minutes (or immediately on returning to the app) everything is sent, in order;
    the server shows one run, three visits, two verified photos, completion; device times match when the actions were
    taken; server receipt times later; `syncedLate` flags as expected.
21. Offline patrol, then **Book Off** (online Book Off requires signal: book off with signal after turning airplane mode
    off only for the Book Off request, or record the patrol offline after Book On and book off later) → after Book Off
    the queue still sends; server flags `synced_after_book_off`.
22. Offline patrol, **sign out**, sign back in as the same Guard → queue still there and sends.
23. Lose signal in the middle of a photo upload (toggle airplane mode while "sending") → retried; one evidence record on
    the server, verified.

### E. Shared phone
24. Guard A records an offline patrol and signs out. Guard B signs in on the same phone: B sees **none** of A's patrol
    items or photos, and nothing of A's is sent while B is signed in (check the server). B signs out, A signs in → A's
    items send.

### F. Session
25. Let Guard A's session expire with items queued (staging: shorten the token lifetime or revoke the session from
    another device) → the app returns to sign-in; on signing in again the items send; nothing duplicated.

### G. The 24-hour window
26. Record an offline patrol, book off, keep the phone offline for **> 24 h** (staging policy may be set to 1 h for the
    test), then reconnect → items marked "Could not be sent — contact your control room"; the photo stays on the phone
    (not in the gallery); the server has nothing new and the refusal is `PATROL_SYNC_WINDOW_CLOSED`.
27. Within the window (e.g. 20 h, or 30 min with a 1 h policy) → accepted and flagged.

### H. States and verification
28. During a patrol: "In progress"; after completing offline: "Waiting to send"; after sending: "Completed — awaiting
    verification"; "Verified" appears **only after** the server's run says verified (check the dashboard at the same
    time). With a required photo missing it never reads Verified.
29. Report a checkpoint as "Can't reach it" with a reason and complete → server run `incomplete` with the reason; a
    `patrol_incomplete` exception on the dashboard.

### I. Regression on the same build
30. Book On (with and without location verification), Book Off, early Book Off.
31. Welfare Check from the card and from a notification (I'm Safe / Need Help) during a patrol in progress — Welfare is
    unaffected, no patrol state changes.
32. Timesheets, shift offers, Live Shift Amendments, Guard inbox / notifications, sign-out / sign-in.

## Exit criteria

All cases pass on one iPhone (HEIC) and one Android device; every server-side record matches; no EXIF/GPS in any
stored photo; no queued item lost in D–G; no duplicate server records. Any failure is fixed on the P1-E branch and the
build is re-made with the owner's approval.
