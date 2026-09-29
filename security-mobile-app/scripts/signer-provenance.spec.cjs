/**
 * UAT-MOB-02: Android release signer provenance.
 *
 * EAS Build 8 was signed with an EAS-generated keystore rather than the retained S4 identity, so Android
 * refused to update the installed 1.0.4 and the Samsung installer said only "App not installed". Nothing
 * in the release process could see it.
 *
 * WHAT THIS SUITE DOES AND DOES NOT DO
 * CI produces no signed APK — the Mobile Release Gate type-checks and exports JavaScript. So this suite
 * makes no claim about any artefact. It certifies the two things that CAN be certified without one:
 *
 *   1. the pinned expectation is present, well-formed, public-only, and is the real historical S4
 *      certificate rather than the rejected Build 8 one;
 *   2. the comparison logic in verify-apk-signer.cjs actually rejects a wrong signer — executed against
 *      RECORDED apksigner/aapt2 output from the two real APKs (public fingerprints only).
 *
 * The artefact itself is checked by `npm run verify:apk-signer -- <apk>` after an EAS build, which is the
 * only place a signed APK exists. A gate step pretending otherwise would be a green check over nothing.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const verifier = require('./verify-apk-signer.cjs');
const config = JSON.parse(read('release/android-signing.json'));
const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));

/** The permanent identity, as independently verified from the retained keystore and every historical APK. */
const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';
/** The EAS-generated certificate that Build 8 carried, and which must always be refused. */
const BUILD8_CERT_SHA256 = 'd9ae541413eedc417dc46fc7957fc773df48d507e20b7d5f57bdc40906e4e5dc';

