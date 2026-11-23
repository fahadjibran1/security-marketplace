// S4-CV-01: Company Verification interface (Platform Admin page + company portal banner).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const moduleState = { exports: {} };
  vm.runInNewContext(output, { exports: moduleState.exports, module: moduleState, require });
  return moduleState.exports;
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// The module runs in a vm context: compare structure, not realm (Array.prototype differs).
const deq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
let tests = 0;
const test = (name, fn) => { fn(); tests += 1; console.log(`PASS ${name}`); };

const V = loadModule('src/navigation/company-verification.ts');
const { ADMIN_NAV_ITEMS } = loadModule('src/navigation/admin-portal.ts');

test('CV-NAV: the admin portal has a dedicated Company verification page', () => {
  const item = ADMIN_NAV_ITEMS.find((entry) => entry.key === 'verification');
  assert.ok(item, 'verification is navigable');
  assert.equal(item.label, 'Company verification');
  assert.equal(item.group, 'Directory');
});

test('CV-ACTIONS: offered actions are exactly the backend transitions', () => {
  const targets = (s) => V.verificationActionsFor(s).map((a) => `${a.key}>${a.target}`);
  // Mirrors COMPANY_VERIFICATION_TRANSITIONS in security-backend-nest/src/company/company-verification.ts
  // (rejected → pending_verification is the company's own reconsideration request, not an admin button).
  deq(targets('pending_verification'), ['approve>approved', 'reject>rejected']);
  deq(targets('approved'), ['suspend>suspended']);
  deq(targets('suspended'), ['reinstate>approved', 'reject>rejected']);
  deq(targets('rejected'), ['approve>approved']);
  deq(targets('unknown'), []);
  deq(targets(undefined), []);
  const backend = read('../security-backend-nest/src/company/company-verification.ts');
  for (const status of V.COMPANY_VERIFICATION_STATUSES) {
    for (const action of V.verificationActionsFor(status)) {
      const enumName = { approved: 'APPROVED', rejected: 'REJECTED', suspended: 'SUSPENDED', pending_verification: 'PENDING_VERIFICATION' };
      const line = backend.split('\n').find((l) => l.includes(`[CompanyVerificationStatus.${enumName[status]}]: [`));
      assert.ok(line && line.includes(`CompanyVerificationStatus.${enumName[action.target]}`), `${status} → ${action.target} is a backend transition`);
    }
  }
});

test('CV-REASON: reject and suspend require a reason; approve and reinstate do not', () => {
  const by = (s, k) => V.verificationActionsFor(s).find((a) => a.key === k);
  const reject = by('pending_verification', 'reject');
  const suspend = by('approved', 'suspend');
  assert.equal(reject.reasonRequired, true); assert.equal(reject.danger, true);
  assert.equal(suspend.reasonRequired, true); assert.equal(suspend.danger, true);
  assert.match(V.verificationReasonError(reject, ''), /reason for rejecting/);
  assert.match(V.verificationReasonError(reject, '   \n '), /reason for rejecting/, 'whitespace is no reason');
  assert.match(V.verificationReasonError(suspend, ''), /reason for suspending/);
  assert.equal(V.verificationReasonError(suspend, 'Insurance expired'), null);
  assert.match(V.verificationReasonError(suspend, 'x'.repeat(1001)), /under 1000/);
  assert.equal(V.verificationReasonError(by('pending_verification', 'approve'), ''), null);
  assert.equal(V.verificationReasonError(by('suspended', 'reinstate'), ''), null);
});

test('CV-CONFIRM: every decision has a confirmation naming the company and its effect', () => {
  for (const status of V.COMPANY_VERIFICATION_STATUSES) for (const action of V.verificationActionsFor(status)) {
    const c = V.verificationConfirmation(action, 'Acme Security Ltd');
    assert.match(c.title, /\?$/); assert.match(c.message, /Acme Security Ltd/); assert.ok(c.confirmLabel.length > 3);
  }
  const suspend = V.verificationConfirmation(V.verificationActionsFor('approved')[0], 'Acme');
  assert.match(suspend.message, /Safety alerts, incidents and work already in place continue/, 'suspension keeps safety and existing work');
});

