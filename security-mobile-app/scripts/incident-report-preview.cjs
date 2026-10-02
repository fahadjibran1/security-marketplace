#!/usr/bin/env node
/**
 * Renders the REAL Incident Report surfaces to standalone HTML for visual review.
 *
 * Not a mock-up: it imports `CompanyIncidentReportDrawer`, `buildIncidentReport` and
 * `renderIncidentReportHtml` themselves, so the pages below are the shipped components and the
 * shipped printable document.
 *
 * The fixture is LOCAL and synthetic. It is shaped like production Incident #4 because that is the
 * UAT case, but nothing here reads from or writes to production, and the evidence cases use
 * example.invalid URLs that exist nowhere.
 *
 *   node scripts/incident-report-preview.cjs [outDir]
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview-incident-report');
const LONDON = 'Europe/London';
const GENERATED = '02 Oct 2026, 18:40';

const { buildIncidentReport } = loadTs('src/components/company/incidentReport.ts');
const { renderIncidentReportHtml } = loadTs('src/components/company/incidentReportPrint.ts');
const { CompanyIncidentReportDrawer } = loadTs('src/components/company/CompanyIncidentReportDrawer.tsx');
const { incidentLifecycleLabel, incidentSeverityLabel } = loadTs('src/components/company/incidentLifecycle.ts');

// ─── the fixture ──────────────────────────────────────────────────────────────

const INCIDENT_4 = {
  id: 4,
  title: 'Guard incident',
  notes: 'Broken fence',
  severity: 'medium',
  category: 'other',
  status: 'resolved',
  locationText: null,
  reportedAt: '2026-09-30T19:49:00.000Z',
  reviewedAt: '2026-10-02T16:25:00.000Z',
  reviewedByUserId: 21,
  closedAt: null,
  closedByUserId: null,
  resolutionReason: 'client_informed',
  resolutionNote: 'no issue',
  createdAt: '2026-09-30T19:49:00.000Z',
  company: { id: 1, name: 'S4 Company' },
  shift: { id: 19, start: '2026-09-30T19:35:00.000Z', end: '2026-09-30T20:35:00.000Z', site: { id: 14, name: 'test site' } },
  site: { id: 14, name: 'test site', clientName: 'client test' },
  guard: { id: 20, fullName: 'Fahad test' },
};

const AUDIT_4 = [
  {
    id: 479, action: 'incident.reported', entityType: 'incident', entityId: 4,
    afterData: { status: 'open' }, createdAt: '2026-09-30T19:49:00.000Z',
    user: { id: 20, firstName: 'Fahad', lastName: 'test' },
  },
  {
    id: 539, action: 'incident.status_updated', entityType: 'incident', entityId: 4,
    beforeData: { status: 'open' }, afterData: { status: 'in_review' },
    createdAt: '2026-10-02T15:32:00.000Z', user: { id: 21, email: 'control@example.invalid' },
  },
  {
    id: 544, action: 'incident.status_updated', entityType: 'incident', entityId: 4,
    beforeData: { status: 'in_review' }, afterData: { status: 'resolved', resolutionReason: 'client_informed' },
    createdAt: '2026-10-02T16:25:00.000Z', user: { id: 21, email: 'control@example.invalid' },
  },
];

/** A long incident, to prove the layout holds under real operational prose. */
const LONG_INCIDENT = {
  ...INCIDENT_4,
  id: 11,
  severity: 'high',
  category: 'damage',
  locationText: 'North perimeter, between gate 3 and the substation',
  notes: 'At approximately 21:10 during a routine perimeter patrol I found a section of the palisade '
    + 'fence on the north boundary pushed inward, with two uprights bent and one panel detached at the '
    + 'base. There were fresh tyre marks in the verge immediately outside the breach, consistent with a '
    + 'vehicle reversing up to the fence line.\n\n'
    + 'I checked the immediate yard for signs of entry. Nothing appeared to have been moved and the '
    + 'container seals were intact. I photographed the damage, informed the duty manager by phone at '
    + '21:18, and remained at the breach until the mobile unit arrived at 21:40 to cover the gap.',
  resolutionNote: 'Attended site and confirmed the breach was limited to the north boundary with no entry '
    + 'to the yard. Contractor attended at 08:00 the following morning, replaced two uprights and refixed '
    + 'the detached panel. Client duty manager inspected and signed off the repair at 09:35. Patrol '
    + 'instructions updated to include a close inspection of the north boundary on every round for the '
    + 'next fourteen days.',
};

