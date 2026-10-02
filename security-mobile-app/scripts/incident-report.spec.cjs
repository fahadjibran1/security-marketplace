#!/usr/bin/env node
/**
 * The Incident Report — the document a client is shown. (Phase 4A, client evidence.)
 *
 * A report that quietly invents a fact is worse than no report, because somebody acts on it. So the
 * assertions here are about provenance as much as appearance: the guard's words survive resolution,
 * resolution evidence never masquerades as the original account, an absent fact reads as absent, and
 * the printed page carries what a client needs and nothing a client should never see.
 *
 * The on-screen drawer and the printed A4 page are built from ONE view model, and both are exercised.
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadTs, ROOT } = require('./load-ts.cjs');

const report = loadTs('src/components/company/incidentReport.ts');
const print = loadTs('src/components/company/incidentReportPrint.ts');
const { CompanyIncidentReportDrawer } = loadTs('src/components/company/CompanyIncidentReportDrawer.tsx');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const screenCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/screens/CompanyDashboardScreen.tsx'), 'utf8'));

const LONDON = 'Europe/London';
const GENERATED = '02 Oct 2026, 18:40';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log('PASS ', name);
  } catch (error) {
    console.error('FAIL ', name);
    console.error(error.message);
    process.exitCode = 1;
  }
};

const isPlainFunctionComponent = (type) =>
  typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent);

/** All rendered text in a tree, with the handlers intact (see incident-workflow.spec.cjs). */
function textOf(element) {
  const words = [];
  const walk = (node) => {
    if (typeof node === 'string' || typeof node === 'number') { words.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !node.type) return;
    if (isPlainFunctionComponent(node.type)) { walk(node.type(node.props)); return; }
    if (node.props && node.props.children !== undefined) walk(node.props.children);
  };
  walk(element);
  return words.join(' | ');
}

function buttonsOf(element) {
  const out = [];
  const walk = (node) => {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object' || !node.type) return;
    if (isPlainFunctionComponent(node.type)) { walk(node.type(node.props)); return; }
    if (node.props && node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function') {
      out.push({ label: node.props.accessibilityLabel, press: node.props.onPress });
    }
    if (node.props && node.props.children !== undefined) walk(node.props.children);
  };
  walk(element);
  return out;
}

const drawer = (model, extra = {}) => React.createElement(CompanyIncidentReportDrawer, {
  model, onClose: () => {}, onPrint: () => {}, printing: false, notice: null, ...extra,
});

// ─── the Incident #4 fixture, shaped exactly like the production record ──────
//
// Taken from the real UAT case and reproduced LOCALLY. Production is never written to for a test or
// a screenshot; these are the shapes the API returns, not rows fetched from it.

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

