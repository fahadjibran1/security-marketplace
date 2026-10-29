/**
 * Synthetic, structurally valid test images for the patrol evidence specs (no real photos, no personal data).
 *   jpeg  baseline JPEG: SOI, APP0 JFIF, optional APP1 Exif stub, COM nonce, DQT, SOF0 (grey), DHT (one-code DC / AC
 *         tables), SOS, entropy data (DC 0 + EOB per 8x8 block, byte-stuffed), EOI — decodes to a flat grey image
 *   png   signature, IHDR, tEXt nonce, IDAT (zlib), IEND, with correct CRCs
 *   webp  RIFF / WEBP / VP8L chunk with its dimensions header
 *   heic  ftyp (heic) + meta + mdat boxes
 * A nonce makes every image's bytes (and SHA-256) unique.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { crc32 } from '../../src/patrol/evidence/patrol-zip-writer';

const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
const nonceText = (nonce?: string) => nonce ?? randomBytes(8).toString('hex');

export function jpeg(opts: { width?: number; height?: number; nonce?: string; comment?: string; exif?: boolean } = {}): Buffer {
  const width = opts.width ?? 16;
  const height = opts.height ?? 8;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])));
  if (opts.exif) parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('II*\0', 'latin1'), Buffer.alloc(2048, 0)])));
  parts.push(segment(0xfe, Buffer.from(opts.comment ?? `s4 synthetic test image ${nonceText(opts.nonce)}`, 'latin1')));
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])));
  parts.push(segment(0xc0, Buffer.concat([Buffer.from([0x08]), u16(height), u16(width), Buffer.from([0x01, 0x01, 0x11, 0x00])])));
  const oneCodeTable = (tcth: number) => segment(0xc4, Buffer.concat([Buffer.from([tcth, 1]), Buffer.alloc(15, 0), Buffer.from([0x00])]));
  parts.push(oneCodeTable(0x00), oneCodeTable(0x10));
  parts.push(segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  let bits = '00'.repeat(blocks);
  bits += '1'.repeat((8 - (bits.length % 8)) % 8);
  const entropy: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8), 2);
    entropy.push(byte);
    if (byte === 0xff) entropy.push(0x00);
  }
  parts.push(Buffer.from(entropy), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const pngChunk = (type: string, data: Buffer) => {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), typed, u32(crc32(typed))]);
};

export function png(opts: { width?: number; height?: number; nonce?: string } = {}): Buffer {
  const width = opts.width ?? 4;
  const height = opts.height ?? 4;
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 0, 0, 0, 0])]);
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y += 1) rows[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`Comment\0s4 synthetic ${nonceText(opts.nonce)}`, 'latin1')),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function webp(opts: { width?: number; height?: number; nonce?: string } = {}): Buffer {
  const width = opts.width ?? 10;
  const height = opts.height ?? 6;
  const header = Buffer.alloc(5);
  header[0] = 0x2f;
  header.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  let data = Buffer.concat([header, Buffer.from(`s4 ${nonceText(opts.nonce)}`, 'latin1'), Buffer.alloc(32, 0x11)]);
  if (data.length % 2) data = Buffer.concat([data, Buffer.from([0])]);
  const chunk = Buffer.concat([Buffer.from('VP8L', 'latin1'), Buffer.alloc(4), data]);
  chunk.writeUInt32LE(data.length, 4);
  const riff = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), chunk]);
  riff.writeUInt32LE(riff.length - 8, 4);
  return riff;
}

const box = (type: string, payload: Buffer) => Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);

export function heic(opts: { nonce?: string } = {}): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'latin1')),
    box('meta', Buffer.alloc(4, 0)),
    box('mdat', Buffer.concat([Buffer.from(`s4 ${nonceText(opts.nonce)}`, 'latin1'), Buffer.alloc(96, 0x22)])),
  ]);
}

/** A tiny but well-formed ZIP (one stored entry) to append to an image: the classic image + archive polyglot. */
export function zipTail(): Buffer {
  const name = Buffer.from('payload.txt');
  const data = Buffer.from('not part of any photo');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(30 + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
