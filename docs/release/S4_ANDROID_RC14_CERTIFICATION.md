# S4 Android RC14 — certification record

Status: **CERTIFIED — awaiting Google Play Internal Testing upload. NOT UPLOADED.**

## 1. Purpose

S4 1.1.0, Android versionCode 14 (`com.sfour.s4`) is the Android candidate for **Google Play Internal Testing**. It is built from the release baseline that is live on the web, so it includes Dashboard Operations V2.

## 2. The artefact

| Item | Value |
| --- | --- |
| App / version / versionCode | S4 · 1.1.0 · **14** |
| Package | `com.sfour.s4` |
| Source commit (pre-build, used by EAS) | **`e099c4e22fac3a2af32053b6870060bda4d9d5ef`**: `chore(release): prepare Android RC14`, on `35a6230`. Clean tree at build time. |
| EAS build | **`4b31e82d-7b36-4b76-8887-59c446527931`**: profile `production`, distribution `STORE`, SDK 54, completed 2026-10-05 22:08 UTC |
| Signing | Existing permanent upload key, `credentialsSource: local`. No EAS-generated or replacement credentials. |
| File | `s4-1.1.0-vc14-4b31e82d.aab` (owner artefact folder `S4-backups/artifacts`), 58,685,803 bytes |
| AAB SHA-256 | **`e07c4dc8dc33c9c66b8fe107296be69506b50681b6da9dec21008f39e23dde66`** |

This record was committed **after** the build. The AAB's source is `e099c4e`, not the documentation commit that follows it.

## 3. Certification evidence (from the artefact itself)

| Check | Evidence | Result |
| --- | --- | --- |
| Upload signer | `keytool -printcert -jarfile`, via `scripts/verify-apk-signer.cjs` | SHA-256 `0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b`, SHA-1 `45:A5:30:AA:…:B7:5E`, `CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB`. **Matches the pinned key.** |
| Package / version | `bundletool dump manifest` | `com.sfour.s4`, versionName `1.1.0`, versionCode `14`, minSdk 24, targetSdk 36 |
| Release build | manifest | no `android:debuggable`; no dev-launcher or dev-menu activities |
| Permissions | manifest, compared with the certified vc13 bundle | identical set: fine and coarse location (foreground), INTERNET, network state, biometric/fingerprint, vibrate |
| Only intended change | full manifest diff, vc13 → vc14 | the only difference is `versionCode` 13 → 14 |
| Dashboard V2 included | `base/assets/index.android.bundle` | V2-only copy present ("items in Live Operations", "SOS active", "Needs cover", "The next shifts, unassigned ones first."); none of it is in vc13 |
| Production API | JS bundle | `https://security-marketplace-api.onrender.com` |
| EAS record | `eas build:view` | `production`, appVersion 1.1.0, appBuildVersion 14, gitCommitHash `e099c4e…` |

Not claimed: byte-identity between the AAB's JS bundle and a local export. Different build machines produce different bytes.

## 4. Decision: versionCode 13 retired from intended upload

| | versionCode 13 (retired) | versionCode 14 (RC14) |
| --- | --- | --- |
| Source | `6cf29c8` | `e099c4e` (on `35a6230`) |
| Dashboard Operations V2 | **not included** | included |
| EAS build | `545b6ed6-78ca-43ce-9689-b11f0e34e7ad` | `4b31e82d-7b36-4b76-8887-59c446527931` |
| AAB SHA-256 | `955fd091465ab7cac189179d1e99149a13a9146bb74207bb6272ff0e6e020f86` | `e07c4dc8dc33c9c66b8fe107296be69506b50681b6da9dec21008f39e23dde66` |
| Status | certified, **retired**: historical, not intended for Play upload | **certified, intended for Internal Testing** |

The vc13 certification is preserved unchanged in `retiredArtefacts` (`security-mobile-app/release/android-signing.json`); only its status records the retirement. Its AAB file is kept, and its hash still matches.

## 5. Pre-build release gate (at `e099c4e`)

- Typecheck, `npm run build` and `expo install --check`: pass.
- `expo config`: S4 · 1.1.0 · 14 · `com.sfour.s4` · production API · OTA disabled.
- Spec suite: **51 / 55 files pass, 1,715 checks.** Dashboard V2 37/37; store identity, build provenance and signer provenance pass, re-pinned to 14.
- Android and web production exports: pass.
- Secret scan over `6cf29c8..e099c4e`: clean. The only pattern hit is the signing record's own statement that it holds no private key.

**Known stale failures (not caused by RC14).** These are identical, assertion by assertion, to pristine `3b7cc44`: `guard-personnel-p1a`, `guard-personnel-p1gb`, `phys007-screening-remediation`, `post-phys007-uat-remediation`. They must be repaired before the external pilot.

## 6. Unchanged

- Version 1.1.0; iOS build 13 (iOS has its own counter and has never been built at 13).
- Identifiers, app name, API, OTA, permissions and privacy wording.
- Backend: no change since `6cf29c8`; 61 migrations; no Migration 62.

## 7. Known pilot risk (recorded, not changed)

Opening Live Operations marks overdue shifts with no Book On as missed (a client-side write that happens on viewing). This predates Dashboard V2. Brief operators; move the rule to the backend after the pilot.

## 8. Status

- Google Play: **NOT UPLOADED.** No Play app, release, testers, listing or Play App Signing changes.
- Google Play organisation / identity verification: not checked in this phase; owner-supervised.
- Web: already live separately from `35a6230` (Vercel `dpl_4X2cAerbj2mNY5A6uuh4AHFQA8us`). RC14 does not redeploy the web.
- iOS: not built; no Apple credentials; App Store Connect unchanged.
