# Patrols P1-E — Patrol Management on the Guard's phone

Status: implemented on `feature/patrols-p1e` (draft PR into `feature/patrols-p1d`). Not built, not deployed.
**Needs a new native store build** (camera, SQLite, file-system, image-manipulator and crypto modules are new) — it
cannot ship over the air, and OTA is off for this app anyway. Device testing is pending a separately approved build
(see `P1-E-device-test-plan.md`).

## What the Guard gets

| Area | Behaviour |
| --- | --- |
| Where | A **Patrols** section inside the Home tab's Current Shift card (`GuardPatrolPanel`). Shown only on a live (in progress) shift when `GET /patrols/mine/plan` loads (the company's Patrols switch is on) **and** the site has checkpoints or schedules. Anything still waiting to send, or refused, is listed on every Home state — also after Book Off and when there is no shift. On the web app there is no patrol panel (`GuardPatrolPanel.web.tsx`). |
| Due times | The plan's `windows` — the **server's** site-local windows of the shift (the sweep's own engine, see "Backend change"). Shown on the site's clock as `due now` / `upcoming` / `covered`. With an older backend (no `windows`) the app shows no due times rather than inventing any. |
| Start | Client id (`crypto.randomUUID`), device time, the due window's schedule/route (or an unscheduled patrol) — written to the outbox **before** any network call. |
| Scan | S4's own camera (`expo-camera` `CameraView`, QR only). The text is checked locally for the `s4cp:1:…` format only (the same rule as the backend parser — the spec runs both); the raw payload is sent; the **server** decides signature, version, revocation, site, route. A non-S4 QR is refused on the spot (nothing recorded). A second scan of the same checkpoint in the patrol is refused locally ("already scanned"). A label not on the site's list is still recorded with an honest notice; the server's verdict (`wrong_site`, `checkpoint_revoked`, `revoked_label`, `unknown_checkpoint`, `tampered_signature`, …) is then shown in plain words. |
| Photos | Only from S4's camera (`takePictureAsync`, `exif: false`). No image picker, no photo-library permission, no "scan from image". Then `patrolImage.ts`: magic-byte check (JPEG / HEIC / PNG / WebP accepted as camera output, anything else refused), **always** re-encoded to JPEG by `expo-image-manipulator` (2048 px long edge, quality 0.7; a second, smaller attempt if over the cap), every metadata segment removed (APP1–APP15 except an ICC colour profile, and COM — so no EXIF/XMP/GPS), must start `FF D8 FF`, ≤ 10 MiB (backend default), SHA-256 of the final bytes as 64 lowercase hex (the backend DTO format; the server derives `x-amz-checksum-sha256` itself), written to the private folder and **read back and re-hashed** (a mismatch is a write failure, nothing queued). Low storage (< 50 MB free) refuses a new photo with a clear message. |
| Exceptions | "Can't reach it" on a checkpoint, with a reason. Kept on the phone and sent **inside the completion** (`exceptionReason`) — the backend's Guard API for it; the patrol is then recorded as `incomplete` with the reason (P1-B raises the exception). Completing with a required checkpoint neither scanned nor explained asks for a reason first. |
| Completion | A review (checkpoints scanned / expected, photos taken / expected, missing ones with reasons) and, after confirming, a confirmation screen with status, device and server-receipt times and what is still waiting to send. |
| States | `Waiting to send`, `In progress`, `Incomplete`, `Completed — awaiting verification`, `Verified`, `Closed by S4`, `Not sent`. **Verified only when the server's run says `verificationStatus = 'verified'`** — never because the phone sent everything. |
| Times | Device times are captured at the action and stored; `sentAtDevice` is added at each send (the server measures drift). Server receipt times are shown once known. |
| Location | None. Nothing in Patrols imports `expo-location`; no request body carries a location field (the backend refuses them with `PATROL_LOCATION_VERIFICATION_DISABLED`); no background location anywhere (static checks). |

## The offline outbox

`src/components/guard/patrol/patrolOutbox.ts` (pure engine) + `patrolOutboxSql.ts` (SQLite statements) +
`src/services/patrolNative.ts` (expo-sqlite / file-system / image-manipulator / crypto adapters) +
`src/services/patrolSync.ts` (one engine per signed-in Guard, wiring and triggers).

* **Rows**: table `patrol_outbox` in `s4-patrol-outbox.db` (expo-sqlite's private database directory), primary key
  `(owner_user_id, id)`; columns company, shift, client run id, sequence, kind, status, JSON data, updated at.
  Kinds: `start`, `scan`, `photo` (stages `intent` → `put` → `complete`), `exception` (local, carried by the
  completion), `complete`. Each row keeps its client id, body, device time, attempts, next retry time, last error code
  and message, and the server's answer (ids, verdicts, receipt times).
* **Order**: per patrol, start → scans in order → completion, strictly. A photo waits only for what it belongs to (the
  start, or its scan — `visitId` is resolved from the scan's server id) and never holds up the patrol. A step whose
  prerequisite was refused settles with the same outcome.
* **Retry**: exponential backoff 5 s doubling to a 2-minute cap, scaled by a random 0.5–1.0 (jitter); single-flight
  (one pass at a time, one follow-up pass when asked during one); a connection failure ends the pass. Triggers: app
  start, foreground, after every Guard action and "eager" (a waiting step is tried once at once), plus a timer at the
  next retry time. There is no network listener and no background task; the 2-minute cap bounds how long a regained
  connection waits while the app is open.
* **Idempotency**: every replay uses the same client id; a lost answer or a duplicate send is harmless (the server
  returns the stored row). `409 PATROL_IDEMPOTENCY_CONFLICT` is a permanent error, surfaced, never retried.
* **Upload**: intent (`POST /patrols/runs/:id/evidence`) → PUT of the file's exact bytes to the presigned URL with
  exactly the returned headers (`FileSystem.uploadAsync`, binary, no S4 Authorization header) → `POST
  /patrols/evidence/:id/complete`. The presigned URL is used once and never stored or logged. `409
  PATROL_EVIDENCE_NOT_UPLOADED` → back to a fresh intent (the server's replay issues a new URL) and PUT again; `503`
  (storage unavailable) and other 5xx/429 → backoff; a 400 from storage (checksum/length mismatch) → permanent
  (`STORAGE_REJECTED_UPLOAD`); `rejected` from the server → permanent, shown. The local file is deleted only when the
  server says `verified`.
* **Session**: requests go through the app's existing `request()` (shared refresh). A 401 after a failed renewal
  pauses the **whole** queue (not counted as an attempt, nothing dropped) until the Guard signs in again; the existing
  unauthorized handler signs the Guard out. A temporarily failed renewal (503) is a transient error.
* **Post-shift**: the queue keeps sending after Book Off; the server decides (P1-B: accepted and flagged for 24 h — the
  policy's `postShiftSyncHours` — after Book Off; replays always accepted).

### Outcomes and local retention (decided here)

| Outcome | When | Local retention |
| --- | --- | --- |
| pending | not yet accepted | **never expires** — kept through restarts, Book Off, sign-out, until sent or refused |
| done | the server accepted it (a photo: the server **verified** it) | the row 7 days (on-phone history); a photo file is deleted at verification |
| refused | `PATROL_SYNC_WINDOW_CLOSED`, `PATROL_SYNC_NOT_BOOKED_ON`, `PATROL_SHIFT_NOT_IN_PROGRESS` | row **and photo** kept **14 days after the refusal**, shown as "Could not be sent — contact your control room", then removed. Recovery beyond the window is issue #68 (owner-approved design, not built). |
| failed | any other permanent answer (409 payload mismatch, rejected photo, 404 …) | as refused |

Queued evidence is **never** discarded on sign-out or Book Off: neither the sign-out path nor the session store touches
the outbox (asserted by the spec).

### Shared phones (isolation)

* The engine is built for one signed-in user and reads, sends and deletes only that user's rows — the SQL filters on
  `owner_user_id`, and the engine re-checks every row's owner, so even a misbehaving store could not make it send
  another Guard's data.
* Evidence files live in `<document directory>/patrol-evidence/u<userId>/` (app-private, not the cache the OS may purge,
  not shared storage or the photo library). Only paths inside the signed-in user's folder are read, uploaded or deleted.
* When Guard B signs in on Guard A's phone, B sees and sends nothing of A's; A's data stays dormant and is sent when A
  signs in again.
* **What Guard B sees.** Nothing of Guard A's: no item, count, photo or "not sent" notice. B's own patrols go into the
  same database under B's id and B's own folder `patrol-evidence/u<B>/`; B's queue sends only B's rows, B's retention
  prune removes only B's rows, and B cannot enqueue, upload or delete a file outside B's folder.
* **A's dormant items.** While B (or nobody) is signed in, A's pending rows and photos stay untouched in the database and
  in `patrol-evidence/u<A>/` — through app restarts, B's whole session and the temporary-file sweep (which never touches
  `patrol-evidence/` and never removes a file any row references). Nothing on the phone sends them.
* **How A recovers.** A signs in again **on the same phone**: A's queue resumes and sends everything in order, from A's
  own folder. The server still applies the post-shift rules (P1-B: accepted and flagged for 24 h after Book Off; later
  writes are refused, kept and shown as "Could not be sent — contact your control room"). If A cannot sign in on that
  phone in time, the recovery path is the control room / issue #68 — the data cannot be moved to another phone.
* **Uninstall, "Clear storage" or a device reset loses unsent patrol evidence.** It is deliberately **not** in any
  device backup or device-to-device transfer (below), so restoring a backup or moving to a new phone does not bring it
  back. Guards should send everything (stay signed in with a connection) before handing a phone in; anything lost this
  way goes to the control room / #68.
* Certified by `scripts/guard-patrols.spec.cjs` GPAT-07 (B cannot read, send or delete A's items) and GPAT-20 (both
  Guards with pending work in one real SQLite database: B sends only B's, A's survives B's session, a restart and the
  sweep, and A recovers everything by signing back in).
* **Not encrypted at the application level.** The files and the database sit in the app sandbox, which iOS protects
  with Data Protection and Android with file-based encryption of app-private storage; another app cannot read them.
  Another S4 user on the same phone is kept out by the per-user namespace, not by cryptography. Application-level
  encryption (e.g. SQLCipher via expo-sqlite and per-user keys in SecureStore) was not added: a lost key would make
  queued evidence unrecoverable, which conflicts with "never lose evidence". Recorded as a risk for the owner.

### Backups and device transfer (S4 1.2.0 hardening, owner-mandated)

Queued patrol evidence (`<files | Documents>/patrol-evidence/`) and the outbox database (expo-sqlite 16's
`defaultDatabaseDirectory`: Android `filesDir/SQLite/s4-patrol-outbox.db` with its `-wal` / `-shm` / `-journal`, iOS
`Documents/SQLite/…`) are **never** copied off the phone by a backup or a device transfer. No encryption is added.
Implemented by the local config plugin `security-mobile-app/plugins/withPatrolBackupExclusion.js`:

* **Android (Auto Backup ≤ 11 and Android 12+ cloud backup and device-to-device transfer).** The application points at
  S4's own `@xml/s4_backup_rules` (`android:fullBackupContent`) and `@xml/s4_data_extraction_rules`
  (`android:dataExtractionRules`, both `<cloud-backup>` and `<device-transfer>`). They are an **allow-list**: shared
  preferences, minus expo-secure-store's `SecureStore` file — exactly expo-secure-store's own rules, which were in force
  before. Once a rules file has an `<include>`, Android backs up nothing else, so no `file`, `database`, `root` or
  external path — and therefore neither `patrol-evidence/` nor `SQLite/` — is ever backed up or transferred.
  expo-secure-store is configured with `configureAndroidBackup: false` so the two plugins do not compete for the
  manifest attributes (its exclusion is carried in S4's file instead). Explicit `<exclude>` lines for the patrol paths
  were deliberately not added: an exclude outside an included path is an Android lint error (`FullBackupContent`) that
  can fail a release build, and it adds nothing to an allow-list.
* **Why not `android:allowBackup="false"`.** It would also be safe for patrols, but it changes what the rest of the app
  backs up (the shared preferences that are backed up today). The allow-list keeps everything else exactly as before;
  sign-in tokens are in SecureStore and were never backed up either way. `allowBackup` stays `true`.
* **iOS.** Neither expo-file-system 19 nor expo-sqlite 16 exposes `NSURLIsExcludedFromBackupKey`, and moving the data
  to `Library/Caches` is not acceptable (the OS may purge it). The plugin adds a reviewed Swift function to
  `AppDelegate.swift`, called first in `application(_:didFinishLaunchingWithOptions:)` (before any JavaScript): it
  creates `Documents/patrol-evidence` and `Documents/SQLite` if missing and sets `isExcludedFromBackup = true` on both,
  which excludes the directories and everything in them from iCloud and computer backups. It runs on every launch, so a
  directory recreated later is covered again at the next start. A changed Expo template fails the prebuild loudly
  instead of shipping without it.
* **Verified.** Android: `npx expo prebuild --no-install --platform android` into a throw-away copy (store and
  `APP_VARIANT=uat`) — the merged `<application>` carries `android:allowBackup="true"`,
  `android:fullBackupContent="@xml/s4_backup_rules"`, `android:dataExtractionRules="@xml/s4_data_extraction_rules"`,
  and both rules files are generated as above. iOS prebuild cannot run on Windows: the Swift change is certified
  against the SDK 54 template `AppDelegate.swift` (`expo-template-bare-minimum` 54.0.54, kept as
  `scripts/fixtures/…`), and `expo config --type introspect` confirms the Info.plist side (bundle id, 1.2.0 / 20, camera
  string only). Static spec: GPAT-21. **Still to check on the first device build:** `xcodebuild` compiles the snippet
  (EAS), and on a device the evidence folder is absent from an iCloud backup / `adb shell bmgr` backup.
* **Consequence (accepted):** uninstall, "Clear storage", a device reset or a move to a new phone loses any patrol
  evidence that was not yet sent; recovery is the control room / #68.

### Stale temporary camera files

`src/components/guard/patrol/patrolTempCleanup.ts` (pure) + `src/services/patrolTempNative.ts` (device). A patrol
photo passes through the camera's capture (`<cache>/Camera/`) and the re-encoded JPEG (`<cache>/ImageManipulator/`),
both removed in `processCapturedPhoto`'s `finally`; an app killed mid-photo can leave them (possibly with EXIF). When a
Guard's queue starts, and then at most every 10 minutes before a sync pass, files **directly inside those two cache
folders** that were last modified **more than 1 hour ago** and are **not referenced by any outbox row of any Guard** are
deleted. Never anything under `patrol-evidence/`; a file whose age cannot be read is kept; if the outbox cannot be read
nothing is removed; a failed delete is ignored. `patrolNative.ts` still never touches the cache. Certified by GPAT-19.

## Backend change (minimal, no migration)

`GET /patrols/mine/plan` gained `windows`: every active schedule's window overlapping the shift (start → end), computed
by `windowsBetween` — the sweep's own site-local engine — each with `windowKey`, `scheduleId`, `scheduleName`,
`routeId`, `localDate`, `start`, `end` and `covered` (a run is already recorded for that window and the policy's scope;
no Guard or run is named). At most 200, earliest first. No new route, no new permission, no schema change. Certified by
`scripts/patrol-schedule.spec.ts` PS-G02.

No other backend change: start, scans, completion with `exceptionReason`, evidence intent / complete, `sentAtDevice`,
the post-shift rules and refusals are the P1-A/B/C APIs as they are.

## Native dependencies (Expo SDK 54 pins, `npx expo install`)

`expo-camera ~17.0.10`, `expo-sqlite ~16.0.10`, `expo-file-system ~19.0.24` (already in the tree as an Expo dependency,
now direct), `expo-image-manipulator ~14.0.8`, `expo-crypto ~15.0.9`. None adds a privacy-manifest API category the app
does not already declare.

## Configuration

* `app.json` plugin `expo-camera` with `cameraPermission` = "S4 uses the camera only while you patrol, to scan
  checkpoint QR labels and take patrol photos inside S4. Patrol photos are not saved to your photo library and carry no
  location.", `microphonePermission: false` (no microphone string), `recordAudioAndroid: false`.
* Android: `CAMERA` added to `permissions` and removed from `blockedPermissions`; `RECORD_AUDIO` (declared by the
  camera library's manifest) stays blocked, as do background location, foreground services, external storage and
  overlay. A local `expo prebuild` of the Android project confirmed the merged manifest: CAMERA present, RECORD_AUDIO
  removed, `applicationId 'com.sfour.s4'`, versionCode 17, versionName 1.1.0.
* iOS: the resolved config (`expo config --type introspect`) has `NSCameraUsageDescription` = the string above, no
  microphone or photo-library string, bundle id `com.sfour.s4`, build 16, entitlements unchanged (push production only).
  iOS prebuild cannot run on Windows.
* **Unchanged**: app identity (`com.sfour.s4`), name, scheme, version 1.1.0 / versionCode 17 / buildNumber 16, EAS
  project, profiles, channels (none), `updates.enabled: false`, no `runtimeVersion`, signing inputs.
* `store-identity.spec.cjs` was updated for the deliberate change (STORE-04 now expects CAMERA; new STORE-13 certifies
  the camera configuration; STORE-12 also checks the resolved purpose strings and Android permissions).

## Release note for the owner

The live Guard app line is **1.1.2** on `release-prep/guard-app-1.1.2` (PR #59; Android 20 distributed, iOS 19
uploaded). `feature/patrols-p1e` itself kept 1.1.0 / 17 / 16. The combined branch is `integration/s4-1.2.0-patrols`:
P1-E merged with the 1.1.2 line, prepared as **S4 1.2.0 — Android versionCode 21, iOS build 20, UAT Android 22** (not
built), with the backup exclusion and temporary-file sweep above. The version lines in "Configuration" describe P1-E as
first certified; on the integration branch the expected values are 1.2.0 / 21 / 20 (GPAT-16, store-identity,
pilot-build-provenance, signer-provenance, uat-variant).
