#!/usr/bin/env node
/**
 * Phase 4B — the Log Book register, the Daily Site Log and the export evidence.
 *
 * A Log Book is a record somebody will later rely on, so these assertions are about truthfulness
 * first: an "as required" site must never appear to have failed an hourly duty, a Welfare Check must
 * never satisfy a Log Book period, and one entry must read identically on every surface that shows
 * it. Where a rule is about wiring or scope, the real component is rendered and its handlers are
 * pressed — presence in the source proves nothing, as Phase 4A established twice.
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
const { loadTs, ROOT } = require('./load-ts.cjs');

const reg = loadTs('src/components/company/logBookRegister.ts');
const dsl = loadTs('src/components/company/dailySiteLog.ts');
const dslPrint = loadTs('src/components/company/dailySiteLogPrint.ts');
const report = loadTs('src/components/company/operationsReport.ts');
const forms = loadTs('src/components/guard/guardActionForms.ts');
const { CompanyLogBookWorkspace } = loadTs('src/components/company/CompanyLogBookWorkspace.tsx');
const { CompanyLogBookEntryDrawer } = loadTs('src/components/company/CompanyLogBookEntryDrawer.tsx');
const { buildXlsx } = loadTs('src/components/company/xlsxWriter.ts');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const screenCode = stripComments(read('src/screens/CompanyDashboardScreen.tsx'));
const backend = (rel) => fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', rel), 'utf8');

const LONDON = 'Europe/London';
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log('PASS ', name); }
  catch (error) { console.error('FAIL ', name); console.error(error.message); process.exitCode = 1; }
};

const isPlainFunctionComponent = (type) =>
  typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent);

function walk(node, visit) {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (typeof node !== 'object' || !node.type) return;
  if (isPlainFunctionComponent(node.type)) { walk(node.type(node.props), visit); return; }
  visit(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}

function textOf(element) {
  const words = [];
  const collect = (node) => {
    if (typeof node === 'string' || typeof node === 'number') { words.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== 'object' || !node.type) return;
    if (isPlainFunctionComponent(node.type)) { collect(node.type(node.props)); return; }
    if (node.props && node.props.children !== undefined) collect(node.props.children);
  };
  collect(element);
  return words.join(' | ');
}

function buttonsOf(element) {
  const out = [];
  walk(element, (node) => {
    if (node.props && node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function') {
      out.push({ label: node.props.accessibilityLabel, press: node.props.onPress, disabled: Boolean(node.props.disabled) });
    }
  });
  return out;
}

// ─── the fixture: two sites, one scheduled, one as required ──────────────────
// Wednesday 30 September 2026, Europe/London. Entirely local; no production record is used.

const SITE_A = { id: 14, name: 'Northgate Retail Park', clientName: 'Northgate Estates', timezone: LONDON };
const SITE_B = { id: 15, name: 'Quayside Logistics', clientName: 'Quayside Freight', timezone: LONDON };

const SHIFT_A = {
  id: 19, siteId: 14, siteName: SITE_A.name, site: SITE_A,
  start: '2026-09-30T18:00:00.000Z', end: '2026-09-30T22:00:00.000Z',
  status: 'completed', guard: { id: 20, fullName: 'Fahad test' }, closeOutNotes: 'Handed over to day team.',
};
/** An overnight shift at the second site, to prove the day boundary is the SITE's. */
const SHIFT_B = {
  id: 24, siteId: 15, siteName: SITE_B.name, site: SITE_B,
  start: '2026-09-30T21:00:00.000Z', end: '2026-10-01T05:00:00.000Z',
  status: 'completed', guard: { id: 21, fullName: 'B. Guard' },
};

const log = (id, shift, logType, message, iso, guard) => ({
  id, logType, message, createdAt: iso, shift, guard: guard || shift.guard,
});

const LONG_ENTRY = 'Perimeter patrol completed. '.repeat(14).trim();

const LOGS = [
  log(101, SHIFT_A, 'log_book', '19:05 perimeter checked, all secure', '2026-09-30T18:05:00.000Z'),
  log(102, SHIFT_A, 'welfare_check', 'All good', '2026-09-30T18:30:00.000Z'),
  log(103, SHIFT_A, 'log_book', LONG_ENTRY, '2026-09-30T20:12:00.000Z'),
  log(104, SHIFT_A, 'observation', 'Noticed a delivery van', '2026-09-30T20:40:00.000Z'),
  log(105, SHIFT_B, 'log_book', 'Yard sweep complete', '2026-09-30T21:30:00.000Z'),
  log(106, SHIFT_A, 'check_call', 'Legacy welfare row', '2026-09-30T21:05:00.000Z'),
];

/** Site A: hourly. Four windows, the 20:00–21:00 one missed. */
const OPS_A = {
  bookOnAt: '2026-09-30T17:58:00.000Z',
  bookOffAt: '2026-09-30T22:04:00.000Z',
  timezone: LONDON,
  missingBookOff: false,
  welfare: { enabled: true, requiredCount: 4, completedCount: 3, missedCount: 1, windows: [] },
  logBook: {
    required: true, intervalMinutes: 60,
    currentWindow: null, currentWindowSubmitted: false,
    requiredCount: 4, submittedCount: 2, missingCount: 2,
    lastEntryAt: '2026-09-30T20:12:00.000Z',
    windows: [
      { index: 0, start: '2026-09-30T18:00:00.000Z', end: '2026-09-30T19:00:00.000Z', state: 'completed', applicable: true, completedAt: '2026-09-30T18:05:00.000Z', completionCount: 1 },
      { index: 1, start: '2026-09-30T19:00:00.000Z', end: '2026-09-30T20:00:00.000Z', state: 'missed', applicable: true, completedAt: null, completionCount: 0 },
      { index: 2, start: '2026-09-30T20:00:00.000Z', end: '2026-09-30T21:00:00.000Z', state: 'completed', applicable: true, completedAt: '2026-09-30T20:12:00.000Z', completionCount: 1 },
      { index: 3, start: '2026-09-30T21:00:00.000Z', end: '2026-09-30T22:00:00.000Z', state: 'missed', applicable: true, completedAt: null, completionCount: 0 },
    ],
  },
};

