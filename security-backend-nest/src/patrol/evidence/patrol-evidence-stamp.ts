import sharp = require('sharp');

/**
 * Stamped patrol photos. GET /patrols/evidence/:id/stamped derives a JPEG from the verified original PER REQUEST: the
 * original object is only read (its bytes and SHA-256 never change), and the derived image is streamed to the caller and
 * never stored anywhere (S4 1.3.0 B1, owner decision 7).
 *
 * THE STAMP (S4 patrol assignment correctness, owner-approved 3 Nov 2026; replaces the B2 footer band as the default).
 * A compact, translucent panel in the photo's bottom-left corner carrying, prominently: the security company, the site,
 * the Guard and the device capture time (site time, with its zone abbreviation); then one small line with the patrol
 * reference, the photo number and sfour.co.uk. The server receipt time, the patrol's window and the SHA-256 fingerprint
 * stay in the evidence viewer, beside the photo. No wording implies that a person reviewed the photograph.
 *
 * NOT COVERING EVIDENCE. The panel never covers more than STAMP_MAX_AREA of the photo (sized for the Guard app's 2048 px
 * photos) and never more than about half its width; on a photo too small for a readable panel within those bounds the stamp falls back to a band appended BELOW the
 * photograph (nothing drawn over it), as in B2.
 *
 * TEXT. Inter (SIL Open Font License, @fontsource/inter) is read from the installed package and drawn as SVG paths with
 * opentype.js, so the stamp renders identically on every server (Windows development, the Linux CI runner, the Render
 * image) with no system font, no fontconfig and no network; librsvg (inside sharp) only fills paths. Latin, Latin
 * Extended, Greek, Cyrillic and Vietnamese are covered; any other character is drawn as '?'.
 */

// opentype.js ships no types: the few calls used here.
type OtGlyph = { advanceWidth: number; getPath(x: number, y: number, size: number): { toPathData(decimals: number): string } };
type OtFont = { unitsPerEm: number; ascender: number; descender: number; charToGlyphIndex(ch: string): number; charToGlyph(ch: string): OtGlyph };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const opentype: { loadSync(path: string): OtFont } = require('opentype.js');

const SUBSETS = ['latin', 'latin-ext', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext', 'vietnamese'];
type Weight = 400 | 600;
const fontCache = new Map<Weight, OtFont[]>();
function fonts(weight: Weight): OtFont[] {
  let list = fontCache.get(weight);
  if (!list) {
    list = SUBSETS.map((s) => opentype.loadSync(require.resolve(`@fontsource/inter/files/inter-${s}-${weight}-normal.woff`)));
    fontCache.set(weight, list);
  }
  return list;
}

/** The share of the photo the corner panel may cover at most. */
export const STAMP_MAX_AREA = 0.1;
/** The panel's widest extent, as a share of the photo's width (landscape; a portrait photo allows more). */
const MAX_WIDTH_LANDSCAPE = 0.45;
const MAX_WIDTH_PORTRAIT = 0.62;
/** The smallest text drawn (px); below it the stamp moves to a band under the photo. */
const MIN_FONT_PX = 12;

/** Printable text: control characters removed, whitespace collapsed, at most `max` characters. */
export function stampText(value: string, max = 80): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export type StampFields = {
  companyName: string;
  clientName: string | null;
  siteName: string;
  guardName: string;
  capturedAtDevice: Date | null;
  receivedAtServer: Date | null;
  timeZone: string;
  runId: number;
  evidenceId?: number | null;
  window: { start: Date; end: Date; name: string | null } | null;
};

/** "03 Nov 2026 10:10:32 GMT" in the site's zone (the zone's own abbreviation, e.g. GMT / BST). */
export function stampTime(at: Date | null, timeZone: string): string {
  if (!at) return 'not recorded';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).formatToParts(at);
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    return `${p('day')} ${p('month')} ${p('year')} ${p('hour')}:${p('minute')}:${p('second')} ${p('timeZoneName')}`;
  } catch {
    return `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  }
}

export type StampLine = { text: string; weight: Weight; size: number; color: string };

/**
 * The stamp's lines (pure; what the unit test reads): company, site, Guard, device capture time — prominent — and one
 * small reference line. `base` is the body text size in px.
 */
export function stampLines(f: StampFields, base = 16): StampLine[] {
  const ref = [`Patrol P-${f.runId}`, f.evidenceId != null ? `Photo #${f.evidenceId}` : null, 'sfour.co.uk'].filter(Boolean).join('  ·  ');
  return [
    { text: stampText(f.companyName) || 'Security company', weight: 600, size: Math.round(base * 1.12), color: '#FFFFFF' },
    { text: stampText(f.siteName), weight: 600, size: base, color: '#FFFFFF' },
    { text: stampText(f.guardName), weight: 400, size: base, color: '#E2E8F0' },
    { text: `${stampTime(f.capturedAtDevice, f.timeZone)}  ·  device time`, weight: 400, size: base, color: '#E2E8F0' },
    { text: ref, weight: 400, size: Math.max(MIN_FONT_PX - 1, Math.round(base * 0.74)), color: '#99F6E4' },
  ];
}

