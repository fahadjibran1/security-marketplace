import { promises as fs } from 'fs';
import * as zlib from 'zlib';

/**
 * A minimal streaming ZIP writer for evidence exports (P1-C), written to a local temporary file.
 *
 * Why not a dependency: the backend has no ZIP library, and this needs only the "stored" method (photos are already
 * compressed; deflating JPEG / HEIC / WebP gains ~nothing and costs CPU), no encryption and no ZIP64 (exports are bounded
 * well under 4 GiB and 65 535 entries). ~150 lines with no supply-chain surface, versus pulling in archiver (+ ~10
 * transitive packages) or yazl. The output is checked by independent readers in scripts/patrol-evidence.spec.ts (unzip /
 * Python zipfile / .NET ZipFile, whichever the machine has) as well as by its own central-directory parser.
 *
 * Memory: each entry is streamed to disk chunk by chunk; its CRC-32 is computed on the way and written back into the local
 * header afterwards (positional write), so there are no data descriptors and any reader can extract it. Names are UTF-8
 * (general-purpose flag bit 11).
 */

const MAX_ZIP_BYTES = 0xffff_fffe;
const MAX_ENTRIES = 0xfffe;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (zlib.crc32 where the runtime has it — Node ≥ 20.15 / 22.2 — else a table implementation). */
export function crc32(data: Buffer, previous = 0): number {
  const native = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
  if (typeof native === 'function') return native(data, previous) >>> 0;
  let c = (previous ^ -1) >>> 0;
  for (let i = 0; i < data.length; i += 1) c = (crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

function dosDateTime(at: Date) {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: ((at.getUTCHours() & 0x1f) << 11) | ((at.getUTCMinutes() & 0x3f) << 5) | (Math.floor(at.getUTCSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((at.getUTCMonth() + 1) & 0x0f) << 5) | (at.getUTCDate() & 0x1f),
  };
}

type Entry = { name: Buffer; crc: number; size: number; offset: number; time: number; date: number };

export class ZipFileWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];
  private closed = false;

  private constructor(private readonly handle: fs.FileHandle) {}

  static async create(path: string): Promise<ZipFileWriter> {
    return new ZipFileWriter(await fs.open(path, 'w', 0o600));
  }

  private async write(buffer: Buffer) {
    if (this.offset + buffer.length > MAX_ZIP_BYTES) throw new Error('ZIP size limit reached');
    await this.handle.write(buffer, 0, buffer.length, this.offset);
    this.offset += buffer.length;
  }

  /** Adds one stored entry from a stream of chunks; `onChunk` sees every chunk (e.g. to hash it). */
  async addStream(name: string, chunks: AsyncIterable<Buffer | Uint8Array>, at: Date, onChunk?: (chunk: Buffer) => void): Promise<{ size: number; crc: number }> {
    if (this.closed) throw new Error('ZIP already closed');
    if (this.entries.length >= MAX_ENTRIES) throw new Error('ZIP entry limit reached');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith('/') || name.includes('..')) throw new Error('Invalid ZIP entry name');
    const nameBytes = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(at);
    const headerOffset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // crc / sizes (14..25) patched below
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(header);
    await this.write(nameBytes);
    let crc = 0;
    let size = 0;
    for await (const raw of chunks) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      onChunk?.(chunk);
      crc = crc32(chunk, crc);
      size += chunk.length;
      await this.write(chunk);
    }
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc >>> 0, 0);
    patch.writeUInt32LE(size, 4);
    patch.writeUInt32LE(size, 8);
    await this.handle.write(patch, 0, 12, headerOffset + 14);
    this.entries.push({ name: nameBytes, crc, size, offset: headerOffset, time, date });
    return { size, crc };
  }

  async addBuffer(name: string, data: Buffer, at: Date) {
    async function* once() {
      yield data;
    }
    return this.addStream(name, once(), at);
  }

  /** Writes the central directory and closes the file. Returns the ZIP's length. */
  async close(): Promise<number> {
    if (this.closed) return this.offset;
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // made by
      h.writeUInt16LE(20, 6); // needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // extra, comment, disk, internal attrs = 0; external attrs = 0
      h.writeUInt32LE(e.offset, 42);
      await this.write(h);
      await this.write(e.name);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.offset - start, 12);
    eocd.writeUInt32LE(start, 16);
    await this.write(eocd);
    this.closed = true;
    await this.handle.close();
    return this.offset;
  }

  /** Abandons the file (the caller deletes it). */
  async abort() {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

/** Reads a ZIP's central directory (used by the export's own self-check and the tests). */
export function readZipDirectory(zip: Buffer): Array<{ name: string; crc: number; size: number; offset: number; method: number }> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('No end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory entry');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    out.push({ name: zip.toString('utf8', p + 46, p + 46 + nameLength), crc, size, offset, method });
    p += 46 + nameLength + extra + comment;
  }
  return out;
}

/** An entry's stored bytes, read through its local header. */
export function readZipEntry(zip: Buffer, entry: { offset: number; size: number }): Buffer {
  if (zip.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error('Bad local header');
  const nameLength = zip.readUInt16LE(entry.offset + 26);
  const extra = zip.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extra;
  return zip.subarray(start, start + entry.size);
}