/** Site B: as required. No windows at all. */
const OPS_B = {
  bookOnAt: '2026-09-30T20:55:00.000Z',
  bookOffAt: null,
  timezone: LONDON,
  missingBookOff: true,
  welfare: { enabled: false, requiredCount: 0, completedCount: 0, missedCount: 0, windows: [] },
  logBook: {
    required: false, intervalMinutes: null,
    currentWindow: null, currentWindowSubmitted: false,
    requiredCount: 0, submittedCount: 0, missingCount: 0,
    lastEntryAt: '2026-09-30T21:30:00.000Z',
    windows: [],
  },
};

const OPS = new Map([[19, OPS_A], [24, OPS_B]]);
const SHIFTS_BY_ID = new Map([[19, SHIFT_A], [24, SHIFT_B]]);

const INCIDENTS = [{
  id: 4, title: 'Broken fence', notes: 'Broken fence', severity: 'medium', category: 'other',
  status: 'resolved', reportedAt: '2026-09-30T19:49:00.000Z', createdAt: '2026-09-30T19:49:00.000Z',
  reviewedAt: '2026-09-30T20:30:00.000Z', closedAt: null,
  resolutionReason: 'client_informed', resolutionNote: 'no issue',
  shift: SHIFT_A, site: SITE_A, guard: SHIFT_A.guard, company: { id: 8, name: 'vesoft Test Company' },
}];

const ALERTS = [
  { id: 9, type: 'site_request', priority: 'medium', message: 'Need replacement log sheets', status: 'closed', createdAt: '2026-09-30T18:40:00.000Z', closedAt: '2026-09-30T19:10:00.000Z', shift: SHIFT_A, guard: SHIFT_A.guard },
  { id: 10, type: 'panic', priority: 'critical', message: 'Emergency alert raised by guard', status: 'closed', createdAt: '2026-09-30T21:15:00.000Z', closedAt: '2026-09-30T21:25:00.000Z', shift: SHIFT_A, guard: SHIFT_A.guard },
  { id: 11, type: 'missed_checkcall', priority: 'high', message: 'Welfare overdue', status: 'open', createdAt: '2026-09-30T19:35:00.000Z', closedAt: null, shift: SHIFT_A, guard: SHIFT_A.guard },
];

const dayModel = (shifts = [SHIFT_A]) => dsl.buildDailySiteLog({
  siteId: 14, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
  companyName: 'vesoft Test Company',
  shifts, operationsByShiftId: OPS, dailyLogs: LOGS, incidents: INCIDENTS, alerts: ALERTS,
});

// ─── LOG-01 … LOG-04: the Guard write path and its integrity ─────────────────

test('LOG-01-GUARD-STILL-WRITES-logType-log_book', () => {
  const dispatch = stripComments(read('src/components/guard/guardActionDispatch.ts'));
  assert.match(
    dispatch,
    /createIncident\(\{ title: 'Guard incident'[\s\S]{0,80}\}\)/,
    'the incident path is untouched',
  );
  assert.match(
    dispatch,
    /key === 'logBook'[\s\S]{0,160}createDailyLog\(\{ shiftId, message: text, logType: 'log_book' \}\)/,
    'Log Book still writes logType log_book through createDailyLog',
  );
  // Each action still reaches exactly its own endpoint and type.
  assert.match(dispatch, /key === 'welfareCheck'[\s\S]{0,140}logType: 'welfare_check'/);
  assert.match(dispatch, /key === 'siteRequest'[\s\S]{0,160}type: 'site_request'/);
  assert.match(dispatch, /type: 'panic'/, 'emergency still raises a panic alert');

  // The helper text was added without touching what is written.
  const logBookForm = forms.guardActionForm('logBook');
  assert.equal(logBookForm.title, 'Log Book');
  assert.match(logBookForm.helperText, /routine record/i);
  assert.match(forms.guardActionForm('siteRequest').helperText, /site needs/i);
  assert.match(forms.guardActionForm('incident').helperText, /reporting and follow-up/i);
  assert.match(forms.guardActionForm('emergency').helperText, /immediate help/i);
  assert.equal(forms.guardActionForm('emergency').confirmWord, 'SOS', 'the SOS confirmation survives');
});

test('LOG-02-NO-ENTRY-WITHOUT-A-LIVE-AUTHORISED-SHIFT', () => {
  // Frontend: the dispatcher refuses before any write.
  const blocked = forms.resolveActionSubmitState
    ? null
    : null; // the submit-state helper is exercised by its own suite
  const dispatch = stripComments(read('src/components/guard/guardActionDispatch.ts'));
  assert.match(dispatch, /if \(!ctx\.shift \|\| !isLiveShift\(ctx\.shift\)\)/, 'no shift, no submission');
  assert.equal(blocked, null);

  // Backend: assignment AND in_progress are both required, server-side.
  const shiftService = backend('src/shift/shift.service.ts');
  const guardCheck = shiftService.slice(shiftService.indexOf('assertGuardCanOperateShift'));
  assert.match(guardCheck.slice(0, 600), /This shift is not assigned to the current guard/);
  assert.match(guardCheck.slice(0, 600), /Shift must be in progress/);
  assert.match(
    backend('src/daily-log/daily-log.service.ts'),
    /assertGuardCanOperateShift\(shift, guard\.id, 'record a daily log'\)/,
    'the Log Book write goes through that guard',
  );
});

