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

/**
 * SIGNER-06E rule 3, strict (release-record validation only). A distributed-superseded artefact (vc) that says
 * "Superseded by versionCode N" is fully recorded only when:
 *   1. N = vc + 1, or every k with vc < k < N is in retiredArtefacts EXACTLY ONCE with an unreleased status
 *      ('uploaded-draft-superseded', 'consumed-unreleased-superseded', or 'built-not-uploaded-superseded' — built and
 *      never uploaded to Google Play, so it reached no tester: 1.2.1 (24) between 23 and 25) — a number missing from the
 *      record fails;
 *   2. N itself is a recorded RELEASED artefact: the approved artefact, or a retiredArtefacts entry with a released
 *      (distributed) status — never an unreleased one.
 * Returns the problems (empty = fully recorded). Takes the config so the self-tests can run it on mutated copies.
 */
const UNRELEASED_SUPERSEDED = ['uploaded-draft-superseded', 'consumed-unreleased-superseded', 'built-not-uploaded-superseded'];
const RELEASED_SUPERSEDED = ['distributed-superseded'];
function supersededByProblems(cfg, entry) {
  const vc = Number(entry.versionCode);
  const next = Number((String(entry.retiredReason || '').match(/^Superseded by versionCode (\d+)\b/) || [])[1]);
  if (!Number.isInteger(next) || next <= vc) return [`vc${vc} names no later successor`];
  const retired = cfg.retiredArtefacts || [];
  const problems = [];
  for (let k = vc + 1; k < next; k += 1) {
    const rows = retired.filter((e) => Number(e.versionCode) === k);
    if (rows.length !== 1) problems.push(`vc${k} (between ${vc} and ${next}) is recorded ${rows.length} times, not exactly once`);
    else if (!UNRELEASED_SUPERSEDED.includes(rows[0].status)) problems.push(`vc${k} (between ${vc} and ${next}) has status ${rows[0].status}, not an unreleased one`);
  }
  const successor = (cfg.approvedArtefact && Number(cfg.approvedArtefact.versionCode) === next)
    || retired.some((e) => Number(e.versionCode) === next && RELEASED_SUPERSEDED.includes(e.status));
  if (!successor) problems.push(`vc${next} is not a recorded released artefact`);
  return problems;
}
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
  assert.equal(appJson.expo.version, '1.3.0');
  assert.equal(appJson.expo.android.versionCode, 29, 'the prepared S4 1.3.0 candidate (integration 5bdfdd2, EM-01 and PRs #129 to #134)');
  assert.ok(appJson.expo.android.versionCode > 28, 'above 28 (uploaded, owner-stated 26 Nov 2026), the distributed 1.2.4 and the active Play Internal Testing release; it is never rebuilt with other content');
  assert.ok(appJson.expo.android.versionCode > 27, 'above the distributed-superseded 1.2.3 (27); it is never rebuilt with other content');
  assert.ok(appJson.expo.android.versionCode > 26, 'above the distributed-superseded 1.2.2 (26); it is never rebuilt with other content');
  assert.ok(appJson.expo.android.versionCode > 25, 'above the distributed-superseded 1.2.2 (25); it is never rebuilt with other content');
  assert.ok(appJson.expo.android.versionCode > 24, 'above the built, never uploaded 1.2.1 (24), which is never rebuilt with other content');
  assert.ok(appJson.expo.android.versionCode > 23, 'above the distributed 1.2.0 (23) (published to Play Internal Testing on 31 Oct 2026), which it supersedes');
  assert.ok(appJson.expo.android.versionCode > 22, 'above the superseded 1.2.0 (22), which Play reports as used');
  assert.ok(appJson.expo.android.versionCode > 21, 'above the superseded 1.2.0 (21) Play draft, which is consumed');
  assert.ok(appJson.expo.android.versionCode > 20, 'above the distributed Guard app 1.1.2 (20)');
  assert.ok(appJson.expo.android.versionCode > 19, 'above the distributed push-registration fix maintenance release 19');
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
      assert.notEqual(prepared.gitCommit, current.gitCommit, 'built from a newer commit than the distributed one');
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
      } else {
        // No hash was read back from Play: the record says so rather than leaving it to be assumed.
        assert.match(current.playInternalTesting.note, /hash was not read back from Play Console/, 'an unread uploaded hash is stated as unread');
      }
      if ('activeRelease' in current.playInternalTesting) {
        assert.equal(current.playInternalTesting.activeRelease, `${current.versionName} (${current.versionCode})`, 'the confirmed active release is this artefact');
      }
      assert.equal(config.playConsole.internalTesting.activeRelease, `${current.versionName} (${current.versionCode})`, 'Play shows the distributed artefact');
      for (const entry of config.retiredArtefacts || []) {
        if (entry.versionCode > current.versionCode) {
          // Only a build that never reached a tester may be retired above the distributed one: consumed in Play without
          // a release (an unreleased draft, or a code Play reports as used), superseded, and strictly below the prepared
          // release.
          const UNRELEASED = { 'uploaded-draft-superseded': 'draft-not-released', 'consumed-unreleased-superseded': 'consumed-not-in-library' };
          if (entry.status === 'built-upload-unconfirmed-superseded') {
            // A built, verified build handed over for upload whose Play state was never confirmed: no Play fact is claimed
            // either way, its exact build is kept, and its number is treated as consumed. (No such record today: 1.2.2 (25),
            // once recorded this way, was owner-verified as uploaded and available to internal testers on 15 Nov 2026,
            // SIGNER-13N.)
            assert.deepEqual(Object.keys(entry).filter((key) => /^play|internalTesting|uploaded/i.test(key)), [], `vc${entry.versionCode} claims no Play fact`);
            assert.match(entry.note, /Whether it was uploaded is not confirmed/, `vc${entry.versionCode} states the unknown`);
            assert.doesNotMatch(entry.note, /Not uploaded to Google Play/, `vc${entry.versionCode} is not presented as never uploaded`);
            assert.match(entry.retiredReason, /treated as consumed whether or not it reached Google Play/, `vc${entry.versionCode} is never reused`);
            assert.match(entry.retiredReason, /never rebuilt with other content/, `vc${entry.versionCode} keeps its number for its own build`);
            assert.match(entry.easBuildId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a real EAS build id');
            assert.match(entry.aabSha256, /^[0-9a-f]{64}$/, 'the AAB hash');
            assert.match(entry.gitCommit, /^[0-9a-f]{40}$/, 'the full source commit');
            assert.equal(entry.requiredUploadCertificateSha256, config.signer.certificateSha256);
            assert.equal(entry.uploadCertificateSha256, config.signer.certificateSha256, 'verified against the permanent upload key');
          } else if (entry.status === 'built-not-uploaded-superseded') {
            // A build that never reached Play at all — no Play fact, its exact build kept, and its number is not consumed in
            // Play but is never rebuilt with other content. (No such record today: 1.2.0 (23), once recorded this way, was
            // published to Play Internal Testing on 31 Oct 2026 — owner correction, SIGNER-13M.)
            assert.deepEqual(Object.keys(entry).filter((key) => /^play|internalTesting|uploaded/i.test(key)), [], `vc${entry.versionCode} has no Play fact`);
            assert.match(entry.note, /Not uploaded to Google Play/, `vc${entry.versionCode} says it was not uploaded`);
            assert.match(entry.retiredReason, /never rebuilt with other content/, `vc${entry.versionCode} keeps its number for its own build`);
            assert.match(entry.easBuildId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a real EAS build id');
            assert.match(entry.aabSha256, /^[0-9a-f]{64}$/, 'the AAB hash');
            assert.match(entry.gitCommit, /^[0-9a-f]{40}$/, 'the full source commit');
            assert.equal(entry.requiredUploadCertificateSha256, config.signer.certificateSha256);
          } else {
            assert.ok(entry.status in UNRELEASED, `retired versionCode ${entry.versionCode} above the distributed one was never released (${entry.status})`);
            assert.equal(entry.playInternalTesting.status, UNRELEASED[entry.status], `vc${entry.versionCode} was never active in Play`);
            assert.match(entry.retiredReason, /must never be reused/, `vc${entry.versionCode} is consumed`);
          }
          assert.ok(entry.versionCode < config.expectedRelease.versionCode, `vc${entry.versionCode} is below the expected release`);
          assert.match(entry.retiredReason, new RegExp(`^Superseded by versionCode ${entry.versionCode + 1}\\b`), `vc${entry.versionCode} names its successor`);
        } else {
          assert.ok(entry.versionCode < current.versionCode, `retired versionCode ${entry.versionCode} is below the distributed one`);
        }
        assert.notEqual(entry.aabSha256, current.aabSha256, 'a retired artefact is never the distributed one');
        assert.notEqual(entry.easBuildId, current.easBuildId);
        if (entry.status === 'distributed-superseded') {
          // A once-distributed artefact keeps its attributed Play facts and names the very next versionCode that replaced it.
          assert.equal(entry.playInternalTesting.confirmedBy, 'owner', `vc${entry.versionCode} keeps its owner confirmation`);
          assert.ok(['uploaded', 'active'].includes(entry.playInternalTesting.status), `vc${entry.versionCode} keeps its Play state`);
          assert.match(entry.retiredOn, /^\d{4}-\d{2}-\d{2}$/);
          // It names the versionCode that replaced it: the very next one, or the next RELEASED one when EVERY number in
          // between is recorded as consumed in Play without a release (20 → 23: 21 a draft, 22 used but not in the
          // library) — strict, see supersededByProblems (SIGNER-06F).
          assert.deepEqual(supersededByProblems(config, entry), [], `vc${entry.versionCode}'s successor is fully recorded`);
        }
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

test('SIGNER-06F-SUPERSEDED-BY-IS-STRICT-SELF-TESTS', () => {
  // The recorded chain passes: 17→18, 18→19, 19→20 (the very next one) and 20→23 (21 and 22 recorded as unreleased).
  const distributed = (config.retiredArtefacts || []).filter((e) => e.status === 'distributed-superseded');
  assert.ok(distributed.length >= 4);
  for (const entry of distributed) assert.deepEqual(supersededByProblems(config, entry), [], `vc${entry.versionCode} as recorded`);
  const copy = () => JSON.parse(JSON.stringify(config));
  const vc20 = (c) => c.retiredArtefacts.find((e) => e.versionCode === 20);
  assert.match(vc20(config).retiredReason, /^Superseded by versionCode 23\b/, '20 → 23 as recorded');
  // A number in between that is missing from the record fails (before: it passed silently).
  {
    const c = copy();
    c.retiredArtefacts = c.retiredArtefacts.filter((e) => e.versionCode !== 22);
    assert.ok(supersededByProblems(c, vc20(c)).some((p) => /vc22 .*recorded 0 times/.test(p)), 'a gap number missing from the record fails');
  }
  // A number in between recorded twice fails.
  {
    const c = copy();
    c.retiredArtefacts.push({ ...c.retiredArtefacts.find((e) => e.versionCode === 21) });
    assert.ok(supersededByProblems(c, vc20(c)).some((p) => /vc21 .*recorded 2 times/.test(p)), 'a duplicated gap number fails');
  }
  // A number in between with a RELEASED status fails (it, not the named one, would be the successor).
  {
    const c = copy();
    c.retiredArtefacts.find((e) => e.versionCode === 21).status = 'distributed-superseded';
    assert.ok(supersededByProblems(c, vc20(c)).some((p) => /vc21 .*distributed-superseded/.test(p)), 'a released number in between fails');
  }
  // 23 → 25 (15 Nov 2026): 24 in between was built and never uploaded to Google Play, so it reached no tester and counts
  // as unreleased. A build whose Play upload is unconfirmed may have reached testers, so it does not.
  {
    const vc23 = (c) => c.retiredArtefacts.find((e) => e.versionCode === 23);
    assert.match(vc23(config).retiredReason, /^Superseded by versionCode 25\b/, '23 → 25 as recorded');
    assert.equal(config.retiredArtefacts.find((e) => e.versionCode === 24).status, 'built-not-uploaded-superseded');
    assert.deepEqual(supersededByProblems(config, vc23(config)), []);
    const c = copy();
    c.retiredArtefacts.find((e) => e.versionCode === 24).status = 'built-upload-unconfirmed-superseded';
    assert.ok(supersededByProblems(c, vc23(c)).some((p) => /vc24 .*built-upload-unconfirmed-superseded/.test(p)), 'an unconfirmed upload in between fails');
  }
  // The named successor not recorded as a released artefact fails.
  {
    const c = copy();
    c.retiredArtefacts = c.retiredArtefacts.filter((e) => e.versionCode !== 23);
    assert.ok(supersededByProblems(c, vc20(c)).some((p) => /vc23 is not a recorded released artefact/.test(p)), 'an unrecorded successor fails');
    const d = copy();
    // 29: a number no real record uses (27 is now the distributed approved artefact and 28 the prepared one).
    d.retiredArtefacts.push({ versionCode: 29, status: 'consumed-unreleased-superseded' });
    const e19 = d.retiredArtefacts.find((e) => e.versionCode === 19);
    e19.retiredReason = e19.retiredReason.replace(/^Superseded by versionCode 20\b/, 'Superseded by versionCode 29');
    assert.ok(supersededByProblems(d, e19).some((p) => /vc29 is not a recorded released artefact/.test(p)), 'a successor recorded only as unreleased fails');
  }
  // No successor named, or one not above it, fails.
  {
    const c = copy();
    vc20(c).retiredReason = 'Superseded by versionCode 20 (itself)';
    assert.ok(supersededByProblems(c, vc20(c)).length > 0);
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
    badging: "package: name='com.sfour.s4' versionCode='29' versionName='1.3.0'\nminSdkVersion:'24'",
  });
  const result = verifier.assessApk(config, candidate);
  assert.equal(result.ok, true, result.failures.join('; '));
  // A wrong code or name on the right package is still refused — including the retired 13 and the distributed 18, 19 and 20.
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 13 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 14 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 15 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 16 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 17 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 18 }).ok, false);
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 19 }).ok, false, 'the distributed 19 is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 20 }).ok, false, 'the distributed 20 is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 21 }).ok, false, 'the superseded 1.2.0 (21) Play draft is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 22 }).ok, false, 'the superseded 1.2.0 (22), consumed in Play, is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 23 }).ok, false, 'the distributed 1.2.0 (23) is not the expected release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 24 }).ok, false, 'the built, never uploaded 1.2.1 (24) is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 25 }).ok, false, 'the built 1.2.2 (25) without the Guard Leave company selector is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 26 }).ok, false, 'the distributed-superseded 1.2.2 (26) without the Guard Profile redesign is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 27 }).ok, false, 'the distributed-superseded 1.2.3 (27) without UX-02 is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 28 }).ok, false, 'the distributed 1.2.4 (28) (uploaded, owner-stated 26 Nov 2026) is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionCode: 30 }).ok, false, 'nor the UAT app\'s 30');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.2.4' }).ok, false, 'the 1.2.4 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.2.3' }).ok, false, 'the 1.2.3 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.2.2' }).ok, false, 'the 1.2.2 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.2.1' }).ok, false, 'the 1.2.1 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.2.0' }).ok, false, 'the 1.2.0 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.1.0' }).ok, false, 'the 1.1.0 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.1.1' }).ok, false, 'the 1.1.1 name is not the prepared release');
  assert.equal(verifier.assessApk(config, { ...candidate, versionName: '1.1.2' }).ok, false, 'the 1.1.2 name is not the prepared release');
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
  // 1.1.1 (19) is distributed-superseded too (SIGNER-13H); 1.1.2 (20) is the distributed approved artefact (SIGNER-13I),
  // and the prepared, not built S4 1.2.0 (23) in front of it is the expected release (SIGNER-13J), past the superseded
  // 1.2.0 (21) Play draft (SIGNER-13K) and the consumed 1.2.0 (22) (SIGNER-13L).
  const vc19 = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 19);
  assert.ok(vc19, 'the 1.1.1 maintenance release 19 is recorded');
  assert.match(vc19.note, /808a55c/);
  // Owner correction (1 Nov 2026): 1.2.0 (23) was published to Play Internal Testing on 31 Oct 2026 and is the distributed
  // approved artefact (SIGNER-13M); 1.1.2 (20) is distributed-superseded (SIGNER-13I); 1.2.1 (24) was built, never uploaded
  // and is retired (SIGNER-13J). Owner-verified 15 Nov 2026: 1.2.2 (25) was uploaded on 11 Nov 2026 and is available to
  // internal testers, so it is the distributed approved artefact (SIGNER-13N) and 1.2.0 (23) is distributed-superseded
  // (SIGNER-13M); 1.2.2 (26) is built, not uploaded (SIGNER-13O).
  // 17 Nov 2026 (owner statement in the 1.2.3 release brief): 1.2.2 (26) is the active Play Internal Testing release, so
  // it is the distributed approved artefact (SIGNER-13O) and 1.2.2 (25) is distributed-superseded (SIGNER-13N); 1.2.3 (27)
  // is prepared, not built (SIGNER-13P). 17 Nov 2026: 27 was built (EAS 5bb7a0c2), not uploaded.
  // 21 Nov 2026 (owner statement): 1.2.3 (27) was uploaded by the owner and is the active Play Internal Testing release, so
  // it is the distributed approved artefact (SIGNER-13P) and 1.2.2 (26) is distributed-superseded (SIGNER-13O); 1.2.4 (28)
  // is prepared, not built (SIGNER-13Q). 21 Nov 2026: 28 was built (EAS e1866f5b), not uploaded.
  // 26 Nov 2026 (owner statement): 1.2.4 (28) was uploaded by the owner to Play Internal Testing and tested, so it is the
  // distributed approved artefact (SIGNER-13Q) and 1.2.3 (27) is distributed-superseded (SIGNER-13P); 1.3.0 (29) is
  // prepared, not built (SIGNER-13R).
  assert.equal(config.approvedArtefact.versionCode, 28);
  assert.equal(config.expectedRelease.versionCode, 29);
  assert.equal(config.expectedRelease.versionCode, config.preparedArtefact.versionCode);
  assert.equal(config.preparedArtefact.status, 'prepared-not-built', 'only the prepared, not built 1.3.0 (29) is in front of the distributed 1.2.4 (28)');
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

