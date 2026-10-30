const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'services', 'api-base-url.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('exports', 'module', 'require', compiled)(
  moduleUnderTest.exports,
  moduleUnderTest,
  require,
);

const { LIVE_API_BASE_URL, resolveApiBaseUrl } = moduleUnderTest.exports;

// The value, not just the precedence. Every assertion below uses LIVE_API_BASE_URL on both sides, so
// they prove which input wins but would happily pass if the constant itself were repointed at staging —
// which is the exact confusion the pilot build inventory uncovered. Pin the host explicitly.
assert.equal(
  LIVE_API_BASE_URL,
  'https://security-marketplace-api.onrender.com',
  'the live API fallback must be the PRODUCTION host, never staging',
);
assert.doesNotMatch(LIVE_API_BASE_URL, /staging/i, 'and must never contain staging');

assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'localhost',
  }),
  'http://localhost:3000',
  'localhost web must default to the local NestJS backend',
);
assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: '127.0.0.1',
  }),
  'http://localhost:3000',
  '127.0.0.1 web must default to the local NestJS backend',
);
assert.equal(
  resolveApiBaseUrl({
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'dashboard.observantsecurity.co.uk',
  }),
  LIVE_API_BASE_URL,
  'production web must retain the configured live API',
);
assert.equal(
  resolveApiBaseUrl({ configuredUrl: LIVE_API_BASE_URL }),
  LIVE_API_BASE_URL,
  'native must retain the configured API URL',
);
assert.equal(
  resolveApiBaseUrl({
    environmentUrl: 'https://explicit.example.test',
    configuredUrl: LIVE_API_BASE_URL,
    webHostname: 'localhost',
  }),
  'https://explicit.example.test',
  'an explicit environment override must have highest precedence',
);

console.log('API base URL selection regression tests passed (5/5).');


