#!/usr/bin/env node
/**
 * Post-build Android signer provenance check (UAT-MOB-02).
 *
 *   node scripts/verify-apk-signer.cjs <path-to.apk>
 *
 * Android will only install an update signed by the same certificate as the installed app. EAS Build 8
 * was signed with an EAS-generated keystore rather than the retained S4 identity, so it could not update
 * the 1.0.4 on the pilot device — and nothing in the release process could see that, because the ordinary
 * JS/Expo gate never touches a signed APK. This is the step that does.
 *
 * DELIBERATELY NOT PART OF THE MOBILE RELEASE GATE. CI produces no signed APK, so a gate step here would
 * be a green check that never looked at the artefact. It runs against a real downloaded APK after an EAS
 * build, before anything is handed to a tester or a client.
 *
 * It reads only PUBLIC material: the expected certificate fingerprint from release/android-signing.json
 * and the certificate embedded in the APK. No keystore, alias or password is involved.
 *
 * Exit 0 only when the package, the signer and the version metadata all match expectations.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'release', 'android-signing.json');

// ─── pure helpers, exported so the gated spec can execute them without an APK ───

/** Normalises a fingerprint to lowercase hex with no separators, so 0D:58:… and 0d58… compare equal. */
function normaliseFingerprint(value) {
  return String(value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

/** Pulls the certificate SHA-256 out of `apksigner verify --print-certs` output. */
function parseSignerSha256(apksignerOutput) {
  const match = /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)/.exec(String(apksignerOutput ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/** True when `apksigner verify` reported the APK as validly signed. */
function parseVerifies(apksignerOutput) {
  return /^Verifies\s*$/m.test(String(apksignerOutput ?? ''));
}

/** Pulls package / versionCode / versionName / minSdk out of `aapt2 dump badging` output. */
function parseBadging(badgingOutput) {
  const text = String(badgingOutput ?? '');
  const pkg = /package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'/.exec(text);
  const minSdk = /minSdkVersion:'(\d+)'/.exec(text);
  return {
    packageName: pkg ? pkg[1] : null,
    versionCode: pkg && pkg[2] !== '' ? Number(pkg[2]) : null,
    versionName: pkg ? pkg[3] : null,
    minSdkVersion: minSdk ? Number(minSdk[1]) : null,
  };
}

/**
 * The decision. Returns { ok, failures[], checks[] } — never throws, so the caller controls reporting.
 * `expected` is the parsed release/android-signing.json; `actual` is what the APK reported.
 */
function assessApk(expected, actual) {
  const failures = [];
  const checks = [];
  const record = (label, pass, detail) => {
    checks.push({ label, pass, detail });
    if (!pass) failures.push(`${label}: ${detail}`);
  };

  record('APK signature valid', actual.verifies === true, actual.verifies ? 'apksigner reports Verifies' : 'apksigner did NOT report Verifies');

  const expectedSigner = normaliseFingerprint(expected.signer.certificateSha256);
  const actualSigner = normaliseFingerprint(actual.certificateSha256);
  const signerMatches = Boolean(actualSigner) && actualSigner === expectedSigner;
  record(
    'signer certificate',
    signerMatches,
    signerMatches
      ? `matches the permanent S4 identity (${actualSigner.slice(0, 12)}…)`
      : `expected ${expectedSigner.slice(0, 12)}… but found ${actualSigner ? `${actualSigner.slice(0, 12)}…` : '(none)'}`,
  );

  // Name a known-rejected build explicitly, so the operator gets the reason rather than a bare mismatch.
  const rejected = (expected.rejectedBuilds || []).find(
    (entry) => normaliseFingerprint(entry.certificateSha256) === actualSigner,
  );
  if (rejected && !signerMatches) {
    failures.push(`this is the signer of a REJECTED build (${rejected.easBuildId}): ${rejected.reason}`);
  }

  record(
    'package id',
    actual.packageName === expected.package,
    actual.packageName === expected.package ? actual.packageName : `expected ${expected.package} but found ${actual.packageName}`,
  );
  record(
    'versionName',
    actual.versionName === expected.expectedRelease.versionName,
    `${actual.versionName} (expected ${expected.expectedRelease.versionName})`,
  );
  record(
    'versionCode',
    actual.versionCode === expected.expectedRelease.versionCode,
    `${actual.versionCode} (expected ${expected.expectedRelease.versionCode})`,
  );
  record(
    'minSdkVersion',
    actual.minSdkVersion === expected.expectedRelease.minSdkVersion,
    `${actual.minSdkVersion} (expected ${expected.expectedRelease.minSdkVersion})`,
  );

  return { ok: failures.length === 0, failures, checks };
}

/**
 * Pulls the certificate SHA-256 out of `keytool -printcert -jarfile <app.aab>` output. An Android App
 * Bundle is what Google Play receives, and apksigner cannot read one; keytool (shipped with every JDK)
 * prints the upload certificate as colon-separated hex.
 */
function parseKeytoolSha256(keytoolOutput) {
  const match = /SHA256:\s*([0-9A-Fa-f:]{95})/.exec(String(keytoolOutput ?? ''));
  return match ? normaliseFingerprint(match[1]) : null;
}

/**
 * The expectation for the retired development-era package. Historical APKs (1.0.4, Builds 9-12) are
 * verified against it rather than against the current release, so their records stay checkable after
 * the move to com.sfour.s4.
 */
function legacyExpectation(config) {
  const legacy = config.legacyPackage;
  return {
    package: legacy.package,
    signer: config.signer,
    expectedRelease: legacy.finalRelease,
    rejectedBuilds: config.rejectedBuilds,
  };
}

/** Signer-only assessment, for comparing an arbitrary APK (e.g. the historical 1.0.4) to the pinned identity. */
function assessSignerOnly(expected, actual) {
  const expectedSigner = normaliseFingerprint(expected.signer.certificateSha256);
  const actualSigner = normaliseFingerprint(actual.certificateSha256);
  return { ok: Boolean(actualSigner) && actualSigner === expectedSigner, expectedSigner, actualSigner };
}

module.exports = {
  normaliseFingerprint,
  parseSignerSha256,
  parseVerifies,
  parseBadging,
  parseKeytoolSha256,
  legacyExpectation,
  assessApk,
  assessSignerOnly,
  CONFIG_PATH,
};

// ─── CLI ────────────────────────────────────────────────────────────────────────

/** Finds apksigner and aapt2 in the local Android SDK, newest build-tools first. */
function findSdkTools() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    path.join(process.env.HOME || '', 'Android', 'Sdk'),
    path.join(process.env.HOME || '', 'Library', 'Android', 'sdk'),
  ].filter(Boolean);

  for (const sdk of candidates) {
    const buildTools = path.join(sdk, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs.readdirSync(buildTools).sort().reverse();
    for (const version of versions) {
      const dir = path.join(buildTools, version);
      const apksigner = ['apksigner.bat', 'apksigner'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
      const aapt2 = ['aapt2.exe', 'aapt2'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
      if (apksigner && aapt2) return { apksigner, aapt2, sdk, buildToolsVersion: version };
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  // --signer-only compares JUST the certificate, for checking an APK that is not the current release —
  // the historical 1.0.4, for instance, which legitimately carries an older versionCode.
  const signerOnly = args.includes('--signer-only');
  // --legacy checks against the retired com.securitymarketplace.mobile expectations (Build 12 and earlier).
  const legacy = args.includes('--legacy');
  const apkPath = args.find((a) => !a.startsWith('--'));
  if (!apkPath) {
    console.error('usage: node scripts/verify-apk-signer.cjs [--signer-only] [--legacy] <path-to.apk|path-to.aab>');
    process.exit(2);
  }
  if (!fs.existsSync(apkPath)) {
    console.error(`APK not found: ${apkPath}`);
    process.exit(2);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const expected = legacy ? legacyExpectation(config) : config;

  if (/\.aab$/i.test(apkPath)) {
    // An App Bundle carries the UPLOAD signature only; Play re-signs what devices install. Package and
    // version come from the EAS build record for the same artefact. Only the signer is checked here.
    const keytool = process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
      : 'keytool';
    let output = '';
    try {
      output = execFileSync(keytool, ['-printcert', '-jarfile', apkPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      output = `${error.stdout || ''}${error.stderr || ''}`;
    }
    const signer = assessSignerOnly(expected, { certificateSha256: parseKeytoolSha256(output) });
    console.log(`AAB            : ${apkPath}`);
    console.log(`${signer.ok ? 'OK  ' : 'FAIL'}  upload certificate   ${signer.actualSigner || '(none — is a JDK keytool on PATH or JAVA_HOME?)'}`);
    console.log(`      expected             ${signer.expectedSigner}`);
    if (signer.ok) {
      console.log('\nUPLOAD SIGNER MATCHES the permanent S4 key. Confirm package/version from the EAS build record.');
      process.exit(0);
    }
    console.error('\nUPLOAD SIGNER DOES NOT MATCH the permanent S4 key. Do NOT upload this AAB.');
    process.exit(1);
  }
  const tools = findSdkTools();
  if (!tools) {
    console.error('Android SDK build-tools (apksigner + aapt2) not found. Set ANDROID_SDK_ROOT.');
    process.exit(2);
  }

  // apksigner ships as a .bat on Windows, which execFileSync cannot launch directly — it needs a shell.
  // Getting this wrong silently produced empty output and made a correctly signed APK look unsigned, so
  // the tool is required to produce parseable output rather than being allowed to fail quietly.
  const run = (bin, args, { required = true } = {}) => {
    const useShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin);
    const quoted = useShell ? [`"${bin}"`, ...args.map((a) => `"${a}"`)].join(' ') : null;
    let output = '';
    try {
      output = useShell
        ? execFileSync(quoted, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // A non-zero exit is expected for an unsigned or invalid APK, and the useful text is still printed.
      output = `${error.stdout || ''}${error.stderr || ''}`;
    }
    if (required && !output.trim()) {
      console.error(`Could not run ${path.basename(bin)} — no output. Cannot verify this APK.`);
      process.exit(2);
    }
    return output;
  };

  // --verbose is REQUIRED, not cosmetic: without it apksigner prints only the certificate block and
  // omits the "Verifies" line entirely, so the signature-validity check could never see a pass. That
  // failed safe (a good APK looked unverified) but it would have blocked every release.
  const signerOutput = run(tools.apksigner, ['verify', '--verbose', '--print-certs', apkPath]);
  const badgingOutput = run(tools.aapt2, ['dump', 'badging', apkPath]);

  const actual = {
    verifies: parseVerifies(signerOutput),
    certificateSha256: parseSignerSha256(signerOutput),
    ...parseBadging(badgingOutput),
  };

  console.log(`APK            : ${apkPath}`);
  console.log(`build-tools    : ${tools.buildToolsVersion}`);
  console.log(`mode           : ${signerOnly ? 'signer only' : 'full release verification'}`);

  if (signerOnly) {
    const signer = assessSignerOnly(expected, actual);
    console.log(`${signer.ok ? 'OK  ' : 'FAIL'}  signer certificate   ${signer.actualSigner || '(none)'}`);
    console.log(`      expected             ${signer.expectedSigner}`);
    console.log(`      versionName/Code     ${actual.versionName} / ${actual.versionCode}`);
    if (signer.ok) {
      console.log('\nSIGNER MATCHES the permanent S4 Android identity.');
      process.exit(0);
    }
    const rejected = (expected.rejectedBuilds || []).find(
      (entry) => normaliseFingerprint(entry.certificateSha256) === signer.actualSigner,
    );
    console.error(`\nSIGNER DOES NOT MATCH the permanent S4 Android identity.${rejected ? `\n  This is the signer of REJECTED build ${rejected.easBuildId}: ${rejected.reason}` : ''}`);
    process.exit(1);
  }

  const result = assessApk(expected, actual);
  for (const check of result.checks) {
    console.log(`${check.pass ? 'OK  ' : 'FAIL'}  ${check.label.padEnd(20)} ${check.detail}`);
  }

  if (result.ok) {
    console.log('\nSIGNER PROVENANCE OK — this APK carries the permanent S4 Android identity.');
    process.exit(0);
  }

  console.error('\nSIGNER PROVENANCE FAILED:');
  for (const failure of result.failures) console.error(`  - ${failure}`);
  console.error('\nDo NOT distribute this APK.');
  process.exit(1);
}

if (require.main === module) main();
