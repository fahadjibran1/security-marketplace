#!/usr/bin/env node
/**
 * Replace Guard from BOTH company entry points: the Shift Offers drawer and the Rota Planner's Guard positions.
 *
 * WHY THIS EXISTS
 * Replace Guard shipped (27d2500) only inside the Shift Offers drawer, and it simply vanished whenever the client
 * thought the server would refuse — so the owner, looking at a shift in the Rota Planner (which had only Cancel beside
 * a Guard position), had no way to replace a Guard there and no way to learn why it was not offered. This certifies:
 *
 *   - one implementation: the availability rules (replaceGuard.ts) and the form (ReplaceGuardForm.tsx) are shared, and
 *     neither workspace keeps its own copy;
 *   - every state either offers Replace Guard or shows it disabled with a specific one-line reason (Awaiting, Accepted
 *     before start, Accepted and started within / after the 15-minute grace, Booked On, Completed, ended, cancelled,
 *     declined, marketplace hire, no other active Guards);
 *   - the server's refusal (e.g. REPLACE_GUARD_HIRE_LINKED, the fatigue acknowledgement) is shown in the form;
 *   - Cancel Position, Withdraw Offer and Replace Guard are separate controls and Replace never cancels;
 *   - after a replacement both views re-read, so the incoming Guard shows as Awaiting.
 *
 * WHAT IS EXECUTED
 * The real CompanyShiftOffersWorkspace and CompanyRotaPlannerWorkspace, rendered on react-native-web through
 * react-test-renderer and driven by presses, with only the Modal PRIMITIVE substituted (react-native-web's renders
 * through a DOM portal the test renderer cannot mount) — the same approach as guard-shift-offers.spec.cjs. The
 * dashboard wiring (one handler, one refresh) is checked by reading the screen's source.
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

/** The Modal primitive only: children when visible, nothing when not. Everything else is react-native-web. */
function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
const RN_SHIM = { ...RNW, Modal: TestModal };
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  if (request === 'react-native-safe-area-context') {
    return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
  }
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The company dashboard ships on the WEB, so it is rendered with its web layout (IS_WEB is `typeof document !== 'undefined'`).
// react-native-web's TextInput only reads document.activeElement.
if (typeof globalThis.document === 'undefined') globalThis.document = { activeElement: null };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TestRenderer = require('react-test-renderer');
const ts = require('typescript');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

/** One module cache for every component, so `Button` here is the same function the workspaces render. */
const cache = new Map();
function loadComponent(rel) {
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), request);
        for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
          if (fs.existsSync(c)) return load(c);
        }
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(ROOT, rel));
}

const rules = loadComponent('src/components/company/replaceGuard.ts');
const { CompanyShiftOffersWorkspace } = loadComponent('src/components/company/CompanyShiftOffersWorkspace.tsx');
const { CompanyRotaPlannerWorkspace } = loadComponent('src/components/company/CompanyRotaPlannerWorkspace.tsx');
const { Button } = loadComponent('src/components/ui/Button.tsx');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const backend = (rel) => fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', rel), 'utf8').replace(/\r\n/g, '\n');
/** Source with comments stripped, so assertions are about code and not about prose. */
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// ─── fixtures ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now(); // the components read the real clock, so every fixture is relative to it
const iso = (ms) => new Date(ms).toISOString();
const R = rules.REPLACE_GUARD_UNAVAILABLE_REASONS;

const GUARDS = [
  { id: 1, name: 'Ava Current' },
  { id: 2, name: 'Bea Spare' },
  { id: 3, name: 'Cal Spare' },
];

/** One company shift, as GET /shifts returns it (assignment / jobApplication are null unless it is a hire). */
const shift = (id, status, startOffsetMs, durationMs = 8 * HOUR, extra = {}) => ({
  id,
  siteId: 10,
  siteName: `Site ${id}`,
  site: { id: 10, name: `Site ${id}`, timezone: 'Europe/London' },
  start: iso(NOW + startOffsetMs),
  end: iso(NOW + startOffsetMs + durationMs),
  status,
  guardId: 1,
  guard: { id: 1, fullName: 'Ava Current' },
  assignment: null,
  jobApplication: null,
  rotaSlotId: 500,
  ...extra,
});

