# S4 v1.0.0 Pilot UAT — Defect Register

**Release candidate:** `release/v1.0.0-rc1`
**Hardened HEAD:** `ff4ad00`
**Created:** 2026-08-28

> Record every UAT failure here before attempting any fix.
> Do not silently fix failures during UAT execution.
> Stop the affected workflow, raise the defect, report to UAT Lead.

---

## Severity definitions

| Severity | Definition | Release action |
|---|---|---|
| **Critical** | Cross-tenant disclosure/modification, authentication bypass, unrecoverable data loss, materially incorrect payroll/invoice totals, production outage | Immediate NO-GO |
| **High** | Core P0 workflow cannot complete, GPS/security control bypass, major incorrect state transition with no safe workaround | NO-GO until fixed |
| **Medium** | Important workflow defect with safe documented workaround and no security/data-integrity impact | Release-owner decision |
| **Low** | Cosmetic/usability issue without operational impact | May defer |

---

## Open defects

_None._

---

## Closed / resolved defects

---

### DEF-002 — Location permission denied shows "backend unreachable" instead of GPS/permission error on check-in

| Field | Value |
|---|---|
| **Defect ID** | DEF-002 |
| **UAT Test ID** | UAT-ATT-003 |
| **Severity** | **Medium** |
| **Status** | **Closed — fixed and physically verified on new APK** |
| **Date raised** | 2026-08-30 |
| **Raised by** | Release owner (physical device observation) |
| **Owner** | Release owner |
| **Environment** | Production API `https://security-marketplace-api.onrender.com` |
| **Device/Browser** | Physical Android device, EAS preview APK (fix build ID `a17f2026-2402-45b9-8337-b67d83a0cb7c`, commit `abd9373`) |
| **Steps to reproduce** | 1. Go to Settings → Apps → S4 Security → Permissions → Location → Deny. 2. Return to S4 app. 3. Confirm Shift 2 (UAT Site A, `requireGpsCheckIn:true`) is visible and `Ready`. 4. Tap Check In / Book On. 5. If system permission dialog appears, tap "Don't allow". |
| **Expected result** | App shows a clear location/GPS permission error. Example: "Location permission is required to Book On at this site. Allow location access while using S4 Security and try again." No attendance event created. |
| **Actual result** | App shows: "Start shift failed — The live backend is unreachable. Check the internet access and then try again." The internet was fully available. No attendance event created (check-in correctly blocked). |
| **Evidence** | (1) User-observed on physical Android device, 2026-08-30. (2) API verification (PowerShell, 2026-08-30): Shift 2 status=`ready`, attendance events=0. No check-in reached the server. (3) Production API health confirmed UP at time of test: `{"ok":true,"status":"ready","checks":{"database":"up"}}`. |
| **Fix commit** | `abd9373` — `fix(mobile): preserve transport interceptor errors instead of masking as NetworkError` |
| **Fix file** | `security-mobile-app/src/services/api.ts` — `request()` catch block |
| **Fix description** | Only wrap `TypeError` as `NetworkError`; re-throw all other errors (plain `Error` from transport interceptors) without modification |
| **Tests added** | `security-mobile-app/scripts/api-error-handling.spec.cjs` — 17 assertions covering tests A–D |
| **Test result** | 17/17 PASS. All 6 existing suites PASS. TypeScript: clean. |
| **Verified by** | Release owner (physical Android device) |
| **Verification date** | 2026-08-30 |
| **Notes** | Safety behaviour was correct throughout — the check-in was always blocked and no attendance event was created. The defect was in the error message only. Physically verified on EAS build `a17f2026` (commit `abd9373`): location permission denied now shows the correct GPS/location error, not "backend unreachable". |

---

#### DEF-002 Root-cause investigation

**Scope of investigation (2026-08-30):**

**The `attendanceTransport.ts` fetch interceptor fires first, before the user is prompted for GPS.**

The interceptor (`security-mobile-app/src/services/attendanceTransport.ts`) patches `globalThis.fetch`. The check-in flow proceeds as follows when location permission is denied:

