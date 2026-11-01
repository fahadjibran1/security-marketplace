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

test('BUILD-01-APP-VERSION-IS-1-2-1-AND-ANDROID-BUILD-24', () => {
  // S4 1.2.1: 1.2.0 plus Package A (patrol correctness, Guard app plan refresh and visibility) on
  // feature/s4-1.2.1-patrol-correctness, built 1 Nov 2026 from 5d749fa: Android 24 built, not uploaded; iOS 21 uploaded to
  // App Store Connect (BUILD-01G). 1.2.0 Android 23 (EAS b5d6a189 from 625bea0) was published to Google Play Internal
  // Testing on 31 Oct 2026 (owner correction) and is the distributed Android build; iOS 1.2.0 build 20 (EAS a1855201 from
  // 4f4de31) was built and never submitted (BUILD-01D).
  // S4 1.2.0 Android 23 (31 Oct 2026, prepared, not built): 1.2.0 (22) was built (EAS e7ffa73a from 61526c9) and never
  // released; Play Console reports 22 as used although it is not in the App bundle library, so 22 is consumed and 23
  // carries the same content (BUILD-01F). 21 and 22 are never reused; iOS stays build 20.
  // S4 1.2.0 Android 22 (31 Oct 2026, prepared, not built): 1.2.0 (21) was built (EAS a9f475ad from 4f4de31) and uploaded
  // by the owner to Google Play as an unpublished Internal Testing draft, never released. Play reported 436 devices no
  // longer supported because CAMERA implied required camera hardware, so 22 declares the camera optional (BUILD-01E).
  // 21 is consumed in Play and is never reused; iOS stays build 20.
  // S4 1.2.0 (29 Oct 2026, prepared, not built): Patrol Management P1-A..P1-E integrated with the Guard app 1.1.2 line
  // on integration/s4-1.2.0-patrols (BUILD-01D). 1.1.2 (Android 20, iOS 19) stays as recorded until 1.2.0 is built.
  // Guard app 1.1.2 (28 Oct 2026): S4 1.1.2 / 20 is the 1.1.1 line merged with release/s4-pilot-rc1 bca5047 (Guard
  // timesheet UX). Built, certified and, owner-confirmed 28 Oct 2026, Active in Google Play Internal Testing; 1.1.1 / 19
  // is distributed-superseded.
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
  assert.equal(appJson.expo.version, '1.2.1');
  assert.equal(appJson.expo.android.versionCode, 24, 'the prepared S4 1.2.1 candidate');
  assert.ok(appJson.expo.android.versionCode > 23, 'above the distributed 1.2.0 (23), published to Play Internal Testing on 31 Oct 2026 (owner correction)');
  assert.ok(appJson.expo.android.versionCode > 22, 'above the superseded 1.2.0 (22), consumed in Play');
  assert.ok(appJson.expo.android.versionCode > 21, 'above the superseded 1.2.0 (21), consumed in Play as a draft');
  assert.ok(appJson.expo.android.versionCode > 20, 'above the distributed Guard app 1.1.2 (20)');
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
  // Connect 26 Oct 2026, EAS Submit 5118fcda), and Guard app 1.1.2 is build 19 (uploaded to App Store Connect 28 Oct
  // 2026, EAS Submit a3234a35; external Beta App Review pending, BUILD-01C).
  // S4 1.2.0 is build 20 (built, never submitted; BUILD-01D); S4 1.2.1 is build 21 (prepared, not built; BUILD-01G).
  assert.equal(appJson.expo.ios.buildNumber, '21', 'above the uploaded builds 13, 16, 17, 18 and 19 and the built builds 14, 15 and 20');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 20, 'above the built 1.2.0 build 20');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 19, 'above the uploaded build 19');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 18, 'above the uploaded build 18');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 17, 'above the distributed build 17');
  assert.ok(Number(appJson.expo.ios.buildNumber) > 16, 'above the distributed build 16');
});

