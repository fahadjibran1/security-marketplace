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

test('BUILD-01-APP-VERSION-IS-1-1-2-AND-ANDROID-BUILD-20', () => {
  // Guard app 1.1.2 (28 Oct 2026, prepared, not built): S4 1.1.2 / 20 is the 1.1.1 line merged with release/s4-pilot-rc1
  // bca5047 (Guard timesheet UX). 1.1.1 / 19 is distributed in Google Play Internal Testing and stays so until 20 is built.
  // Maintenance release (25 Oct 2026): S4 1.1.1 / 19 adds the push-registration loop fix (808a55c) over 1.1.0 / 18, which
  // is Active in Google Play Internal Testing (owner-confirmed 25 Oct 2026) and stays distributed until 19 is built.
  // Guard notifications update (25 Oct 2026): S4 1.1.0 / 18 adds the Guard notifications inbox (PR #34) over 1.1.0 / 17,
  // which is in Google Play Internal Testing (owner-confirmed 24 Oct 2026).
  // Welfare Check push update (23 Oct 2026): S4 1.1.0 / 17 adds Welfare Check push notifications over the built 1.1.0 / 16.
  // Pilot update (23 Oct 2026): S4 1.1.0 / 16 supersedes the 20 Oct Guard release 1.1.0 / 15 on the same identity.
  // Guard release (20 Oct 2026): S4 1.1.0 / 15 carries the Guard shift-offer fix and supersedes 1.1.0 / 14, which
  // is active in Google Play Internal Testing (owner-confirmed 20 Oct 2026). Phase 4E: S4 1.1.0 / 14 was the Google Play Internal Testing candidate. Gate 4A's 1.1.0 / 13 was the
  // first permanent-identity candidate (com.sfour.s4); it is retired because it predates Dashboard V2. It is a new
  // Android package, so nothing installs over anything — but the code keeps climbing, so every S4
  // artefact ever produced carries a distinct, increasing number. The development-package history:
  assert.equal(appJson.expo.version, '1.1.2');
  assert.equal(appJson.expo.android.versionCode, 20, 'the Guard app 1.1.2 candidate');
  assert.ok(appJson.expo.android.versionCode > 19, 'above the distributed push-registration fix maintenance release 19');
  assert.ok(appJson.expo.android.versionCode > 18, 'above the distributed Guard notifications update 18');
  assert.ok(appJson.expo.android.versionCode > 17, 'above the distributed Welfare Check push release 17');
  assert.ok(appJson.expo.android.versionCode > 16, 'above the built pilot update 16');
  assert.ok(appJson.expo.android.versionCode > 15, 'above the superseded Guard release 15');
  assert.ok(appJson.expo.android.versionCode > 14, 'above the superseded RC14');
  assert.ok(appJson.expo.android.versionCode > 13, 'above the retired first permanent-identity candidate 13');
  assert.ok(appJson.expo.android.versionCode > 12, 'above the final development-package Build 12');
  // Build 12 is the full operational UAT candidate: Phase 1 (scheduled times as true instants),
  // Phase 2 (action forms on a real modal), Phase 3A (Live Operations in site time, shift welfare
  // override), 3A-iii (actions actually reach the API), 3B (Live Operations stays operationally current,
  // Shift Offers in site time), 3C (one canonical action model) and 3D (the Guard reads the backend's
  // own welfare verdict).
  //
  // The lineage this number has to clear:
  //   5  the 1.0.4 installed on the pilot device
  //   8  rejected for distribution — EAS-generated signing identity, could not update an S4 build
  //   9  first distributable pilot build
  //  10  Phase 1 only; verified and signed, but never installed
  //  11  Phase 1 + Phase 2; verified and signed, UAT found the Phase 3 defects
  //  12  final com.securitymarketplace.mobile build (Phase 1 through Phase 3D)
  assert.ok(appJson.expo.android.versionCode > 11, 'above Build 11');
  assert.ok(appJson.expo.android.versionCode > 10, 'above the Phase-1-only Build 10');
  assert.ok(appJson.expo.android.versionCode > 9, 'and above the first distributable pilot build');
  assert.ok(appJson.expo.android.versionCode > 8, 'above the rejected Build 8');
  assert.ok(appJson.expo.android.versionCode > 5, 'and above the installed 1.0.4 (versionCode 5)');

  // iOS has its own counter. Build 13 was uploaded to App Store Connect on 8 Oct 2026 (EAS Submit 90bd22f5), so
  // App Store Connect will never accept 13 again; the Guard release was build 14, the pilot update build 15, and the
  // Welfare Check push update build 16 (in TestFlight, owner-confirmed 24 Oct 2026), the Guard notifications update
  // build 17 (in TestFlight, owner-confirmed 25 Oct 2026), the 1.1.1 maintenance release build 18 (uploaded to App Store
  // Connect 26 Oct 2026, EAS Submit 5118fcda), and Guard app 1.1.2 is build 19.
  assert.equal(appJson.expo.ios.buildNumber, '19', 'above the uploaded builds 13, 16, 17 and 18 and the built builds 14 and 15');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 18, 'above the uploaded build 18');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 17, 'above the distributed build 17');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 16, 'above the distributed build 16');
});

