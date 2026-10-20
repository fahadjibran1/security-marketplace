// Expo dynamic config. app.json stays the single source of truth for the store app (com.sfour.s4): without
// APP_VARIANT=uat this returns it untouched, so the production and pilot builds are byte-for-byte the config
// that was certified. Only the EAS `uat` profile sets APP_VARIANT=uat.
//
// The UAT variant is a separate, side-by-side app that talks ONLY to the isolated staging API. It is made
// unmistakable on a Guard's phone: its own application id, the name "S4 UAT", amber icons and splash, and an
// in-app "UAT · STAGING" label (see src/services/appVariant.ts).

const UAT_API_BASE_URL = 'https://security-marketplace-api-staging.onrender.com';
const UAT_AMBER = '#B45309';

module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== 'uat') return config;

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
      adaptiveIcon: { ...config.android.adaptiveIcon, foregroundImage: './assets/uat/adaptive-icon.png', backgroundColor: UAT_AMBER },
    },
    extra: { ...config.extra, apiBaseUrl: UAT_API_BASE_URL, appVariant: 'uat' },
  };
};
