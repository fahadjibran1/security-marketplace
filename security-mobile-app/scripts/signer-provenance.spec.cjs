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
/** What the retired com.securitymarketplace.mobile builds (1.0.4 to Build 12) are checked against. */
const legacy = verifier.legacyExpectation(config);

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
  /** Build 9: the S4 identity at versionCode 9 — the build currently installed on the pilot device. */
  build9: {
    apksigner: [
      'Verifies',
      'Number of signers: 1',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='9' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
  /** Build 10: Phase 1 only. Verified and signed with the S4 identity, but never installed. */
  build10: {
    apksigner: [
      'Verifies',
      'Number of signers: 1',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='10' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
  /** Build 11: Phase 1 + Phase 2. Correctly signed, and superseded by Build 12. */
  build11: {
    apksigner: [
      'Verifies',
      'Number of signers: 1',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='11' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
  /** What a correct Build 12 must look like: the same S4 identity at versionCode 12. */
  expectedBuild12: {
    apksigner: [
      'Verifies',
      'Number of signers: 1',
      `Signer #1 certificate SHA-256 digest: ${S4_CERT_SHA256}`,
    ].join('\n'),
    badging: "package: name='com.securitymarketplace.mobile' versionCode='12' versionName='1.0.7'\nminSdkVersion:'24'\ntargetSdkVersion:'36'",
  },
};

const observe = (recorded) => ({
  verifies: verifier.parseVerifies(recorded.apksigner),
  certificateSha256: verifier.parseSignerSha256(recorded.apksigner),
  ...verifier.parseBadging(recorded.badging),
});

// ═══════════════════ the pinned expectation ═══════════════════

test('SIGNER-01-THE-PERMANENT-IDENTITY-IS-PINNED-AND-IS-THE-HISTORICAL-S4-CERTIFICATE', () => {
  // Gate 4A: the permanent store identity. The signer did NOT change with the package.
  assert.equal(config.package, 'com.sfour.s4');
  assert.equal(config.legacyPackage.package, 'com.securitymarketplace.mobile', 'the development package is kept as history');
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
  assert.equal(appJson.expo.version, '1.1.1');
  assert.equal(appJson.expo.android.versionCode, 19, 'the push-registration fix maintenance release candidate');
  assert.ok(appJson.expo.android.versionCode > 18, 'above the distributed Guard notifications update 18');
  assert.ok(appJson.expo.android.versionCode > 17, 'above the distributed Welfare Check push release 17');
  assert.ok(appJson.expo.android.versionCode > 16, 'above the built pilot update 16');
  assert.ok(appJson.expo.android.versionCode > 15, 'above the superseded Guard release 15');
  assert.ok(appJson.expo.android.versionCode > 14, 'above the superseded RC14');
  assert.ok(appJson.expo.android.versionCode > 13, 'above the retired first permanent-identity candidate 13');
  // com.sfour.s4 is a new Android application, so no install-over is involved — the code still never
  // goes backwards, so every S4 artefact ever made has a distinct, increasing number.
  assert.ok(appJson.expo.android.versionCode > config.legacyPackage.finalRelease.versionCode, 'above the final development-package Build 12');
  assert.equal(config.legacyPackage.finalRelease.versionCode, 12);
  assert.equal(config.legacyPackage.finalRelease.versionName, '1.0.7');
});

test('SIGNER-05-THE-PILOT-RELEASE-SHAPE-IS-UNCHANGED', () => {
  assert.equal(easJson.cli.appVersionSource, 'local');
  assert.equal(easJson.build.pilot.distribution, 'internal');
  assert.equal(easJson.build.pilot.android.buildType, 'apk');
  // The setting that makes the pilot profile sign with the permanent S4 keystore rather than the
  // EAS-generated one. Reverting it to the remote default is exactly how Build 8 came to be signed with
  // the wrong identity, and it would be invisible until a tester could not install the APK.
  assert.equal(easJson.build.pilot.credentialsSource, 'local', 'the pilot profile signs with the local S4 keystore');
  // The store profile too. Left on the remote default, EAS would GENERATE a new keystore for the new
  // package com.sfour.s4 — Build 8's failure again, this time on the store upload key.
  assert.equal(easJson.build.production.android.credentialsSource, 'local', 'the store profile signs with the local S4 keystore');
  assert.ok(!('EXPO_PUBLIC_API_URL' in (easJson.build.pilot.env || {})), 'pilot still uses the production API');
  assert.equal(appJson.expo.extra.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  assert.deepEqual(appJson.expo.updates, { enabled: false }, 'OTA stays disabled');
});

// ═══════════════════ the comparison logic, executed ═══════════════════

test('SIGNER-06-A-CORRECT-BUILD-12-WOULD-PASS-FULL-VERIFICATION', () => {
  const result = verifier.assessApk(legacy, observe(RECORDED.expectedBuild12));
  assert.equal(result.ok, true, `a correct Build 12 must pass its own (legacy) release check, got: ${result.failures.join('; ')}`);
});

test('SIGNER-06B-A-SUPERSEDED-BUILD-NO-LONGER-PASSES-AS-THE-CURRENT-RELEASE', () => {
  // Builds 9, 10 and 11 all carry the correct permanent identity but are no longer the release this
  // repository expects. Without this, re-verifying a stale download would look like a pass and the wrong
  // APK could reach the pilot device — Build 11 especially, since it is signed, verified, only one number
  // behind, and is the build actually installed on the test phone. A Build 11 APK is the most likely file
  // to be re-checked by mistake.
  for (const stale of [RECORDED.build9, RECORDED.build10, RECORDED.build11]) {
    const observed = observe(stale);
    assert.equal(verifier.assessSignerOnly(config, observed).ok, true, 'the signer itself is still ours');

    const full = verifier.assessApk(legacy, observed);
    assert.equal(full.ok, false, `vc${observed.versionCode} is not the current release`);
    assert.ok(
      full.failures.some((f) => /versionCode/.test(f)),
      `the versionCode must be named as the reason; got ${JSON.stringify(full.failures)}`,
    );
  }
});

test('SIGNER-06C-BUILD-12-CAN-UPDATE-EVERY-EARLIER-S4-BUILD', () => {
  // Android installs an update only over an identical package signed by an identical certificate, with a
  // versionCode that does not go backwards. Build 8 failed exactly this and could not be installed.
  //
  // Build 11 leads the list because it is the build actually on the test phone: Build 12 has to install
  // directly over it, without an uninstall.
  const build12 = observe(RECORDED.expectedBuild12);
  const lineage = [
    ['Build 11 (on the test phone)', observe(RECORDED.build11)],
    ['Build 10 (never installed)', observe(RECORDED.build10)],
    ['Build 9 (first distributable pilot build)', observe(RECORDED.build9)],
    ['the installed 1.0.4', observe(RECORDED.historical104)],
  ];

  for (const [label, earlier] of lineage) {
    assert.equal(build12.packageName, earlier.packageName, `same package as ${label}`);
    assert.equal(
      verifier.normaliseFingerprint(build12.certificateSha256),
      verifier.normaliseFingerprint(earlier.certificateSha256),
      `same signing certificate as ${label}`,
    );
    assert.ok(
      build12.versionCode > earlier.versionCode,
      `versionCode must advance over ${label}: ${build12.versionCode} > ${earlier.versionCode}`,
    );
  }

  // The chain stated as the release instruction states it.
  const vc = (recorded) => observe(recorded).versionCode;
  assert.ok(
    vc(RECORDED.expectedBuild12) > vc(RECORDED.build11)
      && vc(RECORDED.build11) > vc(RECORDED.build10)
      && vc(RECORDED.build10) > vc(RECORDED.build9),
    '12 > 11 > 10 > 9',
  );

  // And it is the identity the repository pins, not merely self-consistent.
  assert.equal(verifier.normaliseFingerprint(build12.certificateSha256), S4_CERT_SHA256);
  assert.equal(build12.versionCode, config.legacyPackage.finalRelease.versionCode);
});

test('SIGNER-06D-THE-SUPERSEDED-BUILD-12-IS-NAMED-AND-NOT-DISTRIBUTABLE', () => {
  // Two artefacts now carry versionCode 12. The first was correctly signed and is defective: on a real
  // device the Current Shift card showed In Progress / LIVE with a Book On recorded, while every action
  // form refused as if no shift were active, because the dispatcher validated a historical
  // selectedShift. A versionCode alone therefore no longer identifies the approved build.
  const superseded = (config.legacyPackage.supersededBuilds || []).find(
    (entry) => entry.easBuildId === '4085faf6-c755-4720-9e86-c15ac2e63926',
  );
  assert.ok(superseded, 'the defective Build 12 must be recorded');
  assert.equal(superseded.versionCode, 12);
  assert.equal(superseded.distribute, false, 'and marked as not distributable');
  assert.match(superseded.reason, /selectedShift|current-shift/i, 'with the reason stated');
  assert.match(superseded.apkSha256, /^[0-9a-f]{64}$/, 'identified by artefact hash, not just version');

  // It must NOT be filed as a rejected build: that list is keyed by certificate fingerprint and is only
  // consulted to explain a signer MISMATCH. This artefact carries our own correct signer, so an entry
  // there would never trigger and could describe a validly signed APK as rejected.
  const misfiled = (config.rejectedBuilds || []).find((entry) => entry.versionCode === 12);
  assert.equal(misfiled, undefined, 'a content defect is not a signer rejection');
  for (const entry of config.rejectedBuilds || []) {
    assert.notEqual(
      verifier.normaliseFingerprint(entry.certificateSha256),
      verifier.normaliseFingerprint(config.signer.certificateSha256),
      'no rejected entry may carry the permanent identity',
    );
  }
});

test('SIGNER-06E-THE-APPROVED-ARTEFACT-IS-EXPLICIT', () => {
  // Because two artefacts share a versionCode, something has to say which one is approved. Until the
  // replacement is built and its id and hash are recorded, NO versionCode 12 artefact is approved —
  // stated as data rather than left implicit.
  // The final development-package build stays explicitly identified.
  const approved = config.legacyPackage.approvedArtefact;
  assert.ok(approved, 'the approved legacy artefact must still be named');
  assert.equal(approved.versionCode, config.legacyPackage.finalRelease.versionCode);
  assert.equal(approved.versionName, config.legacyPackage.finalRelease.versionName);

  // A 1.1.0 artefact is claimed only once it has been built AND certified, and then it is identified
  // completely: build id, source commit, AAB hash and the upload signer it was verified against.
  const current = config.approvedArtefact;
  const prepared = config.preparedArtefact;
  if (prepared) {
    // A prepared release (version set in app.json, nothing built) is what the next build must match, so it, not the
    // distributed artefact, carries the expected release. It is held to the same identity and signer requirements and
    // may claim no build: no build id, no hash, no file, no Play state. Once built and certified from the downloaded
    // AAB (built-not-uploaded, as vc18 was before its upload) it is identified completely, and still has no Play state.
    assert.ok(['prepared-not-built', 'built-not-uploaded'].includes(prepared.status), `unexpected prepared status ${prepared.status}`);
    assert.equal(prepared.versionCode, config.expectedRelease.versionCode);
    assert.equal(prepared.versionName, config.expectedRelease.versionName);
    assert.ok(Number.isInteger(prepared.versionCode), 'a whole versionCode');
    // No Play state in either state: a prepared or built-not-uploaded artefact has never reached Google Play.
    assert.deepEqual(Object.keys(prepared).filter((key) => /^play|internalTesting|uploaded/i.test(key)), [], 'no Play upload facts');
    const buildFacts = ['easBuildId', 'easBuildUrl', 'aabSha256', 'aabFilename', 'aabSizeBytes', 'gitCommit', 'certifiedOn', 'verified', 'uploadCertificateSha256'];
    if (prepared.status === 'prepared-not-built') {
      for (const key of [...buildFacts, 'apkSha256', 'completedAt']) {
        assert.ok(!(key in prepared), `a prepared artefact records no ${key}`);
      }
    } else {
      for (const key of buildFacts) assert.ok(key in prepared, `a built artefact records its ${key}`);
      assert.ok(!('apkSha256' in prepared), 'an App Bundle, not an APK');
      assert.match(prepared.easBuildId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a real EAS build id');
      assert.ok(prepared.easBuildUrl.endsWith(`/builds/${prepared.easBuildId}`), 'the build URL names the same build');
      assert.match(prepared.gitCommit, /^[0-9a-f]{40}$/, 'the full source commit it was built from');
      assert.match(prepared.aabSha256, /^[0-9a-f]{64}$/, 'the AAB hash');
      assert.match(prepared.aabFilename, /\.aab$/, 'an App Bundle, not an APK');
      assert.ok(prepared.aabFilename.includes(`vc${prepared.versionCode}-`), 'the file is named for its versionCode');
      assert.ok(Number.isInteger(prepared.aabSizeBytes) && prepared.aabSizeBytes > 0, 'the AAB size in bytes');
      assert.match(prepared.certifiedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(prepared.uploadCertificateSha256, config.signer.certificateSha256, 'verified against the permanent upload key');
      assert.equal(prepared.verified.package, config.package);
      assert.equal(prepared.verified.versionCode, prepared.versionCode);
      assert.equal(prepared.verified.versionName, prepared.versionName);
      assert.equal(prepared.verified.signerCertificateSha256, config.signer.certificateSha256, 'read from the AAB signature');
      assert.equal(prepared.verified.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
      assert.equal(prepared.verified.stagingApiUrls, 0);
      assert.notEqual(prepared.aabSha256, current.aabSha256, 'a different artefact from the distributed one');
      assert.notEqual(prepared.easBuildId, current.easBuildId);
      assert.match(prepared.note, /Not uploaded to Google Play/);
      assert.doesNotMatch(prepared.note, /uploaded (by the owner )?to Google Play Internal Testing/i, 'not presented as uploaded');
    }
    assert.equal(prepared.easBuildProfile, 'production', 'built only with the store profile');
    assert.equal(prepared.distribution, 'STORE');
    assert.match(prepared.sourceFixCommit, /^[0-9a-f]{40}$/, 'the full source commit it is prepared from');
    assert.ok(prepared.sourceBranch, 'the branch it is prepared on');
    assert.equal(prepared.requiredUploadCertificateSha256, config.signer.certificateSha256, 'must be signed by the permanent upload key');
    // The distributed artefact stays the built, certified one, strictly below the prepared one.
    assert.ok(prepared.versionCode > current.versionCode, 'the prepared versionCode is above the distributed one');
    assert.notEqual(current.status, 'pending-build', 'with a prepared release in front, the approved artefact is a built one');
  } else {
    assert.equal(current.versionCode, config.expectedRelease.versionCode);
    assert.equal(current.versionName, config.expectedRelease.versionName);
  }
  if (current.status === 'pending-build') {
    assert.ok(!current.easBuildId && !current.apkSha256 && !current.aabSha256, 'a pending artefact has no build id or hash');
  } else {
    // Built and certified from the downloaded AAB; awaiting the Play upload, recorded as not uploaded yet, or distributed.
    assert.ok(['certified-awaiting-play', 'built-not-uploaded', 'distributed'].includes(current.status), `unexpected status ${current.status}`);
    assert.match(current.easBuildId, /^[0-9a-f-]{36}$/, 'a real EAS build id');
    assert.match(current.gitCommit, /^[0-9a-f]{40}$/, 'the full source commit');
    assert.match(current.aabSha256, /^[0-9a-f]{64}$/, 'the AAB hash');
    assert.match(current.aabFilename, /\.aab$/, 'an App Bundle, not an APK');
    assert.equal(current.uploadCertificateSha256, config.signer.certificateSha256, 'verified against the permanent upload key');
    // Until Play signs anything, the upload certificate is the only one known; it is never overwritten.
    assert.equal(config.playAppSigning.uploadCertificateSha256, config.signer.certificateSha256);
    if (current.status === 'distributed') {
      // A distributed artefact names who confirmed it reached Play and when, is Play's active release, and is the
      // only artefact at its versionCode: nothing retired may share or exceed it.
      assert.equal(current.playInternalTesting.status, 'active', 'distributed means active in Play Internal Testing');
      assert.equal(current.playInternalTesting.confirmedBy, 'owner', 'store facts are attributed, not presented as inspected');
      assert.match(current.playInternalTesting.confirmedOn, /^\d{4}-\d{2}-\d{2}$/);
      if ('uploadedAabSha256' in current.playInternalTesting) {
        assert.equal(current.playInternalTesting.uploadedAabSha256, current.aabSha256, 'an uploaded hash is the certified one');
      }
      assert.equal(config.playConsole.internalTesting.activeRelease, `${current.versionName} (${current.versionCode})`, 'Play shows the distributed artefact');
      for (const entry of config.retiredArtefacts || []) {
        assert.ok(entry.versionCode < current.versionCode, `retired versionCode ${entry.versionCode} is below the distributed one`);
        assert.notEqual(entry.aabSha256, current.aabSha256, 'a retired artefact is never the distributed one');
        assert.notEqual(entry.easBuildId, current.easBuildId);
      }
    }
  }

  if (approved.status === 'pending-rebuild') {
    assert.ok(approved.requiredGitCommit, 'the commit the rebuild must contain');
    assert.ok(!approved.easBuildId, 'a pending artefact has no build id yet');
    assert.ok(!approved.apkSha256, 'nor a hash');
  } else {
    assert.equal(approved.status, 'approved');
    assert.match(approved.easBuildId, /^[0-9a-f-]{36}$/, 'a real EAS build id');
    assert.match(approved.apkSha256, /^[0-9a-f]{64}$/, 'and a real artefact hash');
    assert.match(approved.gitCommit, /^[0-9a-f]{7,40}$/, 'built from a known commit');
    // The approved artefact must never be the superseded one.
    for (const entry of config.legacyPackage.supersededBuilds || []) {
      assert.notEqual(approved.easBuildId, entry.easBuildId, 'approved must not be a superseded build');
      assert.notEqual(approved.apkSha256, entry.apkSha256, 'nor the same artefact');
    }
  }
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

// ═══════════════════ Gate 4A: the permanent package ═══════════════════

test('SIGNER-12-A-DEVELOPMENT-PACKAGE-APK-CAN-NEVER-PASS-AS-THE-STORE-CANDIDATE', () => {
  // Build 12 is correctly signed and current for its own package — and is still not S4 1.1.0. If it were
  // re-verified against the new expectation by mistake, the package must be named as the reason.
  const full = verifier.assessApk(config, observe(RECORDED.expectedBuild12));
  assert.equal(full.ok, false);
  assert.ok(full.failures.some((f) => /package id/.test(f) && /com\.sfour\.s4/.test(f)), JSON.stringify(full.failures));
  assert.ok(full.failures.every((f) => !/signer certificate/.test(f)), 'the signer itself is still the permanent key');
});

test('SIGNER-13-A-CORRECT-1-1-0-COM-SFOUR-S4-ARTEFACT-WOULD-PASS', () => {
  // Constructed in the exact apksigner/aapt2 shapes recorded above; no such artefact exists yet.
  const candidate = observe({
    apksigner: RECORDED.expectedBuild12.apksigner,
    badging: "package: name='com.sfour.s4' versionCode='19' versionName='1.1.1'\nminSdkVersion:'24'",
  });
  const result = verifier.assessApk(config, candidate);
  assert.equal(result.ok, true, result.failures.join('; '));
  // A wrong code or name on the right package is still refused — including the retired 13 and the distributed 18.
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 13 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 14 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 15 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 16 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 17 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 18 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 20 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.1.0' }).ok, false, 'the 1.1.0 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.0.7' }).ok, false);
});

test('SIGNER-13B-THE-RETIRED-VC13-ARTEFACT-IS-KEPT-EXACTLY', () => {
  // Phase 4E: the certified 1.1.0 (13) AAB predates Dashboard V2 and is not intended for upload, but its
  // certification is history and is never rewritten — only its status records the retirement.
  const retired = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 13);
  assert.ok(retired, 'versionCode 13 is recorded as retired');
  assert.equal(retired.status, 'certified-retired');
  assert.equal(retired.easBuildId, '545b6ed6-78ca-43ce-9689-b11f0e34e7ad');
  assert.equal(retired.gitCommit, '6cf29c8b3444a9cabb81bb79e90e21ce7ddf5626');
  assert.equal(retired.aabSha256, '955fd091465ab7cac189179d1e99149a13a9146bb74207bb6272ff0e6e020f86');
  assert.equal(retired.aabSizeBytes, 58675805);
  assert.equal(retired.uploadCertificateSha256, config.signer.certificateSha256);
  assert.equal(retired.certifiedOn, '2026-10-05');
  assert.match(retired.retiredReason, /Dashboard Operations V2/);
  assert.match(retired.retiredReason, /not intended for Google Play upload/);
  assert.notEqual(config.approvedArtefact.versionCode, 13, 'and it is no longer the approved artefact');
});

test('SIGNER-13C-THE-SUPERSEDED-VC14-ARTEFACT-IS-KEPT-EXACTLY', () => {
  // Guard release (20 Oct 2026): the certified 1.1.0 (14) AAB predates the Guard shift-offer fix. It is active in
  // Google Play Internal Testing (owner-confirmed). Its certification is history and is kept exactly; only its status,
  // reason and the owner-confirmed Play state record the change.
  const superseded = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 14);
  assert.ok(superseded, 'versionCode 14 is recorded as superseded');
  assert.equal(superseded.status, 'superseded-active-in-play-internal-testing');
  assert.equal(superseded.easBuildId, '4b31e82d-7b36-4b76-8887-59c446527931');
  assert.equal(superseded.gitCommit, 'e099c4e22fac3a2af32053b6870060bda4d9d5ef');
  assert.equal(superseded.aabSha256, 'e07c4dc8dc33c9c66b8fe107296be69506b50681b6da9dec21008f39e23dde66');
  assert.equal(superseded.aabSizeBytes, 58685803);
  assert.equal(superseded.uploadCertificateSha256, config.signer.certificateSha256);
  assert.equal(superseded.certifiedOn, '2026-10-06');
  assert.match(superseded.retiredReason, /active in Google Play Internal Testing/);
  assert.equal(superseded.playInternalTesting.status, 'active');
  assert.equal(superseded.playInternalTesting.confirmedBy, 'owner', 'store facts are attributed, not presented as inspected');
  assert.match(superseded.retiredReason, /d880ef0/);
  assert.equal(config.signer.keySizeBits, 4096, 'the size keytool reports for the permanent key');
});

test('SIGNER-13D-THE-SUPERSEDED-VC15-ARTEFACT-IS-KEPT-EXACTLY', () => {
  // Pilot update (23 Oct 2026): the certified 1.1.0 (15) AAB (20 Oct Guard release) is superseded by 16. Its
  // certification is history and is kept exactly; whether it reached Play is not asserted (owner to confirm).
  const superseded = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 15);
  assert.ok(superseded, 'versionCode 15 is recorded as superseded');
  assert.equal(superseded.status, 'certified-superseded');
  assert.equal(superseded.easBuildId, '8d1873a3-ec09-48f6-90f4-0ca75f178ba8');
  assert.equal(superseded.gitCommit, '6b8e41b679bfa3726ae4ca21d36701fafb2a38c7');
  assert.equal(superseded.aabSha256, '5e69f8d830f4bbc1d08500bf3e0b9430438bf0fd91a747018b5ffae2c22ccf80');
  assert.equal(superseded.verified.package, 'com.sfour.s4');
  assert.equal(superseded.verified.versionCode, 15);
  assert.equal(superseded.uploadCertificateSha256, config.signer.certificateSha256);
  assert.match(superseded.retiredReason, /to be confirmed by the owner/, 'the Play state is not presented as known');
});

test('SIGNER-13E-THE-BUILT-VC16-ARTEFACT-IS-SUPERSEDED-BY-THE-WELFARE-PUSH-UPDATE', () => {
  // Welfare Check push update (23 Oct 2026): the built 1.1.0 (16) AAB is superseded by 17. Its build, hash and
  // signer are recorded; whether it reached Play is not asserted (owner to confirm).
  const superseded = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 16);
  assert.ok(superseded, 'versionCode 16 is recorded as superseded');
  assert.equal(superseded.status, 'built-superseded');
  assert.equal(superseded.easBuildId, '5a3bfe71-3125-4fd0-b8c5-dcf6b808de98');
  assert.equal(superseded.gitCommit, 'e539b89cc7cdf5479837e9076b45c24c7ecc40f7');
  assert.equal(superseded.aabSha256, '82f0aff91acf824d18134e192528459192ab88caff07ac47ad9c266e41974b60');
  assert.equal(superseded.uploadCertificateSha256, config.signer.certificateSha256, 'signed by the permanent S4 key');
  assert.match(superseded.retiredReason, /to be confirmed by the owner/, 'the Play state is not presented as known');
  // The Firebase client file and FCM key are EAS-held, never recorded here.
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13F-THE-DISTRIBUTED-VC17-ARTEFACT-IS-SUPERSEDED-BY-THE-GUARD-NOTIFICATIONS-UPDATE', () => {
  // Guard notifications update (25 Oct 2026): the 1.1.0 (17) AAB, built and certified on 24 Oct 2026 (EAS production
  // build dd77f96d from 5a562f1), was uploaded to Google Play Internal Testing (owner-confirmed 24 Oct 2026). It is
  // superseded by 18 and kept exactly: build, commit, hash and signer.
  const superseded = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 17);
  assert.ok(superseded, 'versionCode 17 is recorded as superseded');
  assert.equal(superseded.status, 'distributed-superseded');
  assert.equal(superseded.easBuildId, 'dd77f96d-44cd-4d60-aa61-45f2b9a059ee');
  assert.equal(superseded.gitCommit, '5a562f163a613dc780871345ee9e55d1ac1f24ef');
  assert.equal(superseded.aabSha256, 'c82e0c40ea67ad4eb7c2ad42408973462bca3e3dcec29a312c5f82999934f9fa');
  assert.equal(superseded.uploadCertificateSha256, config.signer.certificateSha256, 'signed by the permanent S4 key');
  assert.equal(superseded.verified.package, 'com.sfour.s4');
  assert.equal(superseded.verified.versionCode, 17);
  assert.equal(superseded.playInternalTesting.confirmedBy, 'owner');
  assert.equal(superseded.playInternalTesting.confirmedOn, '2026-10-24');
  assert.match(superseded.retiredReason, /uploaded to Google Play Internal Testing \(owner-confirmed 24 Oct 2026\)/);
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 17).length, 1, 'recorded once');
  // The Guard notifications update 18 that superseded it is itself now superseded by 1.1.1 (19) (SIGNER-13G, 13H).
  const vc18 = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 18);
  assert.ok(vc18, 'the Guard notifications update 18 is recorded');
  assert.match(vc18.note, /PR #34/);
  assert.equal(config.expectedRelease.versionCode, 19);
  assert.equal(config.expectedRelease.versionCode, config.approvedArtefact.versionCode);
});

test('SIGNER-13G-THE-DISTRIBUTED-VC18-ARTEFACT-IS-SIGNED-BY-THE-SAME-UPLOAD-KEY-AS-VC17-AND-SUPERSEDED-BY-VC19', () => {
  // Guard notifications update (25 Oct 2026): 1.1.0 (18) built by EAS (1b76ec3f) from c5a4f40 with the existing upload
  // key, certified from the downloaded AAB, uploaded by the owner and Active in Google Play Internal Testing
  // (owner-confirmed 25 Oct 2026). Superseded on 26 Oct 2026 by 1.1.1 (19); kept exactly, as vc17 was by vc18.
  const current = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 18);
  const vc17 = config.retiredArtefacts.find((entry) => entry.versionCode === 17);
  assert.ok(current, 'versionCode 18 is recorded as superseded');
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 18).length, 1, 'recorded once');
  assert.equal(current.status, 'distributed-superseded', 'the certified AAB was distributed and is now superseded');
  assert.equal(current.status, vc17.status, 'the same superseded status vc17 carries');
  assert.equal(current.retiredOn, '2026-10-26');
  assert.match(current.retiredReason, /^Superseded by versionCode 19 \(1\.1\.1\)/);
  assert.match(current.retiredReason, /808a55c/);
  assert.match(current.retiredReason, /Active in Google Play Internal Testing \(owner-confirmed 25 Oct 2026\)/);
  assert.equal(current.playInternalTesting.status, 'active');
  assert.equal(current.playInternalTesting.confirmedBy, 'owner');
  assert.equal(current.playInternalTesting.confirmedOn, '2026-10-25');
  assert.equal(current.playInternalTesting.uploadedAabSha256, current.aabSha256, 'the uploaded AAB is the certified one');
  assert.notEqual(config.approvedArtefact.versionCode, 18, 'and it is no longer the approved artefact');
  assert.equal(current.easBuildId, '1b76ec3f-0445-4d33-8f06-c379f31d1118');
  assert.equal(current.gitCommit, 'c5a4f4099937b23228c355a8e70a687658ad887b');
  assert.equal(current.aabSha256, '936bfe7531dfd94fa4afc5006b7d6755ef5b9d07e8e3a21c0baa67dd6a4f4bc8');
  assert.equal(current.aabFilename, 's4-1.1.0-vc18-1b76ec3f.aab');
  assert.equal(current.uploadCertificateSha256, config.signer.certificateSha256, 'signed by the permanent S4 key');
  assert.equal(current.uploadCertificateSha256, vc17.uploadCertificateSha256, 'the same upload certificate as the distributed vc17');
  assert.equal(current.verified.signerCertificateSha256, S4_CERT_SHA256, 'full fingerprint read from the AAB signature');
  assert.equal(current.verified.package, 'com.sfour.s4');
  assert.equal(current.verified.versionCode, 18);
  assert.equal(current.verified.versionName, '1.1.0');
  assert.equal(current.verified.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  assert.equal(current.verified.stagingApiUrls, 0);
  assert.equal(current.verified.defaultNotificationChannel, 'welfare-checks', 'the Welfare channel stays the default');
  assert.notEqual(current.aabSha256, vc17.aabSha256);
  assert.notEqual(current.easBuildId, vc17.easBuildId);
  assert.match(current.note, /Uploaded by the owner to Google Play Internal Testing \(the certified AAB/, 'the upload is the owner\'s, of the certified AAB');
  // vc17 stays recorded as distributed and superseded.
  assert.equal(vc17.status, 'distributed-superseded');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13H-THE-1-1-1-VC19-IS-DISTRIBUTED-AND-USES-THE-VC17-VC18-UPLOAD-KEY', () => {
  // Maintenance release (25 Oct 2026): 1.1.1 (19) carries the push-registration loop fix (808a55c on
  // fix/push-registration-loop). Built by EAS (b0506fbb) from 1a6c856 on owner approval and certified from the
  // downloaded AAB (26 Oct 2026). The owner uploaded it to Google Play Internal Testing (approved 26 Oct 2026) and
  // production push_devices shows Android devices on appVersion 1.1.1 (27 Oct 2026): it is the distributed build.
  assert.ok(!('preparedArtefact' in config), 'nothing is prepared in front of the distributed 1.1.1 (19)');
  const prepared = config.approvedArtefact;
  const vc18 = config.retiredArtefacts.find((entry) => entry.versionCode === 18);
  const vc17 = config.retiredArtefacts.find((entry) => entry.versionCode === 17);
  const semver = (v) => v.split('.').map(Number);
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  assert.ok(prepared, 'the 1.1.1 release is recorded');
  assert.equal(prepared.status, 'distributed', 'built, certified and distributed');
  assert.equal(prepared.versionCode, config.expectedRelease.versionCode, 'the expected release is the distributed one');
  assert.equal(prepared.versionName, config.expectedRelease.versionName);
  assert.equal(prepared.versionName, '1.1.1');
  assert.equal(prepared.versionCode, 19);
  // It is exactly the version app.json now carries, and strictly above the distributed build.
  assert.equal(prepared.versionName, appJson.expo.version);
  assert.equal(prepared.versionCode, appJson.expo.android.versionCode);
  assert.ok(prepared.versionCode > vc18.versionCode, 'above the distributed versionCode 18');
  assert.ok(above(prepared.versionName, vc18.versionName), 'and a higher versionName than the distributed 1.1.0');
  assert.equal(prepared.sourceBranch, 'fix/push-registration-loop');
  assert.equal(prepared.sourceFixCommit, '808a55c2d7f2bc8a803a3f23a18d6d24123922ac');
  // The exact build: EAS id, source commit (the 1.1.1 release commit directly on top of the fix), AAB file, hash, size.
  assert.equal(prepared.easBuildId, 'b0506fbb-8644-4c51-b509-987b3d6b5796');
  assert.equal(prepared.easBuildProfile, 'production');
  assert.equal(prepared.distribution, 'STORE');
  assert.equal(prepared.gitCommit, '1a6c856504c64bf41758fb1cfd73bf81dfd06040');
  assert.equal(prepared.aabFilename, 's4-1.1.1-vc19-b0506fbb.aab');
  assert.equal(prepared.aabSha256, '168c3f116ad84be0b41225ac5658b815968d7af5006e9ccd012e8a0363f731ca');
  assert.equal(prepared.aabSizeBytes, 59102350);
  // The same upload certificate as the distributed vc17 and vc18, in full: required, and read from the AAB.
  assert.equal(prepared.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(prepared.requiredUploadCertificateSha256, vc18.uploadCertificateSha256);
  assert.equal(prepared.requiredUploadCertificateSha256, vc17.uploadCertificateSha256);
  assert.equal(prepared.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 key');
  assert.equal(prepared.verified.signerCertificateSha256, S4_CERT_SHA256, 'full fingerprint read from the AAB signature');
  assert.equal(prepared.verified.package, 'com.sfour.s4');
  assert.equal(prepared.verified.versionCode, 19);
  assert.equal(prepared.verified.versionName, '1.1.1');
  assert.equal(prepared.verified.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  assert.equal(prepared.verified.stagingApiUrls, 0);
  assert.match(prepared.verified.guardInboxInBundle, /^yes/);
  assert.match(prepared.verified.pushRegistrationFixInBundle, /^yes/);
  assert.notEqual(prepared.aabSha256, vc18.aabSha256);
  assert.notEqual(prepared.aabSha256, vc17.aabSha256);
  assert.notEqual(prepared.easBuildId, vc18.easBuildId);
  // Distributed: the owner's upload (approved 26 Oct 2026) and the production devices that report 1.1.1, attributed
  // and dated. The uploaded file's hash was not read back from Play, so none is claimed.
  const play = prepared.playInternalTesting;
  assert.ok(play, 'the Play state is recorded');
  assert.equal(play.status, 'active');
  assert.equal(play.confirmedBy, 'owner');
  assert.equal(play.confirmedOn, '2026-10-26');
  assert.equal(play.evidence, 'owner uploaded to Play Internal Testing (approved 26 Oct); production devices report 1.1.1');
  assert.ok(!('uploadedAabSha256' in play), 'no uploaded hash is claimed that was not read back from Play');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.deepEqual(play.productionDevices, {
    source: 'production push_devices',
    platform: 'android',
    appVersion: prepared.versionName,
    devices: 2,
    observedOn: '2026-10-27',
  });
  assert.match(prepared.note, /Uploaded by the owner to Google Play Internal Testing \(owner-approved 26 Oct 2026\)/);
  assert.doesNotMatch(prepared.note, /Not uploaded to Google Play/, 'no longer presented as not uploaded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.1.1 (19)');
  assert.match(config.playConsole.source, /active release 1\.1\.1 \(19\): owner uploaded to Play Internal Testing \(approved 26 Oct\); production devices report 1\.1\.1/);
  // vc18 is kept exactly as the distributed-superseded build below it (SIGNER-13G).
  assert.equal(vc18.status, 'distributed-superseded');
  assert.equal(vc18.versionCode, 18);
  assert.equal(vc18.aabSha256, '936bfe7531dfd94fa4afc5006b7d6755ef5b9d07e8e3a21c0baa67dd6a4f4bc8');
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode >= 19).length, 0, 'nothing at 19 or above is retired');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-14-AN-UPLOADED-AAB-SIGNER-IS-READ-FROM-KEYTOOL', () => {
  const keytoolOutput = [
    'Signer #1:',
    '',
    'Certificate #1:',
    'Owner: CN=S4 Security, OU=S4 Pilot, O=Vesoft Services Limited, C=GB',
    'Certificate fingerprints:',
    '\t SHA1: 45:A5:30:AA:16:81:F2:DA:1E:3B:05:68:D9:82:F4:92:EE:ED:B7:5E',
    '\t SHA256: 0D:58:94:49:33:5F:91:54:E0:4A:6B:97:3E:B1:86:E8:8F:D6:17:58:1A:98:43:FB:62:AC:C2:E8:EC:76:31:1B',
  ].join('\n');
  assert.equal(verifier.parseKeytoolSha256(keytoolOutput), S4_CERT_SHA256);
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: verifier.parseKeytoolSha256(keytoolOutput) }).ok, true);
  assert.equal(verifier.parseKeytoolSha256('keytool error: java.lang.Exception: Not a signed jar file'), null, 'an unsigned AAB yields no signer');
  assert.equal(verifier.assessSignerOnly(config, { certificateSha256: verifier.parseKeytoolSha256('') }).ok, false);
});

test('SIGNER-15-PLAY-APP-SIGNING-IS-RECORDED-HONESTLY', () => {
  // The upload certificate is ours; the app-signing certificate is Google's. 1.1.0 (14) is in Internal Testing, so
  // Play App Signing is in use, but its certificate has not been read from Play Console: null, not guessed.
  assert.equal(config.playAppSigning.status, 'in-use-certificate-not-recorded');
  assert.equal(config.playAppSigning.uploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(config.playAppSigning.appSigningCertificateSha256, null);
});

console.log(`\n${passed} signer provenance checks passed`);