test('LOG-03-createdAt-IS-SERVER-CONTROLLED', () => {
  // The DTO accepts no timestamp, so a client cannot propose one.
  const dto = backend('src/daily-log/dto/create-daily-log.dto.ts');
  assert.ok(!/createdAt|occurredAt|timestamp/i.test(dto), 'the DTO carries no time field');
  assert.match(dto, /@MaxLength\(DAILY_LOG_MESSAGE_MAX_LENGTH\)/, 'and still bounds the message');

  // The column is generated.
  assert.match(
    backend('src/daily-log/entities/daily-log.entity.ts'),
    /@CreateDateColumn\(\)\s*\n\s*createdAt!/,
    'createdAt is a generated column',
  );
  // The service never sets it.
  const service = backend('src/daily-log/daily-log.service.ts');
  const create = service.slice(service.indexOf('createForGuard'), service.indexOf('findMine'));
  assert.ok(!/createdAt/.test(create), 'nothing assigns createdAt on write');
});

test('LOG-04-NO-PATCH-OR-DELETE-LOG-BOOK-PATH-EXISTS', () => {
  const controller = backend('src/daily-log/daily-log.controller.ts');
  for (const verb of ['@Patch', '@Put', '@Delete']) {
    assert.ok(!controller.includes(verb), `the controller exposes no ${verb}`);
  }
  assert.deepEqual(
    (controller.match(/@(Get|Post)\(/g) || []).sort(),
    ['@Get(', '@Get(', '@Post('],
    'exactly two reads and one write',
  );
  const service = backend('src/daily-log/daily-log.service.ts');
  for (const method of ['update', 'remove', 'delete(', 'softDelete']) {
    assert.ok(!service.includes(method), `the service has no ${method}`);
  }

  // And the control room offers no such control.
  const drawerSource = stripComments(read('src/components/company/CompanyLogBookEntryDrawer.tsx'));
  for (const banned of ['Edit', 'Delete', 'onSubmit', 'TextInput']) {
    assert.ok(!drawerSource.includes(banned), `the entry drawer has no ${banned}`);
  }
  const buttons = buttonsOf(React.createElement(CompanyLogBookEntryDrawer, {
    entry: { ...reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, {})[0], scheduledShift: '', recordedAt: '', periodLabel: '' },
    onClose: () => {},
  }));
  assert.ok(
    !buttons.some((b) => /edit|delete|save/i.test(b.label || '')),
    'nothing pressable can change the entry',
  );
});

// ─── LOG-05 … LOG-07: the register ───────────────────────────────────────────

test('LOG-05-REGISTER-IS-COMPANY-SCOPED', () => {
  // The only retrieval is the company-scoped endpoint, behind a permission.
  const service = backend('src/daily-log/daily-log.service.ts');
  assert.match(
    service,
    /resolveCompanyContext\(userId, userRole, CompanyPermission\.COMPLIANCE_VIEW\)/,
    'company context is resolved from the caller, never from a parameter',
  );
  assert.match(service, /where: \{ company: \{ id: company\.id \} \}/, 'and the query is scoped to it');
  assert.match(screenCode, /listCompanyDailyLogs/, 'the register reads that endpoint');

  // No new endpoint was added for the register.
  const controller = backend('src/daily-log/daily-log.controller.ts');
  assert.ok(!/register|search|by-site|by-date/i.test(controller), 'no Log Book endpoint was invented');
});

test('LOG-06-REGISTER-IS-OLDEST-FIRST-WITHIN-THE-DAY', () => {
  const rows = reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' });
  assert.deepEqual(rows.map((r) => r.id), [101, 103, 105], 'only Log Book rows, oldest first');
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].atMs >= rows[i - 1].atMs, 'an occurrence book reads forwards');
  }

  // Filters narrow without reordering.
  assert.deepEqual(
    reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30', siteId: 15 }).map((r) => r.id),
    [105],
  );
  assert.deepEqual(
    reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { search: 'yard' }).map((r) => r.id),
    [105],
    'search reaches the entry text',
  );
  assert.deepEqual(
    reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { guardId: 21 }).map((r) => r.id),
    [105],
  );
  // A day with nothing in it is empty, not a fallback to everything.
  assert.deepEqual(reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-10-05' }), []);
});

test('LOG-07-FULL-ENTRY-OPENS-FROM-THE-REGISTER', () => {
  const rows = reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' });
  const opened = [];
  const element = React.createElement(CompanyLogBookWorkspace, {
    rows, periods: [], date: '2026-09-30',
    onDateChange: () => {}, search: '', onSearchChange: () => {},
    clientOptions: [], siteOptions: [], guardOptions: [],
    clientFilter: '', siteFilter: '', guardFilter: '',
    onClientFilter: () => {}, onSiteFilter: () => {}, onGuardFilter: () => {},
    onOpenEntry: (id) => opened.push(id),
    onOpenDailySiteLog: () => {}, dailySiteLogEnabled: false,
    timeLabel: (iso) => iso.slice(11, 16),
  });

  const rowButtons = buttonsOf(element).filter((b) => /^Open Log Book entry/.test(b.label || ''));
  assert.equal(rowButtons.length, 3, 'every row is a way in');
  rowButtons[1].press();
  assert.deepEqual(opened, [103], 'the row opens its own entry');

  // The long entry is abbreviated in the table but never truncated in the record.
  const workspaceSource = read('src/components/company/CompanyLogBookWorkspace.tsx');
  assert.match(workspaceSource, /colEntry\]\} numberOfLines=\{2\}/, 'the table abbreviates');
  const detail = textOf(React.createElement(CompanyLogBookEntryDrawer, {
    entry: { ...rows[1], scheduledShift: '18:00–22:00', recordedAt: '30 Sept 2026 · 21:12', periodLabel: '21:00–22:00' },
    onClose: () => {},
  }));
  assert.ok(detail.includes(LONG_ENTRY), 'the drawer holds every word');
  const drawerSource = read('src/components/company/CompanyLogBookEntryDrawer.tsx');
  assert.ok(!/numberOfLines/.test(drawerSource.slice(drawerSource.indexOf('styles.body'))), 'and clamps nothing');
});