test('SIGNER-13H-THE-1-1-1-VC19-WAS-DISTRIBUTED-AND-IS-SUPERSEDED-BY-VC20-ON-THE-VC17-VC18-UPLOAD-KEY', () => {
  // Maintenance release (25 Oct 2026): 1.1.1 (19) carries the push-registration loop fix (808a55c on
  // fix/push-registration-loop). Built by EAS (b0506fbb) from 1a6c856 on owner approval and certified from the
  // downloaded AAB (26 Oct 2026). The owner uploaded it to Google Play Internal Testing (approved 26 Oct 2026) and
  // production push_devices shows Android devices on appVersion 1.1.1 (27 Oct 2026): it was the distributed build.
  // Superseded on 28 Oct 2026 by 1.1.2 (20) (SIGNER-13I); kept exactly, as vc18 was by vc19.
  const prepared = (config.retiredArtefacts || []).find((entry) => entry.versionCode === 19);
  const vc18 = config.retiredArtefacts.find((entry) => entry.versionCode === 18);
  const vc17 = config.retiredArtefacts.find((entry) => entry.versionCode === 17);
  const semver = (v) => v.split('.').map(Number);
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  assert.ok(prepared, 'versionCode 19 is recorded as superseded');
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 19).length, 1, 'recorded once');
  assert.equal(prepared.status, 'distributed-superseded', 'built, certified, distributed and now superseded');
  assert.equal(prepared.status, vc18.status, 'the same superseded status vc18 carries');
  assert.equal(prepared.retiredOn, '2026-10-28');
  assert.match(prepared.retiredReason, /^Superseded by versionCode 20 \(1\.1\.2\)/);
  assert.match(prepared.retiredReason, /bca5047/);
  assert.match(prepared.retiredReason, /Active in Google Play Internal Testing/);
  assert.notEqual(config.approvedArtefact.versionCode, 19, 'and it is no longer the approved artefact');
  assert.equal(prepared.versionName, '1.1.1');
  assert.equal(prepared.versionCode, 19);
  // The distributed 1.1.2 (20) is exactly one above it; the expected release (and app.json) is the prepared 1.2.0 (23),
  // past the consumed 21 and 22 (SIGNER-13K, 13L).
  assert.equal(prepared.versionCode + 1, config.retiredArtefacts.find((entry) => entry.versionCode === 20).versionCode, 'the artefact distributed next was 20 (itself superseded by 23)');
  assert.equal(prepared.versionCode + 10, config.expectedRelease.versionCode, 'the expected release is 29, after the consumed 21 and 22, the published 23, the built, never uploaded 24 and the distributed 25, 26, 27 and 28');
  assert.equal(prepared.versionCode + 10, appJson.expo.android.versionCode);
  assert.ok(above(appJson.expo.version, prepared.versionName), 'app.json carries a higher versionName than 1.1.1');
  assert.ok(prepared.versionCode > vc18.versionCode, 'above the distributed-superseded versionCode 18');
  assert.ok(above(prepared.versionName, vc18.versionName), 'and a higher versionName than 1.1.0');
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
  // Its distribution facts are kept exactly: the owner's upload (approved 26 Oct 2026) and the production devices that
  // reported 1.1.1, attributed and dated. The uploaded file's hash was not read back from Play, so none is claimed.
  const play = prepared.playInternalTesting;
  assert.ok(play, 'the Play state is kept');
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
  assert.doesNotMatch(prepared.note, /Not uploaded to Google Play/, 'never presented as not uploaded');
  // Play's active release history keeps the 1.1.1 (19) confirmation; the active release is now 1.1.2 (20).
  assert.match(config.playConsole.source, /active release 1\.1\.1 \(19\): owner uploaded to Play Internal Testing \(approved 26 Oct\); production devices report 1\.1\.1/);
  assert.notEqual(config.playConsole.internalTesting.activeRelease, '1.1.1 (19)', 'no longer Play\'s active release');
  // vc18 is kept exactly as the distributed-superseded build below it (SIGNER-13G).
  assert.equal(vc18.status, 'distributed-superseded');
  assert.equal(vc18.versionCode, 18);
  assert.equal(vc18.aabSha256, '936bfe7531dfd94fa4afc5006b7d6755ef5b9d07e8e3a21c0baa67dd6a4f4bc8');
  assert.deepEqual((config.retiredArtefacts || []).filter((entry) => entry.versionCode >= 20).map((entry) => [entry.versionCode, entry.status]), [[20, 'distributed-superseded'], [21, 'uploaded-draft-superseded'], [22, 'consumed-unreleased-superseded'], [23, 'distributed-superseded'], [24, 'built-not-uploaded-superseded'], [25, 'distributed-superseded'], [26, 'distributed-superseded'], [27, 'distributed-superseded']], 'retired at 20 or above: the distributed-superseded 20, 23, 25, 26 and 27, the never-released 21 and 22 and the never uploaded 24 (28 is distributed, owner-stated 26 Nov 2026)');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13I-THE-1-1-2-VC20-IS-DISTRIBUTED-AND-USES-THE-VC17-VC18-VC19-UPLOAD-KEY', () => {
  // Guard app 1.1.2 (28 Oct 2026): 1.1.2 (20) is the distributed 1.1.1 line (fix/push-registration-loop 00710f0) merged
  // into release/s4-pilot-rc1 bca5047 (merge f2baeb7 on release-prep/guard-app-1.1.2). Prepared in c45dce7, built by EAS
  // (8a1a4145) from exactly c45dce7 on owner approval and certified from the downloaded AAB (28 Oct 2026). The owner
  // uploaded it to Google Play Internal Testing, where it is Active and Play's active internal release "1.1.2 (20)"
  // (owner-confirmed 28 Oct 2026). No uploaded hash was read back from Play, so none is claimed; 1.1.1 (19) is superseded.
  // Owner correction (1 Nov 2026): superseded on 31 Oct 2026 by 1.2.0 (23), published to Play Internal Testing (SIGNER-13M);
  // the 1.1.2 (20) record moved, unchanged apart from status and retirement, into retiredArtefacts.
  assert.equal(config.preparedArtefact.status, 'prepared-not-built', 'the prepared, not built 1.3.0 (29) is in front of the distributed 1.2.4 (28); 1.2.0 (23), 1.2.1 (24), 1.2.2 (25), 1.2.2 (26) and 1.2.3 (27) are retired (SIGNER-13J, 13M, 13N, 13O, 13P, 13Q, 13R)');
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 20).length, 1, 'recorded once');
  const current = config.retiredArtefacts.find((entry) => entry.versionCode === 20);
  const vc19 = config.retiredArtefacts.find((entry) => entry.versionCode === 19);
  const vc18 = config.retiredArtefacts.find((entry) => entry.versionCode === 18);
  const vc17 = config.retiredArtefacts.find((entry) => entry.versionCode === 17);
  const semver = (v) => v.split('.').map(Number);
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  assert.ok(current, 'the 1.1.2 release is recorded');
  assert.equal(current.status, 'distributed-superseded', 'built, certified, distributed and now superseded');
  assert.equal(current.retiredOn, '2026-10-31');
  assert.match(current.retiredReason, /^Superseded by versionCode 23 \(1\.2\.0\), published to Google Play Internal Testing on 31 Oct 2026 \(owner-confirmed\)/);
  assert.match(current.retiredReason, /Active in Google Play Internal Testing \(owner-confirmed 28 Oct 2026\), so it can never be reused/);
  assert.equal(current.versionName, '1.1.2');
  assert.equal(current.versionCode, 20);
  // It stays the distributed approved artefact three below the prepared 1.2.0 (23) that app.json and the expected release
  // now carry (SIGNER-13J; 21 and 22 are consumed and never released, SIGNER-13K, 13L), and strictly above the superseded
  // build.
  // S4 1.2.2: now six below the built 1.2.2 (26) — 21 and 22 consumed, 23 published, 24 built and never uploaded, 25
  // uploaded and available to internal testers (owner-verified 15 Nov 2026).
  // S4 1.2.3: now seven below the prepared 1.2.3 (27) — 26 is distributed (owner-confirmed 17 Nov 2026).
  // S4 1.2.4: now eight below the prepared 1.2.4 (28) — 27 is distributed (owner-stated 21 Nov 2026).
  // S4 1.3.0: now nine below the prepared 1.3.0 (29) — 28 is distributed (owner-stated 26 Nov 2026).
  assert.equal(current.versionCode + 9, appJson.expo.android.versionCode);
  assert.equal(current.versionCode + 9, config.expectedRelease.versionCode);
  assert.equal(config.expectedRelease.versionName, appJson.expo.version);
  assert.ok(above(config.expectedRelease.versionName, current.versionName), 'the expected release is a higher versionName than 1.1.2');
  assert.ok(current.versionCode > vc19.versionCode, 'above the superseded versionCode 19');
  assert.ok(above(current.versionName, vc19.versionName), 'and a higher versionName than 1.1.1');
  assert.equal(current.sourceBranch, 'release-prep/guard-app-1.1.2');
  assert.equal(current.sourceFixCommit, 'f2baeb7fca0bb5af1bf657244f7fee6ef6598455');
  assert.ok(!('sourceCommit' in current), 'the exact gitCommit replaces the prose source description');
  // The certified build, unchanged by the upload: EAS id, source commit, AAB file, hash, size, certification date.
  assert.equal(current.easBuildId, '8a1a4145-94c8-443f-a25b-1d145abf3064');
  assert.equal(current.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/8a1a4145-94c8-443f-a25b-1d145abf3064');
  assert.equal(current.easBuildProfile, 'production');
  assert.equal(current.distribution, 'STORE');
  assert.equal(current.gitCommit, 'c45dce74109ed2efd0efcf6f5a766a07c10f0ecd');
  assert.equal(current.aabFilename, 's4-1.1.2-vc20-8a1a4145.aab');
  assert.equal(current.aabSha256, '4252cc986296c09f7f97df497dc6433829f0f8d15cb653af85f906d8c23f4c4e', 'the certified hash is unchanged');
  assert.equal(current.aabSizeBytes, 59135520);
  assert.equal(current.certifiedOn, '2026-10-28');
  // The same upload certificate as the distributed vc17, vc18 and vc19, in full: required, and read from the AAB.
  assert.equal(current.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(current.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 key');
  for (const earlier of [vc19, vc18, vc17]) {
    assert.equal(current.requiredUploadCertificateSha256, earlier.uploadCertificateSha256, `the vc${earlier.versionCode} upload key`);
    assert.equal(current.uploadCertificateSha256, earlier.uploadCertificateSha256, `signed as vc${earlier.versionCode}`);
    assert.notEqual(current.aabSha256, earlier.aabSha256, `a different artefact from vc${earlier.versionCode}`);
    assert.notEqual(current.easBuildId, earlier.easBuildId, `a different build from vc${earlier.versionCode}`);
  }
  assert.notEqual(current.gitCommit, vc19.gitCommit, 'built from a newer commit than vc19');
  const v = current.verified;
  assert.equal(v.signerCertificateSha256, S4_CERT_SHA256, 'full fingerprint read from the AAB signature');
  assert.equal(v.package, 'com.sfour.s4');
  assert.equal(v.versionCode, 20);
  assert.equal(v.versionName, '1.1.2');
  assert.match(v.signerCheck, /verify-apk-signer/);
  assert.equal(v.apiBaseUrl, 'https://security-marketplace-api.onrender.com');
  assert.equal(v.stagingApiUrls, 0);
  assert.match(v.guardInboxInBundle, /^yes/);
  assert.match(v.pushRegistrationFixInBundle, /^yes/);
  assert.match(v.timesheetHoursMinutesInBundle, /^yes/);
  assert.ok(!('apkSha256' in current) && !('completedAt' in current), 'an App Bundle, recorded as certified');
  // Distributed: owner-confirmed, Active, and Play's active internal release, exactly these facts and no more.
  const play = current.playInternalTesting;
  assert.ok(play, 'the Play state is recorded');
  assert.deepEqual(Object.keys(play).sort(), ['activeRelease', 'confirmedBy', 'confirmedOn', 'evidence', 'note', 'status'], 'the confirmed facts and nothing more');
  assert.equal(play.status, 'active');
  assert.equal(play.confirmedBy, 'owner');
  assert.equal(play.confirmedOn, '2026-10-28');
  assert.equal(play.activeRelease, '1.1.2 (20)');
  assert.equal(play.evidence, 'owner uploaded to Play Internal Testing; Play active internal release 1.1.2 (20)');
  assert.ok(!('uploadedAabSha256' in play), 'no uploaded hash is claimed that was not read back from Play');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.match(current.note, /Uploaded by the owner to Google Play Internal Testing and Active there \(owner-confirmed 28 Oct 2026\)/);
  assert.doesNotMatch(current.note, /Not uploaded to Google Play/, 'no longer presented as not uploaded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'Play now shows 1.2.4 (28) (owner-stated 26 Nov 2026)');
  assert.match(config.playConsole.source, /active release 1\.1\.2 \(20\): owner uploaded to Play Internal Testing, owner-confirmed 2026-10-28\. Not inspected from the build machine\.; active release 1\.2\.0 \(23\): published to Internal Testing 2026-10-31, owner-confirmed \(S4 did not upload it; rollout, testers and time not recorded\)\.; active release 1\.2\.2 \(25\): uploaded 2026-11-11 and available to internal testers, owner-verified from Play Console screenshots 2026-11-15 \(no versionCode 26 or higher\)\.; active release 1\.2\.2 \(26\): available to internal testers, owner-confirmed from a Play Console screenshot 2026-11-15 and restated 2026-11-17 \(S4 did not upload it; not inspected from the build machine\)\.; active release 1\.2\.3 \(27\): uploaded by the owner and the active Internal Testing release, owner-stated 2026-11-21 \(S4 did not upload it; no screenshot; upload date unknown; not inspected from the build machine\)\.; active release 1\.2\.4 \(28\): uploaded by the owner to Internal Testing and tested by the owner, owner-stated 2026-11-26 \(S4 did not upload it; no screenshot; upload date unknown; not inspected from the build machine\)\.$/);
  // vc19 is kept exactly as the distributed-superseded build below it (SIGNER-13H).
  assert.equal(vc19.status, 'distributed-superseded');
  assert.equal(vc19.aabSha256, '168c3f116ad84be0b41225ac5658b815968d7af5006e9ccd012e8a0363f731ca');
  assert.deepEqual((config.retiredArtefacts || []).filter((entry) => entry.versionCode >= 20).map((entry) => [entry.versionCode, entry.status]), [[20, 'distributed-superseded'], [21, 'uploaded-draft-superseded'], [22, 'consumed-unreleased-superseded'], [23, 'distributed-superseded'], [24, 'built-not-uploaded-superseded'], [25, 'distributed-superseded'], [26, 'distributed-superseded'], [27, 'distributed-superseded']], 'retired at 20 or above: the distributed-superseded 20, 23, 25, 26 and 27, the never-released 21 and 22 and the never uploaded 24 (28 is distributed, owner-stated 26 Nov 2026)');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13J-THE-1-2-1-VC24-IS-BUILT-NOT-UPLOADED-AND-SIGNED-BY-THE-SAME-UPLOAD-KEY', () => {
  // S4 1.2.1: 1.2.0 plus Package A (patrol correctness, Guard app plan refresh and visibility, dashboard patrol exception
  // actions) on feature/s4-1.2.1-patrol-correctness, on top of 625bea0 (the commit 1.2.0 (23) was built from). First
  // prepared only (no build fact, no Play state; sourceFixCommit 63b706a, the last 1.2.1 app-code commit). Owner update
  // (1 Nov 2026): built by EAS (85a98a03, production, STORE) from 5d749fa and verified — manifest com.sfour.s4 / 24 /
  // 1.2.1, both camera features required="false", permissions identical to 23, the permanent upload certificate — and NOT
  // uploaded (the owner uploads it manually to Internal Testing). It is the expected release, so the post-build check
  // accepts only 1.2.1 (24) signed by the permanent upload key.
  // History of this test: 1.2.0 (21) (29 Oct) was built from 4f4de31 and is superseded (SIGNER-13K); 1.2.0 (22) (31 Oct)
  // was built from 61526c9 and Play reports 22 as used (SIGNER-13L); 1.2.0 (23), the same content, was published to Play
  // Internal Testing on 31 Oct 2026 (SIGNER-13M).
  // 10 Nov 2026: 1.2.2 (25) is prepared (SIGNER-13N), so this exact build moves, unchanged, to retiredArtefacts as
  // built-not-uploaded-superseded: never uploaded to Play, never rebuilt with other content.
  assert.equal(config.retiredArtefacts.filter((entry) => entry.versionCode === 24).length, 1, 'vc24 is recorded once');
  const prepared = config.retiredArtefacts.find((entry) => entry.versionCode === 24);
  const current = config.approvedArtefact;
  const vc20 = config.retiredArtefacts.find((entry) => entry.versionCode === 20);
  assert.ok(prepared, 'the 1.2.1 release is recorded');
  assert.equal(prepared.status, 'built-not-uploaded-superseded');
  assert.equal(prepared.versionName, '1.2.1');
  assert.equal(prepared.versionCode, 24);
  assert.equal(prepared.retiredOn, '2026-11-10');
  assert.match(prepared.retiredReason, /^Superseded by versionCode 25 \(1\.2\.2\)/);
  assert.match(prepared.retiredReason, /never uploaded to Google Play/);
  // 15 Nov 2026: its successor 25 is the distributed artefact (owner-verified in Play Console; SIGNER-13N), below the built
  // 26 (SIGNER-13O). 24 itself never reached Google Play.
  // 17 Nov 2026: 25 is distributed-superseded by 26 (owner-confirmed), below the prepared 27.
  // 21 Nov 2026: 26 is distributed-superseded by 27 (owner-stated), below the prepared 28.
  // 26 Nov 2026: 27 is distributed-superseded by 28 (owner-stated), below the prepared 29.
  assert.equal(prepared.versionCode + 1, config.retiredArtefacts.find((entry) => entry.versionCode === 25).versionCode, 'its successor, the distributed (now superseded) 25');
  assert.equal(prepared.versionCode + 2, config.retiredArtefacts.find((entry) => entry.versionCode === 26).versionCode, 'then the distributed (now superseded) 26');
  assert.equal(prepared.versionCode + 3, config.retiredArtefacts.find((entry) => entry.versionCode === 27).versionCode, 'then the distributed (now superseded) 27');
  assert.equal(prepared.versionCode + 4, current.versionCode, 'then the distributed 28');
  assert.equal(prepared.versionCode + 5, appJson.expo.android.versionCode, 'app.json carries 29');
  assert.equal(prepared.versionCode + 5, config.expectedRelease.versionCode);
  assert.equal(prepared.versionCode + 5, config.preparedArtefact.versionCode);
  assert.equal(prepared.versionCode, config.retiredArtefacts.find((entry) => entry.versionCode === 23).versionCode + 1, 'one above the distributed-superseded 1.2.0 (23)');
  assert.equal(prepared.versionCode, vc20.versionCode + 4, 'four above 1.1.2 (20): 21 and 22 consumed in Play, 23 published');
  // Built and verified: exactly these facts.
  assert.equal(prepared.easBuildId, '85a98a03-f279-45f4-8e38-2dc730c95b3e');
  assert.equal(prepared.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/85a98a03-f279-45f4-8e38-2dc730c95b3e');
  assert.equal(prepared.gitCommit, '5d749fa1bd5797ff69fa16c4432ee13a2437b602');
  assert.equal(prepared.aabFilename, 's4-1.2.1-vc24-85a98a03.aab');
  assert.ok(prepared.aabFilename.includes(`vc${prepared.versionCode}-`), 'the file is named for its versionCode');
  assert.equal(prepared.aabSha256, '8a948d6b9b370bdded279454e0b16d085a9e9ca7cc9b62d6112e2f961d855a6a');
  assert.equal(prepared.aabSizeBytes, 64057635);
  assert.equal(prepared.certifiedOn, '2026-11-01');
  assert.equal(prepared.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(prepared.verified.signerCertificateSha256, S4_CERT_SHA256);
  assert.match(prepared.verified.cameraFeatures, /android\.hardware\.camera and android\.hardware\.camera\.autofocus declared android:required="false"/);
  assert.equal(prepared.verified.permissions, 'identical to 1.2.0 (23)');
  assert.ok(!('notReRead' in prepared.verified), 'every check was read');
  assert.deepEqual([prepared.verified.package, prepared.verified.versionCode, prepared.verified.versionName, prepared.verified.minSdkVersion, prepared.verified.targetSdkVersion],
    ['com.sfour.s4', 24, '1.2.1', 24, 36]);
  assert.deepEqual(prepared.verified.abis, ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
  assert.deepEqual([prepared.verified.apiBaseUrl, prepared.verified.productionApiUrls, prepared.verified.stagingApiUrls], ['https://security-marketplace-api.onrender.com', 1, 0]);
  assert.match(prepared.verified.patrolOutboxInBundle, /^yes/);
  assert.match(prepared.verified.servicesAndBackup, /s4_backup_rules \/ s4_data_extraction_rules, excluding SecureStore/);
  assert.match(prepared.verified.signerCheck, /keytool -printcert -jarfile/);
  for (const key of ['apkSha256', 'completedAt', 'playInternalTesting', 'sourceCommit']) {
    assert.ok(!(key in prepared), `the built, not uploaded 1.2.1 records no ${key}`);
  }
  for (const other of [current, ...config.retiredArtefacts.filter((entry) => entry !== prepared)]) {
    assert.notEqual(prepared.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(prepared.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  assert.equal(prepared.easBuildProfile, 'production');
  assert.equal(prepared.distribution, 'STORE');
  assert.equal(prepared.sourceBranch, 'feature/s4-1.2.1-patrol-correctness');
  assert.equal(prepared.sourceFixCommit, '63b706a1ed5ba9af5bf1526243ae0ce71ce3dcb0', 'the last 1.2.1 app-code commit');
  assert.equal(prepared.requiredUploadCertificateSha256, S4_CERT_SHA256, 'the permanent S4 upload key');
  assert.equal(prepared.requiredUploadCertificateSha256, vc20.uploadCertificateSha256, 'the same upload key as the certified 20');
  assert.equal(prepared.requiredUploadCertificateSha256, current.requiredUploadCertificateSha256, 'and as the distributed 25 requires');
  assert.match(prepared.note, /Not uploaded to Google Play: the owner will upload it manually to Internal Testing/);
  assert.match(prepared.note, /withOptionalCameraHardware, withPatrolBackupExclusion/, 'the plugins (optional camera hardware, backup exclusion) are kept');
  assert.match(prepared.note, /same upload key as vc17 to vc23/);
  assert.doesNotMatch(prepared.note, /Uploaded by the owner/);
  assert.equal(config.package, 'com.sfour.s4', 'the package is unchanged');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'Play shows the distributed 1.2.4 (28), never 24');
  assert.deepEqual((config.retiredArtefacts || []).filter((entry) => entry.versionCode >= 20).map((entry) => [entry.versionCode, entry.status]), [[20, 'distributed-superseded'], [21, 'uploaded-draft-superseded'], [22, 'consumed-unreleased-superseded'], [23, 'distributed-superseded'], [24, 'built-not-uploaded-superseded'], [25, 'distributed-superseded'], [26, 'distributed-superseded'], [27, 'distributed-superseded']], 'retired at 20 or above: the distributed-superseded 20, 23, 25, 26 and 27, the never-released 21 and 22 and the never uploaded 24 (28 is distributed, owner-stated 26 Nov 2026)');
});

test('SIGNER-13K-THE-BUILT-1-2-0-VC21-IS-A-SUPERSEDED-UNRELEASED-PLAY-DRAFT-ON-THE-SAME-UPLOAD-KEY', () => {
  // 31 Oct 2026: 1.2.0 (21), built by EAS (a9f475ad) from 4f4de31, was uploaded by the owner to Google Play as an
  // unpublished Internal Testing draft and NOT released. Play reported 436 devices (69 phone models) no longer supported:
  // the CAMERA permission with no <uses-feature> made Play imply android.hardware.camera(.autofocus) as required. Kept
  // exactly; versionCode 21 is consumed in Play and must never be reused, so the expected release is 22.
  const entries = (config.retiredArtefacts || []).filter((entry) => entry.versionCode === 21);
  assert.equal(entries.length, 1, 'recorded once');
  const vc21 = entries[0];
  const vc19 = config.retiredArtefacts.find((entry) => entry.versionCode === 19);
  assert.equal(vc21.versionName, '1.2.0');
  assert.equal(vc21.status, 'uploaded-draft-superseded');
  assert.equal(vc21.easBuildId, 'a9f475ad-690f-411d-bf16-3e37ead73274');
  assert.equal(vc21.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/a9f475ad-690f-411d-bf16-3e37ead73274');
  assert.equal(vc21.easBuildProfile, 'production');
  assert.equal(vc21.distribution, 'STORE');
  assert.equal(vc21.gitCommit, '4f4de31f5d00d04f953662662c4775e463d0bc3d');
  assert.equal(vc21.aabFilename, 's4-1.2.0-vc21-a9f475ad.aab');
  assert.ok(vc21.aabFilename.includes(`vc${vc21.versionCode}-`), 'the file is named for its versionCode');
  assert.equal(vc21.aabSha256, 'b057144fc92159065e6ec50d51397bd8ce2805e9ba71881181764d2719842ee0');
  assert.equal(vc21.aabSizeBytes, 64049992);
  assert.equal(vc21.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(vc21.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(vc21.uploadCertificateSha256, config.retiredArtefacts.find((entry) => entry.versionCode === 20).uploadCertificateSha256, 'the same upload key as the then-distributed 20');
  assert.equal(vc21.uploadCertificateSha256, vc19.uploadCertificateSha256, 'and as vc19');
  assert.equal(vc21.uploadCertificateSha256, config.approvedArtefact.requiredUploadCertificateSha256, 'the key the distributed 23 requires');
  assert.equal(vc21.uploadCertificateSha256, config.preparedArtefact.requiredUploadCertificateSha256, 'the key 24 must carry too');
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== vc21)]) {
    assert.notEqual(vc21.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(vc21.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Uploaded as a draft, never released: attributed to the owner, no active state, no uploaded hash claimed.
  const play = vc21.playInternalTesting;
  assert.equal(play.status, 'draft-not-released');
  assert.equal(play.confirmedBy, 'owner');
  assert.match(play.confirmedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!('uploadedAabSha256' in play) && !('activeRelease' in play), 'no hash read back and no active release claimed');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.match(play.note, /436 previously supported devices \(69 phone models\)/);
  assert.match(vc21.note, /unpublished Internal Testing DRAFT and NOT released/);
  assert.match(vc21.retiredReason, /^Superseded by versionCode 22 \(1\.2\.0\)/);
  assert.match(vc21.retiredReason, /436 devices \(69 phone models\)/);
  assert.match(vc21.retiredReason, /consumed there and must never be reused/);
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'never Play\'s active release (28 is, owner-stated 26 Nov 2026)');
  // The number line: distributed-superseded 20 < superseded draft 21 < consumed 22 (SIGNER-13L) < distributed-superseded 23,
  // published 31 Oct 2026 (SIGNER-13M) < never uploaded 24 < distributed 25 < built / expected 26 = app.json.
  assert.equal(vc21.versionCode, config.retiredArtefacts.find((entry) => entry.versionCode === 20).versionCode + 1);
  assert.equal(vc21.versionCode + 2, config.retiredArtefacts.find((entry) => entry.versionCode === 23).versionCode);
  // 17 Nov 2026: < distributed-superseded 25 < distributed 26 < prepared / expected 27 = app.json.
  // 21 Nov 2026: < distributed-superseded 26 < distributed 27 < prepared / expected 28 = app.json.
  // 26 Nov 2026: < distributed-superseded 27 < distributed 28 < prepared / expected 29 = app.json.
  assert.equal(vc21.versionCode + 7, config.approvedArtefact.versionCode);
  assert.equal(vc21.versionCode + 8, config.expectedRelease.versionCode);
  assert.equal(vc21.versionCode + 8, config.preparedArtefact.versionCode);
  assert.notEqual(appJson.expo.android.versionCode, vc21.versionCode, 'app.json never carries the consumed 21 again');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13L-THE-BUILT-1-2-0-VC22-IS-CONSUMED-IN-PLAY-NEVER-RELEASED-ON-THE-SAME-UPLOAD-KEY', () => {
  // 31 Oct 2026: 1.2.0 (22), 21 plus the optional camera hardware declarations, was built by EAS (e7ffa73a) from 61526c9
  // and NOT released. Play Console reports versionCode 22 as already used, while "Add from library" lists 14 to 21 only.
  // Kept exactly; 22 is consumed in Play and must never be reused, so the expected release is 23.
  const entries = (config.retiredArtefacts || []).filter((entry) => entry.versionCode === 22);
  assert.equal(entries.length, 1, 'recorded once');
  const vc22 = entries[0];
  const vc21 = config.retiredArtefacts.find((entry) => entry.versionCode === 21);
  assert.equal(vc22.versionName, '1.2.0');
  assert.equal(vc22.status, 'consumed-unreleased-superseded');
  assert.equal(vc22.easBuildId, 'e7ffa73a-9038-4cdc-88be-8671075d40b9');
  assert.equal(vc22.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/e7ffa73a-9038-4cdc-88be-8671075d40b9');
  assert.equal(vc22.easBuildProfile, 'production');
  assert.equal(vc22.distribution, 'STORE');
  assert.equal(vc22.gitCommit, '61526c972df25a0309517ced112215b12f32ce3d');
  assert.equal(vc22.aabFilename, 's4-1.2.0-vc22-e7ffa73a.aab');
  assert.ok(vc22.aabFilename.includes(`vc${vc22.versionCode}-`), 'the file is named for its versionCode');
  assert.equal(vc22.aabSha256, 'fd79784626c1a1d95ef30214c573fbdd17918e6f6b7e28b593f30a7f5c25a01e');
  assert.equal(vc22.aabSizeBytes, 64050088);
  assert.equal(vc22.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(vc22.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(vc22.uploadCertificateSha256, config.retiredArtefacts.find((entry) => entry.versionCode === 20).uploadCertificateSha256, 'the same upload key as the then-distributed 20');
  assert.equal(vc22.uploadCertificateSha256, vc21.uploadCertificateSha256, 'and as 21');
  assert.equal(vc22.uploadCertificateSha256, config.approvedArtefact.requiredUploadCertificateSha256, 'the key the distributed 23 requires');
  assert.equal(vc22.uploadCertificateSha256, config.preparedArtefact.requiredUploadCertificateSha256, 'the key 24 must carry too');
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== vc22)]) {
    assert.notEqual(vc22.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(vc22.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Consumed in Play, never released: attributed to the owner, no active state, no uploaded hash claimed.
  const play = vc22.playInternalTesting;
  assert.equal(play.status, 'consumed-not-in-library');
  assert.equal(play.confirmedBy, 'owner');
  assert.equal(play.confirmedOn, '2026-10-31');
  assert.ok(!('uploadedAabSha256' in play) && !('activeRelease' in play), 'no hash read back and no active release claimed');
  assert.match(play.note, /reports versionCode 22 as already used/);
  assert.match(play.note, /lists versionCodes 14 to 21 only/);
  assert.match(vc22.note, /NOT released/);
  assert.equal(vc22.retiredOn, '2026-10-31');
  assert.match(vc22.retiredReason, /^Superseded by versionCode 23 \(1\.2\.0\)/);
  assert.match(vc22.retiredReason, /consumed there and must never be reused/);
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'never Play\'s active release (28 is, owner-stated 26 Nov 2026)');
  // The number line: 21 < 22 < distributed-superseded 23, published 31 Oct 2026 (SIGNER-13M) < 24 < distributed 25 <
  // built / expected 26 = app.json.
  const vc23 = config.retiredArtefacts.find((entry) => entry.versionCode === 23);
  assert.equal(vc23.versionCode, vc22.versionCode + 1);
  assert.equal(vc22.versionCode, vc21.versionCode + 1);
  assert.equal(vc22.versionCode + 7, config.expectedRelease.versionCode, 'the prepared 29 (26 Nov 2026; 28 on 21 Nov 2026)');
  assert.equal(vc22.versionCode + 7, config.preparedArtefact.versionCode);
  assert.equal(vc23.sourceFixCommit, vc22.gitCommit, 'the published 23 sits on the commit 22 was built from');
  assert.notEqual(appJson.expo.android.versionCode, vc22.versionCode, 'app.json never carries the consumed 22 again');
  // vc21 is kept exactly as recorded.
  assert.equal(vc21.status, 'uploaded-draft-superseded');
  assert.equal(vc21.aabSha256, 'b057144fc92159065e6ec50d51397bd8ce2805e9ba71881181764d2719842ee0');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13M-THE-BUILT-1-2-0-VC23-WAS-PUBLISHED-TO-PLAY-INTERNAL-TESTING-AND-IS-SUPERSEDED-BY-25', () => {
  // 1.2.0 (23) was built by EAS (b5d6a189, production, STORE) from 625bea0. OWNER CORRECTION (1 Nov 2026): it WAS
  // published to Google Play Internal Testing on 31 Oct 2026 (the owner published it; S4 did not upload it), so versionCode
  // 23 is consumed in Play. Its exact build is kept; facts not known (uploaded hash, rollout, tester count, exact time, a
  // re-read signer) are stated as unknown, never invented.
  // 15 Nov 2026 (owner-verified from Play Console screenshots): 1.2.2 (25) was uploaded on 11 Nov 2026 and is available to
  // internal testers (SIGNER-13N), so 23 moved, unchanged apart from status and retirement, into retiredArtefacts as
  // distributed-superseded, superseded by 25 (24 in between was built and never uploaded; SIGNER-06F).
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 23).length, 1, 'recorded once, retired');
  const vc23 = config.retiredArtefacts.find((entry) => entry.versionCode === 23);
  const vc22 = config.retiredArtefacts.find((entry) => entry.versionCode === 22);
  const vc20 = config.retiredArtefacts.find((entry) => entry.versionCode === 20);
  assert.equal(vc23.versionCode, 23);
  assert.equal(vc23.versionName, '1.2.0');
  assert.equal(vc23.status, 'distributed-superseded');
  assert.equal(vc23.easBuildId, 'b5d6a189-6ad0-4530-b685-689c6115a674');
  assert.equal(vc23.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/b5d6a189-6ad0-4530-b685-689c6115a674');
  assert.equal(vc23.easBuildProfile, 'production');
  assert.equal(vc23.distribution, 'STORE');
  assert.equal(vc23.sourceBranch, 'fix/android-optional-camera-hardware');
  assert.equal(vc23.gitCommit, '625bea0b5e03d232e6c6ee9c2cfe874a4dcbbec4');
  assert.equal(vc23.aabFilename, 's4-1.2.0-vc23-b5d6a189.aab');
  assert.ok(vc23.aabFilename.includes(`vc${vc23.versionCode}-`), 'the file is named for its versionCode');
  assert.equal(vc23.aabSha256, 'eab6a4d55b1e1cb9c07b3b062364f07b803698572dd669a44ef4ac98e45567a3');
  assert.equal(vc23.aabSizeBytes, 64050099);
  assert.equal(vc23.requiredUploadCertificateSha256, S4_CERT_SHA256, 'built for the permanent S4 upload key');
  assert.equal(vc23.requiredUploadCertificateSha256, config.preparedArtefact.requiredUploadCertificateSha256, 'the key 26 carries too');
  // The EAS artefact was verified on 31 Oct 2026: the permanent S4 upload key, both camera features optional.
  assert.equal(vc23.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(vc23.certifiedOn, '2026-10-31');
  assert.deepEqual([vc23.verified.package, vc23.verified.versionCode, vc23.verified.versionName, vc23.verified.signerCertificateSha256], ['com.sfour.s4', 23, '1.2.0', S4_CERT_SHA256]);
  assert.match(vc23.verified.cameraFeatures, /android\.hardware\.camera and android\.hardware\.camera\.autofocus declared android:required="false"/);
  assert.equal(vc23.uploadCertificateSha256, vc20.uploadCertificateSha256, 'the same upload key as the certified 20');
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== vc23)]) {
    assert.notEqual(vc23.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(vc23.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Published: exactly the attributed Play facts, kept as recorded on 31 Oct / 1 Nov 2026.
  assert.deepEqual(Object.keys(vc23).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'one Play fact');
  const play = vc23.playInternalTesting;
  assert.deepEqual([play.status, play.confirmedBy, play.confirmedOn, play.publishedOn, play.activeRelease], ['active', 'owner', '2026-10-31', '2026-10-31', '1.2.0 (23)']);
  assert.equal(play.uploadedBy, 'owner (not S4)');
  assert.ok(!('uploadedAabSha256' in play), 'no uploaded hash is claimed that was not read back from Play');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.deepEqual(play.unknown, ['whether the uploaded file is byte-identical to the verified EAS artefact (the Play-side hash was not read back from Play Console)', 'rollout', 'tester count', 'exact publication time']);
  assert.match(vc23.note, /Whether the file the owner uploaded to Play is byte-identical to this artefact is not known/);
  assert.match(vc23.note, /Published to Google Play Internal Testing on 31 Oct 2026 \(owner-confirmed; S4 did not upload it\), so versionCode 23 is consumed in Play/);
  assert.doesNotMatch(JSON.stringify(vc23), /never uploaded|Not uploaded|not consumed|never reached Play/i, 'never described as not uploaded');
  // Superseded by the distributed 1.2.2 (25); no longer Play's active internal release.
  assert.equal(vc23.retiredOn, '2026-11-15');
  assert.match(vc23.retiredReason, /^Superseded by versionCode 25 \(1\.2\.2\), uploaded to Google Play Internal Testing on 11 Nov 2026 and available to internal testers \(owner-verified from Play Console, 15 Nov 2026\)/);
  assert.match(vc23.retiredReason, /so it can never be reused/);
  assert.deepEqual(supersededByProblems(config, vc23), [], '23 → 25 is fully recorded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'Play\'s active internal release is now 28 (owner-stated 26 Nov 2026)');
  // It superseded the distributed 1.1.2 (20).
  assert.equal(vc20.status, 'distributed-superseded');
  assert.match(vc20.retiredReason, /^Superseded by versionCode 23 \(1\.2\.0\)/);
  // The number line: 20 < 21 < 22 < published 23 < built, never uploaded 24 < distributed 25 < built, not uploaded /
  // expected 26 = app.json.
  assert.equal(vc23.versionCode, vc22.versionCode + 1);
  assert.equal(vc23.versionCode + 1, config.retiredArtefacts.find((entry) => entry.versionCode === 24).versionCode);
  // 17 Nov 2026: 25 distributed-superseded < distributed 26 < prepared / expected 27 = app.json.
  // 21 Nov 2026: 26 distributed-superseded < distributed 27 < prepared / expected 28 = app.json.
  // 26 Nov 2026: 27 distributed-superseded < distributed 28 < prepared / expected 29 = app.json.
  assert.equal(vc23.versionCode + 2, config.retiredArtefacts.find((entry) => entry.versionCode === 25).versionCode);
  assert.equal(vc23.versionCode + 3, config.retiredArtefacts.find((entry) => entry.versionCode === 26).versionCode);
  assert.equal(vc23.versionCode + 4, config.retiredArtefacts.find((entry) => entry.versionCode === 27).versionCode);
  assert.equal(vc23.versionCode + 5, config.approvedArtefact.versionCode);
  assert.equal(vc23.versionCode + 6, config.expectedRelease.versionCode);
  assert.equal(vc23.versionCode + 6, config.preparedArtefact.versionCode);
  assert.equal(vc23.versionCode + 6, appJson.expo.android.versionCode);
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13N-THE-1-2-2-VC25-WAS-UPLOADED-AND-IS-DISTRIBUTED-SUPERSEDED-BY-26-ON-THE-SAME-UPLOAD-KEY', () => {
  // S4 1.2.2 (25) was prepared on 10 Nov 2026 (release/s4-pilot-rc1 1251a8e plus the Guard Home UX-01 work and the Guard
  // Profile release patch, feature/s4-ux-01-guard-home, PR #116) and built by EAS (cb9581ba, production, STORE) from
  // 6fbd885 on 11 Nov 2026, then verified from the downloaded AAB: com.sfour.s4 / 25 / 1.2.2, the permanent upload key,
  // the production API only. S4 could not upload it; the verified AAB was handed to the owner. Its upload was first
  // recorded as unconfirmed (15 Nov 2026, built-upload-unconfirmed-superseded). The same day the owner verified it in Play
  // Console (screenshots): uploaded on 11 Nov 2026 and available to internal testers, with no versionCode 26 or higher.
  // So it was the distributed approved artefact; its exact build is kept, and the uploaded hash is stated as unread.
  // 17 Nov 2026 (owner statement in the 1.2.3 release brief): 1.2.2 (26) is the active Play Internal Testing release
  // (SIGNER-13O), so 25 moved, unchanged apart from status and retirement, into retiredArtefacts as distributed-superseded.
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 25).length, 1, 'recorded once, retired');
  const vc25 = config.retiredArtefacts.find((entry) => entry.versionCode === 25);
  const vc24 = config.retiredArtefacts.find((entry) => entry.versionCode === 24);
  assert.deepEqual([vc25.versionName, vc25.versionCode, vc25.status], ['1.2.2', 25, 'distributed-superseded']);
  assert.equal(vc25.easBuildId, 'cb9581ba-4644-4f1a-816c-e60cd41799b0');
  assert.equal(vc25.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/cb9581ba-4644-4f1a-816c-e60cd41799b0');
  assert.deepEqual([vc25.easBuildProfile, vc25.distribution, vc25.sourceBranch], ['production', 'STORE', 'feature/s4-ux-01-guard-home']);
  assert.equal(vc25.gitCommit, '6fbd885b6f5a79e0ceca3b533cecf4e7ad4dbaa3', 'built from the PR #116 head');
  assert.equal(vc25.sourceFixCommit, '395c3ec050a7b81b5da7f327da9d80a92e9dc7f8', 'the Guard Profile release patch');
  assert.equal(vc25.completedAt, '2026-11-11T11:22:41.681Z');
  assert.equal(vc25.aabFilename, 's4-1.2.2-vc25-cb9581ba.aab');
  assert.equal(vc25.aabSha256, '4106865210c0a523c1119657d8c7add757c1812d5260f406fa5b97ec56fa7189');
  assert.equal(vc25.aabSizeBytes, 64932035);
  assert.equal(vc25.certifiedOn, '2026-11-11');
  assert.equal(vc25.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(vc25.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(vc25.uploadCertificateSha256, vc24.uploadCertificateSha256, 'the key 24 was verified against');
  assert.deepEqual([vc25.verified.package, vc25.verified.versionCode, vc25.verified.versionName, vc25.verified.signerCertificateSha256], ['com.sfour.s4', 25, '1.2.2', S4_CERT_SHA256]);
  assert.deepEqual([vc25.verified.apiBaseUrl, vc25.verified.stagingApiUrls], ['https://security-marketplace-api.onrender.com', 0]);
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== vc25)]) {
    assert.notEqual(vc25.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(vc25.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Distributed: exactly the owner-verified Play facts of 15 Nov 2026, kept as recorded, the unknowns stated as such.
  assert.deepEqual(Object.keys(vc25).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'one Play fact');
  const play = vc25.playInternalTesting;
  assert.deepEqual([play.status, play.confirmedBy, play.confirmedOn, play.uploadedOn, play.activeRelease], ['active', 'owner', '2026-11-15', '2026-11-11', '1.2.2 (25)']);
  assert.equal(play.uploadedBy, 'owner (not S4)');
  assert.match(play.evidence, /^owner-verified Play Console screenshots \(15 Nov 2026\)/);
  assert.match(play.evidence, /no versionCode 26 or higher$/);
  assert.ok(!('uploadedAabSha256' in play), 'no uploaded hash is claimed that was not read back from Play');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.deepEqual(play.unknown, ['whether the uploaded file is byte-identical to the verified EAS artefact (the Play-side hash was not read back from Play Console)', 'rollout', 'tester count', 'exact upload time']);
  assert.match(vc25.note, /Owner-verified from Play Console screenshots on 15 Nov 2026: versionCode 25 was uploaded on 11 Nov 2026 and is available to internal testers/);
  assert.match(vc25.note, /does not contain SEC-001B Stage 2B/);
  assert.doesNotMatch(vc25.note, /Whether it was uploaded is not confirmed|Not uploaded to Google Play/, 'never presented as unconfirmed or not uploaded');
  assert.ok(!('unconfirmed' in config.playConsole), 'the unconfirmed note is resolved');
  // No artefact with an unconfirmed upload remains.
  assert.deepEqual(config.retiredArtefacts.filter((entry) => entry.status === 'built-upload-unconfirmed-superseded'), []);
  // Superseded by the distributed 1.2.2 (26); no longer Play's active internal release.
  assert.equal(vc25.retiredOn, '2026-11-17');
  assert.match(vc25.retiredReason, /^Superseded by versionCode 26 \(1\.2\.2\), available to Google Play internal testers and the active Internal Testing release \(owner-confirmed from a Play Console screenshot on 15 Nov 2026; restated 17 Nov 2026\)/);
  assert.match(vc25.retiredReason, /so it can never be reused/);
  assert.deepEqual(supersededByProblems(config, vc25), [], '25 → 26 is fully recorded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)');
  assert.equal(vc25.versionCode, vc24.versionCode + 1);
  // 21 Nov 2026: its successor 26 is itself distributed-superseded by 27 (SIGNER-13O, 13P), below the prepared 28.
  // 26 Nov 2026: 27 is distributed-superseded by 28 (SIGNER-13P, 13Q), below the prepared 29 (SIGNER-13R).
  assert.equal(vc25.versionCode + 1, config.retiredArtefacts.find((entry) => entry.versionCode === 26).versionCode);
  assert.equal(vc25.versionCode + 2, config.retiredArtefacts.find((entry) => entry.versionCode === 27).versionCode);
  assert.equal(vc25.versionCode + 3, config.approvedArtefact.versionCode);
  assert.equal(vc25.versionCode + 4, config.preparedArtefact.versionCode);
});

test('SIGNER-13O-THE-1-2-2-VC26-WAS-DISTRIBUTED-AND-IS-SUPERSEDED-BY-27-ON-THE-SAME-IDENTITY-AND-UPLOAD-KEY', () => {
  // S4 1.2.2 (26): the release candidate release-candidate/s4-1.2.2-sec001b-2b, b384c56 = production release/s4-pilot-rc1
  // 4bf731e (SEC-001B Stage 2B, the Guard Leave company selector) merged with PR #116 6fbd885 (Guard Home UX-01 and the
  // Guard Profile release patch), versioned in 6216b84 and merged into release/s4-pilot-rc1 (PR #122). 15 Nov 2026: the
  // owner verified Play Console (highest versionCode 25, nothing at 26 or above) and approved the build. Built by EAS
  // (ea0118ad, production, STORE) from exactly 6216b84 and verified from the downloaded AAB. S4 did not upload it.
  // The verified AAB was handed to the owner on 15 Nov 2026 (hash re-checked). The same day the owner confirmed from a
  // Google Play Console screenshot that versionCode 26 is available to internal testers (restated 17 Nov 2026), so 26 was
  // the distributed approved artefact. The screenshot image is not held in S4's records; the upload date, rollout, tester
  // count and the Play-side hash were not established, and nothing was read from Play by S4.
  // 21 Nov 2026 (owner statement): 1.2.3 (27) is uploaded and is the active Internal Testing release (SIGNER-13P), so 26
  // moved, unchanged apart from status and retirement, into retiredArtefacts as distributed-superseded.
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 26).length, 1, 'recorded once, retired');
  const current = config.retiredArtefacts.find((entry) => entry.versionCode === 26);
  assert.deepEqual([current.versionName, current.versionCode, current.status], ['1.2.2', 26, 'distributed-superseded']);
  assert.notEqual(config.approvedArtefact.versionCode, 26, 'no longer the approved artefact');
  assert.equal(current.versionCode, config.retiredArtefacts.find((entry) => entry.versionCode === 25).versionCode + 1, 'one above the distributed-superseded 25');
  assert.match(current.storeNumberCheck, /^Owner-verified from Play Console on 15 Nov 2026 \(screenshots\): the highest S4 versionCode was 25/);
  // The exact build, unchanged.
  assert.equal(current.easBuildId, 'ea0118ad-2d7d-4228-b132-df0f52534905');
  assert.equal(current.easBuildUrl, 'https://expo.dev/accounts/fahadjibran/projects/security-marketplace/builds/ea0118ad-2d7d-4228-b132-df0f52534905');
  assert.equal(current.gitCommit, '6216b8415eb2a18686b6da7ee207eb32c1ea4f3a', 'built from the merged release commit');
  assert.match(current.sourceGate, /43718282605/);
  assert.match(current.sourceGate, /43722028989/);
  assert.equal(current.completedAt, '2026-11-15T16:01:01.844Z');
  assert.equal(current.aabFilename, 's4-1.2.2-vc26-ea0118ad.aab');
  assert.equal(current.aabSha256, 'da2b75c13f485cc1274ff843e75e75c06e9bfa612daf00357b089d5ea6be0d65');
  assert.equal(current.aabSizeBytes, 64935676);
  assert.equal(current.certifiedOn, '2026-11-15');
  // Verified from the downloaded AAB: identity, signer, API and the three features.
  const v = current.verified;
  assert.deepEqual([v.package, v.versionCode, v.versionName, v.minSdkVersion, v.targetSdkVersion], ['com.sfour.s4', 26, '1.2.2', 24, 36]);
  assert.equal(current.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(v.signerCertificateSha256, S4_CERT_SHA256, 'read from the AAB signature');
  assert.match(v.signerCheck, /keytool -printcert -jarfile/);
  assert.deepEqual([v.apiBaseUrl, v.productionApiUrls, v.stagingApiUrls], ['https://security-marketplace-api.onrender.com', 1, 0]);
  assert.match(v.cameraFeatures, /android\.hardware\.camera and android\.hardware\.camera\.autofocus declared android:required="false"/);
  assert.match(v.featuresInBundle, /^yes: the Guard Leave company selector \(leave\/mine\/companies/);
  assert.match(v.featuresInBundle, /Guard Home on-duty Emergency bar \(UX-01\)/);
  assert.match(v.featuresInBundle, /Guard Profile save safety/);
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== current)]) {
    assert.notEqual(current.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(current.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Distributed, then superseded: exactly the owner-stated Play facts, kept as recorded; everything not stated is unknown.
  assert.deepEqual(Object.keys(current).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'one Play fact');
  const play = current.playInternalTesting;
  assert.deepEqual([play.status, play.confirmedBy, play.confirmedOn, play.reconfirmedOn, play.activeRelease, play.availableTo], ['active', 'owner', '2026-11-15', '2026-11-17', '1.2.2 (26)', 'internal testers']);
  assert.equal(play.uploadedBy, 'owner (not S4)');
  assert.ok(!('uploadedOn' in play) && !('publishedOn' in play), 'no upload date is claimed that was not established');
  assert.ok(!('uploadedAabSha256' in play), 'no uploaded hash is claimed that was not read back from Play');
  assert.match(play.evidence, /^owner-reported Google Play Console screenshot \(15 Nov 2026\): versionCode 26 available to internal testers/);
  assert.match(play.evidence, /The screenshot image is not held in S4's records\.$/, 'the screenshot is attributed to the owner, not claimed as seen');
  assert.deepEqual(play.unknown, ['whether the uploaded file is byte-identical to the verified EAS artefact (the handed-over copy matched it, but the Play-side hash was not read back from Play Console)', 'rollout', 'tester count', 'upload date and time']);
  assert.match(play.note, /hash was not read back from Play Console/);
  // The handover: the file the owner received was checked against the verified artefact.
  assert.deepEqual([current.ownerHandover.handedOverOn, current.ownerHandover.sha256, current.ownerHandover.sizeBytes], ['2026-11-15', current.aabSha256, current.aabSizeBytes]);
  assert.match(current.note, /Owner-confirmed on 15 Nov 2026 from a Google Play Console screenshot: versionCode 26 is available to internal testers/);
  assert.match(current.note, /The screenshot image is not held in S4's records/);
  assert.match(current.note, /Whether the file the owner uploaded to Play is byte-identical to this artefact is not known/);
  assert.match(current.note, /does not contain the Guard Profile redesign/);
  assert.doesNotMatch(current.note, /Not uploaded to Google Play/, 'never presented as not uploaded');
  // Superseded by the distributed 1.2.3 (27); no longer Play's active internal release.
  assert.equal(current.retiredOn, '2026-11-21');
  assert.match(current.retiredReason, /^Superseded by versionCode 27 \(1\.2\.3\), uploaded by the owner to Google Play Internal Testing and the active Internal Testing release \(owner statement, 21 Nov 2026; not screenshot-verified\)/);
  assert.match(current.retiredReason, /so it can never be reused/);
  assert.deepEqual(supersededByProblems(config, current), [], '26 → 27 is fully recorded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)');
  assert.deepEqual([current.easBuildProfile, current.distribution, current.sourceBranch], ['production', 'STORE', 'release-candidate/s4-1.2.2-sec001b-2b']);
  assert.equal(current.sourceFixCommit, '4bf731ef7c65fcdf470773cde322022204b675d9', 'the last app-code commit: the Stage 2B leave company selector');
  assert.match(current.sourceBase, /^b384c56 \(merge of production release\/s4-pilot-rc1 4bf731e, SEC-001B Stage 2B, and PR #116 6fbd885/);
  // The same identity, upload key, plugins, Expo project and API.
  assert.equal(config.package, 'com.sfour.s4');
  assert.equal(current.requiredUploadCertificateSha256, S4_CERT_SHA256, 'the permanent S4 upload key');
  assert.equal(current.uploadCertificateSha256, config.retiredArtefacts.find((entry) => entry.versionCode === 25).uploadCertificateSha256, 'the key the distributed 25 carries');
  assert.match(current.note, /withOptionalCameraHardware, withPatrolBackupExclusion/);
  assert.match(current.note, /the originals unchanged; nothing was generated or replaced/);
  // 26 Nov 2026: its successor 27 is itself distributed-superseded by 28 (SIGNER-13P, 13Q), below the prepared 29.
  assert.equal(current.versionCode + 1, config.retiredArtefacts.find((entry) => entry.versionCode === 27).versionCode);
  assert.equal(current.versionCode + 2, config.approvedArtefact.versionCode);
  assert.equal(current.versionCode + 3, config.preparedArtefact.versionCode);
});

test('SIGNER-13P-THE-1-2-3-VC27-WAS-DISTRIBUTED-AND-IS-SUPERSEDED-BY-28-ON-THE-SAME-IDENTITY-AND-UPLOAD-KEY', () => {
  // S4 1.2.3 (27), 17 Nov 2026: the distributed 1.2.2 (26) plus the Guard Profile redesign (PR #123, 2A to 2E), versioned
  // on release-prep/s4-1.2.3-android-27 and merged to release/s4-pilot-rc1 at 35b4f31 (PR #124). Prepared, then built the
  // same day (EAS 5bb7a0c2, owner-approved) after the owner verified in Play Console that 26 was the highest versionCode
  // (not inspected from the build machine). Verified from the downloaded AAB. S4 did not upload it.
  // 21 Nov 2026 (owner statement, answering S4 during the 1.2.4 (28) preparation): the owner uploaded the 5bb7a0c2 AAB to
  // Google Play Internal Testing and it is the active Internal Testing release, so 27 is the distributed approved
  // artefact. No screenshot was provided; the upload date, rollout, tester count and the Play-side hash are unknown, and
  // no handover hash check was recorded, so nothing about the uploaded file is claimed beyond the owner's statement.
  // 26 Nov 2026 (owner statement): 1.2.4 (28) is uploaded to Internal Testing and was tested by the owner (SIGNER-13Q), so
  // 27 moved, unchanged apart from status and retirement, into retiredArtefacts as distributed-superseded.
  assert.equal((config.retiredArtefacts || []).filter((entry) => entry.versionCode === 27).length, 1, 'recorded once, retired');
  const current = config.retiredArtefacts.find((entry) => entry.versionCode === 27);
  const vc26 = config.retiredArtefacts.find((entry) => entry.versionCode === 26);
  assert.deepEqual([current.versionName, current.versionCode, current.status], ['1.2.3', 27, 'distributed-superseded']);
  assert.notEqual(config.approvedArtefact.versionCode, 27, 'no longer the approved artefact');
  assert.equal(current.versionCode, Math.max(...config.retiredArtefacts.filter((entry) => entry !== current).map((entry) => entry.versionCode)) + 1, 'one above every other retired Android build');
  assert.equal(current.versionCode, vc26.versionCode + 1, 'one above the distributed-superseded 26');
  // The pre-build store check stays exactly as it was recorded for the build.
  assert.match(current.storeNumberCheck, /^Owner-verified in Google Play Console before this build \(stated in the S4 Android 1\.2\.3 \(27\) build approval, 17 Nov 2026\): versionCode 26 is the highest uploaded S4 build and no versionCode 27 or higher existed\. Not inspected from the build machine\.$/);
  // Built and certified from the downloaded AAB: the exact build, file, hash, size and signer, unchanged.
  assert.deepEqual([current.easBuildId, current.gitCommit, current.aabSha256, current.aabSizeBytes, current.aabFilename, current.certifiedOn],
    ['5bb7a0c2-4f4b-4418-91e4-bc2d69a3e03e', '35b4f31c275f5ba850644d81c2164d9819435a35', '0042eaa12a12d740307c6420fe47f4bd2e6034e144c121e58baaf6c042162198', 64957526, 's4-1.2.3-vc27-5bb7a0c2.aab', '2026-11-17']);
  assert.ok(current.easBuildUrl.endsWith('/builds/5bb7a0c2-4f4b-4418-91e4-bc2d69a3e03e'));
  assert.equal(current.completedAt, '2026-11-17T16:39:18.812Z');
  assert.ok(!('apkSha256' in current), 'an App Bundle');
  assert.deepEqual([current.verified.package, current.verified.versionCode, current.verified.versionName, current.verified.minSdkVersion, current.verified.targetSdkVersion], ['com.sfour.s4', 27, '1.2.3', 24, 36]);
  assert.deepEqual([current.uploadCertificateSha256, current.verified.signerCertificateSha256], [S4_CERT_SHA256, S4_CERT_SHA256], 'signed with the permanent S4 upload key');
  assert.deepEqual([current.verified.apiBaseUrl, current.verified.productionApiUrls, current.verified.stagingApiUrls], ['https://security-marketplace-api.onrender.com', 1, 0], 'the production API only');
  assert.match(current.verified.featuresInBundle, /^yes: the Guard Profile redesign \("Your optional S4 screening summary"/);
  assert.match(current.verified.featuresInBundle, /none of which is in 1\.2\.2 \(26\)/);
  assert.equal(current.verified.sessionStorageKey, 'security-app-session (unchanged)');
  assert.match(current.sourceGate, /44107508143 \(PR #124\) and 44121591228 \(push to release\/s4-pilot-rc1\), both passed on this exact commit/);
  assert.match(current.releaseBranch, /^release\/s4-pilot-rc1 \(35b4f31 since PR #124 was merged on 17 Nov 2026\)/);
  for (const other of [config.approvedArtefact, ...config.retiredArtefacts.filter((entry) => entry !== current)]) {
    assert.notEqual(current.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(current.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  // Superseded by the distributed 1.2.4 (28); no longer Play's active internal release.
  assert.equal(current.retiredOn, '2026-11-26');
  assert.match(current.retiredReason, /^Superseded by versionCode 28 \(1\.2\.4\), uploaded by the owner to Google Play Internal Testing and tested by the owner \(owner statement, 26 Nov 2026; not screenshot-verified\)/);
  assert.match(current.retiredReason, /so it can never be reused/);
  assert.deepEqual(supersededByProblems(config, current), [], '27 → 28 is fully recorded');
  // Distributed, then superseded: exactly the owner-stated Play facts, kept as recorded; everything not stated is unknown.
  assert.deepEqual(Object.keys(current).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'one Play fact');
  const play = current.playInternalTesting;
  assert.deepEqual(Object.keys(play).sort(), ['activeRelease', 'confirmedBy', 'confirmedOn', 'evidence', 'note', 'status', 'unknown', 'uploadedBy'], 'the stated facts and nothing more');
  assert.deepEqual([play.status, play.confirmedBy, play.confirmedOn, play.activeRelease, play.uploadedBy], ['active', 'owner', '2026-11-21', '1.2.3 (27)', 'owner (not S4)']);
  assert.match(play.evidence, /^owner statement in chat \(21 Nov 2026, answering S4 during the 1\.2\.4 \(28\) preparation\)/);
  assert.match(play.evidence, /No screenshot\.$/, 'no screenshot is claimed');
  assert.deepEqual(play.unknown, ['whether the uploaded file is byte-identical to the verified EAS artefact (no handover hash check was recorded and the Play-side hash was not read back from Play Console)', 'rollout', 'tester count', 'upload date and time']);
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.ok(!('ownerHandover' in current), 'no handover was recorded for 27, so none is claimed');
  assert.match(current.note, /S4 did not upload it \(the build machine has no Play developer account\)\. Owner-stated on 21 Nov 2026: 1\.2\.3 \(27\) was uploaded by the owner to Google Play Internal Testing and is the active internal release/);
  assert.match(current.note, /No screenshot was provided, the upload date is unknown and the Play-side hash was not read back/);
  assert.match(current.note, /the signing material was staged as temporary copies for the EAS upload and deleted afterwards, the originals unchanged; nothing was generated or replaced/);
  assert.doesNotMatch(current.note, /Not uploaded to Google Play/, 'no longer presented as not uploaded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'Play\'s active internal release is now 28 (27 until 26 Nov 2026)');
  assert.deepEqual([current.easBuildProfile, current.distribution, current.sourceBranch], ['production', 'STORE', 'release-prep/s4-1.2.3-android-27']);
  assert.equal(current.sourceFixCommit, '187e61f6aa67901f5521709d02afc78a10756ef5', 'the Guard Profile redesign on release/s4-pilot-rc1');
  assert.match(current.sourceBase, /^187e61f \(release\/s4-pilot-rc1 after PR #123/);
  // The same identity, upload key, plugins, Expo project, API and session storage key.
  assert.equal(config.package, 'com.sfour.s4');
  assert.equal(current.requiredUploadCertificateSha256, S4_CERT_SHA256, 'the permanent S4 upload key');
  assert.equal(current.requiredUploadCertificateSha256, vc26.uploadCertificateSha256, 'the key the distributed-superseded 26 carries');
  assert.match(current.note, /withOptionalCameraHardware, withPatrolBackupExclusion/);
  assert.match(current.note, /unchanged session storage key security-app-session/);
  assert.equal(current.versionCode + 1, config.approvedArtefact.versionCode);
  assert.equal(current.versionCode + 2, config.preparedArtefact.versionCode);
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13Q-THE-1-2-4-VC28-IS-THE-DISTRIBUTED-ARTEFACT-ON-THE-SAME-IDENTITY-AND-UPLOAD-KEY', () => {
  // S4 1.2.4 (28), 21 Nov 2026: the distributed 1.2.3 (27) plus UX-02 Packages A and B (PR #125, merged to
  // release/s4-pilot-rc1 at 9b56ef2 on 20 Nov 2026 by fast-forward), versioned on release-prep/s4-1.2.4-android-28.
  // Prepared, not built: no EAS build, file, hash or store fact exists, and none is recorded. Play Console is not readable
  // from the build machine, so the absence of a versionCode 28 or higher in Play is NOT verified; the record says so, and
  // the owner must confirm it before a build. Later on 21 Nov 2026 PR #126 was merged (release/s4-pilot-rc1 b45ffc3), the
  // owner verified in Play Console that 27 was the highest versionCode (not inspected from the build machine) and 28 was
  // built from b45ffc3 (EAS e1866f5b, owner-approved). Verified from the downloaded AAB; not uploaded by S4.
  // 26 Nov 2026 (owner statement, in the S4 1.3.0 version brief): the owner uploaded it to Google Play Internal Testing
  // and tested it, so 28 is the distributed approved artefact (its build facts unchanged) and 27 is distributed-superseded
  // (SIGNER-13P). No screenshot; the upload date, rollout, tester count and the Play-side hash are unknown, and no handover
  // hash check is recorded, so nothing about the uploaded file is claimed beyond the owner's statement. EAS (read the same
  // day) holds no Android build above 28. app.json moved on to 1.3.0 (29) (SIGNER-13R).
  // (The variable keeps its historical name: this record was the prepared artefact until 26 Nov 2026.)
  const prepared = config.approvedArtefact;
  const current = config.retiredArtefacts.find((entry) => entry.versionCode === 27);
  assert.deepEqual([prepared.versionName, prepared.versionCode, prepared.status], ['1.2.4', 28, 'distributed']);
  assert.equal(config.retiredArtefacts.filter((entry) => entry.versionCode === 28).length, 0, 'not a retired record');
  assert.ok(appJson.expo.android.versionCode > prepared.versionCode, 'app.json is above 28 (uploaded, owner-stated 26 Nov 2026)');
  assert.ok(config.expectedRelease.versionCode > prepared.versionCode, 'the post-build check no longer expects 28');
  assert.equal(prepared.versionCode, Math.max(...config.retiredArtefacts.map((entry) => entry.versionCode)) + 1, 'one above every retired Android build');
  assert.equal(prepared.versionCode, current.versionCode + 1, 'one above the distributed-superseded 27');
  assert.match(prepared.storeNumberCheck, /^Owner-verified in Google Play Console before this build \(stated in the S4 Android 1\.2\.4 \(28\) build approval, 21 Nov 2026\): versionCode 27 is the highest uploaded S4 build and no versionCode 28 or higher existed\. Not inspected from the build machine\.$/);
  // Built and certified from the downloaded AAB: the exact build, file, hash, size and signer.
  assert.deepEqual([prepared.easBuildId, prepared.gitCommit, prepared.aabSha256, prepared.aabSizeBytes, prepared.aabFilename, prepared.certifiedOn],
    ['e1866f5b-150c-43dd-b883-1c676e5960b7', 'b45ffc32a1dd56008332652eb4d12958b750c05d', '3a32f3bcba111020a54806bc9b272e677c6a7a3fa9b6513c66b630dfc5e12a6f', 64958717, 's4-1.2.4-vc28-e1866f5b.aab', '2026-11-21']);
  assert.ok(prepared.easBuildUrl.endsWith('/builds/e1866f5b-150c-43dd-b883-1c676e5960b7'));
  assert.equal(prepared.completedAt, '2026-11-21T01:21:57.315Z');
  assert.ok(!('apkSha256' in prepared), 'an App Bundle');
  assert.deepEqual([prepared.verified.package, prepared.verified.versionCode, prepared.verified.versionName, prepared.verified.minSdkVersion, prepared.verified.targetSdkVersion], ['com.sfour.s4', 28, '1.2.4', 24, 36]);
  assert.deepEqual([prepared.uploadCertificateSha256, prepared.verified.signerCertificateSha256], [S4_CERT_SHA256, S4_CERT_SHA256], 'signed with the permanent S4 upload key');
  assert.deepEqual([prepared.verified.apiBaseUrl, prepared.verified.productionApiUrls, prepared.verified.stagingApiUrls], ['https://security-marketplace-api.onrender.com', 1, 0], 'the production API only');
  assert.match(prepared.verified.embeddedConfig, /no extra\.appVariant \(the store app; the UAT label constant is inert\)/);
  assert.match(prepared.verified.featuresInBundle, /^yes: UX-02 Packages A and B \("Status recorded · expiry date needed"/);
  assert.match(prepared.verified.featuresInBundle, /14 of which are not in 1\.2\.3 \(27\)/);
  assert.equal(prepared.verified.sessionStorageKey, 'security-app-session (unchanged)');
  assert.notEqual(prepared.aabSha256, current.aabSha256, 'a new artefact, not 27');
  for (const other of config.retiredArtefacts) {
    assert.notEqual(prepared.aabSha256, other.aabSha256, `a different artefact from vc${other.versionCode}`);
    assert.notEqual(prepared.easBuildId, other.easBuildId, `a different build from vc${other.versionCode}`);
  }
  assert.ok(!('retiredOn' in prepared) && !('retiredReason' in prepared), 'the distributed artefact is not retired');
  assert.match(prepared.sourceGate, /44845700527 \(PR #126\) and 44847132116 \(push to release\/s4-pilot-rc1\), both passed on this exact commit/);
  assert.match(prepared.releaseBranch, /^release\/s4-pilot-rc1 \(b45ffc3 since PR #126 was merged on 21 Nov 2026\)/);
  // Distributed: exactly the owner-stated Play facts; everything not stated is unknown, never invented.
  assert.deepEqual(Object.keys(prepared).filter((key) => /^play|internalTesting|uploaded|handover/i.test(key)), ['playInternalTesting'], 'one Play fact, no handover');
  const play = prepared.playInternalTesting;
  assert.deepEqual(Object.keys(play).sort(), ['activeRelease', 'confirmedBy', 'confirmedOn', 'evidence', 'note', 'status', 'testedBy', 'unknown', 'uploadedBy'], 'the stated facts and nothing more');
  assert.deepEqual([play.status, play.confirmedBy, play.confirmedOn, play.activeRelease, play.uploadedBy, play.testedBy], ['active', 'owner', '2026-11-26', '1.2.4 (28)', 'owner (not S4)', 'owner']);
  assert.match(play.evidence, /^owner statement \(26 Nov 2026, in the S4 1\.3\.0 version brief\): the e1866f5b AAB \(1\.2\.4, 28\) was uploaded to Google Play Internal Testing and tested by the owner\. No screenshot\./);
  assert.match(play.evidence, /EAS \(read on 26 Nov 2026\) holds no Android build above 28\.$/);
  assert.deepEqual(play.unknown, ['whether the uploaded file is byte-identical to the verified EAS artefact (no handover hash check is recorded here and the Play-side hash was not read back from Play Console)', 'rollout', 'tester count', 'upload date and time']);
  assert.ok(!('uploadedOn' in play) && !('uploadedAabSha256' in play), 'no upload date or uploaded hash is invented');
  assert.match(play.note, /hash was not read back from Play Console/);
  assert.match(prepared.note, /the signing material was staged as temporary copies for the EAS upload and deleted afterwards, the originals unchanged; nothing was generated or replaced/);
  assert.match(prepared.note, /S4 did not upload it \(the build machine has no Play developer account\)\. Owner-stated on 26 Nov 2026: 1\.2\.4 \(28\) was uploaded by the owner to Google Play Internal Testing and tested by the owner/);
  assert.match(prepared.note, /No screenshot was provided, the upload date is unknown and the Play-side hash was not read back/);
  assert.doesNotMatch(prepared.note, /Not uploaded to Google Play/, 'no longer presented as not uploaded');
  assert.equal(config.playConsole.internalTesting.activeRelease, '1.2.4 (28)', 'Play\'s active internal release');
  assert.match(prepared.note, /UX-02 Packages A and B \(PR #125, merged 20 Nov 2026\)/);
  assert.deepEqual([prepared.easBuildProfile, prepared.distribution, prepared.sourceBranch], ['production', 'STORE', 'release-prep/s4-1.2.4-android-28']);
  assert.equal(prepared.sourceFixCommit, '9b56ef2f1f339e16a41697ca634056e866aa11e7', 'UX-02 on release/s4-pilot-rc1');
  assert.match(prepared.sourceBase, /^9b56ef2 \(release\/s4-pilot-rc1 after PR #125/);
  // An in-place update: the same identity, upload key, plugins, Expo project, API and session storage key.
  assert.equal(config.package, 'com.sfour.s4');
  assert.equal(appJson.expo.android.package, 'com.sfour.s4');
  assert.equal(appJson.expo.ios.bundleIdentifier, 'com.sfour.s4');
  assert.equal(prepared.requiredUploadCertificateSha256, S4_CERT_SHA256, 'the permanent S4 upload key');
  assert.equal(prepared.requiredUploadCertificateSha256, current.uploadCertificateSha256, 'the key the distributed-superseded 27 carries');
  assert.equal(easJson.build.production.android.credentialsSource, 'local', 'the store profile signs with the local permanent key');
  assert.match(prepared.note, /withOptionalCameraHardware, withPatrolBackupExclusion/);
  assert.match(prepared.note, /unchanged session storage key security-app-session/);
  assert.equal(easJson.build.production.env.EXPO_PUBLIC_API_URL, 'https://security-marketplace-api.onrender.com');
  assert.equal(appJson.expo.extra.eas.projectId, 'c786f15c-7d60-4122-9001-02cabbb7692b', 'the existing Expo project');
  assert.equal(current.status, 'distributed-superseded');
  assert.equal(prepared.versionCode + 1, config.preparedArtefact.versionCode, 'only the prepared 1.3.0 (29) is in front of it');
  assert.doesNotMatch(JSON.stringify(config), /private_key|api_key|current_key|BEGIN [A-Z ]*PRIVATE KEY/);
});

test('SIGNER-13R-THE-1-3-0-VC29-IS-PREPARED-NOT-BUILT-ON-THE-SAME-IDENTITY-AND-UPLOAD-KEY', () => {
  // S4 1.3.0 (29), 26 Nov 2026: the integrated 1.3.0 release candidate 5bdfdd2 (integration/s4-1.3.0: EM-01 two-tap
  // Emergency PR #129, dependency security #130, multi-tab refresh #131, Platform Admin MFA #132, company staff management
  // #133, account deletion #134), versioned on release/s4-1.3.0-version. Prepared, not built: no EAS build, file, hash or
  // store fact exists, and none is recorded. The owner stated the same day that 28 is uploaded to Internal Testing, and EAS
  // holds no Android build above 28; Play Console is not readable from the build machine, so the absence of a versionCode
  // 29 or higher in Play is NOT verified. The record says so, and the owner must confirm it before a build.
  const prepared = config.preparedArtefact;
  const current = config.approvedArtefact;
  assert.deepEqual([prepared.versionName, prepared.versionCode, prepared.status], ['1.3.0', 29, 'prepared-not-built']);
  assert.deepEqual([prepared.versionName, prepared.versionCode], [appJson.expo.version, appJson.expo.android.versionCode], 'app.json carries 1.3.0 (29)');
  assert.deepEqual([config.expectedRelease.versionName, config.expectedRelease.versionCode, config.expectedRelease.minSdkVersion], ['1.3.0', 29, 24], 'the post-build check expects 1.3.0 (29)');
  assert.equal(prepared.versionCode, Math.max(current.versionCode, ...config.retiredArtefacts.map((entry) => entry.versionCode)) + 1, 'one above every Android build');
  assert.equal(prepared.versionCode, current.versionCode + 1, 'one above the distributed 28');
  assert.ok(prepared.versionCode > 28, 'above 28 (uploaded, owner-stated 26 Nov 2026)');
  assert.match(prepared.storeNumberCheck, /^NOT VERIFIED from Play Console\. The owner stated on 26 Nov 2026 that 1\.2\.4 \(28\) is uploaded to Google Play Internal Testing; EAS \(read 26 Nov 2026\) holds no Android build above 28\./);
  assert.match(prepared.storeNumberCheck, /The owner must confirm it before 29 is built\.$/);
  for (const key of ['easBuildId', 'easBuildUrl', 'aabSha256', 'aabFilename', 'aabSizeBytes', 'gitCommit', 'certifiedOn', 'verified', 'uploadCertificateSha256', 'completedAt', 'apkSha256']) {
    assert.ok(!(key in prepared), `prepared, not built: no ${key}`);
  }
  assert.deepEqual(Object.keys(prepared).filter((key) => /^play|internalTesting|uploaded|handover/i.test(key)), [], 'no Play fact');
  assert.match(prepared.note, /Prepared, not built: no EAS build, file, hash, upload or store fact yet\. Not uploaded to Google Play\./);
  assert.deepEqual([prepared.easBuildProfile, prepared.distribution, prepared.sourceBranch], ['production', 'STORE', 'release/s4-1.3.0-version']);
  assert.equal(prepared.sourceFixCommit, '5bdfdd24d78ae464167c101a9b4193ef7daae5ea', 'the integrated 1.3.0 release candidate');
  assert.match(prepared.sourceBase, /^5bdfdd2 \(integration\/s4-1\.3\.0: production a700c20 plus EM-01 two-tap Emergency PR #129/);
  // An in-place update: the same identity, upload key, plugins, Expo project, API and session storage key.
  assert.equal(config.package, 'com.sfour.s4');
  assert.equal(appJson.expo.android.package, 'com.sfour.s4');
  assert.equal(appJson.expo.ios.bundleIdentifier, 'com.sfour.s4');
  assert.equal(prepared.requiredUploadCertificateSha256, S4_CERT_SHA256, 'the permanent S4 upload key');
  assert.equal(prepared.requiredUploadCertificateSha256, current.uploadCertificateSha256, 'the key the distributed 28 carries');
  assert.equal(easJson.build.production.android.credentialsSource, 'local', 'the store profile signs with the local permanent key');
  assert.match(prepared.note, /withOptionalCameraHardware, withPatrolBackupExclusion/);
  assert.match(prepared.note, /unchanged session storage key security-app-session/);
  assert.equal(easJson.build.production.env.EXPO_PUBLIC_API_URL, 'https://security-marketplace-api.onrender.com');
  assert.equal(appJson.expo.extra.eas.projectId, 'c786f15c-7d60-4122-9001-02cabbb7692b', 'the existing Expo project');
  assert.equal(current.status, 'distributed');
  // The UAT app keeps its own number strictly above the store app (configuration only; no UAT app is built).
  assert.equal(easJson.build.uat.env.UAT_ANDROID_VERSION_CODE, '30');
  assert.ok(Number(easJson.build.uat.env.UAT_ANDROID_VERSION_CODE) > prepared.versionCode);
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
