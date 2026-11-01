/**
 * S4 1.3.0 B1 rules, pure (no database, no app): the functions every reader and the sweep share.
 *
 *   PB1-01  shift-anchored windows: the shift's SCHEDULED start by default; Book On only by explicit override (no Book On
 *           = no windows); whole windows only; keys opaque, distinct per schedule version, shift and anchor
 *   PB1-02  overnight and UK DST in both directions: windows are real elapsed time (8 h / 9 h nights), never a duplicated
 *           or missing hour; a version boundary (frequency change) decides by window START
 *   PB1-03  applicability: late Book On, early Book Off and a cancelled shift (the shared operational rule)
 *   PB1-04  the shift patrol requirement matrix (every_shift / per_shift / off / not set up / not activated × site
 *           default / required / not required) and its plain-English summary
 *   PB1-05  route versions: the version in force at a window's start, the head, the same chain, content keys
 *   PB1-06  evidence modes ↔ policy methods / photosPerRun (photos stay yes / no, 0 / 1)
 *   PB1-07  evidence rules (owner decision 6) through the sweep's own runRequirements: photo-only, QR-only, QR + photos,
 *           no per-checkpoint photo on an automatic route, pending / rejected / quarantined / purged photos never count,
 *           QR without a route version never verified (A1)
 *   PB1-08  explainVerification: every code, plain English, the deadline on the site's clock
 *   PB1-09  the stamp: fields present (company, client, site, guard, both times distinct and zoned, P-ref, window,
 *           www.sfour.co.uk), ASCII-only text, glyph paths, and a real JPEG rendered by sharp without any font
 */
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

