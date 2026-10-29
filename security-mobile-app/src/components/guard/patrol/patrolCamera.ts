// Camera access for patrols (Patrols P1-E). PURE: the screen passes in what expo-camera reported.
//
// S4 asks for the camera only when the Guard opens the scanner or the patrol camera, with a rationale first. There is
// no photo-library permission and no image picker anywhere in the app: a patrol photo can only come from S4's camera.

export type CameraPermissionSnapshot = { granted: boolean; canAskAgain: boolean; status: string } | null;

export type CameraAccess =
  | { kind: 'checking'; title: string; message: string; action: null }
  | { kind: 'unavailable'; title: string; message: string; action: null }
  | { kind: 'ask'; title: string; message: string; action: 'request' }
  | { kind: 'denied'; title: string; message: string; action: 'request' }
  | { kind: 'blocked'; title: string; message: string; action: 'open_settings' }
  | { kind: 'ready'; title: string; message: string; action: null };

const RATIONALE =
  'S4 uses the camera only while you patrol: to scan the checkpoint QR labels and to take patrol photos inside S4. Photos are not saved to your photo library and carry no location.';

/**
 * What the patrol camera screen shows.
 *   available false     the phone has no usable camera, or the camera failed to start (onMountError)
 *   undetermined        explain first, then ask
 *   denied, can ask     explain and offer to ask again
 *   denied, cannot ask  (permanently denied / blocked by policy) only the phone's Settings can change it
 */
export function cameraAccess(permission: CameraPermissionSnapshot, available: boolean | null): CameraAccess {
  if (available === false) {
    return {
      kind: 'unavailable',
      title: 'Camera not available',
      message: 'S4 cannot use this phone\'s camera right now. Close other apps using the camera and try again. If it still fails, tell your control room — you can still record the patrol and give a reason for any missing scans.',
      action: null,
    };
  }
  if (!permission) return { kind: 'checking', title: 'Checking camera access', message: RATIONALE, action: null };
  if (permission.granted) return { kind: 'ready', title: 'Camera ready', message: '', action: null };
  if (permission.status === 'undetermined') return { kind: 'ask', title: 'Allow camera for patrols', message: RATIONALE, action: 'request' };
  if (permission.canAskAgain) {
    return { kind: 'denied', title: 'Camera access is off', message: `${RATIONALE} Without it you cannot scan checkpoints or take patrol photos.`, action: 'request' };
  }
  return {
    kind: 'blocked',
    title: 'Turn on the camera in Settings',
    message: 'Camera access for S4 is turned off in your phone\'s Settings, so S4 cannot ask again. Open Settings, allow Camera for S4, then come back.',
    action: 'open_settings',
  };
}
