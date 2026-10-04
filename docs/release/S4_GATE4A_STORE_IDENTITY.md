# S4 Gate 4A — permanent identity and Android store-candidate source

Status: SOURCE PREPARED. Nothing built, uploaded or submitted. No Play Console app exists yet.

## Identity

| | Development era (Build 12 and earlier) | Permanent (from 1.1.0) |
|---|---|---|
| Display name | S4 Security | **S4** |
| Android package | com.securitymarketplace.mobile | **com.sfour.s4** |
| iOS bundle id | com.securitymarketplace.mobile | **com.sfour.s4** |
| URL scheme | securitymarketplace | **s4security** |
| Version / versionCode / iOS build | 1.0.7 / 12 / 12 | **1.1.0 / 13 / 13** |

Guard, Company, Client and Platform Admin are workspaces inside the one S4 app, never product names.

Kept internally on purpose (never shown to a user): EAS project `c786f15c-7d60-4122-9001-02cabbb7692b`
and its slug `security-marketplace` (a new package does not need a new EAS project, and a second project
would split build history and credentials); the API host `security-marketplace-api.onrender.com`
(renaming it is backend/DNS work); the repository name; the signing certificate subject
`CN=S4 Security` (a certificate's subject cannot change without a new key, and Play shows the developer
name, not the certificate). The `exp+security-marketplace` scheme in the generated manifest is added by
expo-dev-client for development builds; it launches nothing extra in a release build.

## Build 12 retirement

`com.securitymarketplace.mobile` and `com.sfour.s4` are **different Android applications**. Build 12
cannot update to 1.1.0, both can be installed side by side, and nothing — sign-in, SecureStore, local
state — transfers between them.

Operational rule, once S4 1.1.0 is approved on Google Play Internal Testing:

1. Build 12 (`com.securitymarketplace.mobile`, EAS `fcd24b02-…`) is the final development-package build.
2. Pilot devices uninstall Build 12.
3. They install **S4** from the Internal Testing link and sign in fresh.
4. No session or local data is expected to carry over; all S4 data lives on the server.

Do not distribute any further `com.securitymarketplace.mobile` build.

## Version and update strategy

- 1.1.0 / 13 is deliberately monotonic with the old package: every S4 artefact ever made has a distinct,
  increasing build number, so a support conversation can never confuse two builds.
- Future releases: bump `version` (semver) and `android.versionCode` / `ios.buildNumber` together, by
  hand, in `app.json` (`appVersionSource: local`). The store profile has **no** `autoIncrement`: with a
  local version source it would rewrite `app.json` during the build and ship an uncertified number.
- OTA updates are **disabled** (`updates.enabled: false`, no `runtimeVersion`, no channel). Every change
  ships as a new store build. Nothing was published over the air in Gate 4A.

## Signing

- Permanent S4 certificate SHA-256 `0d589449…c76311b` (full value in `release/android-signing.json`).
  An Android signing key is not tied to a package, so the same key signs `com.sfour.s4`.
- Keystore and `credentials.json` stay outside Git (`*.jks`, `credentials.json` ignored).
- The store profile signs Android builds with the **local** S4 key (`credentialsSource: local`). Left on
  the EAS default, a new package would get an EAS-generated key — the Build 8 failure again.
- **Backup: NOT CONFIRMED.** Two identical plaintext copies exist on one workstation
  (`~/.s4-pilot-secrets/` and `~/Downloads/`). There is no encrypted, offline or second-location backup.
  **BLOCKER BEFORE FIRST PLAY UPLOAD:** make an encrypted backup (password manager / encrypted archive on
  separate offline media), store the keystore passwords separately from it, then remove the stray copy
  from `Downloads`.

## Google Play App Signing — recommendation (executed in Gate 4B)

Enrol with **a Google-generated app signing key**, and use the **existing permanent S4 key as the upload
key**.

- `com.sfour.s4` has no installed base anywhere, so nothing requires the app-signing key to be the old
  certificate. A Google-held key is protected by Google's infrastructure and supports key upgrade.
- If the upload key is ever lost or compromised it can be reset through Play support; an app-signing key
  that only exists on one PC cannot. (That does not remove the backup blocker above.)
- Consequence: copies installed from Play are signed by Google's certificate, so a locally signed APK of
  `com.sfour.s4` cannot update a Play install. Rule: **`com.sfour.s4` is distributed only through Google
  Play** (Internal Testing, then production). The `pilot` APK profile is for the legacy package only.
- After enrolment, record the Play app-signing certificate in `release/android-signing.json`
  (`playAppSigning.appSigningCertificateSha256`, currently `null`).
- Alternative, only if side-loaded APKs must interoperate with Play installs: upload the existing key as
  the app-signing key and create a new upload key. Not recommended.