let passed = 0;
const failures: string[] = [];
const test = async (id: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL  ${id}\n      ${String((error as Error)?.stack ?? error).split('\n').slice(0, 10).join('\n      ')}`);
  }
};
const Z = (s: string) => new Date(s);
const MIN = 60_000;

async function main() {
  const SW = await import('../src/patrol/patrol-shift-windows');
  const RV = await import('../src/patrol/patrol-route-versions');
  const RE = await import('../src/patrol/patrol-run-evaluation');
  const SET = await import('../src/patrol/patrol-setup.service');
  const ST = await import('../src/patrol/evidence/patrol-evidence-stamp');
  const { OperationalWindowService } = await import('../src/operations/operational-window.service');
  const ops = new OperationalWindowService();
  const schedule = (over: Record<string, unknown> = {}) => ({
    id: 41, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], activeFrom: '00:00', activeTo: '00:00', frequencyMinutes: 60, windowMinutes: 60,
    startsOn: '2000-01-01', endsOn: '2000-01-01', ...over,
  });
  const shift = (start: string, end: string, id = 7) => ({ id, start: Z(start), end: Z(end) });
  const spans = (ws: Array<{ start: Date; end: Date }>) => ws.map((w) => `${w.start.toISOString().slice(11, 16)}-${w.end.toISOString().slice(11, 16)}`);

  await test('PB1-01-SCHEDULED-START-BY-DEFAULT-BOOK-ON-BY-OVERRIDE-WHOLE-WINDOWS-OPAQUE-KEYS', () => {
    const s = shift('2026-11-02T08:00:00Z', '2026-11-02T12:30:00Z');
    const scheduled = SW.shiftAnchoredWindows(schedule(), s, 'scheduled_start', Z('2026-11-02T08:40:00Z'), 'Europe/London');
    assert.deepEqual(spans(scheduled), ['08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00'], 'from the scheduled start; the 30-minute tail owes nothing');
    assert.deepEqual(scheduled.map((w) => w.windowKey), ['s41:sh7:20261102T0800Z:0', 's41:sh7:20261102T0800Z:1', 's41:sh7:20261102T0800Z:2', 's41:sh7:20261102T0800Z:3']);
    assert.ok(scheduled.every((w) => w.windowKey.length <= 64), 'fits patrol_runs.windowKey (64)');
    assert.deepEqual(scheduled.map((w) => w.localDate), ['2026-11-02', '2026-11-02', '2026-11-02', '2026-11-02']);
    const bookOn = SW.shiftAnchoredWindows(schedule(), s, 'book_on', Z('2026-11-02T08:40:00Z'), 'Europe/London');
    assert.deepEqual(spans(bookOn), ['08:40-09:40', '09:40-10:40', '10:40-11:40'], 'Book On override: from the Book On, never past the shift end');
    assert.ok(bookOn.every((w) => w.windowKey.includes(':20261102T0840Z:')), 'the anchor is part of the key');
    assert.deepEqual(SW.shiftAnchoredWindows(schedule(), s, 'book_on', null, 'Europe/London'), [], 'Book On override without a Book On: no window');
    assert.deepEqual(SW.shiftAnchoredWindows(schedule({ frequencyMinutes: 10 }), s, 'scheduled_start', null, 'Europe/London'), [], 'below 15 minutes: none');
    const moved = SW.shiftAnchoredWindows(schedule(), shift('2026-11-02T08:15:00Z', '2026-11-02T12:30:00Z'), 'scheduled_start', null, 'Europe/London');
    assert.ok(moved.every((w) => !scheduled.some((x) => x.windowKey === w.windowKey)), 'a moved scheduled start never reuses an earlier key');
    assert.notEqual(SW.shiftAnchoredWindows(schedule({ id: 42 }), s, 'scheduled_start', null, 'Europe/London')[0].windowKey, scheduled[0].windowKey, 'distinct per version');
    assert.equal(SW.shiftScopeKey(7), 'sh7');
    const late = SW.shiftWindowForStart(scheduled, Z('2026-11-02T09:10:00Z'), 15);
    assert.deepEqual([late?.window.slotIndex, late?.lateStart], [1, false]);
    const lateStart = SW.shiftWindowForStart(scheduled, Z('2026-11-02T12:10:00Z'), 15);
    assert.deepEqual([lateStart?.window.slotIndex, lateStart?.lateStart], [3, true], 'within the start grace of the last window');
    assert.equal(SW.shiftWindowForStart(scheduled, Z('2026-11-02T12:20:00Z'), 15), null, 'after the grace: no window');
  });

  await test('PB1-02-OVERNIGHT-AND-UK-DST-BOTH-WAYS-AND-VERSION-BOUNDS', () => {
    // Overnight 22:00–06:00 GMT: 8 windows, local dates of each window's start.
    const night = SW.shiftAnchoredWindows(schedule(), shift('2026-11-02T22:00:00Z', '2026-11-03T06:00:00Z'), 'scheduled_start', null, 'Europe/London');
    assert.equal(night.length, 8);
    assert.deepEqual([night[0].localDate, night[7].localDate], ['2026-11-02', '2026-11-03']);
    // Spring forward (29 Mar 2026, 01:00 GMT → 02:00 BST): 22:00 GMT to 07:00 BST is 8 real hours — 8 windows, none in the gap.
    const spring = SW.shiftAnchoredWindows(schedule(), shift('2026-03-28T22:00:00Z', '2026-03-29T06:00:00Z'), 'scheduled_start', null, 'Europe/London');
    assert.equal(spring.length, 8, 'eight real hours');
    assert.ok(spring.every((w) => w.end.getTime() - w.start.getTime() === 60 * MIN), 'every window is 60 real minutes');
    assert.equal(new Set(spring.map((w) => w.windowKey)).size, 8);
    // Fall back (25 Oct 2026, 02:00 BST → 01:00 GMT): 22:00 BST to 06:00 GMT is 9 real hours — 9 windows, the repeated hour counted once each.
    const autumn = SW.shiftAnchoredWindows(schedule(), shift('2026-10-24T21:00:00Z', '2026-10-25T06:00:00Z'), 'scheduled_start', null, 'Europe/London');
    assert.equal(autumn.length, 9, 'nine real hours');
    assert.ok(autumn.every((w, i) => i === 0 || w.start.getTime() === autumn[i - 1].end.getTime()), 'contiguous, no overlap');
    // A frequency change mid-shift (Migration 73 successor): the version in force at a window's START owns it.
    const at = Z('2026-11-02T01:30:00Z');
    const before = SW.shiftAnchoredWindows(schedule({ effectiveUntil: at }), shift('2026-11-01T22:00:00Z', '2026-11-02T06:00:00Z'), 'scheduled_start', null, 'Europe/London');
    const after = SW.shiftAnchoredWindows(schedule({ id: 43, frequencyMinutes: 30, windowMinutes: 30, effectiveFrom: at }), shift('2026-11-01T22:00:00Z', '2026-11-02T06:00:00Z'), 'scheduled_start', null, 'Europe/London');
    assert.deepEqual(spans(before), ['22:00-23:00', '23:00-00:00', '00:00-01:00', '01:00-02:00']);
    assert.equal(after[0].start.toISOString(), '2026-11-02T01:30:00.000Z', 'the successor\'s first window is its first slot (from the same anchor) at or after the change');
    assert.ok(after.every((w) => w.start.getTime() >= at.getTime()));
    assert.ok(after.every((w) => w.end.getTime() - w.start.getTime() === 30 * MIN));
  });

  await test('PB1-03-APPLICABILITY-LATE-BOOK-ON-EARLY-BOOK-OFF-CANCELLED', () => {
    const ws = SW.shiftAnchoredWindows(schedule(), shift('2026-11-02T08:00:00Z', '2026-11-02T14:00:00Z'), 'scheduled_start', null, 'Europe/London');
    const applicable = (a: { bookOnAt: Date | null; bookOffAt: Date | null; cancelled?: boolean }) =>
      spans(ws.filter((w) => ops.isApplicable({ index: w.slotIndex, start: w.start, end: w.end }, { ...a, shiftEnd: Z('2026-11-02T14:00:00Z'), cancelled: a.cancelled ?? false })));
    assert.deepEqual(applicable({ bookOnAt: Z('2026-11-02T08:00:00Z'), bookOffAt: null }).length, 6);
    assert.deepEqual(applicable({ bookOnAt: Z('2026-11-02T09:20:00Z'), bookOffAt: null })[0], '09:00-10:00', 'late Book On: owed from the window it falls in');
    assert.deepEqual(applicable({ bookOnAt: Z('2026-11-02T08:00:00Z'), bookOffAt: Z('2026-11-02T10:30:00Z') }), ['08:00-09:00', '09:00-10:00', '10:00-11:00'], 'early Book Off truncates');
    assert.deepEqual(applicable({ bookOnAt: Z('2026-11-02T08:00:00Z'), bookOffAt: null, cancelled: true }), [], 'a cancelled shift owes nothing');
    assert.deepEqual(applicable({ bookOnAt: null, bookOffAt: null }), [], 'never booked on: nothing owed');
  });

  await test('PB1-04-THE-SHIFT-PATROL-REQUIREMENT-MATRIX', () => {
    const active = (mode: any) => ({ setupMode: mode, setupConfirmedAt: Z('2026-10-01T00:00:00Z') });
    const r = (setting: any, setup: any) => {
      const v = SW.effectiveShiftRequirement(setting, setup);
      return `${v.value}/${v.effectiveRequired ? 'yes' : 'no'}/${v.source}`;
    };
    assert.deepEqual([null, 'required', 'not_required'].map((s) => r(s, active('every_shift'))),
      ['site_default/yes/site', 'required/yes/shift', 'not_required/no/shift'], 'every_shift: required unless the shift says not');
    assert.deepEqual([null, 'required', 'not_required'].map((s) => r(s, active('per_shift'))),
      ['site_default/no/site', 'required/yes/shift', 'not_required/no/shift'], 'per_shift: only shifts marked required');
    assert.deepEqual([null, 'required', 'not_required'].map((s) => r(s, active('off'))),
      ['site_default/no/site', 'required/no/shift', 'not_required/no/shift'], 'off: none, whatever the shift says');
    assert.deepEqual([null, 'required'].map((s) => r(s, { setupMode: null, setupConfirmedAt: null })), ['site_default/no/site', 'required/no/shift'], 'never set up: none');
    assert.deepEqual([null, 'required'].map((s) => r(s, { setupMode: 'every_shift', setupConfirmedAt: null })), ['site_default/no/site', 'required/no/shift'], 'saved, not activated: none');
    assert.equal(SW.effectiveShiftRequirement(null, active('every_shift')).summary, 'Patrols required (site default: every shift).');
    assert.equal(SW.effectiveShiftRequirement('required', active('per_shift')).summary, 'Patrols required (set on this shift).');
    assert.equal(SW.effectiveShiftRequirement(null, active('per_shift')).summary, 'No patrols (site default: only shifts marked as requiring patrols).');
    assert.equal(SW.effectiveShiftRequirement(null, { setupMode: 'every_shift', setupConfirmedAt: null }).summary, 'No patrols yet: the site\'s patrol setup has not been activated.');
    assert.equal(SW.setupActive(active('every_shift')), true);
    assert.equal(SW.setupActive(active('off')), false);
    assert.equal(SW.siteSetupOf({ windowAnchor: null }).windowAnchor, 'scheduled_start', 'NULL = scheduled start');
  });

  await test('PB1-05-ROUTE-VERSIONS-IN-FORCE-AT-A-WINDOW-START', () => {
    const links = new Map([[10, { successorId: 11, at: Z('2026-11-02T10:30:00Z') }], [11, { successorId: 12, at: Z('2026-11-02T12:00:00Z') }]]);
    assert.equal(RV.routeVersionAt(links, 10, Z('2026-11-02T10:00:00Z')), 10, 'a window that started before the change keeps the version then in force');
    assert.equal(RV.routeVersionAt(links, 10, Z('2026-11-02T10:30:00Z')), 11, 'at the change instant: the successor');
    assert.equal(RV.routeVersionAt(links, 10, Z('2026-11-02T13:00:00Z')), 12);
    assert.equal(RV.routeVersionAt(links, 11, Z('2026-11-02T09:00:00Z')), 11, 'never back to a predecessor');
    assert.equal(RV.routeHead(links, 10), 12);
    assert.equal(RV.routeVersionAt(links, null, Z('2026-11-02T13:00:00Z')), null);
    assert.equal(RV.sameRouteChain(links, 10, 12), true);
    assert.equal(RV.sameRouteChain(links, 12, 10), false);
    assert.equal(RV.sameRouteChain(links, 10, 99), false);
    const loop = new Map([[1, { successorId: 2, at: Z('2026-01-01T00:00:00Z') }], [2, { successorId: 1, at: Z('2026-01-01T00:00:00Z') }]]);
    assert.ok([1, 2].includes(RV.routeHead(loop, 1)!), 'a corrupt cycle terminates');
    assert.notEqual(RV.routeContentKey([{ checkpointId: 1 }, { checkpointId: 2 }], 'any'), RV.routeContentKey([{ checkpointId: 2 }, { checkpointId: 1 }], 'any'), 'order is content');
    assert.notEqual(RV.routeContentKey([{ checkpointId: 1, required: true }], 'any'), RV.routeContentKey([{ checkpointId: 1, required: false }], 'any'));
    assert.notEqual(RV.routeContentKey([{ checkpointId: 1 }], 'any'), RV.routeContentKey([{ checkpointId: 1 }], 'strict'));
  });

  await test('PB1-06-EVIDENCE-MODES-MAP-ONTO-METHODS-AND-PHOTOS-YES-NO', () => {
    assert.deepEqual(SET.evidenceModePolicy('qr'), { methods: ['qr'], photosPerRun: 0 });
    assert.deepEqual(SET.evidenceModePolicy('photo'), { methods: ['photo'], photosPerRun: 1 });
    assert.deepEqual(SET.evidenceModePolicy('qr_photo'), { methods: ['qr', 'photo'], photosPerRun: 1 });
    assert.equal(SET.evidenceModeOf({ methods: ['qr'], photosPerRun: 0 }), 'qr');
    assert.equal(SET.evidenceModeOf({ methods: ['qr'], photosPerRun: 1 }), 'qr_photo', 'a 1.2.1 QR policy asking for a run photo');
    assert.equal(SET.evidenceModeOf({ methods: ['photo'], photosPerRun: 0 }), 'photo');
    assert.equal(SET.evidenceModeOf({ methods: ['qr', 'photo'], photosPerRun: 1 }), 'qr_photo');
  });

  // A run, its route version and its evidence, through the sweep's own requirement rule.
  const ctx = (o: { kind?: string; route?: Array<{ id: number; required?: boolean; photoRequired?: boolean }>; visits?: number[]; photos?: Array<[string, string?]>; sitePhoto?: number[] }) => ({
    visits: (o.visits ?? []).map((cp, i) => ({ id: 100 + i, runId: 1, checkpointId: cp, result: 'verified' })),
    evidence: (o.photos ?? []).map(([upload, retention], i) => ({ id: 200 + i, runId: 1, visitId: null, kind: 'run_photo', uploadStatus: upload, retentionStatus: retention ?? 'active', sha256Stored: upload === 'verified' ? `${i}`.repeat(64).slice(0, 64) : null })),
    routeCheckpoints: (o.route ?? []).map((c) => ({ routeId: 5, checkpointId: c.id, required: c.required ?? true, photoRequired: c.photoRequired ?? false, label: `Gate ${c.id}`, kind: o.kind ?? 'auto' })),
    photoRequiredAtSite: o.sitePhoto ?? [],
    labels: new Map([[1, 'Gate 1'], [2, 'Gate 2'], [3, 'Gate 3']]),
    routeKinds: new Map([[5, o.kind ?? 'auto']]),
  });
  const policy = (mode: 'qr' | 'photo' | 'qr_photo') => ({ ...SET.evidenceModePolicy(mode), photosPerCheckpoint: 0 });
  const req = (mode: 'qr' | 'photo' | 'qr_photo', c: Parameters<typeof ctx>[0], routeId: number | null = 5) =>
    RE.runRequirements({ id: 1, routeId }, policy(mode), ctx(c) as any);
  const verdict = (r: any) => {
    const missing = r.missingCheckpointIds.length + r.missingRunPhotos + r.missingCheckpointPhotos + r.photosNotVerified;
    return r.anyFlaggedScan ? 'flagged' : missing === 0 && !r.qrRuleMissing ? 'verified' : 'not verified';
  };

  await test('PB1-07-EVIDENCE-RULES-PHOTO-ONLY-QR-ONLY-QR-AND-PHOTOS', () => {
    // Photo-only: ≥ 1 server-verified eligible photo; no checkpoint.
    assert.equal(verdict(req('photo', { photos: [['verified']] }, null)), 'verified');
    assert.equal(verdict(req('photo', { photos: [] }, null)), 'not verified', 'no photo');
    for (const [u, r] of [['pending'], ['uploaded'], ['rejected'], ['verified', 'quarantined'], ['verified', 'purged'], ['verified', 'tombstone']] as Array<[string, string?]>) {
      assert.equal(verdict(req('photo', { photos: [[u, r]] }, null)), 'not verified', `${u}/${r ?? 'active'} never counts`);
    }
    assert.equal(verdict(req('photo', { photos: [['rejected'], ['verified']] }, null)), 'verified', 'one good photo is enough');
    // QR-only: the route version's checkpoints scanned; no photo needed.
    assert.equal(verdict(req('qr', { route: [{ id: 1 }, { id: 2 }], visits: [1, 2] })), 'verified');
    assert.deepEqual(req('qr', { route: [{ id: 1 }, { id: 2 }], visits: [1] }).missingCheckpointIds, [2]);
    assert.equal(req('qr', { route: [], visits: [1] }).qrRuleMissing, true, 'an EMPTY automatic version: no rule, never verified (A1)');
    assert.equal(req('qr', { visits: [1] }, null).qrRuleMissing, true, 'no route version at all: never verified (A1)');
    // QR + photos: the set scanned AND ≥ 1 verified photo per patrol; no per-checkpoint photo on an automatic route.
    assert.equal(verdict(req('qr_photo', { route: [{ id: 1, photoRequired: true }], visits: [1], photos: [['verified']], sitePhoto: [1] })), 'verified',
      'a checkpoint\'s own photo setting asks nothing on an automatic route');
    assert.equal(verdict(req('qr_photo', { route: [{ id: 1 }], visits: [1], photos: [['pending']] })), 'not verified', 'a pending photo does not count');
    assert.equal(verdict(req('qr_photo', { route: [{ id: 1 }], visits: [1], photos: [] })), 'not verified', 'no photo');
    assert.equal(verdict(req('qr_photo', { route: [{ id: 1 }], visits: [], photos: [['verified']] })), 'not verified', 'checkpoint missing');
    // A chosen (custom) route keeps 1.2.1's per-checkpoint photo setting exactly.
    assert.equal(req('qr_photo', { kind: 'custom', route: [{ id: 1, photoRequired: true }], visits: [1], photos: [['verified']] }).missingCheckpointPhotos, 1,
      'custom route: the checkpoint\'s own photo is still required (unchanged from 1.2.1)');
  });

  await test('PB1-08-EXPLAIN-VERIFICATION-EVERY-CODE-IN-PLAIN-ENGLISH', () => {
    const pol = { maxPatrolDurationMinutes: 45, completionGraceMinutes: 30, syncGraceMinutes: 60, methods: ['qr', 'photo'] };
    const run = (o: Record<string, unknown> = {}) => ({ status: 'completed', verificationStatus: 'pending', startedAtDevice: '2026-11-02T14:00:00Z', windowEnd: '2026-11-02T15:00:00Z', exceptionReason: null, ...o });
    const base = { missingCheckpointIds: [] as number[], missingRunPhotos: 0, missingCheckpointPhotos: 0, photosNotVerified: 0, photosNotOnServer: 0, anyFlaggedScan: false, qrRuleMissing: false, duplicateEvidenceIds: [] as number[] };
    const ex = (r: any, req: any, now = '2026-11-02T14:50:00Z', evidence: any[] = [], tz = 'Europe/London') =>
      RE.explainVerification({ run: run(r), policy: pol, requirements: req, evidence, labels: new Map([[2, 'Gate 2'], [3, 'Gate 3']]), now: Z(now), timeZone: tz });
    // Completion deadline min(14:00 + 45, 15:00 + 30) = 14:45 UTC = 14:45 GMT; sync deadline 15:45.
    assert.deepEqual(ex({ status: 'in_progress' }, null), { code: 'in_progress', text: 'Patrol in progress (to be completed by 14:45).', deadline: '2026-11-02T14:45:00.000Z' });
    assert.equal(ex({ status: 'closed_by_system' }, null).code, 'closed_by_system');
    assert.deepEqual(ex({ verificationStatus: 'verified' }, base), { code: 'verified', text: 'Verified: every required checkpoint was scanned and the patrol photo reached S4.', deadline: null });
    assert.equal(ex({}, { ...base, anyFlaggedScan: true }).code, 'scan_flagged');
    assert.deepEqual(ex({}, { ...base, qrRuleMissing: true }),
      { code: 'setup_incomplete', text: 'Site setup incomplete: no confirmed checkpoints, so this patrol cannot be verified from QR scans.', deadline: null });
    assert.equal(ex({}, { ...base, missingCheckpointIds: [2] }).text, 'Checkpoint \'Gate 2\' not scanned.');
    assert.equal(ex({}, { ...base, missingCheckpointIds: [2, 3] }).text, 'Checkpoints \'Gate 2\' and \'Gate 3\' not scanned.');
    assert.equal(ex({}, { ...base, missingRunPhotos: 1 }).code, 'photo_not_taken');
    assert.equal(ex({}, { ...base, missingRunPhotos: 1 }, undefined, [{ uploadStatus: 'rejected' }]).code, 'photo_rejected');
    assert.deepEqual(ex({}, { ...base, photosNotVerified: 1 }, '2026-11-02T15:00:00Z', [{ uploadStatus: 'pending' }]),
      { code: 'awaiting_photos', text: 'Waiting for photos to upload (deadline 15:45).', deadline: '2026-11-02T15:45:00.000Z' });
    assert.equal(ex({}, { ...base, photosNotVerified: 1 }, '2026-11-02T15:45:00Z', [{ uploadStatus: 'pending' }]).text, 'Photos did not reach S4 by the deadline (15:45).');
    assert.equal(ex({}, { ...base, photosNotVerified: 1 }, undefined, [{ uploadStatus: 'verified', retentionStatus: 'purged' }]).code, 'photo_removed');
    assert.equal(ex({ status: 'incomplete', exceptionReason: 'Gate locked' }, base).text, 'Completed with a reason: "Gate locked".');
    assert.equal(ex({}, base).code, 'awaiting_check');
    // The site's clock: in BST (summer) the sync deadline 14:45 UTC reads 15:45.
    assert.equal(RE.explainVerification({ run: run({ startedAtDevice: '2026-07-02T13:00:00Z', windowEnd: '2026-07-02T14:00:00Z' }), policy: pol,
      requirements: { ...base, photosNotVerified: 1 }, evidence: [{ uploadStatus: 'pending' }], labels: new Map(), now: Z('2026-07-02T13:50:00Z'), timeZone: 'Europe/London' }).text,
    'Waiting for photos to upload (deadline 15:45).');
  });

  await test('PB1-09-THE-STAMP-FIELDS-ASCII-GLYPHS-AND-A-REAL-JPEG-WITHOUT-FONTS', async () => {
    const fields = {
      companyName: 'Sécurité Shield – North Ltd', clientName: 'Harbour Estates', siteName: 'Quay Gate', guardName: 'Ava Okafor',
      capturedAtDevice: Z('2026-07-02T13:32:05Z'), receivedAtServer: Z('2026-07-02T13:40:11Z'), timeZone: 'Europe/London', runId: 123,
      window: { start: Z('2026-07-02T13:00:00Z'), end: Z('2026-07-02T14:00:00Z'), name: 'Shift patrol' },
    };
    const { title, lines } = ST.stampLines(fields);
    assert.equal(title, 'Securite Shield - North Ltd', 'the company name, prominent (accents and dashes transliterated)');
    assert.deepEqual(lines, [
      'Client: Harbour Estates | Site: Quay Gate',
      'Guard: Ava Okafor',
      'Captured (device): 02 Jul 2026 14:32:05 BST',
      'Received by S4 (server): 02 Jul 2026 14:40:11 BST',
      'Patrol P-123 | Window 14:00-15:00 (Shift patrol)',
      'Times in Europe/London | www.sfour.co.uk',
    ]);
    assert.notEqual(lines[2].split(': ')[1], lines[3].split(': ')[1], 'device capture and server receipt are two distinct times');
    assert.ok([title, ...lines].every((l) => /^[\x20-\x7E]*$/.test(l)), 'printable ASCII only');
    assert.equal(ST.stampTime(Z('2026-12-02T13:32:05Z'), 'Europe/London'), '02 Dec 2026 13:32:05 GMT', 'GMT in winter');
    assert.match(ST.stampLines({ ...fields, window: null, clientName: null }).lines[4], /P-123 \| Unscheduled patrol$/);
    assert.equal(ST.stampText('aé—b’c中'), 'ae-b\'c?');
    // Glyph paths: a known glyph's cells, merged per row.
    assert.equal(ST.textPath('-', 0, 0, 1), 'M0 3h5v1h-5z', 'the dash is one row of five cells');
    assert.equal(ST.textPath('I', 10, 0, 2).split('M').length - 1, 7, 'one run per row of the I');
    const { svg, bandHeight, scale } = ST.stampSvg(1600, 1200, { title, lines });
    assert.ok(scale >= 2 && bandHeight < 1200 * 0.45 && /<path d="M/.test(svg) && !/<text|font/i.test(svg), 'paths only — no <text>, no font');
    // A real JPEG through sharp: the original bytes are untouched and the stamp darkens the bottom band only.
    const sharp = require('sharp');
    const original: Buffer = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
    const sha = createHash('sha256').update(original).digest('hex');
    const copy = Buffer.from(original);
    const { jpeg, width, height } = await ST.renderStampedJpeg(original, fields);
    assert.equal(createHash('sha256').update(original).digest('hex'), sha, 'the original buffer is never modified');
    assert.ok(original.equals(copy));
    assert.deepEqual([width, height], [800, 600]);
    assert.deepEqual([jpeg[0], jpeg[1], jpeg[2]], [0xff, 0xd8, 0xff], 'a JPEG');
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    assert.ok(px(400, 50) > 180, 'the top of the photo is untouched (still light)');
    const band = ST.stampSvg(800, 600, ST.stampLines(fields));
    let dark = 0;
    let light = 0;
    for (let y = 600 - band.bandHeight + 1; y < 599; y += 1) for (let x = 0; x < 800; x += 2) (px(x, y) < 120 ? (dark += 1) : px(x, y) > 200 ? (light += 1) : 0);
    assert.ok(dark > 1000, `the band is darkened (${dark})`);
    assert.ok(light > 200, `white text is drawn without any font (${light} light pixels in the band)`);
    // EXIF orientation 6 (rotated): the stamp is drawn on the upright image.
    const rotated: Buffer = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#888888' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const upright = await ST.renderStampedJpeg(rotated, fields);
    assert.deepEqual([upright.width, upright.height], [200, 300], 'axes swapped for orientation 6');
    await assert.rejects(() => ST.renderStampedJpeg(Buffer.from('not an image'), fields), 'an undecodable original throws (the API answers 422)');
  });

  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
  console.log(JSON.stringify({ event: 'patrol_b1_rules_certified', tests: passed }));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
