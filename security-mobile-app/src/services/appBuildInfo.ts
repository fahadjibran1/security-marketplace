// App version / build provenance, read from runtime configuration — never hard-coded.
//
// Real UAT could not establish which build a Guard phone was running: the app showed no version
// anywhere, and every EAS Android build reported 1.0.0 / versionCode 1 regardless of the repository,
// so even Android's App Info could not distinguish one build from another.
//
// WHY THIS READS expo-constants AND WHY THE VERSION SOURCE MATTERS
// eas.json sets `cli.appVersionSource: "local"`, which makes app.json the single source of truth for
// both the version and the Android versionCode. That is what makes this display honest: the same
// numbers end up in the APK manifest AND in `Constants.expoConfig`, so what a Guard reads here is
// exactly what Android's App Info reports. Under the previous "remote" setting EAS ignored app.json
// and used its own counter, while expo-constants still served app.json's value — EAS warns about this
// explicitly — so a display like this one would have shown a number the installed APK did not have.
// If anyone moves appVersionSource back to "remote", this display starts lying. It is pinned by test.
//
// Deliberately dependency-free (no expo-constants, no react-native) so the presentation rules can be
// executed in a plain node test. AppBuildFooter supplies the live runtime values.

export type AppBuildInfo = {
  /** Marketing version, e.g. "1.0.7". Always present. */
  version: string | null;
  /**
   * Android versionCode, the monotonic build number. Null on web and iOS, where it does not exist as
   * an Android build number — never substituted with something that merely looks like one.
   */
  buildNumber: number | null;
  /** Short non-secret label for non-production builds, e.g. "pilot". Null when unset. */
  buildLabel: string | null;
  platform: 'android' | 'ios' | 'web' | 'other';
};

type BuildInfoSources = {
  version?: string | null;
  androidVersionCode?: number | string | null;
  iosBuildNumber?: string | null;
  buildLabel?: string | null;
  platform?: string;
};

/** Pure resolver, so the presentation rules can be tested without a device. */
export function resolveAppBuildInfo(sources: BuildInfoSources): AppBuildInfo {
  const platform: AppBuildInfo['platform'] =
    sources.platform === 'android' || sources.platform === 'ios' || sources.platform === 'web'
      ? sources.platform
      : 'other';

  const version = String(sources.version ?? '').trim() || null;

  // Only Android has a versionCode. On web there is no installed package at all, and on iOS the
  // equivalent is a buildNumber string — neither is presented as an Android build number.
  let buildNumber: number | null = null;
  if (platform === 'android') {
    const numeric = Number(sources.androidVersionCode);
    buildNumber = Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  } else if (platform === 'ios') {
    const numeric = Number(sources.iosBuildNumber);
    buildNumber = Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  const buildLabel = String(sources.buildLabel ?? '').trim() || null;

  return { version, buildNumber, buildLabel, platform };
}

/** Lines to render, in order. Never returns a fabricated build number. */
export function formatBuildInfoLines(info: AppBuildInfo, appLabel: string): string[] {
  const lines: string[] = [appLabel];
  lines.push(info.version ? `Version ${info.version}` : 'Version unavailable');
  if (info.buildNumber !== null) {
    lines.push(info.buildLabel ? `Build ${info.buildNumber} · ${info.buildLabel}` : `Build ${info.buildNumber}`);
  } else if (info.buildLabel) {
    lines.push(info.buildLabel);
  }
  return lines;
}
