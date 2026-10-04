# Public account-deletion page — specification for `https://sfour.co.uk/account-deletion`

**Status:** SPECIFICATION ONLY. Not implemented here, and deliberately so.

## Where the page has to be built

- `sfour.co.uk` (the marketing site) is **not in this repository**. Nothing in `security-marketplace`
  references `sfour.co.uk` or a Vercel marketing project, and the only static site here, `download-site/`,
  is a separate download page. No local project for `sfour.co.uk` was identified during Gate 2.
- The site currently serves PatrolSafe legal documents at `/privacy` and `/terms`, which suggests it is
  deployed from the **PatrolSafe / patrol-evidence-platform** project or a website project owned alongside
  it. **Owner action:** identify the repository and Vercel project that serves `sfour.co.uk` and add the
  page there. This repository did not modify any other project.
- Google Play requires this URL in the Data safety form for apps that let users create accounts.

## Page content (factual; S4 only; not legal advice)

**Title:** Delete your S4 account

**How to delete your account in the app**
1. Sign in to S4.
2. Guards: open **Profile** → **Account** → **Delete account**.
   Company users: select **Account** in the top bar → **Delete account**.
3. Read the explanation, select **Continue**, then enter your password and select **Delete my account**.
4. You are signed out on every device straight away.

**If you cannot sign in** — use **Forgot your password?** on the S4 sign-in screen, or contact us (below).

**If your account owns a company workspace** — it cannot be deleted from the app, because that would
leave the company without an owner. Contact us so the workspace can be transferred or closed first.

**What is deleted or anonymised**
- Your access to S4 is removed and every session is ended.
- Your email address is replaced with a non-deliverable placeholder.
- Your first name, last name and phone number on your account are deleted.
- Your password is made unusable.
- For Guards: the phone number on your Guard profile is removed and location sharing is turned off.

**What may be kept**
Some operational and security records may be retained where required for legal, contractual, regulatory,
safety or evidential purposes — for example shift and attendance records, timesheets and payroll records,
Welfare Check, Log Book and incident records, safety alerts, screening and compliance records, and audit
logs. Where your name or SIA licence number forms part of those records it may remain on them. These
records may be held by, or on behalf of, the security company you worked with.
*(Retention periods: to be added only once decided — see `S4_RETENTION_DECISION_REGISTER.md`. Do not
publish a period that has not been decided.)*

**Requesting deletion without the app** — email **[S4 privacy contact — LEGAL/OWNER DECISION REQUIRED]**
from the email address registered to your S4 account, with the subject "Delete my S4 account".

**Identity verification** — to protect your account, S4 will only act on a request that comes from the
account's registered email address, or after confirming you control it (for example by sending a link to
that address). S4 will not ask for your password by email. **LEGAL/OWNER DECISION REQUIRED** — confirm the
support process and the response time to state.

## Must not say

- That all data or all history will be permanently erased.
- Anything from the PatrolSafe documents (local-first, evidence only on the device, etc.).
- "S4 Security", "S4 Guard" or "Security Marketplace".