// The states, by id. Shift Offers lists offered/assigned/ready/accepted/rejected/missed; the Rota Planner lists all.
const S = {
  awaiting: shift(101, 'offered', 26 * HOUR),
  accepted: shift(102, 'ready', 26 * HOUR),
  startedInGrace: shift(103, 'ready', -5 * MIN),
  startedAfterGrace: shift(104, 'ready', -30 * MIN),
  bookedOn: shift(105, 'in_progress', -2 * HOUR),
  completed: shift(106, 'completed', -10 * HOUR),
  ended: shift(107, 'offered', -10 * HOUR),
  hire: shift(108, 'offered', 26 * HOUR, 8 * HOUR, { assignment: { id: 77 }, jobApplication: { id: 88 } }),
  cancelled: shift(109, 'cancelled', 26 * HOUR),
  declined: shift(110, 'rejected', 26 * HOUR),
};
const ALL = Object.values(S);

// ─── renderer helpers ────────────────────────────────────────────────────────

const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const outermost = (nodes) => nodes.filter((n) => !nodes.some((other) => other !== n && isInside(n, other)));
const pressables = (root, label) => outermost(root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
const maybe = (root, label) => pressables(root, label)[0] ?? null;
const one = (root, label) => {
  const found = pressables(root, label);
  assert.ok(found.length >= 1, `expected a pressable labelled "${label}"`);
  return found[0];
};
const press = async (node) => {
  assert.ok(!node.props.disabled, `"${node.props.accessibilityLabel}" is disabled`);
  await act(async () => { await node.props.onPress(); });
};
const type = async (root, label, value) => {
  const input = root.find((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function');
  await act(async () => { input.props.onChangeText(value); });
};
/** Every string rendered under a node. */
const textOf = (node) => {
  const words = [];
  const walk = (n) => {
    if (typeof n === 'string') { words.push(n); return; }
    if (!n || !n.children) return;
    n.children.forEach(walk);
  };
  walk(node);
  return words.join(' ');
};
const screenText = (renderer) => textOf(renderer.root);
const modal = (renderer) => renderer.root.findAll((n) => n.type === 'test-modal')[0] ?? null;
const buttonsLabelled = (root, label) => root.findAll((n) => n.type === Button && n.props.label === label);
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

// ─── Shift Offers entry point ────────────────────────────────────────────────

async function mountOffers(props = {}) {
  const calls = { replace: [], withdraw: [] };
  let current = {
    shifts: ALL,
    refreshing: false,
    onRefresh: () => undefined,
    feedback: null,
    onWithdrawOffer: async (id) => { calls.withdraw.push(id); },
    onNavigateToRota: () => undefined,
    onNavigateToLiveOps: () => undefined,
    replacementGuards: GUARDS,
    onReplaceGuard: async (id, input) => { calls.replace.push([id, input]); },
    ...props,
  };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyShiftOffersWorkspace, current)); });
  // Show every offer, not only the Awaiting tab.
  const allChip = renderer.root.find((n) => n.props && n.props.accessibilityRole === 'button' && n.props.children === 'All' && typeof n.props.onPress === 'function');
  await act(async () => { allChip.props.onPress(); });
  const update = async (next) => {
    current = { ...current, ...next };
    await act(async () => { renderer.update(h(CompanyShiftOffersWorkspace, current)); });
  };
  return { renderer, calls, update };
}

/** Opens the drawer for one offer by pressing its row. */
async function openOffer(renderer, s) {
  const rows = outermost(renderer.root.findAll((n) => n.props && n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function'
    && n.findAll((c) => c.props && c.props.children === s.siteName).length > 0));
  assert.ok(rows.length >= 1, `the offer list shows ${s.siteName}`);
  await act(async () => { rows[0].props.onPress(); });
  const m = modal(renderer);
  assert.ok(m, 'the offer drawer opened');
  return m;
}

// ─── Rota Planner entry point ────────────────────────────────────────────────

