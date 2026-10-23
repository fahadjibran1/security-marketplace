// Expo dynamic config. app.json stays the single source of truth for the store app (com.sfour.s4): without
// APP_VARIANT=uat this returns it untouched, so the production and pilot builds are byte-for-byte the config
// that was certified. Only the EAS `uat` profile sets APP_VARIANT=uat.
//
// The UAT variant is a separate, side-by-side app that talks ONLY to the isolated staging API. It is made
// unmistakable on a Guard's phone: its own application id, the name "S4 UAT", amber icons and splash, and an
// in-app "UAT · STAGING" label (see src/services/appVariant.ts).
//
// EXPO_PUBLIC_API_URL wins over extra.apiBaseUrl at runtime (src/services/api-base-url.ts), so the identity and
// the API are checked together here: a UAT app that would reach anything but staging, or a store-identity app
// built on EAS that would reach staging (the old `preview-staging` profile), fails the build instead of shipping.

const UAT_API_BASE_URL = 'https://security-marketplace-api-staging.onrender.com';
const UAT_AMBER = '#B45309';

function assertApiMatchesIdentity(isUat) {
  const url = (process.env.EXPO_PUBLIC_API_URL || '').trim();
  if (isUat && process.env.EAS_BUILD && url !== UAT_API_BASE_URL) {
    throw new Error(`S4 UAT must be built with EXPO_PUBLIC_API_URL=${UAT_API_BASE_URL}; refusing to build it against any other API.`);
  }
  if (isUat && url && url !== UAT_API_BASE_URL) {
    throw new Error('S4 UAT may only talk to the staging API; EXPO_PUBLIC_API_URL names a different one.');
  }
  if (!isUat && process.env.EAS_BUILD && /staging/i.test(url)) {
    throw new Error('The store-identity app (com.sfour.s4) must never be built against the staging API. Use the `uat` profile.');
  }
}

/**
 * The UAT app's Android versionCode. It is its own number (the UAT app carries code the store release does not), set
 * only by the EAS `uat` profile, and an EAS UAT build refuses to start unless it is above the store app's — so a new
 * UAT build always installs over the previous UAT build and never borrows the store's number.
 */
function uatVersionCode(config) {
  const raw = process.env.UAT_ANDROID_VERSION_CODE;
  const store = Number(config.android && config.android.versionCode);
  if (raw === undefined || raw === '') {
    if (process.env.EAS_BUILD) throw new Error('S4 UAT must be built with UAT_ANDROID_VERSION_CODE (the eas.json `uat` profile sets it).');
    return store;
  }
  const code = Number(raw);
  if (!Number.isInteger(code) || code <= store) {
    throw new Error(`UAT_ANDROID_VERSION_CODE must be a whole number above the store app's versionCode ${store}.`);
  }
  return code;
}

module.exports = ({ config }) => {
  const isUat = process.env.APP_VARIANT === 'uat';
  assertApiMatchesIdentity(isUat);
  if (!isUat) return config;

  return {
    ...config,
    name: 'S4 UAT',
    scheme: 's4security-uat',
    icon: './assets/uat/icon.png',
    splash: { ...config.splash, backgroundColor: UAT_AMBER },
    ios: { ...config.ios, bundleIdentifier: 'com.sfour.s4.uat' },
    android: {
      ...config.android,
      package: 'com.sfour.s4.uat',
      versionCode: uatVersionCode(config),
      adaptiveIcon: { ...config.android.adaptiveIcon, foregroundImage: './assets/uat/adaptive-icon.png', backgroundColor: UAT_AMBER },
    },
    extra: { ...config.extra, apiBaseUrl: UAT_API_BASE_URL, appVariant: 'uat' },
  };
};
