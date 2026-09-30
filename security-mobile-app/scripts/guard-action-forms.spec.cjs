/**
 * Guard live-shift action forms stay reachable. (Phase 2, P0 pilot blocker.)
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * On the real Android device a Guard could open Check Call / Log / Incident / Welfare / Panic but could
 * not reliably press Submit. Each form was an absolutely-positioned View inside the screen's own view
 * tree, which produced four failures at once:
 *
 *   - zIndex:20 with NO elevation, while the persistent bottom nav carries elevation:6. Android decides
 *     sibling paint order by elevation, so the nav painted over the form — over the Submit row.
 *   - a flat 16px bottom padding, so the card's bottom edge sat under the Android system navigation.
 *   - no ScrollView at all, so content taller than the screen was simply unreachable.
 *   - no keyboard handling, on forms whose main input is a 120px multiline note.
 *
 * WHAT IS ACTUALLY EXECUTED HERE
 * The layout is arithmetic (modalLayout.ts) and the button state is a pure function
 * (guardActionForms.ts), so both are run directly across viewport sizes, inset values and keyboard
 * states. The real ModalFrame is then rendered and its element tree walked, which proves the structural
 * property that makes the fix work: THE FOOTER IS NOT INSIDE THE SCROLL CONTAINER.
 *
 * WHAT CANNOT HONESTLY BE PROVEN HERE
 * Whether a physical Android soft keyboard, on a specific OEM skin, leaves the footer on screen. No
 * assertion in Node can establish that. It is manual Build 11 UAT and is named as such in the report.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped, so assertions are about code and not about prose. */
const codeOf = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const layout = loadTs('src/components/ui/modalLayout.ts');
const actions = loadTs('src/components/guard/guardActionForms.ts');

const {
  resolveModalLayout,
  bodyMustScroll,
  OVERLAY_GUTTER,
  MIN_PANEL_HEIGHT,
  MAX_PANEL_VIEWPORT_RATIO,
} = layout;
const { GUARD_ACTION_FORMS, guardActionForm, resolveActionSubmitState } = actions;

// Real devices in the pilot's range, plus a deliberately cruel one.
const PIXEL_TALL = { height: 892, width: 412 };
const SMALL_ANDROID = { height: 640, width: 360 }; // a 5" budget Android, the pilot's worst case
const TINY = { height: 320, width: 320 };
const ANDROID_INSETS = { top: 24, bottom: 48 }; // status bar + gesture nav
const NO_INSETS = { top: 0, bottom: 0 };

// ═══════════════════ layout arithmetic, executed ═══════════════════

test('FORM-01-THE-PANEL-IS-CAPPED-SO-THE-BODY-HAS-SOMETHING-TO-SCROLL-IN', () => {
  // Without a ceiling the panel sizes to its content, the content overflows the screen, and the
  // ScrollView never scrolls because it was never constrained. This is the load-bearing assertion.
  for (const viewport of [PIXEL_TALL, SMALL_ANDROID]) {
    const l = resolveModalLayout({ viewport, insets: ANDROID_INSETS, platform: 'android' });
    assert.ok(l.panelMaxHeight > 0, 'a ceiling must exist');
    assert.ok(
      l.panelMaxHeight < viewport.height,
      `the panel must be shorter than the screen (${l.panelMaxHeight} vs ${viewport.height})`,
    );
    // It must also clear both insets, or the panel would be under the system bars.
    assert.ok(
      l.panelMaxHeight <= viewport.height - ANDROID_INSETS.top - ANDROID_INSETS.bottom,
      'the ceiling must respect both safe-area insets',
    );
  }
});

test('FORM-02-SAFE-AREA-INSETS-ARE-ADDED-NOT-ASSUMED', () => {
  const withInsets = resolveModalLayout({ viewport: PIXEL_TALL, insets: ANDROID_INSETS, platform: 'android' });
  const without = resolveModalLayout({ viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'android' });

  assert.equal(withInsets.overlayPaddingBottom, OVERLAY_GUTTER + ANDROID_INSETS.bottom);
  assert.equal(withInsets.overlayPaddingTop, OVERLAY_GUTTER + ANDROID_INSETS.top);
  assert.equal(without.overlayPaddingBottom, OVERLAY_GUTTER, 'with no inset it is just the gutter');

  // The old code used a flat 16 regardless. On a gesture-nav device that put Submit under the system bar.
  assert.ok(withInsets.overlayPaddingBottom > 16, 'must clear more than the old flat 16px padding');
  assert.ok(
    withInsets.overlayPaddingBottom >= ANDROID_INSETS.bottom,
    'the system navigation inset must be fully cleared',
  );
});