const POSITION_ORDER = ['awaiting', 'accepted', 'startedInGrace', 'startedAfterGrace', 'bookedOn', 'completed', 'ended', 'hire', 'cancelled', 'declined'];
const position = (s, over = {}) => ({ shiftId: s.id, guardId: s.guardId, guardName: s.guard.fullName, status: s.status, ...over });
const slotDetail = (positions) => ({
  id: 500, siteId: 10, siteName: 'Northgate', clientId: null, clientName: null, jobId: null, title: null,
  startAt: iso(NOW + 26 * HOUR), endAt: iso(NOW + 34 * HOUR), requiredGuardCount: positions.length,
  checkCallIntervalMinutes: 60, instructions: null, status: 'active', coveragePhase: 'future', coverageState: 'offered_pending',
  counts: { required: positions.length, assigned: positions.length, confirmed: 0, offered: 1, open: 0, problem: 0, onShift: 0, completed: 0 },
  createdAt: iso(NOW), updatedAt: iso(NOW), positions,
});
const ALL_POSITIONS = [
  ...POSITION_ORDER.map((k) => position(S[k], { guardName: `${S[k].guard.fullName} #${S[k].id}` })),
  { shiftId: 111, guardId: null, guardName: null, status: 'unfilled' },
];
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  .map((label, i) => ({ date: `2026-10-${26 + i}`, label, shortLabel: `${26 + i} Oct` }));
const emptyDay = { slots: [] };
const SITES = [{
  siteId: 10, siteName: 'Northgate', clientId: null, clientName: null,
  days: {
    monday: { slots: [{ slotId: 500, title: null, startAt: iso(NOW + 26 * HOUR), endAt: iso(NOW + 34 * HOUR), isNightShift: false,
      coveragePhase: 'future', coverageState: 'offered_pending',
      counts: { required: 1, assigned: 1, confirmed: 0, offered: 1, open: 0, problem: 0, onShift: 0, completed: 0 }, positions: [] }] },
    tuesday: emptyDay, wednesday: emptyDay, thursday: emptyDay, friday: emptyDay, saturday: emptyDay, sunday: emptyDay,
  },
}];

async function mountRota({ details, lookup = true, ...props } = {}) {
  const calls = { replace: [], cancelPosition: [], loadSlot: 0, refreshWeek: 0 };
  const queue = [...details];
  const noop = () => undefined;
  const byId = new Map(ALL.map((s) => [s.id, s]));
  const current = {
    plannerClientId: '', plannerSiteId: '', setPlannerClientId: noop, setPlannerSiteId: noop,
    siteClientOptions: [], plannerSiteOptions: [],
    weekCommencing: '2026-10-26', weekEnding: '2026-11-01', plannerWeekDays: WEEK_DAYS,
    onPrevWeek: noop, onNextWeek: noop, onTodayWeek: noop,
    sites: SITES, slotsByDayName: new Map(), weekSnapshot: null, loadingRota: false, rotaError: null,
    onRetryLoadRota: noop,
    onRefreshWeek: () => { calls.refreshWeek += 1; },
    legacyShiftsByDate: new Map(),
    onLoadSlot: async () => { calls.loadSlot += 1; return queue.length > 1 ? queue.shift() : queue[0]; },
    onCreateSlot: async () => { throw new Error('not used'); },
    onSaveSlotEdits: async () => { throw new Error('not used'); },
    onAssignPosition: async () => { throw new Error('not used'); },
    onAssignMultiple: async () => { throw new Error('not used'); },
    onCancelPosition: async (slotId, shiftId) => { calls.cancelPosition.push(shiftId); return details[0]; },
    onCancelSlot: async () => undefined,
    onGetEligibleGuards: async () => [],
    resolveSiteZone: () => 'Europe/London',
    replacementGuards: GUARDS,
    onReplaceGuard: async (id, input) => { calls.replace.push([id, input]); },
    lookupShift: lookup ? (id) => byId.get(id) ?? null : undefined,
    ...props,
  };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyRotaPlannerWorkspace, current)); });
  const card = renderer.root.findAll((n) => typeof n.type === 'function' && n.type.name === 'SlotMiniCard')[0];
  assert.ok(card, 'the week shows the slot');
  await act(async () => { await card.props.onPress(); });
  await settle();
  assert.ok(modal(renderer), 'the shift details drawer opened');
  return { renderer, calls };
}
const rotaName = (k) => `${S[k].guard.fullName} #${S[k].id}`;
const rotaReplace = (renderer, k) => maybe(renderer.root, `Replace Guard for ${rotaName(k)}`);
/** The rendered Guard position for one shift (the planner's PositionRow), holding its actions and reason line. */
const rotaBlock = (renderer, k) => {
  assert.ok(rotaReplace(renderer, k), `position ${rotaName(k)} shows Replace Guard`);
  const rows = renderer.root.findAll((n) => typeof n.type === 'function' && n.type.name === 'PositionRow' && n.props.position.shiftId === S[k].id);
  assert.equal(rows.length, 1, `one position row for ${rotaName(k)}`);
  return rows[0];
};

