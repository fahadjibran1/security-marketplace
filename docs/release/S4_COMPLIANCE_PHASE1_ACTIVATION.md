# S4 compliance phase 1: activation and rollback runbook (Migrations 62 and 63)

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
| A check lapsing during a live shift (Migration 63) | Nothing | The backend's five-minute sweep raises one critical **Compliance** alert per lapsed check (expired, not confirmed, or missing) on in-progress shifts whose scheduled end was less than 12 hours ago, and writes `shift.compliance_lapse_detected` to the audit log. It **never** ends, changes or reassigns the shift and never books the Guard off. See §1a. |
| Recorded right to work restrictions | n/a | Stored and shown as warnings. **Not enforced.** |

No existing row changes. Nothing is grandfathered: at activation, **every company has zero recorded checks,
so no Guard is eligible for any company until that company records its checks**, and any Guard on a live shift
at that moment raises "missing check" alerts (see the go/no-go in §3).

## 1a. Compliance alerts: who sees, who is told, who acts

| Who | Sees in the company alert list | In-app notification | May acknowledge / resolve |
| --- | --- | --- | --- |
| Company owner account (legacy owner) | Every alert, as before | "Urgent compliance review required": Guard, site and what lapsed (for example "SIA licence check expired on 11/10/2026") | Every alert, as before |
| Members with compliance.manage (Owner, Admin, HR / Compliance memberships) | Their own company's Compliance alerts | Same as the owner | **Compliance alerts only**, own company only, with a reason from the compliance set and a mandatory note. Never panic / SOS, welfare, Missing Book Off, site requests or incidents. |
| Operations and Control Room members | Their own company's Compliance alerts (they already hold compliance.view) | "Urgent eligibility review required": Guard, site and shift time only. **No check category, reason, expiry, licence, immigration status or evidence.** | No |
| Finance members | Nothing new | None | No |
| Viewer members | Their own company's Compliance alerts (compliance.view) | None | No |
| Guards, other companies | Nothing | None | No |

- **Channels:** in-app notifications only. No email, SMS, WhatsApp or push.
- **Deduplication:** a notification is written only when an alert is newly created, in the same transaction, so
  repeated sweeps never notify twice.
- **Evidence:** the alert, the notification and the audit entries carry no licence number, check method, permission
  type, document or evidence reference. That detail stays in the company check record, which only
  compliance.manage roles can open.
- **Audit:** detection (`shift.compliance_lapse_detected`, system), acknowledgement (`safety_alert.acknowledged`)
  and resolution (`safety_alert.closed`) each record the actor, the time and the before / after state. Resolution
  also records the reason and the note.
- **Detection delay:** up to five minutes after a check lapses (for an expiry, after 00:00 UK time on the day after
  the expiry date), and up to five minutes after a backend start, because the first sweep runs one interval after
  boot.
- **No automatic shift action:** S4 never books the Guard off, ends the shift, removes the Guard, reassigns cover or
  overrides compliance. Book Off always remains available. A new shift cannot start while the check is lapsed (the
  Book On gate). What to do about the live shift is the company's operational and legal decision.

## 2. Deployment mechanics (as configured today)

- **Web (Vercel):** production branch `release/s4-pilot-rc1`. A push deploys app.sfour.co.uk automatically.
- **Backend (Render, `render.yaml`):** `autoDeployTrigger: off`, `numInstances: 1`. A deploy is started by hand.
  Its `preDeployCommand` is `npm run migration:run:prod`, so **Migrations 62 and 63 are applied by the deploy
  itself, immediately before the new code starts serving.** Both are additive and never applied ahead of the code
  that reads them.
- **Background sweep:** started by the backend at boot (`SafetyAlertService.onModuleInit`), every five minutes,
  with no dependency on any page being open. Production evidence: the existing Missing Book Off sweep raised and
  later closed its own alerts with no user involved. Overlapping or concurrent sweeps (including the brief overlap
  of two instances during a zero-downtime deploy) are made safe by per-shift advisory locks and unique indexes.
  The first compliance sweep runs five minutes after boot.
- **Android versionCode 14 / iOS build 13:** already built and unchanged. They talk to the same API.

### Mixed-version behaviour (tested)

| Web | Backend | Result |
| --- | --- | --- |
| new | old | The drawer shows the earlier read-only view. Record buttons and check sections appear only when the API returns `companyChecks`. No `compliance_lapse` alerts exist yet. Old rules apply everywhere. **Safe.** |
| new | new | Full feature. Compliance alerts appear in Attention / Live Operations as red "Compliance" items, never as SOS. |
| old | new | The table's SIA / Right to Work columns read the declarations while the status reads the company checks, so they can disagree. No Record action. Compliance alerts are not listed in the old attention queue (its categories are an allow-list), but the in-app notifications still arrive. **Usable but incomplete. Keep this interval short: deploy the web first.** |
| vc14 / iOS 13 | new | Every field the apps read is still present with the same type (BOC-15, LAPSE-16). A refused Book On shows the server's message verbatim. Company screens in the apps behave like "old web" above. Companies must record checks and handle Compliance alerts on the web. |

