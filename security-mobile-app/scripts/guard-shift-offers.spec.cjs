#!/usr/bin/env node
/**
 * Guard shift offers can be accepted and declined. (Post-release P0, 19 October 2026.)
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * A Guard opened an offered shift and pressed Review offer. A grey overlay appeared and there was no
 * Accept or Decline button anywhere. The detail was an absolutely-positioned backdrop and bottom sheet
 * INSIDE GuardShiftOffersWorkspace, and the workspace is rendered inside the Guard dashboard's ScrollView.
 * So the backdrop and sheet were sized to the whole offer LIST, not the screen: with more offers than fit,
 * the backdrop greyed the visible list while the sheet — and its action row — were laid out below the
 * fold, behind the bottom navigation. Measured locally at 390x690 with four offers: the visible area ended
 * at 607px and Accept was drawn at 889-941px. The installed Android vc14 and iOS build 13 bundles both
 * carry that overlay. The Phase 2 fix for the same class of defect (guard-action-forms.spec.cjs, FORM-19)
 * only scanned GuardDashboardScreen, so an overlay in a child component was never looked at.
 *
 * WHAT IS EXECUTED HERE
 * The real GuardShiftOffersWorkspace, rendered with the real AppModal / ModalFrame on react-native-web
 * through react-test-renderer, and driven by presses: open, close, backdrop, decline confirmation, keep,
 * accept, decline, the in-flight state, an offer leaving the list, and the Home "Review Offer" entry. The
 * only substitute is the Modal PRIMITIVE itself (react-native-web's renders through a DOM portal, which
 * the test renderer cannot mount); it renders its children when visible and nothing otherwise, which is
 * the only property of it the workspace relies on.
 *
 * WHAT CANNOT HONESTLY BE PROVEN HERE
 * Pixel placement on a physical Android or iOS device. That the real RNModal paints above the tab bar is
 * the property certified for the action forms on device (Build 11/12 UAT); it is manual UAT for the
 * build that carries this fix and is named as such in the report.
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
    return { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) };
  }
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TestRenderer = require('react-test-renderer');
const ts = require('typescript');
const { ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

/**
 * Loads a component and its relative imports. esModuleInterop is on because these components use a
 * default `import React from 'react'`, which load-ts.cjs (written for pure modules) does not interop.
 */
function loadComponent(rel) {
  const cache = new Map();
  const load = (abs) => {
    if (cache.has(abs)) return cache.get(abs).exports;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true },
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
const { GuardShiftOffersWorkspace } = loadComponent('src/components/guard/GuardShiftOffersWorkspace.tsx');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped, so assertions are about code and not about prose. */
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const offer = (id, hoursAhead, extra = {}) => ({
  id,
  siteName: `Site ${id}`,
  start: new Date(NOW + hoursAhead * 3_600_000).toISOString(),
  end: new Date(NOW + (hoursAhead + 12) * 3_600_000).toISOString(),
  status: 'offered',
  checkCallIntervalMinutes: 60,
  instructions: null,
  site: { timezone: 'Europe/London' },
  ...extra,
});
const FOUR = [offer(1, -2), offer(2, 26), offer(3, 50), offer(4, 74, { instructions: 'Long. '.repeat(400) })];

/** Mounts the workspace with a recording onRespond; props can be changed later with update(). */
async function mount(props = {}) {
  const responses = [];
  let current = {
    offers: FOUR,
    respondingShiftId: null,
    offerRespondAction: null,
    onRespond: (id, r) => responses.push([id, r]),
    onRefresh: () => undefined,
    refreshing: false,
    liveNow: NOW,
    ...props,
  };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(GuardShiftOffersWorkspace, current)); });
  const update = async (next) => {
    current = { ...current, ...next };
    await act(async () => { renderer.update(h(GuardShiftOffersWorkspace, current)); });
  };
  return { renderer, responses, update };
}

