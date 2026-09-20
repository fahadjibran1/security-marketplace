// 2D3.1 — Company Compliance safety hardening (selection binding, fetch race, evidence access UI, verification).
// Uses the repo's existing node-script test pattern: pure logic is loaded through the TypeScript compiler that is
// already a dev dependency (no new framework); wiring is asserted against the component source.
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

const lib = loadTs('src/components/company/compliance-selection.ts');
const workspace = read('src/components/company/CompanyComplianceWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');

let count = 0;
async function test(name, work) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

const A = { guardId: 1, fullName: 'Guard A' };
const B = { guardId: 2, fullName: 'Guard B' };
const C = { guardId: 3, fullName: 'Guard C' };

// The pre-2D3.1 logic, reproduced verbatim, to prove the bug the audit found.
const legacySelectedSummary = (summaries, selectedGuardId) =>
  summaries.find((item) => String(item.guardId) === selectedGuardId) || summaries[0] || null;

const doc = (over = {}) => ({
  id: 1, type: 'sia_licence', guard: { id: 1, fullName: 'Guard A' }, originalFileName: 'sia.pdf',
  uploadCompletedAt: '2026-01-01T00:00:00Z', expiryDate: '2099-01-01', verified: false, ...over,
});

(async () => {
  await test('WRONG-GUARD-SELECTION reproduction: legacy logic showed Guard A over Guard B evidence', () => {
    // Manager selected Guard B (documents fetched for B), then filtered to "expired" where only A remains.
    const filtered = [A];
    const selectedGuardId = '2';
    assert.equal(legacySelectedSummary(filtered, selectedGuardId).guardId, 1, 'legacy panel labelled Guard A…');
    assert.notEqual(String(legacySelectedSummary(filtered, selectedGuardId).guardId), selectedGuardId, '…while documents/actions still targeted Guard B');
  });

  await test('WRONG-GUARD-SELECTION fixed: displayed Guard === document Guard for every selection/filter combination', () => {
    const lists = [[], [A], [B], [A, B], [B, C], [A, B, C]];
    for (const summaries of lists) {
      for (const requested of ['', '1', '2', '3', '99']) {
        const active = lib.resolveActiveGuardId(summaries, requested);
        const summary = lib.findActiveSummary(summaries, active);
        if (!summaries.length) {
          assert.equal(active, '');
          assert.equal(summary, null);
          continue;
        }
        assert.ok(summary, 'a visible Guard is always selected when any are visible');
        assert.equal(String(summary.guardId), active, 'panel Guard identity equals the document-query Guard id');
        assert.ok(summaries.some((item) => item.guardId === summary.guardId), 'active Guard is visible under the current filter');
        if (summaries.some((item) => String(item.guardId) === requested)) assert.equal(active, requested, 'a still-visible selection is kept');
      }
    }
  });

  await test('selection invariant: filtering the selected Guard out selects a visible Guard; nothing visible clears the panel', () => {
    assert.equal(lib.resolveActiveGuardId([A], '2'), '1');
    assert.equal(lib.resolveActiveGuardId([], '2'), '');
    assert.equal(lib.findActiveSummary([A], '2'), null, 'strict lookup — no silent fallback to another Guard');
  });

  await test('documents are only shown for the Guard they were fetched for', () => {
    const stateForB = { guardId: 2, items: [doc({ id: 9, guard: { id: 2 } })] };
    assert.equal(lib.documentsForGuard(stateForB, '1').length, 0, 'B documents never render under A');
    assert.equal(lib.documentsForGuard(stateForB, '2').length, 1);
    assert.equal(lib.documentsForGuard({ guardId: null, items: [doc()] }, '1').length, 0);
    assert.equal(lib.documentsForGuard(stateForB, '').length, 0);
  });

  await test('DOCUMENT-RACE: a late response for Guard A cannot overwrite Guard B', async () => {
    // Same load pattern as the workspace: take a token, fetch, apply only if still current.
    const gate = lib.createRequestGate();
    let state = { guardId: null, items: [] };
    const resolvers = {};
    const fetchDocs = (guardId) => new Promise((resolve) => { resolvers[guardId] = () => resolve([doc({ id: guardId * 10, guard: { id: guardId } })]); });
    const load = async (guardId) => {
      const token = gate.next();
      const items = await fetchDocs(guardId);
      if (!gate.isCurrent(token)) return 'dropped';
      state = { guardId, items };
      return 'applied';
    };
    const first = load(1); // Guard A selected
    const second = load(2); // …then Guard B selected quickly
    resolvers[2]();
    assert.equal(await second, 'applied');
    resolvers[1](); // A's response arrives LATE
    assert.equal(await first, 'dropped');
    assert.equal(state.guardId, 2);
    assert.equal(state.items[0].guard.id, 2);
    gate.invalidate();
    assert.equal(gate.isCurrent(gate.next() - 1), false);
  });

  await test('documents fetch is bound to the active Guard, with a stale-response gate, and never re-fetched by loadData', () => {
    assert.match(workspace, /createRequestGate\(\)/);
    assert.match(workspace, /documentGate\.current\.isCurrent\(token\)/);
    assert.match(workspace, /loadDocuments\(activeGuardId\)/);
    assert.doesNotMatch(workspace, /listGuardDocuments\(Number\(selectedGuardId\)\)/, 'documents must not be fetched from the raw selection');
    assert.doesNotMatch(workspace, /summaries\[0\]/, 'no fallback to another Guard summary');
    assert.match(workspace, /documentsForGuard\(documentsState, activeGuardId\)/);
    assert.match(workspace, /resolveActiveGuardId\(summaries, selectedGuardId\)/);
    const loadData = /const loadData = React\.useCallback\(async \(\) => \{[\s\S]*?\}, \[statusFilter\]\);/.exec(workspace);
    assert.ok(loadData, 'loadData depends only on the status filter, so a Guard click does not reload every summary');
    assert.doesNotMatch(loadData[0], /listGuardDocuments/, 'loadData refreshes summaries only');
  });

  await test('VERIFY-INCOMPLETE-BLOCKED (presentation): incomplete upload has no View/Verify and says so', () => {
    const incomplete = doc({ uploadCompletedAt: null });
    const manager = lib.getDocumentPresentation(incomplete, true);
    assert.equal(manager.statusLabel, 'Upload incomplete');
    assert.equal(manager.canView, false);
    assert.equal(manager.canToggleVerification, false);
    assert.equal(manager.uploadComplete, false);
    assert.match(workspace, /The upload was not completed, so this evidence cannot be viewed or verified\./);
  });

  await test('ACCESS gating: manager sees View + Verify; view-only sees status but no evidence actions', () => {
    const complete = doc();
    const manager = lib.getDocumentPresentation(complete, true);
    assert.equal(manager.canView, true);
    assert.equal(manager.canToggleVerification, true);
    assert.equal(manager.statusLabel, 'Pending');
    assert.equal(lib.getDocumentPresentation(doc({ verified: true }), true).statusLabel, 'Verified');
    const viewer = lib.getDocumentPresentation(complete, false);
    assert.equal(viewer.canView, false);
    assert.equal(viewer.canToggleVerification, false);
    assert.equal(viewer.evidenceRestricted, true);
    assert.equal(viewer.statusLabel, 'Pending', 'status stays visible to view-only users');
    assert.equal(viewer.expired, false);
  });

  await test('VERIFY-EXPIRED-PRESENTATION: past expiry is flagged Expired; today and future are not', () => {
    const now = new Date(2026, 8, 21, 15, 30);
    assert.equal(lib.isDocumentExpired('2026-09-20', now), true);
    assert.equal(lib.isDocumentExpired('2026-09-21', now), false, 'expires today is not yet expired (backend: daysUntil < 0)');
    assert.equal(lib.isDocumentExpired('2026-09-22', now), false);
    assert.equal(lib.isDocumentExpired(null, now), false);
    assert.equal(lib.isDocumentExpired('not-a-date', now), false);
    assert.equal(lib.getDocumentPresentation(doc({ expiryDate: '2020-01-01' }), false, now).expired, true, 'view-only users also see Expired');
    assert.match(workspace, /view\.expired \?/);
    assert.match(workspace, /<Text style=\{styles\.statusText\}>Expired<\/Text>/);
  });

  await test('VERIFY confirmation names the Guard, the document type and the file', () => {
    const verify = lib.buildVerificationDialog({ guardName: 'Ahmed Khan', document: doc(), verified: true });
    assert.equal(verify.title, 'Verify SIA licence for Ahmed Khan?');
    assert.match(verify.message, /sia\.pdf/);
    assert.match(verify.message, /Confirm that you have reviewed this document and it matches the Guard's record\./);
    assert.equal(verify.confirmLabel, 'Verify');
    const unverify = lib.buildVerificationDialog({ guardName: 'Ahmed Khan', document: doc({ verified: true }), verified: false });
    assert.equal(unverify.title, 'Mark SIA licence for Ahmed Khan as unverified?');
    assert.equal(unverify.variant, 'danger');
    const expired = lib.buildVerificationDialog({ guardName: 'Ahmed Khan', document: doc({ expiryDate: '2020-01-01' }), verified: true, now: new Date(2026, 8, 21) });
    assert.match(expired.message, /has expired/);
    assert.equal(lib.documentTypeLabel('right_to_work'), 'Right to work');
  });

  await test('Verify is never one click: the button opens ConfirmationDialog; the API call lives only in the confirm handler', () => {
    assert.match(workspace, /from '\.\.\/ui\/ConfirmationDialog'/);
    assert.match(workspace, /<ConfirmationDialog/);
    assert.equal((workspace.match(/verifyGuardDocument\(/g) || []).length, 1, 'exactly one verify call');
    const confirm = workspace.slice(workspace.indexOf('const confirmVerification'), workspace.indexOf('const verificationDialog'));
    assert.match(confirm, /verifyGuardDocument\(pending\.document\.id, pending\.verified\)/);
    assert.match(confirm, /String\(pending\.guardId\) !== activeGuardId/, 'action re-checks the Guard it was opened for');
    assert.match(workspace, /onVerify\(document, !document\.verified\)/);
    assert.match(workspace, /documentBelongsToGuard\(document, selectedSummary\.guardId\)/, 'document must belong to the displayed Guard');
  });

  await test('VIEW before verify: uses the signed-URL endpoint, opens a temporary URL, never a raw storage URL', () => {
    assert.match(workspace, /accessGuardDocument\(document\.id\)/);
    assert.match(workspace, /View document/);
    assert.doesNotMatch(workspace, /fileUrl|storageKey|storageProvider/, 'no permanent storage location in the UI');
    assert.match(workspace, /window\.open\('', '_blank'\)/);
    assert.match(workspace, /tab\.opener = null/);
    assert.match(workspace, /Linking\.openURL\(url\)/);
    assert.match(read('src/services/api.ts'), /\/compliance\/documents\/\$\{id\}\/access/);
  });

  await test('FRONTEND permission gating: dashboard passes compliance.manage; workspace fails closed and gates every write action', () => {
    assert.match(dashboard, /canManageCompliance=\{[\s\S]*?includes\('compliance\.manage'\)/);
    assert.match(workspace, /canManageCompliance = false/, 'default is fail-closed');
    assert.match(workspace, /\{canManageCompliance \? \(\s*<View style=\{styles\.panel\}>\s*<Text style=\{styles\.panelTitle\}>Add \/ Update Compliance Record/);
    assert.match(read('src/components/company/compliance-selection.ts'), /canView: canManageCompliance && uploadComplete/);
    assert.match(read('src/components/company/compliance-selection.ts'), /canToggleVerification: canManageCompliance && uploadComplete/);
    assert.match(workspace, /Evidence files are restricted to compliance managers\./);
  });

  await test('Guard upload API surface exists for the later UI (company-scoped)', () => {
    assert.match(read('src/services/api.ts'), /listMyDocumentUploadCompanies/);
    assert.match(read('src/types/models.ts'), /GuardDocumentUploadCompany/);
    assert.match(read('src/types/models.ts'), /companyId\?: number;/);
  });

  console.log(JSON.stringify({ event: 'company_compliance_safety_tests_passed', tests: count }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
