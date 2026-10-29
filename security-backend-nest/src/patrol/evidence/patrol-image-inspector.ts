import { createHash, Hash } from 'crypto';

/**
 * Server-side validation of an uploaded patrol photo (P1-C), in one streaming pass: no photo is ever held whole in
 * memory (only its first 512 KiB, for the header, plus a few bytes of parser state).
 *
 * It computes the SHA-256 and size of exactly the stored bytes, and decides whether they are a real image of the declared
 * type and nothing else:
 *   signature    JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A), WebP (RIFF….WEBP) or HEIC/HEIF (an ftyp box with a HEIF
 *                brand). Anything else is not_an_image; another allowed type than the declared one is content_type_mismatch.
 *   structure    the file is walked to where the image really ends, and must end exactly there:
 *                  JPEG  marker segments, and entropy-coded scan data up to the EOI marker that follows the last scan
 *                  PNG   length-prefixed chunks up to and including IEND
 *                  WebP  the RIFF length is the file length
 *                  HEIF  the top-level boxes tile the file exactly
 *                Bytes after the image (how image + ZIP / HTML / script polyglots are built — even ones that end with a
 *                fake end marker) are trailing_data; an image that stops early is truncated.
 *   markup       no HTML / script / PHP / SVG markup anywhere in the bytes (embedded_markup)
 *   dimensions   from the header where the format allows (JPEG SOF, PNG IHDR, WebP VP8 / VP8L / VP8X): 1–20000 px
 *
 * Metadata: EXIF / XMP are NOT parsed (the JPEG walk only reads segment lengths). No location metadata is read, stored
 * or acted on — location-based verification is disabled until the DPIA. The bytes are stored exactly as the device
 * hashed them (stripping metadata server-side would change the SHA-256 the device declared); the Guard app must capture
 * without location EXIF (a P1-D requirement, docs/patrols/P1-C-evidence-storage.md).
 */

export type InspectedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

export type ImageProblem =
  | 'too_small'
  | 'not_an_image'
  | 'content_type_mismatch'
  | 'trailing_data'
  | 'truncated'
  | 'embedded_markup'
  | 'invalid_dimensions';

export type InspectionResult = {
  sha256: string;
  size: number;
  detectedMime: InspectedMime | null;
  width: number | null;
  height: number | null;
  problems: ImageProblem[];
};

const HEAD_LIMIT = 512 * 1024;
const MIN_SIZE = 64;
const MAX_DIMENSION = 20_000;
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
/** Lower-case ASCII markers that never belong in a photo; a chance match in compressed data is ~2^-48 per position or rarer. */
const MARKUP = ['<script', '<html', '<?php', '<iframe', '<svg', '<!doctype', '<object', '<embed'];
const MARKUP_CARRY = Math.max(...MARKUP.map((m) => m.length)) - 1;

type Walk = { end: number | null; broken: boolean };

/** JPEG: marker segments and entropy-coded data, streamed, to the EOI that ends the image. */
class JpegWalker {
  private state: 'ff' | 'code' | 'len1' | 'len2' | 'skip' | 'entropy' | 'entropyFF' | 'done' = 'ff';
  private pos = 2; // after SOI
  private lengthHi = 0;
  private remaining = 0;
  private afterSkip: 'ff' | 'entropy' = 'ff';
  private pendingCode = 0;
  readonly walk: Walk = { end: null, broken: false };

