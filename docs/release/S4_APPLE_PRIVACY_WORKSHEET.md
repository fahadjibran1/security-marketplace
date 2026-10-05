# S4 — Apple App Privacy worksheet (App Store Connect "App Privacy")

Status: DRAFT, evidence-based. **Not submitted.** Every declaration needs **OWNER/LEGAL CONFIRMATION**
before it is entered in App Store Connect. Source of truth for the data: the Gate 2 data map
(`docs/gate2/S4_PRIVACY_POLICY_DRAFTING_PACK.md`) and the code at the commit that adds this file.

Apple's definitions: <https://developer.apple.com/app-store/app-privacy-details/>. "Collected" means
transmitted off the device and stored longer than needed to service the request. "Tracking" means
linking with data from other companies' apps/sites for advertising or sharing with data brokers.

## Global answers

| Question | Draft answer | Evidence |
|---|---|---|
| Does S4 collect data? | **Yes** | Accounts, shifts, attendance, operational records are stored on the S4 backend |
| Tracking (ATT)? | **No** — no tracking, no advertising, no data brokers | No ad/analytics SDKs (dependency list: expo, expo-constants, expo-document-picker, expo-location, expo-secure-store, react, react-native, safe-area-context, react-native-web). Privacy manifest declares `NSPrivacyTracking: false` |
| Third-party SDKs that collect data | **None** | No analytics, crash-reporting or ad SDK in the app. Sentry exists only on the backend and is disabled |
| Data linked to the user? | **Yes** for everything below — all records belong to a signed-in account | Every API call is authenticated to a user |

## Data types

All rows: **source = S4 itself** (first-party backend), **not used for tracking**. Purposes are
"App Functionality" unless stated; S4 has no advertising, analytics or personalisation purpose.

| Apple category → type | Collected? | Linked | Required / optional | Purpose(s) | Notes / evidence |
|---|---|---|---|---|---|
| Contact Info → Name | Yes | Yes | Required for Guards (registration); company users | App Functionality | Guard `fullName`; company user names |
| Contact Info → Email Address | Yes | Yes | Required | App Functionality (sign-in, verification, password reset) | Account email; authentication email via Resend |
| Contact Info → Phone Number | Yes | Yes | Required for Guards | App Functionality | Guard profile phone |
| Contact Info → Physical Address | Yes | Yes | Company/site addresses required; screening address history if screening used | App Functionality | **OWNER/LEGAL** — mostly business addresses; screening address history is personal |
| Contact Info → Other User Contact Info | Yes (company-held) | Yes | Optional | App Functionality | Guard emergency contact (a third party) |
| Identifiers → User ID | Yes | Yes | Required | App Functionality | Account id |
| Identifiers → Device ID | **No** | — | — | — | No IDFA/IDFV/advertising identifier read by S4 code |
| Location → Precise Location | Yes | Yes | Optional — only at sites that require location verification | App Functionality | One foreground reading at Book On; stored with the attendance record (latitude, longitude, accuracy, distance) |
| Location → Coarse Location | Yes (same reading) | Yes | Optional | App Functionality | Same reading; iOS may give reduced accuracy if the user chooses |
| Sensitive Info | **OWNER/LEGAL** | Yes | Optional | App Functionality | Screening (criminal-record-related references), possible health information in Welfare/incident free text |
| Financial Info → Other Financial Info | Yes (company-held) | Yes | Optional | App Functionality | Guard bank details for payroll |
| User Content → Photos or Videos | **No** in the iOS app | — | — | — | No camera / photo-library access; evidence upload uses the document picker |
| User Content → Other User Content | Yes | Yes | Required for operations | App Functionality | Log Book entries, Welfare Checks, incidents, Site Requests, close-out notes, uploaded compliance/screening documents |
| Usage Data → Product Interaction | **No** | — | — | — | No analytics; the server audit log records actions for security/accountability — **OWNER/LEGAL** whether to declare it here |
| Diagnostics → Crash Data / Performance | **No** | — | — | — | No crash reporting in the app; Sentry is backend-only and disabled |
| Other Data → Other Data Types | Yes | Yes | Required | App Functionality | SIA licence number and expiry, right-to-work status, NI number/UTR (company-held, encrypted), shift schedules, attendance (Book On / Book Off times), timesheets |
| Health & Fitness, Contacts, Browsing/Search History, Purchases, Emails or Text Messages, Audio, Gameplay | **No** | — | — | — | Not accessed |

Authentication/session/security data (password hash, refresh-session hashes, verification/reset token
hashes, audit log entries) are server-side security records, not separate Apple data types;
**OWNER/LEGAL** to confirm they need no separate declaration.

## Privacy manifest (separate from App Privacy)

The app-level `PrivacyInfo.xcprivacy` (generated from `app.json` → `ios.privacyManifests`) declares:
`NSPrivacyTracking: false`, no tracking domains, and the required-reason APIs used by bundled
dependencies (UserDefaults CA92.1; FileTimestamp C617.1, 0A2A.1, 3B52.1; DiskSpace E174.1, 85F4.1;
SystemBootTime 35F9.1). It does **not** yet list `NSPrivacyCollectedDataTypes`; adding them must follow the
owner/legal-confirmed answers above, so they stay consistent with the App Privacy label.

## Location purpose string (shown by iOS)

> S4 uses your location only when you Book On at a site that requires location verification, to confirm
> you are at that site. S4 does not track your location in the background.

Only `NSLocationWhenInUseUsageDescription` is present; the "Always" strings and the Face ID string that
the Expo plugins add by default are removed.