test('FORM-03-A-NEGATIVE-OR-ABSENT-INSET-CANNOT-SHRINK-THE-GUTTER', () => {
  const l = resolveModalLayout({ viewport: PIXEL_TALL, insets: { top: -10, bottom: -50 }, platform: 'android' });
  assert.equal(l.overlayPaddingTop, OVERLAY_GUTTER);
  assert.equal(l.overlayPaddingBottom, OVERLAY_GUTTER);
});

test('FORM-04-A-TINY-VIEWPORT-KEEPS-A-USABLE-PANEL-INSTEAD-OF-COLLAPSING', () => {
  // Squeezing the panel to nothing is unrecoverable; keeping a floor and letting the body scroll is not.
  const l = resolveModalLayout({ viewport: TINY, insets: ANDROID_INSETS, platform: 'android' });
  assert.equal(l.panelMaxHeight, MIN_PANEL_HEIGHT);
  assert.ok(MIN_PANEL_HEIGHT >= 200, 'the floor must leave room for a header, an input and the actions');
});

test('FORM-05-IOS-AVOIDS-THE-KEYBOARD-ITSELF-ANDROID-DOES-NOT-DOUBLE-COUNT-IT', () => {
  // iOS overlays the keyboard, so the view must give way. Android resizes the window instead, so asking
  // for avoidance as well would subtract the keyboard twice and push the footer off the top.
  const ios = resolveModalLayout({ viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'ios' });
  const android = resolveModalLayout({ viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'android' });
  const web = resolveModalLayout({ viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'web' });
  assert.equal(ios.keyboardBehavior, 'padding');
  assert.equal(android.keyboardBehavior, undefined);
  assert.equal(web.keyboardBehavior, undefined);

  const iosOpen = resolveModalLayout({
    viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'ios', keyboardVisible: true, keyboardHeight: 336,
  });
  assert.ok(iosOpen.panelMaxHeight < ios.panelMaxHeight, 'iOS takes the keyboard off the available height');

  const androidOpen = resolveModalLayout({
    viewport: PIXEL_TALL, insets: NO_INSETS, platform: 'android', keyboardVisible: true, keyboardHeight: 336,
  });
  assert.equal(
    androidOpen.panelMaxHeight, android.panelMaxHeight,
    'Android must NOT subtract it again — the viewport height already shrank',
  );
});

test('FORM-06-KEYBOARD-OPEN-ON-A-SMALL-ANDROID-SCREEN-STILL-LEAVES-A-USABLE-PANEL', () => {
  // softwareKeyboardLayoutMode is 'resize', so the keyboard arrives as a shorter viewport.
  const shrunk = { height: SMALL_ANDROID.height - 280, width: SMALL_ANDROID.width };
  const l = resolveModalLayout({ viewport: shrunk, insets: ANDROID_INSETS, platform: 'android' });
  assert.ok(l.panelMaxHeight >= MIN_PANEL_HEIGHT, 'still usable');
  assert.ok(l.panelMaxHeight <= shrunk.height, 'and never taller than what is left of the screen');
});

test('FORM-07-THE-INTERESTING-CASE-THE-BODY-REALLY-DOES-NEED-TO-SCROLL', () => {
  const l = resolveModalLayout({ viewport: SMALL_ANDROID, insets: ANDROID_INSETS, platform: 'android' });
  const header = 72;
  const footer = 76;
  // A 120px multiline note plus a helper line and padding, on a keyboard-shrunk small screen.
  assert.equal(
    bodyMustScroll({ contentHeight: 600, headerHeight: header, footerHeight: footer, panelMaxHeight: l.panelMaxHeight }),
    true,
    'long content must be reported as needing scroll',
  );
  assert.equal(
    bodyMustScroll({ contentHeight: 80, headerHeight: header, footerHeight: footer, panelMaxHeight: l.panelMaxHeight }),
    false,
    'and short content must not',
  );
});

