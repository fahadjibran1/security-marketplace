#!/usr/bin/env node
/**
 * An uncaught render error must not leave S4 as a blank white screen. (S4 Pilot Gate 2.)
 *
 * These tests RENDER: React's real reconciler (react-test-renderer) runs the component tree, a child
 * throws during render exactly as a production bug would, and the assertions are about what is on screen
 * afterwards. Error boundaries only work in a real client renderer — server rendering would simply
 * rethrow — which is why this suite does not use renderToStaticMarkup like the others.
 *
 *   ERROR-BOUNDARY-01  a render exception shows the S4 recovery screen, not nothing
 *   ERROR-BOUNDARY-02  nothing from the failure is echoed: no message, no stack, no operational text
 *   ERROR-BOUNDARY-03  Try again re-renders the app once the fault is gone
 *   ERROR-BOUNDARY-04  Sign out is offered only with a session, and works
 *   ERROR-BOUNDARY-05  works with monitoring disabled, and survives a reporter that itself throws
 *   ERROR-BOUNDARY-06  the REAL App: a screen that throws on first paint yields the recovery screen
 *   ERROR-BOUNDARY-07  control: the same App and fault WITHOUT the boundary leaves nothing on screen
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// React logs every caught render error to console.error; that is expected here and only noise.
const realConsoleError = console.error;
const quiet = async (fn) => {
  console.error = () => undefined;
  try { return await fn(); } finally { console.error = realConsoleError; }
};

const { AppErrorBoundary } = loadTs('src/components/AppErrorBoundary.tsx');

const SENSITIVE = 'Incident 42: intruder at north gate — Log Book: fire door open — token=abc123SECRET';
function Exploding() {
  throw new Error(SENSITIVE);
}

/** Everything a user would read, as one string. */
const visibleText = (renderer) => {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    (node.children || []).forEach(walk);
  };
  walk(renderer.toJSON());
  return out.join(' ').replace(/\s+/g, ' ');
};
const pressByText = async (renderer, label) => {
  const target = renderer.root.findAll((node) => typeof node.props.onPress === 'function' &&
    node.findAll((child) => child.children && child.children.includes(label)).length > 0)[0];
  assert.ok(target, `a control labelled "${label}"`);
  await act(async () => { await target.props.onPress(); });
};

test('ERROR-BOUNDARY-01-RENDER-EXCEPTION-SHOWS-RECOVERY-NOT-BLANK', async () => {
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(AppErrorBoundary, null, h(Exploding))); });
  });
  assert.ok(renderer.toJSON(), 'something is rendered — not a blank screen');
  const text = visibleText(renderer);
  assert.match(text, /\bS4\b/, 'S4-branded');
  assert.match(text, /Something went wrong/);
  assert.match(text, /Try again/);
  assert.doesNotMatch(text, /S4 Security|S4 Guard/, 'the product is called S4');
  assert.equal(renderer.root.findAll((n) => n.props.testID === 'app-error-boundary').length > 0, true);
});

test('ERROR-BOUNDARY-02-NOTHING-FROM-THE-FAILURE-IS-ECHOED', async () => {
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(AppErrorBoundary, null, h(Exploding))); });
  });
  const text = visibleText(renderer);
  for (const fragment of ['Incident 42', 'intruder', 'Log Book', 'token', 'SECRET', 'Error:', 'at Exploding', '.tsx']) {
    assert.ok(!text.includes(fragment), `must not show "${fragment}"`);
  }
});

test('ERROR-BOUNDARY-03-TRY-AGAIN-RECOVERS-ONCE-THE-FAULT-IS-GONE', async () => {
  let broken = true;
  function Flaky() {
    if (broken) throw new Error('transient');
    return h('span', null, 'Dashboard is back');
  }
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(AppErrorBoundary, null, h(Flaky))); });
  });
  assert.match(visibleText(renderer), /Something went wrong/);
  broken = false;
  await pressByText(renderer, 'Try again');
  assert.equal(visibleText(renderer), 'Dashboard is back');
});

test('ERROR-BOUNDARY-04-SIGN-OUT-ONLY-WITH-A-SESSION', async () => {
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(AppErrorBoundary, null, h(Exploding))); });
  });
  assert.doesNotMatch(visibleText(renderer), /Sign out/, 'no session, no sign-out button');

  let signedOut = 0;
  await quiet(async () => {
    await act(async () => {
      renderer = TestRenderer.create(h(AppErrorBoundary, { onSignOut: async () => { signedOut += 1; } }, h(Exploding)));
    });
  });
  assert.match(visibleText(renderer), /Sign out/);
  await quiet(() => pressByText(renderer, 'Sign out'));
  assert.equal(signedOut, 1);
});