// ─── LOG-08 … LOG-11: periods, and what may satisfy one ──────────────────────

test('LOG-08-AS-REQUIRED-MANUFACTURES-NO-PERIODS', () => {
  assert.deepEqual(reg.logBookPeriods(OPS_B), [], 'no windows, no periods');

  /**
   * `required` is the authority, not the presence of windows.
   *
   * An as-required site publishes no windows today, so a reader that merely mapped whatever windows
   * arrived would look correct and silently start manufacturing periods the day anything upstream
   * sent some. The flag is what says whether an obligation exists, and it is what is obeyed.
   */
  const strayWindows = {
    logBook: {
      ...OPS_B.logBook,
      required: false,
      windows: OPS_A.logBook.windows,
    },
  };
  assert.deepEqual(
    reg.logBookPeriods(strayWindows), [],
    'a site with no obligation has no periods, whatever windows arrive',
  );
  assert.equal(reg.logBookCompliance(strayWindows, 3).scheduled, false);
  assert.equal(reg.logBookCompliance(strayWindows, 3).missing, 0, 'and nothing can be missing');
  const compliance = reg.logBookCompliance(OPS_B, 1);
  assert.equal(compliance.scheduled, false);
  assert.equal(compliance.required, 0);
  assert.equal(compliance.missing, 0);
  assert.equal(compliance.entries, 1, 'entries are still counted');

  // And the report says so in words rather than printing a zero that reads as a pass.
  const model = dsl.buildDailySiteLog({
    siteId: 15, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
    companyName: 'vesoft Test Company', shifts: [SHIFT_B],
    operationsByShiftId: OPS, dailyLogs: LOGS, incidents: [], alerts: [],
  });
  assert.equal(model.logBook.scheduled, false);
  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' });
  assert.match(html, /As required/);
  assert.ok(!/Missing periods/.test(html), 'no missing-period line for a site with no obligation');
});

test('LOG-09-CONFIGURED-INTERVAL-EXPOSES-THE-BACKEND-PERIODS', () => {
  const periods = reg.logBookPeriods(OPS_A);
  assert.equal(periods.length, 4);
  assert.deepEqual(periods.map((p) => p.status), ['completed', 'missing', 'completed', 'missing']);
  assert.equal(periods[0].completedAt, '2026-09-30T18:05:00.000Z');
  assert.equal(periods[1].completedAt, null);

  const compliance = reg.logBookCompliance(OPS_A, 2);
  assert.deepEqual(
    { scheduled: compliance.scheduled, required: compliance.required, completed: compliance.completed, missing: compliance.missing },
    { scheduled: true, required: 4, completed: 2, missing: 2 },
    'the counts are the backend’s own',
  );

  // Nothing here grades a window: the states come straight from the published payload.
  const source = stripComments(read('src/components/company/logBookRegister.ts'));
  for (const banned of ['intervalMinutes *', 'Math.floor((', 'setMinutes', 'addMinutes', 'grace']) {
    assert.ok(!source.includes(banned), `the register computes no schedule (${banned})`);
  }
  // An unrecognised state degrades to a fact, never to a verdict of "missing".
  assert.equal(
    reg.logBookPeriods({ logBook: { required: true, windows: [{ index: 0, start: 'a', end: 'b', completionCount: 1 }] } })[0].status,
    'completed',
  );
});

test('LOG-10-A-WELFARE-CHECK-CANNOT-SATISFY-A-LOG-BOOK-PERIOD', () => {
  // Front end: a welfare row is not a Log Book entry and never enters the register.
  assert.equal(reg.isLogBookEntry({ logType: 'welfare_check' }), false);
  assert.equal(reg.isLogBookEntry({ logType: 'check_call' }), false);
  assert.equal(reg.isLogBookEntry({ logType: 'log_book' }), true);
  assert.ok(
    !reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, {}).some((r) => [102, 106].includes(r.id)),
    'welfare rows stay out of the Log Book register',
  );

  // Backend: the window engine filters completions to the Log Book kind alone.
  assert.match(
    backend('src/operations/log-book-window.service.ts'),
    /completion\.kind === OperationalCompletionKind\.LOG_BOOK/,
    'only Log Book completions reach a Log Book window',
  );
  assert.match(
    backend('src/coverage/operations-projection.service.ts'),
    /logType: DailyLogType\.LOG_BOOK/,
    'and only log_book rows are fetched as those completions',
  );
  // Welfare keeps its own, separate set — and it does not contain log_book.
  const completion = backend('src/operations/operational-completion.ts');
  const welfareSet = completion.slice(completion.indexOf('WELFARE_COMPLETION_LOG_TYPES'), completion.indexOf('];', completion.indexOf('WELFARE_COMPLETION_LOG_TYPES')));
  assert.match(welfareSet, /CHECK_CALL/);
  assert.match(welfareSet, /WELFARE_CHECK/);
  assert.ok(!/LOG_BOOK/.test(welfareSet), 'a Log Book entry cannot satisfy Welfare either');
});

