#!/usr/bin/env node
/**
 * S4 Pilot Gate 4A — the permanent store identity, certified from source.
 *
 * The app is called S4. Not "S4 Security", not "S4 Guard", not "Security Marketplace". Guard, Company,
 * Client and Platform Admin are workspaces inside S4, never product names.
 *
 *   STORE-01  display name, package, bundle id, scheme, version, versionCode, buildNumber
 *   STORE-02  the existing EAS project is kept; OTA stays off; the internal slug is unchanged
 *   STORE-03  nothing depends on the retired securitymarketplace:// scheme; HTTPS auth links stay canonical
 *   STORE-04  Android permissions are the minimum the pilot uses: foreground location, nothing else
 *   STORE-05  location copy is truthful: Book On only, no background tracking
 *   STORE-06  the store profile can only reach the production API
 *   STORE-07  no user-facing source carries a deprecated product name
 *   STORE-08  the brand module has one product name for every role
 *   STORE-09  iOS identity and export-compliance flags are set, nothing is built
 *
 * Executed against the real files, and the API resolver is executed rather than read.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));
const expo = appJson.expo;

const DEPRECATED_NAMES = /S4[\s-]*Security|S4[\s-]*Guard|Security[\s-]*Marketplace/i;
const PRODUCTION_API = 'https://security-marketplace-api.onrender.com';

test('STORE-01-THE-PERMANENT-S4-IDENTITY', () => {
  assert.equal(expo.name, 'S4', 'display name');
  assert.equal(expo.android.package, 'com.sfour.s4');
  assert.equal(expo.ios.bundleIdentifier, 'com.sfour.s4');
  assert.equal(expo.scheme, 's4security');
  assert.equal(expo.version, '1.1.0');
  assert.equal(expo.android.versionCode, 13);
  assert.equal(expo.ios.buildNumber, '13');
});

test('STORE-02-THE-EXISTING-EAS-PROJECT-IS-KEPT-AND-OTA-STAYS-OFF', () => {
  // A new package does not need a new EAS project, and a second project would split build history and
  // credentials. The slug is an internal EAS identifier, never shown to a user, so it stays.
  assert.equal(expo.extra.eas.projectId, 'c786f15c-7d60-4122-9001-02cabbb7692b');
  assert.equal(expo.slug, 'security-marketplace', 'internal EAS slug, unchanged on purpose');
  assert.deepEqual(expo.updates, { enabled: false }, 'no OTA');
  assert.ok(!('runtimeVersion' in expo), 'no runtime-version policy, because nothing is updated over the air');
  assert.ok(!JSON.stringify(easJson).includes('"channel"'), 'no update channel');
  assert.equal(easJson.cli.appVersionSource, 'local', 'app.json is the version source');
});

test('STORE-03-NOTHING-DEPENDS-ON-THE-RETIRED-SCHEME', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|cjs|json)$/.test(entry.name) && /securitymarketplace:\/\//.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const file of ['App.tsx', 'app.json', 'eas.json']) {
    if (/securitymarketplace:\/\//.test(read(file))) offenders.push(file);
  }
  const backendEmail = path.join(ROOT, '..', 'security-backend-nest', 'src', 'email', 'auth-email.templates.ts');
  if (/securitymarketplace:\/\//.test(fs.readFileSync(backendEmail, 'utf8'))) offenders.push('backend email templates');
  assert.deepEqual(offenders, []);

  // Gate 2's emailed links are HTTPS pages on the S4 web app, and stay so.
  const links = loadTs('src/components/account/accountLinks.ts');
  assert.equal(links.parseAccountLink('/reset-password', '?token=x'.padEnd(40, 'x')).kind, 'reset-password');
  assert.equal(links.parseAccountLink('/verify-email', '?token=x'.padEnd(40, 'x')).kind, 'verify-email');
  const vercel = JSON.parse(read('vercel.json'));
  assert.deepEqual(vercel.rewrites.map((r) => r.source).sort(), ['/reset-password', '/verify-email']);
});

test('STORE-04-ANDROID-PERMISSIONS-ARE-THE-PILOT-MINIMUM', () => {
  assert.deepEqual([...expo.android.permissions].sort(), ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']);
  const blocked = new Set(expo.android.blockedPermissions);
  for (const permission of [
    'ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_LOCATION',
    'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'RECORD_AUDIO', 'CAMERA',
  ]) {
    assert.ok(blocked.has(`android.permission.${permission}`), `${permission} is blocked from the merged manifest`);
  }
  const requested = JSON.stringify(expo.android.permissions);
  for (const deferred of ['CAMERA', 'NFC', 'BLUETOOTH', 'RECORD_AUDIO', 'READ_CONTACTS', 'SMS', 'BACKGROUND_LOCATION']) {
    assert.ok(!requested.includes(deferred), `${deferred} is not requested for a deferred feature`);
  }
});

test('STORE-05-LOCATION-COPY-MATCHES-WHAT-THE-APP-DOES', () => {
  const [, options] = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location');
  assert.equal(options.isAndroidBackgroundLocationEnabled, false);
  assert.equal(options.isIosBackgroundLocationEnabled, false);
  // false (not merely absent) — absent would let the plugin inject its generic "Always" strings on iOS.
  assert.equal(options.locationAlwaysAndWhenInUsePermission, false, 'no "always" prompt');
  assert.equal(options.locationAlwaysPermission, false, 'no "always" prompt');
  const copy = options.locationWhenInUsePermission;
  assert.match(copy, /^S4 /, 'names the app as S4');
  assert.match(copy, /Book On/);
  assert.match(copy, /does not track your location in the background/);
  assert.doesNotMatch(copy, DEPRECATED_NAMES);

  // And the code really does ask only in the foreground, once, at Book On.
  const source = read('src/services/attendanceLocation.ts');
  assert.match(source, /requestForegroundPermissionsAsync/);
  assert.doesNotMatch(source, /requestBackgroundPermissionsAsync|watchPositionAsync|startLocationUpdatesAsync/);
  const transport = read('src/services/attendanceTransport.ts');
  assert.match(transport, /\/attendance\/check-in/, 'location is attached to Book On requests only');
});

test('STORE-06-THE-STORE-PROFILE-CAN-ONLY-REACH-PRODUCTION', () => {
  const production = easJson.build.production;
  assert.equal(production.env.EXPO_PUBLIC_API_URL, PRODUCTION_API, 'stated explicitly, so no local .env can override it');
  assert.equal(expo.extra.apiBaseUrl, PRODUCTION_API);
  const raw = JSON.stringify(production);
  assert.doesNotMatch(raw, /localhost|127\.0\.0\.1|192\.168\.|10\.0\.2\.2|staging|ngrok/i);

  const { resolveApiBaseUrl, LIVE_API_BASE_URL } = loadTs('src/services/api-base-url.ts');
  assert.equal(LIVE_API_BASE_URL, PRODUCTION_API);
  // A native store build has no web hostname: production env wins, and with nothing set it is still production.
  assert.equal(resolveApiBaseUrl({ environmentUrl: production.env.EXPO_PUBLIC_API_URL, configuredUrl: expo.extra.apiBaseUrl }), PRODUCTION_API);
  assert.equal(resolveApiBaseUrl({ configuredUrl: expo.extra.apiBaseUrl }), PRODUCTION_API);
  assert.equal(resolveApiBaseUrl({}), PRODUCTION_API);
});

test('STORE-07-NO-USER-FACING-SOURCE-CARRIES-A-DEPRECATED-NAME', () => {
  // Comments may explain history; code and copy may not use the old names. URLs are excluded: the
  // production API host (security-marketplace-api.onrender.com) is a technical endpoint, not branding —
  // renaming it is backend/DNS work, and the app never shows it as a product name.
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/https?:\/\/[^\s'"`]+/g, '<url>');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        strip(fs.readFileSync(full, 'utf8')).split('\n').forEach((line, index) => {
          if (DEPRECATED_NAMES.test(line)) offenders.push(`${path.relative(ROOT, full)}:${index + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  strip(read('App.tsx')).split('\n').forEach((line, index) => {
    if (DEPRECATED_NAMES.test(line)) offenders.push(`App.tsx:${index + 1}`);
  });
  assert.deepEqual(offenders, [], offenders.join('\n'));

  // The store-facing configuration strings too.
  for (const value of [expo.name, expo.description, JSON.stringify(expo.plugins), JSON.stringify(expo.ios.infoPlist || {})]) {
    assert.doesNotMatch(value, DEPRECATED_NAMES);
  }
});

test('STORE-08-ONE-PRODUCT-NAME-FOR-EVERY-ROLE', () => {
  const { brand } = loadTs('src/theme/brand.ts');
  assert.equal(brand.appName, 'S4');
  assert.equal(brand.shortBrand, 'S4');
  assert.ok(!('guardAppName' in brand), 'no per-role product name');
  for (const value of Object.values(brand)) assert.doesNotMatch(String(value), DEPRECATED_NAMES);
});

test('STORE-09-IOS-IDENTITY-IS-SET-AND-NOTHING-IS-BUILT', () => {
  assert.equal(expo.ios.bundleIdentifier, 'com.sfour.s4');
  assert.equal(expo.ios.buildNumber, '13');
  assert.equal(expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
  assert.equal(expo.ios.config.usesNonExemptEncryption, false);
  // No hand-written usage strings that could drift from the plugin's, and none for unused capabilities.
  const plist = JSON.stringify(expo.ios.infoPlist);
  assert.doesNotMatch(plist, /NSCameraUsageDescription|NSMicrophoneUsageDescription|NSContactsUsageDescription|NSLocationAlways/);

  // Gate 4C: expo-location and expo-secure-store inject generic "Always" location and Face ID purpose
  // strings by default. S4 never asks for Always location and never uses biometrics, so both plugins are
  // told to omit them (false deletes the key) — every purpose string the app ships describes real use.
  const [, location] = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location');
  assert.equal(location.locationAlwaysAndWhenInUsePermission, false);
  assert.equal(location.locationAlwaysPermission, false);
  const [, secureStore] = expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store');
  assert.equal(secureStore.faceIDPermission, false);
});

test('STORE-10-THE-IOS-PRIVACY-MANIFEST-DECLARES-WHAT-THE-PODS-USE', () => {
  // Apple does not reliably read the PrivacyInfo files inside static CocoaPods dependencies, so the
  // required-reason APIs are declared at app level. Every entry is copied from a bundled dependency's own
  // manifest (React Native, its third-party pods, expo-constants, expo-file-system) — none is invented.
  const manifest = expo.ios.privacyManifests;
  assert.equal(manifest.NSPrivacyTracking, false, 'no tracking');
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
  const declared = Object.fromEntries(
    manifest.NSPrivacyAccessedAPITypes.map((entry) => [entry.NSPrivacyAccessedAPIType, [...entry.NSPrivacyAccessedAPITypeReasons].sort()]),
  );

  const required = {};
  const manifests = [
    'node_modules/react-native/React/Resources/PrivacyInfo.xcprivacy',
    'node_modules/react-native/ReactCommon/cxxreact/PrivacyInfo.xcprivacy',
    'node_modules/react-native/third-party-podspecs/boost/PrivacyInfo.xcprivacy',
    'node_modules/react-native/third-party-podspecs/glog/PrivacyInfo.xcprivacy',
    'node_modules/react-native/third-party-podspecs/RCT-Folly/PrivacyInfo.xcprivacy',
    'node_modules/expo-constants/ios/PrivacyInfo.xcprivacy',
    'node_modules/expo-file-system/ios/PrivacyInfo.xcprivacy',
  ];
  for (const rel of manifests) {
    const xml = read(rel);
    for (const match of xml.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g)) {
      required[match[1]] = new Set([...(required[match[1]] || []), ...[...match[2].matchAll(/<string>([^<]+)<\/string>/g)].map((r) => r[1])]);
    }
  }
  assert.ok(Object.keys(required).length >= 3, 'the dependency manifests were read');
  for (const [api, reasons] of Object.entries(required)) {
    assert.ok(declared[api], `${api} is declared at app level`);
    for (const reason of reasons) assert.ok(declared[api].includes(reason), `${api} carries ${reason}`);
  }
  for (const api of Object.keys(declared)) assert.ok(required[api], `${api} is declared only because a dependency uses it`);
});

console.log(`\n${passed} store identity checks passed`);
