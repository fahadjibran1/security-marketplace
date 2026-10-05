# S4 Android RC14 — certification record

Status: **PENDING BUILD.** Prepared for Google Play Internal Testing. Not built, not uploaded.

## 1. Purpose

S4 1.1.0, Android versionCode 14 (`com.sfour.s4`) is the Android candidate for **Google Play Internal Testing**. It is built from the release baseline that is live on the web, so it includes Dashboard Operations V2.

## 2. Decision: versionCode 13 retired from intended upload

| | Previous candidate | RC14 |
| --- | --- | --- |
| App / version | S4 1.1.0 | S4 1.1.0 |
| Android versionCode | 13 | 14 |
| Package | `com.sfour.s4` | `com.sfour.s4` |
| Source | `6cf29c8` | the RC14 preparation commit on `35a6230` (`release/s4-pilot-rc1`) |
| Dashboard Operations V2 | **not included** | included (`ec100a9`..`bf1212d`) |
| EAS build | `545b6ed6-78ca-43ce-9689-b11f0e34e7ad` | (after build) |
| AAB SHA-256 | `955fd091465ab7cac189179d1e99149a13a9146bb74207bb6272ff0e6e020f86` | (after build) |
| Status | certified, **retired**: kept as a historical artefact, not intended for Play upload | pending build; intended for Internal Testing |

The versionCode 13 certification is unchanged. It moves to `retiredArtefacts` in `security-mobile-app/release/android-signing.json` with its original build ID, commit, hash, signer and certification date intact. Only its status changes (`certified-retired`), and the reason is recorded.

## 3. What changes for RC14

- `app.json` `android.versionCode`: 13 → **14**.
- Unchanged: version 1.1.0, iOS `buildNumber` 13 (iOS has its own counter and 13 has never been built), app name, package and bundle IDs, API URL, OTA (disabled), permissions, privacy wording, features, backend, migrations.
- `release/android-signing.json`:
  - `expectedRelease.versionCode` is set to 14;
  - `approvedArtefact` is a `pending-build` record for 14;
  - versionCode 13 moves to `retiredArtefacts`.
- The release specs (store identity, build provenance, signer provenance) are re-pinned to 14. A new check confirms the retired 13 record is kept exactly.

## 4. Signing

The approved permanent upload key (local credentials, EAS production profile, `credentialsSource: local`) is used unchanged.

| Certificate | Value |
| --- | --- |
| Pinned upload certificate SHA-256 | `0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b` |
| SHA-1 | `45a530aa1681f2da1e3b0568d982f492eeedb75e` |
| Subject | `CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB` |

## 5. Build, signer and provenance results

To be recorded after the build: EAS build ID, AAB SHA-256, the upload signer read from the AAB, and package and version from the bundle manifest.

## 6. Status

- Google Play: **NOT UPLOADED.** No Play app, release, testers or Play App Signing changes.
- Web: already live separately from `35a6230` (Vercel `dpl_4X2cAerbj2mNY5A6uuh4AHFQA8us`). RC14 does not redeploy the web.
- iOS: not built; build 13 unchanged; no Apple credentials.
- Backend unchanged; 61 migrations; no Migration 62.