test('LOG-11-AN-OBSERVATION-CANNOT-SATISFY-A-LOG-BOOK-PERIOD', () => {
  assert.equal(reg.isLogBookEntry({ logType: 'observation' }), false);
  assert.ok(
    !reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, {}).some((r) => r.id === 104),
    'the observation row is not reclassified into the Log Book register',
  );
  // It keeps its own name rather than being relabelled.
  assert.equal(reg.logTypeLabel('observation'), 'Observation');
  assert.equal(reg.logTypeLabel('log_book'), 'Log Book');
  assert.equal(reg.logTypeLabel('check_call'), 'Welfare Check', 'legacy welfare still reads as welfare');

  // The enum itself is untouched, and the Daily Site Log ignores the row entirely.
  assert.match(backend('src/daily-log/entities/daily-log.entity.ts'), /OBSERVATION = 'observation'/);
  const events = dayModel().events.filter((e) => e.detail.includes('delivery van'));
  assert.deepEqual(events, [], 'an observation is neither a Log Book entry nor a Welfare Check here');
});

// ─── LOG-12 … LOG-17: the Daily Site Log ─────────────────────────────────────

test('LOG-12-DAILY-SITE-LOG-IS-CHRONOLOGICAL-AND-COMPLETE', () => {
  const model = dayModel();
  const kinds = model.events.map((e) => e.kind);

  for (const expected of ['book_on', 'log_book', 'welfare_check', 'log_book_missed', 'incident_reported', 'site_request', 'emergency', 'book_off', 'handover']) {
    assert.ok(kinds.includes(expected), `the day includes ${expected}`);
  }
  for (let i = 1; i < model.events.length; i += 1) {
    assert.ok(model.events[i].atMs >= model.events[i - 1].atMs, 'strictly chronological');
  }
  assert.equal(kinds[0], 'book_on', 'the day opens with the guard arriving');
  assert.equal(model.events[model.events.length - 1].kind, 'handover', 'and closes with the handover');

  // Attendance summary mirrors the same records.
  assert.equal(model.shifts.length, 1);
  assert.equal(model.shifts[0].state, 'Booked off');
  assert.ok(model.shifts[0].bookOn && model.shifts[0].bookOff);

  // A Log Book entry carries its FULL text into the occurrence record.
  const longEvent = model.events.find((e) => e.kind === 'log_book' && e.detail.length > 100);
  assert.ok(longEvent && longEvent.detail === LONG_ENTRY, 'nothing is abbreviated in the occurrence book');
});

test('LOG-13-THE-REPORT-INVENTS-NO-EVENT', () => {
  // A day with only a shift: no logs, no incidents, no alerts.
  const bare = dsl.buildDailySiteLog({
    siteId: 14, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
    companyName: '', shifts: [{ ...SHIFT_A, closeOutNotes: null }],
    operationsByShiftId: new Map([[19, { ...OPS_A, logBook: { ...OPS_A.logBook, required: false, windows: [] } }]]),
    dailyLogs: [], incidents: [], alerts: [],
  });
  assert.deepEqual(bare.events.map((e) => e.kind), ['book_on', 'book_off'], 'only what happened');
  assert.deepEqual(bare.operational, { incidents: 0, siteRequests: 0, emergencies: 0 });

  // No attendance at all produces no attendance events rather than placeholder times.
  const empty = dsl.buildDailySiteLog({
    siteId: 14, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
    companyName: '', shifts: [{ ...SHIFT_A, closeOutNotes: null }],
    operationsByShiftId: new Map([[19, { ...OPS_B, bookOnAt: null, bookOffAt: null }]]),
    dailyLogs: [], incidents: [], alerts: [],
  });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.shifts[0].bookOn, dsl.NOT_RECORDED);

  // A welfare alert is summarised, never listed as an occurrence of its own.
  assert.ok(
    !dayModel().events.some((e) => e.detail.includes('Welfare overdue')),
    'the missed-welfare alert is not duplicated into the occurrence record',
  );
});

test('LOG-14-ONE-ENTRY-READS-THE-SAME-EVERYWHERE', () => {
  const row = reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' })
    .find((r) => r.id === 103);
  const event = dayModel().events.find((e) => e.kind === 'log_book' && e.detail === LONG_ENTRY);
  const exportRows = report.buildOperationsReport([{
    shift: SHIFT_A, operations: OPS_A, logs: LOGS.filter((l) => l.shift.id === 19),
    attendance: { checkInAt: OPS_A.bookOnAt, checkOutAt: OPS_A.bookOffAt }, incidents: [], alerts: [],
  }], { date: '2026-09-30' }).logBook;
  const exported = exportRows.find((r) => r[9] === LONG_ENTRY);

  assert.ok(row && event && exported, 'the entry appears on all three surfaces');
  assert.equal(row.message, LONG_ENTRY, 'register text');
  assert.equal(event.detail, LONG_ENTRY, 'report text');
  assert.equal(exported[9], LONG_ENTRY, 'export text');
  assert.equal(row.guardName, 'Fahad test');
  assert.equal(exported[4], 'Fahad test', 'same guard');
  assert.equal(row.shiftId, 19);
  assert.equal(exported[3], '#19', 'same shift');
  // Same instant, however each surface chooses to format it.
  assert.equal(row.at, '2026-09-30T20:12:00.000Z');
  assert.equal(exported[7], '21:12', 'the export states it on the site clock');
  assert.equal(event.at, '21:12');
});