  /** Feed bytes starting at file offset `start` (the first call starts at 2). */
  feed(chunk: Buffer, start: number) {
    let i = Math.max(0, this.pos - start);
    while (i < chunk.length && !this.walk.broken && this.state !== 'done') {
      switch (this.state) {
        case 'ff':
          if (chunk[i] !== 0xff) {
            this.walk.broken = true;
            return;
          }
          this.state = 'code';
          i += 1;
          break;
        case 'code': {
          const code = chunk[i];
          i += 1;
          this.marker(code, start + i);
          break;
        }
        case 'len1':
          this.lengthHi = chunk[i];
          this.state = 'len2';
          i += 1;
          break;
        case 'len2': {
          const length = (this.lengthHi << 8) | chunk[i];
          i += 1;
          if (length < 2) {
            this.walk.broken = true;
            return;
          }
          this.remaining = length - 2;
          this.state = this.remaining > 0 ? 'skip' : this.afterSkip;
          break;
        }
        case 'skip': {
          const take = Math.min(this.remaining, chunk.length - i);
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.state = this.afterSkip;
          break;
        }
        case 'entropy': {
          const ff = chunk.indexOf(0xff, i);
          if (ff < 0) {
            i = chunk.length;
            break;
          }
          i = ff + 1;
          this.state = 'entropyFF';
          break;
        }
        case 'entropyFF': {
          const code = chunk[i];
          i += 1;
          if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) this.state = 'entropy'; // stuffed byte / restart marker
          else if (code === 0xff) this.state = 'entropyFF'; // fill byte
          else this.marker(code, start + i);
          break;
        }
      }
    }
    this.pos = start + chunk.length;
  }

  /** A marker code just read; `next` is the file offset after it. */
  private marker(code: number, next: number) {
    if (code === 0xff) {
      this.state = 'code'; // fill bytes before a marker
    } else if (code === 0xd9) {
      this.walk.end = next;
      this.state = 'done';
    } else if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      this.state = 'ff';
    } else if (code === 0xd8 || code === 0x00) {
      this.walk.broken = true;
    } else {
      this.pendingCode = code;
      this.afterSkip = code === 0xda ? 'entropy' : 'ff'; // after a scan header, entropy-coded data follows
      this.state = 'len1';
    }
  }

  get code() {
    return this.pendingCode;
  }
}

/**
 * PNG chunks ([length u32][type 4][data][crc 4], up to IEND) or HEIF top-level boxes ([size u32][type 4]…, size 1 =
 * 64-bit size follows, size 0 = to the end of the file), header by header across chunk boundaries.
 */
class HeaderWalker {
  private next: number;
  private header: number[] = [];
  private count = 0;
  readonly walk: Walk = { end: null, broken: false };

  constructor(private readonly kind: 'png' | 'heif') {
    this.next = kind === 'png' ? 8 : 0;
  }

  feed(chunk: Buffer, start: number) {
    if (this.walk.broken || this.walk.end !== null) return;
    let i = this.next - start;
    while (i < chunk.length && !this.walk.broken && this.walk.end === null) {
      if (i < 0) i = 0; // a header that began in the previous chunk
      const need = this.kind === 'heif' && this.header.length >= 4 && this.isLarge() ? 16 : 8;
      while (this.header.length < need && i < chunk.length) this.header.push(chunk[i++]);
      if (this.header.length < 8) return;
      if (this.kind === 'heif' && this.isLarge() && this.header.length < 16) {
        if (i >= chunk.length) return;
        continue;
      }
      const header = Buffer.from(this.header);
      this.header = [];
      const size32 = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      const at = this.next;
      let size: number;
      if (this.kind === 'png') {
        size = 12 + size32;
        if (this.count === 0 && type !== 'IHDR') this.walk.broken = true;
        if (type === 'IEND') this.walk.end = at + size;
      } else {
        if (this.count === 0 && type !== 'ftyp') this.walk.broken = true;
        if (size32 === 0) {
          this.walk.end = Number.POSITIVE_INFINITY; // the last box runs to the end of the file
          return;
        }
        size = size32 === 1 ? Number(header.readBigUInt64BE(8)) : size32;
        if (!Number.isSafeInteger(size) || size < (size32 === 1 ? 16 : 8)) this.walk.broken = true;
      }
      this.count += 1;
      this.next = at + size;
      i = this.next - start;
    }
  }

  /** HEIF: total covered so far (for a file that ends exactly after a box). */
  covered() {
    return this.header.length === 0 ? this.next : -1;
  }

  boxes() {
    return this.count;
  }

  private isLarge() {
    return this.header[0] === 0 && this.header[1] === 0 && this.header[2] === 0 && this.header[3] === 1;
  }
}

export class ImageInspector {
  private readonly hash: Hash = createHash('sha256');
  private size = 0;
  private head: Buffer[] = [];
  private headLength = 0;
  private carry = '';
  private markup = false;
  private mode: InspectedMime | null | undefined = undefined; // undefined until the first 12 bytes are seen
  private pending: Buffer[] = [];
  private jpeg?: JpegWalker;
  private walker?: HeaderWalker;
  private fed = 0;

