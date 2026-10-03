// The printed Incident Report: a self-contained A4 document, built from the same view model.
//
// WHY A SEPARATE DOCUMENT AND NOT `@media print` ON THE APP. The control room is a single-page app
// whose body is a deep tree of generated class names; hiding "everything except the report" with
// print rules means trusting that no dashboard chrome, drawer backdrop or fixed rail survives into
// the page a client receives. Writing a purpose-built document instead makes the exclusion
// structural: the navigation, the Attention Now rail, the filters and the audit JSON are not hidden
// from the printout, they were never in it.
//
// No PDF library and no backend service: the browser's own print-to-PDF produces the file, which is
// the whole point of a clean A4 layout.
//
// It is a pure string function, so what the client receives is asserted directly in tests.

import type { IncidentReportModel } from './incidentReport';

/** HTML-escape. Every value here is operational free text and none of it may become markup. */
export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Free text with its line breaks kept, escaped first. */
function paragraphs(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

export type PrintOptions = {
  /**
   * The guarding company, when the caller knows it better than the incident does.
   *
   * Normally omitted: the model already carries the company from the incident's own record, and
   * that is the authoritative answer to "whose report is this?".
   */
  companyName?: string;
  /** When the document was produced, already formatted. */
  generatedAt: string;
};

/**
 * The A4 document.
 *
 * Deliberately contains: S4 branding, the incident reference, client, site, guard, shift, reported
 * time, severity, category, the guard's original report, genuine evidence, the handling timeline,
 * the resolution evidence, and when the report was generated.
 *
 * Deliberately contains NOTHING else — no navigation, no controls, no filters, no raw audit JSON, no
 * tokens or signed URLs beyond an evidence file's own existing link, and no internal identifiers
 * that mean nothing to a client.
 */
export function renderIncidentReportHtml(
  model: IncidentReportModel,
  options: PrintOptions,
): string {
  /**
   * The guarding company, or nothing.
   *
   * S4 is the platform the report was produced with, which the footer says separately — it is NOT
   * necessarily the company guarding the client's site, so its name is never substituted here. When
   * the record does not name a company, that side of the footer is simply left empty.
   */
  const company = (options.companyName || model.companyName || '').trim();

  const overviewRows = model.overview
    .map((field) => `
        <tr>
          <th scope="row">${escapeHtml(field.label)}</th>
          <td>${escapeHtml(field.value)}</td>
        </tr>`)
    .join('');

  const evidenceBlock = model.evidence.length
    ? `<div class="evidence">${model.evidence.map((item) => (item.isImage
        ? `<figure class="shot">
             <img src="${escapeHtml(item.fileUrl)}" alt="${escapeHtml(item.fileName)}">
             <figcaption>${escapeHtml(item.fileName)}${item.size ? ` · ${escapeHtml(item.size)}` : ''}</figcaption>
           </figure>`
        : `<p class="file">${escapeHtml(item.fileName)}${item.size ? ` · ${escapeHtml(item.size)}` : ''}</p>`
      )).join('')}</div>`
    : '<p class="absent">No evidence attached.</p>';

  const handlingBlock = model.handling.length
    ? `<ol class="timeline">${model.handling.map((entry) => `
        <li>
          <p class="event">${escapeHtml(entry.label)}</p>
          <p class="when">${escapeHtml(entry.at)}</p>
          ${entry.actor ? `<p class="who">By ${escapeHtml(entry.actor)}</p>` : ''}
        </li>`).join('')}</ol>`
    : '<p class="absent">No handling history recorded.</p>';

  const resolutionBlock = model.resolution.recorded
    ? `<table class="fields">
         ${model.resolution.reason ? `<tr><th scope="row">Resolution reason</th><td>${escapeHtml(model.resolution.reason)}</td></tr>` : ''}
         ${model.resolution.by ? `<tr><th scope="row">Resolved by</th><td>${escapeHtml(model.resolution.by)}</td></tr>` : ''}
         ${model.resolution.at ? `<tr><th scope="row">Resolved at</th><td>${escapeHtml(model.resolution.at)}</td></tr>` : ''}
       </table>
       ${model.resolution.note
         ? `<p class="sub-label">Resolution note</p><p class="body">${paragraphs(model.resolution.note)}</p>`
         : ''}`
    : '<p class="absent">No resolution evidence recorded.</p>';

  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>Incident Report ${escapeHtml(model.reference)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #102536; font-size: 11pt; line-height: 1.45;
    max-width: 180mm; margin: 0 auto; padding: 10mm 0;
  }
  header { display: flex; align-items: flex-start; justify-content: space-between;
           border-bottom: 3px solid #0B1F33; padding-bottom: 8pt; margin-bottom: 14pt; }
  .brand { font-size: 22pt; font-weight: 800; color: #0B1F33; letter-spacing: -0.5pt; line-height: 1; }
  .brand span { color: #16A6A1; }
  .brand-sub { font-size: 8pt; color: #5B6B7A; letter-spacing: 1pt; text-transform: uppercase; margin-top: 3pt; }
  .doc { text-align: right; }
  .doc h1 { font-size: 13pt; font-weight: 800; margin: 0; letter-spacing: 0.5pt; text-transform: uppercase; }
  .doc .ref { font-size: 18pt; font-weight: 800; color: #0B1F33; margin: 2pt 0 0; }
  .badge { display: inline-block; margin-top: 4pt; padding: 2pt 8pt; border: 1pt solid #0B1F33;
           border-radius: 3pt; font-size: 8.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6pt; }
  h2 { font-size: 9pt; font-weight: 800; text-transform: uppercase; letter-spacing: 1pt;
       color: #0B1F33; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1pt solid #D7E0E8; }
  section { page-break-inside: avoid; }
  table.fields { width: 100%; border-collapse: collapse; }
  table.fields th { text-align: left; font-weight: 700; color: #5B6B7A; width: 42mm;
                    padding: 3.5pt 8pt 3.5pt 0; vertical-align: top; font-size: 10pt; }
  table.fields td { padding: 3.5pt 0; vertical-align: top; }
  table.fields tr + tr th, table.fields tr + tr td { border-top: 0.5pt solid #EAF0F5; }
  .body { white-space: pre-wrap; margin: 0; padding: 7pt 9pt; border: 0.75pt solid #D7E0E8;
          border-left: 2.5pt solid #16A6A1; background: #FAFCFD; border-radius: 2pt; }
  .absent { margin: 0; padding: 7pt 9pt; border: 0.75pt dashed #D7E0E8; border-radius: 2pt;
            color: #5B6B7A; font-style: italic; }
  ol.timeline { list-style: none; margin: 0; padding: 0; }
  ol.timeline li { padding: 0 0 7pt 11pt; border-left: 1.5pt solid #D7E0E8; margin-left: 3pt; position: relative; }
  ol.timeline li:last-child { padding-bottom: 0; }
  ol.timeline li::before { content: ""; position: absolute; left: -4.5pt; top: 3pt; width: 7.5pt; height: 7.5pt;
                           border-radius: 50%; background: #16A6A1; border: 1.5pt solid #FFFFFF; }
  ol.timeline p { margin: 0; }
  ol.timeline .event { font-weight: 700; }
  ol.timeline .when { color: #102536; }
  ol.timeline .who { color: #5B6B7A; font-size: 9.5pt; }
  .evidence { display: flex; flex-wrap: wrap; gap: 6pt; align-items: flex-start; }
  .shot { margin: 0; width: 56mm; }
  .shot img { width: 100%; border: 0.75pt solid #D7E0E8; border-radius: 2pt; }
  .shot figcaption { font-size: 8.5pt; color: #5B6B7A; margin-top: 2pt; }
  /* A document is a named row, not a picture frame: it must not stretch to a photograph's height. */
  .file { margin: 0; padding: 5pt 8pt; border: 0.75pt solid #D7E0E8; border-radius: 2pt;
          font-size: 10pt; align-self: flex-start; }
  .sub-label { font-size: 9pt; font-weight: 700; color: #5B6B7A; margin: 8pt 0 3pt; }
  footer { margin-top: 18pt; padding-top: 6pt; border-top: 0.75pt solid #D7E0E8;
           font-size: 8.5pt; color: #5B6B7A; display: flex; justify-content: space-between;
           align-items: flex-end; }
  .foot-left { display: flex; flex-direction: column; gap: 1pt; }
  .foot-company { font-weight: 700; color: #102536; font-size: 9.5pt; }
  .foot-platform { font-size: 8pt; }
  @media print { body { padding: 0; } .noprint { display: none !important; } }
</style></head>
<body>
  <header>
    <div>
      <div class="brand">S<span>4</span></div>
      <div class="brand-sub">Sites · Shifts · Staff · Security</div>
    </div>
    <div class="doc">
      <h1>Incident Report</h1>
      <p class="ref">${escapeHtml(model.reference)}</p>
      <span class="badge">${escapeHtml(model.statusLabel)}</span>
    </div>
  </header>

  <section>
    <h2>Overview</h2>
    <table class="fields">${overviewRows}</table>
  </section>

  <section>
    <h2>Original report</h2>
    ${model.originalReport
      ? `<p class="body">${paragraphs(model.originalReport)}</p>`
      : '<p class="absent">No report text was recorded.</p>'}
  </section>

  <section>
    <h2>Evidence</h2>
    ${evidenceBlock}
  </section>

  <section>
    <h2>Handling history</h2>
    ${handlingBlock}
  </section>

  <section>
    <h2>Resolution</h2>
    ${resolutionBlock}
  </section>

  <footer>
    <div class="foot-left">
      ${company ? `<span class="foot-company">${escapeHtml(company)}</span>` : ''}
      <span class="foot-platform">Generated using S4</span>
    </div>
    <span>Report generated ${escapeHtml(options.generatedAt)}</span>
  </footer>
</body></html>`;
}

/**
 * Hand the document to the browser's own print dialogue.
 *
 * Same-origin `about:blank`, written and printed in place — no network request, no upload, and the
 * report never leaves the authenticated session. Returns false when the browser refused the window
 * (a pop-up blocker), so the caller can say so rather than appearing to do nothing.
 */
export function printIncidentReport(html: string): boolean {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;
  /**
   * NO `noopener` HERE, AND THAT IS NOT AN OVERSIGHT.
   *
   * `window.open()` with `noopener` is specified to return null — the whole point of the flag is to
   * sever the handle. Chrome does exactly that: with pop-up blocking disabled, so the flag is the
   * only variable, `window.open('', '_blank', 'noopener,…')` returns null while the same call
   * without it returns a window whose document can be written. The browser still opens the tab, so
   * the report was never written into it and a client saw a blank page. That was UAT FIX 01.
   *
   * Nothing is given up by omitting it. The window is `about:blank` on this origin, it is never
   * navigated anywhere, and the only thing written into it is the document built below — there is no
   * cross-origin page to protect an opener reference from.
   */
  const frame = window.open('', '_blank', 'width=900,height=1200');
  if (!frame) return false;

  frame.document.open();
  frame.document.write(html);
  frame.document.close();

  // Let the document lay out (and any evidence image load) before the dialogue measures the pages.
  const run = () => {
    try {
      frame.focus();
      frame.print();
    } catch {
      /* The user closed the window before printing. Nothing to recover. */
    }
  };
  if (frame.document.readyState === 'complete') setTimeout(run, 150);
  else frame.addEventListener('load', () => setTimeout(run, 150));

  return true;
}
