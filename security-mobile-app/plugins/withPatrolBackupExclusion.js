// Keeps queued patrol evidence and the patrol outbox OUT of device backups and device-to-device transfer (S4 1.2.0,
// Patrols P1-E hardening, owner-mandated). No encryption is added: this only decides what the OS may copy off the phone.
// See docs/patrols/P1-E-guard-app.md "Backups and device transfer".
//
// What is protected (the paths the app actually uses):
//   * evidence files:  <files / Documents>/patrol-evidence/u<userId>/*.jpg   (src/services/patrolNative.ts)
//   * outbox database: <files / Documents>/SQLite/s4-patrol-outbox.db (+ -wal, -shm, -journal) — expo-sqlite 16's
//     defaultDatabaseDirectory: Android `context.filesDir/SQLite`, iOS `Documents/SQLite`.
//
// ANDROID. Auto Backup rules are an ALLOW-LIST: once a rules file has an <include>, nothing outside the included paths is
// backed up or transferred. expo-secure-store already ships such a list (shared preferences only, minus its own
// "SecureStore" file), but it is owned by that library and could change with it. This plugin takes ownership: the app's
// manifest points at S4's own two rules files (Android <= 11 `fullBackupContent`, Android 12+ `dataExtractionRules`, both
// cloud backup AND device transfer), which keep expo-secure-store's exclusion exactly and include nothing from the `file`,
// `database`, `root` or external domains — so patrol-evidence/ and SQLite/ can never be copied off the phone. Everything
// else is backed up exactly as before (shared preferences except SecureStore). `android:allowBackup` is left as it was.
// Explicit <exclude> lines for the patrol paths are NOT used: an exclude outside an included path is an Android lint
// error (FullBackupContent) that can fail a release build, and it would add nothing to an allow-list.
//
// iOS. There is no Expo API for NSURLIsExcludedFromBackupKey (expo-file-system 19 and expo-sqlite 16 expose none), so a
// small reviewed Swift snippet is added to AppDelegate.didFinishLaunching: it creates Documents/patrol-evidence and
// Documents/SQLite if missing and sets `isExcludedFromBackup` on both directories, which excludes them and everything in
// them from iCloud and computer backups. It runs on every launch (before any JavaScript), so a directory recreated later
// is covered again at the next start. Nothing is moved: Caches would be purgeable, which is not acceptable for evidence.

const { withAndroidManifest, withAppDelegate, withDangerousMod, AndroidConfig } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const BACKUP_RULES = 's4_backup_rules';
const EXTRACTION_RULES = 's4_data_extraction_rules';
const TAG = 's4-patrol-backup-exclusion';

// The allow-list both rules files share: expo-secure-store's own rules, unchanged (shared preferences, minus SecureStore).
const ALLOW_LIST = [
  '<include domain="sharedpref" path="."/>',
  '<exclude domain="sharedpref" path="SecureStore"/>',
];

const NOTE = '<!-- S4: patrol-evidence/ and SQLite/ (the patrol outbox) are in no included domain, so they are never backed up or transferred. -->';

function backupRulesXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- S4 Auto Backup rules for Android 11 and lower (plugins/withPatrolBackupExclusion.js). -->',
    NOTE,
    '<full-backup-content>',
    ...ALLOW_LIST.map((l) => `  ${l}`),
    '</full-backup-content>',
    '',
  ].join('\n');
}

function dataExtractionRulesXml() {
  const section = (name) => [`  <${name}>`, ...ALLOW_LIST.map((l) => `    ${l}`), `  </${name}>`];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- S4 backup and device-transfer rules for Android 12 and higher (plugins/withPatrolBackupExclusion.js). -->',
    NOTE,
    '<data-extraction-rules>',
    ...section('cloud-backup'),
    ...section('device-transfer'),
    '</data-extraction-rules>',
    '',
  ].join('\n');
}

/** Points the application at S4's own rules files (whatever expo-secure-store or anything else set before). */
function applyManifest(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.$['android:fullBackupContent'] = `@xml/${BACKUP_RULES}`;
  app.$['android:dataExtractionRules'] = `@xml/${EXTRACTION_RULES}`;
  return manifest;
}

const SWIFT_CALL = '    s4ExcludePatrolDataFromBackup()';

const SWIFT_FUNCTION = [
  '/// S4 Patrols: queued patrol evidence and the patrol outbox stay on this phone. Sets NSURLIsExcludedFromBackupKey on',
  '/// Documents/patrol-evidence and Documents/SQLite (expo-sqlite\'s database directory), creating them if missing, so',
  '/// neither they nor anything in them is copied into an iCloud or computer backup. No file is moved or encrypted.',
  'private func s4ExcludePatrolDataFromBackup() {',
  '  guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }',
  '  for name in ["patrol-evidence", "SQLite"] {',
  '    var url = documents.appendingPathComponent(name, isDirectory: true)',
  '    do {',
  '      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)',
  '      var values = URLResourceValues()',
  '      values.isExcludedFromBackup = true',
  '      try url.setResourceValues(values)',
  '    } catch {',
  '      NSLog("S4: could not exclude %@ from backup: %@", name, error.localizedDescription)',
  '    }',
  '  }',
  '}',
].join('\n');

/** Adds the call (first thing in didFinishLaunching) and the function (end of file). Throws if the anchor is missing. */
function applyAppDelegate(src, language) {
  if (language !== 'swift') throw new Error(`withPatrolBackupExclusion: expected a Swift AppDelegate, got ${language}`);
  const withCall = mergeContents({
    src,
    newSrc: SWIFT_CALL,
    tag: `${TAG}-call`,
    anchor: /let delegate = ReactNativeDelegate\(\)/,
    offset: 0,
    comment: '//',
  }).contents;
  if (withCall.includes(`// @generated begin ${TAG}-function`)) return withCall;
  return `${withCall.replace(/\s*$/, '\n')}\n// @generated begin ${TAG}-function\n${SWIFT_FUNCTION}\n// @generated end ${TAG}-function\n`;
}

const withPatrolBackupExclusion = (config) => {
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyManifest(c.modResults);
    return c;
  });
  config = withDangerousMod(config, ['android', async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${BACKUP_RULES}.xml`), backupRulesXml());
    fs.writeFileSync(path.join(dir, `${EXTRACTION_RULES}.xml`), dataExtractionRulesXml());
    return c;
  }]);
  config = withAppDelegate(config, (c) => {
    c.modResults.contents = applyAppDelegate(c.modResults.contents, c.modResults.language);
    return c;
  });
  return config;
};

module.exports = withPatrolBackupExclusion;
module.exports.backupRulesXml = backupRulesXml;
module.exports.dataExtractionRulesXml = dataExtractionRulesXml;
module.exports.applyManifest = applyManifest;
module.exports.applyAppDelegate = applyAppDelegate;
module.exports.BACKUP_RULES = BACKUP_RULES;
module.exports.EXTRACTION_RULES = EXTRACTION_RULES;