**Step 1 — Initial API call (no GPS):**
`checkInShift({ shiftId })` in `api.ts` calls `fetch('/attendance/check-in', ...)`. The patched fetch makes the real API call first, without GPS coordinates. The backend (`attendance.service.ts`) detects `requireGpsCheckIn:true` and no GPS coordinates, responds **HTTP 403** with body containing "gps location is required for attendance".

**Step 2 — Interceptor detects GPS-required 403:**
`responseRequiresGps(firstResponse)` → `true`. The interceptor then calls `getAttendanceLocationEvidence({ required: true, promptIfNeeded: true })`.

**Step 3 — `getAttendanceLocationEvidence` throws on denial:**
`Location.requestForegroundPermissionsAsync()` is called → Android system dialog → user taps "Don't allow" → `permission.status !== 'granted'` → since `required:true`, throws:
```
new Error('Location permission is required to Book On at this site. Allow location access while using S4 Security and try again.')
```
This is the correct, user-friendly message.

**Step 4 — Error propagates through the patched `fetch()` as a rejection:**
The throw inside the async fetch interceptor causes the `fetch()` promise itself to reject with that plain `Error`.

**Step 5 — `api.ts:request()` unconditionally wraps all fetch rejections as `NetworkError`:**
```typescript
// api.ts:168
} catch (error) {
  throw new NetworkError(           // <-- ALL fetch rejections treated as network failure
    error instanceof Error && error.message
      ? `Unable to reach the live API at ${API_BASE_URL}. ${error.message}`
      : `Unable to reach the live API at ${API_BASE_URL}.`,
  );
}
```
The original semantic message is preserved in the `NetworkError.message` field, but the type is now `NetworkError`.

**Step 6 — `formatApiErrorMessage` maps `NetworkError` to a fixed string:**
```typescript
// api.ts:200
if (error instanceof NetworkError) {
  return 'The live backend is unreachable right now. Check internet access and server health, then retry.';
}
```
The original location-permission message is **completely discarded**. The user sees the network-failure string regardless.

**Step 7 — `handleCheckIn` displays the wrong message:**
```typescript
// GuardDashboardScreen.tsx:541-542
const message = formatApiErrorMessage(error, 'Unable to start this shift.');
pushFeedback('error', 'Start shift failed', message);
```

---

#### DEF-002 Files and components involved

| File | Role in defect |
|---|---|
| `security-mobile-app/src/services/attendanceTransport.ts` | Fetch interceptor. Correctly throws a location-permission error, but throws it **into** the fetch call chain rather than surfacing it separately. |
| `security-mobile-app/src/services/attendanceLocation.ts` | `getAttendanceLocationEvidence()` — throws the correct user-facing message on permission denial. Not defective itself. |
| `security-mobile-app/src/services/api.ts:168–173` | **Primary defect location.** `request()` catch block wraps ALL fetch rejections (including semantic interceptor errors) as `NetworkError`, discarding the original error type. |
| `security-mobile-app/src/services/api.ts:199–201` | `formatApiErrorMessage()` maps any `NetworkError` to the fixed "backend unreachable" string, losing the semantic message. |
| `security-mobile-app/src/screens/GuardDashboardScreen.tsx:531–546` | `handleCheckIn()` — correctly calls `formatApiErrorMessage`; the defect is upstream. |

---

#### DEF-002 Safety and data-integrity assessment

| Criterion | Assessment |
|---|---|
| Was a check-in created? | **No** — API returned 403, no attendance event written |
| Was Shift 2 status changed? | **No** — remains `ready` |
| Was any data corrupted? | **No** |
| Is there a security control bypass? | **No** — GPS enforcement is intact |
| Is the error message accurate? | **No** — "backend unreachable" when network is available |
| Does the user know what to do? | **No** — message gives wrong remediation (check internet), not "allow location" |

---

#### DEF-002 Safest fix (requires release-owner approval before implementation)

**Single change in `api.ts:request()` catch block:**

Real React Native network failures throw `TypeError` (e.g., `TypeError: Network request failed`). Semantic errors from transport interceptors throw plain `Error`. Distinguishing by type is safe:

```typescript
// BEFORE (api.ts:168)
} catch (error) {
  throw new NetworkError(
    error instanceof Error && error.message
      ? `Unable to reach the live API at ${API_BASE_URL}. ${error.message}`
      : `Unable to reach the live API at ${API_BASE_URL}.`,
  );
}

// AFTER
} catch (error) {
  if (error instanceof TypeError) {
    throw new NetworkError(
      error.message
        ? `Unable to reach the live API at ${API_BASE_URL}. ${error.message}`
        : `Unable to reach the live API at ${API_BASE_URL}.`,
    );
  }
  throw error;   // re-throw semantic errors from transport interceptors as-is
}
```

With this fix, `formatApiErrorMessage` receives a plain `Error` and its line 245 branch applies:
```typescript
if (error instanceof Error && error.message.trim()) {
  return error.message;  // returns the correct location-permission message
}
```

**REC-001 evidence remains valid:** In airplane mode, React Native's native fetch implementation throws `TypeError: Network request failed`. The fix still wraps `TypeError` → `NetworkError` → "backend unreachable" ✓.

---

#### DEF-002 Regression tests required

1. Location permission denied → check-in attempt → error shows location/GPS message (not "backend unreachable")
2. Location permission granted + coordinates inside geofence → check-in succeeds
3. Location permission granted + coordinates outside geofence → error shows geofence-rejection message from backend
4. Device offline (airplane mode) → check-in attempt → error shows "backend unreachable" (regression check for REC-001 scenario)
5. Location services disabled (not just permission) → check-in attempt → error shows "Turn on Location Services" message

---

#### DEF-002 UAT impact

| UAT Test | Impact |
|---|---|
| UAT-ATT-003 | **Cannot PASS** — requirement is "clear, accurate location/GPS permission error"; observed message is incorrect |
| UAT-ATT-002 | Not blocked — ATT-002 requires permission granted; this defect only fires on denial |
| UAT-REC-002 | Not blocked — depends on ATT-002 check-in succeeding |

---

### DEF-001 — Physical Android APK: all guard screens return "Guard profile not found" (404)

| Field | Value |
|---|---|
| **Defect ID** | DEF-001 |
| **UAT Test ID** | UAT-ATT-003 (blocker discovered during pre-flight; also blocked UAT-ATT-002, UAT-REC-001, UAT-REC-002) |
| **Severity** | High |
| **Status** | **Closed — environment/device artefact. Not an application-code defect.** |
| **Date raised** | 2026-08-30 |
| **Raised by** | Release owner (physical device observation) |
| **Owner** | Release owner |
| **Environment** | Production API `https://security-marketplace-api.onrender.com` |
| **Device/Browser** | Physical Android device, EAS preview APK (build ID `31520add-9adc-49fe-9d6a-39882ba7bda2`, package `com.securitymarketplace.mobile`) |
| **Steps to reproduce** | 1. Install EAS preview APK on Android device. 2. Launch app. 3. Observe login state (logged in as uat-guard-a@example.com or app restores stored session). 4. Navigate to Guard Dashboard (home), Profile tab, and Compliance tab. |
| **Expected result** | Guard dashboard loads showing shift id:2. Profile tab shows Guard A's profile. Compliance tab shows status `valid`, work-eligible. All 6 `loadData()` calls and 3 `GuardCompliancePanel` calls return HTTP 200. |
| **Actual result** | Multiple screens displayed "Load failed — Guard profile not found" and "Action required — Guard profile not found". Profile data was blank. Work eligibility showed Not eligible. Home screen showed no live shift. Raw HTTP response observed from app: `404 {"message":"Guard profile not found","error":"Not Found","statusCode":404}`. |
| **Evidence** | (1) User-observed on physical device (2026-08-30). (2) API verification (PowerShell, 2026-08-30): all 8 affected endpoints returned HTTP 200 for Guard A's fresh credentials — confirms backend is healthy. (3) Resolution: release owner cleared app data (Settings → Apps → S4 Security → Storage → Clear Data) and performed a fresh login as uat-guard-a@example.com. All guard screens loaded correctly. Errors did not recur. |
| **Fix commit** | N/A — no code change required or made |
| **Verified by** | Release owner |
| **Verification date** | 2026-08-30 |
| **Notes** | Confirmed environment/device artefact. Root cause: stale SecureStore session (JWT with wrong `sub`) persisted from a prior app installation on the same device. Application code is correct. Backend is correct. No code change was made. UAT may resume from ATT-003. |