test('CV-LIST: counts, state filters and search over name, number, owner email and address', () => {
  const rows = [
    { id: 1, name: 'Alpha Guarding', companyNumber: '111', verificationStatus: 'approved', owner: { id: 1, email: 'a@alpha.test' }, verificationDecidedAt: '2026-11-01T10:00:00Z' },
    { id: 2, name: 'Bravo Security', companyNumber: 'SC222', verificationStatus: 'pending_verification', owner: { id: 2, email: 'owner@bravo.test' }, registeredAt: '2026-11-20T10:00:00Z', address: '1 Leeds Road' },
    { id: 3, name: 'Charlie Ltd', companyNumber: '333', verificationStatus: 'pending_verification', owner: { id: 3, email: 'c@charlie.test' }, registeredAt: '2026-11-10T10:00:00Z' },
    { id: 4, name: 'Delta', companyNumber: '444', verificationStatus: 'suspended', verificationDecidedAt: '2026-11-21T10:00:00Z' },
    { id: 5, name: 'Echo', companyNumber: '555', verificationStatus: 'rejected', verificationDecidedAt: '2026-11-22T10:00:00Z' },
  ];
  deq({ ...V.countByVerificationStatus(rows) }, { pending_verification: 2, approved: 1, rejected: 1, suspended: 1 });
  deq(V.filterVerificationCompanies(rows, 'pending_verification', '').map((r) => r.id), [3, 2], 'pending: oldest registration first');
  deq(V.filterVerificationCompanies(rows, 'all', '').map((r) => r.id), [5, 4, 1, 3, 2], 'others: newest decision first');
  deq(V.filterVerificationCompanies(rows, 'all', 'bravo.test').map((r) => r.id), [2], 'owner email');
  deq(V.filterVerificationCompanies(rows, 'all', 'sc222').map((r) => r.id), [2], 'company number, case-insensitive');
  deq(V.filterVerificationCompanies(rows, 'all', 'leeds').map((r) => r.id), [2], 'address');
  deq(V.filterVerificationCompanies(rows, 'approved', 'bravo').map((r) => r.id), [], 'filter and search combine');
  deq(V.VERIFICATION_LIST_FILTERS.map((f) => f.key), ['pending_verification', 'approved', 'rejected', 'suspended', 'all']);
});

test('CV-HISTORY: history entries read in plain words', () => {
  const e = (fromStatus, toStatus, action = 'company.verification_changed') => ({ id: 1, action, at: '', actor: null, fromStatus, toStatus, note: null });
  assert.equal(V.verificationHistoryTitle(e('pending_verification', 'approved')), 'Approved');
  assert.equal(V.verificationHistoryTitle(e('suspended', 'approved')), 'Reinstated');
  assert.equal(V.verificationHistoryTitle(e('pending_verification', 'rejected')), 'Rejected');
  assert.equal(V.verificationHistoryTitle(e('approved', 'suspended')), 'Suspended');
  assert.equal(V.verificationHistoryTitle(e('rejected', 'pending_verification', 'company.verification_reconsideration_requested')), 'Company asked S4 to reconsider');
});

test('CV-DECISION-ERRORS: conflicts and refusals explain what to do', () => {
  assert.match(V.verificationDecisionError(409, 'COMPANY_VERIFICATION_CHANGED', 'x'), /changed while you were deciding/);
  assert.match(V.verificationDecisionError(409, 'COMPANY_VERIFICATION_TRANSITION_NOT_ALLOWED', 'x'), /not available/);
  assert.match(V.verificationDecisionError(400, 'COMPANY_VERIFICATION_REASON_REQUIRED', 'x'), /reason is required/);
  assert.match(V.verificationDecisionError(403, undefined, 'x'), /Platform Admin/);
  assert.equal(V.verificationDecisionError(500, undefined, 'fallback'), 'fallback');
});

test('CV-BANNER: pending, rejected and suspended guidance; nothing when approved', () => {
  assert.equal(V.companyVerificationBanner('approved', null, true), null);
  assert.equal(V.companyVerificationBanner(undefined, null, true), null);
  const pending = V.companyVerificationBanner('pending_verification', null, true);
  assert.equal(pending.tone, 'warning');
  assert.match(pending.title, /awaiting verification/);
  assert.ok(pending.points.some((p) => /set up now/.test(p)) && pending.points.some((p) => /once S4 approves/.test(p)));
  assert.ok(pending.points.some((p) => /Safety alerts and incidents are never blocked/.test(p)));
  assert.equal(pending.canRequestReconsideration, false); assert.equal(pending.canCorrectDetails, true);
  const rejected = V.companyVerificationBanner('rejected', ' Company number does not match. ', true);
  assert.equal(rejected.reason, 'Company number does not match.');
  assert.equal(rejected.canRequestReconsideration, true); assert.equal(rejected.canCorrectDetails, true);
  const rejectedStaff = V.companyVerificationBanner('rejected', 'x', false);
  assert.equal(rejectedStaff.canRequestReconsideration, false, 'only owner / admin (company.manage)');
  assert.match(rejectedStaff.points[0], /owner or admin/);
  const suspended = V.companyVerificationBanner('suspended', 'Insurance expired', true);
  assert.equal(suspended.reason, 'Insurance expired');
  assert.equal(suspended.canRequestReconsideration, false, 'only S4 lifts a suspension');
  assert.equal(suspended.canCorrectDetails, false, 'suspended companies may not change registration (backend capability)');
  assert.match(suspended.supportGuidance, /Contact S4 support/);
  assert.ok(suspended.points.some((p) => /Safety alerts, incidents and patrol exceptions continue/.test(p)));
  assert.ok(suspended.points.some((p) => /timesheets/.test(p)));
});

