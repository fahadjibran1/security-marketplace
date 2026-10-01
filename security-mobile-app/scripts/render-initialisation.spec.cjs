#!/usr/bin/env node
/**
 * Nothing that runs DURING a render may reach a binding declared later in the component body.
 * (P0 white-screen hotfix.)
 *
 * THE FAILURE THIS EXISTS FOR
 * The 8f574bf release bundled cleanly, typechecked cleanly, passed every suite, and then painted a
 * white screen in production:
 *
 *   Uncaught ReferenceError: Cannot access 'Wi' before initialization
 *
 * `Wi` was `resolveShiftZone`, a `const ... = React.useCallback(...)` declared at line 2390 of
 * CompanyDashboardScreen. A `React.useMemo` factory at line 1891 called it. A useMemo factory runs
 * DURING the render, at the point the hook is called — so when it ran, the `const` four hundred lines
 * below had not been initialised and was still in its temporal dead zone.
 *
 * WHY NOTHING CAUGHT IT
 * TypeScript cannot know when a closure runs, so referencing a later `const` from inside one is legal
 * at compile time. `expo export` resolves and bundles the module graph; it executes nothing. And the
 * call sat inside `.forEach()` over alerts of type `missing_book_off` — so it only threw when such an
 * alert existed. Production had one; no test fixture did.
 *
 * So this is a STATIC check, deliberately: it does not depend on having the right data, and it fails
 * the moment the ordering is wrong rather than only when a particular row exists.
 *
 * useMemo factories are checked; useCallback and useEffect bodies are not, because those run after the
 * component body has finished and may legitimately reference anything in it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error('      ' + (error && error.message));
    process.exitCode = 1;
  }
};

/** Comments and string/template literals removed, with offsets preserved so positions stay comparable. */
function blankOutLiterals(source) {
  const out = source.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      let k = i + 1;
      while (k < source.length && source[k] !== quote) {
        if (source[k] === '\\') k += 1;
        k += 1;
      }
      blank(i + 1, k);
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** The span of the parenthesised argument list starting at `open`. */
function parenSpan(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return [open, i];
    }
  }
  return [open, source.length];
}

const SCREENS = [
  'src/screens/CompanyDashboardScreen.tsx',
  'src/screens/GuardDashboardScreen.tsx',
  'src/components/company/CompanyLiveOperationsWorkspace.tsx',
  'src/components/company/CompanyOperationsTimeline.tsx',
];

/**
 * Every `const` declared at the top level of a component body, with the offset at which it becomes
 * initialised, and every `useMemo` factory, with the span that executes during the render.
 */
function analyse(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = blankOutLiterals(raw);

  const declarations = new Map();
  const declRe = /\n\s{2,6}const\s+([A-Za-z_$][\w$]*)\s*[:=]/g;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    if (!declarations.has(m[1])) declarations.set(m[1], m.index);
  }

  const violations = [];
  const memoRe = /React\.useMemo\s*\(/g;
  while ((m = memoRe.exec(code)) !== null) {
    const [start, end] = parenSpan(code, m.index + m[0].length - 1);
    const body = code.slice(start, end);
    const line = raw.slice(0, m.index).split('\n').length;

    const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let use;
    while ((use = idRe.exec(body)) !== null) {
      const name = use[2];
      const declaredAt = declarations.get(name);
      if (declaredAt === undefined) continue;
      // A binding declared INSIDE the factory is local to it and already initialised by the time the
      // rest of the body runs. Only one declared after the whole expression is in its dead zone.
      if (declaredAt > end) {
        violations.push({
          file,
          name,
          usedAtLine: line,
          declaredAtLine: raw.slice(0, declaredAt).split('\n').length + 1,
        });
      }
    }
  }
  return violations;
}

test('TDZ-01-NO-USEMEMO-REACHES-A-BINDING-DECLARED-BELOW-IT', () => {
  // The exact shape of the production white screen. A useMemo factory runs while the component body
  // is still executing, so anything it calls must already be initialised.
  const all = SCREENS.flatMap(analyse);
  const unique = [...new Map(all.map((v) => [`${v.file}:${v.name}:${v.usedAtLine}`, v])).values()];

  if (unique.length) {
    const detail = unique
      .map((v) => `  ${v.file}: useMemo at line ${v.usedAtLine} calls '${v.name}', declared at line ${v.declaredAtLine}`)
      .join('\n');
    throw new Error(
      `temporal-dead-zone access during render — this is the white-screen defect:\n${detail}`,
    );
  }
});

test('TDZ-02-THE-CHECK-ITSELF-DETECTS-THE-PATTERN', () => {
  // A check that cannot fail proves nothing. This is the pre-fix arrangement in miniature: a useMemo
  // that calls a const declared after it.
  const fixture = `
export function Broken() {
  const items = React.useMemo(() => {
    return later(1);
  }, []);
  const later = React.useCallback((n) => n, []);
  return items;
}
`;
  const tmp = path.join(ROOT, 'scripts', '.tdz-fixture.tsx');
  fs.writeFileSync(tmp, fixture);
  try {
    const found = analyse('scripts/.tdz-fixture.tsx');
    assert.equal(found.length, 1, 'the detector finds the ordering violation');
    assert.equal(found[0].name, 'later');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('TDZ-03-A-USECALLBACK-BODY-IS-NOT-A-VIOLATION', () => {
  // Deferred execution is legitimate: a callback body runs on an event, long after the component body
  // has finished. Flagging those would make the check useless noise.
  const fixture = `
export function Fine() {
  const open = React.useCallback(() => {
    return later(1);
  }, []);
  const later = React.useCallback((n) => n, []);
  return open;
}
`;
  const tmp = path.join(ROOT, 'scripts', '.tdz-fixture-ok.tsx');
  fs.writeFileSync(tmp, fixture);
  try {
    assert.deepEqual(analyse('scripts/.tdz-fixture-ok.tsx'), [], 'a useCallback body is allowed');
  } finally {
    fs.unlinkSync(tmp);
  }
});

console.log(`\n${passed} render initialisation checks passed`);