Verify every AAB before upload: `npm run verify:apk-signer -- path/to/app.aab` (checks the upload
certificate via `keytool`; package and version come from the EAS build record).

## Android technical configuration (from `expo prebuild`, not a build)

| | |
|---|---|
| package / applicationId | com.sfour.s4 |
| versionName / versionCode | 1.1.0 / 13 |
| minSdk / targetSdk / compileSdk | 24 / 36 / 36 (React Native 0.81 defaults). Play requires target 36 for new apps from 31 Aug 2026 — met. |
| Release permissions | INTERNET, VIBRATE (template), ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION |
| Removed from the merged manifest | ACCESS_BACKGROUND_LOCATION, FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION, READ/WRITE_EXTERNAL_STORAGE, SYSTEM_ALERT_WINDOW, RECORD_AUDIO, CAMERA |
| Exported components | MainActivity only (launcher + `s4security` / dev-client VIEW filters) |
| Cleartext traffic | allowed only in the debug manifests; release uses the platform default (HTTPS only, target ≥ 28) |
| Backup | `allowBackup` true with expo-secure-store's backup and data-extraction rules, which exclude SecureStore (the sign-in token is never backed up) |
| Orientation | portrait |

## Location

The app asks for **foreground** location only, only when a Guard Books On at a site that requires
location verification (the server's GPS-required refusal triggers it), takes one reading, and sends it
with that Book On. It does not track continuously and never requests background location. Permission copy:
"S4 uses your location only when you Book On at a site that requires location verification, to confirm
you are at that site. S4 does not track your location in the background."

## iOS (prepared, not built)

`bundleIdentifier com.sfour.s4`, `buildNumber 13`, display name S4, scheme `s4security`, export
compliance `false`, location usage string from the plugin above, no background-location or other usage
strings. Remaining for the iOS track: Apple Developer organisation account, App ID registration,
certificates/provisioning (EAS-managed), App Store Connect app record, privacy nutrition label, reviewer
account, screenshots.

## Store asset inventory

| Asset | State |
|---|---|
| App icon (512 for Play, from `assets/branding/s4-app-icon-1024.png`) | READY — note a faint dark residue above-right of the symbol in the brand master; owner may want a cleaner master before the public listing |
| Adaptive icon, splash, favicon | READY (approved S4 glyph) |
| Feature graphic (1024×500) | NEEDS CREATION |
| Phone screenshots | NEEDS CREATION — from the real app, not fabricated |
| Tablet screenshots | NEEDS CREATION only if tablets are declared |
| Short / full description | NEEDS CREATION, then OWNER REVIEW |
| Privacy policy URL | NEEDS LEGAL/OWNER REVIEW — current `sfour.co.uk/privacy` is PatrolSafe's |
| Support URL / contact email | NEEDS OWNER CONFIRMATION (`support@sfour.co.uk` is published on the website; mailbox not confirmed) |
| Account-deletion URL | NEEDS CREATION in `s4-website` (`docs/gate2/S4_ACCOUNT_DELETION_PAGE_SPEC.md`) |

## Carry-forward (not resolved here)

S4 Privacy Policy and S4 Terms need publishing and review; `/account-deletion` belongs in `s4-website`;
Sentry stays disabled; retention periods are owner/legal decisions; Render region is Oregon (US West);
production account-deletion UAT is deferred; the signing-key backup is unconfirmed.

## Gate 4B prerequisites

1. **Signing-key backup confirmed** (encrypted, offline, passwords stored separately). Blocker.
2. Google Play developer account as an **organisation**: Vesoft Services Limited (D-U-N-S, verified
   organisation details, developer contact email and phone).
3. Create the Play app `com.sfour.s4`, name S4; enrol in Play App Signing as recommended above; record
   the app-signing certificate.
4. Production AAB: `eas build --platform android --profile production` with `credentialsSource: local`
   and `credentials.json` present on the build machine; verify with `verify:apk-signer -- app.aab`;
   record build id, commit and SHA-256 in `release/android-signing.json`.
5. Internal Testing track and tester list (email list or Google Group).
6. Store listing minimums: app name, short and full description, 512 icon, feature graphic, at least two
   phone screenshots, category, contact email.
7. Data Safety form, from `docs/gate2/S4_PRIVACY_POLICY_DRAFTING_PACK.md` (location, personal info,
   app activity, data encrypted in transit, account deletion supported).
8. App Access: a reviewer account and written instructions. A reviewer cannot self-register usefully
   without an SIA licence, so provide a dedicated reviewer login on a real company workspace.
9. Published privacy-policy URL and account-deletion URL (both required for an app with accounts).
10. Content rating questionnaire, target audience (adults), ads declaration (none).