---

#### DEF-001 Root-cause investigation

**Scope of investigation performed (2026-08-30):**

Step 1 — Fresh login as Guard A against production API using correct credentials:
- `POST /auth/login` → HTTP 200. Token issued. JWT `sub=11`, `role=guard`, `email=uat-guard-a@example.com`. `guardId` is NOT embedded in the JWT; it appears only in the login response body (`user.guardId=7`).

Step 2 — All 6 `loadData()` endpoints tested with fresh Guard A token:

| Endpoint | Result | Detail |
|---|---|---|
| `GET /guards/me` | **200** | Returns guard object |
| `GET /shifts/my` | **200** | 4 records returned |
| `GET /attendance/mine` | **200** | 5 records |
| `GET /incidents/mine` | **200** | 2 records |
| `GET /daily-logs/mine` | **200** | 2 records |
| `GET /timesheets/mine` | **200** | 4 records |

Step 3 — `GuardCompliancePanel` endpoints:

| Endpoint | Result | Detail |
|---|---|---|
| `GET /compliance/mine/status` | **200** | `complianceStatus=valid`, `assignable=true` |
| `GET /compliance/documents/mine` | **200** | 11 documents |

Step 4 — Backend code trace: Every guard-specific endpoint uses the same pattern:
```
guardProfileService.findByUserId(user.sub)  →  guard_profiles WHERE user.id = user.sub
if (!guard) throw new NotFoundException('Guard profile not found')
```
`user.sub` is extracted from the JWT by the auth guard. `guard_profiles` has a record for userId=11 (Guard A). All lookups succeed.

**Backend conclusion: No defect in the server-side code or data.**

---

#### DEF-001 Root cause — most likely: stale SecureStore session on the physical Android device

**Why the backend succeeds but the device fails:**

The JWT in the production API is stateless. The backend cannot reject a previously-issued valid token unless it has expired. If the Android device's SecureStore contains a JWT whose `sub` claim maps to a userId that has no guard profile in the production database, every `findByUserId(sub)` call returns null → 404 "Guard profile not found". The user-visible email in the app comes from the `session.user.email` field (a plain object stored alongside the token) — this can display "uat-guard-a@example.com" even if the `accessToken` inside is for a different user.

**How this arises:** Android SecureStore (Keystore) data persists across app re-installs for the same package name (`com.securitymarketplace.mobile`). A prior EAS preview or Expo Go session (if it used the same package) could have stored a session for a different user or for a Guard A account with a different userId (e.g., from a prior test environment or prior database state). The `parseStoredSession` version check (`SESSION_STORAGE_VERSION = 2`) would only reject the old session if the stored version field does not equal 2.

**Consistency check — "Dashboard loads. Shift id 2 is visible."**

The user reported the dashboard loaded and shift id:2 was visible before the errors appeared. Two possible explanations:
- (a) The initial load succeeded (correct session), but a subsequent re-render or navigation event triggered a reload with a corrupted token state.
- (b) "Dashboard loads / Shift id 2 visible" described the expected state before the user navigated and discovered the errors.

If (a): something invalidated the module-level `accessToken` variable in `api.ts` between the initial load and the subsequent reload. This would require a code-level fix.

If (b): the device never successfully loaded Guard A's data, and the stale session hypothesis applies from the start.

**Candidate root causes in order of likelihood:**

| # | Cause | Evidence | Code fix needed |
|---|---|---|---|
| 1 | Stale SecureStore session: `accessToken` JWT has wrong `user.sub` (not userId=11) | All backend endpoints work with fresh credentials; stored `user.email` can differ from JWT `sub` | No — clear device data |
| 2 | Module-level `accessToken` in `api.ts` reset to null between renders (race condition on session restore) | `restoreSession()` sets `accessToken`; if called after first render, second loadData() call uses null token → 401, not 404 | Possible — but 401 ≠ 404 |
| 3 | Transient production API error (cold-start, DB connection) at time of test | Render.com free tier can cold-start; 404 is specific DB lookup failure, not generic error | No |
| 4 | JWT `sub` field parsing issue on Android (platform-specific base64) | Very unlikely — standard JWT library used | Possible — but no platform-specific code observed |