test('ERROR-BOUNDARY-05-MONITORING-OPTIONAL-AND-A-FAILING-REPORTER-IS-CONTAINED', async () => {
  const reported = [];
  let renderer;
  await quiet(async () => {
    await act(async () => {
      renderer = TestRenderer.create(h(AppErrorBoundary, { onError: (error) => reported.push(error) }, h(Exploding)));
    });
  });
  assert.equal(reported.length, 1, 'a configured reporter receives the error');
  assert.match(visibleText(renderer), /Something went wrong/);

  await quiet(async () => {
    await act(async () => {
      renderer = TestRenderer.create(h(AppErrorBoundary, { onError: () => { throw new Error('reporter down'); } }, h(Exploding)));
    });
  });
  assert.match(visibleText(renderer), /Something went wrong/, 'recovery screen survives a broken reporter');
});

// ─── the real App ────────────────────────────────────────────────────────────────────────────────────

/**
 * Loads a source module like load-ts.cjs does, but lets named source files be replaced. Used to render the
 * real App.tsx with its device-bound services swapped for inert ones and its sign-in screen swapped for one
 * that throws — the shape of every white-screen bug this codebase has had.
 */
function loadWithOverrides(relativePath, overrides) {
  const cache = new Map();
  const resolveRelative = (fromFile, request) => {
    const base = path.resolve(path.dirname(fromFile), request);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const load = (absolutePath) => {
    const key = path.relative(ROOT, absolutePath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (overrides[key]) return overrides[key];
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;
    const output = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const mod = { exports: {} };
    cache.set(absolutePath, mod);
    const localRequire = (request) => {
      if (request.startsWith('.')) {
        const resolved = resolveRelative(absolutePath, request);
        if (resolved) return load(resolved);
      }
      if (request === 'react-native-safe-area-context') {
        const Pass = ({ children }) => h(React.Fragment, null, children);
        return { SafeAreaProvider: Pass, SafeAreaView: Pass };
      }
      return require(request);
    };
    new Function('module', 'exports', 'require', output)(mod, mod.exports, localRequire);
    return mod.exports;
  };
  return load(path.join(ROOT, relativePath));
}

const noop = () => undefined;
const appOverrides = (extra = {}) => ({
    'src/screens/AuthScreen': {
      AuthScreen: () => { throw new Error(`render bug ${SENSITIVE}`); },
    },
    'src/services/session': {
      loadStoredSession: async () => null,
      persistSession: async () => undefined,
      clearStoredSession: async () => undefined,
    },
    'src/services/attendanceTransport': { installAttendanceLocationTransport: () => noop },
    // Signed-in workspaces are never reached without a session; they are replaced only so their device
    // dependencies (document picker, location) need not load in Node.
    'src/screens/CompanyDashboardScreen': { CompanyDashboardScreen: () => null },
    'src/screens/GuardDashboardScreen': { GuardDashboardScreen: () => null },
    'src/screens/AdminDashboardScreen': { AdminDashboardScreen: () => null },
    'src/screens/ClientPortalScreen': { ClientPortalScreen: () => null },
    'src/services/api': {
      clearLocalSession: noop, fetchCurrentUser: async () => ({}), getRefreshToken: () => null, logout: async () => undefined,
      restoreSession: noop, setRefreshPersister: noop, setUnauthorizedHandler: noop,
    },
    ...extra,
});

test('ERROR-BOUNDARY-06-THE-REAL-APP-NEVER-PAINTS-A-BLANK-SCREEN', async () => {
  const App = loadWithOverrides('App.tsx', appOverrides()).default;
  let renderer;
  await quiet(async () => {
    await act(async () => { renderer = TestRenderer.create(h(App)); });
    // Let the session bootstrap resolve so the (throwing) sign-in screen is actually reached.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  });
  const text = visibleText(renderer);
  assert.ok(renderer.toJSON(), 'the app rendered something');
  assert.match(text, /Something went wrong/, `recovery screen shown, got: ${text.slice(0, 200)}`);
  assert.ok(!text.includes('intruder') && !text.includes('render bug'), 'the failure is not echoed');
  assert.doesNotMatch(text, /Sign out/, 'no session on the sign-in screen, so no sign-out');
});

test('ERROR-BOUNDARY-07-CONTROL-WITHOUT-THE-BOUNDARY-THE-SAME-FAULT-BLANKS-THE-APP', async () => {
  // Proves 06 is not passing by accident: replace only the boundary with a pass-through and the very
  // same fault takes the whole tree down — React unmounts everything, which in a browser is the white
  // screen.
  const App = loadWithOverrides('App.tsx', appOverrides({
    'src/components/AppErrorBoundary': { AppErrorBoundary: ({ children }) => h(React.Fragment, null, children) },
  })).default;
  let renderer;
  let thrown = null;
  await quiet(async () => {
    try {
      await act(async () => { renderer = TestRenderer.create(h(App)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    } catch (error) {
      thrown = error;
    }
  });
  assert.ok(thrown, 'the render error escapes when there is no boundary');
  assert.equal(renderer.toJSON(), null, 'and nothing is left on screen');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && (error.stack || error.message)));
      process.exitCode = 1;
    }
  }
  console.log(`\nERROR BOUNDARY: ${passed}/${pending.length} PASS`);
})();
