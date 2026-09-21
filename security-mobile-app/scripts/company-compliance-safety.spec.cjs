// Company Compliance workspace — safety (2D3.1) and commercial workspace (2D3.2) tests.
// Uses the repo's existing node-script pattern: pure logic is loaded through the TypeScript compiler that is already a
// dev dependency (no new framework); wiring is asserted against the component source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadTs(file) {
  const out = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require);
  return mod.exports;
}

const sel = loadTs('src/components/company/compliance-selection.ts');
const model = loadTs('src/components/company/compliance-model.ts');
const workspace = read('src/components/company/CompanyComplianceWorkspace.tsx');
const drawerBody = read('src/components/company/ComplianceGuardDrawerBody.tsx');
const dataSourceSrc = read('src/components/company/complianceDataSource.ts');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
const uiSource = `${workspace}\n${drawerBody}`;

let count = 0;
async function test(name, work) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const NOW = new Date(2026, 8, 21, 12, 0); // 21 Sep 2026
const iso = (offsetDays) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let docId = 100;
const doc = (guardId, type, over = {}) => ({
  id: docId++, type, guard: { id: guardId, fullName: `Guard ${guardId}` }, originalFileName: `${type}.pdf`,
  uploadCompletedAt: '2026-08-01T10:00:00Z', expiryDate: iso(400), verified: false, uploadedAt: '2026-08-01T10:00:00Z', ...over,
});
const verifiedDocs = (id, over = {}) => [doc(id, 'sia_licence', { verified: true, verifiedAt: '2026-08-02T09:00:00Z', verifiedByUserId: 7, ...over }), doc(id, 'right_to_work', { verified: true, verifiedAt: '2026-08-02T09:00:00Z', verifiedByUserId: 7 })];
const summary = (id, status, over = {}) => ({
  guardId: id, fullName: `Guard ${id}`, siaLicenceNumber: `12345678901${String(id).padStart(5, '0')}`, siaExpiryDate: iso(400),
  rightToWorkStatus: 'permanent', rightToWorkExpiryDate: null, complianceStatus: status, assignable: status === 'valid' || status === 'expiring',
  blockingReasons: [], expiringReasons: [], missingDocuments: [], documents: verifiedDocs(id), ...over,
});
const link = (id, status = 'ACTIVE') => ({ id: id + 1000, status, guard: { id, fullName: `Guard ${id}` } });

const FIXTURE = [
  summary(1, 'valid'),
  summary(2, 'expiring', { siaExpiryDate: iso(12), expiringReasons: ['SIA licence expires within 30 days'] }),
  summary(3, 'expired', { siaExpiryDate: iso(-5), blockingReasons: ['SIA licence expired'] }),
  summary(4, 'invalid', { siaLicenceNumber: '', blockingReasons: ['Missing SIA licence number'] }),
  summary(5, 'invalid', { documents: [verifiedDocs(5)[0]], missingDocuments: ['Right-to-work document'], blockingReasons: ['Missing Right-to-work document'] }),
  summary(6, 'valid', { fullName: 'Ahmed Khan', siaLicenceNumber: '9876 5432 1098 7654' }),
];