**Candidate #1 is the most consistent with all observations.**

---

#### DEF-001 Reproduction steps to confirm root cause

The following steps, if performed by the release owner, would confirm or rule out the stale-session hypothesis **without making code changes**:

1. On the physical Android device: go to **Settings → Apps → S4 Security → Storage → Clear Data** (removes all SecureStore entries for the app).
2. Re-launch the app. Confirm the login screen appears (session cleared).
3. Log in as `uat-guard-a@example.com` with password `UatPass!2026G`.
4. Observe: if all guard screens load correctly, the defect was caused by stale device state, not a code bug. Resume UAT from ATT-003.
5. If errors persist after clear data + fresh login: the defect is a code bug. Escalate to release owner for code investigation approval.

**Do not proceed with any code investigation or fix before the release owner has confirmed whether step 4 resolves the error.**

---

#### DEF-001 Files and components involved

| File | Role in defect |
|---|---|
| `security-mobile-app/src/services/api.ts` | Module-level `accessToken` variable; `restoreSession()`; all API request functions |
| `security-mobile-app/src/services/session.ts` | `SESSION_STORAGE_VERSION`, `parseStoredSession()` — version gating for restored sessions |
| `security-mobile-app/src/screens/GuardDashboardScreen.tsx` | `loadData()` — `Promise.all` of 6 API calls; `useEffect([user.guardId])` dependency |
| `security-mobile-app/src/components/guard/GuardCompliancePanel.tsx` | Independent `Promise.all` of 3 calls: `getMyGuard()`, `getMyGuardComplianceStatus()`, `listMyGuardDocuments()` |
| `security-backend-nest/src/guard-profile/guard-profile.service.ts` | `findByUserId()` — the lookup that returns null for unknown userId |
| `security-backend-nest/src/auth/auth.service.ts` | JWT payload: `{ sub: userId, email, role, status }` — `guardId` NOT in JWT |

---

#### DEF-001 UAT impact

| UAT Test | Impact |
|---|---|
| UAT-ATT-002 | Blocked — requires physical device session state |
| UAT-ATT-003 | Blocked — primary case that surfaced defect |
| UAT-REC-001 | Blocked — depends on ATT-002/003 |
| UAT-REC-002 | Blocked — depends on ATT-002/003 |

---

#### DEF-001 Safest fix

**Step 1 (device state — no code change):** Release owner clears app data and re-logs in as Guard A. Confirm errors resolve. If resolved, record as "environment/device state — not a code defect" and close.

**Step 2 (only if step 1 does not resolve):** A code investigation is required. Possible mitigations (require release-owner approval before implementing):
- Add a 401 handler in `api.ts` that clears the stored session and redirects to the login screen — prevents stale tokens from causing confusing 404 errors.
- Add JWT `sub` consistency check on session restore: after restoring a stored session, call `GET /guards/me`; if it returns 404, clear session and force re-login.

**No code change may be made without release-owner approval.**


---

## Defect template

When a UAT failure is observed, raise a new defect using this format:

---

### DEF-XXX — [Short title]

| Field | Value |
|---|---|
| **Defect ID** | DEF-XXX |
| **UAT Test ID** | UAT-ZZZZZ-NNN |
| **Severity** | Critical / High / Medium / Low |
| **Status** | Open / In Progress / Fixed / Verified Fixed / Deferred |
| **Date raised** | |
| **Raised by** | |
| **Owner** | |
| **Environment** | |
| **Device/Browser** | |
| **Steps to reproduce** | 1. … 2. … 3. … |
| **Expected result** | |
| **Actual result** | |
| **Evidence** | Screenshot / recording / API response |
| **Fix commit** | |
| **Verified by** | |
| **Verification date** | |
| **Notes** | |

---

## Defect count by severity

| Severity | Open | Fixed | Deferred |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 1 | 0 |
| Medium | 0 | 1 | 0 |
| Low | 0 | 0 | 0 |
| **Total** | **0** | **2** | **0** |

_Release is not blocked — no open Critical or High defects._

_Release is blocked while any Critical or High defect remains open._
