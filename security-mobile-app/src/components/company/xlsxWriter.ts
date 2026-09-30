// A minimal XLSX writer. (Phase 4A.2.)
//
// WHY THIS IS NOT A DEPENDENCY
// Neither project had a spreadsheet library, so one would have had to be added to a release branch whose
// bundle ships inside the Guard's APK as well as the company web app. The two obvious candidates were
// worse than this file:
//
//   xlsx (SheetJS) — the version on npm is 0.18.5, which carries a published prototype-pollution advisory
//   (CVE-2023-30533). The fixed releases are distributed from the vendor's own CDN and are not on npm, so
//   `npm i xlsx` installs the vulnerable one and `npm audit` reports it on every CI run.
//
//   exceljs — well maintained, but stream- and Node-oriented and well over a megabyte, for a feature only
//   the company web surface uses. It would be carried in the Guard app for nothing.
//
// What the export actually needs is narrow: two sheets of inline strings, no formulas, no styling, no
// dates-as-serials, no shared-string table. That is a few hundred lines of well-understood XML plus a
// store-only ZIP, and it is covered by executable tests down to the ZIP structure and the CRC. A
// dependency would have been more code, not less — and a worse security posture.
//
// STORE-ONLY, NO COMPRESSION
// The ZIP entries are written with method 0 (stored). Excel accepts it, and it means no deflate
// implementation and no correctness risk from one. An operations report is tens of kilobytes.

/** One sheet: a tab name and a grid of already-stringified cells, header row included. */
export type XlsxSheet = {
  name: string;
  rows: readonly (readonly string[])[];
};

// ─── XML ──────────────────────────────────────────────────────────────────────

/**
 * Escapes text for XML content.
 *
 * Also strips the control characters XML 1.0 forbids outright. A guard name pasted from elsewhere can
 * carry one, and a single stray 0x0B makes the whole workbook unopenable — Excel reports corruption, not
 * a bad character.
 */
export function xmlEscape(value: string): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A1, B1 … Z1, AA1 — the spreadsheet column name for a zero-based index. */
export function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * A sheet's XML.
 *
 * Every cell is written as an inline string (`t="inlineStr"`). Numbers are deliberately NOT emitted as
 * numeric cells: a value like a site's name or a leading-zero reference would be silently reinterpreted,
 * and a compliance export must say exactly what it was given. An empty cell is omitted entirely, which is
 * what Excel expects rather than an empty inline string.
 */
export function sheetXml(sheet: XlsxSheet): string {
  const rows = sheet.rows.map((cells, rowIndex) => {
    const r = rowIndex + 1;
    const body = cells
      .map((cell, colIndex) => {
        if (cell === undefined || cell === null || cell === '') return '';
        return `<c r="${columnName(colIndex)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
      })
      .join('');
    return `<row r="${r}">${body}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${rows}</sheetData></worksheet>`;
}

/**
 * A sheet name Excel will accept: 31 characters, and none of : \ / ? * [ ].
 *
 * Excel refuses to open a workbook whose sheet name breaks either rule, so this is a correctness
 * requirement rather than tidiness.
 */
export function sanitiseSheetName(name: string): string {
  const cleaned = String(name ?? 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

function workbookXml(sheets: readonly XlsxSheet[]): string {
  const entries = sheets
    .map((sheet, i) => `<sheet name="${xmlEscape(sanitiseSheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${entries}</sheets></workbook>`;
}

function workbookRelsXml(sheets: readonly XlsxSheet[]): string {
  const entries = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

function contentTypesXml(sheets: readonly XlsxSheet[]): string {
  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `${overrides}</Types>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
  + `</Relationships>`;

// ─── ZIP ──────────────────────────────────────────────────────────────────────

/** CRC-32, table built once. Every ZIP entry carries one and Excel checks it. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** UTF-8 bytes, without depending on TextEncoder being present in every runtime. */
export function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out: number[] = [];
  for (const ch of text) {
    let code = ch.codePointAt(0) as number;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

type ZipEntry = { path: string; data: Uint8Array };

/**
 * A store-only ZIP: local headers, then the central directory, then the end record.
 *
 * Method 0 throughout, so there is no deflate implementation to get wrong. Timestamps are fixed rather
 * than taken from the clock, which makes the same report produce byte-identical output — useful when an
 * export is evidence and someone asks whether two files are the same one.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: number[] = [];
  const central: number[] = [];
  const DOS_TIME = 0;
  const DOS_DATE = 0x2100; // 1 Jan 1980, the ZIP epoch.

  const push = (target: number[], ...bytes: number[]) => target.push(...bytes);
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.path);
    const crc = crc32(entry.data);
    const offset = chunks.length;

    push(chunks, ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0));
    push(chunks, ...u16(DOS_TIME), ...u16(DOS_DATE));
    push(chunks, ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length));
    push(chunks, ...u16(nameBytes.length), ...u16(0));
    push(chunks, ...nameBytes, ...entry.data);

    push(central, ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0));
    push(central, ...u16(DOS_TIME), ...u16(DOS_DATE));
    push(central, ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length));
    push(central, ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0));
    push(central, ...u32(0), ...u32(offset), ...nameBytes);
  }

  const centralOffset = chunks.length;
  const all = chunks.concat(central);
  all.push(...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(centralOffset), ...u16(0));

  return new Uint8Array(all);
}

/** The workbook, as bytes ready to download. */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');
  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: utf8Bytes(contentTypesXml(sheets)) },
    { path: '_rels/.rels', data: utf8Bytes(ROOT_RELS) },
    { path: 'xl/workbook.xml', data: utf8Bytes(workbookXml(sheets)) },
    { path: 'xl/_rels/workbook.xml.rels', data: utf8Bytes(workbookRelsXml(sheets)) },
    ...sheets.map((sheet, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      data: utf8Bytes(sheetXml(sheet)),
    })),
  ];
  return buildZip(entries);
}