/** The outermost element per control: a Pressable and the host element it renders both carry the props. */
const outermost = (nodes) => nodes.filter((n) => !nodes.some((other) => other !== n && isInside(n, other)));
const byLabel = (renderer, label) =>
  outermost(renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
const one = (renderer, label) => {
  const found = byLabel(renderer, label);
  assert.ok(found.length >= 1, `expected a pressable labelled "${label}"`);
  return found[0];
};
const press = async (node) => { await act(async () => { node.props.onPress(); }); };
const modalOf = (renderer) => renderer.root.findAll((n) => n.type === 'test-modal');
const isInside = (node, ancestor) => { for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const reviewButtons = (renderer) => outermost(renderer.root.findAll((n) => n.props && typeof n.props.accessibilityLabel === 'string'
  && n.props.accessibilityLabel.startsWith('Review offer for') && typeof n.props.onPress === 'function'));

// ═══════════════════ the structure that was the defect ═══════════════════

test('OFFER-01-THE-DETAIL-IS-HOSTED-IN-APPMODAL-NOT-AN-ABSOLUTE-VIEW', async () => {
  const code = codeOf('src/components/guard/GuardShiftOffersWorkspace.tsx');
  assert.match(code, /import \{ AppModal \} from '\.\.\/ui\/Modal'/, 'the workspace must use the shared AppModal');
  assert.match(code, /<AppModal\b/, 'and render it');
  // The exact shape of the defect: an absolutely-positioned backdrop/sheet inside the scrolling list.
  assert.ok(!/position:\s*'absolute'/.test(code), 'no absolutely-positioned layer may remain in the workspace');
  assert.ok(!/zIndex/.test(code), 'no zIndex layering');
  assert.ok(!/sheetBackdrop|sheetBackdropTap|maxHeight:\s*'84%'/.test(code), 'the hand-rolled sheet and its styles are gone');
});

test('OFFER-02-ACCEPT-AND-DECLINE-ARE-IN-THE-MODAL-FOOTER-OUTSIDE-THE-SCROLLING-BODY', async () => {
  const { renderer } = await mount();
  await press(reviewButtons(renderer)[3]); // the offer with very long instructions
  const [modal] = modalOf(renderer);
  assert.ok(modal, 'the offer detail must be inside the modal');
  const accept = one(renderer, 'Accept this shift');
  const decline = one(renderer, 'Decline this shift offer');
  assert.ok(isInside(accept, modal) && isInside(decline, modal), 'both actions are rendered inside the modal');
  const scrollers = modal.findAll((n) => n.type === RNW.ScrollView);
  assert.ok(scrollers.length >= 1, 'the detail body scrolls');
  for (const s of scrollers) {
    assert.ok(!isInside(accept, s), 'Accept must not be inside the scrolling body — long content would push it away');
    assert.ok(!isInside(decline, s), 'nor Decline');
  }
  // And the long instructions really are in the scrolling body.
  const body = scrollers.find((s) => s.findAll((n) => typeof n.props?.children === 'string' && n.props.children.startsWith('Long.')).length);
  assert.ok(body, 'the long instructions are inside the scrolling body');
});

test('OFFER-03-NO-HAND-ROLLED-OVERLAY-IN-ANY-GUARD-SURFACE', async () => {
  // FORM-19 only read GuardDashboardScreen, which is how this overlay in a child component survived.
  const dir = path.join(ROOT, 'src', 'components', 'guard');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => `src/components/guard/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, 'src', 'screens')).filter((f) => /^Guard.*\.tsx$/.test(f)).map((f) => `src/screens/${f}`));
  assert.ok(files.length >= 3, 'the scan must actually cover the Guard surfaces');
  for (const rel of files) {
    const code = codeOf(rel);
    assert.ok(!/zIndex:\s*\d+/.test(code), `${rel}: zIndex layering is how overlays ended up under the tab bar`);
    assert.ok(!/Backdrop:\s*\{[^}]*position:\s*'absolute'/.test(code), `${rel}: an absolutely-positioned backdrop style`);
  }
});

// ═══════════════════ the workflow, executed ═══════════════════

test('OFFER-04-NOTHING-IS-OPEN-UNTIL-REVIEW-AND-REVIEW-OPENS-THAT-OFFER', async () => {
  const { renderer } = await mount();
  assert.equal(modalOf(renderer).length, 0, 'no overlay before Review offer');
  assert.equal(reviewButtons(renderer).length, 4);
  await press(reviewButtons(renderer)[1]);
  const [modal] = modalOf(renderer);
  assert.ok(modal);
  assert.ok(modal.findAll((n) => n.props?.children === 'Site 2').length, 'the detail is for the offer that was reviewed');
});

test('OFFER-05-CLOSE-AND-BACKDROP-CANCEL-WITHOUT-RESPONDING', async () => {
  const { renderer, responses } = await mount();
  await press(reviewButtons(renderer)[1]);
  await press(one(renderer, 'Close'));
  assert.equal(modalOf(renderer).length, 0, 'the header close dismisses');
  await press(reviewButtons(renderer)[1]);
  await press(one(renderer, 'Close dialog'));
  assert.equal(modalOf(renderer).length, 0, 'a backdrop tap dismisses');
  assert.deepEqual(responses, [], 'cancelling never responds');
});

test('OFFER-06-ACCEPT-RESPONDS-ONCE-FOR-THE-REVIEWED-OFFER', async () => {
  const { renderer, responses } = await mount();
  await press(reviewButtons(renderer)[2]);
  await press(one(renderer, 'Accept this shift'));
  assert.deepEqual(responses, [[3, 'accepted']]);
});

test('OFFER-07-DECLINE-NEEDS-CONFIRMATION-AND-KEEP-BACKS-OUT', async () => {
  const { renderer, responses } = await mount();
  await press(reviewButtons(renderer)[1]);
  await press(one(renderer, 'Decline this shift offer'));
  assert.deepEqual(responses, [], 'the first Decline only asks');
  const [modal] = modalOf(renderer);
  const confirm = one(renderer, 'Confirm decline');
  const keep = one(renderer, 'Keep offer');
  for (const s of modal.findAll((n) => n.type === RNW.ScrollView)) {
    assert.ok(!isInside(confirm, s) && !isInside(keep, s), 'the confirmation buttons are in the footer too');
  }
  await press(keep);
  assert.ok(byLabel(renderer, 'Accept this shift').length, 'Keep returns to Accept / Decline');
  await press(one(renderer, 'Decline this shift offer'));
  await press(one(renderer, 'Confirm decline'));
  assert.deepEqual(responses, [[2, 'rejected']]);
});

test('OFFER-08-WHILE-A-RESPONSE-IS-IN-FLIGHT-NOTHING-CAN-BE-PRESSED-OR-DISMISSED', async () => {
  const { renderer, responses, update } = await mount();
  await press(reviewButtons(renderer)[1]);
  await update({ respondingShiftId: 2, offerRespondAction: 'accepted' });
  const accept = one(renderer, 'Accept this shift');
  assert.equal(accept.props.disabled, true, 'Accept is disabled');
  assert.equal(one(renderer, 'Decline this shift offer').props.disabled, true, 'Decline is disabled');
  assert.ok(accept.findAll((n) => n.props?.children === 'Accepting…').length, 'and it says what is happening');
  await press(one(renderer, 'Close'));
  assert.equal(modalOf(renderer).length, 1, 'the header close does not abandon an in-flight response');
  assert.equal(byLabel(renderer, 'Close dialog').length, 0, 'and the backdrop is not a close target');
  assert.deepEqual(responses, []);
});

test('OFFER-09-AN-OFFER-THAT-LEAVES-THE-LIST-CLOSES-ITS-DETAIL', async () => {
  // After a successful response, or when a refresh shows the offer was withdrawn, the detail must not
  // linger over an offer that no longer exists.
  const { renderer, update } = await mount();
  await press(reviewButtons(renderer)[1]);
  await update({ offers: FOUR.filter((o) => o.id !== 2) });
  assert.equal(modalOf(renderer).length, 0);
});

test('OFFER-10-HOME-REVIEW-OFFER-OPENS-THE-DETAIL-DIRECTLY', async () => {
  let handled = 0;
  const { renderer } = await mount({ initialSelectedOfferId: 3, onInitialSelectedHandled: () => { handled += 1; } });
  const [modal] = modalOf(renderer);
  assert.ok(modal, 'the Home Main action lands on the open detail');
  assert.ok(modal.findAll((n) => n.props?.children === 'Site 3').length);
  assert.ok(byLabel(renderer, 'Accept this shift').length, 'with its actions');
  assert.equal(handled, 1);
});

test('OFFER-11-A-DOUBLE-TAP-CANNOT-SEND-TWO-RESPONSES', async () => {
  // The buttons disable on the next render; the screen's handler must refuse a second call before then.
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  const handler = screen.slice(screen.indexOf('async function handleRespondToShift'), screen.indexOf('useEffect(', screen.indexOf('async function handleRespondToShift')));
  assert.match(handler, /if \(respondInFlightRef\.current\) return;\s*respondInFlightRef\.current = true;/, 'refuse re-entry before anything else');
  assert.ok(handler.indexOf('respondInFlightRef.current) return') < handler.indexOf('await respondToShift('), 'the guard runs before the request');
  assert.match(handler, /finally \{\s*respondInFlightRef\.current = false;/, 'and is released however the request ends, so a retry works');
});

// Expired offers (owner rule, 21 Oct 2026): accept before start or while running; never at or after the end.
const ENDED = offer(7, -14);   // 14 h ago → 2 h ago: over (production shift 42's shape)
const STARTED = offer(8, -2);  // started 2 h ago, ends in 10 h: a late replacement

test('OFFER-12-AN-ENDED-OFFER-SAYS-SO-AND-CANNOT-BE-ACCEPTED-BUT-CAN-BE-DECLINED', async () => {
  const { renderer, responses } = await mount({ offers: [ENDED] });
  const card = renderer.root.findAll((n) => n.props?.children === 'This shift has ended — it can no longer be accepted.');
  assert.ok(card.length, 'the card says the shift has ended');
  await press(reviewButtons(renderer)[0]);
  const accept = one(renderer, 'Offer expired: this shift has ended');
  assert.equal(accept.props.disabled, true, 'Accept is disabled');
  assert.ok(renderer.root.findAll((n) => n.props?.children === 'Offer expired').length, 'and labelled Offer expired');
  await press(accept);
  assert.deepEqual(responses, [], 'nothing is sent even if pressed');
  assert.ok(byLabel(renderer, 'Accept this shift').length === 0, 'no live Accept anywhere for an ended offer');
  await press(one(renderer, 'Decline this shift offer'));
  await press(one(renderer, 'Confirm decline'));
  assert.deepEqual(responses, [[7, 'rejected']], 'Decline still works for an ended offer');
});

test('OFFER-13-A-STARTED-OFFER-SAYS-SO-AND-CAN-STILL-BE-ACCEPTED', async () => {
  const { renderer, responses } = await mount({ offers: [STARTED] });
  assert.ok(renderer.root.findAll((n) => n.props?.children === 'Already started — accept only if you can get there now.').length, 'the card says it has started');
  await press(reviewButtons(renderer)[0]);
  const accept = one(renderer, 'Accept this shift');
  assert.notEqual(accept.props.disabled, true, 'a late replacement can be accepted');
  await press(accept);
  assert.deepEqual(responses, [[8, 'accepted']]);
});

test('OFFER-14-THE-SERVER-EXPIRED-ANSWER-IS-SHOWN-AS-OFFER-EXPIRED', async () => {
  const timing = loadComponent('src/components/guard/offerTiming.ts');
  // The device clock only shapes the display; the boundaries match the server's rule.
  const s = '2026-10-20T18:00:00.000Z', e = '2026-10-21T06:00:00.000Z';
  assert.equal(timing.offerTiming(s, e, Date.parse(s) - 1), 'upcoming');
  assert.equal(timing.offerTiming(s, e, Date.parse(s)), 'started');
  assert.equal(timing.offerTiming(s, e, Date.parse(e) - 1), 'started');
  assert.equal(timing.offerTiming(s, e, Date.parse(e)), 'ended');
  assert.equal(timing.isOfferExpiredError({ status: 409, body: { code: 'SHIFT_OFFER_EXPIRED', message: 'x' } }), true);
  assert.equal(timing.isOfferExpiredError({ status: 409, body: { message: 'Shift is already ready' } }), false, 'other conflicts stay "no longer available"');
  assert.equal(timing.isOfferExpiredError(new Error('network')), false);
  // The screen checks for it first, so an expiry is never reported as a withdrawn offer.
  const screen = codeOf('src/screens/GuardDashboardScreen.tsx');
  const handler = screen.slice(screen.indexOf('async function handleRespondToShift'), screen.indexOf('useEffect(', screen.indexOf('async function handleRespondToShift')));
  assert.ok(handler.indexOf('isOfferExpiredError(error)') > 0 && handler.indexOf('isOfferExpiredError(error)') < handler.indexOf('const isStaleOffer'));
  assert.match(handler, /showAlert\(OFFER_EXPIRED_TITLE, OFFER_EXPIRED_MESSAGE\)/);
  assert.match(timing.OFFER_EXPIRED_MESSAGE, /already ended/);
});

(async () => {
  for (const [name, fn] of pending) {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  }
  console.log(`\n${passed} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
