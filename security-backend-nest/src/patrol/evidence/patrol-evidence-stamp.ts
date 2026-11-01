import sharp = require('sharp');

/**
 * Stamped patrol photos (S4 1.3.0 B1, owner decision 7). GET /patrols/evidence/:id/stamped derives a JPEG from the
 * verified original PER REQUEST: the original object is only read (its bytes and SHA-256 never change), and the derived
 * image is streamed to the caller and never stored anywhere.
 *
 * TEXT WITHOUT FONTS. The stamp's text is drawn from an embedded 5 × 7 bitmap font as SVG paths, so it renders the same
 * on every server (Windows development, the Linux CI runner, the Render Node image) with no installed font, no
 * fontconfig and no network: librsvg (inside sharp) only fills rectangles. Characters outside printable ASCII are
 * transliterated (accents dropped, dashes and quotes simplified) or shown as '?'.
 *
 * The stamp is a SEPARATE footer band appended BELOW the photograph (S4 1.3.0 B2 correction): the output is the upright
 * original (EXIF orientation applied) at its full size, untouched, with a dark band of the same width added underneath —
 * nothing is drawn over the picture. The band carries:
 *   the security company's name (large),
 *   Client · Site, Guard (display name),
 *   "Captured (device)" and "Received by S4 (server)" — two clearly different times, in the SITE's time zone with the
 *   zone's abbreviation, and the zone named on the last line,
 *   the patrol reference (P-{runId}) and its window,
 *   www.sfour.co.uk.
 */

/** 5 × 7 glyphs, rows top to bottom, '#' = ink. Printable ASCII. */
const GLYPHS: Record<string, string> = {
  ' ': '.....|.....|.....|.....|.....|.....|.....',
  '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '"': '.#.#.|.#.#.|.#.#.|.....|.....|.....|.....',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  '$': '..#..|.####|#.#..|.###.|..#.#|####.|..#..',
  '%': '##...|##..#|...#.|..#..|.#...|#..##|...##',
  '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#',
  "'": '..#..|..#..|..#..|.....|.....|.....|.....',
  '(': '...#.|..#..|.#...|.#...|.#...|..#..|...#.',
  ')': '.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '*': '.....|..#..|#.#.#|.###.|#.#.#|..#..|.....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '/': '.....|....#|...#.|..#..|.#...|#....|.....',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '#####|...#.|..#..|...#.|....#|#...#|.###.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  ';': '.....|.##..|.##..|.....|.##..|..#..|.#...',
  '<': '...#.|..#..|.#...|#....|.#...|..#..|...#.',
  '=': '.....|.....|#####|.....|#####|.....|.....',
  '>': '.#...|..#..|...#.|....#|...#.|..#..|.#...',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  '@': '.###.|#...#|....#|.##.#|#.#.#|#.#.#|.###.',
  'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
  'C': '.###.|#...#|#....|#....|#....|#...#|.###.',
  'D': '###..|#..#.|#...#|#...#|#...#|#..#.|###..',
  'E': '#####|#....|#....|####.|#....|#....|#####',
  'F': '#####|#....|#....|####.|#....|#....|#....',
  'G': '.###.|#...#|#....|#.###|#...#|#...#|.####',
  'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  'J': '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  'L': '#....|#....|#....|#....|#....|#....|#####',
  'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  'N': '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  'P': '####.|#...#|#...#|####.|#....|#....|#....',
  'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  'S': '.####|#....|#....|.###.|....#|....#|####.',
  'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  'W': '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
  '[': '.###.|.#...|.#...|.#...|.#...|.#...|.###.',
  '\\': '.....|#....|.#...|..#..|...#.|....#|.....',
  ']': '.###.|...#.|...#.|...#.|...#.|...#.|.###.',
  '^': '..#..|.#.#.|#...#|.....|.....|.....|.....',
  '_': '.....|.....|.....|.....|.....|.....|#####',
  '`': '.#...|..#..|...#.|.....|.....|.....|.....',
  'a': '.....|.....|.###.|....#|.####|#...#|.####',
  'b': '#....|#....|#.##.|##..#|#...#|#...#|####.',
  'c': '.....|.....|.###.|#....|#....|#...#|.###.',
  'd': '....#|....#|.##.#|#..##|#...#|#...#|.####',
  'e': '.....|.....|.###.|#...#|#####|#....|.###.',
  'f': '..##.|.#..#|.#...|###..|.#...|.#...|.#...',
  'g': '.....|.####|#...#|#...#|.####|....#|.###.',
  'h': '#....|#....|#.##.|##..#|#...#|#...#|#...#',
  'i': '..#..|.....|.##..|..#..|..#..|..#..|.###.',
  'j': '...#.|.....|..##.|...#.|...#.|#..#.|.##..',
  'k': '#....|#....|#..#.|#.#..|##...|#.#..|#..#.',
  'l': '.##..|..#..|..#..|..#..|..#..|..#..|.###.',
  'm': '.....|.....|##.#.|#.#.#|#.#.#|#...#|#...#',
  'n': '.....|.....|#.##.|##..#|#...#|#...#|#...#',
  'o': '.....|.....|.###.|#...#|#...#|#...#|.###.',
  'p': '.....|.....|####.|#...#|####.|#....|#....',
  'q': '.....|.....|.##.#|#..##|.####|....#|....#',
  'r': '.....|.....|#.##.|##..#|#....|#....|#....',
  's': '.....|.....|.###.|#....|.###.|....#|####.',
  't': '.#...|.#...|###..|.#...|.#...|.#..#|..##.',
  'u': '.....|.....|#...#|#...#|#...#|#..##|.##.#',
  'v': '.....|.....|#...#|#...#|#...#|.#.#.|..#..',
  'w': '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.',
  'x': '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#',
  'y': '.....|.....|#...#|#...#|.####|....#|.###.',
  'z': '.....|.....|#####|...#.|..#..|.#...|#####',
  '{': '...#.|..#..|..#..|.#...|..#..|..#..|...#.',
  '|': '..#..|..#..|..#..|..#..|..#..|..#..|..#..',
  '}': '.#...|..#..|..#..|...#.|..#..|..#..|.#...',
  '~': '.....|.....|.#...|#.#.#|...#.|.....|.....',
};
const GLYPH_ROWS: Record<string, string[]> = Object.fromEntries(Object.entries(GLYPHS).map(([c, g]) => [c, g.split('|')]));
const CELL_W = 6; // 5 columns + 1 of spacing
const CELL_H = 9; // 7 rows + 2 of leading
export const STAMP_MAX_LINE_CHARS = 72;