test('FORM-08-SHORT-CONTENT-DOES-NOT-PRODUCE-A-GIANT-BLANK-PANEL', () => {
  // The ceiling is a maximum, never a minimum: the panel is free to be small for a one-line form.
  const l = resolveModalLayout({ viewport: PIXEL_TALL, insets: ANDROID_INSETS, platform: 'android' });
  assert.ok(MAX_PANEL_VIEWPORT_RATIO < 1, 'the backdrop must stay visible so this reads as an overlay');
  const modal = codeOf('src/components/ui/Modal.tsx');
  assert.ok(!/minHeight/.test(modal), 'the panel must not be given a minimum height');
  assert.ok(l.panelMaxHeight > MIN_PANEL_HEIGHT, 'and on a tall screen the ceiling is well above the floor');
});

// ═══════════════════ the modal structure, rendered ═══════════════════

const Modal = loadTsx('src/components/ui/Modal.tsx');

/** Loads a .tsx component module with react-native aliased to react-native-web so it can be executed. */
function loadTsx(rel) {
  const ts = require('typescript');
  const abs = path.join(ROOT, rel);
  const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText;
  const mod = { exports: {} };
  const localRequire = (request) => {
    if (request === 'react-native') return require('react-native-web');
    if (request === 'react-native-safe-area-context') {
      return { useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) };
    }
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(abs), request);
      for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate.endsWith('.tsx') ? loadTsx(path.relative(ROOT, candidate)) : loadTs(path.relative(ROOT, candidate));
        }
      }
    }
    return require(request);
  };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, localRequire);
  return mod.exports;
}

/** Depth-first walk of a React element tree, yielding every element. */
function* walk(node) {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node.props) return;
  yield node;
  yield* walk(node.props.children);
}

/**
 * Names an element by IDENTITY against the react-native-web exports, because several of them are
 * anonymous forwardRef objects with no displayName — matching on a name would silently never match.
 */
const RNW_NAMES = (() => {
  const RNW = require('react-native-web');
  const map = new Map();
  for (const key of ['Modal', 'ScrollView', 'KeyboardAvoidingView', 'View', 'Text', 'Pressable', 'TextInput']) {
    if (RNW[key]) map.set(RNW[key], key);
  }
  return map;
})();

function nameOf(element) {
  const t = element.type;
  if (typeof t === 'string') return t;
  if (RNW_NAMES.has(t)) return RNW_NAMES.get(t);
  return t?.displayName || t?.name || 'Anonymous';
}

function renderFrame(extra = {}) {
  const RNW = require('react-native-web');
  return Modal.ModalFrame({
    visible: true,
    onClose: () => {},
    title: 'Check Call',
    viewport: SMALL_ANDROID,
    insets: ANDROID_INSETS,
    platform: 'android',
    children: React.createElement(RNW.TextInput, { accessibilityLabel: 'note', multiline: true }),
    footer: React.createElement(RNW.Text, null, 'Record Check Call'),
    ...extra,
  });
}

test('FORM-09-THE-FORM-IS-HOSTED-IN-A-REAL-MODAL-NOT-AN-ABSOLUTE-VIEW', () => {
  // A real Modal renders in its own window above the host hierarchy, so the bottom navigation's
  // elevation cannot beat it. That is the fix for the overlap; a zIndex could not be.
  const tree = renderFrame();
  const names = [...walk(tree)].map(nameOf);
  assert.ok(names.includes('Modal'), `expected a Modal at the root, got ${names.slice(0, 4).join(' > ')}`);
  assert.equal(nameOf(tree), 'Modal', 'and it must be the outermost element');
});

