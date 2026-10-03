// The printed Daily Site Log: a self-contained A4 occurrence book for a client.
//
// Same architecture as the Incident Report, for the same reason: a purpose-built document makes the
// exclusions STRUCTURAL. The navigation, the filters, the buttons and the audit payloads are not
// hidden from this page by print rules — they were never rendered into it.
//
// Pure, so what a client receives is asserted directly in tests.

import { escapeHtml } from './incidentReportPrint';
import type { DailySiteLogModel } from './dailySiteLog';

/** Free text with its line breaks kept, escaped first. A Log Book entry is never trusted as markup. */
function paragraphs(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

export type DailySiteLogPrintOptions = {
  /** Already formatted, on the site's clock. */
  generatedAt: string;
};

/**
 * The A4 document.
 *
 * Contains: branding, client, site, date, the attendance summary, the chronological occurrence
 * record with every Log Book entry in full, the Log Book compliance statement, the Welfare summary,
 * the operational counts, and when it was produced.
 *
 * Contains nothing else — no navigation, no controls, no filters, no audit payloads, no tokens, and
 * no internal identifier that means nothing to a client.
 */
export function renderDailySiteLogHtml(
  model: DailySiteLogModel,
  options: DailySiteLogPrintOptions,
): string {
  const company = (model.companyName || '').trim();

  const shiftRows = model.shifts.length
    ? model.shifts.map((shift) => `
        <tr>
          <td>${escapeHtml(shift.guardName)}</td>
          <td>${escapeHtml(shift.scheduled)}</td>
          <td>${escapeHtml(shift.bookOn)}</td>
          <td>${escapeHtml(shift.bookOff)}</td>
          <td>${escapeHtml(shift.state)}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No shifts recorded for this date.</td></tr>';

  const eventRows = model.events.length
    ? model.events.map((event) => `
        <tr class="ev ${escapeHtml(event.kind)}">
          <td class="t">${escapeHtml(event.at)}</td>
          <td class="l">${escapeHtml(event.label)}${event.guardName ? `<span class="who">${escapeHtml(event.guardName)}</span>` : ''}</td>
          <td class="d">${event.detail ? paragraphs(event.detail) : ''}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" class="muted">No occurrences were recorded for this date.</td></tr>';

  /**
   * The compliance statement.
   *
   * An "as required" site is told apart in words. Printing "0 missing" for it would read as a pass
   * against an hourly duty it never carried.
   */
  const compliance = model.logBook.scheduled
    ? `<table class="fields">
         <tr><th scope="row">Log Book requirement</th><td>Every ${escapeHtml(String(model.logBook.intervalMinutes ?? ''))} minutes</td></tr>
         <tr><th scope="row">Required periods</th><td>${model.logBook.required}</td></tr>
         <tr><th scope="row">Completed periods</th><td>${model.logBook.completed}</td></tr>
         <tr><th scope="row">Missing periods</th><td>${model.logBook.missing}</td></tr>
       </table>`
    : `<table class="fields">
         <tr><th scope="row">Log Book requirement</th><td>As required</td></tr>
         <tr><th scope="row">Entries recorded</th><td>${model.logBook.entries}</td></tr>
       </table>
       <p class="muted note">No periodic Log Book obligation applies to this site, so no period can be missing.</p>`;

  /**
   * Outcomes that landed after the report date.
   *
   * Visually separate from the chronology on purpose, and every timestamp carries its own date, so a
   * reader cannot take a later action for one that happened on this day.
   */
  const followUpBlock = model.followUps.length
    ? model.followUps.map((item) => `
        <div class="followup">
          <p class="fu-title">${escapeHtml(item.title)}${item.outstanding ? '<span class="fu-open">Outstanding</span>' : ''}</p>
          <table class="fields">
            ${item.lines.map((line) => `
              <tr><th scope="row">${escapeHtml(line.label)}</th><td>${paragraphs(line.value)}</td></tr>`).join('')}
          </table>
        </div>`).join('')
    : '';

  const welfare = model.welfare.applicable
    ? `<table class="fields">
         <tr><th scope="row">Required</th><td>${model.welfare.required}</td></tr>
         <tr><th scope="row">Completed</th><td>${model.welfare.completed}</td></tr>
         <tr><th scope="row">Missed</th><td>${model.welfare.missed}</td></tr>
       </table>`
    : '<p class="muted note">No Welfare Check obligation applied to this date.</p>';

  return `<!DOCTYPE html>
<html lang="en-GB"><head><meta charset="utf-8">
<title>Daily Site Log — ${escapeHtml(model.siteName)} — ${escapeHtml(model.dateLabel)}</title>
<style>
  @page { size: A4; margin: 15mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #102536; font-size: 10.5pt; line-height: 1.45;
    max-width: 182mm; margin: 0 auto; padding: 8mm 0;
  }
  header { display: flex; align-items: flex-start; justify-content: space-between;
           border-bottom: 3px solid #0B1F33; padding-bottom: 8pt; margin-bottom: 12pt; }
  .brand { font-size: 22pt; font-weight: 800; color: #0B1F33; letter-spacing: -0.5pt; line-height: 1; }
  .brand span { color: #16A6A1; }
  .brand-sub { font-size: 8pt; color: #5B6B7A; letter-spacing: 1pt; text-transform: uppercase; margin-top: 3pt; }
  .doc { text-align: right; }
  .doc h1 { font-size: 13pt; font-weight: 800; margin: 0; letter-spacing: 0.5pt; text-transform: uppercase; }
  .doc .site { font-size: 15pt; font-weight: 800; margin: 2pt 0 0; }
  .doc .meta { font-size: 9.5pt; color: #5B6B7A; margin: 1pt 0 0; }
  h2 { font-size: 9pt; font-weight: 800; text-transform: uppercase; letter-spacing: 1pt;
       color: #0B1F33; margin: 14pt 0 5pt; padding-bottom: 3pt; border-bottom: 1pt solid #D7E0E8; }
  table { width: 100%; border-collapse: collapse; }
  table.grid th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.6pt;
                  color: #5B6B7A; padding: 3pt 6pt 3pt 0; border-bottom: 0.75pt solid #D7E0E8; }
  table.grid td { padding: 4pt 6pt 4pt 0; vertical-align: top; border-bottom: 0.5pt solid #EAF0F5; }
  table.fields th { text-align: left; font-weight: 700; color: #5B6B7A; width: 48mm;
                    padding: 3pt 8pt 3pt 0; vertical-align: top; }
  table.fields td { padding: 3pt 0; vertical-align: top; }
  /* The occurrence record. A row must not be split across a page in the middle of an entry. */
  table.occurrences tr { page-break-inside: avoid; }
  table.occurrences td.t { width: 17mm; font-variant-numeric: tabular-nums; color: #102536; font-weight: 700; }
  table.occurrences td.l { width: 42mm; font-weight: 700; }
  table.occurrences td.l .who { display: block; font-weight: 400; font-size: 8.5pt; color: #5B6B7A; }
  table.occurrences td.d { white-space: pre-wrap; word-break: break-word; }
  tr.log_book_missed td.l, tr.log_book_missed td.d { color: #B42318; }
  tr.emergency td.l { color: #B42318; }
  thead { display: table-header-group; }
  .muted { color: #5B6B7A; font-style: italic; }
  /* Outcomes sit in their own boxes so they cannot be read as part of the chronology above. */
  .followup { border: 0.75pt solid #D7E0E8; border-left: 2.5pt solid #5B6B7A; border-radius: 2pt;
              padding: 6pt 9pt; margin-top: 5pt; page-break-inside: avoid; background: #FAFCFD; }
  .fu-title { margin: 0 0 3pt; font-weight: 700; }
  .fu-open { display: inline-block; margin-left: 6pt; padding: 1pt 5pt; border: 0.75pt solid #A15C07;
             border-radius: 2pt; color: #A15C07; font-size: 8pt; font-weight: 700; text-transform: uppercase; }
  .note { margin: 4pt 0 0; font-size: 9pt; }
  footer { margin-top: 16pt; padding-top: 6pt; border-top: 0.75pt solid #D7E0E8;
           font-size: 8.5pt; color: #5B6B7A; display: flex; justify-content: space-between; align-items: flex-end; }
  .foot-left { display: flex; flex-direction: column; gap: 1pt; }
  .foot-company { font-weight: 700; color: #102536; font-size: 9.5pt; }
  .foot-platform { font-size: 8pt; }
</style></head>
<body>
  <header>
    <div>
      <div class="brand">S<span>4</span></div>
      <div class="brand-sub">Sites · Shifts · Staff · Security</div>
    </div>
    <div class="doc">
      <h1>Daily Site Log</h1>
      <p class="site">${escapeHtml(model.siteName || '—')}</p>
      ${model.clientName ? `<p class="meta">${escapeHtml(model.clientName)}</p>` : ''}
      <p class="meta">${escapeHtml(model.dateLabel)}</p>
    </div>
  </header>

  <section>
    <h2>Shifts and attendance</h2>
    <table class="grid">
      <thead><tr><th>Guard</th><th>Scheduled</th><th>Book On</th><th>Book Off</th><th>Attendance</th></tr></thead>
      <tbody>${shiftRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Occurrence record</h2>
    <table class="grid occurrences">
      <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>${eventRows}</tbody>
    </table>
  </section>

  ${followUpBlock ? `<section>
    <h2>Follow-up / outcomes</h2>
    <p class="muted note">Recorded after ${escapeHtml(model.dateLabel)}. Shown with their own dates; they are not part of this day's occurrence record.</p>
    ${followUpBlock}
  </section>` : ''}

  <section>
    <h2>Log Book compliance</h2>
    ${compliance}
  </section>

  <section>
    <h2>Welfare Checks</h2>
    ${welfare}
  </section>

  <section>
    <h2>Operational summary</h2>
    <table class="fields">
      <tr><th scope="row">Incidents</th><td>${model.operational.incidents}</td></tr>
      <tr><th scope="row">Site Requests</th><td>${model.operational.siteRequests}</td></tr>
      <tr><th scope="row">Emergency events</th><td>${model.operational.emergencies}</td></tr>
    </table>
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