/** Printable ASCII only: accents dropped, typographic dashes / quotes simplified, anything else '?'. */
export function stampText(value: string): string {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―−]/g, '-').replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"')
    .replace(/[·•]/g, '-').replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .trim();
}

function clip(text: string, max = STAMP_MAX_LINE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
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
  window: { start: Date; end: Date; name: string | null } | null;
};

/** "01 Nov 2026 14:32:05 GMT" in the site's zone (the zone's own abbreviation, e.g. GMT / BST). */
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

function hhmm(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** The stamp's text, title first (pure; what the unit test reads). */
export function stampLines(f: StampFields): { title: string; lines: string[] } {
  const window = f.window
    ? `Window ${hhmm(f.window.start, f.timeZone)}-${hhmm(f.window.end, f.timeZone)}${f.window.name ? ` (${f.window.name})` : ''}`
    : 'Unscheduled patrol';
  return {
    title: clip(stampText(f.companyName) || 'Security company', 48),
    lines: [
      `Client: ${f.clientName ? f.clientName : '-'}  |  Site: ${f.siteName}`,
      `Guard: ${f.guardName}`,
      `Captured (device): ${stampTime(f.capturedAtDevice, f.timeZone)}`,
      `Received by S4 (server): ${stampTime(f.receivedAtServer, f.timeZone)}`,
      `Patrol P-${f.runId}  |  ${window}`,
      `Times in ${f.timeZone}  |  www.sfour.co.uk`,
    ].map((l) => clip(stampText(l))),
  };
}

/** One line of text as an SVG path of filled cells (horizontal runs merged), top-left at (x, y), `scale` px per cell. */
export function textPath(text: string, x: number, y: number, scale: number): string {
  const out: string[] = [];
  [...stampText(text)].forEach((ch, i) => {
    const rows = GLYPH_ROWS[ch] ?? GLYPH_ROWS['?'];
    const gx = x + i * CELL_W * scale;
    rows.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        if (row[c] !== '#') { c += 1; continue; }
        let end = c;
        while (end < row.length && row[end] === '#') end += 1;
        out.push(`M${gx + c * scale} ${y + r * scale}h${(end - c) * scale}v${scale}h${-(end - c) * scale}z`);
        c = end;
      }
    });
  });
  return out.join('');
}