const LONG_AUDIT = AUDIT_4.map((entry) => ({ ...entry, entityId: 11 }));

const EVIDENCE = [
  {
    id: 31, entityType: 'incident', entityId: 11,
    fileName: 'north-boundary-breach.jpg',
    fileUrl: 'data:image/svg+xml;base64,' + Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220">
         <rect width="320" height="220" fill="#1F3242"/>
         <path d="M0 160 H320" stroke="#94A3B8" stroke-width="3"/>
         ${Array.from({ length: 11 }, (_, i) => `<rect x="${12 + i * 28}" y="${i === 5 || i === 6 ? 70 : 54}" width="7" height="${i === 5 || i === 6 ? 90 : 106}" fill="#64748B" transform="rotate(${i === 5 ? 14 : i === 6 ? -9 : 0} ${15 + i * 28} 110)"/>`).join('')}
         <text x="160" y="200" fill="#CBD5E1" font-family="sans-serif" font-size="13" text-anchor="middle">north boundary · 21:12</text>
       </svg>`,
    ).toString('base64'),
    mimeType: 'image/svg+xml', sizeBytes: 2_411_724, createdAt: '2026-09-30T20:12:00.000Z',
    uploadedBy: { id: 20, firstName: 'Fahad', lastName: 'test' },
  },
  {
    id: 32, entityType: 'incident', entityId: 11,
    fileName: 'tyre-marks-verge.jpg',
    fileUrl: 'data:image/svg+xml;base64,' + Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220">
         <rect width="320" height="220" fill="#2A3B2C"/>
         <path d="M40 210 C110 150 170 120 290 70" stroke="#6B7A5A" stroke-width="22" fill="none" opacity="0.85"/>
         <path d="M70 215 C140 158 200 128 310 80" stroke="#6B7A5A" stroke-width="22" fill="none" opacity="0.85"/>
         <text x="160" y="200" fill="#D7E0E8" font-family="sans-serif" font-size="13" text-anchor="middle">verge · 21:14</text>
       </svg>`,
    ).toString('base64'),
    mimeType: 'image/svg+xml', sizeBytes: 1_904_311, createdAt: '2026-09-30T20:14:00.000Z',
    uploadedBy: { id: 20, firstName: 'Fahad', lastName: 'test' },
  },
  {
    id: 33, entityType: 'incident', entityId: 11,
    fileName: 'contractor-quote.pdf', fileUrl: 'https://storage.example.invalid/quote.pdf',
    mimeType: 'application/pdf', sizeBytes: 83_210, createdAt: '2026-10-01T09:05:00.000Z',
    uploadedBy: { id: 21, email: 'control@example.invalid' },
  },
];

const HISTORICAL = {
  id: 2,
  title: 'Perimeter light failure',
  notes: 'Floodlight on the north perimeter not working.',
  severity: 'low', category: 'health_safety', status: 'closed',
  locationText: null,
  reportedAt: '2026-05-04T22:10:00.000Z',
  reviewedAt: null, reviewedByUserId: null, closedAt: null, closedByUserId: null,
  resolutionReason: null, resolutionNote: null,
  createdAt: '2026-05-04T22:10:00.000Z',
  shift: null, site: null, guard: null, company: null,
};

const REGISTER_ROWS = [
  { id: 11, shift: { id: 24 }, site: { name: 'test site' }, guard: { fullName: 'Fahad test' }, severity: 'high', status: 'in_review', createdAt: '2026-09-30T19:49:00.000Z' },
  INCIDENT_4,
  { id: 3, shift: null, site: { name: 'Quayside Logistics' }, guard: { fullName: 'B. Guard' }, severity: 'critical', status: 'open', createdAt: '2026-08-14T03:20:00.000Z' },
  HISTORICAL,
];

// ─── rendering ────────────────────────────────────────────────────────────────

function withInlineModal(render) {
  const RNW = require('react-native-web');
  const realModal = RNW.Modal;
  RNW.Modal = ({ visible, children }) =>
    (visible === false ? null : React.createElement(RNW.View, null, children));
  try {
    return render();
  } finally {
    RNW.Modal = realModal;
  }
}