test('BUILD-01B-THE-1-1-1-BUILDS-ARE-KEPT-EXACTLY-AND-ARE-ABOVE-THE-DISTRIBUTED-ONES', () => {
  // Since 28 Oct 2026 app.json carries the prepared 1.1.2 (Android 20, iOS 19; BUILD-01C). The 1.1.1 builds stay
  // recorded exactly: Android 19 the distributed approved artefact, iOS 18 the submitted (uploaded) artefact, each
  // exactly one number below what app.json now carries.
  // The release records name the 1.1.1 builds, first prepared (not built), then built and certified (26 Oct 2026, both
  // from 1a6c856). Android 19 is now distributed (Play Internal Testing; production devices report 1.1.1) and 18 is
  // distributed-superseded; iOS 18 is uploaded to App Store Connect (EAS Submit 5118fcda) with no confirmed TestFlight
  // group, so iOS 17 stays the distributed build. Their numbers must be exactly what app.json carries, so a build
  // cannot ship a number the record does not name, and strictly above the builds they follow.
  const android = JSON.parse(read('release/android-signing.json'));
  const ios = JSON.parse(read('release/ios-release.json'));
  const semver = (v) => { assert.match(v, /^\d+\.\d+\.\d+$/); return v.split('.').map(Number); };
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  const NOT_BUILT = /not built/;
  const STATES = ['prepared-not-built', 'built-not-uploaded'];
  const SUBMITTED = 'uploaded-to-testflight';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const SOURCE_COMMIT = '1a6c856504c64bf41758fb1cfd73bf81dfd06040';
  const PRODUCTION_API = 'https://security-marketplace-api.onrender.com';
  const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';

  // Android 1.1.1 (19) is now distributed (owner upload approved 26 Oct 2026; production devices report 1.1.1), so it is
  // the approved artefact, and 1.1.0 (18) is retired as distributed-superseded, as 17 was when 18 replaced it.
  // Only the 1.1.2 (20) stands in front of it (BUILD-01C): built and certified, not uploaded; nothing uploaded does.
  assert.equal(android.preparedArtefact.status, 'built-not-uploaded', 'only the built, not uploaded, 1.1.2 is in front of 1.1.1 (19)');
  const pa = android.approvedArtefact;
  const da = android.retiredArtefacts.find((entry) => entry.versionCode === 18);
  assert.equal(pa.status, 'distributed', 'Android 1.1.1 (19) is the distributed build');
  assert.equal(pa.versionName, '1.1.1');
  assert.equal(pa.versionCode, 19);
  assert.equal(pa.versionCode + 1, appJson.expo.android.versionCode, 'app.json carries the next versionCode, 20');
  assert.ok(above(appJson.expo.version, pa.versionName), 'app.json carries a higher versionName than the distributed 1.1.1');
  assert.equal(da.status, 'distributed-superseded', 'Android 18 was distributed and is superseded');
  assert.equal(android.playConsole.internalTesting.activeRelease, `${pa.versionName} (${pa.versionCode})`, 'Play shows 1.1.1 (19)');
  assert.ok(pa.versionCode > da.versionCode, 'versionCode strictly above the superseded distributed one');
  assert.ok(above(pa.versionName, da.versionName), 'versionName strictly above the superseded distributed one');
  assert.equal(pa.playInternalTesting.status, 'active');
  assert.equal(pa.playInternalTesting.confirmedBy, 'owner');
  assert.match(pa.playInternalTesting.evidence, /production devices report 1\.1\.1$/);
  assert.equal(pa.playInternalTesting.productionDevices.appVersion, pa.versionName, 'the devices report this version');
  {
    assert.match(pa.easBuildId, UUID, 'the EAS build id');
    assert.equal(pa.easBuildProfile, 'production');
    assert.equal(pa.distribution, 'STORE');
    assert.equal(pa.gitCommit, SOURCE_COMMIT, 'built from the 1.1.1 release commit');
    assert.match(pa.aabSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(pa.aabSizeBytes) && pa.aabSizeBytes > 0);
    assert.equal(pa.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
    assert.equal(pa.uploadCertificateSha256, da.uploadCertificateSha256, 'the same upload key as the distributed 18');
    assert.equal(pa.verified.package, 'com.sfour.s4');
    assert.equal(pa.verified.versionCode, pa.versionCode);
    assert.equal(pa.verified.versionName, pa.versionName);
    assert.equal(pa.verified.signerCertificateSha256, S4_CERT_SHA256);
    assert.equal(pa.verified.apiBaseUrl, PRODUCTION_API);
    assert.equal(pa.verified.stagingApiUrls, 0);
    assert.notEqual(pa.aabSha256, da.aabSha256);
    assert.match(pa.note, /Uploaded by the owner to Google Play Internal Testing/);
    assert.doesNotMatch(pa.note, /Not uploaded to Google Play/);
  }

  // The iOS 1.1.1 (18) record moved, unchanged, from preparedArtefact to submittedArtefact when 1.1.2 (19) was prepared.
  const pi = ios.submittedArtefact;
  const di = ios.artefact;
  assert.equal(pi.status, SUBMITTED, 'iOS 1.1.1 (18) is uploaded to App Store Connect, not distributed');
  assert.ok([...STATES, SUBMITTED].includes(pi.status), `unexpected iOS 1.1.1 status ${pi.status}`);
  assert.equal(pi.marketingVersion, '1.1.1');
  assert.equal(pi.buildNumber, '18');
  assert.equal(Number(pi.buildNumber) + 1, Number(appJson.expo.ios.buildNumber), 'app.json carries the next build, 19');
  assert.ok(above(appJson.expo.version, pi.marketingVersion), 'app.json carries a higher version than the uploaded 1.1.1');
  assert.equal(ios.marketingVersion, appJson.expo.version, 'the record header tracks app.json');
  assert.equal(ios.buildNumber, appJson.expo.ios.buildNumber, 'the record header tracks app.json');
  assert.equal(ios.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
  assert.equal(di.status, 'distributed', 'iOS 17 stays the distributed build');
  assert.equal(di.buildNumber, '17');
  assert.ok(Number(pi.buildNumber) > Number(di.buildNumber), 'prepared build number strictly above the distributed one');
  assert.ok(above(pi.marketingVersion, di.marketingVersion), 'prepared marketing version strictly above the distributed one');
  // A submitted-but-unconfirmed build (the status build 13 carries, uploaded-to-testflight) records exactly its
  // EAS submission and nothing about TestFlight groups or Testing: it is not distributed until the owner confirms
  // a group assignment, so 17 stays the distributed iOS build. Before submission, no submission fact at all.
  assert.ok(!('testFlightDistribution' in pi), 'no TestFlight distribution is claimed for 1.1.1 (18)');
  assert.doesNotMatch(JSON.stringify(pi), /"groups?"|in Testing|distributed to/i, 'no tester-group claim');
  if (pi.status === SUBMITTED) {
    assert.deepEqual(Object.keys(pi).filter((key) => /testflight|submission|ascAppId|uploaded/i.test(key)), ['testFlightUpload'], 'only the upload is recorded');
    const up = pi.testFlightUpload;
    assert.deepEqual(Object.keys(up).sort(), ['ascAppId', 'easSubmissionId', 'note', 'uploadedOn'], 'the submission and nothing more');
    assert.match(up.easSubmissionId, UUID, 'the EAS submission id is required');
    assert.equal(up.easSubmissionId, '5118fcda-b1d0-4c6c-ae19-39fe1d2a6df2');
    assert.notEqual(up.easSubmissionId, di.testFlightUpload.easSubmissionId, 'a new submission, not build 17\'s');
    assert.equal(up.ascAppId, '6820632995');
    assert.equal(up.ascAppId, di.testFlightUpload.ascAppId, 'the same App Store Connect app as build 17');
    assert.equal(up.uploadedOn, '2026-10-26');
    assert.match(up.note, /not confirmed/);
    assert.match(pi.note, /TestFlight group assignment is not confirmed/);
    assert.match(pi.note, /1\.1\.0 \(17\) stays the distributed iOS build/);
    assert.doesNotMatch(pi.note, /not submitted/i, 'no longer presented as not submitted');
    assert.match(ios.testFlight, /1\.1\.1 \(18\) uploaded to App Store Connect 2026-10-26 \(EAS Submit 5118fcda\); TestFlight group assignment not confirmed\.$/);
  } else {
    for (const key of ['testFlightUpload', 'testFlightDistribution']) {
      assert.ok(!(key in pi), `a not-submitted iOS artefact records no ${key}`);
    }
    assert.deepEqual(Object.keys(pi).filter((key) => /testflight|submission|ascAppId|uploaded/i.test(key)), [], 'no submission facts');
    assert.match(pi.note, /not submitted/i);
    assert.doesNotMatch(pi.note, /Uploaded to TestFlight|uploaded by EAS Submit/i, 'not presented as submitted');
  }
  if (pi.status === 'prepared-not-built') {
    for (const key of ['easBuildId', 'easBuildUrl', 'ipaSha256', 'ipaFilename', 'ipaSizeBytes', 'gitCommit', 'completedAt', 'certifiedOn', 'verified']) {
      assert.ok(!(key in pi), `a prepared iOS artefact records no ${key}`);
    }
    assert.match(pi.note, NOT_BUILT);
  } else {
    assert.match(pi.easBuildId, UUID, 'the EAS build id');
    assert.ok(pi.easBuildUrl.endsWith(`/builds/${pi.easBuildId}`), 'the build URL names the same build');
    assert.equal(pi.gitCommit, SOURCE_COMMIT, 'built from the 1.1.1 release commit');
    assert.equal(pi.gitCommit, pa.gitCommit, 'the same commit as Android');
    assert.match(pi.ipaSha256, /^[0-9a-f]{64}$/);
    assert.match(pi.ipaFilename, /\.ipa$/);
    assert.ok(pi.ipaFilename.includes(`ios${pi.buildNumber}-`), 'the file is named for its build number');
    assert.ok(Number.isInteger(pi.ipaSizeBytes) && pi.ipaSizeBytes > 0);
    assert.match(pi.certifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(pi.ipaSha256, di.ipaSha256);
    assert.notEqual(pi.easBuildId, di.easBuildId);
    // The exact 1.1.1 (18) build certified on 26 Oct 2026.
    assert.equal(pi.easBuildId, 'ba9af43b-3c6a-49c7-87bd-16e615ce1e71');
    assert.equal(pi.ipaFilename, 's4-1.1.1-ios18-ba9af43b.ipa');
    assert.equal(pi.ipaSha256, '26bb83cf1852c00516248cc11931f6f0f6115c59b88d1e8e2cab335089d50c74');
    assert.equal(pi.ipaSizeBytes, 9709998);
    const v = pi.verified;
    assert.equal(v.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
    assert.equal(v.marketingVersion, pi.marketingVersion);
    assert.equal(v.buildNumber, pi.buildNumber);
    assert.equal(v.usesNonExemptEncryption, false);
    // Signed exactly as the distributed build 17: team, certificate, profile, production push, no debugging.
    assert.equal(v.teamId, di.verified.teamId);
    assert.equal(v.distributionCertificateSha256, di.verified.distributionCertificateSha256);
    assert.equal(v.distributionCertificateSerial, di.verified.distributionCertificateSerial);
    const profileUuid = /UUID ([0-9a-f-]{36})/.exec(di.verified.provisioningProfile)[1];
    assert.ok(v.provisioningProfile.includes(profileUuid), 'the same provisioning profile as build 17');
    assert.equal(v.profileApsEnvironment, 'production');
    assert.equal(v.signedEntitlementsApsEnvironment, 'production');
    assert.equal(v.getTaskAllow, false);
    assert.equal(v.apiBaseUrl, PRODUCTION_API);
    assert.equal(v.stagingApiUrls, 0);
  }
  assert.equal(pi.easBuildProfile, 'production');
  assert.equal(pi.distribution, 'STORE');
  // Same EAS-managed credentials as the distributed build 17: certificate, team and the push-capable profile.
  assert.match(pi.requiredSigning.credentials, /EAS-managed/);
  assert.equal(pi.requiredSigning.teamId, di.verified.teamId);
  assert.equal(pi.requiredSigning.distributionCertificateSha256, di.verified.distributionCertificateSha256);
  assert.equal(pi.requiredSigning.distributionCertificateSerial, di.verified.distributionCertificateSerial);
  assert.match(pi.requiredSigning.provisioningProfile, /B7539588YY/);
  assert.equal(pi.requiredSigning.apsEnvironment, 'production');
  assert.equal(di.verified.profileApsEnvironment, 'production');

  // Both platforms are prepared from the same fix commit on the same branch.
  for (const p of [pa, pi]) {
    assert.equal(p.sourceBranch, 'fix/push-registration-loop');
    assert.equal(p.sourceFixCommit, '808a55c2d7f2bc8a803a3f23a18d6d24123922ac');
  }
});

test('BUILD-01C-THE-1-1-2-BUILDS-ARE-BUILT-NOT-UPLOADED-MATCH-APP-JSON-AND-ARE-ABOVE-THE-1-1-1-ONES', () => {
  // Guard app 1.1.2 (28 Oct 2026): the release records name the 1.1.2 builds, first prepared (not built) in c45dce7, now
  // built by EAS from exactly c45dce7 and certified from the downloaded artefacts, and neither uploaded nor submitted.
  // Their numbers must be exactly what app.json carries, so a build cannot ship a number the record does not name, and
  // strictly above the 1.1.1 builds (Android 19 distributed, iOS 18 uploaded), which stay recorded as they were.
  const android = JSON.parse(read('release/android-signing.json'));
  const ios = JSON.parse(read('release/ios-release.json'));
  const semver = (v) => { assert.match(v, /^\d+\.\d+\.\d+$/); return v.split('.').map(Number); };
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MERGE_COMMIT = 'f2baeb7fca0bb5af1bf657244f7fee6ef6598455';
  const SOURCE_COMMIT = 'c45dce74109ed2efd0efcf6f5a766a07c10f0ecd';
  const PRODUCTION_API = 'https://security-marketplace-api.onrender.com';
  const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';

  const pa = android.preparedArtefact;
  const da = android.approvedArtefact;
  assert.equal(pa.status, 'built-not-uploaded');
  assert.equal(pa.versionName, '1.1.2');
  assert.equal(pa.versionCode, 20);
  assert.equal(pa.versionName, appJson.expo.version);
  assert.equal(pa.versionCode, appJson.expo.android.versionCode);
  assert.equal(android.expectedRelease.versionName, pa.versionName, 'the next AAB is checked against the 1.1.2 release');
  assert.equal(android.expectedRelease.versionCode, pa.versionCode);
  assert.equal(da.status, 'distributed', 'Android 19 stays the distributed build');
  assert.equal(da.versionCode, 19);
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.1.1 (19)', 'Play still shows 1.1.1 (19)');
  assert.ok(pa.versionCode > da.versionCode, '1.1.2 versionCode strictly above the distributed one');
  assert.ok(above(pa.versionName, da.versionName), '1.1.2 versionName strictly above the distributed one');
  // Built: the EAS build, its exact source commit, the AAB and the permanent upload key, read from the AAB.
  assert.match(pa.easBuildId, UUID, 'the EAS build id');
  assert.equal(pa.easBuildId, '8a1a4145-94c8-443f-a25b-1d145abf3064');
  assert.ok(pa.easBuildUrl.endsWith(`/builds/${pa.easBuildId}`), 'the build URL names the same build');
  assert.equal(pa.easBuildProfile, 'production');
  assert.equal(pa.distribution, 'STORE');
  assert.match(pa.gitCommit, /^[0-9a-f]{40}$/);
  assert.equal(pa.gitCommit, SOURCE_COMMIT, 'built from the 1.1.2 release commit');
  assert.ok(!('sourceCommit' in pa), 'the exact gitCommit replaces the prose source description');
  assert.equal(pa.aabFilename, 's4-1.1.2-vc20-8a1a4145.aab');
  assert.match(pa.aabSha256, /^[0-9a-f]{64}$/);
  assert.equal(pa.aabSha256, '4252cc986296c09f7f97df497dc6433829f0f8d15cb653af85f906d8c23f4c4e');
  assert.equal(pa.aabSizeBytes, 59135520);
  assert.ok(!('apkSha256' in pa), 'an App Bundle, not an APK');
  assert.equal(pa.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.equal(pa.uploadCertificateSha256, da.uploadCertificateSha256, 'the same upload key as the distributed 19');
  assert.equal(pa.requiredUploadCertificateSha256, da.uploadCertificateSha256, 'the same upload key as the distributed 19');
  assert.equal(pa.verified.package, 'com.sfour.s4');
  assert.equal(pa.verified.versionCode, pa.versionCode);
  assert.equal(pa.verified.versionName, pa.versionName);
  assert.equal(pa.verified.signerCertificateSha256, S4_CERT_SHA256);
  assert.equal(pa.verified.apiBaseUrl, PRODUCTION_API);
  assert.equal(pa.verified.stagingApiUrls, 0);
  assert.match(pa.verified.guardInboxInBundle, /^yes/);
  assert.match(pa.verified.pushRegistrationFixInBundle, /^yes/);
  assert.match(pa.verified.timesheetHoursMinutesInBundle, /^yes/);
  assert.notEqual(pa.aabSha256, da.aabSha256);
  assert.notEqual(pa.easBuildId, da.easBuildId);
  // Not uploaded: no Play fact of any kind, and the note says so.
  assert.deepEqual(Object.keys(pa).filter((key) => /^play|internalTesting|uploaded/i.test(key)), [], 'no Play upload facts');
  assert.match(pa.note, /Not uploaded to Google Play/);
  assert.doesNotMatch(pa.note, /uploaded (by the owner )?to Google Play Internal Testing/i);

  const pi = ios.preparedArtefact;
  const si = ios.submittedArtefact;
  const di = ios.artefact;
  assert.equal(pi.status, 'built-not-uploaded');
  assert.equal(pi.marketingVersion, '1.1.2');
  assert.equal(pi.buildNumber, '19');
  assert.equal(pi.marketingVersion, appJson.expo.version);
  assert.equal(pi.buildNumber, appJson.expo.ios.buildNumber);
  assert.equal(ios.marketingVersion, appJson.expo.version, 'the record header tracks app.json');
  assert.equal(ios.buildNumber, appJson.expo.ios.buildNumber, 'the record header tracks app.json');
  assert.equal(ios.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
  assert.equal(si.status, 'uploaded-to-testflight', 'iOS 18 stays uploaded, not distributed');
  assert.equal(si.buildNumber, '18');
  assert.equal(si.testFlightUpload.easSubmissionId, '5118fcda-b1d0-4c6c-ae19-39fe1d2a6df2', 'the build 18 submission is kept');
  assert.equal(di.status, 'distributed', 'iOS 17 stays the distributed build');
  assert.equal(di.buildNumber, '17');
  for (const earlier of [si, di]) {
    assert.ok(Number(pi.buildNumber) > Number(earlier.buildNumber), `1.1.2 build number strictly above ${earlier.buildNumber}`);
    assert.ok(above(pi.marketingVersion, earlier.marketingVersion), `1.1.2 marketing version strictly above ${earlier.marketingVersion}`);
    assert.notEqual(pi.ipaSha256, earlier.ipaSha256, `a different IPA from build ${earlier.buildNumber}`);
    assert.notEqual(pi.easBuildId, earlier.easBuildId, `a different build from build ${earlier.buildNumber}`);
  }
  // Not submitted: no TestFlight / App Store Connect fact of any kind, and the note says so.
  for (const key of ['testFlightUpload', 'testFlightDistribution']) {
    assert.ok(!(key in pi), `a not-submitted iOS artefact records no ${key}`);
  }
  assert.deepEqual(Object.keys(pi).filter((key) => /testflight|submission|ascAppId|uploaded/i.test(key)), [], 'no submission facts');
  assert.match(pi.note, /not submitted/i);
  assert.doesNotMatch(pi.note, /Uploaded to TestFlight|uploaded by EAS Submit/i, 'not presented as submitted');
  // Built: the EAS build, the same commit as Android, the IPA, and its signing read from the IPA.
  assert.match(pi.easBuildId, UUID, 'the EAS build id');
  assert.equal(pi.easBuildId, 'eb88768b-9c8a-4e0e-b4a5-0fa721de3151');
  assert.ok(pi.easBuildUrl.endsWith(`/builds/${pi.easBuildId}`), 'the build URL names the same build');
  assert.equal(pi.gitCommit, SOURCE_COMMIT, 'built from the 1.1.2 release commit');
  assert.equal(pi.gitCommit, pa.gitCommit, 'the same commit as Android');
  assert.ok(!('sourceCommit' in pi), 'the exact gitCommit replaces the prose source description');
  assert.equal(pi.ipaFilename, 's4-1.1.2-ios19-eb88768b.ipa');
  assert.ok(pi.ipaFilename.includes(`ios${pi.buildNumber}-`), 'the file is named for its build number');
  assert.match(pi.ipaSha256, /^[0-9a-f]{64}$/);
  assert.equal(pi.ipaSha256, '82c6c54af9114abc73105b9c6c43f71fd6a8470cdc19049235b87fa42da7c18f');
  assert.equal(pi.ipaSizeBytes, 9761128);
  assert.equal(pi.certifiedOn, '2026-10-28');
  const v = pi.verified;
  assert.equal(v.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
  assert.equal(v.marketingVersion, pi.marketingVersion);
  assert.equal(v.buildNumber, pi.buildNumber);
  assert.equal(v.usesNonExemptEncryption, false);
  // Signed exactly as the distributed build 17 and the uploaded build 18: team, certificate, profile, production push,
  // no debugging, no device list.
  for (const earlier of [di, si]) {
    assert.equal(v.teamId, earlier.verified.teamId);
    assert.equal(v.distributionCertificateSha256, earlier.verified.distributionCertificateSha256);
    assert.equal(v.distributionCertificateSerial, earlier.verified.distributionCertificateSerial);
    const profileUuid = /UUID ([0-9a-f-]{36})/.exec(earlier.verified.provisioningProfile)[1];
    assert.ok(v.provisioningProfile.includes(profileUuid), `the same provisioning profile as build ${earlier.buildNumber}`);
  }
  assert.equal(v.teamId, 'SXH4TLU2B5');
  assert.equal(v.distributionCertificateSha256, 'c1f9c5b6c04f4f37939ade278960a16870c88afd2efca94a75b570aab5830196');
  assert.equal(v.distributionCertificateSerial, '3933E4689FD03762FE3029E42A6BC3B5');
  assert.match(v.provisioningProfile, /UUID 1f19cdf5-67cd-4e7b-af8b-131c87c13964, application-identifier SXH4TLU2B5\.com\.sfour\.s4, no device list, expires 2027-06-17/);
  assert.equal(v.profileApsEnvironment, 'production');
  assert.equal(v.profileGetTaskAllow, false);
  assert.equal(v.signedEntitlementsApsEnvironment, 'production');
  assert.equal(v.getTaskAllow, false);
  assert.equal(v.apiBaseUrl, PRODUCTION_API);
  assert.equal(v.stagingApiUrls, 0);
  assert.match(v.guardInboxInBundle, /^yes/);
  assert.match(v.pushRegistrationFixInBundle, /^yes/);
  assert.match(v.timesheetHoursMinutesInBundle, /^yes/);
  // EAS could not validate the profile on Apple's servers (401), so the record says the artefact was verified directly.
  assert.match(pi.note, /Apple 401/);
  assert.match(pi.note, /verified directly/);
  assert.equal(pi.easBuildProfile, 'production');
  assert.equal(pi.distribution, 'STORE');
  // Same EAS-managed credentials as the distributed build 17 and the uploaded build 18.
  assert.match(pi.requiredSigning.credentials, /EAS-managed/);
  for (const earlier of [di, si]) {
    assert.equal(pi.requiredSigning.teamId, earlier.verified.teamId);
    assert.equal(pi.requiredSigning.distributionCertificateSha256, earlier.verified.distributionCertificateSha256);
    assert.equal(pi.requiredSigning.distributionCertificateSerial, earlier.verified.distributionCertificateSerial);
    assert.equal(earlier.verified.profileApsEnvironment, 'production');
  }
  assert.match(pi.requiredSigning.provisioningProfile, /B7539588YY/);
  assert.equal(pi.requiredSigning.apsEnvironment, 'production');

  // Both platforms are prepared on the same branch on top of the same merge commit, which contains the 1.1.1 fix, and
  // built from the same exact release commit.
  for (const p of [pa, pi]) {
    assert.equal(p.sourceBranch, 'release-prep/guard-app-1.1.2');
    assert.equal(p.sourceFixCommit, MERGE_COMMIT);
    assert.equal(p.gitCommit, SOURCE_COMMIT);
    assert.equal(p.certifiedOn, '2026-10-28');
  }
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
  // Gate 4A store profile: an AAB, signed with the permanent S4 key (never an EAS-generated one), on the
  // production API stated explicitly, and with NO autoIncrement — with appVersionSource local that would
  // rewrite app.json during the build and ship a versionCode nobody certified.
  const production = easJson.build.production;
  assert.ok(!('autoIncrement' in production), 'the certified versionCode is not bumped by the build');
  assert.ok(!production.distribution, 'store distribution, not the pilot profile');
  assert.equal(production.android.buildType, 'app-bundle');
  assert.equal(production.android.credentialsSource, 'local');
  assert.equal(production.env.EXPO_PUBLIC_API_URL, 'https://security-marketplace-api.onrender.com');
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
  assert.deepEqual(buildInfo.formatBuildInfoLines(android, 'S4'), ['S4', 'Version 1.0.7', 'Build 8']);

  // On web there is no installed package, so no build number may be shown or fabricated.
  const web = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, platform: 'web' });
  assert.equal(web.buildNumber, null);
  assert.deepEqual(buildInfo.formatBuildInfoLines(web, 'S4'), ['S4', 'Version 1.0.7']);

  // iOS reports its own buildNumber, never Android's versionCode.
  const ios = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, iosBuildNumber: '11', platform: 'ios' });
  assert.equal(ios.buildNumber, 11);
});

test('BUILD-10-A-PILOT-LABEL-IS-APPENDED-AND-IS-NEVER-A-SECRET', () => {
  const pilot = buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 8, buildLabel: 'pilot', platform: 'android' });
  assert.deepEqual(buildInfo.formatBuildInfoLines(pilot, 'S4'), ['S4', 'Version 1.0.7', 'Build 8 · pilot']);
  assert.equal(easJson.build.pilot.env.EXPO_PUBLIC_BUILD_LABEL, 'pilot');
  // Only a label is exposed — no token, key, URL or credential is inlined into the bundle.
  const env = JSON.stringify(easJson.build.pilot.env);
  assert.doesNotMatch(env, /token|secret|key|password|credential/i, 'no secret is exposed through the build label');
});

test('BUILD-11-MISSING-METADATA-DEGRADES-HONESTLY', () => {
  const unknown = buildInfo.resolveAppBuildInfo({ version: null, androidVersionCode: 'x', platform: 'android' });
  assert.deepEqual(buildInfo.formatBuildInfoLines(unknown, 'S4'), ['S4', 'Version unavailable']);
  // A zero or negative versionCode is not a build number either.
  assert.equal(buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: 0, platform: 'android' }).buildNumber, null);
  assert.equal(buildInfo.resolveAppBuildInfo({ version: '1.0.7', androidVersionCode: -3, platform: 'android' }).buildNumber, null);
});

test('BUILD-12-BOTH-ROLES-SHOW-IT-AND-NEITHER-CLUTTERS-OPERATIONS', () => {
  // The product is S4 in every workspace — the footer names the app, not the role.
  assert.match(guard, /<AppBuildFooter appLabel="S4" \/>/, 'Guard Profile shows it');
  assert.match(company, /<AppBuildFooter appLabel="S4" \/>/, 'Company shows it too');
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