/** The three audit rows production actually holds for Incident #4. */
const AUDIT_4 = [
  {
    id: 479, action: 'incident.reported', entityType: 'incident', entityId: 4,
    beforeData: null, afterData: { title: 'Guard incident', severity: 'medium', category: 'other', status: 'open' },
    createdAt: '2026-09-30T19:49:00.000Z', user: { id: 20, email: 'guard@example.invalid' },
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
  // Another incident's history, to prove the report never borrows it.
  {
    id: 601, action: 'incident.status_updated', entityType: 'incident', entityId: 9,
    beforeData: { status: 'open' }, afterData: { status: 'resolved' },
    createdAt: '2026-10-02T17:00:00.000Z', user: { id: 21, email: 'control@example.invalid' },
  },
];

const OPEN_INCIDENT = {
  ...INCIDENT_4,
  id: 7,
  status: 'open',
  notes: 'Unknown vehicle refusing to leave the loading yard.',
  reviewedAt: null, reviewedByUserId: null,
  resolutionReason: null, resolutionNote: null,
};

/** Raised long before Migration 60: every evidence column is null and no audit row exists. */
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

// ─── INC-REPORT-01 … 02 ──────────────────────────────────────────────────────

test('INC-REPORT-01-RESOLVED-INCIDENT-REMAINS-IN-REGISTER', () => {
  const register = screenCode.slice(screenCode.indexOf("case 'incidents':"), screenCode.indexOf("case 'alerts':"));
  // The register maps the WHOLE list. No status filter may stand between an incident and the record.
  assert.match(register, /incidents\.map\(\(incident\) => \(/, 'every incident is listed');
  assert.ok(
    !/\.filter\(/.test(register),
    'the register filters nothing out — a resolved incident is still the historical record',
  );
  // And the register's own status column reads the lifecycle rather than inventing one.
  assert.match(register, /incidentLifecycleLabel\(incident\.status\)/);

  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  assert.equal(model.statusLabel, 'Resolved');
});

test('INC-REPORT-02-CLICKING-ROW-OPENS-INCIDENT-REPORT', () => {
  assert.match(screenCode, /accessibilityLabel=\{`Open Incident #\$\{incident\.id\}`\}/);
  assert.match(screenCode, /onPress=\{\(\) => openIncidentReport\(incident\.id\)\}/);
  assert.match(screenCode, /<CompanyIncidentReportDrawer/, 'and it is the report that opens');

  /**
   * MOUNTED ON THE SCREEN, NOT INSIDE A SECTION.
   *
   * This is the assertion that was missing, and production found the gap: the drawer was mounted
   * inside `renderLiveOperationsSection()`, so on the Incidents page it was never rendered and a row
   * press set state for a drawer that did not exist. Asserting the component merely APPEARS in the
   * file could never catch that — it has to be checked where it sits.
   */
  const liveOpsSection = screenCode.slice(
    screenCode.indexOf('const renderLiveOperationsSection'),
    screenCode.indexOf('const renderContent'),
  );
  assert.ok(liveOpsSection.length > 200, 'the Live Operations section was located');
  assert.ok(
    !liveOpsSection.includes('<CompanyIncidentReportDrawer'),
    'the report is not trapped inside the Live Operations section',
  );

  // It sits in the screen's own return, after the content shell and before the screen closes.
  const mainReturn = screenCode.slice(screenCode.indexOf('<AppBuildFooter appLabel="S4 Company" />'));
  assert.ok(
    mainReturn.includes('<CompanyIncidentReportDrawer'),
    'the report is mounted on the screen, so every section that opens it can show it',
  );

  // The report is not raw audit JSON: it is a built view model.
  assert.match(screenCode, /buildIncidentReport\(/);
  const rendered = textOf(drawer(report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON)));
  assert.match(rendered, /Incident Report/);
  assert.ok(!/beforeData|afterData|entityType/.test(rendered), 'and never exposes audit JSON keys');
});

// ─── INC-REPORT-03 … 04: the guard's account is not the resolution ───────────

test('INC-REPORT-03-ORIGINAL-GUARD-REPORT-REMAINS-UNCHANGED', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  assert.equal(model.originalReport, 'Broken fence', 'verbatim, exactly as the guard wrote it');
  assert.notEqual(model.originalReport, model.resolution.note, 'and not the resolver’s words');

  // Resolving must not have rewritten it: the resolved record still reports what was reported.
  const before = report.buildIncidentReport(OPEN_INCIDENT, [], [], LONDON);
  const stillThere = report.buildIncidentReport(
    { ...OPEN_INCIDENT, status: 'resolved', resolutionReason: 'client_informed', resolutionNote: 'no issue' },
    [], [], LONDON,
  );
  assert.equal(stillThere.originalReport, before.originalReport, 'resolution does not touch the report text');
});

test('INC-REPORT-04-RESOLUTION-RENDERS-SEPARATELY-FROM-THE-REPORT', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  assert.equal(model.resolution.recorded, true);
  assert.equal(model.resolution.reason, 'Client informed', 'the reason reads as words');
  assert.equal(model.resolution.note, 'no issue');

  const rendered = textOf(drawer(model));
  const reportAt = rendered.indexOf('Original report');
  const resolutionAt = rendered.indexOf('Resolution');
  assert.ok(reportAt > -1 && resolutionAt > reportAt, 'they are distinct sections, in that order');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.match(html, /<h2>Original report<\/h2>/);
  assert.match(html, /<h2>Resolution<\/h2>/);
  assert.ok(html.indexOf('Original report') < html.indexOf('<h2>Resolution'), 'and in the printout too');
});

// ─── INC-REPORT-05 … 06: absence, told honestly ──────────────────────────────

test('INC-REPORT-05-OPEN-INCIDENT-RENDERS-WITH-NO-RESOLUTION-EVIDENCE', () => {
  const model = report.buildIncidentReport(OPEN_INCIDENT, [], [], LONDON);
  assert.equal(model.resolution.recorded, false);
  assert.equal(model.statusLabel, 'Open');

  const rendered = textOf(drawer(model));
  assert.match(rendered, /No resolution evidence recorded/);
  assert.match(rendered, /Unknown vehicle refusing/, 'the report itself still reads');
  for (const leak of ['null', 'undefined', 'NaN', 'Invalid Date']) {
    assert.ok(!rendered.includes(leak), `nothing renders as "${leak}"`);
  }
});

test('INC-REPORT-06-HISTORICAL-NULL-EVIDENCE-RENDERS-SAFELY', () => {
  // No site, no guard, no shift, no company, no audit row, no resolution. Nothing may be invented.
  const model = report.buildIncidentReport(HISTORICAL, [], [], LONDON);
  const rendered = textOf(drawer(model));

  assert.match(rendered, /No resolution evidence recorded/);
  assert.match(rendered, /No evidence attached/);
  assert.ok(rendered.includes(report.NOT_RECORDED), 'missing overview facts read as an em dash');
  for (const leak of ['null', 'undefined', 'NaN', 'Invalid Date', 'User #']) {
    assert.ok(!rendered.includes(leak), `nothing renders as "${leak}"`);
  }

  // Reported still has a time, because the ROW records one — that is evidence, not inference.
  const reported = model.handling.find((entry) => entry.label === 'Reported');
  assert.ok(reported && reported.at, 'the recorded reported time is used');
  assert.equal(reported.actor, '', 'and no actor is invented for it');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.match(html, /No resolution evidence recorded/);
  assert.ok(!/undefined|NaN|Invalid Date/.test(html));
});

// ─── INC-REPORT-07 … 08: the timeline, and the real case ─────────────────────

test('INC-REPORT-07-HANDLING-TIMELINE-PRESERVES-LIFECYCLE-ORDER', () => {
  // Deliberately shuffled: ordering must come from the timestamps, not the array.
  const shuffled = [AUDIT_4[2], AUDIT_4[0], AUDIT_4[3], AUDIT_4[1]];
  const model = report.buildIncidentReport(INCIDENT_4, shuffled, [], LONDON);

  assert.deepEqual(
    model.handling.map((entry) => entry.label),
    ['Reported', 'Marked In Review', 'Resolved'],
    'oldest first, named by what each transition achieved',
  );
  for (let i = 1; i < model.handling.length; i += 1) {
    assert.ok(model.handling[i].atMs >= model.handling[i - 1].atMs, 'strictly non-decreasing in time');
  }
  // Another incident's audit row is never borrowed.
  assert.equal(model.handling.length, 3);

  /**
   * The row alone could not produce this: resolving overwrote `reviewedAt` with the resolution time,
   * so the "Marked In Review" moment survives only in the audit log.
   */
  assert.match(model.handling[1].at, /15:32|16:32/, 'the in-review moment is the audited one, not the row’s');
  assert.equal(model.handling[1].actor, 'control@example.invalid');
  /**
   * UPDATED BY THE FINALISATION PASS, not relaxed.
   *
   * This asserted the guard's account email. The client-facing report now prefers the person's real
   * name where the records genuinely hold one, and `incident.guard.fullName` is exactly that for the
   * person who filed the report — the same individual, named properly. FINAL-04 to FINAL-06 own this
   * rule; the assertion here simply follows it.
   */
  assert.equal(model.handling[0].actor, 'Fahad test');
});

test('INC-REPORT-08-INCIDENT-4-SHAPED-FIXTURE-RENDERS-THE-KNOWN-FACTS', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const rendered = textOf(drawer(model));

  assert.match(rendered, /Broken fence/, 'the original report');
  assert.match(rendered, /Client informed/, 'the resolution reason, as words');
  assert.match(rendered, /no issue/, 'the resolution note');
  assert.match(rendered, /#4/);
  assert.match(rendered, /test site/);
  assert.match(rendered, /client test/, 'the client the site belongs to');
  assert.match(rendered, /Fahad test/);
  assert.match(rendered, /#19/, 'the shift');
  assert.match(rendered, /Medium/, 'severity');
  assert.match(rendered, /Resolved/);
  assert.ok(!rendered.includes('client_informed'), 'the stored value is never shown');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  for (const needle of ['Broken fence', 'Client informed', 'no issue', '#4', 'test site', 'client test', 'Fahad test', 'Medium']) {
    assert.ok(html.includes(needle), `the printout carries "${needle}"`);
  }
});

// ─── INC-REPORT-09 … 10: what the printed page must and must not carry ───────

test('INC-REPORT-09-PRINT-VIEW-CONTAINS-THE-CLIENT-FACING-FIELDS', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const html = print.renderIncidentReportHtml(model, { companyName: 'S4 Company', generatedAt: GENERATED });

  assert.match(html, /<title>Incident Report #4<\/title>/);
  assert.match(html, /Incident Report/);
  assert.match(html, /class="brand"/, 'S4 branding');
  assert.match(html, /S<span>4<\/span>/);
  for (const section of ['Overview', 'Original report', 'Evidence', 'Handling history', 'Resolution']) {
    assert.ok(html.includes(`<h2>${section}</h2>`), `the printout has a ${section} section`);
  }
  for (const field of ['Incident reference', 'Client', 'Site', 'Guard', 'Shift', 'Reported', 'Severity', 'Category']) {
    assert.ok(html.includes(field), `the printout states ${field}`);
  }
  assert.match(html, /Marked In Review/, 'the handling timeline');
  assert.match(html, /Resolved by/);
  assert.match(html, /Resolved at/);
  assert.ok(html.includes(`Report generated ${GENERATED}`), 'and when it was produced');
  assert.match(html, /@page \{ size: A4;/, 'laid out for A4');
});

test('INC-REPORT-10-PRINT-VIEW-EXCLUDES-NAVIGATION-AND-INTERNALS', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });

  // Nothing from the app shell. These are not hidden by print rules — they were never rendered.
  for (const chrome of [
    'Attention Now', 'Live Operations', 'Dashboard', 'Next Up', 'Refresh', 'Log out',
    'Export', 'Filter', 'navigation', '<nav', '<button', '<select', '<input',
  ]) {
    assert.ok(!html.includes(chrome), `the printout contains no "${chrome}"`);
  }
  // No audit JSON, no internal plumbing, no credentials.
  for (const internal of [
    'beforeData', 'afterData', 'entityType', 'entityId', 'reviewedByUserId', 'closedByUserId',
    'userId', 'companyId', 'Bearer', 'Authorization', 'token', 'audit_logs',
  ]) {
    assert.ok(!html.includes(internal), `the printout leaks no "${internal}"`);
  }
  // The guard's stored machine values never reach the page either.
  assert.ok(!html.includes('client_informed'));
  assert.ok(!html.includes('in_review'));

  // Free text is escaped, so an incident report can never inject markup into the document.
  const nasty = report.buildIncidentReport(
    { ...INCIDENT_4, notes: '<script>alert(1)</script> & "quoted"' }, AUDIT_4, [], LONDON,
  );
  const nastyHtml = print.renderIncidentReportHtml(nasty, { generatedAt: GENERATED });
  assert.ok(!nastyHtml.includes('<script>'), 'markup in a report is escaped, never executed');
  assert.match(nastyHtml, /&lt;script&gt;/);
});

// ─── INC-REPORT-11 … 12: evidence, only where it genuinely exists ────────────

test('INC-REPORT-11-NO-EVIDENCE-RENDERS-NO-EVIDENCE-ATTACHED', () => {
  for (const attachments of [[], null, undefined]) {
    const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, attachments, LONDON);
    assert.deepEqual(model.evidence, [], 'nothing is conjured');
    assert.match(textOf(drawer(model)), /No evidence attached/);
    assert.match(
      print.renderIncidentReportHtml(model, { generatedAt: GENERATED }),
      /No evidence attached/,
    );
  }

  // An attachment belonging to a DIFFERENT incident, or to an alert, is not this incident's evidence.
  const foreign = [
    { id: 1, entityType: 'incident', entityId: 9, fileName: 'other.jpg', fileUrl: 'https://example.invalid/o.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, createdAt: '2026-10-02T10:00:00.000Z' },
    { id: 2, entityType: 'alert', entityId: 4, fileName: 'alert.jpg', fileUrl: 'https://example.invalid/a.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, createdAt: '2026-10-02T10:00:00.000Z' },
  ];
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, foreign, LONDON);
  assert.deepEqual(model.evidence, [], 'another record’s attachment is never shown here');
});

test('INC-REPORT-12-REAL-ATTACHMENT-METADATA-RENDERS-CORRECTLY', () => {
  // The `attachments` table already models entityType 'incident'; this is what it would return.
  const attachments = [
    {
      id: 31, entityType: 'incident', entityId: 4,
      fileName: 'fence-north.jpg', fileUrl: 'https://storage.example.invalid/fence-north.jpg',
      mimeType: 'image/jpeg', sizeBytes: 2_411_724, createdAt: '2026-09-30T19:52:00.000Z',
      uploadedBy: { id: 20, firstName: 'Fahad', lastName: 'Test' },
    },
    {
      id: 32, entityType: 'incident', entityId: 4,
      fileName: 'contractor-quote.pdf', fileUrl: 'https://storage.example.invalid/quote.pdf',
      mimeType: 'application/pdf', sizeBytes: 83_210, createdAt: '2026-10-01T09:05:00.000Z',
      uploadedBy: { id: 21, email: 'control@example.invalid' },
    },
  ];
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, attachments, LONDON);

  assert.equal(model.evidence.length, 2, 'both, and multiple attachments are supported');
  assert.equal(model.evidence[0].isImage, true);
  assert.equal(model.evidence[1].isImage, false, 'a PDF is not rendered as a photograph');
  assert.equal(model.evidence[0].size, '2.3 MB');
  assert.equal(model.evidence[1].size, '81.3 KB');
  assert.equal(model.evidence[0].uploadedBy, 'Fahad Test', 'a name when the record holds one');
  assert.equal(model.evidence[1].uploadedBy, 'control@example.invalid', 'an email when it only holds that');

  const rendered = textOf(drawer(model));
  assert.match(rendered, /fence-north\.jpg/);
  assert.match(rendered, /contractor-quote\.pdf/);
  assert.ok(!/No evidence attached/.test(rendered));

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.match(html, /<img src="https:\/\/storage\.example\.invalid\/fence-north\.jpg"/, 'the photo is printed');
  assert.match(html, /contractor-quote\.pdf/, 'the document is listed');
  assert.ok(!/No evidence attached/.test(html));

  // Sizes stay honest at the edges.
  assert.equal(report.formatFileSize(0), '');
  assert.equal(report.formatFileSize(null), '');
  assert.equal(report.formatFileSize(900), '900 B');
});

