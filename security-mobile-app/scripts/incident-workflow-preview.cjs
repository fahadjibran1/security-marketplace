#!/usr/bin/env node
/**
 * Renders the REAL incident workflow surfaces to standalone HTML for visual review. (UAT FIX 03.)
 *
 * Not a mock-up: it imports `LiveOpsAttentionRail`, `CompanyResolveAlertDrawer` and
 * `CompanyIncidentDetailDrawer` themselves and renders them through react-native-web's AppRegistry,
 * which produces the stylesheet the web control room actually ships.
 *
 * The fixture is deterministic and local. No API client is loaded, no network call is made, and the
 * incidents below are invented for this file — they are not production records.
 *
 *   node scripts/incident-workflow-preview.cjs [outDir]
 *
 * The pages are static HTML, so an exact-width capture needs nothing beyond the installed browser:
 *
 *   chrome.exe --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
 *     --window-size=1440,900 --screenshot=queue.png <outDir>/incident-queue.html
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
// Without this the components answer "native" to `typeof document !== 'undefined'` and the preview
// would certify a phone layout the control room never sees.
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { loadTs, ROOT } = require('./load-ts.cjs');

const OUT_DIR = process.argv[2] || path.join(ROOT, 'preview-incidents');
const LONDON = 'Europe/London';

// ─── the fixture: one incident at each point of its lifecycle ────────────────
// Thursday 1 October 2026, 22:10 London (BST, so 21:10Z). Synthetic sites and guards only.

const OPEN_INCIDENT = {
  id: 4,
  incidentId: 4,
  shiftId: 77,
  status: 'open',
  siteName: 'Northgate Retail Park',
  guardName: 'A. Guard',
  category: 'incident',
  issueType: 'Incident unresolved',
  message: 'Broken window to the rear fire exit',
  occurredAt: '2026-10-01T21:10:00.000Z',
};

const REVIEWING_INCIDENT = {
  ...OPEN_INCIDENT,
  id: 5,
  incidentId: 5,
  shiftId: 78,
  status: 'in_review',
  siteName: 'Quayside Logistics',
  guardName: 'B. Guard',
  message: 'Unknown vehicle refusing to leave the loading yard',
  occurredAt: '2026-10-01T20:35:00.000Z',
};

// A safety alert sits in the same queue, so the two vocabularies can be compared side by side.
const WELFARE_ALERT = {
  id: 'welfare-9',
  alertId: 9,
  shiftId: 77,
  status: 'open',
  siteName: 'Northgate Retail Park',
  guardName: 'A. Guard',
  category: 'missed_check_call',
  issueType: 'Welfare Check missed',
  message: 'No response to the 21:00 Welfare Check',
  occurredAt: '2026-10-01T21:05:00.000Z',
};

const INCIDENT_RECORD = {
  id: 4,
  title: 'Broken window to the rear fire exit',
  notes: 'Found the rear fire exit pane cracked at 21:10 during a patrol of the service corridor. '
    + 'No sign of entry; glass is intact but unsafe. Client duty manager informed on site.',
  severity: 'high',
  category: 'damage',
  status: 'open',
  locationText: 'Service corridor, rear fire exit',
  reportedAt: '2026-10-01T21:10:00.000Z',
  reviewedAt: null,
  reviewedByUserId: null,
  closedAt: null,
  closedByUserId: null,
  resolutionReason: null,
  resolutionNote: null,
  createdAt: '2026-10-01T21:10:00.000Z',
  shift: { id: 77, site: { id: 3, name: 'Northgate Retail Park' } },
  site: { id: 3, name: 'Northgate Retail Park' },
  guard: { id: 20, fullName: 'A. Guard' },
};

const RESOLVED_RECORD = {
  ...INCIDENT_RECORD,
  status: 'resolved',
  reviewedAt: '2026-10-01T21:22:00.000Z',
  reviewedByUserId: 21,
  resolutionReason: 'maintenance_arranged',
  resolutionNote: 'Glazier booked for 08:00. Exit boarded and made safe; client duty manager signed off at 21:48.',
};

const RESOLVE_TARGET = {
  kind: 'incident',
  id: 4,
  family: 'incident',
  title: 'Broken window to the rear fire exit',
  reference: '#4',
  siteName: 'Northgate Retail Park',
  guardName: 'A. Guard',
  shiftLabel: '#77 · 18:00–06:00',
  severityLabel: 'High',
  statusLabel: 'Open',
  reportText: INCIDENT_RECORD.notes,
  raisedLabel: '1 Oct 2026, 22:10',
};

// ─── pages ────────────────────────────────────────────────────────────────────

/**
 * Render the drawers inline, by making `Modal` a passthrough for the preview only.
 *
 * `Drawer` wraps its content in a react-native Modal, which react-native-web renders through a
 * client-side portal — so a server-rendered page of it is simply empty. The product code is not
 * touched: the module object react-native-web exports is patched in this process before the drawer
 * is rendered, so what the screenshot shows is the real drawer, with its real styles, minus the
 * portal that cannot exist in static HTML.
 */