// ---------------------------------------------------------------------------------------------------------------
// The S4 UAT app fails closed (30 Oct 2026). It must never fall back to the live API when its configuration is
// missing, and must refuse production and any unapproved endpoint. The approved endpoint (staging) is named only in
// app.config.js (uat-variant UAT-07), so the guarantee has two halves, both tested here: the build cannot produce a
// UAT configuration for any other server (UATAPI-05), and the app refuses anything but two identical, valid copies.
const {
  UAT_API_NOT_CONFIGURED,
  isUatBuild,
  resolveUatApiBaseUrl,
} = moduleUnderTest.exports;
const STAGING = 'https://security-marketplace-api-staging.onrender.com';
const ROOT = path.join(__dirname, '..');
const makeConfig = require(path.join(ROOT, 'app.config.js'));
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const CONFIG_KEYS = ['APP_VARIANT', 'EXPO_PUBLIC_API_URL', 'EAS_BUILD', 'UAT_ANDROID_VERSION_CODE'];
function buildConfig(vars) {
  const before = Object.fromEntries(CONFIG_KEYS.map((k) => [k, process.env[k]]));
  CONFIG_KEYS.forEach((k) => { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
  try {
    return makeConfig({ config: JSON.parse(JSON.stringify(appJson)) });
  } finally {
    CONFIG_KEYS.forEach((k) => { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; });
  }
}
const uatBuildVars = (apiUrl) => ({
  APP_VARIANT: 'uat',
  EAS_BUILD: 'true',
  EXPO_PUBLIC_API_URL: apiUrl,
  UAT_ANDROID_VERSION_CODE: String(appJson.android.versionCode + 1),
});

let uatPassed = 0;
const uat = (id, fn) => { fn(); uatPassed += 1; console.log(`PASS  ${id}`); };
const refused = (input, why) =>
  assert.deepEqual(resolveUatApiBaseUrl(input), { ok: false, reason: UAT_API_NOT_CONFIGURED }, why);

uat('UATAPI-01-THE-REAL-UAT-BUILD-RESOLVES-TO-STAGING-AND-ONLY-STAGING', () => {
  assert.equal(easJson.build.uat.env.EXPO_PUBLIC_API_URL, STAGING, 'the eas.json uat profile names staging');
  const config = buildConfig(uatBuildVars(STAGING));
  assert.equal(config.extra.apiBaseUrl, STAGING, 'app.config.js forces the UAT extra to staging');
  assert.deepEqual(
    resolveUatApiBaseUrl({ environmentUrl: easJson.build.uat.env.EXPO_PUBLIC_API_URL, configuredUrl: config.extra.apiBaseUrl }),
    { ok: true, url: STAGING },
  );
  const resolver = fs.readFileSync(path.join(ROOT, 'src', 'services', 'api-base-url.ts'), 'utf8');
  assert.ok(!resolver.includes('api-staging'), 'the resolver must not name staging (it would reach the store bundle)');
});

uat('UATAPI-02-MISSING-CONFIGURATION-NEVER-FALLS-BACK-TO-PRODUCTION', () => {
  refused({}, 'nothing configured');
  refused({ environmentUrl: '', configuredUrl: '' }, 'empty strings');
  refused({ environmentUrl: '   ', configuredUrl: undefined }, 'whitespace only');
  refused({ environmentUrl: STAGING }, 'the configured copy is missing');
  refused({ configuredUrl: STAGING }, 'the build-time copy is missing');
  for (const input of [{}, { environmentUrl: '' }, { configuredUrl: STAGING }]) {
    const result = resolveUatApiBaseUrl(input);
    assert.equal(result.ok, false);
    assert.equal(result.url, undefined, 'a refusal carries no URL at all, so nothing can be fetched from it');
  }
});

uat('UATAPI-03-PRODUCTION-IS-REFUSED-WHEREVER-IT-APPEARS', () => {
  refused({ environmentUrl: LIVE_API_BASE_URL, configuredUrl: LIVE_API_BASE_URL }, 'both production');
  refused({ environmentUrl: `${LIVE_API_BASE_URL}/`, configuredUrl: LIVE_API_BASE_URL }, 'production, trailing slash');
  refused({ environmentUrl: STAGING, configuredUrl: LIVE_API_BASE_URL }, 'staging + configured production');
  refused({ environmentUrl: LIVE_API_BASE_URL, configuredUrl: STAGING }, 'production + configured staging');
  refused({ environmentUrl: LIVE_API_BASE_URL }, 'production alone');
  refused({ configuredUrl: LIVE_API_BASE_URL }, 'configured production alone');
});

uat('UATAPI-04-UNAPPROVED-ENDPOINTS-ARE-REFUSED-AT-RUN-TIME', () => {
  const malformed = [
    'http://localhost:3000',
    'https://localhost',
    'http://127.0.0.1:3000',
    'https://127.0.0.1',
    'http://security-marketplace-api-staging.onrender.com', // not https
    'https://security-marketplace-api-staging.onrender.com:8443',
    'https://security-marketplace-api-staging.onrender.com/v2',
    'https://security-marketplace-api-staging.onrender.com?x=1',
    'https://user@security-marketplace-api-staging.onrender.com',
    'https://evil.test/https://security-marketplace-api-staging.onrender.com',
    'https://SECURITY-MARKETPLACE-API-STAGING.onrender.com',
  ];
  for (const url of malformed) refused({ environmentUrl: url, configuredUrl: url }, `both ${url}`);
  for (const url of [...malformed, 'https://security-marketplace-api-staging.onrender.com.attacker.test', 'https://explicit.example.test']) {
    refused({ environmentUrl: STAGING, configuredUrl: url }, `staging + configured ${url}`);
    refused({ environmentUrl: url, configuredUrl: STAGING }, `${url} + configured staging`);
  }
});

uat('UATAPI-05-THE-BUILD-CANNOT-PRODUCE-A-UAT-CONFIGURATION-FOR-ANY-OTHER-SERVER', () => {
  for (const url of [LIVE_API_BASE_URL, 'https://explicit.example.test', 'http://localhost:3000', `${STAGING}.attacker.test`]) {
    assert.throws(() => buildConfig(uatBuildVars(url)), /S4 UAT/, `an EAS UAT build against ${url} is refused`);
    assert.throws(
      () => buildConfig({ ...uatBuildVars(url), EAS_BUILD: undefined }),
      /S4 UAT/,
      `a local UAT config against ${url} is refused`,
    );
  }
  assert.throws(() => buildConfig(uatBuildVars(undefined)), /S4 UAT/, 'an EAS UAT build with no API is refused');
  // Even where a local UAT config is allowed without EXPO_PUBLIC_API_URL, the configured copy is staging, and the
  // app then refuses to connect because the build-time copy is missing: never the live API.
  const local = buildConfig({ ...uatBuildVars(undefined), EAS_BUILD: undefined });
  assert.equal(local.extra.apiBaseUrl, STAGING);
  refused({ environmentUrl: undefined, configuredUrl: local.extra.apiBaseUrl }, 'local UAT without a build-time URL');
});

uat('UATAPI-06-ANY-ONE-UAT-SIGNAL-MAKES-THE-APP-UAT', () => {
  assert.equal(isUatBuild({ appVariant: 'uat' }), true, 'extra.appVariant');
  assert.equal(isUatBuild({ buildLabel: 'UAT' }), true, 'EXPO_PUBLIC_BUILD_LABEL');
  assert.equal(isUatBuild({ buildLabel: ' uat ' }), true, 'build label, any case');
  assert.equal(isUatBuild({ androidPackage: 'com.sfour.s4.uat' }), true, 'Android package alone (lost extra and label)');
  assert.equal(isUatBuild({ iosBundleIdentifier: 'com.sfour.s4.uat' }), true, 'iOS bundle id alone');
  const config = buildConfig(uatBuildVars(STAGING));
  assert.equal(
    isUatBuild({
      appVariant: config.extra.appVariant,
      buildLabel: easJson.build.uat.env.EXPO_PUBLIC_BUILD_LABEL,
      androidPackage: config.android.package,
      iosBundleIdentifier: config.ios.bundleIdentifier,
    }),
    true,
    'the real UAT build carries the signals',
  );
});

uat('UATAPI-07-THE-STORE-APP-AND-WEB-ARE-NOT-UAT-SO-THEIR-RESOLUTION-IS-UNCHANGED', () => {
  const store = buildConfig({});
  for (const [name, profile] of Object.entries(easJson.build)) {
    if (name === 'uat') continue;
    assert.equal(
      isUatBuild({
        appVariant: store.extra?.appVariant,
        buildLabel: profile.env?.EXPO_PUBLIC_BUILD_LABEL,
        androidPackage: store.android?.package,
        iosBundleIdentifier: store.ios?.bundleIdentifier,
      }),
      false,
      `EAS profile ${name} must not be treated as UAT`,
    );
  }
  assert.equal(isUatBuild({}), false, 'web (no native ids, no label)');
  assert.equal(
    isUatBuild({ appVariant: 'production', buildLabel: 'pilot', androidPackage: 'com.sfour.s4', iosBundleIdentifier: 'com.sfour.s4' }),
    false,
  );
  assert.equal(isUatBuild({ appVariant: 'UAT ' }), false, 'only the exact app.config.js value turns the variant on');
});

uat('UATAPI-08-EVERY-API-REQUEST-IN-THE-APP-GOES-THROUGH-THE-FAIL-CLOSED-URL', () => {
  const api = fs.readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8');
  assert.doesNotMatch(api, /fetch\(\s*`\$\{API_BASE_URL\}/, 'no fetch may build its URL from API_BASE_URL directly');
  const fetches = api.match(/fetch\(([^,)]+)/g) || [];
  assert.ok(fetches.length >= 2, 'request() and the session refresh both fetch');
  for (const call of fetches) assert.match(call, /fetch\((url|apiUrl\()/, `unguarded fetch: ${call}`);
  assert.match(api, /const url = apiUrl\(path\);/);
  assert.match(api, /fetch\(apiUrl\('\/auth\/refresh'\)/);
  assert.match(api, /function apiUrl\(path: string\): string \{\s*if \(API_CONFIGURATION_ERROR\) throw/);
  // The UAT decision is made first; resolveApiBaseUrl (with its live fallback) is only the non-UAT branch.
  assert.match(api, /const API_BASE_URL = uatApi\s*\?\s*uatApi\.ok\s*\?\s*uatApi\.url\s*:\s*''\s*:\s*resolveApiBaseUrl\(/);
  for (const signal of ['extra?.appVariant', 'EXPO_PUBLIC_BUILD_LABEL', 'android?.package', 'ios?.bundleIdentifier']) {
    assert.ok(api.includes(signal), `isUatBuild must be given ${signal}`);
  }
});

// UATAPI-09 executes the REAL api.ts (with the real resolver) against a recording fetch: a refused UAT configuration
// sends nothing anywhere — not to production, not to staging — and the store app's resolution is unchanged.
function loadApiAs({ extra, android, ios, env }) {
  const vm = require('node:vm');
  const compiled = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra, android, ios } } };
      if (id.endsWith('api-base-url')) return moduleUnderTest.exports;
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process: { env: { ...env } },
    console, Error, TypeError, Promise, JSON, Array, Object, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: false, status: 503, statusText: 'stub', headers: { get: () => 'application/json' }, text: async () => '{}', json: async () => ({}) };
    },
    Headers: class Headers {
      constructor() { this._h = {}; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });
  return { api: mod.exports, calls };
}

(async () => {
  const uatIds = { android: { package: 'com.sfour.s4.uat' }, ios: { bundleIdentifier: 'com.sfour.s4.uat' } };
  const refusedApps = {
    'UAT with no API configured at all': { ...uatIds, extra: { appVariant: 'uat' }, env: { EXPO_PUBLIC_BUILD_LABEL: 'UAT' } },
    'UAT built against production': { ...uatIds, extra: { appVariant: 'uat', apiBaseUrl: STAGING }, env: { EXPO_PUBLIC_API_URL: LIVE_API_BASE_URL } },
    'UAT configured for production': { ...uatIds, extra: { appVariant: 'uat', apiBaseUrl: LIVE_API_BASE_URL }, env: { EXPO_PUBLIC_API_URL: STAGING } },
    'UAT that lost its extra, built against production': { ...uatIds, extra: undefined, env: { EXPO_PUBLIC_API_URL: LIVE_API_BASE_URL } },
    'UAT known only by its build label': { extra: { apiBaseUrl: LIVE_API_BASE_URL }, env: { EXPO_PUBLIC_BUILD_LABEL: 'UAT' } },
    'UAT pointed at an unapproved server': { ...uatIds, extra: { appVariant: 'uat', apiBaseUrl: 'http://localhost:3000' }, env: { EXPO_PUBLIC_API_URL: 'http://localhost:3000' } },
  };
  for (const [name, app] of Object.entries(refusedApps)) {
    const { api, calls } = loadApiAs(app);
    assert.equal(api.getApiBaseUrl(), '', `${name}: no base URL`);
    await assert.rejects(api.login('a@example.test', 'x'), (error) => error instanceof api.NetworkError && error.message === UAT_API_NOT_CONFIGURED, name);
    api.restoreSession({ accessToken: 'expired', refreshToken: 'stored' });
    await assert.rejects(api.login('a@example.test', 'x'), api.NetworkError, `${name}: with a stored session`);
    assert.deepEqual(calls, [], `${name}: nothing was sent anywhere`);
  }

  const good = loadApiAs({ ...uatIds, extra: { appVariant: 'uat', apiBaseUrl: STAGING }, env: { EXPO_PUBLIC_API_URL: STAGING, EXPO_PUBLIC_BUILD_LABEL: 'UAT' } });
  await assert.rejects(good.api.login('a@example.test', 'x'));
  assert.deepEqual(good.calls, [`${STAGING}/auth/login`], 'the correctly built UAT app talks to staging');

  const store = loadApiAs({ extra: { apiBaseUrl: LIVE_API_BASE_URL }, android: { package: 'com.sfour.s4' }, ios: { bundleIdentifier: 'com.sfour.s4' }, env: { EXPO_PUBLIC_BUILD_LABEL: 'pilot' } });
  assert.equal(store.api.getApiBaseUrl(), LIVE_API_BASE_URL, 'the store app still resolves to the live API');
  await assert.rejects(store.api.login('a@example.test', 'x'));
  assert.deepEqual(store.calls, [`${LIVE_API_BASE_URL}/auth/login`], 'and still talks to it');

  uatPassed += 1;
  console.log('PASS  UATAPI-09-THE-REAL-API-CLIENT-SENDS-NOTHING-WHEN-UAT-IS-REFUSED');
  console.log(`UAT fail-closed API tests passed (${uatPassed}/9).`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