test('FORM-10-THERE-IS-A-SCROLL-CONTAINER-AND-THE-FOOTER-IS-OUTSIDE-IT', () => {
  const tree = renderFrame();
  const elements = [...walk(tree)];

  const scroll = elements.find((el) => nameOf(el) === 'ScrollView');
  assert.ok(scroll, 'the body must be scrollable');
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled', 'a tap must land while an input has focus');

  // The load-bearing structural property: the footer must NOT be reachable from inside the ScrollView.
  const insideScroll = [...walk(scroll.props.children)];
  const footerTextInside = insideScroll.some(
    (el) => el.props && el.props.children === 'Record Check Call',
  );
  assert.equal(footerTextInside, false, 'the action row must not live inside the scrollable area');

  const footerTextAnywhere = elements.some((el) => el.props && el.props.children === 'Record Check Call');
  assert.equal(footerTextAnywhere, true, 'but it must still be rendered');
});

test('FORM-11-THE-KEYBOARD-AVOIDER-IS-PRESENT-AND-CARRIES-THE-PANEL-CEILING', () => {
  const tree = renderFrame();
  const kav = [...walk(tree)].find((el) => nameOf(el) === 'KeyboardAvoidingView');
  assert.ok(kav, 'a KeyboardAvoidingView must wrap the panel');
  assert.equal(kav.props.behavior, undefined, 'undefined on Android, which resizes instead');

  const flat = require('react-native-web').StyleSheet.flatten(kav.props.style);
  assert.ok(flat.maxHeight > 0, `the panel must carry a maxHeight, got ${JSON.stringify(flat.maxHeight)}`);
  const expected = resolveModalLayout({
    viewport: SMALL_ANDROID, insets: ANDROID_INSETS, platform: 'android',
  }).panelMaxHeight;
  assert.equal(flat.maxHeight, expected, 'and it must be the value the layout module computed');

  const iosTree = renderFrame({ platform: 'ios' });
  const iosKav = [...walk(iosTree)].find((el) => nameOf(el) === 'KeyboardAvoidingView');
  assert.equal(iosKav.props.behavior, 'padding', 'iOS must avoid the keyboard itself');
});

test('FORM-12-THE-OVERLAY-PADDING-CARRIES-THE-SAFE-AREA', () => {
  const tree = renderFrame();
  const overlay = [...walk(tree)].find(
    (el) => nameOf(el) === 'View' && require('react-native-web').StyleSheet.flatten(el.props.style)?.paddingBottom != null,
  );
  assert.ok(overlay, 'the overlay must set its own padding');
  const flat = require('react-native-web').StyleSheet.flatten(overlay.props.style);
  assert.equal(flat.paddingBottom, OVERLAY_GUTTER + ANDROID_INSETS.bottom);
  assert.equal(flat.paddingTop, OVERLAY_GUTTER + ANDROID_INSETS.top);
});

test('FORM-13-A-MODAL-WITH-NO-FOOTER-STILL-RENDERS', () => {
  const tree = renderFrame({ footer: undefined });
  const names = [...walk(tree)].map(nameOf);
  assert.ok(names.includes('ScrollView'), 'the body still scrolls');
  assert.equal(nameOf(tree), 'Modal');
});

test('FORM-14-IT-RENDERS-ON-WEB-WITHOUT-AN-INDEXED-STYLE-CRASH', () => {
  // Guards the same class of defect test:web-style exists for: an array style reaching a raw DOM node
  // serialises to `style="0:[object Object]"` and blanks the page.
  //
  // The PANEL subtree is rendered rather than the whole modal, because react-native-web's Modal mounts
  // through a DOM portal and renderToStaticMarkup has no document to portal into — it returns an empty
  // string, and a length check against that would pass while testing nothing. The panel is where this
  // component's own styles live, including the computed maxHeight and the overlay padding.
  const { renderToStaticMarkup } = require('react-dom/server');
  const tree = renderFrame({ platform: 'web' });
  const panel = [...walk(tree)].find((el) => nameOf(el) === 'KeyboardAvoidingView');
  assert.ok(panel, 'the panel must be found');

  const markup = renderToStaticMarkup(React.createElement(() => panel));
  assert.ok(markup.length > 0, 'the panel must render to markup');
  assert.ok(!/style="[^"]*\b\d+:/.test(markup), `no numeric CSS property may be emitted: ${markup.slice(0, 300)}`);
  assert.match(markup, /Record Check Call/, 'and the action label must reach the document');
  assert.match(markup, /Check Call/, 'along with the title');
});

