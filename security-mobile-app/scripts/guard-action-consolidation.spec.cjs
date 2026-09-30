#!/usr/bin/env node
/**
 * One action model, and nothing lost on the way. (Phase 3C.)
 *
 * WHAT WAS WRONG
 * The active shift offered Add Log, Check Call, Incident, Welfare and Panic in one grid labelled
 * LOG / CALL / INC / CARE / SOS, and then offered Report incident and Record check call AGAIN in a second
 * "On-shift reporting" block, under copy explaining that the same form was also available elsewhere.
 * Two of the five actions had two launchers, and Check Call and Welfare were two names for the one thing
 * a guard calls a welfare check.
 *
 * WHAT THIS SUITE COVERS
 * The half of Phase 3C that is NOT about dispatch — dispatch is executed in guard-action-dispatch.spec.cjs
 * and the launcher/vocabulary certification lives in guard-action-forms.spec.cjs. Here: the legacy
 * compatibility rules, which are the ones that could silently lose a company's records, and the Company
 * presentation of the new canonical actions.
 *
 * The legacy rules are EXECUTED, because they are the dangerous half. Recognising only the new log type
 * would have made every Welfare Check recorded before this change invisible, on both surfaces.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const evidence = loadTs('src/components/shifts/welfareEvidence.ts');
const forms = loadTs('src/components/guard/guardActionForms.ts');
const policy = loadTs('src/components/company/liveOperationsPolicy.ts');
const { WELFARE_EVIDENCE_LOG_TYPES, isWelfareEvidence, lastWelfareEvidence } = evidence;
const { GUARD_ACTION_FORMS } = forms;
const { PERSISTED_ATTENTION_CATEGORIES, DERIVED_ATTENTION_CATEGORIES } = policy;

const COMPANY_SCREEN = 'src/screens/CompanyDashboardScreen.tsx';
const LIVE_OPS = 'src/components/company/CompanyLiveOperationsWorkspace.tsx';
const GUARD_SCREEN = 'src/screens/GuardDashboardScreen.tsx';

// ─── Legacy Welfare evidence ──────────────────────────────────────────────────

test('LEGACY-01-BOTH-LOG-TYPES-COUNT-AS-A-WELFARE-CHECK', () => {
  // Mirrors the backend's WELFARE_COMPLETION_LOG_TYPES. `welfare_check` is what the app writes now;
  // `check_call` is what it wrote before, and a shift worked yesterday must still read as complete.
  assert.deepEqual([...WELFARE_EVIDENCE_LOG_TYPES].sort(), ['check_call', 'welfare_check']);
  assert.equal(isWelfareEvidence({ logType: 'welfare_check' }), true);
  assert.equal(isWelfareEvidence({ logType: 'check_call' }), true, 'the legacy type is still evidence');
});

test('LEGACY-02-NOTHING-ELSE-DISCHARGES-A-WELFARE-OBLIGATION', () => {
  // The distinction the types exist to make: a Log Book entry or a voluntary observation is not a
  // Welfare Check, and must never be allowed to satisfy one.
  for (const other of ['log_book', 'observation', 'patrol', 'visitor', 'delivery', 'maintenance', 'other', '']) {
    assert.equal(isWelfareEvidence({ logType: other }), false, `${other} must not count`);
  }
  assert.equal(isWelfareEvidence(null), false);
  assert.equal(isWelfareEvidence(undefined), false);
});

test('LEGACY-03-A-SHIFT-WORKED-ACROSS-THE-UPGRADE-READS-CORRECTLY', () => {
  // The case that breaks a naive fix: one shift carrying both vocabularies. The most recent evidence is
  // the most recent evidence, whichever type it happens to be, and whatever order it arrives in.
  const logs = [
    { logType: 'check_call', createdAt: '2026-09-30T20:00:00.000Z' },
    { logType: 'log_book', createdAt: '2026-09-30T22:30:00.000Z' },
    { logType: 'welfare_check', createdAt: '2026-09-30T21:00:00.000Z' },
    { logType: 'observation', createdAt: '2026-09-30T23:00:00.000Z' },
  ];
  assert.equal(lastWelfareEvidence(logs).logType, 'welfare_check');
  assert.equal(lastWelfareEvidence(logs).createdAt, '2026-09-30T21:00:00.000Z');

  // Reversed input, same answer: order is not trusted, because both types arrive interleaved from one
  // endpoint.
  assert.equal(lastWelfareEvidence([...logs].reverse()).createdAt, '2026-09-30T21:00:00.000Z');

  // A shift entirely on the old vocabulary still resolves.
  const legacyOnly = [
    { logType: 'check_call', createdAt: '2026-09-29T20:00:00.000Z' },
    { logType: 'check_call', createdAt: '2026-09-29T21:00:00.000Z' },
  ];
  assert.equal(lastWelfareEvidence(legacyOnly).createdAt, '2026-09-29T21:00:00.000Z');

  // And a shift with no evidence at all is undefined, not a crash and not a false completion.
  assert.equal(lastWelfareEvidence([{ logType: 'log_book', createdAt: '2026-09-30T22:30:00.000Z' }]), undefined);
  assert.equal(lastWelfareEvidence([]), undefined);
});

test('LEGACY-04-THE-COMPANY-SIDE-USES-THE-SHARED-RECOGNISER', () => {
  // Phase 3D moved Welfare TIMING to the backend's window engine, so the Guard screen decides nothing
  // about welfare and no longer needs this. What still counts and labels daily-log rows directly is the
  // company side, which is why the module moved out of guard/ and into the shared shifts folder.
  const company = codeOf(COMPANY_SCREEN);
  assert.ok(
    company.includes("from '../components/shifts/welfareEvidence'"),
    'the company screen imports the shared recogniser',
  );
  assert.ok(company.includes('shiftLogs.filter(isWelfareEvidence)'), 'the close-out count uses it');
  assert.ok(company.includes('isWelfareEvidence(log)'), 'and so does the activity feed');

  // The Guard screen must not have kept a check_call-only recogniser behind.
  const guard = codeOf(GUARD_SCREEN);
  assert.ok(!guard.includes("entry.logType === 'check_call'"), 'no single-type filter in the Guard screen');
  assert.ok(!guard.includes('welfareEvidence'), 'and no stale import of the recogniser');
});

test('LEGACY-05-THE-COMPANY-CLOSE-OUT-COUNTS-BOTH-TYPES', () => {
  // Same risk on the company side: counting one type would have under-reported every completed shift
  // from the day this shipped.
  const company = codeOf(COMPANY_SCREEN);
  assert.ok(
    company.includes('shiftLogs.filter(isWelfareEvidence).length'),
    'the close-out summary must count both Welfare log types, via the shared rule',
  );
  assert.ok(
    !company.includes("shiftLogs.filter((log) => log.logType === 'check_call')"),
    'the single-type count must be gone',
  );
});

// ─── Company presentation of the canonical actions ────────────────────────────

test('COMPANY-01-SITE-REQUEST-IS-A-CLASSIFIED-ATTENTION-ITEM', () => {
  // Executable: the policy must place it, or it would fall through the derived/persisted split. It is
  // PERSISTED — a real safety_alerts row with an open/acknowledged/closed lifecycle — so it must never be
  // expired by schedule the way a derived coverage gap is.
  assert.ok(PERSISTED_ATTENTION_CATEGORIES.includes('site_request'));
  assert.ok(!DERIVED_ATTENTION_CATEGORIES.includes('site_request'));
});

test('COMPANY-02-SITE-REQUEST-NEVER-RENDERS-AS-A-FALLBACK', () => {
  // A control room reading "Safety / welfare needs attention" against a request for log books learns
  // nothing, and reading "Alert" or "site request" from a default branch learns less.
  const live = codeOf(LIVE_OPS);
  const company = codeOf(COMPANY_SCREEN);

  assert.ok(live.includes("case 'site_request':     return 'Site Request';"), 'the rail badge names it');
  assert.ok(company.includes("case 'site_request':      return 'Site Request';"), 'so does the screen badge');
  assert.ok(live.includes("case 'site_request':    return"), 'and it has its own primary action');
  assert.ok(company.includes("issueType: 'Site Request',"), 'the queue item is named, not defaulted');

  // It must be a category in its own right on both sides, not folded into the generic safety bucket.
  for (const [name, src] of [['workspace', live], ['screen', company]]) {
    assert.ok(src.includes("| 'site_request'"), `${name} must declare the category`);
  }
  assert.ok(
    !company.includes("['welfare', 'site_request', 'late_checkin', 'missing_book_off', 'other']"),
    'site_request must no longer be swept into the generic safety filter',
  );
});

test('COMPANY-03-THE-ACTIVITY-FEED-NAMES-THE-CANONICAL-RECORDS', () => {
  const company = codeOf(COMPANY_SCREEN);
  // Historical check_call rows read as the Welfare Checks they are — one wording for one thing.
  assert.ok(
    company.includes("['check_call', 'welfare_check'].includes(log.logType)"),
    'both Welfare log types read as a Welfare Check',
  );
  assert.ok(company.includes("'Welfare Check recorded'"), 'named with the canonical vocabulary');
  assert.ok(company.includes("'Log Book entry added'"), 'and Log Book has its own wording');
  // `observation` keeps its generic wording, because that is what it was. Nothing rewrites old data.
  assert.ok(company.includes("'Log entry added'"), 'legacy observations stay readable');
  assert.ok(!company.includes("'Check call recorded'"), 'the old split wording is gone');
});

test('COMPANY-04-EVERY-CANONICAL-GUARD-ACTION-HAS-A-COMPANY-SURFACE', () => {
  // Each of the five actions writes a record the company already reads: daily logs for the first two,
  // safety alerts for Site Request and Emergency, incidents for Incident. This asserts the company side
  // actually names all five rather than leaving one to a default branch.
  const live = codeOf(LIVE_OPS);
  const company = codeOf(COMPANY_SCREEN);
  const both = live + company;
  const expected = ['Welfare Check', 'Log Book', 'Site Request', 'Incident'];
  for (const name of expected) {
    assert.ok(both.includes(name), `the company surface must name ${name}`);
  }
  // Emergency is SafetyAlertType.PANIC on the wire and the company rail has always called it Critical;
  // that is unchanged on purpose, so the alert history keeps reading as it did.
  assert.ok(live.includes("case 'panic':            return 'Critical';"), 'panic keeps its company label');

  assert.equal(GUARD_ACTION_FORMS.length, 5, 'and there are exactly five actions to account for');
});

console.log(`\n${passed} action consolidation checks passed`);