/** Fills the shared form and presses its confirm button. */
async function completeForm(root, { guard = 'Bea Spare', reason = 'Reason Cover rearranged', details = 'Swapped with Bea after a call', noShow = false } = {}) {
  await press(one(root, `Replacement Guard ${guard}`));
  await press(one(root, reason));
  await type(root, 'Replacement details', details);
  if (noShow) {
    assert.ok(one(root, 'Confirm Replace Guard').props.disabled, 'the no-show must be confirmed first');
    await press(one(root, 'Confirm no-show'));
  }
  await press(one(root, 'Confirm Replace Guard'));
  await settle();
}

// ═══════════════════ one implementation, matching the server ═══════════════════

test('RG-01-ONE-SHARED-FORM-AND-RULESET-NO-LOCAL-COPIES', async () => {
  const offers = codeOf('src/components/company/CompanyShiftOffersWorkspace.tsx');
  const rota = codeOf('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  for (const [name, src] of [['Shift Offers', offers], ['Rota Planner', rota]]) {
    assert.ok(src.includes("from './ReplaceGuardForm'"), `${name} uses the shared form`);
    assert.ok(src.includes("from './replaceGuard'"), `${name} uses the shared rules`);
    assert.ok(src.includes('replaceGuardAvailability('), `${name} asks the shared availability rule`);
    assert.ok(!/REASON_CATEGORIES\s*[:=]/.test(src), `${name} keeps no reason list of its own`);
    assert.ok(!/function canReplaceGuard|function isAcceptedAndStarted/.test(src), `${name} keeps no replace rule of its own`);
    assert.ok(!src.includes("'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED'"), `${name} keeps no fatigue handling of its own`);
    assert.ok(!src.includes('replace-guard'), `${name} never calls the endpoint itself`);
  }
});

test('RG-02-RULES-MATCH-THE-SERVER-POLICY', async () => {
  const policy = backend('src/shift/replace-guard-policy.ts');
  const editPolicy = backend('src/shift/shift-edit-policy.ts');
  assert.ok(policy.includes(`REPLACEABLE_STATUSES: ReadonlySet<string> = new Set(['offered', 'ready'])`), 'server replaces offered and ready only');
  assert.ok(policy.includes('NO_SHOW_GRACE_MINUTES = MISSED_SHIFT_GRACE_MINUTES'));
  assert.ok(editPolicy.includes(`MISSED_SHIFT_GRACE_MINUTES = ${rules.REPLACE_GUARD_NO_SHOW_GRACE_MINUTES};`), 'the grace is the server\'s');
  for (const c of rules.REPLACE_GUARD_REASON_CATEGORIES) {
    assert.ok(policy.includes(`${c.key}: '${c.label}'`), `reason category ${c.key} is the server's`);
  }
  assert.ok(policy.includes(`FATIGUE_ACKNOWLEDGEMENT_REQUIRED: '${rules.REPLACE_GUARD_FATIGUE_ACK_CODE}'`));
  // The hire link: the server refuses on exactly the relations the company shift list carries.
  const service = backend('src/shift/shift.service.ts');
  assert.ok(service.includes('if (shift.assignment || shift.jobApplication) {'), 'server checks assignment / jobApplication');
  assert.ok(/isCompanyRole\(user\.role\)[\s\S]{0,400}relations: \['assignment', 'company', 'guard', 'site', 'job', 'jobApplication'\]/.test(service),
    'GET /shifts for a company loads both relations, so the client can know');
  assert.equal(rules.isHireLinkedShift({ assignment: null, jobApplication: null }), false);
  assert.equal(rules.isHireLinkedShift({ assignment: { id: 1 }, jobApplication: null }), true);
  assert.equal(rules.isHireLinkedShift({ assignment: null, jobApplication: { id: 2 } }), true);
  assert.equal(rules.isHireLinkedShift(null), false, 'no payload → unknown → the server decides');
});

