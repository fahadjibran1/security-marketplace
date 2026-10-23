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