// ═══════════════════ the action inventory and submit state ═══════════════════

test('FORM-15-EVERY-AFFECTED-ACTION-IS-IN-THE-INVENTORY-WITH-ITS-CURRENT-WORDING', () => {
  const keys = GUARD_ACTION_FORMS.map((f) => f.key);
  assert.deepEqual(keys, ['log', 'checkCall', 'incident', 'welfare', 'panic']);

  // Phase 5 will rationalise this vocabulary. Until then it must not drift, or a UAT report stops
  // matching what the tester sees.
  assert.equal(guardActionForm('log').title, 'Add Log');
  assert.equal(guardActionForm('checkCall').title, 'Check Call');
  assert.equal(guardActionForm('checkCall').submitLabel, 'Record Check Call');
  assert.equal(guardActionForm('incident').title, 'Incident');
  assert.equal(guardActionForm('welfare').submitLabel, 'Send Welfare Update');
  assert.equal(guardActionForm('panic').title, 'Panic');
  assert.equal(guardActionForm('panic').confirmWord, 'PANIC');
  assert.equal(guardActionForm('panic').destructive, true);

  for (const form of GUARD_ACTION_FORMS) {
    assert.ok(form.submitLabel && form.busyLabel, `${form.key} needs both labels`);
    assert.ok(form.placeholder, `${form.key} needs a placeholder`);
    assert.ok(form.launchAccessibilityLabel, `${form.key} needs an accessible launcher`);
  }
});

test('FORM-16-THE-BUTTON-IS-ENABLED-ONLY-WHEN-THE-HANDLER-WOULD-ACCEPT-IT', () => {
  for (const form of GUARD_ACTION_FORMS.filter((f) => !f.confirmWord)) {
    assert.equal(resolveActionSubmitState(form, { value: '', busy: false }).disabled, true, `${form.key} empty`);
    assert.equal(resolveActionSubmitState(form, { value: '   ', busy: false }).disabled, true, `${form.key} whitespace`);
    const ready = resolveActionSubmitState(form, { value: 'All quiet on the gate.', busy: false });
    assert.equal(ready.disabled, false, `${form.key} with a real note`);
    assert.equal(ready.label, form.submitLabel);
    assert.equal(ready.blockedReason, null);
  }
});

test('FORM-17-PANIC-REQUIRES-THE-CONFIRMATION-WORD', () => {
  const panic = guardActionForm('panic');
  for (const bad of ['', 'panick', 'PAN', 'help']) {
    const state = resolveActionSubmitState(panic, { value: bad, busy: false });
    assert.equal(state.disabled, true, `"${bad}" must not enable an emergency alert`);
    assert.equal(state.blockedReason, 'confirmation');
  }
  // Case and surrounding space are forgiven, exactly as the handler forgives them.
  for (const good of ['PANIC', 'panic', '  Panic  ']) {
    assert.equal(resolveActionSubmitState(panic, { value: good, busy: false }).disabled, false, `"${good}"`);
  }
});

test('FORM-18-A-SUBMISSION-IN-FLIGHT-DISABLES-THE-BUTTON-AND-SAYS-SO', () => {
  // This is the double-tap protection: while busy the button cannot start a second request.
  for (const form of GUARD_ACTION_FORMS) {
    const valid = form.confirmWord ? form.confirmWord : 'a note';
    const busy = resolveActionSubmitState(form, { value: valid, busy: true });
    assert.equal(busy.disabled, true, `${form.key} must be disabled while submitting`);
    assert.equal(busy.label, form.busyLabel, `${form.key} must show its busy label`);
    assert.equal(busy.blockedReason, 'busy');
  }
});

// ═══════════════════ the screen actually uses all of it ═══════════════════

const SCREEN = 'src/screens/GuardDashboardScreen.tsx';

