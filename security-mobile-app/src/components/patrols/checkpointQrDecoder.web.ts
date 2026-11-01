// WEB ONLY (Metro resolves this file for the web bundle; native builds use checkpointQrDecoder.ts and never include it).
// Decodes the checkpoint label from the camera's video: the browser's own BarcodeDetector when it reads QR codes
// (Chrome / Edge on Android, desktop Chrome), otherwise jsQR (exact-pinned, pure JavaScript, bundled — no network, no
// worker loaded from a CDN), which is what iOS Safari and Firefox use.

import jsQR from 'jsqr';
import type { CheckpointQrDecoder } from './checkpointQrDecoder';

export type { CheckpointQrDecoder } from './checkpointQrDecoder';

const MAX_SIDE = 800;

function jsQrDecoder(): CheckpointQrDecoder {
  let canvas: any = null;
  return {
    engine: 'built-in',
    async decode(video: any) {
      const w = Number(video?.videoWidth) || 0;
      const h = Number(video?.videoHeight) || 0;
      if (!w || !h || typeof document === 'undefined') return null;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      canvas = canvas ?? document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(video, 0, 0, cw, ch);
      const image = context.getImageData(0, 0, cw, ch);
      const found = jsQR(image.data, cw, ch, { inversionAttempts: 'attemptBoth' });
      return found?.data ? found.data : null;
    },
  };
}

export function createCheckpointQrDecoder(): CheckpointQrDecoder | null {
  const Detector = typeof window !== 'undefined' ? (window as any).BarcodeDetector : undefined;
  const fallback = jsQrDecoder();
  if (typeof Detector !== 'function') return fallback;
  let detector: any = null;
  let usable: Promise<boolean> | null = null;
  const ready = () => {
    usable = usable ?? Promise.resolve()
      .then(async () => {
        const formats: string[] = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : ['qr_code'];
        if (!formats.includes('qr_code')) return false;
        detector = new Detector({ formats: ['qr_code'] });
        return true;
      })
      .catch(() => false);
    return usable;
  };
  return {
    engine: 'browser',
    async decode(video: any) {
      if (!(await ready())) return fallback.decode(video);
      try {
        const codes = await detector.detect(video);
        const text = Array.isArray(codes) ? codes.find((c: any) => typeof c?.rawValue === 'string' && c.rawValue)?.rawValue : null;
        return text ?? null;
      } catch {
        return fallback.decode(video);
      }
    },
  };
}
