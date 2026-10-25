# S4 production release: standard features for every company (backend 77cc18d, web daced92)

**Status: COMPLETE. Certified and verified in production on 25 Oct 2026.** This file records the release; it changes nothing.

## What was released
| Item | Value |
|---|---|
| Backend commit | `77cc18df59c3` (PR #33, merged by fast-forward, no merge commit), on top of `daced92` |
| Release branch | `release/s4-pilot-rc1` = `77cc18d` |
| CI | PR #33 backend release gate: pass. Release-branch S4 Backend Release Gate run 40152618822: pass |
| Render | Manual deploy of `77cc18d` by the owner, Live 25 Oct 2026. Rollback target: the previous deploy (`daced92`). No migration (ledger stays at 65). |
| Vercel (app.sfour.co.uk) | Promoted `dpl_8nie56kd7uvvhRnAf1vB8xdjwe7R` (built from `daced92`). Its web code is identical to `77cc18d`: the `77cc18d` production build was skipped by Vercel's Ignored Build Step because no web files changed. Rollback target: `dpl_E1mtW7mkyw22KENPEocnsnaUn97C` (`e539b89`). |
| Production settings | None changed. `PUSH_WELFARE_REMINDERS_ENABLED` stays off; Welfare push reminders remain disabled. |

## Behaviour
- Live Shift Amendments (shift extensions) are on by default for every company, including companies created later. The S4 platform administrator's per-company switch is an emergency off, and is audited.
- Platform safety limits: a company can make these stricter but never weaker: fatigue warning ≤ 12 h, management approval ≤ 14 h, maximum shift ≤ 16 h (cannot be removed), minimum rest ≥ 11 h, weekly review ≤ 48 h, last-minute warning ≥ 10 min. Any stored value is applied at the stricter of the company value and the limit.
- `PUSH_WELFARE_REMINDER_COMPANY_IDS=all` is supported (every company), but is not set. `PUSH_WELFARE_REMINDERS_ENABLED` remains the global emergency switch.
- Web (daced92): Live Operations can show each Welfare window's push reminder status. Nothing is shown while no reminders exist.

## Evidence
- **Pre-deploy backup:** `~/.s4-pilot-secrets/backups/s4_pilot_pre_pr33_20261025T014659Z.dump`, SHA-256 `62b1c68dd82deb404559171d10bccc90c4724a981e2e9c9cce10e6be96e5dc4b`, 58/58 tables, `pg_restore --list` OK.
- **Backend post-deploy check (read-only, 02:21 UTC):**
  - `/health` and `/health/ready` return 200; ledger 65.
  - Company 9 policy row unchanged: on, 12/14/16/11/48/10, updated 24 Oct 18:32. Company 8 has no row, so the default (on) applies.
  - Row fingerprints identical to the 01:58 UTC snapshot: shifts 55, rota slots 39, company Guards 7, attendance 39, daily logs 105 (94 Welfare Checks), timesheets 27, amendments 1, policies 1.
  - Welfare reminders: 0. Duplicate missed-window evidence, open summaries and policies: 0. Deadlocks: 0.
  - Only activity: the Welfare sweep recorded shift 55 window 7 once at 02:05.
- **Web post-promotion check (02:30–02:36 UTC):**
  - The domain serves `dpl_8nie…`. The bundle points at the production API, has no staging URL and no unreleased inbox or notifications code. CORS for app.sfour.co.uk is OK.
  - Company 9 dashboard, Live Operations (timeline and Welfare windows), Rota Planner and the "Shift extension" panel on the live shift 55 all load. No console errors once observed.
  - Row fingerprints identical before and after.
- **Tests:** shift-amendment 32/32 (LSA-01 rewritten, LSA-10 adjusted, LSA-26 new); welfare-push 19/19 (WPN-18 adjusted, WPN-19 new); m64 9/9; staging seeder 13/13; tsc and build OK.

## Known issues (not part of this release)
- **Low priority, display only:** in the BST→GMT repeated hour, the Welfare window label reads "01:00–01:00". Grading and records are correct. Logged as a separate defect.
- **Test-only:** the welfare-push and m64 specs fail if run 00:00–01:00 UTC on the clock-change night. The baseline fails identically; production behaved correctly.