(async () => {
  // ── 2D3.1 regressions (selection / race / evidence safety) ─────────────────
  const legacySelectedSummary = (summaries, selectedGuardId) =>
    summaries.find((item) => String(item.guardId) === selectedGuardId) || summaries[0] || null;

  await test('WRONG-GUARD-SELECTION reproduction: the legacy logic labelled Guard A over Guard B evidence', () => {
    assert.notEqual(String(legacySelectedSummary([{ guardId: 1 }], '2').guardId), '2');
  });

  await test('WRONG-GUARD-SELECTION fixed: the drawer Guard is resolved strictly by id from ALL rows and never falls back', () => {
    const rows = model.buildComplianceRows(FIXTURE);
    for (const id of [null, 1, 2, 3, 6, 99]) {
      const found = model.findRowByGuardId(rows, id);
      if (id !== null && rows.some((row) => row.guardId === id)) assert.equal(found.guardId, id);
      else assert.equal(found, null, 'no silent fallback to another Guard');
    }
    // Every document shown under a Guard belongs to that Guard (documents come from the Guard's own summary).
    for (const row of rows) for (const d of row.summary.documents) assert.ok(sel.documentBelongsToGuard(d, row.guardId));
    assert.equal(sel.documentBelongsToGuard(doc(2, 'sia_licence'), 1), false);
    // Filtering / searching the table can never change which Guard an open drawer shows: it looks in ALL rows.
    assert.match(workspace, /findRowByGuardId\(rows, selectedGuardId\)/);
    assert.doesNotMatch(uiSource, /summaries\[0\]|rows\[0\]|visibleRows\[0\]/, 'no fallback to another Guard');
    assert.doesNotMatch(uiSource, /listGuardDocuments/, 'no per-Guard document fetch: documents come from the summary');
  });

  await test('LOAD-RACE: a late, superseded load can never overwrite newer data', async () => {
    const gate = sel.createRequestGate();
    let state = null;
    const resolvers = {};
    const fetchData = (label) => new Promise((resolve) => { resolvers[label] = () => resolve(label); });
    const load = async (label) => {
      const token = gate.next();
      const value = await fetchData(label);
      if (!gate.isCurrent(token)) return 'dropped';
      state = value;
      return 'applied';
    };
    const slow = load('older');
    const fast = load('newer');
    resolvers.newer();
    assert.equal(await fast, 'applied');
    resolvers.older();
    assert.equal(await slow, 'dropped');
    assert.equal(state, 'newer');
    assert.match(workspace, /loadGate\.current\.isCurrent\(token\)/);
  });

  await test('VERIFY safety kept: confirmation names Guard/type/file; API call only in the confirm handler; action re-checks its Guard', () => {
    const verify = sel.buildVerificationDialog({ guardName: 'Ahmed Khan', document: doc(6, 'sia_licence', { originalFileName: 'sia.pdf' }), verified: true });
    assert.equal(verify.title, 'Verify SIA licence for Ahmed Khan?');
    assert.match(verify.message, /sia\.pdf/);
    assert.match(verify.message, /Confirm that you have reviewed this document and it matches the Guard's record\./);
    assert.equal(sel.buildVerificationDialog({ guardName: 'A', document: doc(1, 'sia_licence', { verified: true }), verified: false }).variant, 'danger');
    assert.match(sel.buildVerificationDialog({ guardName: 'A', document: doc(1, 'sia_licence', { expiryDate: '2020-01-01' }), verified: true, now: NOW }).message, /has expired/);
    assert.match(workspace, /<ConfirmationDialog/);
    assert.equal((workspace.match(/ds\.verifyDocument\(/g) || []).length, 1, 'exactly one verify call');
    const confirm = workspace.slice(workspace.indexOf('const confirmVerification'), workspace.indexOf('const uploadDocument'));
    assert.match(confirm, /ds\.verifyDocument\(pending\.document\.id, pending\.verified\)/);
    assert.match(confirm, /pending\.guardId !== selectedGuardId/);
    assert.match(workspace, /documentBelongsToGuard\(document, activeRow\.guardId\)/);
  });

  await test('VIEW before verify: signed-URL endpoint only, temporary URL, no storage location in the UI', () => {
    assert.match(workspace, /ds\.accessDocument\(document\.id\)/);
    assert.match(dataSourceSrc, /accessGuardDocument\(documentId\)/);
    assert.match(read('src/services/api.ts'), /\/compliance\/documents\/\$\{id\}\/access/);
    assert.doesNotMatch(`${uiSource}\n${dataSourceSrc}`, /fileUrl|storageKey|storageProvider/);
    assert.match(workspace, /window\.open\('', '_blank'\)/);
    assert.match(workspace, /tab\.opener = null/);
    assert.match(workspace, /Linking\.openURL\(url\)/);
  });

  // ── Status, metrics, filters (2D3.2) ────────────────────────────────────────
  await test('UNKNOWN: a Guard with no summary, or an unrecognised status, is Unknown — never Valid', () => {
    const rows = model.buildComplianceRows(
      [...FIXTURE, summary(20, 'something-new')],
      [link(1), link(30), link(31, 'BLOCKED'), link(32, 'INACTIVE')],
    );
    const byId = (id) => rows.find((row) => row.guardId === id);
    assert.equal(byId(20).status, 'unknown', 'unrecognised backend status');
    assert.equal(byId(30).status, 'unknown', 'ACTIVE link without a summary');
    assert.equal(byId(31).status, 'unknown', 'BLOCKED link without a summary');
    assert.equal(byId(30).summary, null);
    assert.equal(byId(32), undefined, 'INACTIVE relationships are outside the compliance population');
    assert.equal(rows.filter((row) => row.guardId === 1).length, 1, 'a Guard with a summary is not duplicated');
    assert.equal(model.normalizeStatus(undefined), 'unknown');
    assert.equal(model.normalizeStatus('VALID'), 'valid');
    assert.equal(model.STATUS_LABELS.unknown, 'Unknown');
  });

  await test('NEEDS ATTENTION = Expired + Invalid; Total = Valid + Expiring + Needs Attention + Unknown', () => {
    const rows = model.buildComplianceRows(FIXTURE, [link(30)]);
    const m = model.computeMetrics(rows);
    assert.deepEqual(m, { total: 7, valid: 2, expiring: 1, needsAttention: 3, unknown: 1 });
    assert.equal(m.needsAttention, rows.filter((r) => r.status === 'expired').length + rows.filter((r) => r.status === 'invalid').length);
    assert.equal(m.total, m.valid + m.expiring + m.needsAttention + m.unknown);
    assert.deepEqual(model.computeMetrics([]), { total: 0, valid: 0, expiring: 0, needsAttention: 0, unknown: 0 });
  });

  await test('CLICKABLE SUMMARY + FILTERS: every metric equals the rows its filter shows (one shared filter state)', () => {
    const rows = model.buildComplianceRows(FIXTURE, [link(30)]);
    const m = model.computeMetrics(rows);
    assert.equal(model.selectVisibleRows(rows, 'all', '').length, m.total);
    assert.equal(model.selectVisibleRows(rows, 'valid', '').length, m.valid);
    assert.equal(model.selectVisibleRows(rows, 'expiring', '').length, m.expiring);
    assert.equal(model.selectVisibleRows(rows, 'attention', '').length, m.needsAttention);
    assert.equal(model.selectVisibleRows(rows, 'unknown', '').length, m.unknown);
    assert.deepEqual(model.selectVisibleRows(rows, 'attention', '').map((r) => r.status).sort(), ['expired', 'invalid', 'invalid']);
    // Wiring: chips and tabs drive the SAME state; no separate Expired / Invalid tabs.
    assert.equal((workspace.match(/useState<ComplianceFilter>/g) || []).length, 1, 'one shared filter state');
    for (const key of ['all', 'valid', 'expiring', 'attention']) {
      assert.ok(workspace.includes(`active={filter === '${key}'}`), `metric chip ${key} reflects the shared filter`);
      assert.ok(workspace.includes(`setFilter('${key}')`), `metric chip ${key} sets the shared filter`);
    }
    assert.match(workspace, /label: 'Needs Attention'/);
    assert.deepEqual([...workspace.matchAll(/\{ key: '(\w+)', label: '([^']+)' \}/g)].map((m2) => m2[2]), ['All', 'Valid', 'Expiring', 'Needs Attention', 'Unknown']);
  });

  await test('SEARCH: guard name and SIA number, case-insensitive, over the loaded rows', () => {
    const rows = model.buildComplianceRows(FIXTURE);
    const ids = (q) => model.selectVisibleRows(rows, 'all', q).map((r) => r.guardId).sort();
    assert.deepEqual(ids('AHMED'), [6]);
    assert.deepEqual(ids('khan'), [6]);
    assert.deepEqual(ids('9876543210987654'), [6], 'SIA number ignoring spaces');
    assert.deepEqual(ids('9876 5432'), [6]);
    assert.deepEqual(ids('nobody'), []);
    assert.equal(ids('').length, rows.length);
    assert.deepEqual(model.selectVisibleRows(rows, 'valid', 'guard 1').map((r) => r.guardId), [1], 'search combines with the filter');
  });

  await test('SORT: attention first (expired, invalid), then expiring, unknown, valid; name within a group', () => {
    const rows = model.buildComplianceRows(FIXTURE, [link(30)]);
    assert.deepEqual(model.sortRows(rows).map((r) => r.status), ['expired', 'invalid', 'invalid', 'expiring', 'unknown', 'valid', 'valid']);
  });

  // ── Table content ─────────────────────────────────────────────────────────
  await test('TABLE columns: Guard, Compliance, SIA, Right to work, Documents, Screening, action — no blocker dump', () => {
    for (const label of ['Guard', 'Compliance', 'SIA', 'Right to work', 'Documents', 'Screening']) assert.match(workspace, new RegExp(`<TableHeaderCell label="${label}"`));
    assert.doesNotMatch(workspace, /blockingReasons/, 'the table never lists blockers — the drawer does');
    assert.match(workspace, /<ScrollView horizontal/, 'narrow screens scroll the table inside its card instead of squeezing columns');
    assert.match(workspace, /Review compliance ›/);
  });

  await test('GUARD column: name plus a masked SIA suffix only', () => {
    assert.equal(model.maskSiaNumber('1234567890123456'), '•••• 3456');
    assert.equal(model.maskSiaNumber(''), null);
    assert.doesNotMatch(workspace, /dateOfBirth|nationality|phone|address/i, 'no unnecessary PII in the workspace');
  });

  await test('SIA indicator: missing / no expiry / expired / expires in N days / today / valid date', () => {
    const at = (over) => model.siaIndicator(summary(1, 'valid', over), NOW);
    assert.equal(at({ siaLicenceNumber: '' }).label, 'Missing');
    assert.equal(at({ siaExpiryDate: null }).label, 'No expiry date');
    assert.deepEqual([at({ siaExpiryDate: iso(-1) }).label, at({ siaExpiryDate: iso(-1) }).tone], ['Expired', 'danger']);
    assert.equal(at({ siaExpiryDate: iso(0) }).label, 'Expires today');
    assert.equal(at({ siaExpiryDate: iso(1) }).label, 'Expires in 1 day');
    assert.equal(at({ siaExpiryDate: iso(12) }).label, 'Expires in 12 days');
    assert.equal(at({ siaExpiryDate: iso(30) }).tone, 'warning');
    assert.equal(at({ siaExpiryDate: iso(31) }).tone, 'neutral');
    assert.equal(model.siaIndicator(null).label, '—');
  });

  await test('RIGHT TO WORK: indefinite is not "expired"/"missing"; missing, time-limited, expired and invalid are distinct', () => {
    const at = (status, expiry = null) => model.rightToWorkIndicator(summary(1, 'valid', { rightToWorkStatus: status, rightToWorkExpiryDate: expiry }), NOW);
    for (const s of ['permanent', 'Settled', 'indefinite', 'british', 'citizen', 'no_expiry']) assert.equal(at(s).label, 'Indefinite', s);
    assert.equal(at('permanent').tone, 'success');
    assert.equal(at('').label, 'Missing');
    assert.equal(at(null).label, 'Missing');
    assert.equal(at('share-code').label, 'No expiry date', 'a time-limited status without an expiry is flagged, not called indefinite');
    assert.equal(at('share-code', iso(-3)).label, 'Expired');
    assert.equal(at('share-code', iso(9)).label, 'Expires in 9 days');
    assert.equal(at('share-code', iso(200)).label, 'Valid');
    assert.equal(at('expired').label, 'Expired');
    for (const s of ['revoked', 'refused', 'suspended', 'invalid']) assert.equal(at(s).label, 'Invalid', s);
    assert.equal(at('permanent', iso(-2)).label, 'Expired', 'a recorded expiry on an indefinite status is still checked, as the backend does');
  });

  await test('DOCUMENTS column: verified / pending / missing / expired from the summary documents — nothing invented', () => {
    const s = (docs) => model.summarizeDocuments(summary(1, 'valid', { documents: docs }), NOW);
    const all = s(verifiedDocs(1));
    assert.deepEqual([all.headline, all.detail, all.tone], ['2/2 verified', undefined, 'success']);
    const pending = s([verifiedDocs(1)[0], doc(1, 'right_to_work')]);
    assert.deepEqual([pending.headline, pending.detail, pending.tone], ['1/2 verified', '1 pending', 'warning']);
    const missing = s([verifiedDocs(1)[0]]);
    assert.deepEqual([missing.headline, missing.detail, missing.tone], ['1/2 verified', '1 missing', 'danger']);
    const incompleteOnly = s([doc(1, 'sia_licence', { uploadCompletedAt: null }), verifiedDocs(1)[1]]);
    assert.equal(incompleteOnly.missing, 1, 'an incomplete upload does not count as evidence (backend rule)');
    const expired = s([verifiedDocs(1, { expiryDate: iso(-4) })[0], verifiedDocs(1)[1]]);
    assert.deepEqual([expired.headline, expired.detail, expired.tone], ['2/2 verified', 'Expired', 'danger']);
    assert.equal(s([]).headline, '0/2 verified');
    assert.equal(model.summarizeDocuments(null), null);
    // The computed missing count agrees with the backend's own missingDocuments list on the fixtures.
    for (const g of FIXTURE) assert.equal(model.summarizeDocuments(g, NOW).missing, g.missingDocuments.length, `Guard ${g.guardId}`);
  });

  await test('SCREENING column: friendly status for every value, no raw enum, one batch request, no admin actions', () => {
    const labels = Object.fromEntries(['VETTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'REQUIRES_ATTENTION', 'NOT_STARTED', 'REJECTED', 'EXPIRED'].map((s) => [s, model.screeningIndicator({ guardId: 1, status: s, vetted: s === 'VETTED' })]));
    assert.deepEqual(Object.values(labels).map((v) => v.label), ['Vetted', 'In progress', 'Submitted for review', 'Under review', 'Requires attention', 'Not started', 'Rejected', 'Expired']);
    for (const { label } of Object.values(labels)) assert.doesNotMatch(label, /_|^[A-Z]{2,}/, `raw enum leaked: ${label}`);
    assert.equal(model.screeningIndicator({ guardId: 1, status: 'WEIRD', vetted: false }).label, 'Unknown');
    assert.equal(model.screeningIndicator(undefined).label, '—');
    assert.equal(model.screeningIndicator({ guardId: 1, status: 'VETTED', vetted: true }).tone, 'success');
    assert.equal(model.screeningIndicator({ guardId: 1, status: 'REQUIRES_ATTENTION', vetted: false }).tone, 'warning');
    // No N+1: the workspace loads screening once, through the batch endpoint.
    assert.equal((workspace.match(/ds\.listScreeningOutcomes\(\)/g) || []).length, 1);
    assert.match(dataSourceSrc, /listScreeningOutcomes: \(\) => listCompanyScreeningOutcomes\(\)/);
    assert.match(read('src/services/api.ts'), /\/screening\/company\/outcomes/);
    assert.doesNotMatch(`${uiSource}\n${dataSourceSrc}`, /\/outcome\b|companyOutcome\(|getScreening|listScreenings|startScreeningReview|verifyScreeningCheck|reviewScreeningReference|requestScreeningReference|requestScreeningInformation|completeScreeningReview|rejectScreening|expireScreening/, 'Company gets status only — no Admin review actions');
    assert.match(drawerBody, /Screening is reviewed by S4 platform administrators\. You can see the status only\./);
  });

  await test('NO PER-ROW REQUESTS: the workspace makes one call each per load; nothing is fetched inside a row loop', () => {
    const loadBlock = workspace.slice(workspace.indexOf('const load = React.useCallback'), workspace.indexOf('React.useEffect(() => {\n    if (!canViewCompliance)') > 0 ? workspace.indexOf('if (!canViewCompliance) return;') : undefined);
    for (const call of ['ds.listStatuses()', 'ds.listGuards()', 'ds.listRecords()', 'ds.listScreeningOutcomes()']) assert.equal((workspace.match(new RegExp(call.replace(/[().]/g, '\\$&'), 'g')) || []).length, 1, call);
    assert.ok(loadBlock.includes('Promise.allSettled'));
    const rowBlock = workspace.slice(workspace.indexOf('visibleRows.map((row) =>'), workspace.indexOf('</ScrollView>'));
    assert.doesNotMatch(rowBlock, /\bds\.|await |fetch\(/, 'no network in the row renderer');
  });

  // ── Drawer: blockers ──────────────────────────────────────────────────────
  await test('ALL BLOCKERS: every blocking and expiring reason is listed — an Invalid blocker never hides an expiring item', () => {
    const s = summary(9, 'invalid', {
      blockingReasons: ['Missing sia licence expiry date', 'SIA licence document is not verified', 'Missing Right-to-work document'],
      expiringReasons: ['Right-to-work clearance expires within 30 days', 'SIA compliance record expiring soon'],
    });
    const blockers = model.buildBlockers(s, true);
    assert.equal(blockers.length, 5);
    assert.deepEqual(blockers.map((b) => b.severity), ['blocking', 'blocking', 'blocking', 'expiring', 'expiring']);
    assert.equal(blockers[0].text, 'Missing SIA licence expiry date');
    assert.deepEqual(model.buildBlockers(summary(1, 'valid'), true), []);
    assert.deepEqual(model.buildBlockers(null, true), []);
    assert.match(drawerBody, /buildBlockers\(summary, canManage\)/);
    assert.match(drawerBody, /blockers\.map\(\(blocker\)/);
    assert.doesNotMatch(drawerBody, /blockingReasons\[0\]|expiringReasons\[0\]|blockers\[0\]/, 'never only the first reason');
  });

  await test('BLOCKER NEXT STEPS: practical, role-aware, and only for actions that exist', () => {
    const step = (reason, sev = 'blocking', manage = true) => model.describeReason(reason, sev, manage);
    assert.match(step('Missing SIA licence number').nextStep, /Ask the Guard to add their SIA licence number/);
    assert.match(step('SIA licence expired').nextStep, /Ask the Guard to update their SIA details/);
    assert.match(step('Missing right-to-work status').nextStep, /Ask the Guard/);
    assert.equal(step('Missing SIA licence number').action, null, 'Company has no way to edit the Guard profile, so no button');
    const missingDoc = step('Missing Right-to-work document');
    assert.deepEqual(missingDoc.action, { kind: 'add_document', documentType: 'right_to_work' });
    assert.match(missingDoc.nextStep, /Add the right-to-work document/);
    assert.deepEqual(step('Missing SIA licence document').action, { kind: 'add_document', documentType: 'sia_licence' });
    const unverified = step('SIA licence document is not verified');
    assert.match(unverified.nextStep, /Review the uploaded evidence, then verify it/);
    assert.equal(unverified.action, null);
    assert.deepEqual(step('SIA licence document expired').action, { kind: 'add_document', documentType: 'sia_licence' });
    assert.deepEqual(step('Right-to-work compliance record expired').action, { kind: 'update_record', recordType: 'RIGHT_TO_WORK' });
    assert.deepEqual(step('SIA compliance record expiring soon', 'expiring').action, { kind: 'update_record', recordType: 'SIA' });
    // View-only users are told who can act and get no action button.
    for (const reason of ['Missing SIA licence document', 'SIA licence document is not verified', 'SIA compliance record expired']) {
      const v = step(reason, 'blocking', false);
      assert.equal(v.action, null);
      assert.match(v.nextStep, /A compliance manager needs to/);
    }
    // Nothing fabricated for a reason we do not recognise.
    assert.deepEqual(step('Guard compliance invalid: something new'), { nextStep: null, action: null });
    assert.match(drawerBody, /Next step: \{blocker\.nextStep\}/);
    assert.equal(model.prettyReason('Missing sia licence expiry date'), 'Missing SIA licence expiry date');
  });

  await test('DRAWER sections: compliance, SIA, right to work, screening, blockers, documents, records — compact, from the loaded summary', () => {
    for (const title of ['Compliance', 'SIA licence', 'Right to work', 'Screening', 'Documents', 'Compliance records']) assert.match(drawerBody, new RegExp(`<Section title="${title}"`));
    assert.match(drawerBody, /title=\{`Blockers/);
    assert.match(workspace, /<Drawer/);
    assert.match(workspace, /compact/);
    assert.match(workspace, /onPress=\{\(\) => setSelectedGuardId\(row\.guardId\)\}/, 'row click opens the drawer');
    assert.match(drawerBody, /Licence and document compliance only\. It does not cover your relationship with this Guard, availability or shift clashes\./);
  });

  // ── Documents ─────────────────────────────────────────────────────────────
  await test('DOCUMENT ROW states: Verified / Pending / Upload incomplete / Expired, plus verified by/at', () => {
    const p = (d, manage = true) => sel.getDocumentPresentation(d, manage, NOW);
    assert.equal(p(doc(1, 'sia_licence')).statusLabel, 'Pending');
    assert.equal(p(doc(1, 'sia_licence', { verified: true })).statusLabel, 'Verified');
    const incomplete = p(doc(1, 'sia_licence', { uploadCompletedAt: null }));
    assert.deepEqual([incomplete.statusLabel, incomplete.canView, incomplete.canToggleVerification], ['Upload incomplete', false, false]);
    assert.equal(p(doc(1, 'sia_licence', { expiryDate: iso(-1) })).expired, true);
    assert.equal(p(doc(1, 'sia_licence', { expiryDate: iso(0) })).expired, false);
    assert.equal(model.describeVerification(doc(1, 'x', { verified: true, verifiedAt: '2026-08-02T09:00:00Z', verifiedByUserId: 7 }), 7), 'Verified 2 Aug 2026 by you');
    assert.equal(model.describeVerification(doc(1, 'x', { verified: true, verifiedAt: '2026-08-02T09:00:00Z', verifiedByUserId: 9 }), 7), 'Verified 2 Aug 2026 by user #9');
    assert.equal(model.describeVerification(doc(1, 'x', { verified: false })), null);
    assert.match(drawerBody, /describeVerification\(document, currentUserId\)/);
    assert.match(drawerBody, /Uploaded \{formatDate\(document\.uploadedAt\)\} · Expiry \{formatDate\(document\.expiryDate\)\}/);
  });

  await test('MISSING DOCUMENT: shows Missing with Add document for managers and never a Verify action', () => {
    assert.match(drawerBody, /label="Missing" tone="danger"/);
    const missingBlock = drawerBody.slice(drawerBody.indexOf('missingTypes.map'), drawerBody.indexOf('documents.map((document)'));
    assert.match(missingBlock, /canManage \? \(/);
    assert.match(missingBlock, /Add document/);
    assert.doesNotMatch(missingBlock, /Verify/);
    assert.match(drawerBody, /Required evidence has not been uploaded\./);
  });

  await test('UPLOAD: existing upload API only (create → signed PUT → complete → refresh → Pending); client checks mirror the backend', () => {
    assert.match(dataSourceSrc, /uploadGuardDocument\(\{/);
    assert.match(dataSourceSrc, /fetch\(created\.upload\.url, \{\s*method: created\.upload\.method,\s*headers: created\.upload\.headers,\s*body: blob/);
    assert.match(dataSourceSrc, /completeGuardDocumentUpload\(created\.id\)/);
    assert.match(dataSourceSrc, /DocumentPicker\.getDocumentAsync/);
    assert.match(workspace, /await load\('refresh'\);\s*showNotice\(\{ tone: 'success', message: 'Document uploaded\. It is Pending until it has been verified\.' \}\)/);
    assert.equal(model.validateUpload({ name: 'a.pdf', mimeType: 'application/pdf', size: 1000, expiryDate: '' }), null);
    assert.match(model.validateUpload({ name: null }), /Choose a document/);
    assert.match(model.validateUpload({ name: 'a.exe', mimeType: 'application/x-msdownload', size: 10 }), /PDF, JPEG\/JPG or PNG/);
    assert.match(model.validateUpload({ name: 'a.pdf', mimeType: 'application/pdf', size: 11 * 1024 * 1024 }), /10 MB/);
    assert.match(model.validateUpload({ name: 'a.pdf', mimeType: 'application/pdf', size: 5, expiryDate: '31/12/2030' }), /YYYY-MM-DD/);
    assert.equal(model.validateUpload({ name: 'a.jpg', mimeType: '', size: 5, expiryDate: '2030-12-31' }), null, 'mime falls back to the extension');
    assert.match(drawerBody, /<Section title="Documents">[\s\S]*canManage && uploadOpen/);
  });

  await test('COMPLIANCE RECORD form: behind Add/Update record in the drawer, explains what a record is, keeps saving', () => {
    assert.doesNotMatch(workspace, /Add \/ Update Compliance Record/, 'no permanent form on the page');
    assert.match(drawerBody, /canManage && summary \? \(\s*<Section title="Compliance records">/);
    assert.match(drawerBody, /It is separate from the\s+Guard's own SIA and right-to-work details and does not change them\./);
    assert.match(drawerBody, /editingExisting \? 'Update record' : 'Add record'/);
    assert.match(workspace, /ds\.saveRecord\(\{ \.\.\.payload, guardId \}\)/);
    assert.match(drawerBody, /Compliance not yet recorded\./);
    assert.deepEqual(model.recordsForGuard([{ guard: { id: 1 } }, { guard: { id: 2 } }], 2), [{ guard: { id: 2 } }]);
  });

  // ── Permissions ───────────────────────────────────────────────────────────
  await test('PERMISSIONS: frontend gating equals the canonical backend role matrix for all seven roles', () => {
    const src = fs.readFileSync(path.join(root, '..', 'security-backend-nest', 'src', 'company-membership', 'company-membership-types.ts'), 'utf8');
    const enumBody = /export enum CompanyPermission \{([\s\S]*?)\n\}/.exec(src)[1];
    const perm = Object.fromEntries([...enumBody.matchAll(/(\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const sets = {};
    for (const m of src.matchAll(/const (\w+)_PERMISSIONS: Set<CompanyPermission> = new Set\(\[([\s\S]*?)\]\);/g)) {
      sets[m[1]] = [...m[2].replace(/\/\/.*$/gm, '').matchAll(/CompanyPermission\.(\w+)/g)].map((x) => perm[x[1]]);
    }
    sets.OWNER = Object.values(perm);
    const expected = {
      OWNER: [true, true, true], ADMIN: [true, true, true], HR_COMPLIANCE: [true, true, true],
      OPERATIONS: [true, false, true], CONTROL_ROOM: [true, false, false], FINANCE: [false, false, false], VIEWER: [true, false, false],
    };
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(sets).sort());
    for (const [role, [view, manage, screening]] of Object.entries(expected)) {
      const result = model.resolveCompliancePermissions(sets[role], 'company_staff');
      assert.deepEqual([result.canView, result.canManage, result.canViewScreening], [view, manage, screening], role);
    }
    // Legacy fallback only when the session carries no permission list.
    assert.deepEqual(model.resolveCompliancePermissions(undefined, 'company'), { canView: true, canManage: true, canViewScreening: true });
    assert.deepEqual(model.resolveCompliancePermissions(undefined, 'company_admin'), { canView: true, canManage: true, canViewScreening: true });
    assert.deepEqual(model.resolveCompliancePermissions(undefined, 'company_staff'), { canView: false, canManage: false, canViewScreening: false });
    assert.equal(model.resolveCompliancePermissions([], 'company').canView, false, 'an explicit empty list is honoured');
  });

  await test('HR_COMPLIANCE end-to-end and VIEW-ONLY roles: managers get every write action; view-only roles get status and metadata only', () => {
    const hr = model.resolveCompliancePermissions(['compliance.view', 'compliance.manage', 'screening.view'], 'company_staff');
    assert.equal(hr.canManage, true, 'company_staff + HR_COMPLIANCE can view, upload, verify and save records');
    assert.doesNotMatch(`${uiSource}\n${model.resolveCompliancePermissions}`, /hr_compliance|HR_COMPLIANCE|'company_staff'/, 'no role is hard-coded in the UI');
    for (const [label, pattern] of [
      ['View document', /view\.canView \?/], ['Verify / Mark unverified', /view\.canToggleVerification \?/],
      ['Add document (missing)', /canManage \? \(\s*<View style=\{styles\.actions\}>\s*<Button label="Add document"/],
      ['Add document (footer)', /canManage && !uploadOpen/], ['Add/Update record', /canManage && summary \? \(/],
    ]) assert.match(drawerBody, pattern, label);
    const viewer = sel.getDocumentPresentation(doc(1, 'sia_licence'), false, NOW);
    assert.deepEqual([viewer.canView, viewer.canToggleVerification, viewer.evidenceRestricted, viewer.statusLabel], [false, false, true, 'Pending']);
    assert.match(drawerBody, /Evidence file access is restricted to compliance managers\./);
    assert.match(workspace, /canManageCompliance \? ds\.listRecords\(\) : Promise\.resolve\(null\)/, 'view-only users do not even request compliance records');
    assert.match(workspace, /canViewScreening \? ds\.listScreeningOutcomes\(\) : Promise\.resolve\(null\)/);
    assert.match(drawerBody, /Screening status is not available for your role\./);
  });

  await test('FINANCE NAVIGATION: Compliance is hidden without compliance.view; the section, dashboard tile and loader honour it too', () => {
    assert.match(dashboard, /resolveCompliancePermissions\(user\?\.companyPermissions, user\?\.role\)/);
    assert.match(dashboard, /itemIds: group\.itemIds\.filter\(\(id\) => id !== 'compliance' \|\| canViewCompliance\)/);
    assert.equal((dashboard.match(/groups=\{navGroups\}/g) || []).length, 2, 'both sidebars use the permission-filtered groups');
    assert.doesNotMatch(dashboard, /groups=\{COMPANY_NAV_GROUPS\}/);
    assert.match(dashboard, /canViewCompliance=\{compliancePermissions\.canView\}/);
    assert.match(dashboard, /canManageCompliance=\{compliancePermissions\.canManage\}/);
    assert.match(dashboard, /canViewScreening=\{compliancePermissions\.canViewScreening\}/);
    assert.match(dashboard, /loader\.label !== 'compliance' \|\| canViewCompliance/, 'no compliance request (and no 403 banner) for roles without compliance.view');
    assert.match(dashboard, /Compliance not available/);
    assert.match(workspace, /if \(!canViewCompliance\) return;\s*load\('initial'\)/, 'the workspace loads nothing without compliance.view');
    assert.match(workspace, /Compliance is not available for your role/);
  });

  // ── States and copy ───────────────────────────────────────────────────────
  await test('EMPTY / LOADING / ERROR / RETRY copy and behaviour', () => {
    assert.match(workspace, /No guards to review\.\\nLink Guards from the Guards workspace first\./);
    assert.match(workspace, /No guards match your search or filter\./);
    assert.match(workspace, /Clear search and filter/);
    assert.match(workspace, /Loading compliance…/);
    assert.match(workspace, /Compliance could not be loaded/);
    assert.match(workspace, /label="Retry" onPress=\{\(\) => load\('initial'\)\}/);
    assert.match(workspace, /label="Refresh"/);
    assert.match(drawerBody, /No documents uploaded yet\./);
    assert.match(drawerBody, /Compliance not yet recorded\./);
  });

  await test('FEEDBACK is dismissible, success auto-clears, and every load clears stale messages', () => {
    assert.match(workspace, /accessibilityLabel="Dismiss message"/);
    assert.match(workspace, /if \(next\?\.tone === 'success'\) noticeTimer\.current = setTimeout\(\(\) => setNotice\(null\), 6000\)/);
    const loadBlock = workspace.slice(workspace.indexOf('const load = React.useCallback'), workspace.indexOf('const rows = '));
    assert.match(loadBlock, /showNotice\(null\);/);
    assert.match(workspace, /Some information could not be loaded/);
  });

  await test('TERMINOLOGY: compliance-only wording — never "Eligible" or "Ready to work" — and no BS7858/DBS claims', () => {
    assert.doesNotMatch(uiSource, /eligible|ready to work/i);
    assert.doesNotMatch(`${uiSource}\n${read('src/components/company/compliance-model.ts').replace(/\/\/.*$/gm, '')}`, /bs ?7858|\bdbs\b|criminal|fully compliant/i);
    assert.deepEqual(Object.values(model.STATUS_LABELS), ['Valid', 'Expiring', 'Expired', 'Invalid', 'Unknown']);
  });

  await test('Guard upload API surface for the later Guard UI is company-scoped', () => {
    assert.match(read('src/services/api.ts'), /listMyDocumentUploadCompanies/);
    assert.match(read('src/types/models.ts'), /GuardDocumentUploadCompany/);
    assert.match(read('src/types/models.ts'), /companyId\?: number;/);
    assert.match(read('src/types/models.ts'), /CompanyScreeningOutcome/);
  });

  console.log(JSON.stringify({ event: 'company_compliance_safety_tests_passed', tests: count }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
