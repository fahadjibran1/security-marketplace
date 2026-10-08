# S4 iOS TestFlight build 1.1.0 (13) — certification record

Status: **CERTIFIED — awaiting owner approval to submit to TestFlight. NOT SUBMITTED.**

## 1. The artefact

| Item | Value |
| --- | --- |
| App / version / build | S4 · 1.1.0 · **13** |
| Bundle ID | `com.sfour.s4`: the **new** App Store Connect app "S4" (SKU `s4-ios-001`), not the legacy "S4 Security" (`com.securitymarketplace.mobile`) |
| Source commit (used by EAS) | **`876712819a9c889923de7734146b990720258866`** on `release/s4-pilot-rc1` (`35a6230` + the two Android RC14 commits). Clean tree; no iOS-specific code or configuration change was needed. |
| EAS build | **`fa7c7560-f734-4bbe-a86e-5224811f624c`**: profile `production`, distribution `STORE`, SDK 54, not a simulator build, completed 2026-10-08 18:10 UTC |
| File | `s4-ios-1.1.0-b13-fa7c7560.ipa` (owner artefact folder `S4-backups/artifacts`), 9,327,185 bytes |
| IPA SHA-256 | **`95a6881ce92a00bedc2b45f620021c1a0701482672806a016f304ef50ac0e7ca`** |

This record was committed after the build. The IPA's source is `8767128`, not the documentation commit.

## 2. Signing

- **Credentials:** EAS-managed (remote), set up interactively by the owner with `eas credentials`. The existing Apple Distribution certificate was reused and a new App Store provisioning profile created. Nothing was revoked or replaced.
- **Apple team:** `SXH4TLU2B5` (Individual membership, fahad jibran). The conversion to an organisation (Vesoft Services Limited) is still pending with Apple; proceeding on Individual is the owner's decision.
- **Profile:** `*[expo] com.sfour.s4 AppStore 2026-10-08T18:00:31.293Z`, App ID name "S4", application identifier `SXH4TLU2B5.com.sfour.s4`. App Store distribution (no device list). Expires 2027-06-17.
- **Signing certificate:** SHA-256 of the DER certificate in the profile is `c1f9c5b6c04f4f37939ade278960a16870c88afd2efca94a75b570aab5830196`. That same certificate is present in the app binary's code signature.

## 3. Certification evidence (from the IPA itself)

| Check | Evidence | Result |
| --- | --- | --- |
| Identity | `S4.app/Info.plist` | display name S4, `com.sfour.s4`, `CFBundleShortVersionString` 1.1.0, `CFBundleVersion` 13, minimum iOS 15.1, iPhone and iPad, `iphoneos` |
| Export compliance | Info.plist | `ITSAppUsesNonExemptEncryption` = false |
| Purpose strings | Info.plist | only `NSLocationWhenInUseUsageDescription` (the honest Book On wording). No Always or background location, background modes, tracking, Face ID, camera, photos, microphone or contacts. |
| OTA | Info.plist | no Expo Updates keys (updates disabled) |
| Not a debug / development build | provisioning profile | `get-task-allow` false; App Store profile |
| Capabilities | profile entitlements | only `application-identifier`, team identifier, `keychain-access-groups`, `get-task-allow` (false) and `beta-reports-active` (TestFlight). No push, iCloud, associated domains or other capabilities. |
| Development client | app binary and frameworks | no dev-launcher controller and no dev-menu implementation; frameworks are React, ReactNativeDependencies and Hermes only. The binary contains the always-linked `EXDevMenuInterface` protocol stubs and registers an `exp+security-marketplace` URL scheme from the installed `expo-dev-client` package. Both are inert in a release build. |
| Privacy manifest | `PrivacyInfo.xcprivacy` | tracking false; no tracking domains; no collected data types declared; required-reason APIs UserDefaults (CA92.1), FileTimestamp (0A2A.1/3B52.1/C617.1), DiskSpace (E174.1/85F4.1), SystemBootTime (35F9.1) |
| Dashboard V2 | `main.jsbundle` (Hermes) | V2-only text present: "items in Live Operations", "SOS active", "Needs cover", "The next shifts, unassigned ones first.", "Guard document and certification status." |
| Production API | `main.jsbundle` | `https://security-marketplace-api.onrender.com` present; staging API absent |

The App Store privacy *questionnaire* in App Store Connect is a separate owner step (see `S4_APPLE_PRIVACY_WORKSHEET.md`). The bundled privacy manifest above is not that questionnaire.

## 4. Release gate (at `8767128`)

- Typecheck, `npm run build`, `expo install --check` and `expo config` (public and plugin-applied): pass.
- Spec suite: **51 / 55 files pass, 1,715 checks.** Dashboard V2 37/37.
- iOS production export: pass. Contains Dashboard V2 and the production API.
- Secret scan: clean. The only pattern hits are release-document statements that no private key is stored.
- Known stale failures, identical to pristine `3b7cc44`: `guard-personnel-p1a`, `guard-personnel-p1gb`, `phys007-screening-remediation`, `post-phys007-uat-remediation`.

## 5. Unchanged

- Android: versionCode 14, signing and the Play Internal Testing release are untouched.
- Backend: unchanged since `6cf29c8`; 61 migrations; no Migration 62; no production writes.
- Web: not deployed (app.sfour.co.uk stays on `35a6230`).

## 6. Status

- TestFlight / App Store Connect: **NOT SUBMITTED.**
- Submission target when approved: the App Store Connect app with bundle ID `com.sfour.s4`.
