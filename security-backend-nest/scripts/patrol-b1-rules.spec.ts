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
 *   PB1-05  route versions: the version in force at a window's start whichever version the schedule names (it names the
 *           current one), the root and the head, the same chain either way round, content keys
 *   PB1-06  evidence modes ↔ policy methods / photosPerRun (photos stay yes / no, 0 / 1)
 *   PB1-07  evidence rules (owner decision 6) through the sweep's own runRequirements: photo-only, QR-only, QR + photos,
 *           no per-checkpoint photo on an automatic route, pending / rejected / quarantined / purged photos never count,
 *           QR without a route version never verified (A1)
 *   PB1-08  explainVerification: every code, plain English, the deadline on the site's clock
 *   PB1-09  the stamp (S4 patrol assignment correctness, owner-approved 3 Nov 2026): a compact translucent corner panel
 *           — company, site, Guard, device capture time, then P-ref, photo number and sfour.co.uk — in Inter drawn as
 *           paths (no system font); at most STAMP_MAX_AREA of the photo and about half its width; the photo outside it
 *           unchanged and the original buffer untouched; a band below the photo only when it is too small; no wording
 *           implying a person reviewed it; EXIF orientation; an undecodable image throws
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
    // A schedule names the CURRENT version (12); the window still owes the version in force at its start.
    for (const named of [10, 11, 12]) {
      assert.deepEqual([Z('2026-11-02T09:00:00Z'), Z('2026-11-02T11:00:00Z'), Z('2026-11-02T12:00:00Z')].map((at) => RV.routeVersionAt(links, named, at)), [10, 11, 12],
        `the same answer whichever version (${named}) the schedule names`);
    }
    assert.equal(RV.routeRoot(links, 12), 10);
    assert.equal(RV.routeHead(links, 10), 12);
    assert.equal(RV.routeVersionAt(links, null, Z('2026-11-02T13:00:00Z')), null);
    assert.equal(RV.routeVersionAt(links, 77, Z('2026-11-02T13:00:00Z')), 77, 'a route never versioned is itself');
    assert.equal(RV.sameRouteChain(links, 10, 12), true);
    assert.equal(RV.sameRouteChain(links, 12, 10), true, 'either way round');
    assert.equal(RV.sameRouteChain(links, 10, 99), false);
    const loop = new Map([[1, { successorId: 2, at: Z('2026-01-01T00:00:00Z') }], [2, { successorId: 1, at: Z('2026-01-01T00:00:00Z') }]]);
    assert.ok([1, 2].includes(RV.routeHead(loop, 1)!), 'a corrupt cycle terminates');
    assert.ok([1, 2].includes(RV.routeRoot(loop, 1)) && [1, 2].includes(RV.routeVersionAt(loop, 1, Z('2026-02-01T00:00:00Z'))!), 'backwards too');
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
    // A route-less patrol: the checkpoint's own photo counts at a site without a setup (1.2.1), never at an active setup site.
    const routeless = (setup: boolean) => RE.runRequirements({ id: 1, routeId: null, siteId: 3 }, policy('qr_photo'),
      { ...(ctx({ visits: [1], photos: [['verified']], sitePhoto: [1] }) as any), setupSites: new Set(setup ? [3] : []) });
    assert.equal(routeless(false).missingCheckpointPhotos, 1, 'no setup: as in 1.2.1');
    assert.equal(routeless(true).missingCheckpointPhotos, 0, 'active setup: no per-checkpoint photo');
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

  await test('PB1-09-THE-STAMP-A-COMPACT-CORNER-PANEL-ORIGINAL-UNTOUCHED-BAND-ONLY-WHEN-TOO-SMALL', async () => {
    const fields = {
      companyName: 'Sécurité Shield – North Ltd', clientName: 'Harbour Estates', siteName: 'Quay Gate', guardName: 'Ava Okafor',
      capturedAtDevice: Z('2026-07-02T13:32:05Z'), receivedAtServer: Z('2026-07-02T13:40:11Z'), timeZone: 'Europe/London', runId: 123, evidenceId: 15,
      window: { start: Z('2026-07-02T13:00:00Z'), end: Z('2026-07-02T14:00:00Z'), name: 'Shift patrol' },
    };
    // The lines: company, site, Guard, device capture time — then one small reference line. Server receipt time, the
    // window and the fingerprint stay in the evidence viewer.
    const lines = ST.stampLines(fields, 20);
    assert.deepEqual(lines.map((l) => l.text), [
      'Sécurité Shield – North Ltd',
      'Quay Gate',
      'Ava Okafor',
      '02 Jul 2026 14:32:05 BST  ·  device time',
      'Patrol P-123  ·  Photo #15  ·  sfour.co.uk',
    ], 'accents and dashes kept (Inter covers them); the device time on the site\'s clock with its zone');
    assert.ok(lines[0].size > lines[3].size && lines[3].size > lines[4].size, 'the company is largest; the reference line smallest');
    assert.deepEqual(lines.map((l) => l.weight), [600, 600, 400, 400, 400]);
    const words = lines.map((l) => l.text).join(' ');
    assert.doesNotMatch(words, /verif|review|approv|confirm|check/i, 'no wording that implies a person reviewed the photograph');
    assert.doesNotMatch(words, /https?:|:\/\//i, 'no protocol prefix');
    assert.doesNotMatch(words, /14:40:11/, 'the server receipt time is in the viewer, not on the photo');
    assert.equal(ST.stampTime(Z('2026-12-02T13:32:05Z'), 'Europe/London'), '02 Dec 2026 13:32:05 GMT', 'GMT in winter');
    assert.equal(ST.stampText('a\u0007b\n  c'), 'a b c', 'control characters and runs of whitespace collapse');
    assert.ok(ST.measureText('中', 400, 20) > 0, 'a character outside the fonts is drawn as "?" rather than failing');
    // A long name is shortened with "…" to fit the panel, never overflowing it.
    const long = ST.stampLayout(800, 600, { ...fields, companyName: 'An Exceptionally Long Security Company Name That Never Ends Limited' });
    assert.ok(long.lines[0].text.endsWith('…') && long.box.width <= 800 * 0.45, 'shortened to fit under half the photo\'s width');

    const sharp = require('sharp');
    const gradient = (w: number, h: number) => {
      const raw = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3;
        raw[i] = Math.round(40 + (180 * x) / w); raw[i + 1] = Math.round(60 + (160 * y) / h); raw[i + 2] = 200;
      }
      return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer() as Promise<Buffer>;
    };
    const decode = async (b: Buffer) => sharp(b).rotate().raw().toBuffer({ resolveWithObject: true });
    const check = async (w: number, h: number, what: string) => {
      const original = await gradient(w, h);
      const sha = createHash('sha256').update(original).digest('hex');
      const copy = Buffer.from(original);
      const out = await ST.renderStampedJpeg(original, fields);
      assert.equal(createHash('sha256').update(original).digest('hex'), sha, `${what}: the original's bytes (and SHA-256) are never modified`);
      assert.ok(original.equals(copy));
      assert.deepEqual([out.jpeg[0], out.jpeg[1], out.jpeg[2]], [0xff, 0xd8, 0xff], `${what}: a JPEG`);
      const { layout } = out;
      assert.ok(/<path d="M/.test(layout.svg) && !/<text|font-family|@font-face|<image|href=/i.test(layout.svg), `${what}: vector paths only — no system font, no external reference`);
      const stamped = await sharp(out.jpeg).raw().toBuffer({ resolveWithObject: true });
      const src = await decode(original);
      const inBox = (x: number, y: number) => x >= layout.box.x && x < layout.box.x + layout.box.width && y >= layout.box.y && y < layout.box.y + layout.box.height;
      // Everything outside the stamp matches the source within JPEG re-encoding tolerance.
      let worst = 0; let sum = 0; let count = 0; let darker = 0; let inside = 0;
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          const d = Math.abs(stamped.data[(y * w + x) * stamped.info.channels + c] - src.data[(y * w + x) * src.info.channels + c]);
          if (!inBox(x, y)) { worst = Math.max(worst, d); sum += d; count += 1; }
        }
        if (layout.mode === 'overlay' && inBox(x, y)) {
          inside += 1;
          if (stamped.data[(y * w + x) * stamped.info.channels + 2] < src.data[(y * w + x) * src.info.channels + 2] - 40) darker += 1;
        }
      }
      assert.ok(sum / count < 3 && worst < 60, `${what}: the photo outside the stamp is unchanged (mean ${(sum / count).toFixed(2)}, worst ${worst})`);
      if (layout.mode === 'overlay') {
        assert.deepEqual([stamped.info.width, stamped.info.height, out.bandHeight], [w, h, 0], `${what}: the photo's own size`);
        const area = (layout.box.width * layout.box.height) / (w * h);
        assert.ok(area <= ST.STAMP_MAX_AREA, `${what}: the panel covers at most ${ST.STAMP_MAX_AREA * 100}% (${(area * 100).toFixed(1)}%)`);
        assert.ok(layout.box.width <= w * (h > w ? 0.62 : 0.45), `${what}: never wider than about half the photo`);
        assert.ok(layout.box.x > 0 && layout.box.y + layout.box.height < h && layout.box.x < w * 0.1, `${what}: in the bottom-left corner, inside the photo`);
        assert.ok(darker > inside * 0.5, `${what}: a dark translucent panel behind the text (${darker}/${inside})`);
        assert.ok(layout.base >= 12, `${what}: readable text (${layout.base}px)`);
      } else {
        assert.deepEqual([stamped.info.width, stamped.info.height], [w, h + out.bandHeight], `${what}: a band appended below — nothing drawn over the photo`);
      }
      return out;
    };
    const landscape = await check(800, 600, 'landscape');
    assert.equal(landscape.layout.mode, 'overlay');
    assert.equal((await check(600, 900, 'portrait')).layout.mode, 'overlay');
    const phone = await check(640, 480, 'a small phone photo');
    assert.ok(phone.layout.mode === 'overlay' && phone.layout.base >= 12, `640 × 480 still gets the corner panel at a readable size (${phone.layout.base}px)`);
    const tiny = await check(160, 120, 'tiny');
    assert.equal(tiny.layout.mode, 'band', 'too small for a corner panel within the bounds: the band below the photo');
    const big = ST.stampLayout(4032, 3024, fields);
    assert.ok(big.mode === 'overlay' && big.base >= 40 && (big.box.width * big.box.height) / (4032 * 3024) < 0.05, `a 12 MP photo: large, legible text in a small corner (${big.base}px)`);
    // EXIF orientation 6 (rotated): the stamp is laid out on the upright image.
    const rotated: Buffer = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#888888' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const upright = await ST.renderStampedJpeg(rotated, fields);
    assert.deepEqual([upright.width, upright.height], [400, 600], 'axes swapped for orientation 6');
    const uprightInfo = await sharp(upright.jpeg).metadata();
    assert.deepEqual([uprightInfo.width, uprightInfo.height, uprightInfo.orientation ?? 1], [400, 600 + upright.bandHeight, 1], 'upright (with any band below it), no orientation tag');
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