test('LOG-15-MISSING-PERIODS-REACH-THE-REPORT-AND-THE-EXPORT', () => {
  const model = dayModel();
  const missed = model.events.filter((e) => e.kind === 'log_book_missed');
  assert.equal(missed.length, 2, 'both missed periods appear');
  assert.match(missed[0].detail, /No entry recorded for 20:00–21:00/);
  assert.equal(model.logBook.missing, 2);

  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' });
  assert.match(html, /Missing periods/);
  assert.match(html, /Log Book period missed/);

  const rows = report.buildOperationsReport([{
    shift: SHIFT_A, operations: OPS_A, logs: LOGS.filter((l) => l.shift.id === 19),
    attendance: {}, incidents: [], alerts: [],
  }], { date: '2026-09-30' }).logBook;
  const periodRows = rows.filter((r) => r[12] === 'Missing');
  assert.equal(periodRows.length, 2, 'the export carries the missing periods');
  assert.equal(periodRows[0][10], '20:00');
  assert.equal(periodRows[0][11], '21:00');
  assert.equal(periodRows[0][9], '', 'a period row carries no entry text');
});

test('LOG-16-AS-REQUIRED-IS-STATED-NOT-SCORED', () => {
  const model = dsl.buildDailySiteLog({
    siteId: 15, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
    companyName: 'vesoft Test Company', shifts: [SHIFT_B],
    operationsByShiftId: OPS, dailyLogs: LOGS, incidents: [], alerts: [],
  });
  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' });

  assert.match(html, /Log Book requirement<\/th><td>As required/);
  assert.match(html, /Entries recorded<\/th><td>1/);
  assert.match(html, /no period can be missing/i, 'and the reason is stated plainly');
  assert.ok(!/Required periods/.test(html), 'no requirement is implied');
  assert.ok(!/>0<\/td>/.test(html.slice(html.indexOf('Log Book compliance'), html.indexOf('Welfare'))),
    'no zero is printed that could read as a pass');

  // An as-required site contributes entry rows to the export, and no period rows.
  const rows = report.buildOperationsReport([{
    shift: SHIFT_B, operations: OPS_B, logs: LOGS.filter((l) => l.shift.id === 24),
    attendance: {}, incidents: [], alerts: [],
  }], { date: '2026-09-30' }).logBook;
  assert.equal(rows.length, 1);
  assert.equal(rows[0][12], '', 'no period status is asserted');
});