  update(chunk: Buffer): void {
    if (!chunk.length) return;
    this.hash.update(chunk);
    this.size += chunk.length;
    if (this.headLength < HEAD_LIMIT) {
      const take = chunk.subarray(0, HEAD_LIMIT - this.headLength);
      this.head.push(take);
      this.headLength += take.length;
    }
    if (!this.markup) {
      const text = this.carry + chunk.toString('latin1').toLowerCase();
      if (MARKUP.some((m) => text.includes(m))) this.markup = true;
      this.carry = text.slice(-MARKUP_CARRY);
    }
    if (this.mode === undefined) {
      this.pending.push(chunk);
      const first = Buffer.concat(this.pending);
      if (first.length < 12) return;
      this.pending = [];
      this.mode = detect(first);
      if (this.mode === 'image/jpeg') this.jpeg = new JpegWalker();
      else if (this.mode === 'image/png') this.walker = new HeaderWalker('png');
      else if (this.mode === 'image/heic') this.walker = new HeaderWalker('heif');
      this.feed(first);
      return;
    }
    this.feed(chunk);
  }

  private feed(chunk: Buffer) {
    this.jpeg?.feed(chunk, this.fed);
    this.walker?.feed(chunk, this.fed);
    this.fed += chunk.length;
  }

  finish(declaredMime: string): InspectionResult {
    if (this.mode === undefined && this.pending.length) {
      // Fewer than 12 bytes in total.
      this.mode = detect(Buffer.concat(this.pending));
    }
    const head = Buffer.concat(this.head);
    const problems: ImageProblem[] = [];
    const detectedMime = this.mode ?? null;
    let dims: { width: number; height: number } | null = null;
    if (this.size < MIN_SIZE) problems.push('too_small');
    if (!detectedMime) problems.push('not_an_image');
    else {
      if (detectedMime !== declaredMime) problems.push('content_type_mismatch');
      const structure = this.structure(detectedMime, head);
      if (structure) problems.push(structure);
      dims = dimensions(detectedMime, head);
      if (dims && (dims.width < 1 || dims.height < 1 || dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)) problems.push('invalid_dimensions');
    }
    if (this.markup) problems.push('embedded_markup');
    return { sha256: this.hash.digest('hex'), size: this.size, detectedMime, width: dims?.width ?? null, height: dims?.height ?? null, problems };
  }

  private structure(mime: InspectedMime, head: Buffer): ImageProblem | null {
    const ending = (walk: Walk): ImageProblem | null => {
      if (walk.broken || walk.end === null) return 'truncated';
      if (walk.end === Number.POSITIVE_INFINITY || walk.end === this.size) return null;
      return walk.end < this.size ? 'trailing_data' : 'truncated';
    };
    switch (mime) {
      case 'image/jpeg':
        return ending(this.jpeg!.walk);
      case 'image/png':
        return ending(this.walker!.walk);
      case 'image/webp': {
        const riff = head.length >= 8 ? head.readUInt32LE(4) + 8 : -1;
        return riff === this.size ? null : riff >= 0 && riff < this.size ? 'trailing_data' : 'truncated';
      }
      case 'image/heic': {
        const w = this.walker!;
        if (w.walk.broken) return 'truncated';
        if (w.walk.end === Number.POSITIVE_INFINITY) return null;
        if (w.boxes() < 2) return 'truncated';
        const covered = w.covered();
        return covered === this.size ? null : covered >= 0 && covered < this.size ? 'trailing_data' : 'truncated';
      }
    }
  }
}

function detect(head: Buffer): InspectedMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(head.toString('latin1', 8, 12))) return 'image/heic';
  return null;
}

function dimensions(mime: InspectedMime, head: Buffer): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      if (head.length >= 24 && head.toString('latin1', 12, 16) === 'IHDR') return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
      return null;
    }
    if (mime === 'image/webp') {
      const chunk = head.toString('latin1', 12, 16);
      if (chunk === 'VP8X' && head.length >= 30) return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
      if (chunk === 'VP8L' && head.length >= 25 && head[20] === 0x2f) {
        const bits = head.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ' && head.length >= 30) return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 4 <= head.length) {
        if (head[i] !== 0xff) return null;
        const marker = head[i + 1];
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) return null; // no frame header before the scan
        const length = head.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (i + 9 > head.length) return null;
          return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
        }
        if (length < 2) return null;
        i += 2 + length;
      }
      return null;
    }
    return null; // HEIF: dimensions live deep in the meta box; not read
  } catch {
    return null;
  }
}
