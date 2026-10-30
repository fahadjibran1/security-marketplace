export const LOCAL_WEB_API_BASE_URL = 'http://localhost:3000';
export const LIVE_API_BASE_URL = 'https://security-marketplace-api.onrender.com';
export const UAT_APP_IDENTIFIER = 'com.sfour.s4.uat';
export const UAT_BUILD_LABEL = 'UAT';

type ApiBaseUrlOptions = {
  environmentUrl?: string;
  configuredUrl?: string;
  webHostname?: string;
};

/** The store app and the web dashboard. Unchanged: the UAT app never uses this (see resolveUatApiBaseUrl). */
export function resolveApiBaseUrl({
  environmentUrl,
  configuredUrl,
  webHostname,
}: ApiBaseUrlOptions): string {
  const explicitEnvironmentUrl = environmentUrl?.trim();
  if (explicitEnvironmentUrl) {
    return explicitEnvironmentUrl;
  }

  const hostname = webHostname?.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return LOCAL_WEB_API_BASE_URL;
  }

  return configuredUrl?.trim() || LIVE_API_BASE_URL;
}

type UatSignals = {
  appVariant?: unknown;
  buildLabel?: string | null;
  androidPackage?: string | null;
  iosBundleIdentifier?: string | null;
};

/**
 * Whether this binary is the S4 UAT app. Any one signal is enough, so a UAT build that lost one of them (a missing
 * `extra`, an unset build label) is still treated as UAT and still fails closed. The store app carries none of them.
 */
export function isUatBuild({ appVariant, buildLabel, androidPackage, iosBundleIdentifier }: UatSignals): boolean {
  return (
    appVariant === 'uat' ||
    buildLabel?.trim().toUpperCase() === UAT_BUILD_LABEL ||
    androidPackage?.trim() === UAT_APP_IDENTIFIER ||
    iosBundleIdentifier?.trim() === UAT_APP_IDENTIFIER
  );
}

export type UatApiBaseUrlResolution = { ok: true; url: string } | { ok: false; reason: string };

export const UAT_API_NOT_CONFIGURED =
  'S4 UAT is not configured for the staging API, so it will not connect to any server. Install a correctly built S4 UAT app.';

/** An https origin with a DNS name: no port, path, query, credentials, IP literal or localhost. */
const HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const LIVE_API_HOST = LIVE_API_BASE_URL.replace(/^https:\/\//, '');

/**
 * The UAT app fails closed. The staging address is deliberately not named in app source (uat-variant UAT-07): it
 * reaches only the UAT bundle, through app.config.js, which forces `extra.apiBaseUrl` to staging and refuses to build
 * UAT against any other EXPO_PUBLIC_API_URL. At run time the UAT app therefore needs BOTH copies — the build-time
 * EXPO_PUBLIC_API_URL and the configured `extra.apiBaseUrl` — present, identical, an https origin, and not the live
 * API. If either is missing it does NOT fall back to the live API; anything else and it connects to nothing.
 */
export function resolveUatApiBaseUrl({
  environmentUrl,
  configuredUrl,
}: Pick<ApiBaseUrlOptions, 'environmentUrl' | 'configuredUrl'>): UatApiBaseUrlResolution {
  const refused: UatApiBaseUrlResolution = { ok: false, reason: UAT_API_NOT_CONFIGURED };
  const buildTime = environmentUrl?.trim().replace(/\/+$/, '');
  const configured = configuredUrl?.trim().replace(/\/+$/, '');
  if (!buildTime || !configured || buildTime !== configured) return refused;
  if (!HTTPS_ORIGIN.test(buildTime)) return refused;
  if (buildTime.replace(/^https:\/\//, '') === LIVE_API_HOST) return refused;
  return { ok: true, url: buildTime };
}