test('BUILD-01B-THE-1-1-1-BUILDS-ARE-KEPT-EXACTLY-AND-ARE-ABOVE-THE-DISTRIBUTED-ONES', () => {
  // Since 28 Oct 2026 app.json carries 1.1.2 (Android 20, iOS 19; BUILD-01C). The 1.1.1 builds stay recorded exactly:
  // Android 19 distributed and now superseded by the distributed 20, iOS 18 the submitted (uploaded) artefact, each
  // exactly one number below what app.json now carries.
  // The release records name the 1.1.1 builds, first prepared (not built), then built and certified (26 Oct 2026, both
  // from 1a6c856). Android 19 was distributed (Play Internal Testing; production devices reported 1.1.1) and, like 18,
  // is distributed-superseded; iOS 18 is uploaded to App Store Connect (EAS Submit 5118fcda) with no confirmed TestFlight
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

  // Android 1.1.1 (19) was distributed (owner upload approved 26 Oct 2026; production devices reported 1.1.1) and since
  // 28 Oct 2026 is retired as distributed-superseded by the distributed 1.1.2 (20) (BUILD-01C), as 18 was when 19
  // replaced it. Nothing is prepared in front of 20.
  // Only the prepared, not built 1.2.0 (23) is in front of the distributed 20 (BUILD-01D), above the superseded, never
  // released 1.2.0 (21) draft (BUILD-01E) and 1.2.0 (22) (BUILD-01F).
  // S4 1.2.1: 1.2.1 (24) was then prepared past the consumed 21, 22 and the built 23 (BUILD-01G).
  // Owner correction (1 Nov 2026): 1.2.0 (23) WAS published to Google Play Internal Testing on 31 Oct 2026, so it is the
  // distributed approved artefact and 20 is distributed-superseded; the built, not uploaded 1.2.1 (24) is next (BUILD-01G).
  assert.equal(android.preparedArtefact.versionCode, android.approvedArtefact.versionCode + 1, 'only the built 1.2.1 (24) is in front of the distributed 1.2.0 (23)');
  const pa = android.retiredArtefacts.find((entry) => entry.versionCode === 19);
  const da = android.retiredArtefacts.find((entry) => entry.versionCode === 18);
  assert.equal(android.retiredArtefacts.filter((entry) => entry.versionCode === 19).length, 1, 'recorded once');
  assert.equal(pa.status, 'distributed-superseded', 'Android 1.1.1 (19) was distributed and is superseded');
  assert.equal(pa.retiredOn, '2026-10-28');
  assert.match(pa.retiredReason, /^Superseded by versionCode 20 \(1\.1\.2\)/);
  assert.equal(pa.versionName, '1.1.1');
  assert.equal(pa.versionCode, 19);
  assert.equal(pa.versionCode + 5, appJson.expo.android.versionCode, 'app.json carries the prepared 1.2.1 versionCode, 24');
  assert.ok(above(appJson.expo.version, pa.versionName), 'app.json carries a higher versionName than 1.1.1');
  assert.equal(da.status, 'distributed-superseded', 'Android 18 was distributed and is superseded');
  assert.equal(android.retiredArtefacts.find((entry) => entry.versionCode === 20).versionCode, pa.versionCode + 1, '20 followed 19 (now distributed-superseded by 23)');
  assert.equal(android.approvedArtefact.versionCode, pa.versionCode + 4, 'the distributed approved artefact is 1.2.0 (23) (21 and 22 consumed, never released)');
  assert.notEqual(android.playConsole.internalTesting.activeRelease, `${pa.versionName} (${pa.versionCode})`, 'Play no longer shows 1.1.1 (19)');
  assert.equal(pa.aabSha256, '168c3f116ad84be0b41225ac5658b815968d7af5006e9ccd012e8a0363f731ca', 'kept exactly');
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

  // The iOS 1.1.1 (18) record moved, unchanged, from preparedArtefact to submittedArtefact when 1.1.2 (19) was prepared,
  // and from submittedArtefact to supersededArtefacts (adding only supersededBy) when 1.2.0 (20) was prepared.
  assert.equal(ios.supersededArtefacts.filter((entry) => entry.buildNumber === '18').length, 1, 'recorded once');
  const pi = ios.supersededArtefacts.find((entry) => entry.buildNumber === '18');
  assert.match(pi.supersededBy, /^1\.1\.2 \(19\) eb88768b/);
  assert.equal(ios.submittedArtefact.buildNumber, '19', 'the uploaded 1.1.2 (19) is the submitted artefact');
  const di = ios.artefact;
  assert.equal(pi.status, SUBMITTED, 'iOS 1.1.1 (18) is uploaded to App Store Connect, not distributed');
  assert.ok([...STATES, SUBMITTED].includes(pi.status), `unexpected iOS 1.1.1 status ${pi.status}`);
  assert.equal(pi.marketingVersion, '1.1.1');
  assert.equal(pi.buildNumber, '18');
  assert.equal(Number(pi.buildNumber) + 1, Number(ios.submittedArtefact.buildNumber), 'the uploaded 1.1.2 is the next build, 19');
  assert.equal(Number(pi.buildNumber) + 3, Number(appJson.expo.ios.buildNumber), 'app.json carries the prepared 1.2.1 build, 21 (20 is the built 1.2.0)');
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
    assert.match(ios.testFlight, /1\.1\.1 \(18\) uploaded to App Store Connect 2026-10-26 \(EAS Submit 5118fcda\); TestFlight group assignment not confirmed\. 1\.1\.2 \(19\) /);
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

test('BUILD-01C-THE-1-1-2-BUILDS-ANDROID-DISTRIBUTED-IOS-UPLOADED-AWAITING-BETA-REVIEW-MATCH-APP-JSON', () => {
  // Guard app 1.1.2 (28 Oct 2026): the release records name the 1.1.2 builds, first prepared (not built) in c45dce7, then
  // built by EAS from exactly c45dce7 and certified from the downloaded artefacts. Owner-confirmed 28 Oct 2026: Android 20
  // is Active in Google Play Internal Testing (Play's active internal release "1.1.2 (20)"); iOS 19 is uploaded to App
  // Store Connect (EAS Submit a3234a35) and assigned to the TestFlight groups "Team (Expo)" (internal) and "S4 pilot
  // guards" (external), whose external review is Waiting for Review, so it is NOT distributed and 17 stays the
  // distributed iOS build. Their numbers must be exactly what app.json carries, and strictly above the 1.1.1 builds
  // (Android 19 distributed-superseded, iOS 18 uploaded), which stay recorded as they were.
  const android = JSON.parse(read('release/android-signing.json'));
  const ios = JSON.parse(read('release/ios-release.json'));
  const semver = (v) => { assert.match(v, /^\d+\.\d+\.\d+$/); return v.split('.').map(Number); };
  const above = (a, b) => { const [x, y] = [semver(a), semver(b)]; for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MERGE_COMMIT = 'f2baeb7fca0bb5af1bf657244f7fee6ef6598455';
  const SOURCE_COMMIT = 'c45dce74109ed2efd0efcf6f5a766a07c10f0ecd';
  const PRODUCTION_API = 'https://security-marketplace-api.onrender.com';
  const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';

  // The 1.1.2 (20) moved from preparedArtefact to approvedArtefact; only the prepared, not built 1.2.0 (23) is in front of it
  // (BUILD-01D), past the superseded 1.2.0 (21) draft (BUILD-01E) and 1.2.0 (22) (BUILD-01F).
  // Owner correction (1 Nov 2026): 1.2.0 (23) was published to Play Internal Testing on 31 Oct 2026 and is now the
  // approved (distributed) artefact; the 1.1.2 (20) record moved, unchanged apart from status and retirement, into
  // retiredArtefacts as distributed-superseded, as 19 did when 20 replaced it. 1.2.1 (24) is built, not uploaded.
  assert.equal(android.preparedArtefact.versionName, '1.2.1');
  assert.equal(android.preparedArtefact.status, 'built-not-uploaded');
  assert.equal(android.retiredArtefacts.filter((entry) => entry.versionCode === 20).length, 1, 'recorded once');
  const pa = android.retiredArtefacts.find((entry) => entry.versionCode === 20);
  const da = android.retiredArtefacts.find((entry) => entry.versionCode === 19);
  assert.equal(pa.status, 'distributed-superseded', 'Android 1.1.2 (20) was the distributed build and is superseded by 1.2.0 (23)');
  assert.equal(pa.retiredOn, '2026-10-31');
  assert.match(pa.retiredReason, /^Superseded by versionCode 23 \(1\.2\.0\), published to Google Play Internal Testing on 31 Oct 2026 \(owner-confirmed\)/);
  assert.equal(android.approvedArtefact.versionCode, 23, 'the distributed approved artefact is 1.2.0 (23)');
  assert.equal(pa.versionName, '1.1.2');
  assert.equal(pa.versionCode, 20);
  assert.ok(above(appJson.expo.version, pa.versionName), 'app.json carries the prepared 1.2.1, above the distributed 1.1.2');
  assert.equal(pa.versionCode + 4, appJson.expo.android.versionCode, 'app.json carries the prepared 24, four above the distributed 20 (21 and 22 are consumed, 23 superseded)');
  assert.equal(android.expectedRelease.versionName, appJson.expo.version, 'the expected release is the prepared 1.2.1 (BUILD-01G)');
  assert.equal(android.expectedRelease.versionCode, pa.versionCode + 4);
  assert.equal(da.status, 'distributed-superseded', 'Android 19 was distributed and is superseded');
  assert.equal(da.versionCode, 19);
  // Distributed only on the owner's confirmation, as Play's active internal release, with the certified hash unchanged.
  assert.equal(pa.playInternalTesting.status, 'active');
  assert.equal(pa.playInternalTesting.confirmedBy, 'owner');
  assert.equal(pa.playInternalTesting.confirmedOn, '2026-10-28');
  assert.equal(pa.playInternalTesting.activeRelease, '1.1.2 (20)');
  assert.ok(!('uploadedAabSha256' in pa.playInternalTesting), 'no uploaded hash was read back from Play, so none is claimed');
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.2.0 (23)', 'Play showed 1.1.2 (20) until 1.2.0 (23) was published (31 Oct 2026)');
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
  // Uploaded: exactly the one Play fact, and the note says so.
  assert.deepEqual(Object.keys(pa).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'only the Play Internal Testing state');
  assert.match(pa.note, /Uploaded by the owner to Google Play Internal Testing and Active there \(owner-confirmed 28 Oct 2026\)/);
  assert.doesNotMatch(pa.note, /Not uploaded to Google Play/);

  // The 1.1.2 (19) record moved, unchanged, from preparedArtefact to submittedArtefact when 1.2.0 (20) was prepared, and
  // the 1.1.1 (18) record from submittedArtefact to supersededArtefacts (BUILD-01B).
  const pi = ios.submittedArtefact;
  const si = ios.supersededArtefacts.find((entry) => entry.buildNumber === '18');
  const di = ios.artefact;
  // Submitted, not distributed: the status builds 13 and 18 carry.
  assert.equal(pi.status, 'uploaded-to-testflight');
  assert.equal(pi.marketingVersion, '1.1.2');
  assert.equal(pi.buildNumber, '19');
  assert.ok(above(appJson.expo.version, pi.marketingVersion), 'app.json carries the prepared 1.2.1, above the uploaded 1.1.2');
  assert.equal(Number(pi.buildNumber) + 2, Number(appJson.expo.ios.buildNumber), 'app.json carries the prepared build 21 (20 is the built 1.2.0)');
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
  // Uploaded and assigned to groups, external review pending: exactly the submission and the assignment, no distribution.
  assert.deepEqual(Object.keys(pi).filter((key) => /testflight|submission|ascAppId|uploaded/i.test(key)), ['testFlightUpload', 'testFlightAssignment'], 'the upload and the group assignment, nothing more');
  assert.ok(!('testFlightDistribution' in pi), 'no TestFlight distribution is claimed for 1.1.2 (19)');
  const up = pi.testFlightUpload;
  assert.deepEqual(Object.keys(up).sort(), ['ascAppId', 'easSubmissionId', 'note', 'uploadedOn'], 'the submission and nothing more');
  assert.match(up.easSubmissionId, UUID);
  assert.equal(up.easSubmissionId, 'a3234a35-1b3a-441b-83f8-98dfb33b85bb');
  for (const earlier of [si, di]) {
    assert.notEqual(up.easSubmissionId, earlier.testFlightUpload.easSubmissionId, `a new submission, not build ${earlier.buildNumber}'s`);
    assert.equal(up.ascAppId, earlier.testFlightUpload.ascAppId, `the same App Store Connect app as build ${earlier.buildNumber}`);
  }
  assert.equal(up.ascAppId, '6820632995');
  assert.equal(up.uploadedOn, '2026-10-28');
  const asg = pi.testFlightAssignment;
  assert.deepEqual(Object.keys(asg).sort(), ['confirmedBy', 'confirmedOn', 'externalReview', 'groups', 'note'], 'the assignment facts and nothing more');
  assert.deepEqual(asg.groups, [{ name: 'Team (Expo)', type: 'internal' }, { name: 'S4 pilot guards', type: 'external' }]);
  assert.equal(asg.confirmedBy, 'owner');
  assert.equal(asg.confirmedOn, '2026-10-28');
  // Apple Beta App Review state of the external group. Only the observed state is accepted; while it is
  // waiting-for-review, the build may claim no distribution, no Testing and no availability to external testers.
  assert.ok(['waiting-for-review'].includes(asg.externalReview), `unexpected externalReview ${asg.externalReview}`);
  if (asg.externalReview === 'waiting-for-review') {
    assert.equal(pi.status, 'uploaded-to-testflight', 'not distributed while the external review is pending');
    assert.notEqual(di.buildNumber, pi.buildNumber, 'not the distributed iOS artefact');
    assert.notEqual(di.easBuildId, pi.easBuildId);
    assert.match(asg.note, /Waiting for Review/);
    assert.match(asg.note, /not distributed and not available to the external testers/);
    assert.doesNotMatch(JSON.stringify(pi), /in Testing|distributed to|(?<!not )available to (the )?external testers/i, 'no distribution claim');
    assert.match(pi.note, /not available to the external testers and 1\.1\.0 \(17\) stays the distributed iOS build/);
    assert.match(ios.testFlight, /1\.1\.2 \(19\) uploaded to App Store Connect 2026-10-28 \(EAS Submit a3234a35\) and assigned to the groups "Team \(Expo\)" \(internal\) and "S4 pilot guards" \(external\); the external group is Waiting for Review \(Apple Beta App Review\), not available to external testers \(owner-confirmed 2026-10-28\)\. 1\.2\.1 \(21\) uploaded to App Store Connect 2026-11-01 \(EAS Submit fa9fafd1\); Apple processing not yet confirmed; no TestFlight group assigned by S4\. 1\.2\.0 \(20\) was never submitted\.$/,
      'the 1.1.2 (19) facts are kept exactly, followed by the 1.2.1 (21) upload (owner update, 1 Nov 2026)');
  }
  // No other iOS record may carry an assignment whose external review is pending while claiming distribution.
  for (const record of [di, si, ...(ios.supersededArtefacts || [])]) {
    if (record.testFlightAssignment) {
      assert.notEqual(record.testFlightAssignment.externalReview, 'waiting-for-review', `build ${record.buildNumber} cannot be pending review and recorded otherwise`);
    }
  }
  assert.ok(!('testFlightAssignment' in si), 'the build 18 evidence is kept exactly: no group is claimed');
  assert.doesNotMatch(pi.note, /not submitted/i, 'no longer presented as not submitted');
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

test('BUILD-01D-THE-1-2-0-BUILDS-ANDROID-23-PUBLISHED-TO-PLAY-INTERNAL-TESTING-AND-IOS-20-BUILT-NEVER-SUBMITTED', () => {
  // S4 1.2.1 (31 Oct 2026): the 1.2.0 builds prepared below (Android 23 on fix/android-optional-camera-hardware on top of
  // 61526c9, iOS 20 on integration/s4-1.2.0-patrols on top of 5bb60b8) were built and never sent to a store: Android 23
  // by EAS b5d6a189 from 625bea0 (not uploaded to Google Play), iOS 20 by EAS a1855201 from 4f4de31 (not submitted to
  // App Store Connect). They moved, with their prepared branch and commit, into the superseded records with exactly their
  // build, file, hash and size and no store fact; the prepared releases are now 1.2.1 (BUILD-01G).
  // OWNER CORRECTION (1 Nov 2026): Android 1.2.0 (23) WAS published to Google Play Internal Testing on 31 Oct 2026 (the
  // owner published it; S4 did not upload it), so versionCode 23 is consumed in Play and is the active internal release:
  // it moved from retiredArtefacts to approvedArtefact with exactly its build, file, hash and size, and its one Play fact.
  // The earlier "never uploaded" assertions are replaced by these corrected facts. iOS 20 stays built, never submitted.
  // Before that (29–31 Oct 2026) the prepared 1.2.0 carried no build, file, hash, upload or store fact; BUILD-01G holds
  // the same rule for 1.2.1.
  const android = JSON.parse(read('release/android-signing.json'));
  const ios = JSON.parse(read('release/ios-release.json'));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';
  assert.equal(android.retiredArtefacts.filter((entry) => entry.versionCode === 23).length, 0, 'Android 23 is no longer a retired record');
  const i = ios.supersededArtefacts.filter((entry) => entry.buildNumber === '20');
  assert.equal(i.length, 1, 'iOS 20 recorded once');
  const pa = android.approvedArtefact;
  const [pi] = i;
  // Android 1.2.0 (23): built, published to Google Play Internal Testing on 31 Oct 2026 (owner-confirmed), consumed there.
  assert.equal(pa.versionCode, 23);
  assert.equal(pa.versionName, '1.2.0');
  assert.equal(pa.status, 'distributed');
  assert.equal(pa.sourceBranch, 'fix/android-optional-camera-hardware');
  assert.equal(pa.sourceFixCommit, '61526c972df25a0309517ced112215b12f32ce3d', 'the base it was prepared on');
  assert.equal(pa.easBuildId, 'b5d6a189-6ad0-4530-b685-689c6115a674');
  assert.match(pa.easBuildId, UUID);
  assert.ok(pa.easBuildUrl.endsWith(`/builds/${pa.easBuildId}`), 'the build URL names the same build');
  assert.equal(pa.gitCommit, '625bea0b5e03d232e6c6ee9c2cfe874a4dcbbec4');
  assert.equal(pa.aabFilename, 's4-1.2.0-vc23-b5d6a189.aab');
  assert.equal(pa.aabSha256, 'eab6a4d55b1e1cb9c07b3b062364f07b803698572dd669a44ef4ac98e45567a3');
  assert.equal(pa.aabSizeBytes, 64050099);
  assert.equal(pa.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.deepEqual(Object.keys(pa).filter((key) => /^play|internalTesting|uploaded/i.test(key)), ['playInternalTesting'], 'exactly the one Play fact');
  assert.deepEqual([pa.playInternalTesting.status, pa.playInternalTesting.confirmedBy, pa.playInternalTesting.confirmedOn, pa.playInternalTesting.publishedOn, pa.playInternalTesting.activeRelease],
    ['active', 'owner', '2026-10-31', '2026-10-31', '1.2.0 (23)']);
  assert.match(pa.playInternalTesting.uploadedBy, /owner \(not S4\)/);
  assert.ok(!('uploadedAabSha256' in pa.playInternalTesting), 'no uploaded hash was read back from Play, so none is claimed');
  for (const unknown of ['rollout', 'tester count', 'exact publication time']) {
    assert.ok(pa.playInternalTesting.unknown.some((u) => u.includes(unknown)), `${unknown} is recorded as unknown, not invented`);
  }
  for (const key of ['testers', 'rolloutPercentage', 'publishedAt']) assert.ok(!(key in pa.playInternalTesting), `no ${key} is claimed`);
  assert.ok(!('uploadCertificateSha256' in pa) && !('verified' in pa) && !('certifiedOn' in pa), 'its signer was not re-read, so no certification is claimed');
  assert.match(pa.note, /Published to Google Play Internal Testing on 31 Oct 2026 \(owner-confirmed; S4 did not upload it\), so versionCode 23 is consumed in Play/);
  assert.doesNotMatch(JSON.stringify(pa), /never uploaded|Not uploaded|not consumed|never reached Play/i, 'the corrected record never says 23 was not uploaded');
  assert.ok(!('retiredReason' in pa) && !('retiredOn' in pa), 'the distributed build is not retired');
  // iOS 1.2.0 (20): built, never submitted.
  assert.equal(pi.marketingVersion, '1.2.0');
  assert.equal(pi.status, 'built-not-submitted');
  assert.equal(pi.sourceBranch, 'integration/s4-1.2.0-patrols');
  assert.equal(pi.sourceFixCommit, '5bb60b80ce9effbfe955068b663b92a2f5454b9a');
  assert.equal(pi.easBuildId, 'a1855201-d6ec-41cd-a2d8-c859d7c4d369');
  assert.ok(pi.easBuildUrl.endsWith(`/builds/${pi.easBuildId}`), 'the build URL names the same build');
  assert.equal(pi.gitCommit, '4f4de31f5d00d04f953662662c4775e463d0bc3d', 'the same source as Android 1.2.0 (21)');
  assert.equal(pi.ipaFilename, 's4-1.2.0-ios20-a1855201.ipa');
  assert.equal(pi.ipaSha256, 'eca08c8fa7ab492390dc32011cfc34ce8a901949fb1b06e9c2899128a1fc1e11');
  assert.equal(pi.ipaSizeBytes, 12856701);
  for (const key of ['testFlightUpload', 'testFlightAssignment', 'testFlightDistribution']) {
    assert.ok(!(key in pi), `a never-submitted iOS build records no ${key}`);
  }
  assert.match(pi.note, /not submitted/i);
  assert.match(pi.supersededBy, /^1\.2\.1 \(21\)/);
  assert.match(pi.requiredSigning.credentials, /EAS-managed/);
  for (const field of ['teamId', 'distributionCertificateSha256', 'distributionCertificateSerial', 'apsEnvironment']) {
    assert.equal(pi.requiredSigning[field], ios.submittedArtefact.requiredSigning[field], `the same ${field} as build 19`);
  }
  for (const p of [pa, pi]) {
    assert.equal(p.easBuildProfile, 'production');
    assert.equal(p.distribution, 'STORE');
    assert.ok(!('sourceCommit' in p), 'the exact gitCommit replaces the prose source description');
  }
  // Play now shows 1.2.0 (23) (owner correction); iOS 20 reached no store and iOS 17 stays the distributed build.
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.2.0 (23)');
  assert.equal(ios.artefact.buildNumber, '17', 'iOS 17 stays the distributed build');
  assert.equal(ios.submittedArtefact.buildNumber, '19', 'iOS 19 stays the uploaded build');
});

test('BUILD-01G-THE-1-2-1-BUILDS-ANDROID-24-BUILT-NOT-UPLOADED-IOS-21-UPLOADED-MATCH-APP-JSON', () => {
  // S4 1.2.1 (31 Oct 2026): 1.2.0 plus Package A on feature/s4-1.2.1-patrol-correctness, on top of 625bea0 (the commit
  // Android 1.2.0 (23) was built from). It was first prepared only — Android 24 and iOS 21 set in app.json and named in the
  // records with no build, file, hash, upload or store fact, sourceFixCommit pinned to 63b706a (the last 1.2.1 app-code
  // commit). Owner update (1 Nov 2026): both were built by EAS from 5d749fa (= release/s4-pilot-rc1, the live backend)
  // and verified; Android 24 is NOT uploaded (the owner uploads it manually to Internal Testing); iOS 21 was uploaded to
  // App Store Connect (EAS Submit fa9fafd1) with Apple processing unconfirmed and no TestFlight group assigned by S4.
  const android = JSON.parse(read('release/android-signing.json'));
  const ios = JSON.parse(read('release/ios-release.json'));
  const BRANCH = 'feature/s4-1.2.1-patrol-correctness';
  const BUILT_COMMIT = '5d749fa1bd5797ff69fa16c4432ee13a2437b602';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const S4_CERT_SHA256 = '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b';
  const pa = android.preparedArtefact;
  const pi = ios.preparedArtefact;
  assert.equal(pa.status, 'built-not-uploaded');
  assert.equal(pi.status, 'uploaded-to-app-store-connect');
  assert.equal(pa.versionName, '1.2.1');
  assert.equal(pa.versionCode, 24);
  assert.equal(pi.marketingVersion, '1.2.1');
  assert.equal(pi.buildNumber, '21');
  assert.equal(pa.versionName, appJson.expo.version);
  assert.equal(pa.versionCode, appJson.expo.android.versionCode);
  assert.equal(pi.marketingVersion, appJson.expo.version);
  assert.equal(pi.buildNumber, appJson.expo.ios.buildNumber);
  assert.equal(android.expectedRelease.versionName, pa.versionName);
  assert.equal(android.expectedRelease.versionCode, pa.versionCode);
  assert.equal(ios.marketingVersion, pi.marketingVersion);
  assert.equal(ios.buildNumber, pi.buildNumber);
  // Above everything built: Android one above the distributed 23, iOS one above the built 20 and two above the uploaded 19.
  assert.equal(pa.versionCode, android.approvedArtefact.versionCode + 1);
  assert.equal(pa.versionCode, Math.max(android.approvedArtefact.versionCode, ...android.retiredArtefacts.map((entry) => entry.versionCode)) + 1);
  assert.equal(Number(pi.buildNumber), Number(ios.submittedArtefact.buildNumber) + 2);
  assert.equal(Number(pi.buildNumber), Math.max(...ios.supersededArtefacts.filter((entry) => entry.buildNumber).map((entry) => Number(entry.buildNumber))) + 1);
  assert.equal(android.retiredArtefacts.find((entry) => entry.versionCode === 20).aabSha256, '4252cc986296c09f7f97df497dc6433829f0f8d15cb653af85f906d8c23f4c4e', 'the 1.1.2 AAB hash is kept');
  assert.equal(android.approvedArtefact.aabSha256, 'eab6a4d55b1e1cb9c07b3b062364f07b803698572dd669a44ef4ac98e45567a3', 'the 1.2.0 (23) AAB hash is kept');
  assert.equal(ios.submittedArtefact.ipaSha256, '82c6c54af9114abc73105b9c6c43f71fd6a8470cdc19049235b87fa42da7c18f', 'the 1.1.2 IPA hash is kept');
  // Built: the exact EAS builds, commit, files, hashes and sizes.
  assert.equal(pa.easBuildId, '85a98a03-f279-45f4-8e38-2dc730c95b3e');
  assert.equal(pi.easBuildId, 'b5a46d30-b24f-4c5e-a11e-85ea9257123b');
  for (const p of [pa, pi]) {
    assert.match(p.easBuildId, UUID);
    assert.ok(p.easBuildUrl.endsWith(`/builds/${p.easBuildId}`), 'the build URL names the same build');
    assert.equal(p.gitCommit, BUILT_COMMIT, 'built from 5d749fa');
    assert.equal(p.certifiedOn, '2026-11-01');
    assert.ok(!('sourceCommit' in p), 'the exact gitCommit replaces the prose source description');
  }
  assert.equal(pa.aabFilename, 's4-1.2.1-vc24-85a98a03.aab');
  assert.equal(pa.aabSha256, '8a948d6b9b370bdded279454e0b16d085a9e9ca7cc9b62d6112e2f961d855a6a');
  assert.equal(pa.aabSizeBytes, 64057635);
  assert.ok(!('apkSha256' in pa), 'an App Bundle, not an APK');
  assert.equal(pa.uploadCertificateSha256, S4_CERT_SHA256, 'signed by the permanent S4 upload key');
  assert.deepEqual([pa.verified.package, pa.verified.versionCode, pa.verified.versionName, pa.verified.signerCertificateSha256], ['com.sfour.s4', 24, '1.2.1', S4_CERT_SHA256]);
  assert.match(pa.verified.cameraFeatures, /android\.hardware\.camera and android\.hardware\.camera\.autofocus declared android:required="false"/);
  assert.equal(pa.verified.permissions, 'identical to 1.2.0 (23)');
  assert.equal(pi.ipaFilename, 's4-1.2.1-ios21-b5a46d30.ipa');
  assert.equal(pi.ipaSha256, 'e5e4d4be5eea07684573e6d29676628ffe921d4b6d289b5a1678eec196a9a47a');
  assert.equal(pi.ipaSizeBytes, 12868425);
  assert.deepEqual([pi.verified.provisioningProfileUuid, pi.verified.teamId, pi.verified.distributionCertificateSha256, pi.verified.apsEnvironment],
    ['1f19cdf5-67cd-4e7b-af8b-131c87c13964', 'SXH4TLU2B5', 'c1f9c5b6c04f4f37939ade278960a16870c88afd2efca94a75b570aab5830196', 'production']);
  // Store facts: Android 24 has none (not uploaded); iOS 21 only its App Store Connect upload, processing unconfirmed.
  for (const key of ['playInternalTesting', 'uploadedAabSha256']) assert.ok(!(key in pa), `the not-uploaded Android 1.2.1 records no ${key}`);
  assert.match(pa.note, /Not uploaded to Google Play: the owner will upload it manually to Internal Testing/);
  assert.deepEqual([pi.testFlightUpload.easSubmissionId, pi.testFlightUpload.ascAppId, pi.testFlightUpload.ascApiKeyId, pi.testFlightUpload.uploadedOn, pi.testFlightUpload.appleProcessing],
    ['fa9fafd1-1a41-468b-8ce9-caca7bec6b44', '6820632995', '468TT6N8RB', '2026-11-01', 'unconfirmed']);
  for (const key of ['testFlightAssignment', 'testFlightDistribution', 'appStoreSubmission']) assert.ok(!(key in pi), `iOS 21 records no ${key}`);
  assert.match(pi.note, /Apple processing is not yet confirmed; S4 assigned it to no TestFlight group and it is not submitted for App Store review/);
  assert.equal(ios.appStore, 'NOT SUBMITTED');
  // Same branch, the same pinned 1.2.1 app-code commit, the store profile and the unchanged signing.
  for (const p of [pa, pi]) {
    assert.equal(p.sourceBranch, BRANCH);
    assert.match(p.sourceFixCommit, /^[0-9a-f]{40}$/);
    assert.equal(p.easBuildProfile, 'production');
    assert.equal(p.distribution, 'STORE');
  }
  assert.equal(pa.sourceFixCommit, pi.sourceFixCommit, 'the same commit for both platforms');
  // Pinned exactly: the LAST S4 1.2.1 app-code commit (the dashboard's patrol exception actions); the built commit 5d749fa
  // descends from it with backend-only changes.
  assert.equal(pa.sourceFixCommit, '63b706a1ed5ba9af5bf1526243ae0ce71ce3dcb0');
  assert.equal(pi.sourceFixCommit, '63b706a1ed5ba9af5bf1526243ae0ce71ce3dcb0');
  assert.match(pa.note, /Migration 73 \(1720900000020-AddPatrolScheduleSuccessors/, '1.2.1 includes Migration 73');
  assert.match(pi.note, /Migration 73 \(1720900000020-AddPatrolScheduleSuccessors/, '1.2.1 includes Migration 73');
  assert.match(pa.note, /withOptionalCameraHardware, withPatrolBackupExclusion/, 'the plugins are unchanged');
  assert.equal(pa.requiredUploadCertificateSha256, S4_CERT_SHA256);
  assert.equal(pa.requiredUploadCertificateSha256, android.retiredArtefacts.find((entry) => entry.versionCode === 20).uploadCertificateSha256, 'the same upload key as the certified 20');
  assert.equal(pa.requiredUploadCertificateSha256, android.approvedArtefact.requiredUploadCertificateSha256, 'the same upload key the distributed 23 requires');
  assert.match(pi.requiredSigning.credentials, /EAS-managed/);
  for (const field of ['teamId', 'distributionCertificateSha256', 'distributionCertificateSerial', 'apsEnvironment']) {
    assert.equal(pi.requiredSigning[field], ios.submittedArtefact.requiredSigning[field], `the same ${field} as build 19`);
  }
  assert.match(pi.requiredSigning.provisioningProfile, /B7539588YY, UUID 1f19cdf5-67cd-4e7b-af8b-131c87c13964/);
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.2.0 (23)', 'Play shows the distributed 1.2.0 (23), not 1.2.1');
  assert.equal(ios.artefact.buildNumber, '17', 'iOS 17 stays the distributed build');
});

test('BUILD-01E-THE-BUILT-1-2-0-VC21-IS-A-SUPERSEDED-NEVER-RELEASED-PLAY-DRAFT', () => {
  // 31 Oct 2026: 1.2.0 (21) was built by EAS (a9f475ad) from 4f4de31 and uploaded by the owner to Google Play as an
  // unpublished Internal Testing draft, never released. Play reported 436 devices (69 phone models) no longer supported:
  // CAMERA with no <uses-feature> made Play imply the camera hardware as required. It is kept exactly as a superseded
  // artefact; 21 is consumed in Play, so app.json and the expected release moved to 22, never back to 21.
  const android = JSON.parse(read('release/android-signing.json'));
  const vc21 = android.retiredArtefacts.filter((entry) => entry.versionCode === 21);
  assert.equal(vc21.length, 1, 'recorded once');
  const s = vc21[0];
  assert.equal(s.versionName, '1.2.0');
  assert.equal(s.status, 'uploaded-draft-superseded');
  assert.equal(s.easBuildId, 'a9f475ad-690f-411d-bf16-3e37ead73274');
  assert.ok(s.easBuildUrl.endsWith(`/builds/${s.easBuildId}`), 'the build URL names the same build');
  assert.equal(s.easBuildProfile, 'production');
  assert.equal(s.distribution, 'STORE');
  assert.equal(s.gitCommit, '4f4de31f5d00d04f953662662c4775e463d0bc3d');
  assert.equal(s.aabFilename, 's4-1.2.0-vc21-a9f475ad.aab');
  assert.equal(s.aabSha256, 'b057144fc92159065e6ec50d51397bd8ce2805e9ba71881181764d2719842ee0');
  assert.equal(s.aabSizeBytes, 64049992);
  assert.equal(s.uploadCertificateSha256, '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b');
  assert.equal(s.uploadCertificateSha256, android.retiredArtefacts.find((entry) => entry.versionCode === 20).uploadCertificateSha256, 'the same upload key as the then-distributed 20');
  assert.equal(s.uploadCertificateSha256, android.approvedArtefact.requiredUploadCertificateSha256, 'the upload key the distributed 23 requires');
  assert.equal(s.playInternalTesting.status, 'draft-not-released');
  assert.equal(s.playInternalTesting.confirmedBy, 'owner');
  assert.match(s.note, /unpublished Internal Testing DRAFT and NOT released/);
  assert.match(s.retiredReason, /^Superseded by versionCode 22 \(1\.2\.0\)/);
  assert.match(s.retiredReason, /436 devices \(69 phone models\)/);
  assert.match(s.retiredReason, /must never be reused/);
  // Never released, so never distributed: Play showed 1.1.2 (20) until 1.2.0 (23) was published on 31 Oct 2026 (owner
  // correction, BUILD-01D). Its successor 22 is itself consumed (BUILD-01F).
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.2.0 (23)');
  assert.ok(s.versionCode > android.retiredArtefacts.find((entry) => entry.versionCode === 20).versionCode && s.versionCode < android.approvedArtefact.versionCode,
    'between the formerly distributed 20 and the distributed 23');
  assert.equal(android.preparedArtefact.versionCode, s.versionCode + 3, 'S4 1.2.1: the built release is 24 (23 is published, BUILD-01D)');
  assert.notEqual(appJson.expo.android.versionCode, s.versionCode, 'app.json never carries the consumed 21 again');
  assert.deepEqual(android.retiredArtefacts.filter((entry) => entry.versionCode >= 20).map((entry) => entry.versionCode), [20, 21, 22],
    'retired at 20 or above: the distributed-superseded 20 and the never-released 21 and 22 (23 is the distributed build)');
});

test('BUILD-01F-THE-BUILT-1-2-0-VC22-IS-CONSUMED-IN-PLAY-NEVER-RELEASED-AND-SUPERSEDED-BY-23', () => {
  // 31 Oct 2026: 1.2.0 (22), 21 plus the optional camera hardware declarations, was built by EAS (e7ffa73a) from 61526c9
  // and never released. Play Console reports versionCode 22 as already used although "Add from library" lists 14 to 21
  // only, so 22 is consumed and must never be reused. Kept exactly; app.json and the expected release moved to 23.
  const android = JSON.parse(read('release/android-signing.json'));
  const vc22 = android.retiredArtefacts.filter((entry) => entry.versionCode === 22);
  assert.equal(vc22.length, 1, 'recorded once');
  const s = vc22[0];
  const vc21 = android.retiredArtefacts.find((entry) => entry.versionCode === 21);
  assert.equal(s.versionName, '1.2.0');
  assert.equal(s.status, 'consumed-unreleased-superseded');
  assert.equal(s.easBuildId, 'e7ffa73a-9038-4cdc-88be-8671075d40b9');
  assert.ok(s.easBuildUrl.endsWith(`/builds/${s.easBuildId}`), 'the build URL names the same build');
  assert.equal(s.easBuildProfile, 'production');
  assert.equal(s.distribution, 'STORE');
  assert.equal(s.sourceBranch, 'fix/android-optional-camera-hardware');
  assert.equal(s.gitCommit, '61526c972df25a0309517ced112215b12f32ce3d');
  assert.equal(s.gitCommit, android.approvedArtefact.sourceFixCommit, 'the published 23 sits on the commit 22 was built from');
  assert.equal(s.aabFilename, 's4-1.2.0-vc22-e7ffa73a.aab');
  assert.equal(s.aabSha256, 'fd79784626c1a1d95ef30214c573fbdd17918e6f6b7e28b593f30a7f5c25a01e');
  assert.equal(s.aabSizeBytes, 64050088);
  assert.equal(s.uploadCertificateSha256, '0d589449335f9154e04a6b973eb186e88fd617581a9843fb62acc2e8ec76311b');
  assert.equal(s.uploadCertificateSha256, android.retiredArtefacts.find((entry) => entry.versionCode === 20).uploadCertificateSha256, 'the same upload key as the then-distributed 20');
  assert.equal(s.uploadCertificateSha256, vc21.uploadCertificateSha256, 'and as 21');
  assert.notEqual(s.aabSha256, vc21.aabSha256, 'a different artefact from 21');
  assert.notEqual(s.easBuildId, vc21.easBuildId);
  assert.equal(s.playInternalTesting.status, 'consumed-not-in-library');
  assert.equal(s.playInternalTesting.confirmedBy, 'owner');
  assert.match(s.note, /NOT released/);
  assert.match(s.note, /lists 14 to 21 only/);
  assert.match(s.retiredReason, /^Superseded by versionCode 23 \(1\.2\.0\)/);
  assert.match(s.retiredReason, /must never be reused/);
  assert.equal(s.retiredOn, '2026-10-31');
  // The number line: distributed-superseded 20 < consumed 21 < consumed 22 < distributed (published) 23 < built / expected
  // 24 = app.json.
  assert.equal(android.playConsole.internalTesting.activeRelease, '1.2.0 (23)');
  assert.equal(android.approvedArtefact.versionCode, s.versionCode + 1, 'the published 23 follows 22');
  assert.equal(s.versionCode, vc21.versionCode + 1);
  assert.equal(android.preparedArtefact.versionCode, s.versionCode + 2);
  assert.equal(android.expectedRelease.versionCode, s.versionCode + 2);
  assert.notEqual(appJson.expo.android.versionCode, s.versionCode, 'app.json never carries the consumed 22 again');
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