test('RG-03-EVERY-STATE-HAS-AN-ANSWER', async () => {
  const facts = (s, over = {}) => ({ status: s.status, guardId: s.guardId, start: s.start, end: s.end, hireLinked: rules.isHireLinkedShift(s), ...over });
  const at = (s, over) => rules.replaceGuardAvailability(facts(s, over), Date.now(), 2);
  assert.deepEqual(at(S.awaiting), { available: true, noShow: false });
  assert.deepEqual(at(S.accepted), { available: true, noShow: false });
  assert.deepEqual(at(S.startedAfterGrace), { available: true, noShow: true });
  const expect = { startedInGrace: 'no_show_grace', bookedOn: 'booked_on', completed: 'completed', ended: 'ended', hire: 'hire_linked', cancelled: 'cancelled', declined: 'declined' };
  for (const [k, key] of Object.entries(expect)) {
    const a = at(S[k]);
    assert.equal(a.available, false, `${k} is not replaceable`);
    assert.equal(a.key, key, `${k} → ${key}`);
    assert.equal(a.reason, R[key]);
  }
  assert.equal(R.booked_on, 'Booked On — use Book Off or Close without Book Off, then create a new shift');
  assert.equal(R.hire_linked, "Marketplace hire shifts can't be replaced yet");
  assert.equal(R.no_show_grace, 'Wait until 15 minutes after the start to replace as a no-show');
  assert.equal(rules.replaceGuardAvailability(facts(S.awaiting), Date.now(), 0).key, 'no_candidates');
  assert.equal(rules.replaceGuardAvailability(facts(S.awaiting, { guardId: null, status: 'unfilled' }), Date.now(), 2).key, 'no_guard');
  // The grace boundary itself, on a fixed clock.
  const start = Date.parse('2026-10-27T09:00:00.000Z');
  const ready = { status: 'ready', guardId: 1, start: iso(start), end: iso(start + 8 * HOUR) };
  assert.equal(rules.replaceGuardAvailability(ready, start - 1, 1).available, true, 'before start: available, not a no-show');
  assert.equal(rules.replaceGuardAvailability(ready, start - 1, 1).noShow, false);
  assert.equal(rules.replaceGuardAvailability(ready, start + 15 * MIN - 1, 1).key, 'no_show_grace');
  assert.deepEqual(rules.replaceGuardAvailability(ready, start + 15 * MIN, 1), { available: true, noShow: true });
  assert.equal(rules.replaceGuardAvailability(ready, start + 8 * HOUR, 1).key, 'ended');
  // Candidates exclude the current Guard only.
  assert.deepEqual(rules.replacementCandidatesFor(GUARDS, 1).map((g) => g.id), [2, 3]);
});

// ═══════════════════ Shift Offers drawer ═══════════════════