function withInlineModal(render) {
  const RNW = require('react-native-web');
  const realModal = RNW.Modal;
  RNW.Modal = ({ visible, children }) =>
    (visible === false ? null : React.createElement(RNW.View, { style: { padding: 0 } }, children));
  try {
    return render();
  } finally {
    RNW.Modal = realModal;
  }
}

function page(title, body) {
  const RNW = require('react-native-web');
  const { AppRegistry } = RNW;

  AppRegistry.registerComponent('IncidentPreview', () => () =>
    React.createElement(
      RNW.View,
      { style: { padding: 16, backgroundColor: '#F4F7FA', gap: 12 } },
      React.createElement(RNW.Text, { style: { fontSize: 20, fontWeight: '800', color: '#0B1F33' } }, title),
      body(),
    ));

  const { element, getStyleElement } = AppRegistry.getApplication('IncidentPreview', {});
  const { renderToStaticMarkup } = require('react-dom/server');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>S4 — ${title}</title>
<style>html,body{margin:0;padding:0;background:#F4F7FA;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;}</style>
${renderToStaticMarkup(getStyleElement())}
</head><body><div id="root">${renderToStaticMarkup(element)}</div></body></html>`;
}

function queuePage() {
  const RNW = require('react-native-web');
  const { LiveOpsAttentionRail } = loadTs('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  return page('Attention Now — incident lifecycle', () =>
    React.createElement(
      RNW.View,
      { style: { flexDirection: 'row', alignItems: 'flex-start' } },
      React.createElement(LiveOpsAttentionRail, {
        items: [OPEN_INCIDENT, REVIEWING_INCIDENT, WELFARE_ALERT],
        metricFocus: 'all',
        resolveShiftZone: () => LONDON,
        urgentActionItemId: null,
        onOpenUrgentDetail: () => {},
        onOpenUrgentShift: () => {},
        onUrgentIncidentFollowUp: async () => {},
        onUrgentAlertFollowUp: async () => {},
        onOpenIncidentResolution: () => {},
        nextUp: [],
      }),
    ));
}

function resolvePage() {
  const { CompanyResolveAlertDrawer } = loadTs('src/components/company/CompanyResolveAlertDrawer.tsx');
  return page('Resolve Incident', () =>
    React.createElement(CompanyResolveAlertDrawer, {
      target: RESOLVE_TARGET,
      submitting: false,
      error: null,
      onCancel: () => {},
      onSubmit: () => {},
    }));
}

function detailPage(record, title) {
  const { CompanyIncidentDetailDrawer } = loadTs('src/components/company/CompanyIncidentDetailDrawer.tsx');
  return page(title, () =>
    React.createElement(CompanyIncidentDetailDrawer, {
      incident: record,
      timeZone: LONDON,
      onClose: () => {},
    }));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const pages = [
  ['incident-queue.html', queuePage],
  ['incident-resolve.html', () => withInlineModal(resolvePage)],
  ['incident-detail-open.html', () => withInlineModal(() => detailPage(INCIDENT_RECORD, 'Incident #4 — open'))],
  ['incident-detail-resolved.html', () => withInlineModal(() => detailPage(RESOLVED_RECORD, 'Incident #4 — resolved'))],
];
for (const [name, build] of pages) {
  fs.writeFileSync(path.join(OUT_DIR, name), build());
  console.log('wrote', path.join(OUT_DIR, name));
}
