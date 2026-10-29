// Patrol photo processing on the Guard's phone (Patrols P1-E, issue #72). PURE: every device capability is a port.
//
// A patrol photo is taken in S4's own camera (never chosen from the photo library) and then, before anything is queued:
//   1. the source is identified by its magic bytes — JPEG, HEIC/HEIF, PNG or WebP are accepted as camera output; anything
//      else is refused with a clear message;
//   2. it is ALWAYS re-encoded to JPEG by the image manipulator (HEIC → JPEG on iPhones that shoot HEIC), long edge at most
//      PATROL_PHOTO_MAX_EDGE px, quality PATROL_PHOTO_QUALITY;
//   3. every metadata segment (APP1–APP15 except an ICC colour profile, and COM) is removed from the JPEG header, so no
//      EXIF / XMP — and therefore no GPS location, device serial or capture software — can leave the phone. The camera is
//      also asked for no EXIF (exif: false) and S4 never asks for location for patrols;
//   4. the result must start FF D8 FF and be within the backend cap (PATROL_PHOTO_MAX_BYTES, the server default);
//   5. the SHA-256 of exactly those final bytes, as 64 lowercase hex characters, is what the upload declares — the format
//      the backend validates (RequestPatrolEvidenceUploadDto.sha256) and converts to x-amz-checksum-sha256 itself;
//   6. the bytes are written to the Guard's private evidence folder and read back: a write that does not read back the
//      same hash is a write failure, never a queued photo.

export const PATROL_PHOTO_MAX_EDGE = 2048;
export const PATROL_PHOTO_QUALITY = 0.7;
/** The backend default cap (PATROL_EVIDENCE_MAX_BYTES, 10 MiB). A server configured lower answers PATROL_EVIDENCE_TOO_LARGE. */
export const PATROL_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Below this much free space S4 does not take a patrol photo (the queue must never fail to write mid-patrol). */
export const PATROL_PHOTO_MIN_FREE_BYTES = 50 * 1024 * 1024;

export type ImageFormat = 'jpeg' | 'heic' | 'png' | 'webp' | 'unknown';

const ascii = (bytes: Uint8Array, from: number, length: number): string =>
  bytes.length < from + length ? '' : String.fromCharCode(...Array.from(bytes.subarray(from, from + length)));

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif']);

/** The image format from its first bytes. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 4))) return 'heic';
  return 'unknown';
}

export function isJpeg(bytes: Uint8Array): boolean {
  return detectImageFormat(bytes) === 'jpeg';
}

const isIccProfile = (bytes: Uint8Array, segmentStart: number): boolean => ascii(bytes, segmentStart + 4, 12) === 'ICC_PROFILE\u0000';

type Segment = { marker: number; start: number; end: number };

/** The header segments of a JPEG up to Start Of Scan. Throws on a structure that is not a JPEG. */
function headerSegments(bytes: Uint8Array): { segments: Segment[]; scanStart: number } {
  if (!isJpeg(bytes)) throw new PatrolPhotoError('conversion_failed');
  const segments: Segment[] = [];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new PatrolPhotoError('conversion_failed');
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j += 1; // fill bytes
    if (j >= bytes.length) throw new PatrolPhotoError('conversion_failed');
    const marker = bytes[j];
    if (marker === 0xda || marker === 0xd9) return { segments, scanStart: i };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (j + 2 >= bytes.length) throw new PatrolPhotoError('conversion_failed');
    const length = (bytes[j + 1] << 8) | bytes[j + 2];
    const end = j + 1 + length;
    if (length < 2 || end > bytes.length) throw new PatrolPhotoError('conversion_failed');
    segments.push({ marker, start: i, end });
    i = end;
  }
  throw new PatrolPhotoError('conversion_failed');
}

const isMetadata = (bytes: Uint8Array, s: Segment): boolean =>
  s.marker === 0xfe || (s.marker >= 0xe1 && s.marker <= 0xef && !(s.marker === 0xe2 && isIccProfile(bytes, s.start)));

/** The metadata segments a JPEG still carries (EXIF / XMP / maker notes / comments). Empty for a clean file. */
export function jpegMetadataSegments(bytes: Uint8Array): Array<{ marker: number; identifier: string }> {
  const { segments } = headerSegments(bytes);
  return segments.filter((s) => isMetadata(bytes, s)).map((s) => ({ marker: s.marker, identifier: ascii(bytes, s.start + 4, 4) }));
}

