# S4 — App Store / TestFlight pack (Gate 4C)

Status: DRAFT FOR OWNER REVIEW. Nothing has been created or submitted in App Store Connect. No reviewer
credentials are recorded here — the owner enters them in App Store Connect only.

## Apple requirements that apply (official sources, read 2026-10-05)

| Requirement | Applies to S4 | Source |
|---|---|---|
| Uploads must be built with **Xcode 26** and an **iOS 26 SDK** (since 28 Apr 2026) | Yes — EAS must build on an Xcode 26 image | <https://developer.apple.com/news/upcoming-requirements/> |
| iOS apps must target **iOS 13 or later** (since 9 Sep 2026) | Met — Expo SDK 54 deployment target 15.1 | same |
| Updated **age-rating questions** must be answered (since 31 Jan 2026) | Yes — owner answers in App Store Connect | same |
| Required-reason APIs must be declared in a privacy manifest (since 1 May 2024) | Yes — app-level declaration added in Gate 4C | same; <https://developer.apple.com/documentation/bundleresources/privacy-manifest-files> |
| Listed third-party SDKs need their own privacy manifest and signature | **Hermes** is on the list (ships with React Native); SDWebImage is listed but not used by S4 | <https://developer.apple.com/support/third-party-SDK-requirements/> |
| Account deletion must be offered **in the app** if the app supports account creation (5.1.1(v)) | Met — Account → Delete account (Gate 2) | <https://developer.apple.com/app-store/review/guidelines/> |
| Purpose strings must clearly and completely describe use (5.1.1(ii), 5.1.5) | Met — single, specific When-In-Use location string | same |
| Sign in with Apple / equivalent (4.8) | **Not required** — S4 uses only its own account system (exception 4.8 first bullet); no third-party or social login exists | same |
| Demo account for review if the app has a login (2.1) | Yes, for external TestFlight review and App Review | same |
| TestFlight: internal ≤ 100 App Store Connect users, no review; external ≤ 10,000, first build needs Beta App Review; builds expire after 90 days | Yes | <https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview> |
| External testing needs Test Information incl. a Beta App Description | Yes | <https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information> |
| Privacy Policy URL is required for iOS apps | Yes — before App Review; have it ready before external TestFlight | <https://developer.apple.com/help/app-store-connect/reference/app-information/> |
| Export compliance | `ITSAppUsesNonExemptEncryption = false` — S4 uses only the operating system's HTTPS/TLS and Keychain | <https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations> |

## Listing draft

| Field | Draft |
|---|---|
| Name | S4 |
| Subtitle (≤ 30) | Security operations, on shift |
| Primary category | Business |
| Secondary category | Productivity (optional) |
| Promotional text | Shifts, Book On, Welfare Checks and the site Log Book — one workspace for security companies and their Guards. |
| Keywords (≤ 100 chars) | security,guard,shift,rota,welfare,log book,site,patrol,SIA,book on,attendance,incident |
| Support URL | https://www.sfour.co.uk/support (exists; 200) |
| Marketing URL | https://www.sfour.co.uk |
| Privacy Policy URL | **BLOCKER** — must be an S4 app policy. The current `/privacy` covers the website and PatrolSafe only |
| Copyright | © 2026 Vesoft Services Limited — **OWNER** to confirm once the Apple organisation conversion completes |

Full description: reuse the Google Play draft in `docs/release/S4_PLAY_INTERNAL_TESTING_PREP.md`
(same product facts; no lone-worker certification, emergency-response or background-tracking claims).

## TestFlight

- **Beta App Description:** S4 pilot build for UK security companies and their Guards: shifts and offers,
  Book On / Book Off, Welfare Checks, Log Book, Site Requests and incidents.
- **What to Test:** sign in; accept a shift offer; Book On at the pilot site (allow location if the site
  asks); complete a Welfare Check; add a Log Book entry; Book Off; reopen the app and confirm the session
  restores. Password reset and email verification use links to app.sfour.co.uk.
- **Feedback email:** **OWNER** (e.g. support@sfour.co.uk once confirmed monitored).
- **Beta review contact:** first name / last name / phone / email — **OWNER placeholders**.
- **Sign-in for review:** a dedicated reviewer **Company** account on the existing company workspace,
  created by the owner; never a real person's account. Guard self-registration needs a genuine SIA licence,
  so state that Guard access is by company invitation. Credentials only in App Store Connect.

## Declarations worksheet (OWNER answers)

- **Ads:** none (no advertising SDK).
- **Content rights:** the app shows only content created by its users and the company; no third-party
  copyrighted content — owner to confirm.
- **Age rating (new questionnaire):** no violence, sexual content, profanity, gambling, alcohol/drugs,
  medical advice; user-generated text is visible only within the user's company (no public UGC, no chat
  with strangers); unrestricted web access: no. Expected result: suitable for all ages, but the app is a
  workforce tool for adults — **OWNER** answers each question.
- **Encryption:** uses exempt encryption only (HTTPS via the OS, Keychain). `ITSAppUsesNonExemptEncryption`
  is set to `false`, so App Store Connect will not ask per build.
- **Accessibility (App Store accessibility declarations):** **OWNER** — not yet audited for VoiceOver,
  larger text or reduced motion; do not claim support until tested.
- **App Privacy:** see `docs/release/S4_APPLE_PRIVACY_WORKSHEET.md`.
- **Account deletion:** in-app (Account → Delete account). Company owners and Platform Admins record the
  request in the app and are told to contact support to transfer or close the workspace first —
  **OWNER/LEGAL** to confirm this is acceptable for review, and keep the reviewer account a non-owner
  if the reviewer is expected to complete a deletion.

## Screenshots and icon

- `supportsTablet: true` is intentional (the Company workspace targets tablet/desktop), so App Store
  Connect needs **iPhone 6.9" (1320 × 2868)** and **iPad 13" (2064 × 2752)** screenshot sets — from the
  real app, not fabricated. Phone: sign-in, Guard Home, current shift actions, Log Book. iPad: Company
  Live Operations, Rota Planner, Log Book / Daily Site Log.
- App Store icon: generated by EAS from `assets/icon.png` (1024 × 1024, opaque, no alpha) — the approved
  S4 icon, unchanged.

## Public web status (read-only, 2026-10-05)

| URL | Status |
|---|---|
| https://www.sfour.co.uk/privacy | 200 — PatrolSafe / website notice, **not** the S4 app |
| https://www.sfour.co.uk/terms | 200 — PatrolSafe Software Licence Terms, **not** S4 |
| https://www.sfour.co.uk/account-deletion | **404** |
| https://www.sfour.co.uk/support | 200 |

What Apple needs, when:

| | Internal TestFlight | External TestFlight | App Store release |
|---|---|---|---|
| In-app account deletion | met | met | met |
| S4 privacy policy URL | not needed to test | expected for Beta App Review — **treat as blocker** | **required** |
| Web account-deletion page | not required by Apple | not required by Apple | not required by Apple (Google Play requires one) |
| Demo account | — | required | required |

Smallest safe next step for the blocker: publish the S4 app privacy policy (from the Gate 2 drafting pack,
after legal review) in the `s4-website` project at a stable URL such as `/s4-app/privacy`, leaving the
PatrolSafe notice untouched; add `/account-deletion` there at the same time for Google Play.
