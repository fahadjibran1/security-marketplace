/**
 * Web rendering safety for raw DOM elements.
 *
 * Production UAT hit a white screen:
 *
 *   Uncaught TypeError: Failed to set an indexed property [0] on 'CSSStyleDeclaration':
 *   Indexed property setter is not supported.
 *
 * React Native flattens style arrays itself, so `style={[a, b]}` is correct on a React Native
 * component. A RAW DOM element is different: React DOM assigns the style object's own keys straight
 * onto CSSStyleDeclaration, and an array's keys are 0, 1, … so the browser is asked to set an indexed
 * property and throws, blanking the page.
 *
 * These checks render real elements through react-dom/server and inspect the emitted markup, which
 * makes the defect visible without a browser: an array style serialises to `style="0:[object Object]"`,
 * a numeric CSS property that no browser can accept. The previous tests for this feature were
 * source-text assertions and could not have caught it — that is why UAT did.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** True when the rendered markup contains a numeric CSS property, which crashes a real browser. */
function hasIndexedStyle(markup) {
  return /style="[^"]*\b\d+:/.test(markup);
}

// ═══════════════════ the mechanism, demonstrated ═══════════════════

test('WEBSTYLE-01-AN-ARRAY-STYLE-ON-A-RAW-DOM-ELEMENT-EMITS-A-NUMERIC-CSS-PROPERTY', () => {
  const base = { height: 40, borderWidth: 1.5 };
  const error = { borderColor: 'red' };
  const Tag = 'input';

  const arrayMarkup = renderToStaticMarkup(React.createElement(Tag, { type: 'date', style: [base, error] }));
  assert.ok(
    hasIndexedStyle(arrayMarkup),
    `an array style must be detectable as broken, got ${arrayMarkup}`,
  );
  assert.match(arrayMarkup, /style="0:/, 'the array index becomes the CSS property name');

  // The same shape the production crash had: a falsy second entry still produces index 0.
  const falsyMarkup = renderToStaticMarkup(React.createElement(Tag, { type: 'date', style: [base, false] }));
  assert.ok(hasIndexedStyle(falsyMarkup), 'a falsy second entry does not save it');

  const objectMarkup = renderToStaticMarkup(
    React.createElement(Tag, { type: 'date', style: { ...base, ...error } }),
  );
  assert.ok(!hasIndexedStyle(objectMarkup), 'a flattened object is safe');
  assert.match(objectMarkup, /height:40px/, 'and produces real CSS');
});

// ═══════════════════ the Add Shift inputs, rendered ═══════════════════

/**
 * The two web inputs from the Add Shift drawer, reproduced exactly as the component composes them.
 * Rendering the whole workspace would need a DOM and effects; this renders the precise elements that
 * crashed, with the precise style expression the source now uses.
 */
function rotaWebInput(hasError) {
  const source = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  const expr = /style=\{\{ \.\.\.nativeInputStyle, \.\.\.\(hasError \? nativeInputErrorStyle : null\) \}\}/g;
  const occurrences = (source.match(expr) || []).length;
  const nativeInputStyle = {
    height: 40, borderWidth: 1.5, borderColor: '#ccc', borderRadius: 6,
    paddingHorizontal: 12, fontSize: 14, color: '#111', backgroundColor: '#fff', outlineStyle: 'none',
  };
  const nativeInputErrorStyle = { borderColor: '#b42318', backgroundColor: '#fef3f2' };
  const Tag = 'input';
  return {
    occurrences,
    markup: renderToStaticMarkup(
      React.createElement(Tag, {
        type: 'date',
        style: { ...nativeInputStyle, ...(hasError ? nativeInputErrorStyle : null) },
      }),
    ),
  };
}

test('WEBSTYLE-02-ADD-SHIFT-DATE-AND-TIME-INPUTS-RENDER-WITHOUT-AN-INDEXED-STYLE', () => {
  const clean = rotaWebInput(false);
  const errored = rotaWebInput(true);
  assert.equal(clean.occurrences, 2, 'both the date and time web inputs use the flattened form');
  assert.ok(!hasIndexedStyle(clean.markup), `no numeric CSS property, got ${clean.markup}`);
  assert.ok(!hasIndexedStyle(errored.markup), 'including in the error state');
  assert.match(clean.markup, /height:40px/, 'the base style still applies');
  assert.match(errored.markup, /border-color:#b42318/, 'and the error style still overrides it');
});

test('WEBSTYLE-03-THE-NATIVE-BRANCHES-KEEP-THEIR-ARRAYS', () => {
  // React Native's TextInput flattens arrays itself, so those branches were never broken and must not
  // have been changed: doing so would be churn on the path this defect never touched.
  const source = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  const nativeArrays = (source.match(/^ {6}style=\{\[nativeInputStyle, hasError && nativeInputErrorStyle\]\}$/gm) || []).length;
  assert.equal(nativeArrays, 2, `both native TextInput branches still pass arrays, found ${nativeArrays}`);
});

// ═══════════════════ no raw DOM element anywhere takes an array ═══════════════════

test('WEBSTYLE-04-NO-RAW-DOM-ELEMENT-IN-THE-APP-RECEIVES-A-STYLE-ARRAY', () => {
  // The whole-repo guard. This is the defect class, not one instance of it: any future raw <input>,
  // <select> or <textarea> given a style array will blank the page the moment it renders.
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'dev' && entry.name !== 'node_modules') walk(rel); }
      else if (entry.name.endsWith('.tsx')) files.push(rel);
    }
  })('src');

  const offenders = [];
  for (const file of files) {
    const source = read(file);
    const tagRe = /const (\w+): any = '(input|select|textarea|div|button|span)';/g;
    let declared;
    while ((declared = tagRe.exec(source))) {
      const [, varName, tag] = declared;
      const useRe = new RegExp(`<${varName}\\b([\\s\\S]*?)/?>`, 'g');
      let use;
      while ((use = useRe.exec(source))) {
        const styleMatch = /style=\{\s*\[/.exec(use[1]);
        if (styleMatch) {
          offenders.push(`${file}:${source.slice(0, use.index).split('\n').length} <${tag}>`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `raw DOM elements must not receive style arrays: ${offenders.join(', ')}`);
});

// ═══════════════════ the shortcut and the one-shot guard survive the fix ═══════════════════

test('WEBSTYLE-05-THE-ADD-SHIFT-SHORTCUT-IS-STILL-IN-PLACE', () => {
  const liveOps = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const planner = read('src/components/company/CompanyRotaPlannerWorkspace.tsx');
  const dashboard = read('src/screens/CompanyDashboardScreen.tsx');

  assert.ok(liveOps.includes('+ Add Shift'), 'the Live Operations shortcut was not removed to dodge the crash');
  assert.ok(liveOps.includes('canManageShifts'), 'still permission gated');
  assert.ok(dashboard.includes('setActiveSection("rota-planner")'), 'still navigates to the planner');
  assert.match(planner, /if \(!createShiftIntent\) return;/, 'the one-shot guard is intact');
  assert.ok(planner.includes('title="Add Shift"'), 'and there is still exactly one drawer');
  assert.ok(!liveOps.includes('CreateSlotBody'), 'with no duplicated form');
});

test('WEBSTYLE-06-THE-LIVE-OPERATIONS-BUTTON-STYLE-IS-A-REACT-NATIVE-COMPONENT', () => {
  // The new button is a Pressable, not a raw DOM element, so its style array is correct and must stay
  // an array — Pressable's callback form is how the rest of this component is written.
  const liveOps = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  assert.match(
    liveOps,
    /style=\{\(\{ pressed \}: any\) => \[styles\.addShiftBtn/,
    'the shortcut uses the Pressable callback style the file already uses elsewhere',
  );
  assert.ok(!/const \w+: any = 'button'/.test(liveOps), 'and is not a raw DOM button');
});

console.log(`\n${passed} web style safety checks passed`);