/** The same JPEG without its metadata segments; the frame, tables and scan data are copied byte for byte. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const { segments, scanStart } = headerSegments(bytes);
  const keep = segments.filter((s) => !isMetadata(bytes, s));
  const size = 2 + keep.reduce((n, s) => n + (s.end - s.start), 0) + (bytes.length - scanStart);
  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  let at = 2;
  for (const s of keep) {
    out.set(bytes.subarray(s.start, s.end), at);
    at += s.end - s.start;
  }
  out.set(bytes.subarray(scanStart), at);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export type PhotoErrorCode = 'unsupported_format' | 'conversion_failed' | 'metadata_remains' | 'too_large' | 'low_storage' | 'write_failed' | 'camera_failed';

const PHOTO_MESSAGES: Record<PhotoErrorCode, string> = {
  unsupported_format: 'This photo is in a format S4 cannot use. Take the photo again with the S4 camera.',
  conversion_failed: 'S4 could not prepare this photo. Take it again.',
  metadata_remains: 'S4 could not remove the photo\'s hidden details, so it was not kept. Take it again.',
  too_large: 'This photo is too large to send. Take it again.',
  low_storage: 'Your phone is almost out of storage, so S4 cannot keep another patrol photo. Free up some space, then take the photo.',
  write_failed: 'S4 could not save this photo on your phone. Nothing was queued. Take it again.',
  camera_failed: 'The camera could not take a photo. Try again.',
};

export class PatrolPhotoError extends Error {
  readonly code: PhotoErrorCode;
  constructor(code: PhotoErrorCode) {
    super(PHOTO_MESSAGES[code]);
    this.name = 'PatrolPhotoError';
    this.code = code;
  }
}

export function photoErrorMessage(error: unknown): string {
  return error instanceof PatrolPhotoError ? error.message : PHOTO_MESSAGES.conversion_failed;
}

export type PhotoPorts = {
  readBytes(uri: string): Promise<Uint8Array>;
  /** Re-encode to JPEG at most `maxEdge` on the long edge. Must never add metadata or location. */
  reencodeJpeg(uri: string, options: { maxEdge: number; quality: number; width: number; height: number }): Promise<{ uri: string; width: number; height: number }>;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
  /** Write into the signed-in Guard's private evidence folder; returns the file's location. */
  writeEvidence(fileName: string, bytes: Uint8Array): Promise<string>;
  removeFile(uri: string): Promise<void>;
  /** Free bytes on the device, or null when unknown. */
  freeBytes(): number | null;
};

export type ProcessedPhoto = { path: string; sha256: string; sizeBytes: number; width: number; height: number; contentType: 'image/jpeg' };

/** From the camera's capture to a clean, hashed JPEG in the Guard's private folder. Temporary files are always removed. */
export async function processCapturedPhoto(
  capture: { uri: string; width: number; height: number },
  ports: PhotoPorts,
  options: { fileName: string; maxBytes?: number },
): Promise<ProcessedPhoto> {
  const maxBytes = options.maxBytes ?? PATROL_PHOTO_MAX_BYTES;
  const temporary = [capture.uri];
  try {
    const free = ports.freeBytes();
    if (free != null && free < PATROL_PHOTO_MIN_FREE_BYTES) throw new PatrolPhotoError('low_storage');
    const source = await ports.readBytes(capture.uri);
    if (detectImageFormat(source) === 'unknown') throw new PatrolPhotoError('unsupported_format');

    let final: Uint8Array | null = null;
    let size = { width: capture.width, height: capture.height };
    // Second attempt only if the first is over the cap: smaller and more compressed.
    for (const attempt of [{ maxEdge: PATROL_PHOTO_MAX_EDGE, quality: PATROL_PHOTO_QUALITY }, { maxEdge: 1600, quality: 0.5 }]) {
      const encoded = await ports.reencodeJpeg(capture.uri, { ...attempt, width: capture.width, height: capture.height });
      temporary.push(encoded.uri);
      const bytes = await ports.readBytes(encoded.uri);
      if (!isJpeg(bytes)) throw new PatrolPhotoError(detectImageFormat(bytes) === 'unknown' ? 'conversion_failed' : 'unsupported_format');
      const clean = stripJpegMetadata(bytes);
      if (jpegMetadataSegments(clean).length) throw new PatrolPhotoError('metadata_remains');
      size = { width: encoded.width, height: encoded.height };
      if (clean.length <= maxBytes) {
        final = clean;
        break;
      }
    }
    if (!final) throw new PatrolPhotoError('too_large');

    const sha256 = toHex(await ports.sha256(final));
    let path: string;
    try {
      path = await ports.writeEvidence(options.fileName, final);
    } catch {
      throw new PatrolPhotoError('write_failed');
    }
    let readBack: Uint8Array | null = null;
    try {
      readBack = await ports.readBytes(path);
    } catch {
      readBack = null;
    }
    if (!readBack || readBack.length !== final.length || toHex(await ports.sha256(readBack)) !== sha256) {
      await ports.removeFile(path).catch(() => undefined);
      throw new PatrolPhotoError('write_failed');
    }
    return { path, sha256, sizeBytes: final.length, width: size.width, height: size.height, contentType: 'image/jpeg' };
  } finally {
    for (const uri of temporary) await ports.removeFile(uri).catch(() => undefined);
  }
}
