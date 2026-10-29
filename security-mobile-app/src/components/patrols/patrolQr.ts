// Checkpoint QR labels (Patrols P1-D). The label payload is SIGNED BY THE SERVER (GET /patrols/checkpoints/:id/label,
// s4cp:1:<keyId>:<publicId>:<tokenVersion>:<mac>) and only ENCODED here: this module draws the payload it is given as
// a QR code and never builds, alters or signs one. The signing key never reaches the client.
//
// Encoder: qrcode-generator 1.4.4 (MIT, no dependencies, pure JavaScript, published 2019), pinned exactly. It works the
// same on web and native because the QR is drawn from its module matrix, not from a canvas.

import qrcode from 'qrcode-generator';
import { escapeHtml } from '../company/incidentReportPrint';

/** The shape of a server-issued label. Checked only so a wrong value is never printed; the server verifies the MAC. */
const SERVER_LABEL = /^s4cp:1:[A-Za-z0-9]{1,16}:[0-9a-f]{32}:\d{1,9}:[A-Za-z0-9_-]{16,}$/;

export function isServerLabelPayload(payload: unknown): payload is string {
  return typeof payload === 'string' && payload.length <= 256 && SERVER_LABEL.test(payload);
}

/** The QR module matrix (true = dark) for a server-issued payload; null when the payload is not one. Error correction M. */
export function qrMatrix(payload: string): boolean[][] | null {
  if (!isServerLabelPayload(payload)) return null;
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** An SVG of the QR code (quiet zone of 4 modules), for the printed sheet. Null when the payload is not a server label. */
export function qrSvg(payload: string, sizePx = 180): string | null {
  const matrix = qrMatrix(payload);
  if (!matrix) return null;
  const quiet = 4;
  const n = matrix.length + quiet * 2;
  let path = '';
  matrix.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + quiet} ${r + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="Checkpoint QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export type PrintableLabel = { label: string; siteName: string; payload: string; tokenVersion: number; checkpointId: number };

/**
 * The printable A4 label sheet. Contains the checkpoint name, site, label version and the QR — no navigation, no
 * controls, no identifier beyond what the printed label needs. The payload itself is not printed as text (the QR
 * carries it). Labels whose payload is not a server label are left out, never "fixed".
 */
export function renderLabelSheetHtml(labels: PrintableLabel[], options: { companyName?: string | null; generatedAt: string }): string {
  const cells = labels
    .map((l) => ({ l, svg: qrSvg(l.payload, 180) }))
    .filter((x): x is { l: PrintableLabel; svg: string } => Boolean(x.svg))
    .map(({ l, svg }) => `
      <div class="label">
        <div class="qr">${svg}</div>
        <div class="name">${escapeHtml(l.label)}</div>
        <div class="site">${escapeHtml(l.siteName)}</div>
        <div class="meta">S4 patrol checkpoint · label v${escapeHtml(String(l.tokenVersion))}</div>
      </div>`)
    .join('');
  const company = (options.companyName || '').trim();
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>S4 checkpoint labels</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #102536; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0B1F33; padding-bottom: 6px; margin-bottom: 10px; }
  header h1 { font-size: 16px; margin: 0; color: #0B1F33; }
  header .gen { font-size: 11px; color: #5B6B7A; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; }
  .label { border: 1px dashed #9AAABA; border-radius: 6px; padding: 6mm 4mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .qr svg { width: 42mm; height: 42mm; }
  .name { font-size: 14px; font-weight: 700; margin-top: 3mm; }
  .site { font-size: 12px; color: #5B6B7A; }
  .meta { font-size: 10px; color: #748392; margin-top: 2mm; }
  .note { font-size: 10px; color: #5B6B7A; margin-top: 8mm; }
</style></head>
<body>
  <header><h1>${company ? `${escapeHtml(company)} · ` : ''}Patrol checkpoint labels</h1><span class="gen">Printed ${escapeHtml(options.generatedAt)}</span></header>
  <div class="grid">${cells}</div>
  <p class="note">Scanning a label records that the label was scanned. Reprinting a label (rotate) makes earlier copies invalid.</p>
</body></html>`;
}