test('RG-04-OFFERS-AWAITING-REPLACES-WITHOUT-WITHDRAWING', async () => {
  const { renderer, calls } = await mountOffers();
  const m = await openOffer(renderer, S.awaiting);
  const replace = one(m, 'Replace Guard');
  assert.equal(replace.props.disabled, false, 'Awaiting: Replace Guard is available');
  // Withdraw Offer and Replace Guard are separate buttons with separate variants.
  assert.equal(buttonsLabelled(m, 'Withdraw Offer')[0].props.variant, 'danger');
  assert.equal(buttonsLabelled(m, 'Replace Guard')[0].props.variant, 'secondary');
  await press(replace);
  assert.ok(!maybe(m, 'Withdraw Offer'), 'the form replaces the footer: no Withdraw beside the confirm button');
  const form = modal(renderer);
  const candidates = form.findAll((n) => n.props && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Replacement Guard ') && typeof n.props.onPress === 'function');
  assert.deepEqual(outermost(candidates).map((n) => n.props.accessibilityLabel), ['Replacement Guard Bea Spare', 'Replacement Guard Cal Spare'], 'the current Guard is not a candidate');
  assert.ok(one(form, 'Confirm Replace Guard').props.disabled, 'nothing is sent until a Guard, reason and details are given');
  await completeForm(form);
  assert.deepEqual(calls.replace, [[101, { replacementGuardId: 2, reasonCategory: 'cover_rearranged', reason: 'Swapped with Bea after a call' }]]);
  assert.deepEqual(calls.withdraw, [], 'Replace never withdraws or cancels');
  assert.equal(modal(renderer), null, 'the drawer closes after the server accepts');
});

test('RG-05-OFFERS-ACCEPTED-BEFORE-START-IS-AVAILABLE', async () => {
  const { renderer, calls } = await mountOffers();
  const m = await openOffer(renderer, S.accepted);
  await press(one(m, 'Replace Guard'));
  const form = modal(renderer);
  assert.ok(!maybe(form, 'Confirm no-show'), 'not started: no no-show confirmation');
  await completeForm(form, { reason: 'Reason Schedule change' });
  assert.equal(calls.replace.length, 1);
  assert.equal(calls.replace[0][1].noShow, undefined, 'not sent as a no-show');
});

test('RG-06-OFFERS-STARTED-WITHIN-GRACE-IS-DISABLED-WITH-REASON', async () => {
  const { renderer } = await mountOffers();
  const m = await openOffer(renderer, S.startedInGrace);
  const replace = one(m, 'Replace Guard');
  assert.equal(replace.props.disabled, true);
  assert.ok(textOf(m).includes(`Replace Guard unavailable: ${R.no_show_grace}`), 'the reason is shown');
});

test('RG-07-OFFERS-STARTED-AFTER-GRACE-NEEDS-THE-NO-SHOW-CONFIRMATION', async () => {
  const { renderer, calls } = await mountOffers();
  const m = await openOffer(renderer, S.startedAfterGrace);
  await press(one(m, 'Replace Guard'));
  await completeForm(modal(renderer), { noShow: true });
  assert.equal(calls.replace.length, 1);
  assert.equal(calls.replace[0][1].noShow, true, 'sent as an explicit no-show');
});

test('RG-08-OFFERS-ENDED-DECLINED-AND-HIRE-ARE-DISABLED-WITH-REASONS', async () => {
  const { renderer } = await mountOffers();
  for (const [k, key] of [['ended', 'ended'], ['declined', 'declined'], ['hire', 'hire_linked']]) {
    const m = await openOffer(renderer, S[k]);
    assert.equal(one(m, 'Replace Guard').props.disabled, true, `${k}: disabled, not hidden`);
    assert.ok(textOf(m).includes(R[key]), `${k}: "${R[key]}"`);
    await act(async () => { one(m, 'Close').props.onPress(); });
  }
  // Booked On and Completed shifts are not offers: they never appear in Shift Offers at all.
  const listed = screenText(renderer);
  assert.ok(!listed.includes(S.bookedOn.siteName) && !listed.includes(S.completed.siteName));
});

test('RG-09-OFFERS-NO-OTHER-ACTIVE-GUARDS-IS-A-REASON', async () => {
  const { renderer } = await mountOffers({ replacementGuards: [GUARDS[0]] });
  const m = await openOffer(renderer, S.awaiting);
  assert.equal(one(m, 'Replace Guard').props.disabled, true);
  assert.ok(textOf(m).includes(R.no_candidates));
});

test('RG-10-OFFERS-SERVER-REFUSALS-ARE-SHOWN-AND-FATIGUE-CAN-BE-ACKNOWLEDGED', async () => {
  const attempts = [];
  const refusals = [
    Object.assign(new Error('Bea would exceed the approval threshold. Acknowledge the fatigue warning to continue.'), { code: 'REPLACE_GUARD_FATIGUE_ACKNOWLEDGEMENT_REQUIRED' }),
  ];
  const { renderer } = await mountOffers({
    onReplaceGuard: async (id, input) => { attempts.push([id, input]); const r = refusals.shift(); if (r) throw r; },
  });
  const m = await openOffer(renderer, S.awaiting);
  await press(one(m, 'Replace Guard'));
  await completeForm(modal(renderer));
  const form = modal(renderer);
  assert.ok(form, 'a refusal keeps the drawer open');
  assert.ok(textOf(form).includes('Acknowledge the fatigue warning'), 'the server\'s words are shown');
  await press(one(form, 'Acknowledge and replace'));
  await settle();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1][1].fatigueAcknowledged, true);
  assert.equal(modal(renderer), null);
});

// ═══════════════════ Rota Planner ═══════════════════