function page(title, body) {
  const RNW = require('react-native-web');
  const { AppRegistry } = RNW;
  AppRegistry.registerComponent('ReportPreview', () => () =>
    React.createElement(
      RNW.View,
      { style: { padding: 16, backgroundColor: '#F4F7FA', gap: 12 } },
      React.createElement(RNW.Text, { style: { fontSize: 19, fontWeight: '800', color: '#0B1F33' } }, title),
      body(),
    ));
  const { element, getStyleElement } = AppRegistry.getApplication('ReportPreview', {});
  const { renderToStaticMarkup } = require('react-dom/server');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>S4 — ${title}</title>
<style>html,body{margin:0;padding:0;background:#F4F7FA;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style>
${renderToStaticMarkup(getStyleElement())}
</head><body><div id="root">${renderToStaticMarkup(element)}</div></body></html>`;
}

/** The Incidents register, drawn exactly as the dashboard's simple-table section draws it. */
function registerPage() {
  const RNW = require('react-native-web');
  const head = ['Incident', 'Shift', 'Site', 'Guard', 'Severity', 'Status', 'Time'];
  const cell = { fontSize: 12, color: '#102536', flex: 1 };
  return page('Management → Incidents', () =>
    React.createElement(
      RNW.View,
      { style: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D7E0E8', borderRadius: 10, padding: 16, gap: 2, maxWidth: 1000 } },
      React.createElement(RNW.Text, { style: { fontSize: 15, fontWeight: '800', color: '#102536', marginBottom: 8 } }, 'Incidents'),
      React.createElement(
        RNW.View,
        { style: { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#D7E0E8' } },
        ...head.map((h) => React.createElement(RNW.Text, { key: h, style: { ...cell, fontSize: 10, fontWeight: '800', color: '#5B6B7A', textTransform: 'uppercase', letterSpacing: 0.6 } }, h)),
      ),
      ...REGISTER_ROWS.map((incident) => React.createElement(
        RNW.View,
        { key: incident.id, style: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#EAF0F5', cursor: 'pointer' } },
        React.createElement(RNW.Text, { style: { ...cell, fontWeight: '800' } }, `#${incident.id}`),
        React.createElement(RNW.Text, { style: cell }, incident.shift?.id ? `#${incident.shift.id}` : '—'),
        React.createElement(RNW.Text, { style: cell }, incident.site?.name || '—'),
        React.createElement(RNW.Text, { style: cell }, incident.guard?.fullName || '—'),
        React.createElement(RNW.Text, { style: cell }, incidentSeverityLabel(incident.severity) || '—'),
        React.createElement(RNW.Text, { style: cell }, incidentLifecycleLabel(incident.status)),
        React.createElement(RNW.Text, { style: cell }, new Date(incident.createdAt).toLocaleDateString('en-GB')),
      )),
    ));
}

function reportPage(title, incident, audit, attachments) {
  return withInlineModal(() => page(title, () =>
    React.createElement(CompanyIncidentReportDrawer, {
      model: buildIncidentReport(incident, audit, attachments, LONDON),
      onClose: () => {}, onPrint: () => {}, printing: false, notice: null,
    })));
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const pages = [
  ['register.html', registerPage],
  ['report-incident-4.html', () => reportPage('Incident Report #4 — the UAT case', INCIDENT_4, AUDIT_4, [])],
  ['report-no-evidence.html', () => reportPage('Incident Report — historical, no evidence', HISTORICAL, [], [])],
  ['report-full.html', () => reportPage('Incident Report — long report with evidence', LONG_INCIDENT, LONG_AUDIT, EVIDENCE)],
];
for (const [name, build] of pages) {
  fs.writeFileSync(path.join(OUT_DIR, name), build());
  console.log('wrote', path.join(OUT_DIR, name));
}

// The printable A4 documents, exactly as the browser receives them.
const printables = [
  ['print-incident-4.html', INCIDENT_4, AUDIT_4, []],
  ['print-full.html', LONG_INCIDENT, LONG_AUDIT, EVIDENCE],
  ['print-historical.html', HISTORICAL, [], []],
];
for (const [name, incident, audit, attachments] of printables) {
  const model = buildIncidentReport(incident, audit, attachments, LONDON);
  fs.writeFileSync(
    path.join(OUT_DIR, name),
    renderIncidentReportHtml(model, { companyName: incident.company?.name, generatedAt: GENERATED }),
  );
  console.log('wrote', path.join(OUT_DIR, name));
}