test('FORM-19-NO-HAND-ROLLED-OVERLAY-SURVIVES-IN-THE-GUARD-SCREEN', () => {
  const screen = codeOf(SCREEN);
  // The exact shape of the defect: an absolutely-positioned backdrop inside the screen tree.
  assert.ok(!/styles\.modalBackdrop/.test(screen), 'the fake-modal backdrop must be gone');
  assert.ok(!/styles\.modalCard/.test(screen), 'and its card');
  assert.ok(!/summarySheetWrap|summaryBackdropTapZone|summaryDoneButton/.test(screen), 'and the sheet variant');
  // And the styles themselves must not linger, or they invite reuse.
  assert.ok(!/^\s*modalBackdrop:/m.test(screen), 'the dead style must be deleted, not just unused');
  assert.ok(!/zIndex:\s*20/.test(screen), 'no zIndex-based overlay layering remains');
});

test('FORM-20-ALL-FIVE-ACTIONS-RENDER-THROUGH-APPMODAL-FROM-ONE-RENDERER', () => {
  const screen = codeOf(SCREEN);
  assert.match(screen, /GUARD_ACTION_FORMS\.map\(/, 'one renderer, not five copies');
  assert.match(screen, /<AppModal/, 'hosted by the shared modal');
  assert.match(screen, /resolveActionSubmitState\(form, \{ value, busy \}\)/, 'using the tested submit state');
  // Exactly two AppModal usages: the action-form renderer and the shift summary.
  assert.equal((screen.match(/<AppModal/g) || []).length, 2, 'no additional bespoke modal crept in');
  assert.match(screen, /footer=\{/, 'with the actions in the footer slot');
});

test('FORM-21-EVERY-ACTION-ROUTES-THROUGH-THE-ONE-SHARED-DISPATCHER', () => {
  // This used to assert the router called handleCreateLog / handleCreateIncident and so on by name.
  // Phase 3A-iii removed those four handlers: their routing, preconditions and API writes moved into
  // guardActionDispatch.ts so the press-to-API path could be EXECUTED rather than pattern-matched.
  // Build 11 is exactly why that mattered — the router was provably reached and no request was ever
  // emitted, which a source-text assertion like the old one could never have caught.
  //
  // What each action actually sends is now certified by execution in guard-action-dispatch.spec.cjs
  // (DISPATCH-01..05). This keeps only the structural half: one dispatcher, no second path.
  const screen = codeOf(SCREEN);
  const start = screen.indexOf('const submitQuickAction');
  assert.ok(start > 0, 'the router must exist');
  const router = screen.slice(start, screen.indexOf('\n  };', start));

  assert.ok(router.includes('await dispatchGuardAction('), 'it must delegate to the shared dispatcher');
  for (const payloadCall of ['createDailyLog({', 'createIncident({', 'createSafetyAlert({']) {
    assert.ok(!router.includes(payloadCall), `the router must build no API payload of its own (${payloadCall})`);
  }
});

test('FORM-22-THE-BUSY-FLAG-COMES-FROM-THE-EXISTING-SUBMISSION-STATE', () => {
  const screen = codeOf(SCREEN);
  const busy = /const actionFormBusy[\s\S]*?submittingDailyLogType !== null;/.exec(screen);
  assert.ok(busy, 'the busy lookup must exist');
  for (const flag of ['submittingIncident', 'submittingAlertType', 'submittingDailyLogType']) {
    assert.ok(busy[0].includes(flag), `${flag} must still drive the button`);
  }
  // Closing during a submission would orphan the request's feedback.
  assert.match(screen, /closeOnBackdrop=\{!busy\}/, 'the backdrop must not dismiss mid-submission');
});

test('FORM-23-PHASE-5-TERMINOLOGY-IS-EXPLICITLY-NOT-DONE-YET', () => {
  // Guards against a well-meaning rename landing with the layout fix and making a UAT regression
  // impossible to attribute.
  const titles = GUARD_ACTION_FORMS.map((f) => f.title);
  assert.ok(titles.includes('Add Log'), 'still "Add Log", not "Log Book"');
  assert.ok(titles.includes('Welfare'), 'still "Welfare", not "Welfare Check"');
  assert.ok(!titles.includes('Site Request'), 'Site Request is Phase 5');
  assert.ok(!titles.includes('Emergency'), 'Emergency is Phase 5');
});

console.log(`\n${passed} guard action form checks passed`);