// ─── INC-REPORT-13 … 14 ──────────────────────────────────────────────────────

test('INC-REPORT-13-VIEWING-AND-PRINTING-MUTATE-NOTHING', () => {
  // Opening a report reads; it never writes.
  const opener = screenCode.slice(
    screenCode.indexOf('const openIncidentReport'),
    screenCode.indexOf('const handlePrintIncidentReport'),
  );
  assert.ok(opener.length > 100, 'openIncidentReport exists');
  assert.match(opener, /listCompanyAuditLogs\(\)/, 'it reads the audit log');
  assert.match(opener, /listCompanyAttachments\(\)/, 'and the attachments');
  for (const write of ['updateIncidentStatus', 'closeSafetyAlert', 'createIncident', 'acknowledge', 'resolve']) {
    assert.ok(!opener.includes(write), `opening a report never calls ${write}`);
  }

  const printer = screenCode.slice(
    screenCode.indexOf('const handlePrintIncidentReport'),
    screenCode.indexOf('const handleSubmitResolution'),
  );
  assert.ok(printer.length > 100, 'handlePrintIncidentReport exists');
  for (const write of ['updateIncidentStatus', 'createIncident', 'fetch(', 'POST', 'PATCH']) {
    assert.ok(!printer.includes(write), `printing never performs ${write}`);
  }

  // The report modules themselves cannot reach the API at all.
  for (const file of [
    'src/components/company/incidentReport.ts',
    'src/components/company/incidentReportPrint.ts',
    'src/components/company/CompanyIncidentReportDrawer.tsx',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/services\/api/.test(source), `${file} imports no API client`);
    assert.ok(!/\bfetch\(|XMLHttpRequest/.test(source), `${file} makes no request`);
  }

  // And the printed document is produced in the browser, not uploaded anywhere.
  const printSource = fs.readFileSync(path.join(ROOT, 'src/components/company/incidentReportPrint.ts'), 'utf8');
  assert.match(printSource, /window\.open\(''/, 'a local, same-origin window');
  assert.ok(!/https?:\/\/(?!storage\.example)/.test(printSource.replace(/^\s*\*.*$/gm, '')), 'no external endpoint');
});

test('INC-REPORT-14-THE-REPORT-STAYS-INSIDE-THE-AUTHENTICATED-WORKSPACE', () => {
  // No public route, no share link, no token in the document.
  assert.ok(!/public|share-link|\/p\/|unauthenticated/i.test(
    fs.readFileSync(path.join(ROOT, 'src/components/company/incidentReportPrint.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''),
  ), 'the printed report defines no public URL');

  /**
   * Sharing is absent entirely, not disabled.
   *
   * This previously asserted a "coming soon" placeholder. The finalisation pass removed it: a
   * greyed-out promise on a client-facing surface is clutter, and the assertion that matters is that
   * nothing here can send anything. FINAL-09 owns its removal.
   */
  const drawerSource = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyIncidentReportDrawer.tsx'), 'utf8');
  assert.ok(
    !/[Ss]hare|[Ee]mail|[Ss]end/.test(stripComments(drawerSource)),
    'the report has no sharing affordance at all',
  );

  /**
   * The drawer offers exactly the actions this phase ships.
   *
   * "Close panel" is the Drawer shell's own dismiss control, so the report's own actions are what is
   * asserted: one way to print, and no way at all to send anything to anyone.
   */
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const labels = buttonsOf(drawer(model)).map((button) => button.label);
  assert.deepEqual(
    labels.filter((label) => !/^Close/.test(label)), ['Print / Save PDF'],
    'print is the only action besides closing',
  );
  assert.ok(
    !labels.some((label) => /share|send|email/i.test(label || '')),
    'nothing pressable can share, send or email the report',
  );
});

/** The report has to survive the real renderer, not only a walked tree. */
test('RENDER-01-THE-REPORT-RENDERS-THROUGH-REACT-NATIVE-WEB', () => {
  const { AppRegistry } = require('react-native-web');
  const RNW = require('react-native-web');
  const realModal = RNW.Modal;
  // The Drawer's Modal is a client-side portal; inline it so the server renderer can see the body.
  RNW.Modal = ({ children }) => React.createElement(RNW.View, null, children);
  try {
    const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
    AppRegistry.registerComponent('ReportSpec', () => () => drawer(model));
    const app = AppRegistry.getApplication('ReportSpec', {});
    const html = renderToStaticMarkup(app.element);

    assert.match(html, /Incident Report #4/);
    assert.match(html, /Broken fence/);
    assert.match(html, /Client informed/);
    assert.match(html, /Marked In Review/);
    assert.match(html, /No evidence attached/);
    assert.match(html, /Print \/ Save PDF/);
  } finally {
    RNW.Modal = realModal;
  }
});

/** A long report and a long note must not be silently truncated by the layout. */
test('RENDER-02-LONG-TEXT-IS-NOT-TRUNCATED', () => {
  const long = 'Lorem ipsum dolor sit amet. '.repeat(60).trim();
  const model = report.buildIncidentReport(
    { ...INCIDENT_4, notes: long, resolutionNote: long }, AUDIT_4, [], LONDON,
  );
  assert.equal(model.originalReport, long, 'the view model keeps every word');

  const drawerSource = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyIncidentReportDrawer.tsx'), 'utf8');
  const bodyBlock = drawerSource.slice(drawerSource.indexOf('style={styles.body}'), drawerSource.indexOf('</Section>'));
  assert.ok(!/numberOfLines/.test(bodyBlock), 'the report body clamps no lines');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.ok(html.includes(print.escapeHtml(long)), 'and the printout carries all of it');
  assert.match(html, /white-space: pre-wrap/, 'wrapping, not clipping');
});

// ═══════════════════ finalisation pass ═══════════════════
//
// Four presentation changes, certified: one shift-window rule shared by both surfaces, a
// human-readable actor identity that never invents one, a footer that does not pass S4 off as the
// guarding company, and no placeholder for an action this release does not ship.

/** The same shift on the same day, and one that runs through the night. */
const SAME_DAY = { ...INCIDENT_4, shift: { id: 19, start: '2026-09-30T19:35:00.000Z', end: '2026-09-30T20:35:00.000Z' } };
const OVERNIGHT = { ...INCIDENT_4, shift: { id: 20, start: '2026-09-30T19:00:00.000Z', end: '2026-10-01T07:00:00.000Z' } };
const scheduledOf = (model) => model.overview.find((field) => field.label === 'Scheduled shift').value;

test('FINAL-01-SAME-DAY-SHIFT-STATES-ITS-DATE-ONCE', () => {
  const value = scheduledOf(report.buildIncidentReport(SAME_DAY, AUDIT_4, [], LONDON));
  assert.equal(value, 'Wed, 30 Sept 2026 · 20:35–21:35');

  // The date appears exactly once, and the times are a range rather than two stamps.
  assert.equal((value.match(/30 Sept 2026/g) || []).length, 1, 'the date is not repeated');
  assert.match(value, /20:35–21:35/);

  const html = print.renderIncidentReportHtml(
    report.buildIncidentReport(SAME_DAY, AUDIT_4, [], LONDON), { generatedAt: GENERATED },
  );
  assert.ok(html.includes('20:35–21:35'), 'and the printout says the same');
  assert.equal((html.match(/30 Sept 2026 · 20:35/g) || []).length, 1);
});

test('FINAL-02-OVERNIGHT-SHIFT-NAMES-BOTH-CALENDAR-DATES', () => {
  const value = scheduledOf(report.buildIncidentReport(OVERNIGHT, AUDIT_4, [], LONDON));

  assert.match(value, /30 Sept 2026/, 'the day it started');
  assert.match(value, /01 Oct 2026/, 'and the day it ended — the change of day is explicit');
  assert.match(value, / – /, 'spaced around the dash, because the reader needs the pause');
  assert.ok(value.includes('20:00') && value.includes('08:00'), 'both times, on the site clock');

  const html = print.renderIncidentReportHtml(
    report.buildIncidentReport(OVERNIGHT, AUDIT_4, [], LONDON), { generatedAt: GENERATED },
  );
  assert.ok(html.includes('30 Sept 2026') && html.includes('01 Oct 2026'), 'the printout keeps both');
});

test('FINAL-03-DRAWER-AND-PRINT-SHARE-ONE-SHIFT-RULE', () => {
  // One exported formatter, and both surfaces read the SAME built value — they cannot drift.
  assert.equal(typeof report.scheduledShiftLabel, 'function');
  for (const incident of [SAME_DAY, OVERNIGHT]) {
    const model = report.buildIncidentReport(incident, AUDIT_4, [], LONDON);
    const expected = report.scheduledShiftLabel(incident.shift, LONDON);
    assert.equal(scheduledOf(model), expected, 'the model uses the shared formatter');
    assert.ok(textOf(drawer(model)).includes(expected), 'the drawer renders that value');
    assert.ok(
      print.renderIncidentReportHtml(model, { generatedAt: GENERATED }).includes(print.escapeHtml(expected)),
      'and so does the printout',
    );
  }

  // Neither surface formats a shift window of its own.
  for (const file of [
    'src/components/company/CompanyIncidentReportDrawer.tsx',
    'src/components/company/incidentReportPrint.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/formatInstantDateTime|scheduledShiftLabel/.test(source), `${file} formats no times itself`);
  }
});

test('FINAL-04-A-REAL-NAME-IS-PREFERRED-WHEN-GENUINELY-AVAILABLE', () => {
  const named = AUDIT_4.map((entry) => (entry.action === 'incident.status_updated'
    ? { ...entry, user: { id: 21, firstName: 'Dana', lastName: 'Okafor', email: 'control@example.invalid' } }
    : entry));
  const model = report.buildIncidentReport(INCIDENT_4, named, [], LONDON);

  const review = model.handling.find((entry) => entry.label === 'Marked In Review');
  const resolved = model.handling.find((entry) => entry.label === 'Resolved');
  assert.equal(review.actor, 'Dana Okafor', 'the name, not the account');
  assert.equal(resolved.actor, 'Dana Okafor');
  assert.equal(model.resolution.by, 'Dana Okafor', 'and "Resolved by" agrees');

  const rendered = textOf(drawer(model));
  // `textOf` joins each text node with " | ", so the "By" label and the name are separate nodes.
  assert.match(rendered, /By\s*\|\s*Dana Okafor/, 'the name is what the drawer shows');
  assert.ok(!rendered.includes('control@example.invalid'), 'the email gives way to the name');

  // A guard's profile name is the person's real name, so it is preferred over their account email.
  const reported = model.handling.find((entry) => entry.label === 'Reported');
  assert.equal(reported.actor, 'Fahad test');

  // A single name is still a name.
  assert.equal(report.actorLabel({ firstName: 'Dana', email: 'd@example.invalid' }), 'Dana');
});

test('FINAL-05-EMAIL-REMAINS-A-TRUTHFUL-FALLBACK', () => {
  /**
   * This is what PRODUCTION looks like today: `users.firstName` and `users.lastName` are NULL for
   * every actor, so the email is the only identity the API can offer. A presentation preference is
   * not a reason to add a column or an endpoint.
   */
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  assert.equal(model.handling.find((e) => e.label === 'Marked In Review').actor, 'control@example.invalid');
  assert.equal(model.resolution.by, 'control@example.invalid');
  assert.equal(report.actorLabel({ email: 'who@example.invalid' }), 'who@example.invalid');
  assert.equal(
    report.actorLabel({ firstName: '   ', lastName: null, email: 'who@example.invalid' }),
    'who@example.invalid',
    'whitespace is not a name',
  );
});

test('FINAL-06-NO-ACTOR-IDENTITY-IS-EVER-INVENTED', () => {
  // No user on the audit row at all: a control action says Control, and names nobody.
  const anonymous = AUDIT_4.map((entry) => ({ ...entry, user: null }));
  const model = report.buildIncidentReport({ ...INCIDENT_4, guard: null }, anonymous, [], LONDON);

  assert.equal(model.handling.find((e) => e.label === 'Marked In Review').actor, report.CONTROL_ACTOR);
  assert.equal(model.resolution.by, report.CONTROL_ACTOR);
  // A report the guard filed is never attributed to Control: it is simply left unnamed.
  assert.equal(model.handling.find((e) => e.label === 'Reported').actor, '');

  const rendered = textOf(drawer(model));
  assert.match(rendered, /Recorded by Control/);
  for (const leak of ['User #', 'undefined', 'null', '@']) {
    assert.ok(!rendered.includes(leak), `no "${leak}" stands in for a person`);
  }
  assert.equal(report.actorLabel(null), '', 'nothing in, nothing out');
  assert.equal(report.actorLabel({}), '');
});

test('FINAL-07-FOOTER-NAMES-THE-REAL-GUARDING-COMPANY', () => {
  const model = report.buildIncidentReport(
    { ...INCIDENT_4, company: { id: 8, name: 'vesoft Test Company' } }, AUDIT_4, [], LONDON,
  );
  assert.equal(model.companyName, 'vesoft Test Company', 'taken from the incident’s own record');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.match(html, /<span class="foot-company">vesoft Test Company<\/span>/);
  assert.ok(html.includes(`Report generated ${GENERATED}`));

  // S4 is the platform, never a stand-in for the guarding company.
  const nameless = print.renderIncidentReportHtml(
    report.buildIncidentReport({ ...INCIDENT_4, company: null }, AUDIT_4, [], LONDON),
    { generatedAt: GENERATED },
  );
  // The stylesheet always DEFINES .foot-company; only an emitted span proves a name was printed.
  assert.ok(
    !/<span class="foot-company">/.test(nameless),
    'an unnamed company is omitted, not substituted',
  );
  assert.ok(!/S4 Security/.test(nameless), 'and S4 never fills the gap');
});

test('FINAL-08-PRINTABLE-REPORT-CREDITS-THE-PLATFORM', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.match(html, /Generated using S4/);
  // Stated as the tool, separately from whoever guarded the site.
  assert.ok(
    html.indexOf('Generated using S4') > html.indexOf('<span class="foot-company">'),
    'beneath the company, not in place of it',
  );
});

test('FINAL-09-NO-SHARE-PLACEHOLDER-IN-THE-PRODUCTION-REPORT', () => {
  const drawerSource = fs.readFileSync(path.join(ROOT, 'src/components/company/CompanyIncidentReportDrawer.tsx'), 'utf8');
  const code = stripComments(drawerSource);
  for (const banned of ['Share with Client', 'coming soon', 'sharePlaceholder']) {
    assert.ok(!code.includes(banned), `"${banned}" is gone from the component`);
  }

  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const rendered = textOf(drawer(model));
  assert.ok(!/Share|coming soon/i.test(rendered), 'and nothing renders it');

  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.ok(!/Share|coming soon/i.test(html), 'nor the printout');
});

test('FINAL-10-CLOSE-AND-PRINT-REMAIN-THE-ACTIONS', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const buttons = buttonsOf(drawer(model));
  const labels = buttons.map((button) => button.label);

  assert.ok(labels.includes('Close'), 'Close remains');
  assert.ok(labels.includes('Print / Save PDF'), 'Print / Save PDF remains');
  assert.deepEqual(
    labels.filter((label) => !/^Close/.test(label)), ['Print / Save PDF'],
    'and they are the only actions',
  );

  // Print is wired to the handler it is labelled with.
  let printed = 0;
  const live = buttonsOf(drawer(model, { onPrint: () => { printed += 1; } }));
  live.find((button) => button.label === 'Print / Save PDF').press();
  assert.equal(printed, 1);
});

test('FINAL-11-INCIDENT-4-STILL-READS-AS-IT-DID', () => {
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const rendered = textOf(drawer(model));
  for (const fact of ['Broken fence', 'Client informed', 'no issue', 'No evidence attached']) {
    assert.ok(rendered.includes(fact), `the report still shows "${fact}"`);
  }
  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  for (const fact of ['Broken fence', 'Client informed', 'no issue', 'No evidence attached']) {
    assert.ok(html.includes(fact), `and so does the printout: "${fact}"`);
  }
});

test('FINAL-12-HISTORICAL-NULL-SAFE-REPORT-STILL-PASSES', () => {
  const model = report.buildIncidentReport(HISTORICAL, [], [], LONDON);
  const rendered = textOf(drawer(model));

  assert.match(rendered, /No resolution evidence recorded/);
  assert.match(rendered, /No evidence attached/);
  assert.ok(rendered.includes(report.NOT_RECORDED), 'absent facts read as an em dash');
  assert.equal(scheduledOf(model), report.NOT_RECORDED, 'a shiftless incident states no window');
  for (const leak of ['null', 'undefined', 'NaN', 'Invalid Date', 'User #']) {
    assert.ok(!rendered.includes(leak), `nothing renders as "${leak}"`);
  }
  const html = print.renderIncidentReportHtml(model, { generatedAt: GENERATED });
  assert.ok(!/undefined|NaN|Invalid Date/.test(html));
  assert.ok(!/<span class="foot-company">/.test(html), 'and no company is invented for it');
});

test('FINAL-13-VIEWING-AND-PRINTING-STILL-WRITE-NOTHING', () => {
  for (const file of [
    'src/components/company/incidentReport.ts',
    'src/components/company/incidentReportPrint.ts',
    'src/components/company/CompanyIncidentReportDrawer.tsx',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/services\/api/.test(source), `${file} imports no API client`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|axios/.test(source), `${file} issues no request`);
    assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)/i.test(source), `${file} performs no write`);
  }

  // Pressing Print calls only the print handler — nothing else is dispatched.
  const model = report.buildIncidentReport(INCIDENT_4, AUDIT_4, [], LONDON);
  const calls = [];
  const buttons = buttonsOf(drawer(model, {
    onPrint: () => calls.push('print'),
    onClose: () => calls.push('close'),
  }));
  buttons.forEach((button) => button.press());
  assert.ok(calls.every((call) => call === 'print' || call === 'close'), `only print/close, got ${calls.join(',')}`);
});

console.log(`\n${passed} incident report checks passed`);