test('RG-11-ROTA-EVERY-GUARD-POSITION-HAS-REPLACE-OR-A-REASON', async () => {
  const { renderer } = await mountRota({ details: [slotDetail(ALL_POSITIONS)] });
  for (const k of ['awaiting', 'accepted', 'startedAfterGrace']) {
    assert.equal(rotaReplace(renderer, k).props.disabled, false, `${k}: Replace Guard available`);
    assert.ok(!textOf(rotaBlock(renderer, k)).includes('Replace Guard unavailable'), `${k}: no reason line`);
  }
  const expect = { startedInGrace: 'no_show_grace', bookedOn: 'booked_on', completed: 'completed', ended: 'ended', hire: 'hire_linked', cancelled: 'cancelled', declined: 'declined' };
  for (const [k, key] of Object.entries(expect)) {
    assert.equal(rotaReplace(renderer, k).props.disabled, true, `${k}: disabled, not hidden`);
    assert.ok(textOf(rotaBlock(renderer, k)).includes(`Replace Guard unavailable: ${R[key]}`), `${k}: "${R[key]}" beside the position`);
  }
  assert.ok(!screenText(renderer).includes('Replace Guard for Open position'), 'an open position is assigned, not replaced');
});

test('RG-12-ROTA-CANCEL-POSITION-AND-REPLACE-ARE-SEPARATE', async () => {
  const { renderer, calls } = await mountRota({ details: [slotDetail(ALL_POSITIONS)] });
  const cancel = one(renderer.root, `Cancel Position for ${rotaName('awaiting')}`);
  const replace = rotaReplace(renderer, 'awaiting');
  assert.notEqual(cancel, replace);
  assert.ok(textOf(cancel).includes('Cancel Position') && !textOf(cancel).includes('Replace'));
  assert.ok(textOf(replace).includes('Replace Guard') && !textOf(replace).includes('Cancel'));
  // Booked On has no Cancel Position at all, but still explains Replace.
  assert.ok(!maybe(renderer.root, `Cancel Position for ${rotaName('bookedOn')}`));
  await press(replace);
  assert.ok(!maybe(renderer.root, `Cancel Position for ${rotaName('awaiting')}`), 'while replacing, Cancel Position is not beside the form');
  assert.ok(one(renderer.root, 'Back without replacing'), 'leaving the form is "Back", never "Cancel"');
  await completeForm(modal(renderer));
  assert.equal(calls.replace.length, 1);
  assert.deepEqual(calls.cancelPosition, [], 'Replace never cancels the position');
});

test('RG-13-ROTA-AWAITING-AND-ACCEPTED-REPLACE-THEN-REFRESH-TO-AWAITING', async () => {
  const before = slotDetail([position(S.accepted)]);
  const after = slotDetail([{ shiftId: S.accepted.id, guardId: 2, guardName: 'Bea Spare', status: 'offered' }]);
  const { renderer, calls } = await mountRota({ details: [before, after] });
  assert.equal(calls.loadSlot, 1);
  await press(one(renderer.root, 'Replace Guard for Ava Current'));
  const form = modal(renderer);
  assert.ok(!maybe(form, 'Confirm no-show'));
  await completeForm(form);
  assert.deepEqual(calls.replace, [[102, { replacementGuardId: 2, reasonCategory: 'cover_rearranged', reason: 'Swapped with Bea after a call' }]]);
  assert.equal(calls.loadSlot, 2, 'the shift details are re-read');
  assert.ok(calls.refreshWeek >= 1, 'and the week');
  const text = screenText(renderer);
  assert.ok(text.includes('Bea Spare') && text.includes('Awaiting'), 'the incoming Guard shows as Awaiting');
  assert.ok(text.includes(rules.replaceGuardSuccessMessage('Bea Spare')));
});

test('RG-14-ROTA-AWAITING-OFFER-IS-REPLACEABLE', async () => {
  const { renderer, calls } = await mountRota({ details: [slotDetail([position(S.awaiting)])] });
  await press(one(renderer.root, 'Replace Guard for Ava Current'));
  await completeForm(modal(renderer), { guard: 'Cal Spare', reason: 'Reason Operational change' });
  assert.deepEqual(calls.replace, [[101, { replacementGuardId: 3, reasonCategory: 'operational_change', reason: 'Swapped with Bea after a call' }]]);
});

test('RG-15-ROTA-STARTED-AFTER-GRACE-IS-A-CONFIRMED-NO-SHOW', async () => {
  const { renderer, calls } = await mountRota({ details: [slotDetail([position(S.startedAfterGrace)])] });
  await press(one(renderer.root, 'Replace Guard for Ava Current'));
  await completeForm(modal(renderer), { noShow: true });
  assert.equal(calls.replace[0][1].noShow, true);
});

