# S4 compliance phase 1: activation and rollback runbook (Migration 62)

Status: **PROPOSED. Not executed.** Nothing in this document has been run against production. Every
production step below needs the owner's explicit approval at the time.

## 1. What activation changes

| Area | Before | After |
| --- | --- | --- |
| Eligibility for a company | Guard's own declared SIA / Right to Work details + both documents verified by the company | The company's own recorded SIA check and Right to Work check + both documents verified by the company. Declarations are shown for reference only. |
| Rota assignment, shift create/reassign, offer acceptance | Gate run against the old assessment | Same gate, new assessment |
| Guard Book On (`POST /attendance/check-in`) | No compliance gate | Fresh gate: ACTIVE relationship + company assessment. Refusal is a 403 naming the reason; audited as `attendance.book_on_refused` |
| Company starting a shift by hand (`PATCH /shifts/:id` → `in_progress`) | No compliance gate | Same fresh gate |
| Book Off, and a Book On retry for a shift already started | No gate | **Still no gate.** A Guard at work can always record leaving. |
| Recorded right to work restrictions | n/a | Stored and shown as warnings. **Not enforced.** |

No existing row changes. Nothing is grandfathered: at activation, **every company has zero recorded checks,
so no Guard is eligible for any company until that company records its checks.**

## 2. Deployment mechanics (as configured today)

- **Web (Vercel):** production branch `release/s4-pilot-rc1`. A push deploys app.sfour.co.uk automatically.
- **Backend (Render, `render.yaml`):** `autoDeployTrigger: off`. A deploy is started by hand. Its
  `preDeployCommand` is `npm run migration:run:prod`, so **Migration 62 is applied by the deploy itself,
  immediately before the new code starts serving.** The migration is additive and is never applied ahead of
  the code that reads it.
- **Android versionCode 14 / iOS build 13:** already built and unchanged. They talk to the same API.

### Mixed-version behaviour (tested)

| Web | Backend | Result |
| --- | --- | --- |
| new | old | The drawer shows the earlier read-only view. Record buttons and check sections appear only when the API returns `companyChecks`. Old rules apply everywhere. **Safe.** (mobile spec: "Previous backend …") |
| new | new | Full feature. |
| old | new | The table's SIA / Right to Work columns read the declarations while the status reads the company checks, so they can disagree. Blocker text shows without a next step. No Record action. **Usable but confusing. Keep this interval as short as possible: deploy the web first.** |
| vc14 / iOS 13 | new | Every field the apps read is still present with the same type (BOC-15). A refused Book On shows the server's message verbatim in the existing "Start shift failed" alert. The company screens in the apps behave like "old web" above. Companies must record checks on the web. |

**No feature flag is proposed.** The web is safe against either backend, and the backend switches atomically
with its migration, so a flag would add an untested second code path without removing any risk. The
activation gate is the go/no-go check in step 1.

## 3. Activation sequence

1. **Go/no-go (read-only, within 1 hour of deploying).** Run the aggregate query in §5 inside a
   `READ ONLY` transaction. **Go** only if every shift that would be refused is known and accepted:
   - `future_offered`, `future_ready_accepted` and `bookable_now_not_started` for each company. Every
     assigned Guard will be refused at acceptance or Book On until their company records checks.
   - `in_progress_now`. These shifts are not affected: Book Off stays open.

   At 2026-10-12 11:52 UTC production showed 0 assigned future shifts, 0 bookable shifts and one stale test
   shift `in_progress` (company 8: booked on, never booked off, scheduled end about 279 hours earlier). **Go** on
   that data.
2. **Backup.** Take a Supabase point-in-time marker or a `pg_dump` of production.
3. **Company notice.** Tell each company that it must record SIA and Right to Work checks on the web before
   its Guards can be rostered or Book On.
4. **Web first.** Fast-forward `release/s4-pilot-rc1` to the approved commit and push. Vercel deploys. Verify
   that the Compliance page loads and shows the earlier view (the old backend is still serving).
5. **Backend.** Start a manual Render deploy of the same commit. The pre-deploy step applies Migration 62 only.
   Health check `/health/ready`. Verify:
   - `migration:show:prod` lists 62 as executed;
   - `GET /compliance/statuses` returns `companyChecks`, `requirements` and `warnings`;
   - the Compliance page shows "Still needed" and Record actions.
6. **Record checks.** Each pilot company records its Guards' checks. Re-run §5 to confirm assignability.

## 4. Rollback

| Situation | Action | Effect |
| --- | --- | --- |
| Web problem | Vercel instant rollback to the previous deployment | The previous web works against both backends |
| Backend problem | Render rollback to the previous deploy | Old rules and no Book On gate return. Its pre-deploy `migration:run` applies nothing against a 62 database (rehearsed: M62-12). **The table and every recorded check are kept.** |
| Remove the table entirely | Only on explicit owner instruction: first `pg_dump -t guard_compliance_checks`, then `migration:revert:prod` | Drops the table. Recorded checks are lost except in the export. Audit log entries remain. |

The pre-deploy migration failing aborts the Render deploy before any new code serves. The migration is a
single `CREATE TABLE IF NOT EXISTS` plus guarded constraints and indexes. It is repeatable (M62-10) and does
not lock or rewrite existing tables.

## 5. Go/no-go query (aggregates only)

Run as a read-only role inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`. It returns counts per company: no
names, emails, licence numbers or documents.

```sql
select co.id as company_id,
  (select count(*) from company_guards l where l."companyId" = co.id and l.status = 'ACTIVE') as active_guards,
  (select count(*) from shifts s where s."companyId" = co.id and s."guardId" is not null and s.start > now()
     and s.status in ('offered','assigned')) as future_offered,
  (select count(*) from shifts s where s."companyId" = co.id and s."guardId" is not null and s.start > now()
     and s.status in ('ready','accepted')) as future_ready_accepted,
  (select count(*) from shifts s where s."companyId" = co.id and s."guardId" is not null and s.status in ('ready','accepted')
     and s.start <= now() and s."end" + interval '12 hours' > now()) as bookable_now_not_started,
  (select count(*) from shifts s where s."companyId" = co.id and s.status = 'in_progress') as in_progress_now
from companies co order by co.id;
```

## 6. Open decisions before activation

See the phase 1B report: a check expiring during a live shift; legal scope of the 1 October 2026 Right to
Work Scheme extension; restriction enforcement; retention; the stale company 8 `in_progress` test shift.
