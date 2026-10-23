# S4 Live Shift Amendments — device UAT checklist (S4 UAT app on staging)

Run on the **S4 UAT** app (`com.sfour.s4.uat`, amber icon, "UAT · STAGING" label), installed **alongside** the pilot
S4 app. Never on the pilot app, never against production. Fictional UAT accounts only (owner, Guard Alpha, Guard
Bravo); the company side is the staging web app signed in as the fictional owner.

Before each session: the tester's UAT Guard has a live, booked-on shift created by the coordinator on staging; note
the staging time and the shift's scheduled end.

Devices: one small phone (≈ 320–360 pt / 5"), one large phone (≈ 430 pt / 6.7"), Android 15 and iOS current.
Record for every case: device, OS, app build, time, PASS/FAIL, screenshot, and anything surprising.

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | Request appears on Home | Company proposes +1 h. On the phone, wait up to one minute with the app open (or background and reopen). | Card "Your company is asking you to stay later" at the top of Home: original end, current end, "Asked to stay until" (+1 hour), reason, "Answer by". The note says requests appear when the app refreshes and that S4 sends no instant alert. |
| 2a | Accept | Tap **Accept extension** → **Yes, accept**. | "Sending…", then "You accepted the extension". The shift card's end changes only after this. The company drawer shows "Accepted by the Guard in the app". |
| 2b | Decline | New proposal; **Decline** → **Yes, decline**. | "You declined the extension"; end unchanged on phone and company side. |
| 3 | Double-tap | Tap **Yes, accept** rapidly 3–5 times. | One acceptance: company history shows one "Accepted" entry; shift end moved once. |
| 4 | Airplane mode and retry | New proposal; airplane mode on; **Yes, accept**. | "No connection to S4. Your answer was not sent…"; the end is unchanged. Airplane mode off, tap **Yes, accept** again → accepted once. |
| 5 | Withdrawn while backgrounded | New proposal; background the app; company withdraws; reopen. | Within seconds of reopening: "Your company withdrew the extension request … did not change". Tapping old buttons is impossible. |
| 6 | Expiry while open | Coordinator creates a shift ending in ~3 minutes and proposes; leave the app open past the end. | Within a minute after the end: "The extension request expired … did not change". If **Accept** was tapped at the deadline: "This request has expired. Your shift end has not changed." |
| 7 | Management approval required | Company proposes an extension making the shift over the approval threshold (e.g. > 14 h). | Phone: "Extension request — waiting for management approval", no Accept/Decline, warnings with figures. After the company approves: Accept/Decline appear on the next refresh. |
| 8 | Verbal agreement and dispute | Company records a verbal agreement. On the phone: **I did not agree — dispute**, enter a reason, **Send dispute**. | Card says "Extension recorded by your company … You did not accept this in the app" (badge "Recorded by company"). After dispute: "You disputed this extension — waiting for review"; company drawer shows the dispute and a **Review dispute** action for Owner/Admin. |
| 9 | Welfare continues after acceptance | Shift with Welfare Checks; accept +1 h; stay booked on past the original end. | Welfare Check windows continue to the new end; no Missing Book Off alert at the original end; one at the new end + 15 min if not booked off. |
| 10 | Book On / Book Off regression | Book On to a fresh shift; Book Off (with the existing confirmation). Repeat on a shift that had an extension. | Unchanged behaviour: confirmations, timings and the shift card exactly as in 1.1.0. |
| 11 | Android back and keyboard | Open the dispute form, type with the keyboard up; press Android back. | Field and **Send dispute** stay above the keyboard; back closes the keyboard first and never submits. |
| 12 | Small and large screens | Repeat 1, 7 and 8 on both phones, portrait. | Nothing clipped or overlapping; labels stack above values on the small phone; buttons reachable. |
| 13 | Company dashboard reflects answers | After each of 2a, 2b, 5, 8: open the company Live Operations shift → **Shift extension**. | Status, Guard answer and history match the phone within one board refresh. |
| 14 | No duplicates | After the session the coordinator runs the read-only staging check. | Per shift: one attendance Book On / Book Off; one amendment per proposal; one audit entry per action; no duplicate Welfare or Missing Book Off alerts. |

Coordinator read-only checks (staging): `staging-baseline.cjs snapshot` before and after; `staging-guard-contract.cjs`
and `staging-web-contract.cjs` re-runnable at any time. Production is never touched.

## Build record — Android S4 UAT 1.1.0 (16) — 23 Oct 2026 (owner-approved)

| | |
|---|---|
| Source | `c41e129` (integration/uat-mobile-reconcile, draft PR #30; gates 39936143901 / 39936143895 success), clean worktree |
| EAS build | `5d758b92-4e22-4a9c-8146-713dac4b0356`, profile `uat`, internal distribution, FINISHED 10:51:44Z |
| Link | https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/5d758b92-4e22-4a9c-8146-713dac4b0356 |
| APK | `s4-uat-1.1.0-vc16-5d758b92.apk` (held in `~/.s4-pilot-secrets/artifacts`), 89,231,065 bytes, SHA-256 `d0d6592f39b7ba2ee03c73f5253109d5b07b33c03eabe20752ff1bafbcee8310` |
| Identity | `com.sfour.s4.uat`, label "S4 UAT", versionName 1.1.0, versionCode 16, minSdk 24, targetSdk 36, not debuggable |
| Signer | APK Signature Scheme v2, 1 signer, `CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB`, SHA-256 `0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b`, RSA 4096 (the permanent S4 key, as the store app and UAT 15) |
| API | embedded config `extra.apiBaseUrl` = staging, `appVariant: uat`, `updates.enabled: false`; build-time `EXPO_PUBLIC_API_URL` = staging (wins at runtime); the one production string in the bundle is the unused fallback constant |
| Contents | Live Shift Amendment Guard card present; "S4 UAT · STAGING" label present; no credentials, keystore or `.env` files |

Installs alongside the store app `com.sfour.s4` (different application id) and over UAT 1.1.0 (15). Not submitted,
published or distributed.

## iOS UAT — owner-operated steps (not started)

No device is registered on Apple team `SXH4TLU2B5` and no `com.sfour.s4.uat` App ID or ad hoc profile exists.
Ad hoc distribution installs only on registered iPhones.

1. Apple Developer account: if Apple shows a pending Program License Agreement, accept it at
   developer.apple.com/account (App ID and profile creation fail until it is accepted).
2. Register each test iPhone. In a terminal in `security-mobile-app` (or `! ` from Claude Code):
   `npx eas-cli device:create` → choose team `SXH4TLU2B5` → "Website" → open the link on each iPhone in **Safari**,
   allow the configuration profile, then Settings → General → VPN & Device Management → install. Check with
   `npx eas-cli device:list --apple-team-id SXH4TLU2B5`.
3. On each iPhone (iOS 16+): Settings → Privacy & Security → Developer Mode → On (restart when asked). Needed to
   open an ad hoc build.
4. Build (interactive Apple sign-in, from a clean checkout of the approved commit):
   `npx eas-cli build -p ios --profile uat` → sign in with the Apple ID (2FA) → let EAS create the App ID
   `com.sfour.s4.uat`, reuse the existing Apple Distribution certificate, and create an **ad hoc** provisioning profile
   containing the registered devices. Do not change the `com.sfour.s4` App Store profile.
5. Verify before distributing: bundle id `com.sfour.s4.uat`, display name "S4 UAT", embedded API = staging, profile
   type ad hoc, device list as expected. Adding an iPhone later needs `device:create` again and a rebuild (the
   profile is regenerated).