// Recorded verbatim from apksigner/aapt2 against the two real APKs. Public fingerprints only.
const RECORDED = {
  historical104: {
    apksigner: [
      'Verifies',
      'Verified using v1 scheme (JAR signing): true',
      'Number of signers: 1',
      'Signer #1 certificate DN: CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
      'Signer #1 certificate SHA-1 digest: 45a530aa1681f2da1e3b0568d982f492eeedb75e',
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='5' versionName='1.0.4'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
  rejectedBuild8: {
    apksigner: [
      'Verifies',
      'Verified using v2 scheme (APK Signature Scheme v2): true',
      'Number of signers: 1',
      'Signer #1 certificate DN: CN=, OU=, O=, L=, ST=, C=',
      `Signer #1 certificate SHA-256 digest: ${BUILD8_CERT_SHA256}`,
      'Signer #1 certificate SHA-1 digest: bed3020254431dc2191dad548fbff718af75834f',
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='8' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
  /** What a correct Build 9 must look like: the S4 identity at versionCode 9. */
  expectedBuild9: {
    apksigner: [
      'Verifies',
      'Number of signers: 1',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='9' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
};

const observe = (recorded) => ({
  verifies: verifier.parseVerifies(recorded.apksigner),
  certificateSha256: verifier.parseSignerSha256(recorded.apksigner),
  ...verifier.parseBadging(recorded.badging),
});

// ═══════════════════ the pinned expectation ═══════════════════

test('SIGNER-01-THE-PERMANENT-IDENTITY-IS-PINNED-AND-IS-THE-HISTORICAL-S4-CERTIFICATE', () => {
  assert.equal(config.package, 'com.securitymarketplace.mobile');
  assert.equal(config.signer.certificateSha256, S4_CERT_SHA256, 'the pinned signer is the historical S4 certificate');
  assert.match(config.signer.certificateSha256, /^[0-9a-f]{64}$/, 'a lowercase 64-hex SHA-256');
  assert.notEqual(config.signer.certificateSha256, BUILD8_CERT_SHA256, 'and NOT the EAS-generated Build 8 certificate');
  assert.match(config.signer.subject, /O=Vesoft Services Limited/, 'attributed to the legal entity');
});

test('SIGNER-02-THE-PINNED-FILE-HOLDS-NO-SECRET-MATERIAL', () => {
  // The repository may pin a public fingerprint. It must never hold the keystore or its passwords.
  // Scanned over the DATA only: $comment is prose that explains why no key material is here, and
  // naturally uses the words "private key" and "password" while doing so.
  const { $comment: _prose, ...data } = config;
  const raw = JSON.stringify(data, null, 2);
  for (const forbidden of [
    /PRIVATE KEY/i, /BEGIN [A-Z ]*KEY/i, /password/i, /passphrase/i,
    /storePass/i, /keyPass/i, /\.keystore["']/i, /\.jks/i, /MII[A-Za-z0-9+/]{40}/,
  ]) {
    assert.doesNotMatch(raw, forbidden, `the pinned config must not contain ${forbidden}`);
  }
  assert.ok(!Object.keys(config.signer).some((k) => /pass|secret|private/i.test(k)), 'no secret-looking keys');
});

test('SIGNER-03-THE-REJECTED-BUILD-IS-RECORDED-WITH-ITS-REASON', () => {
  const rejected = config.rejectedBuilds.find((entry) => entry.easBuildId === 'deb416d3-565b-49b7-be4b-8b64319bb8cf');
  assert.ok(rejected, 'Build 8 is recorded as rejected');
  assert.equal(rejected.versionCode, 8);
  assert.equal(rejected.certificateSha256, BUILD8_CERT_SHA256);
  assert.match(rejected.reason, /signing identity|keystore/i, 'with the reason stated');
});

test('SIGNER-04-THE-EXPECTED-RELEASE-MATCHES-APP-JSON', () => {
  // If app.json and the pinned expectation drift apart, the post-build check would validate the wrong
  // release. They are asserted equal so a version bump cannot be half-applied.
  assert.equal(config.expectedRelease.versionName, appJson.expo.version);
  assert.equal(config.expectedRelease.versionCode, appJson.expo.android.versionCode);
  assert.equal(config.package, appJson.expo.android.package);
  assert.equal(appJson.expo.version, '1.0.7');
  assert.equal(appJson.expo.android.versionCode, 9, 'Build 9 supersedes the rejected Build 8');
  assert.ok(appJson.expo.android.versionCode > 8, 'and is above the rejected build');
  assert.ok(appJson.expo.android.versionCode > 5, 'and above the installed 1.0.4 (versionCode 5)');
});

test('SIGNER-05-THE-PILOT-RELEASE-SHAPE-IS-UNCHANGED', () => {
  assert.equal(easJson.cli.appVersionSource, 'local');
  assert.equal(easJson.build.pilot.distribution, 'internal');
  assert.equal(easJson.build.pilot.android.buildType, 'apk');
  // The setting that makes the pilot profile sign with the permanent S4 keystore rather than the
  // EAS-generated one. Reverting it to the remote default is exactly how Build 8 came to be signed with
  // the wrong identity, and it would be invisible until a tester could not install the APK.
  assert.equal(easJson.build.pilot.credentialsSource, 'local', 'the pilot profile signs with the local S4 keystore');
  assert.ok(!('EXPO_PUBLIC_API_URL' in (easJson.build.pilot.env || {})), 'pilot still uses the production API');
  assert.equal(appJson.expo.extra.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  assert.deepEqual(appJson.expo.updates, { enabled: false }, 'OTA stays disabled');
});

// ═══════════════════ the comparison logic, executed ═══════════════════

test('SIGNER-06-A-CORRECT-BUILD-9-WOULD-PASS-FULL-VERIFICATION', () => {
  const result = verifier.assessApk(config, observe(RECORDED.expectedBuild9));
  assert.equal(result.ok, true, `a correct Build 9 must pass, got: ${result.failures.join('; ')}`);
});

test('SIGNER-07-THE-REJECTED-BUILD-8-SIGNER-IS-REFUSED', () => {
  const observed = observe(RECORDED.rejectedBuild8);
  assert.equal(observed.certificateSha256, BUILD8_CERT_SHA256, 'the recorded output parses');

  const signerOnly = verifier.assessSignerOnly(config, observed);
  assert.equal(signerOnly.ok, false, 'Build 8 must FAIL signer verification');

  const full = verifier.assessApk(config, observed);
  assert.equal(full.ok, false);
  assert.ok(full.failures.some((f) => /signer certificate/.test(f)), 'the signer is named as a failure');
  assert.ok(
    full.failures.some((f) => /REJECTED build \(deb416d3-565b-49b7-be4b-8b64319bb8cf\)/.test(f)),
    `the operator is told this is the known rejected build, not just a bare mismatch; got ${JSON.stringify(full.failures)}`,
  );
});

test('SIGNER-08-THE-HISTORICAL-1-0-4-SIGNER-IS-ACCEPTED', () => {
  // The decisive equivalence: the identity Build 9 must carry is the one already installed on the device.
  const observed = observe(RECORDED.historical104);
  assert.equal(observed.certificateSha256, S4_CERT_SHA256);
  const signerOnly = verifier.assessSignerOnly(config, observed);
  assert.equal(signerOnly.ok, true, 'the installed 1.0.4 signer IS the permanent identity');
  assert.equal(signerOnly.actualSigner, signerOnly.expectedSigner);

  // Full verification still fails on version, which is correct — 1.0.4 is not the current release.
  const full = verifier.assessApk(config, observed);
  assert.equal(full.ok, false);
  assert.ok(full.failures.every((f) => !/signer certificate/.test(f)), 'but never on the signer');
});

test('SIGNER-09-AN-UNSIGNED-OR-UNREADABLE-APK-IS-REFUSED-NOT-WAVED-THROUGH', () => {
  // The defect the negative control caught in this very tool: a failed apksigner invocation produced
  // empty output, which must read as "cannot verify", never as "no signer, therefore fine".
  const empty = verifier.assessApk(config, observe({ apksigner: '', badging: '' }));
  assert.equal(empty.ok, false);
  assert.ok(empty.failures.some((f) => /APK signature valid/.test(f)));
  assert.ok(empty.failures.some((f) => /signer certificate/.test(f)));
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: null }).ok, false);
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: '' }).ok, false);
  assert.equal(verifier.assessSignerOnly(config, {}).ok, false);
});

test('SIGNER-10-FINGERPRINT-COMPARISON-IS-FORMAT-INSENSITIVE-BUT-NOT-SLOPPY', () => {
  const colons = '0D:58:94:49:33:5F:91:54:E0:4A:6B:97:3E:B1:86:E8:8F:D6:17:58:1A:98:43:FB:62:AC:C2:E8:EC:76:31:1B';
  assert.equal(verifier.normaliseFingerprint(colons), S4_CERT_SHA256, 'keytool colon form compares equal');
  assert.equal(verifier.normaliseFingerprint(S4_CERT_SHA256.toUpperCase()), S4_CERT_SHA256, 'case-insensitive');
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: colons }).ok, true);
  // A near-miss must not pass: one character different is a different key.
  const nearMiss = `${S4_CERT_SHA256.slice(0, 63)}c`;
  assert.notEqual(nearMiss, S4_CERT_SHA256);
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: nearMiss }).ok, false);
  // A truncated fingerprint must not pass either.
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: S4_CERT_SHA256.slice(0, 32) }).ok, false);
});

