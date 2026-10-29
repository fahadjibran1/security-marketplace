/**
 * The S4 UAT app variant (staging UAT preparation, 20 Oct 2026).
 *
 * app.config.js adds a second, side-by-side app — com.sfour.s4.uat, "S4 UAT" — that talks only to the isolated
 * staging API. The risk worth guarding is the other direction: that the variant leaks into the certified store
 * app. So the first checks prove that, without APP_VARIANT=uat, the config Expo builds from IS app.json, and that
 * only the EAS `uat` profile can turn the variant on; UAT-08 proves no EAS profile can pair one app's identity
 * with the other environment's API.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { loadTs } = require('./load-ts.cjs');

const STAGING = 'https://security-marketplace-api-staging.onrender.com';
const PRODUCTION = 'https://security-marketplace-api.onrender.com';

const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));
const makeConfig = require(path.join(ROOT, 'app.config.js'));
const variant = loadTs('src/services/appVariant.ts');

function withVariant(value, fn) {
  const before = process.env.APP_VARIANT;
  if (value === undefined) delete process.env.APP_VARIANT; else process.env.APP_VARIANT = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.APP_VARIANT; else process.env.APP_VARIANT = before; }
}
const fresh = () => JSON.parse(JSON.stringify(appJson.expo));

test('UAT-01-WITHOUT-THE-VARIANT-THE-STORE-CONFIG-IS-APP-JSON-UNCHANGED', () => {
  for (const value of [undefined, '', 'production', 'UAT', 'staging']) {
    const input = fresh();
    const out = withVariant(value, () => makeConfig({ config: input }));
    assert.equal(out, input, `APP_VARIANT=${JSON.stringify(value)} must return the very same config object`);
    assert.deepEqual(out, appJson.expo, 'and it is exactly app.json');
  }
});

test('UAT-02-THE-UAT-VARIANT-IS-A-SEPARATE-STAGING-ONLY-APP', () => {
  const out = withVariant('uat', () => makeConfig({ config: fresh() }));
  assert.equal(out.name, 'S4 UAT');
  assert.equal(out.android.package, 'com.sfour.s4.uat');
  assert.equal(out.ios.bundleIdentifier, 'com.sfour.s4.uat');
  assert.equal(out.scheme, 's4security-uat', 'its own deep-link scheme, so links never open the wrong app');
  assert.equal(out.extra.apiBaseUrl, STAGING);
  assert.equal(out.extra.appVariant, 'uat');
  assert.equal(out.android.adaptiveIcon.backgroundColor, '#B45309');
  assert.equal(out.splash.backgroundColor, '#B45309');
  // Same marketing version and iOS build as the store release; the Android versionCode is the UAT app's own
  // (UAT-08), and without UAT_ANDROID_VERSION_CODE outside EAS it falls back to the store's.
  assert.equal(out.version, appJson.expo.version);
  assert.equal(out.android.versionCode, appJson.expo.android.versionCode);
  assert.equal(out.ios.buildNumber, appJson.expo.ios.buildNumber);
  // Everything else is inherited, not re-stated: permissions, plugins, privacy manifest, EAS project.
  assert.deepEqual(out.android.permissions, appJson.expo.android.permissions);
  assert.deepEqual(out.android.blockedPermissions, appJson.expo.android.blockedPermissions);
  assert.deepEqual(out.plugins, appJson.expo.plugins);
  assert.deepEqual(out.ios.privacyManifests, appJson.expo.ios.privacyManifests);
  assert.equal(out.extra.eas.projectId, appJson.expo.extra.eas.projectId);
});

test('UAT-03-BUILDING-THE-VARIANT-DOES-NOT-MUTATE-THE-STORE-CONFIG', () => {
  const input = fresh();
  withVariant('uat', () => makeConfig({ config: input }));
  assert.deepEqual(input, appJson.expo, 'the object Expo passed in is left as app.json');
});

test('UAT-04-THE-UAT-ICONS-EXIST-AND-ARE-VALID', () => {
  const icon = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'assets/uat/icon.png')));
  assert.equal(icon.width, 1024); assert.equal(icon.height, 1024);
  assert.equal(icon.colorType, 2, 'opaque RGB — iOS rejects an app icon with an alpha channel');
  const fg = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'assets/uat/adaptive-icon.png')));
  assert.equal(fg.width, 1024); assert.equal(fg.height, 1024);
  assert.equal(fg.colorType, 6, 'the adaptive foreground keeps transparency over the amber background');
  // And the production assets are still the ones app.json names.
  assert.equal(appJson.expo.icon, './assets/icon.png');
  assert.equal(appJson.expo.android.adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
});

test('UAT-05-ONLY-THE-UAT-PROFILE-CAN-TURN-THE-VARIANT-ON', () => {
  const uat = easJson.build.uat;
  assert.ok(uat, 'the uat profile exists');
  assert.equal(uat.distribution, 'internal', 'never a store build');
  assert.equal(uat.android.buildType, 'apk', 'side-loaded beside the real app');
  assert.equal(uat.android.credentialsSource, 'local', 'signed with the local key, never an EAS-generated one');
  assert.equal(uat.env.APP_VARIANT, 'uat');
  assert.equal(uat.env.EXPO_PUBLIC_API_URL, STAGING, 'staging only');
  assert.equal(uat.env.EXPO_PUBLIC_BUILD_LABEL, 'UAT');
  assert.ok(!('autoIncrement' in uat), 'it does not bump the certified versions');
  for (const [name, profile] of Object.entries(easJson.build)) {
    if (name === 'uat') continue;
    assert.ok(!profile.env || !('APP_VARIANT' in profile.env), `${name} must not set APP_VARIANT`);
  }
  // The store profile is untouched.
  assert.equal(easJson.build.production.env.EXPO_PUBLIC_API_URL, PRODUCTION);
  assert.equal(easJson.build.production.android.buildType, 'app-bundle');
  assert.equal(easJson.build.production.android.credentialsSource, 'local');
  assert.ok(!easJson.build.production.distribution);
});

test('UAT-06-THE-IN-APP-LABEL-ONLY-APPEARS-IN-THE-UAT-APP', () => {
  assert.equal(variant.resolveAppVariant({ appVariant: 'uat' }), 'uat');
  for (const extra of [undefined, null, {}, { appVariant: 'UAT' }, { appVariant: 'production' }, { appVariant: true }]) {
    assert.equal(variant.resolveAppVariant(extra), 'production', `${JSON.stringify(extra)} is the store app`);
  }
  assert.equal(variant.productLabelFor('uat', 'S4'), 'S4 UAT · STAGING');
  assert.equal(variant.productLabelFor('production', 'S4'), 'S4', 'the store app keeps its label');
  const app = read('App.tsx');
  assert.match(app, /const APP_VARIANT = resolveAppVariant\(Constants\.expoConfig\?\.extra\);/);
  assert.match(app, /\{PRODUCT_LABEL\}<\/Text>/, 'the signed-in top bar shows the resolved label');
});

test('UAT-07-THE-STAGING-URL-LIVES-ONLY-IN-THE-UAT-CONFIG', () => {
  // No runtime source names the staging API; it reaches the UAT app only through app.config.js / the uat profile.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const offenders = walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx|js)$/.test(f) && fs.readFileSync(f, 'utf8').includes('api-staging'));
  assert.deepEqual(offenders, [], 'no source file hard-codes the staging API');
  assert.equal(appJson.expo.extra.apiBaseUrl, PRODUCTION, 'app.json still names production');
});

test('UAT-08-AN-APP-CANNOT-BE-BUILT-AGAINST-THE-OTHER-ENVIRONMENT', () => {
  // EXPO_PUBLIC_API_URL beats extra.apiBaseUrl at runtime, so identity and API are checked together at build time.
  const keys = ['APP_VARIANT', 'EXPO_PUBLIC_API_URL', 'EAS_BUILD', 'UAT_ANDROID_VERSION_CODE'];
  const run = (vars) => {
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
    try { return makeConfig({ config: fresh() }); } finally {
      keys.forEach((k) => { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; });
    }
  };
  const onEas = (name) => ({ ...(easJson.build[name].env || {}), EAS_BUILD: 'true' });
  // Every profile in eas.json, as an EAS worker evaluates it.
  assert.equal(run(onEas('uat')).android.package, 'com.sfour.s4.uat');
  assert.equal(run(onEas('uat')).ios.bundleIdentifier, 'com.sfour.s4.uat');
  assert.equal(run(onEas('uat')).android.versionCode, 21, 'the uat profile stays above the store app');
  for (const name of ['production', 'pilot', 'preview', 'development', 'ios-simulator']) {
    assert.equal(run(onEas(name)).android.package, 'com.sfour.s4', `${name} stays the store identity`);
  }
  assert.throws(() => run(onEas('preview-staging')), /never be built against the staging API/, 'the old store-identity staging profile can no longer produce an app');
  // UAT pointed anywhere but staging, or with no URL on EAS, fails.
  assert.throws(() => run({ APP_VARIANT: 'uat', EXPO_PUBLIC_API_URL: PRODUCTION, EAS_BUILD: 'true' }), /refusing to build/);
  assert.throws(() => run({ APP_VARIANT: 'uat', EAS_BUILD: 'true' }), /refusing to build/);
  assert.throws(() => run({ APP_VARIANT: 'uat', EXPO_PUBLIC_API_URL: PRODUCTION }), /only talk to the staging API/);
  // The store app on EAS with a staging URL fails.
  assert.throws(() => run({ EXPO_PUBLIC_API_URL: STAGING, EAS_BUILD: 'true' }), /never be built against the staging API/);
  // Outside EAS (the web export) the store config is still returned untouched.
  const input = fresh();
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  try { assert.equal(makeConfig({ config: input }), input); } finally {
    keys.forEach((k) => { if (before[k] !== undefined) process.env[k] = before[k]; });
  }
});

test('UAT-09-THE-UAT-APP-HAS-ITS-OWN-ANDROID-VERSION-CODE-ABOVE-THE-STORE-APP', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  assert.equal(eas.build.uat.env.UAT_ANDROID_VERSION_CODE, '21', 'above the store app (20) and the UAT 1.1.0 (16) build 5d758b92');
  assert.ok(Number(eas.build.uat.env.UAT_ANDROID_VERSION_CODE) > appJson.expo.android.versionCode, 'strictly above the store app');
  assert.equal(eas.build.production.env.UAT_ANDROID_VERSION_CODE, undefined, 'never on the store profile');
  const prev = { ...process.env };
  try {
    process.env.UAT_ANDROID_VERSION_CODE = '21';
    const uat = withVariant('uat', () => makeConfig({ config: fresh() }));
    assert.equal(uat.android.versionCode, 21);
    assert.equal(uat.android.package, 'com.sfour.s4.uat');
    const store = withVariant(undefined, () => makeConfig({ config: fresh() }));
    assert.equal(store.android.versionCode, appJson.expo.android.versionCode, 'the store app keeps its own number');
    assert.equal(store.android.package, 'com.sfour.s4');
    process.env.UAT_ANDROID_VERSION_CODE = String(appJson.expo.android.versionCode);
    assert.throws(() => withVariant('uat', () => makeConfig({ config: fresh() })), /above the store app's versionCode/);
    delete process.env.UAT_ANDROID_VERSION_CODE;
    process.env.EAS_BUILD = 'true';
    process.env.EXPO_PUBLIC_API_URL = STAGING;
    assert.throws(() => withVariant('uat', () => makeConfig({ config: fresh() })), /UAT_ANDROID_VERSION_CODE/);
  } finally {
    for (const k of ['UAT_ANDROID_VERSION_CODE', 'EAS_BUILD', 'EXPO_PUBLIC_API_URL']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

console.log(`\n${passed} UAT variant checks passed`);
