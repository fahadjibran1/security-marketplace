// S4 1.3.0 B2: scanning a printed checkpoint label with the browser's camera (the dashboard's test scan). Pure rules and
// the browser environment, kept apart from the component so they can be tested and replaced in tests.
//
// The camera is opened ONLY when the manager presses "Scan with camera" (getUserMedia in that press), the rear camera
// preferred (facingMode environment), and every track is stopped on success, cancel, close, unmount and when the tab is
// hidden. The scanned text goes to the existing confirm call and is never logged or shown.

import { createCheckpointQrDecoder, type CheckpointQrDecoder } from './checkpointQrDecoder';

export type CameraProblem = 'denied' | 'no_camera' | 'unsupported' | 'insecure' | 'in_use' | 'timeout' | 'hidden' | 'error';

/** How long the camera looks for a label before giving up (and stopping). */
export const CAMERA_SCAN_TIMEOUT_MS = 30_000;
/** Pause between two decode attempts. */
export const CAMERA_SCAN_INTERVAL_MS = 250;

type MediaDevicesLike = { getUserMedia: (constraints: any) => Promise<any> };

/** The browser pieces the scanner uses — replaceable in tests. */
export const cameraEnvironment: {
  mediaDevices: () => MediaDevicesLike | null;
  secureContext: () => boolean;
  createDecoder: () => CheckpointQrDecoder | null;
  timeoutMs: number;
  intervalMs: number;
} = {
  mediaDevices: () => {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
    return nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' ? nav.mediaDevices : null;
  },
  secureContext: () => (typeof window !== 'undefined' ? (window as any).isSecureContext !== false : true),
  createDecoder: () => createCheckpointQrDecoder(),
  timeoutMs: CAMERA_SCAN_TIMEOUT_MS,
  intervalMs: CAMERA_SCAN_INTERVAL_MS,
};

/** Before asking for the camera: can this page use one at all? */
export function cameraAvailability(env: Pick<typeof cameraEnvironment, 'mediaDevices' | 'secureContext' | 'createDecoder'> = cameraEnvironment): CameraProblem | null {
  if (!env.secureContext()) return 'insecure';
  if (!env.mediaDevices()) return 'unsupported';
  return null;
}

/** The constraints: video only, the rear camera preferred (falls back to any camera). */
export const CAMERA_CONSTRAINTS = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };

/** A getUserMedia / playback failure, read for the screen. */
export function classifyCameraError(error: unknown): CameraProblem {
  const name = String((error as { name?: unknown })?.name ?? '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'in_use';
  return 'error';
}

const MANUAL = 'You can still scan with a handheld scanner, or type or paste the label text below.';

/** Plain English for each problem; every one falls back to the manual input. */
export function cameraProblemMessage(problem: CameraProblem): string {
  switch (problem) {
    case 'denied':
      return `Camera access is blocked for this page. To use it, allow the camera for this site in your browser (the camera or lock icon next to the address, or on iPhone: Settings › Safari › Camera), then press Scan with camera again. ${MANUAL}`;
    case 'no_camera':
      return `No camera was found on this device. ${MANUAL}`;
    case 'unsupported':
      return `This browser cannot open a camera from this page. ${MANUAL}`;
    case 'insecure':
      return `The camera can only be used on a secure (https) page. ${MANUAL}`;
    case 'in_use':
      return `The camera is being used by another app or browser tab. Close it and press Scan with camera again. ${MANUAL}`;
    case 'timeout':
      return `No checkpoint label was read within ${Math.round(cameraEnvironment.timeoutMs / 1000)} seconds, so the camera was turned off. Hold the label flat and fill the frame, then try again. ${MANUAL}`;
    case 'hidden':
      return `The camera was turned off because the page was hidden. Press Scan with camera to try again. ${MANUAL}`;
    default:
      return `The camera could not be started. ${MANUAL}`;
  }
}

/** Stops every track of a stream (idempotent; tolerates anything that is not a stream). */
export function stopCameraStream(stream: any): void {
  try {
    const tracks = typeof stream?.getTracks === 'function' ? stream.getTracks() : [];
    for (const track of tracks) { try { track.stop(); } catch { /* already stopped */ } }
  } catch { /* nothing to stop */ }
}