test('SIGNER-11-THE-CHECK-IS-A-POST-BUILD-STEP-NOT-A-PRETEND-GATE-STEP', () => {
  // Honesty requirement: CI signs nothing, so no gate step may RUN an APK signer verification.
  // Checked against the executed commands only — the surrounding comments legitimately explain where
  // the real APK check happens, and naturally name it.
  const workflow = fs.readFileSync(path.join(ROOT, '..', '.github/workflows/s4-mobile-release-gate.yml'), 'utf8');
  const commands = workflow.split(/\r?\n/).filter((line) => /^\s*run:/.test(line)).join('\n');
  assert.ok(commands.split('\n').length > 20, 'the run: lines were actually captured');
  for (const forbidden of ['verify:apk-signer', 'verify-apk-signer', 'apksigner', '.apk']) {
    assert.ok(!commands.includes(forbidden), `no gate command may reference ${forbidden}`);
  }
  // And the gate DOES run this suite, which is the honest part.
  assert.ok(commands.includes('npm run test:signer-provenance'), 'the gate runs the provenance suite');

  // But the verifier must be a real, runnable release step.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['verify:apk-signer'], 'node scripts/verify-apk-signer.cjs', 'exposed as a release command');
  const source = read('scripts/verify-apk-signer.cjs');
  assert.match(source, /--signer-only/, 'supports comparing an arbitrary APK to the pinned identity');
  assert.match(source, /process\.exit\(1\)/, 'and exits non-zero on mismatch');
  assert.match(source, /shell: true/, 'launches apksigner.bat correctly on Windows');
  // Without --verbose apksigner omits the "Verifies" line entirely, so the validity check could never
  // pass. Pinned because the symptom (a good APK reported unverified) looks like a bad artefact.
  assert.match(
    source,
    /\['verify', '--verbose', '--print-certs', apkPath\]/,
    'apksigner is asked for the verbose output that contains the Verifies line',
  );
});

console.log(`\n${passed} signer provenance checks passed`);