**No feature flag is proposed.** The web is safe against either backend, and the backend switches atomically
with its migrations, so a flag would add an untested second code path without removing any risk. The
activation gate is the go/no-go check in step 1.

## 3. Activation sequence

1. **Go/no-go (read-only, within 1 hour of deploying).** Run the aggregate query in §5 inside a
   `READ ONLY` transaction. **Go** only if every affected shift is known and accepted:
   - `future_offered`, `future_ready_accepted` and `bookable_now_not_started` for each company. Every
     assigned Guard will be refused at acceptance or Book On until their company records checks.
   - `in_progress_live`: each one will raise two "missing check" Compliance alerts and notify the company's
     compliance people within about five minutes of the backend starting. The shift itself is not touched.
   - `in_progress_stale` (scheduled end over 12 hours ago): ignored by the compliance sweep. They remain
     covered by their Missing Book Off alerts.

   At 2026-10-12 production showed 0 assigned future shifts, 0 bookable shifts, 0 live in-progress shifts and one
   stale test shift `in_progress` (company 8: booked on, never booked off, scheduled end about 279 hours earlier,
   already carrying a Missing Book Off alert). **Go** on that data: activation would raise no Compliance alerts.
2. **Backup.** Take a Supabase point-in-time marker or a `pg_dump` of production.
3. **Company notice.** Tell each company that it must record SIA and Right to Work checks on the web before its
   Guards can be rostered or Book On, and that Compliance alerts are handled on the web.
4. **Web first.** Fast-forward `release/s4-pilot-rc1` to the approved commit and push. Vercel deploys. Verify that
   the Compliance page loads and shows the earlier view (the old backend is still serving).
5. **Backend.** Start a manual Render deploy of the same commit. The pre-deploy step applies Migrations 62 and 63
   only. Health check `/health/ready`. Verify:
   - `migration:show:prod` lists 62 and 63 as executed;
   - `GET /compliance/statuses` returns `companyChecks`, `requirements` and `warnings`;
   - the Compliance page shows "Still needed" and Record actions;
   - after 5 minutes, the logs show no `Compliance lapse scan failed` entry.
6. **Record checks.** Each pilot company records its Guards' checks. Re-run §5 to confirm assignability.

## 4. Rollback

| Situation | Action | Effect |
| --- | --- | --- |
| Web problem | Vercel instant rollback to the previous deployment | The previous web works against both backends |
| Backend problem | Render rollback to the previous deploy | Old rules, no Book On gate and no compliance sweep return. Its pre-deploy `migration:run` applies nothing against a 62/63 database (rehearsed: M62-12, M63-09). **Every recorded check and every Compliance alert is kept.** Old code ignores the extra columns; a `compliance_lapse` row reads as an unrecognised alert type. |
| Remove Migration 63 | Only on explicit owner instruction: `migration:revert:prod` | Refused while any `compliance_lapse` alert exists (M63-08). Export and decide first. With none, it drops the three columns and two indexes; the enum label stays (PostgreSQL cannot drop one). |
| Remove Migration 62 | Only on explicit owner instruction, after 63: `pg_dump -t guard_compliance_checks`, then `migration:revert:prod` | Drops the table. Recorded checks are lost except in the export. Audit log entries remain. |

A failing pre-deploy migration aborts the Render deploy before any new code serves. Both migrations are guarded
and repeatable (M62-10, M63-06) and do not rewrite existing rows. Migration 63 runs outside a transaction, as
migration 59 does, because its index predicates use the enum label it adds.

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
  (select count(*) from shifts s where s."companyId" = co.id and s.status = 'in_progress'
     and s."end" > now() - interval '12 hours') as in_progress_live,
  (select count(*) from shifts s where s."companyId" = co.id and s.status = 'in_progress'
     and s."end" <= now() - interval '12 hours') as in_progress_stale
from companies co order by co.id;
```

## 6. Open decisions before activation

- **Legal scope:** how the 1 October 2026 Right to Work Scheme extension applies to companies engaging
  self-employed Guards or subcontractors, and to S4 as a platform. Needs legal advice.
- **Live-shift response:** S4 alerts but does not act. Each company needs its own procedure for a Guard whose
  check lapses on shift; this is not encoded in S4.
- **Members and other alerts:** company members (other than the owner account) still cannot see or act on panic,
  welfare, Missing Book Off, site request or incident alerts. That predates phase 1 and is unchanged.
- **Older clients:** Android vc14, iOS build 13 and a pre-phase-1 web build do not list Compliance alerts in the
  attention queue (they still receive the in-app notifications). Use the web.
- **Restrictions:** recorded work restrictions are shown as warnings and are not enforced.
- **Retention:** compliance checks and alerts are kept indefinitely; a retention period (the guide expects the
  employment period plus two years for check evidence) is still to be set.
- **Pre-existing issue:** a Guard can still create the other system-raised alert types (`missing_book_off`,
  `missed_checkcall`) through the Guard alert endpoint; only `compliance_lapse` is refused.
- **Company 8:** its stale `in_progress` test shift is left unchanged by decision. It is outside the compliance
  watch window and raises no Compliance alert.