/** A glyph from the first subset that has it ('?' otherwise). */
function glyphFor(ch: string, weight: Weight): { font: OtFont; glyph: OtGlyph } {
  for (const font of fonts(weight)) if (font.charToGlyphIndex(ch) > 0) return { font, glyph: font.charToGlyph(ch) };
  const font = fonts(weight)[0];
  return { font, glyph: font.charToGlyph('?') };
}

/** The width of `text` at `size` px. */
export function measureText(text: string, weight: Weight, size: number): number {
  let w = 0;
  for (const ch of [...text]) { const { font, glyph } = glyphFor(ch, weight); w += (glyph.advanceWidth / font.unitsPerEm) * size; }
  return w;
}

/** `text` shortened with "…" to fit `maxWidth` px. */
export function fitText(text: string, weight: Weight, size: number, maxWidth: number): string {
  if (measureText(text, weight, size) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && measureText(`${chars.join('').trimEnd()}…`, weight, size) > maxWidth) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** One line of text as SVG path data, baseline at (x, y). */
export function textPathData(text: string, weight: Weight, size: number, x: number, y: number): string {
  let pen = x;
  const out: string[] = [];
  for (const ch of [...text]) {
    const { font, glyph } = glyphFor(ch, weight);
    const d = glyph.getPath(pen, y, size).toPathData(2);
    if (d) out.push(d);
    pen += (glyph.advanceWidth / font.unitsPerEm) * size;
  }
  return out.join('');
}

export type StampLayout = {
  mode: 'overlay' | 'band';
  /** The panel (overlay) or the band (below the photo), in the output image's pixels. */
  box: { x: number; y: number; width: number; height: number };
  base: number;
  lines: StampLine[];
  svg: string;
};

const PANEL_FILL = '#0B1F33';
const ACCENT = '#14B8A6';

function block(lines: StampLine[], base: number) {
  const pad = Math.round(base * 0.75);
  const gap = Math.round(base * 0.28);
  const heights = lines.map((l) => Math.round(l.size * 1.22));
  const textHeight = heights.reduce((a, b) => a + b, 0) + gap * (lines.length - 1);
  return { pad, gap, heights, height: textHeight + pad * 2, accent: Math.max(3, Math.round(base * 0.22)) };
}

function linesSvg(lines: StampLine[], heights: number[], gap: number, x: number, top: number): string {
  let y = top;
  const parts: string[] = [];
  lines.forEach((l, i) => {
    const baseline = y + Math.round(l.size * 0.98);
    parts.push(`<path d="${textPathData(l.text, l.weight, l.size, x, baseline)}" fill="${l.color}"/>`);
    y += heights[i] + gap;
  });
  return parts.join('');
}

/**
 * The stamp for an upright photo `width` × `height` (pure). Overlay: the panel's text size follows the photo's shorter
 * side and shrinks until the panel fits STAMP_MAX_AREA and the width bound; when even MIN_FONT_PX does not fit, a band
 * the photo's width is laid out to go BELOW the photo instead.
 */
export function stampLayout(width: number, height: number, fields: StampFields): StampLayout {
  const short = Math.min(width, height);
  const maxWidth = width * (height > width ? MAX_WIDTH_PORTRAIT : MAX_WIDTH_LANDSCAPE);
  const margin = Math.max(6, Math.round(short * 0.025));
  for (let base = Math.max(MIN_FONT_PX, Math.min(44, Math.round(short * 0.022))); base >= MIN_FONT_PX; base -= 1) {
    const b = block(stampLines(fields, base), base);
    const textMax = Math.floor(maxWidth - b.pad * 2 - b.accent);
    if (textMax < base * 6) continue;
    const lines = stampLines(fields, base).map((l) => ({ ...l, text: fitText(l.text, l.weight, l.size, textMax) }));
    const textWidth = Math.ceil(Math.max(...lines.map((l) => measureText(l.text, l.weight, l.size))));
    const panel = { width: textWidth + b.pad * 2 + b.accent, height: b.height };
    if (panel.width > maxWidth || (panel.width * panel.height) / (width * height) > STAMP_MAX_AREA) continue;
    const box = { x: margin, y: height - margin - panel.height, width: panel.width, height: panel.height };
    const r = Math.round(base * 0.45);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${r}" ry="${r}" fill="${PANEL_FILL}" fill-opacity="0.82"/>`
      + `<rect x="${box.x}" y="${box.y + r}" width="${b.accent}" height="${box.height - 2 * r}" fill="${ACCENT}"/>`
      + linesSvg(lines, b.heights, b.gap, box.x + b.accent + b.pad, box.y + b.pad)
      + '</svg>';
    return { mode: 'overlay', box, base, lines, svg };
  }
  // Too small for a corner panel: a band of the photo's width, drawn below it.
  const base = Math.max(MIN_FONT_PX, Math.min(28, Math.round(width * 0.04)));
  const b = block(stampLines(fields, base), base);
  const lines = stampLines(fields, base).map((l) => ({ ...l, text: fitText(l.text, l.weight, l.size, Math.max(base * 4, width - b.pad * 2 - b.accent)) }));
  const box = { x: 0, y: height, width, height: b.height };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${box.height}" viewBox="0 0 ${width} ${box.height}">`
    + `<rect x="0" y="0" width="${width}" height="${box.height}" fill="${PANEL_FILL}"/>`
    + `<rect x="0" y="0" width="${b.accent}" height="${box.height}" fill="${ACCENT}"/>`
    + linesSvg(lines, b.heights, b.gap, b.accent + b.pad, b.pad)
    + '</svg>';
  return { mode: 'band', box, base, lines, svg };
}

/**
 * The stamped JPEG of an original photo (EXIF orientation applied, all metadata dropped). Overlay: the upright photo at
 * its full size with the corner panel composited on it. Band: the photo untouched with the band appended below it.
 * Throws when sharp cannot decode the original (the caller answers 422).
 */
export async function renderStampedJpeg(original: Buffer, fields: StampFields): Promise<{ jpeg: Buffer; width: number; height: number; bandHeight: number; layout: StampLayout }> {
  const options = { failOn: 'error' as const, limitInputPixels: 100_000_000 };
  const meta = await sharp(original, options).metadata();
  if (!meta.width || !meta.height) throw new Error('undecodable image');
  // EXIF orientations 5–8 swap the axes once applied (rotate() below applies the orientation, then the stamp).
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  const layout = stampLayout(width, height, fields);
  const oriented = await sharp(original, options).rotate().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels } };
  const bandHeight = layout.mode === 'band' ? layout.box.height : 0;
  const base = layout.mode === 'band'
    ? sharp(oriented.data, raw).extend({ top: 0, left: 0, right: 0, bottom: bandHeight, background: { r: 11, g: 31, b: 51, alpha: 1 } })
      .composite([{ input: Buffer.from(layout.svg), top: height, left: 0 }])
    : sharp(oriented.data, raw).composite([{ input: Buffer.from(layout.svg), top: 0, left: 0 }]);
  const jpeg = await base.flatten({ background: { r: 11, g: 31, b: 51 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  return { jpeg, width, height, bandHeight, layout };
}