test('CV-SCREENS: admin page and company banner use the shared design system and never block safety', () => {
  const panel = read('src/components/admin/CompanyVerificationPanel.tsx');
  assert.match(panel, /<ConfirmationDialog/, 'decisions are confirmed');
  assert.match(panel, /verificationReasonError\(pending, reason\)/, 'reason validated before the confirmation');
  assert.match(panel, /decideCompanyVerification\(selected\.id, decided\.target/);
  assert.match(panel, /getCompanyVerificationHistory/);
  assert.match(panel, /<FilterBar/);
  assert.doesNotMatch(panel, /beforeData|afterData|passwordHash|accessToken/, 'only the verification fields of the audit log');
  assert.doesNotMatch(panel, /#[0-9a-fA-F]{6}/, 'colours come from theme tokens');
  const banner = read('src/components/company/CompanyVerificationBanner.tsx');
  assert.match(banner, /onCompanyNotApproved\(/, 'refreshes on every refusal');
  assert.match(banner, /<ConfirmationDialog/, 'reconsideration is confirmed');
  assert.match(banner, /requestCompanyReconsideration\(message\)/);
  assert.doesNotMatch(banner, /disabled=\{[^}]*verification/i, 'the banner never disables other controls');
  assert.doesNotMatch(banner, /#[0-9a-fA-F]{6}/);
  const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
  assert.match(dashboard, /<CompanyVerificationBanner canManageCompany=\{canManageCompany\} \/>/);
  assert.match(dashboard, /includes\("company\.manage"\)/);
  const admin = read('src/screens/AdminDashboardScreen.tsx');
  assert.match(admin, /section === 'verification' \? <CompanyVerificationPanel \/>/);
});

// CV-NOT-APPROVED: behaviour of the real api.ts request path (stubbed fetch, as session-expiry.spec.cjs does).
function loadApi(respond) {
  const compiled = ts.transpileModule(read('src/services/api.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports, module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'spec' }) };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object, AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => { const { status, body } = respond(url, init); return { ok: status < 300, status, statusText: String(status), headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) }; },
    Headers: class Headers { constructor() { this._h = {}; } has(k) { return k.toLowerCase() in this._h; } set(k, v) { this._h[k.toLowerCase()] = v; } get(k) { return this._h[k.toLowerCase()]; } },
  });
  return mod.exports;
}

(async () => {
  const refusal = { statusCode: 403, code: 'COMPANY_NOT_APPROVED', verificationStatus: 'suspended', capability: 'new_operations', message: 'Your company has been suspended by S4. Existing work, safety alerts and records remain available, but this action is not.' };
  let next = { status: 403, body: refusal };
  const api = loadApi(() => next);
  const heard = [];
  const stop = api.onCompanyNotApproved((r) => heard.push(r));

  let thrown;
  try { await api.createClient({ name: 'x' }); } catch (e) { thrown = e; }
  assert.equal(thrown && thrown.status, 403, 'the request still fails exactly as before');
  assert.equal(heard.length, 1, 'the refusal is announced once');
  assert.equal(heard[0].verificationStatus, 'suspended');
  assert.equal(api.formatApiErrorMessage(thrown, 'fallback'), refusal.message, "one message: the backend's own words");

  next = { status: 403, body: { statusCode: 403, message: 'Forbidden resource' } };
  try { await api.createClient({ name: 'x' }); } catch {}
  assert.equal(heard.length, 1, 'an ordinary 403 (role / permission) is not a verification refusal');

  stop();
  next = { status: 403, body: refusal };
  try { await api.createClient({ name: 'x' }); } catch {}
  assert.equal(heard.length, 1, 'unsubscribed listeners hear nothing');

  assert.equal(api.isCompanyNotApprovedBody(null), false);
  assert.equal(api.isCompanyNotApprovedBody('COMPANY_NOT_APPROVED'), false);
  assert.match(api.companyNotApprovedMessage({ verificationStatus: 'suspended' }), /suspended.*Safety alerts and existing work continue/);
  assert.match(api.companyNotApprovedMessage({ verificationStatus: 'pending_verification' }), /awaiting verification/);

  const calls = [];
  const api2 = loadApi((url, init) => { calls.push(`${init?.method || 'GET'} ${url} ${init?.body || ''}`); return { status: 200, body: [] }; });
  await api2.listCompanyVerification('pending_verification');
  await api2.getCompanyVerificationHistory(7);
  await api2.decideCompanyVerification(7, 'suspended', '  Insurance expired  ');
  await api2.decideCompanyVerification(7, 'approved', '   ');
  await api2.requestCompanyReconsideration('');
  deq(calls.map((c) => c.replace('https://test.example', '')), [
    'GET /admin/companies/verification?status=pending_verification ',
    'GET /admin/companies/7/verification/history ',
    'PUT /admin/companies/7/verification {"status":"suspended","reason":"Insurance expired"}',
    'PUT /admin/companies/7/verification {"status":"approved"}',
    'POST /companies/me/verification/reconsideration {}',
  ]);
  tests += 1; console.log('PASS CV-NOT-APPROVED: every 403 COMPANY_NOT_APPROVED is announced and reads the same; verification calls hit the existing API');
  console.log(JSON.stringify({ event: 'company_verification_ui_tests_passed', tests }));
})().catch((e) => { console.error(e); process.exit(1); });
