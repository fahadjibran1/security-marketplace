# Platform Admin two-step verification (TOTP)

Platform Admin accounts (`users.role = 'admin'`) can protect sign-in with an authenticator app (RFC 6238 TOTP:
SHA-1, 6 digits, 30-second steps, so Google Authenticator, Microsoft Authenticator, 1Password and similar apps all
work). No other role is affected: Guard, company and client-portal sign-in, refresh and tokens are unchanged.

Migration 77 (`AddPlatformAdminMfa1720900000024`) adds the `platform_admin_mfa` table (one row per enrolled or
enrolling admin). It is additive; no existing table changes.

## Flag: `PLATFORM_ADMIN_MFA_REQUIRED`

| Value | Behaviour |
| --- | --- |
| unset / `false` (default) | Admins may enrol in the admin portal under **Account security**. Enrolled admins must use a code; unenrolled admins sign in with a password as today. Admins may turn it off with a current code. |
| `true` | An admin who has not enrolled gets only a 15-minute **enrolment token** after their password, which reaches the enrolment routes and nothing else. Existing sessions of unenrolled admins stop working (access tokens and refresh). Turning it off is refused (`403 MFA_REQUIRED_BY_POLICY`). |

Any other value fails startup. The flag is read per request, so changing it on Render takes effect on restart.

Recommended rollout: deploy with the flag off, have every Platform Admin enrol from **Account security**, confirm
(`SELECT "userId", "enabledAt" FROM platform_admin_mfa`) that every active admin is enrolled, then set the flag to
`true`.

## Sign-in flow

1. `POST /auth/login` with the correct password:
   - not an admin, or an unenrolled admin with the flag off → today's response (`accessToken`, `user`, and on mobile
     `refreshToken`, `refreshExpiresAt`);
   - enrolled admin → `{ mfaRequired: true, method: 'totp', challengeToken, challengeExpiresAt }` (5 minutes). No
     session, no refresh token, no `auth_sessions` row;
   - unenrolled admin, flag on → `{ mfaEnrollmentRequired: true, enrollmentToken, enrollmentExpiresAt }` (15 minutes).
2. `POST /auth/mfa/verify { challengeToken, code }` → the normal sign-in response. The access token carries
   `mfa: true`; refresh keeps it.

Challenge and enrolment tokens are signed with keys derived from `JWT_SECRET` (HMAC with a purpose label), carry a
`purpose` claim, and are refused as bearer tokens everywhere. A token signed with `JWT_SECRET` itself is refused as a
challenge.

An enrolled admin's access token without `mfa: true` (for example one issued before enrolment) is refused with
`401 MFA_REQUIRED`.

## Enrolment and turning off

| Route | Auth | Result |
| --- | --- | --- |
| `GET /auth/mfa/status` | admin session or enrolment token | `{ enrolled, enabledAt, pending, required, method }` |
| `POST /auth/mfa/totp/enrol` | admin session or enrolment token | secret, `otpauth://` URI and parameters (pending for 15 minutes); `409` if already enrolled |
| `POST /auth/mfa/totp/confirm { code }` | admin session or enrolment token | activates; **ends every refresh session of the admin** (`revokedReason = 'mfa_enabled'`); returns a fresh two-step session |
| `POST /auth/mfa/totp/disable { code }` | admin session | `{ enrolled: false }`; refused while the flag is on |

The secret is shown only before confirmation. It is stored only as an AES-256-GCM envelope made by the existing
`EncryptionService` (`GUARD_DATA_ENCRYPTION_KEY`); it is never logged, audited or returned after confirmation.
Rotating `GUARD_DATA_ENCRYPTION_KEY` without re-encrypting would make enrolled admins unable to sign in (recover them,
below).

Logging out while holding only an enrolment token needs no server call: no session exists; the client discards the
token.

## Codes

- The current step and one step either side are accepted (clock drift).
- **Replay**: each accepted code moves `lastUsedStep` forward with a compare-and-set update; a code from that step or
  an earlier one is refused (`replayed_code`), including two simultaneous sign-ins with the same code.
- **Throttling** uses the existing `LoginAttemptLimiter` (scope `mfa`, keyed by the admin): 5 failures per source per
  15 minutes; 10 failures across sources hold new sources but never a source the admin has already signed in from; 30
  per source across accounts. A held attempt is `429` even with the right code. The endpoints are also behind the
  auth throttler (30/minute for verify).
- Wrong codes are `401 MFA_CODE_INVALID` at sign-in, and `403 MFA_CODE_INVALID` inside a session (so a typo never
  signs the admin out).

## Audit

`audit_logs` actions (user = the admin, `afterData.adminUserId`, `method: 'totp'`, `ipAddress` = client source):
`platform_admin.mfa.enrolment_started`, `platform_admin.mfa.enabled`, `platform_admin.mfa.sign_in_verified`,
`platform_admin.mfa.code_rejected` (`stage`, `reason`: `wrong_code` | `replayed_code`), `platform_admin.mfa.disabled`.
No secret, URI, code or token is ever written.

## Recovery (lost authenticator)

Operator-only, from a trusted shell with the production database URL (as for every `admin-operator` command):

```
NODE_ENV=production DATABASE_SYNCHRONIZE=false \
RECOVER_ADMIN_EMAIL=<admin email> RECOVER_ADMIN_PASSWORD=<new password> \
RECOVER_ADMIN_CONFIRM=RECOVER_EXISTING_PLATFORM_ADMIN npm run admin:recover
```

`recover` already resets the password, re-activates the account and ends its sessions; it now also deletes the
admin's `platform_admin_mfa` row in the same transaction (`afterData.mfaReset = true` on the
`platform_admin.recovered` audit row, and the CLI prints `Two-step verification: reset.`). The admin then signs in with the new password and, with the flag on, is taken
straight to enrolment.

There is no self-service recovery and no backup codes; this is deliberate while the number of Platform Admins is small.