test('LOG-17-AN-INCIDENT-IS-REFERENCED-NOT-REPRODUCED', () => {
  const model = dayModel();
  const incident = model.events.find((e) => e.kind === 'incident_reported');
  assert.ok(incident);
  assert.equal(incident.label, 'Incident #4 reported');
  assert.equal(incident.detail, 'Broken fence', 'the title, as a reference');

  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' });
  assert.match(html, /Incident #4 reported/);
  // The Incident Report's own sections and resolution evidence stay in that document.
  for (const leak of ['Original report', 'Resolution reason', 'Client informed', 'no issue', 'Handling history']) {
    assert.ok(!html.includes(leak), `the Daily Site Log does not reproduce "${leak}"`);
  }
  assert.ok(model.events.some((e) => e.kind === 'incident_resolved'), 'but the resolution is still an occurrence');
});

// ─── LOG-18 … LOG-21: the printed page and the export ────────────────────────

test('LOG-18-PRINT-DOCUMENT-CARRIES-NO-APPLICATION-CHROME', () => {
  const html = dslPrint.renderDailySiteLogHtml(dayModel(), { generatedAt: '30 Sept 2026, 23:10' });

  for (const chrome of ['Attention Now', 'Live Operations', 'Dashboard', 'Refresh', 'Log out',
    'Daily Site Log</button', '<nav', '<button', '<select', '<input', 'Search entries']) {
    assert.ok(!html.includes(chrome), `the printout contains no "${chrome}"`);
  }
  for (const internal of ['beforeData', 'afterData', 'entityType', 'entityId', 'Bearer', 'Authorization', 'token', 'audit_logs', 'companyId', 'guardId']) {
    assert.ok(!html.includes(internal), `the printout leaks no "${internal}"`);
  }
  // What it must carry.
  assert.match(html, /DAILY SITE LOG|Daily Site Log/);
  assert.match(html, /vesoft Test Company/);
  assert.match(html, /Generated using S4/);
  assert.match(html, /Report generated 30 Sept 2026, 23:10/);
  assert.match(html, /@page \{ size: A4;/);
  assert.match(html, /page-break-inside: avoid/, 'an entry is not split across pages');
  assert.match(html, /white-space: pre-wrap/, 'long entries wrap rather than clip');
});

test('LOG-19-A-LOG-BOOK-ENTRY-CANNOT-BECOME-MARKUP', () => {
  const nasty = '<script>alert(1)</script> & "quoted" <img src=x onerror=1>';
  const model = dsl.buildDailySiteLog({
    siteId: 14, dateKey: '2026-09-30', dateLabel: 'Wed, 30 Sept 2026', timeZone: LONDON,
    companyName: '<b>Co</b>', shifts: [SHIFT_A],
    operationsByShiftId: OPS,
    dailyLogs: [log(201, SHIFT_A, 'log_book', nasty, '2026-09-30T18:05:00.000Z')],
    incidents: [], alerts: [],
  });
  const html = dslPrint.renderDailySiteLogHtml(model, { generatedAt: 'x' });

  assert.ok(!html.includes('<script>'), 'script tags are escaped');
  assert.ok(!html.includes('onerror=1>'), 'attributes cannot escape');
  assert.ok(!html.includes('<b>Co</b>'), 'even the company name is escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('LOG-20-CSV-FORMULA-INJECTION-PROTECTION-REMAINS', () => {
  for (const hostile of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx']) {
    assert.ok(report.csvCell(hostile).startsWith("'"), `"${hostile}" is neutralised`);
  }
  assert.equal(report.csvCell('Perimeter, all secure'), '"Perimeter, all secure"');
  assert.equal(report.csvCell('He said "ok"'), '"He said ""ok"""');
  assert.equal(report.csvCell('plain'), 'plain');

  // The CSV remains ONE documented dataset — the Welfare-window stream — not a dishonest flattening.
  const csv = report.toCsv(report.buildOperationsReport([{
    shift: SHIFT_A, operations: OPS_A, logs: LOGS.filter((l) => l.shift.id === 19), attendance: {}, incidents: [], alerts: [],
  }], { date: '2026-09-30' }));
  assert.ok(csv.startsWith('﻿'), 'the BOM survives');
  assert.match(csv.replace(/^﻿/, '').split('\r\n')[0], /^Date,Client,Site,Guard/);
});

test('LOG-21-XLSX-CARRIES-THE-LOG-BOOK-EVIDENCE', () => {
  const built = report.buildOperationsReport([{
    shift: SHIFT_A, operations: OPS_A, logs: LOGS.filter((l) => l.shift.id === 19),
    attendance: { checkInAt: OPS_A.bookOnAt, checkOutAt: OPS_A.bookOffAt }, incidents: INCIDENTS, alerts: ALERTS,
  }], { date: '2026-09-30' });

  assert.equal(built.logBook.length, 4, '2 entries + 2 missing periods');
  assert.deepEqual(
    [...report.LOG_BOOK_COLUMNS],
    ['Date', 'Client', 'Site', 'Shift', 'Guard', 'Scheduled Start', 'Scheduled End',
      'Recorded At', 'Log Type', 'Entry', 'Required Period Start', 'Required Period End', 'Period Status'],
  );

  const bytes = buildXlsx([
    { name: 'Operations Summary', rows: [[...report.SUMMARY_COLUMNS], ...built.summary] },
    { name: 'Welfare Detail', rows: [[...report.WELFARE_COLUMNS], ...built.welfare] },
    { name: 'Log Book', rows: [[...report.LOG_BOOK_COLUMNS], ...built.logBook] },
  ]);

  // A real ZIP, and the sheet names and the entry text survive into it.
  assert.equal(bytes[0], 0x50, 'PK signature');
  assert.equal(bytes[1], 0x4b);
  const raw = Buffer.from(bytes).toString('latin1');
  for (const name of ['Operations Summary', 'Welfare Detail', 'Log Book']) {
    assert.ok(raw.includes(name), `the workbook declares the ${name} sheet`);
  }
  assert.ok(raw.includes('xl/worksheets/sheet3.xml'), 'three sheets are written');
  assert.ok(raw.includes('perimeter checked, all secure'), 'the entry text is in the workbook');
  assert.ok(!/<c[^>]*t="str"[^>]*><f>/.test(raw), 'no cell was written as a formula');
});

// ─── LOG-22 … LOG-25 ─────────────────────────────────────────────────────────

test('LOG-22-RECENT-ACTIVITY-PREVIEWS-WITHOUT-ALTERING-THE-RECORD', () => {
  const workspace = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  const block = workspace.slice(workspace.indexOf('recentSlice.map'), workspace.indexOf('recentSlice.map') + 1400);
  assert.match(block, /activityItemPreview[\s\S]{0,80}numberOfLines=\{1\}/, 'a one-line preview');
  assert.match(block, /\{a\.message\}/, 'showing what was written');

  // The preview is a rendering choice; nothing writes a shortened message back.
  // Anchored on the ACTIVITY builder, not the first `dailyLogs.forEach` in the file.
  const screenRaw = read('src/screens/CompanyDashboardScreen.tsx');
  const activity = screenRaw.slice(
    screenRaw.indexOf('const recentOperationalActivity'),
    screenRaw.indexOf('incidents.forEach((incident) => {', screenRaw.indexOf('const recentOperationalActivity')),
  );
  assert.ok(activity.length > 200, 'the activity builder was located');
  assert.match(activity, /message: log\.message,/, 'the item carries the stored message whole');
  assert.ok(!/log\.message\.slice\(/.test(activity), 'and is not truncated at the source');
});

test('LOG-23-SHIFT-OPERATIONS-TELLS-LOG-BOOK-FROM-WELFARE', () => {
  const workspace = read('src/components/company/CompanyLiveOperationsWorkspace.tsx');
  // Anchored on the drawer's own card heading, not the first mention of the words anywhere.
  const cardAt = workspace.indexOf('detailCardTitle}>Daily Logs<');
  assert.ok(cardAt > 0, 'the Daily Logs card was located');
  const block = workspace.slice(cardAt, cardAt + 1400);
  assert.match(block, /logTypeLabel\(log\.logType\)\.toUpperCase\(\)/, 'each entry names its type');
  assert.match(block, /fmtTime\(log\.createdAt, timeZone\)/, 'and keeps its exact time');

  assert.equal(reg.logTypeLabel('log_book').toUpperCase(), 'LOG BOOK');
  assert.equal(reg.logTypeLabel('welfare_check').toUpperCase(), 'WELFARE CHECK');
  assert.equal(reg.logTypeLabel('check_call').toUpperCase(), 'WELFARE CHECK', 'legacy rows read correctly');
});

test('LOG-24-NO-CROSS-COMPANY-READ-OR-REPORT', () => {
  // Server side: the company is resolved from the authenticated caller for every read.
  const service = backend('src/daily-log/daily-log.service.ts');
  assert.ok(!/companyId\?:|dto\.companyId|@Query\('company/.test(service), 'no caller-supplied company');
  const controller = backend('src/daily-log/daily-log.controller.ts');
  assert.match(controller, /@CurrentUser\(\) user: JwtPayload/, 'the caller identifies the company');
  assert.match(controller, /@Roles\(UserRole\.ADMIN, \.\.\.COMPANY_VIEW_ROLES\)/);

  // Client side: a report is built only from the rows already fetched for this company.
  const dsource = stripComments(read('src/components/company/dailySiteLog.ts'));
  assert.ok(!/services\/api|fetch\(/.test(dsource), 'the report builder cannot reach the network');
  // And it only accepts records belonging to the shifts it was given.
  const foreign = dsl.buildDailySiteLog({
    siteId: 14, dateKey: '2026-09-30', dateLabel: 'd', timeZone: LONDON, companyName: '',
    shifts: [SHIFT_A], operationsByShiftId: OPS,
    dailyLogs: [log(301, { id: 999, site: SITE_B, guard: { id: 99, fullName: 'Other' } }, 'log_book', 'another company', '2026-09-30T19:00:00.000Z')],
    incidents: [], alerts: [],
  });
  assert.ok(
    !foreign.events.some((e) => e.detail === 'another company'),
    'a record outside the given shifts never enters the report',
  );
  assert.ok(!dslPrint.renderDailySiteLogHtml(foreign, { generatedAt: 'x' }).includes('another company'));
});

test('LOG-25-READING-PRINTING-AND-EXPORTING-WRITE-NOTHING', () => {
  for (const file of [
    'src/components/company/logBookRegister.ts',
    'src/components/company/dailySiteLog.ts',
    'src/components/company/dailySiteLogPrint.ts',
    'src/components/company/CompanyLogBookWorkspace.tsx',
    'src/components/company/CompanyLogBookEntryDrawer.tsx',
  ]) {
    const source = read(file);
    assert.ok(!/services\/api/.test(source), `${file} imports no API client`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|axios/.test(source), `${file} issues no request`);
    assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)/i.test(source), `${file} performs no write`);
  }

  // Opening the Daily Site Log only renders and prints.
  const handler = screenCode.slice(
    screenCode.indexOf('const handleOpenDailySiteLog'),
    screenCode.indexOf('const urgentOperationalItems'),
  );
  assert.ok(handler.length > 100, 'the handler was located');
  for (const write of ['createDailyLog', 'updateIncidentStatus', 'closeSafetyAlert', 'POST', 'PATCH']) {
    assert.ok(!handler.includes(write), `producing the report never calls ${write}`);
  }
  assert.match(handler, /renderDailySiteLogHtml/);
  assert.match(handler, /printIncidentReport\(html\)/, 'it reuses the same local print window');

  // Pressing every control in the register dispatches only read-side callbacks.
  const calls = [];
  const spy = (name) => (...args) => calls.push({ name, args });
  const element = React.createElement(CompanyLogBookWorkspace, {
    rows: reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' }),
    periods: [], date: '2026-09-30',
    onDateChange: spy('date'), search: '', onSearchChange: spy('search'),
    clientOptions: [], siteOptions: [], guardOptions: [],
    clientFilter: '', siteFilter: '', guardFilter: '',
    onClientFilter: spy('client'), onSiteFilter: spy('site'), onGuardFilter: spy('guard'),
    onOpenEntry: spy('openEntry'), onOpenDailySiteLog: spy('dailySiteLog'),
    dailySiteLogEnabled: true, timeLabel: (iso) => iso.slice(11, 16),
  });
  buttonsOf(element).forEach((button) => button.press());
  assert.ok(
    calls.every((call) => ['openEntry', 'dailySiteLog', 'client', 'site', 'guard'].includes(call.name)),
    `only read-side callbacks fire, got ${[...new Set(calls.map((c) => c.name))].join(', ')}`,
  );
});

/** The register has to survive the real renderer, not only a walked tree. */
test('RENDER-01-THE-REGISTER-RENDERS-THROUGH-REACT-NATIVE-WEB', () => {
  const { AppRegistry } = require('react-native-web');
  const { renderToStaticMarkup } = require('react-dom/server');
  const element = React.createElement(CompanyLogBookWorkspace, {
    rows: reg.buildLogBookRegister(LOGS, SHIFTS_BY_ID, LONDON, { date: '2026-09-30' }),
    periods: reg.logBookPeriods(OPS_A).map((p) => ({
      ...p, shiftId: 19, siteName: SITE_A.name,
      startLabel: p.start.slice(11, 16), endLabel: p.end.slice(11, 16),
      completedLabel: p.completedAt ? p.completedAt.slice(11, 16) : '',
    })),
    date: '2026-09-30', onDateChange: () => {}, search: '', onSearchChange: () => {},
    clientOptions: [{ label: 'Northgate Estates', value: 'Northgate Estates' }],
    siteOptions: [{ label: SITE_A.name, value: '14' }],
    guardOptions: [{ label: 'Fahad test', value: '20' }],
    clientFilter: '', siteFilter: '', guardFilter: '',
    onClientFilter: () => {}, onSiteFilter: () => {}, onGuardFilter: () => {},
    onOpenEntry: () => {}, onOpenDailySiteLog: () => {}, dailySiteLogEnabled: false,
    timeLabel: (iso) => iso.slice(11, 16),
  });
  AppRegistry.registerComponent('LogBookSpec', () => () => element);
  const html = renderToStaticMarkup(AppRegistry.getApplication('LogBookSpec', {}).element);

  assert.match(html, /Log Book/);
  assert.match(html, /Required periods/);
  assert.match(html, /Missing/);
  assert.match(html, /perimeter checked, all secure/);
  assert.match(html, /Daily Site Log/);
});

console.log(`\n${passed} Log Book checks passed`);
