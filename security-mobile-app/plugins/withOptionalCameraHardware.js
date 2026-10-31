// Declares the camera hardware OPTIONAL in the Android manifest (S4 1.2.0, owner-approved compatibility fix).
//
// Why: 1.2.0 added android.permission.CAMERA (expo-camera: patrol QR scans and patrol photos). With the permission and no
// <uses-feature> for the camera, Google Play IMPLIES android.hardware.camera and android.hardware.camera.autofocus as
// REQUIRED, and filters out every device without them. Play reported 1.2.0 (21) dropping 436 devices (69 phone models)
// that 1.1.2 (20) supported. minSdk, targetSdk, ABIs and screens were unchanged; the implied features were the only cause.
//
// What: the manifest root carries exactly one entry for each of the two features, android:required="false". An existing
// entry for either name is set to required=false rather than duplicated, and a second prebuild changes nothing. The
// CAMERA permission and its runtime handling are untouched. A phone without a camera installs S4 and the patrol camera
// reports itself unavailable (CameraView.isAvailableAsync() -> cameraAccess(..., false) -> 'unavailable'), as before.
//
// Android only: iOS has no hardware filtering by permission, so there is no iOS mod.

const { withAndroidManifest } = require('expo/config-plugins');

const OPTIONAL_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus'];

const nameOf = (feature) => (feature && feature.$ ? feature.$['android:name'] : undefined);

/** Ensures each optional feature appears exactly once at the manifest root, with android:required="false". */
function applyManifest(manifest) {
  const root = manifest.manifest;
  const existing = Array.isArray(root['uses-feature']) ? root['uses-feature'] : [];
  const features = [];
  for (const feature of existing) {
    const name = nameOf(feature);
    if (OPTIONAL_FEATURES.includes(name)) {
      if (features.some((kept) => nameOf(kept) === name)) continue; // a duplicate entry for the same name is dropped
      feature.$['android:required'] = 'false';
    }
    features.push(feature);
  }
  for (const name of OPTIONAL_FEATURES) {
    if (!features.some((kept) => nameOf(kept) === name)) {
      features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }
  }
  root['uses-feature'] = features;
  return manifest;
}

const withOptionalCameraHardware = (config) => withAndroidManifest(config, (c) => {
  c.modResults = applyManifest(c.modResults);
  return c;
});

module.exports = withOptionalCameraHardware;
module.exports.applyManifest = applyManifest;
module.exports.OPTIONAL_FEATURES = OPTIONAL_FEATURES;
