// The checkpoint-label QR decoder for the dashboard camera scan. This default file is what NATIVE builds (and the type
// checker) resolve: no decoder, so the camera option is not offered there and nothing is bundled. The web build resolves
// checkpointQrDecoder.web.ts instead (Metro platform extension).

export type CheckpointQrDecoder = {
  /** One attempt on the current video frame: the text of a QR code in it, or null. */
  decode: (video: unknown) => Promise<string | null>;
  /** Which engine is in use, for the screen ("browser" = BarcodeDetector, "built-in" = the bundled jsQR). */
  engine: 'browser' | 'built-in';
};

export function createCheckpointQrDecoder(): CheckpointQrDecoder | null {
  return null;
}
