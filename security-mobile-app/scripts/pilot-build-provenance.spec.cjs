/**
 * Pilot Android build provenance.
 *
 * Real UAT could not establish which build a Guard phone was running: the app showed no version
 * anywhere, and every EAS Android build reported 1.0.0 / versionCode 1 regardless of the repository, so
 * even Android's App Info could not distinguish one build from another. The newest Android build also
 * pointed at the STAGING API, so "on the latest build" and "seeing production data" were not the same
 * thing — a tester could appear current and be on the wrong backend entirely.
 *
 * These checks pin the controlled pilot baseline: app.json is the authoritative version source, the
 * pilot profile is an internal-distribution APK on the PRODUCTION API, OTA stays disabled, the other
 * profiles are untouched, and the in-app display reads runtime configuration rather than hard-coded
 * text — so what a Guard reads matches what Android's App Info reports.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Shared loader (scripts/load-ts.cjs): resolves relative imports between pure source modules.
const { loadTs: loadModule } = require('./load-ts.cjs');

const buildInfo = loadModule('src/services/appBuildInfo.ts');

const guard = read('src/screens/GuardDashboardScreen.tsx');
const company = read('src/screens/CompanyDashboardScreen.tsx');
const footer = read('src/components/ui/AppBuildFooter.tsx');
const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));

// ═══════════════════ the controlled version ═══════════════════

test('BUILD-01-APP-VERSION-IS-1-0-7-AND-BUILD-10', () => {
  assert.equal(appJson.expo.version, '1.0.7');
  // Build 10 carries the Phase 1 timezone correction. It has to exist as its own build because Build 9
  // still reads a scheduled time's hour literally out of the ISO string, so once production data holds
  // true instants Build 9 would display every BST shift an hour early.
  //
  // The lineage this number has to clear:
  //   5  the 1.0.4 installed on the pilot device
  //   8  rejected for distribution — EAS-generated signing identity, could not update an S4 build
  //   9  first distributable pilot build, permanent S4 identity
  assert.equal(appJson.expo.android.versionCode, 10, 'Build 10 carries the Phase 1 timezone correction');
  assert.ok(appJson.expo.android.versionCode > 9, 'and can update the installed Build 9');
  assert.ok(appJson.expo.android.versionCode > 8, 'above the rejected Build 8');
  assert.ok(appJson.expo.android.versionCode > 5, 'and above the installed 1.0.4 (versionCode 5)');
});

test('BUILD-02-APP-JSON-IS-THE-AUTHORITATIVE-VERSION-SOURCE', () => {
  // The whole point. Under "remote", EAS ignores app.json's versionCode while expo-constants still
  // serves it — EAS warns about exactly this — so an in-app display would show a number the installed
  // APK does not have. "local" makes the APK manifest and the display agree.
  assert.equal(easJson.cli.appVersionSource, 'local');
});

test('BUILD-03-THE-IOS-BUILD-NUMBER-CANNOT-REGRESS', () => {
  // The EAS remote counter had already reached iOS buildNumber 10. Moving to a local source means
  // app.json supplies it, so it must start above that high-water mark or a future iOS submission
  // would be rejected as a duplicate/decreasing build number.
  assert.ok(Number(appJson.expo.ios.buildNumber) > 10, `iOS buildNumber must exceed 10, got ${appJson.expo.ios.buildNumber}`);
});

// ═══════════════════ the pilot profile ═══════════════════

test('BUILD-04-A-PILOT-PROFILE-EXISTS-WITH-INTERNAL-APK-DISTRIBUTION', () => {
  const pilot = easJson.build.pilot;
  assert.ok(pilot, 'the pilot profile exists');
  assert.equal(pilot.distribution, 'internal', 'installable directly, not through a store');
  assert.equal(pilot.android.buildType, 'apk', 'an APK, because an AAB cannot be side-loaded');
});

test('BUILD-05-THE-PILOT-PROFILE-USES-THE-PRODUCTION-API', () => {
  const env = easJson.build.pilot.env || {};
  assert.ok(!('EXPO_PUBLIC_API_URL' in env), 'it must NOT override the API URL');
  // With no override, api-base-url.ts falls through to extra.apiBaseUrl.
  assert.equal(appJson.expo.extra.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  const resolver = read('src/services/api-base-url.ts');
  assert.match(resolver, /if \(explicitEnvironmentUrl\) \{\s*return explicitEnvironmentUrl;/, 'env wins when set');
  assert.match(resolver, /return configuredUrl\?\.trim\(\) \|\| LIVE_API_BASE_URL/, 'otherwise the configured production URL');
});

test('BUILD-06-PREVIEW-STAGING-STILL-POINTS-AT-STAGING', () => {
  // The trap this baseline closes: the newest existing Android builds were preview-staging, so they
  // could never have shown production data. Its semantics must be unchanged, not quietly repurposed.
  assert.equal(
    easJson.build['preview-staging'].env.EXPO_PUBLIC_API_URL,
    'https://security-marketplace-api-staging.onrender.com',
  );
  assert.equal(easJson.build['preview-staging'].distribution, 'internal');
  assert.equal(easJson.build['preview-staging'].android.buildType, 'apk');
});

test('BUILD-07-OTHER-PROFILES-ARE-INTACT-AND-OTA-STAYS-DISABLED', () => {
  assert.equal(easJson.build.production.autoIncrement, true, 'the store profile is unchanged');
  assert.ok(!easJson.build.production.distribution, 'and is still store distribution, not the pilot profile');
  assert.equal(easJson.build.preview.distribution, 'internal');
  assert.ok(easJson.build.development.developmentClient);
  assert.ok(easJson.build['ios-simulator'].ios.simulator);
  assert.deepEqual(appJson.expo.updates, { enabled: false }, 'OTA stays disabled');
  assert.ok(!JSON.stringify(easJson).includes('"channel"'), 'no update channel is introduced');
  assert.ok(!JSON.stringify(appJson).includes('runtimeVersion'), 'and no runtimeVersion policy');
});

// ═══════════════════ the in-app display ═══════════════════

test('BUILD-08-DISPLAYED-METADATA-COMES-FROM-RUNTIME-CONFIG', () => {
  assert.match(footer, /formatBuildInfoLines\(liveBuildInfo\(\), appLabel\)/);
  assert.match(footer, /Constants\.expoConfig/, 'version comes from the runtime manifest');
  assert.match(footer, /androidVersionCode: config\?\.android\?\.versionCode/, 'and the build number likewise');
  assert.match(footer, /platform: Platform\.OS/, 'platform decides what may be shown');
  // Comments legitimately mention "1.0.7" as an example; only executable code must be free of it.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(stripComments(footer), /1\.0\.[0-9]/, 'the footer code contains no literal version');
  const source = read('src/services/appBuildInfo.ts');
  assert.doesNotMatch(stripComments(source), /['"]1\.0\.[0-9]['"]/, 'nor does the resolver code');
  // The resolver stays dependency-free so these rules are executable in a plain node test.
  assert.doesNotMatch(source, /^import .*(expo-constants|react-native)/m, 'the pure module imports no runtime deps');
});

test('BUILD-09-ANDROID-SHOWS-A-REAL-BUILD-NUMBER-AND-WEB-INVENTS-NONE', () => {
  const android = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, platform: 'android' });
  assert.deepEqual(buildInfo.formatBuildInfoLines(android, 'S4 Guard'), ['S4 Guard', 'Version 1.0.7', 'Build 8']);

  // On web there is no installed package, so no build number may be shown or fabricated.
  const web = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, platform: 'web' });
  assert.equal(web.buildNumber, null);
  assert.deepEqual(buildInfo.formatBuildInfoLines(web, 'S4 Guard'), ['S4 Guard', 'Version 1.0.7']);

  // iOS reports its own buildNumber, never Android's versionCode.
  const ios = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, iosBuildNumber: '11', platform: 'ios' });
  assert.equal(ios.buildNumber, 11);
});

test('BUILD-10-A-PILOT-LABEL-IS-APPENDED-AND-IS-NEVER-A-SECRET', () => {
  const pilot = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, buildLabel: 'pilot', platform: 'android' });
  assert.deepEqual(buildInfo.formatBuildInfoLines(pilot, 'S4 Guard'), ['S4 Guard', 'Version 1.0.7', 'Build 8 · pilot']);
  assert.equal(easJson.build.pilot.env.EXPO_PUBLIC_BUILD_LABEL, 'pilot');
  // Only a label is exposed — no token, key, URL or credential is inlined into the bundle.
  const env = JSON.stringify(easJson.build.pilot.env);
  assert.doesNotMatch(env, /token|secret|key|password|credential/i, 'no secret is exposed through the build label');
});

test('BUILD-11-MISSING-METADATA-DEGRADES-HONESTLY', () => {
  const unknown = buildInfo.resolveAppBuildInfo({ version: null, androidVersionCode: 'x', platform: 'android' });
  assert.deepEqual(buildInfo.formatBuildInfoLines(unknown, 'S4 Guard'), ['S4 Guard', 'Version unavailable']);
  // A zero or negative versionCode is not a build number either.
  assert.equal(buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 0, platform: 'android' }).buildNumber, null);
  assert.equal(buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: -3, platform: 'android' }).buildNumber, null);
});

test('BUILD-12-BOTH-ROLES-SHOW-IT-AND-NEITHER-CLUTTERS-OPERATIONS', () => {
  assert.match(guard, /<AppBuildFooter appLabel="S4 Guard" \/>/, 'Guard Profile shows it');
  assert.match(company, /<AppBuildFooter appLabel="S4 Company" \/>/, 'Company shows it too');
  // Guard: inside the profile tab only, never the operational Home screen.
  const profileBlock = guard.slice(guard.indexOf("{activeTab === 'profile' ?"));
  assert.ok(
    profileBlock.indexOf('<AppBuildFooter') < profileBlock.indexOf("{activeTab === 'screening' ?"),
    'the Guard footer sits inside the profile tab',
  );
  const homeBlock = guard.slice(guard.indexOf('guardHomeRoot'), guard.indexOf("{activeTab === 'profile' ?"));
  assert.ok(!homeBlock.includes('AppBuildFooter'), 'and not on Home');
});

console.log(`\n${passed} pilot build provenance checks passed`);