/** Splits one line into pieces of at most `max` characters, at " | " or spaces where possible (pure). */
export function wrapStampLine(line: string, max: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const at = Math.max(window.lastIndexOf(' |'), window.lastIndexOf(' '));
    const cut = at > Math.floor(max / 3) ? at : max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s*\|?\s*/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

/**
 * The footer band for an upright photo `width` × `height`: an SVG exactly `width` × `bandHeight`, drawn BELOW the photo.
 * Text scales with the photo's width (whole pixels per font cell, so it stays crisp); on a narrow photo long lines wrap
 * rather than being cut. The band is at most about half the photo's height for a large photo, never less than one
 * readable scale.
 */
export function stampSvg(width: number, height: number, stamp: { title: string; lines: string[] }): { svg: string; bandHeight: number; scale: number; lines: string[] } {
  const usable = Math.max(CELL_W, Math.floor(width * 0.94));
  const longest = Math.max(...stamp.lines.map((l) => l.length), 1);
  let scale = Math.max(1, Math.floor(usable / (longest * CELL_W)));
  const maxChars = (s: number) => Math.max(8, Math.floor(usable / (CELL_W * s)));
  const layout = (s: number) => {
    const lines = stamp.lines.flatMap((l) => wrapStampLine(l, maxChars(s)));
    const titleScale = Math.max(s, Math.min(2 * s, Math.floor(usable / (Math.max(stamp.title.length, 1) * CELL_W))));
    const title = wrapStampLine(stamp.title, maxChars(titleScale));
    const bandHeight = Math.ceil(title.length * CELL_H * titleScale + lines.length * CELL_H * s + 4 * s);
    return { lines, title, titleScale, bandHeight };
  };
  let fit = layout(scale);
  while (scale > 1 && fit.bandHeight > Math.max(height * 0.5, 120)) { scale -= 1; fit = layout(scale); }
  const pad = Math.max(2, Math.floor(width * 0.03));
  let y = 2 * scale;
  const paths: string[] = [];
  for (const t of fit.title) { paths.push(textPath(t, pad, y, fit.titleScale)); y += CELL_H * fit.titleScale; }
  for (const line of fit.lines) { paths.push(textPath(line, pad, y, scale)); y += CELL_H * scale; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fit.bandHeight}" viewBox="0 0 ${width} ${fit.bandHeight}">`
    + `<rect x="0" y="0" width="${width}" height="${fit.bandHeight}" fill="#0B1F33"/>`
    + `<path d="${paths.join('')}" fill="#FFFFFF"/>`
    + '</svg>';
  return { svg, bandHeight: fit.bandHeight, scale, lines: [...fit.title, ...fit.lines] };
}

/**
 * The stamped JPEG of an original photo (EXIF orientation applied, all metadata dropped): the upright photo at its full
 * size with the footer band appended below it, so the output is width × (height + bandHeight) and the photograph is
 * entirely visible. `width` / `height` are the PHOTO's (upright); `bandHeight` is the band's. Throws when sharp cannot
 * decode the original (the caller answers 422).
 */
export async function renderStampedJpeg(original: Buffer, fields: StampFields): Promise<{ jpeg: Buffer; width: number; height: number; bandHeight: number }> {
  const options = { failOn: 'error' as const, limitInputPixels: 100_000_000 };
  const meta = await sharp(original, options).metadata();
  if (!meta.width || !meta.height) throw new Error('undecodable image');
  // EXIF orientations 5–8 swap the axes once applied (rotate() below applies the orientation, then the overlay).
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  const { svg, bandHeight } = stampSvg(width, height, stampLines(fields));
  // Upright pixels first (raw, no re-encode), then a canvas extended DOWNWARDS by the band, which is drawn in the new area.
  const oriented = await sharp(original, options).rotate().raw().toBuffer({ resolveWithObject: true });
  const jpeg = await sharp(oriented.data, { raw: { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels } })
    .extend({ top: 0, left: 0, right: 0, bottom: bandHeight, background: { r: 11, g: 31, b: 51, alpha: 1 } })
    .composite([{ input: Buffer.from(svg), top: height, left: 0 }])
    .flatten({ background: { r: 11, g: 31, b: 51 } })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, width, height, bandHeight };
}