test('RG-16-ROTA-HIRE-UNKNOWN-TO-THE-CLIENT-SHOWS-THE-SERVER-REFUSAL', async () => {
  // Without the shift payload (no lookup) the client cannot know it is a hire, so it lets the server say so.
  const hireMessage = 'This shift belongs to a marketplace hire. Its Guard cannot be replaced here; cancel the shift and create a new one for the replacement.';
  const { renderer, calls } = await mountRota({
    details: [slotDetail([position(S.hire)])],
    lookup: false,
    onReplaceGuard: async () => { throw Object.assign(new Error(hireMessage), { code: 'REPLACE_GUARD_HIRE_LINKED' }); },
  });
  await press(one(renderer.root, 'Replace Guard for Ava Current'));
  await completeForm(modal(renderer));
  assert.ok(screenText(renderer).includes(hireMessage), 'the refusal is shown in the form');
  assert.equal(calls.loadSlot, 1, 'nothing is re-read after a refusal');
  // With the payload, it is known up front.
  const known = await mountRota({ details: [slotDetail([position(S.hire)])] });
  assert.equal(one(known.renderer.root, 'Replace Guard for Ava Current').props.disabled, true);
  assert.ok(screenText(known.renderer).includes(R.hire_linked));
});

test('RG-17-ROTA-NO-OTHER-ACTIVE-GUARDS-IS-A-REASON', async () => {
  const { renderer } = await mountRota({ details: [slotDetail([position(S.awaiting)])], replacementGuards: [GUARDS[0]] });
  assert.equal(one(renderer.root, 'Replace Guard for Ava Current').props.disabled, true);
  assert.ok(screenText(renderer).includes(R.no_candidates));
});

test('RG-18-ROTA-WITHOUT-THE-HANDLER-SHOWS-NO-REPLACE', async () => {
  const { renderer } = await mountRota({ details: [slotDetail([position(S.awaiting)])], onReplaceGuard: undefined });
  assert.ok(!maybe(renderer.root, 'Replace Guard for Ava Current'));
  assert.ok(one(renderer.root, 'Cancel Position for Ava Current'), 'Cancel Position is unaffected');
});

// ═══════════════════ the dashboard: one handler, one refresh, company Guards only ═══════════════════

test('RG-19-BOTH-ENTRY-POINTS-USE-ONE-HANDLER-AND-BOTH-VIEWS-REFRESH', async () => {
  const screen = codeOf('src/screens/CompanyDashboardScreen.tsx');
  const offers = screen.slice(screen.indexOf('const renderShiftOffersSection = () => ('), screen.indexOf('const renderRecruitmentSection'));
  const rota = screen.slice(screen.indexOf('const renderRotaPlannerSection = () => ('), screen.indexOf('const renderLiveOperationsSection'));
  for (const [name, block] of [['Shift Offers', offers], ['Rota Planner', rota]]) {
    assert.ok(block.includes('onReplaceGuard={handleReplaceShiftGuard}'), `${name} uses handleReplaceShiftGuard`);
    assert.ok(block.includes('replacementGuards={replacementGuardOptions}'), `${name} offers the same candidates`);
  }
  assert.ok(rota.includes('lookupShift={lookupShiftById}'));
  const handler = screen.slice(screen.indexOf('const handleReplaceShiftGuard = async'), screen.indexOf('const handleOpenUrgentShift'));
  assert.ok(handler.includes('await replaceShiftGuard(shiftId, input);'), 'one endpoint call');
  const success = handler.slice(handler.indexOf('throw Object.assign'));
  assert.ok(success.includes('setRotaLoadKey((key) => key + 1);'), 'the rota week is re-read');
  assert.ok(success.includes('await loadData(true);'), 'and the shift list');
  // Candidates are only this company's ACTIVE Guards.
  assert.ok(/const activeCompanyGuards = React\.useMemo\(\s*\(\) => companyGuards\.filter\(\(entry\) => \(entry\.status \|\| ''\)\.toUpperCase\(\) === 'ACTIVE'\)/.test(screen));
  assert.ok(/const replacementGuardOptions = React\.useMemo\(\s*\(\) => activeCompanyGuards/.test(screen));
  // The client sends the replacement to the one endpoint; nothing else in the app calls it.
  const api = codeOf('src/services/api.ts');
  assert.ok(api.includes('`/shifts/${id}/replace-guard`'));
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${pending.length} replace guard UI checks passed`);
  if (passed !== pending.length) process.exitCode = 1;
})();
