#!/usr/bin/env node
/**
 * S4 public release — in-app S4 links, the client portal deletion request, and the Platform Admin deletion queue.
 *
 * Executes the real modules: the links constants module, the REAL api.ts against a scripted fetch, the pure admin queue
 * helpers, and renders the links, the client Account panel and the admin queue panel with the real reconciler.
 *
 *   LINKS-01   one constants module: exact Privacy, Terms, Support (mailto) and Account Deletion URLs, in one order
 *   LINKS-02   openS4Link opens the URL through Linking and never throws when the device refuses it
 *   LINKS-03   the support address is support@sfour.co.uk, the backend and verification copy agree, info@vesoft.co.uk is gone
 *   LINKS-04   the rendered links open exactly those URLs
 *   LINKS-05   every account / settings / sign-in surface shows the links (Guard + Company via the Account panel, client,
 *              admin, sign-in); no bare "contact S4 support" copy is left
 *   CLIENT-01  client portal: nothing is sent until asked; Request → explanation → Send request records it; no password
 *   CLIENT-02  an already-recorded request is shown as recorded and not sent again
 *   CLIENT-03  the client portal has an Account section with the panel
 *   ADMIN-01   admin queue API shapes: list, record by email with verification method + note, preview, complete (with
 *              identityConfirmed only when given)
 *   ADMIN-02   admin nav has the queue; refusal codes in words (owner with an open company: close via Company
 *              verification or transfer through S4 support); the confirmation never says a company closes; preview lines
 *   ADMIN-03   the rendered queue: blocking reason and transfer guidance, an emailed request needs verification fields,
 *              review shows the preview summary, a blocked owner cannot be completed, an emailed request needs the
 *              identity box ticked, completion goes through the confirmation with identityConfirmed
 */
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return originalResolve.call(this, request === 'react-native' ? 'react-native-web' : request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

const LINKS = loadTs('src/constants/s4Links.ts');
const QUEUE = loadTs('src/navigation/account-deletion-requests.ts');
const { ADMIN_NAV_ITEMS } = loadTs('src/navigation/admin-portal.ts');
const { CLIENT_ACCOUNT_DELETION_COPY } = loadTs('src/components/account/accountDeletionCopy.ts');

// ── the real api.ts against a scripted fetch (as account-lifecycle-ui.spec.cjs) ─────────────────────────────
function loadApi(router) {
  const compiled = ts.transpileModule(read('src/services/api.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await router(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300, status: spec.status, statusText: 'X',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null), json: async () => spec.body ?? null,
    };
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports, module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://api.test' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://api.test', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'store-app spec' }) };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object, fetch: fetchStub, AbortController, setTimeout, clearTimeout,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });
  return { api: mod.exports, calls };
}

// ── component loader: real modules, with api.ts and the modal dialog replaced ─────────────────────────────────
function loadComponents(overrides) {
  const cache = new Map();
  const load = (absolutePath) => {
    const key = path.relative(ROOT, absolutePath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (overrides[key]) return overrides[key];
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;
    const out = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const mod = { exports: {} };
    cache.set(absolutePath, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(absolutePath), request);
        for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return load(c);
      }
      if (request === 'react-native') return { ...require('react-native-web'), TextInput: (props) => h('input', props) };
      return require(request);
    };
    new Function('module', 'exports', 'require', out)(mod, mod.exports, req);
    return mod.exports;
  };
  return load;
}
const text = (renderer) => {
  const out = [];
  const walk = (n) => { if (n == null) return; if (typeof n === 'string') return out.push(n); if (Array.isArray(n)) return n.forEach(walk); (n.children || []).forEach(walk); };
  walk(renderer.toJSON());
  return out.join(' ');
};
/** Rendered text with all whitespace removed: adjacent text nodes are joined with spaces by text(). */
const tight = (renderer) => text(renderer).replace(/\s+/g, '');
const pressable = (renderer, label) => renderer.root.findAll((n) => typeof n.props.onPress === 'function' &&
  n.findAll((c) => c.children && c.children.filter((x) => typeof x === 'string').join('').includes(label)).length > 0)[0];
const press = async (renderer, label) => {
  const target = pressable(renderer, label);
  assert.ok(target, `control "${label}"`);
  await act(async () => { await target.props.onPress(); });
};
const formatApiErrorMessage = (_e, fallback) => fallback;
class ApiError extends Error { constructor(status, body) { super('api'); this.status = status; this.body = body; } }
/** The dialog renders nothing in Node; the spec reads its props and calls onConfirm as the button would. */
const dialogStub = { ConfirmationDialog: (props) => h('confirmation-dialog', { ...props, message: undefined, 'data-message': props.message }) };

// ═══════════════════════════════════ links ═══════════════════════════════════════════════════════════════
test('LINKS-01-ONE-MODULE-EXACT-URLS', () => {
  assert.equal(LINKS.S4_LINKS.privacy.url, 'https://sfour.co.uk/privacy');
  assert.equal(LINKS.S4_LINKS.terms.url, 'https://sfour.co.uk/terms');
  assert.equal(LINKS.S4_LINKS.support.url, 'mailto:support@sfour.co.uk');
  assert.equal(LINKS.S4_LINKS.accountDeletion.url, 'https://sfour.co.uk/account-deletion');
  assert.deepEqual([...LINKS.S4_LINK_ORDER], ['privacy', 'terms', 'support', 'accountDeletion']);
  assert.deepEqual(LINKS.s4Links().map((l) => l.label), ['Privacy Policy', 'Terms and Conditions', 'Support', 'Account Deletion']);
  // No other source file carries its own copy of the URLs.
  const offenders = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (/\.(ts|tsx)$/.test(entry.name) && rel !== 'src/constants/s4Links.ts' && /sfour\.co\.uk\/(privacy|terms|account-deletion)/.test(read(rel))) offenders.push(rel);
  } };
  walk('src');
  assert.deepEqual(offenders, [], 'the URLs live only in src/constants/s4Links.ts');
});

test('LINKS-02-OPEN-NEVER-THROWS', async () => {
  const opened = [];
  assert.equal(await LINKS.openS4Link('terms', { openURL: async (u) => { opened.push(u); } }), true);
  assert.deepEqual(opened, ['https://sfour.co.uk/terms']);
  assert.equal(await LINKS.openS4Link('support', { openURL: async () => { throw new Error('no mail app'); } }), false);
  assert.equal(await LINKS.openS4Link('bogus', { openURL: async () => undefined }), false);
});

test('LINKS-03-ONE-SUPPORT-ADDRESS-EVERYWHERE', () => {
  assert.equal(LINKS.S4_SUPPORT_EMAIL, 'support@sfour.co.uk', 'the owner-decided S4 support address');
  const backend = fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', 'src', 'auth', 'account-deletion.service.ts'), 'utf8');
  assert.match(backend, /export const S4_SUPPORT_EMAIL = 'support@sfour\.co\.uk';/, 'the backend blocker messages use the same address');
  const V = loadTs('src/navigation/company-verification.ts');
  for (const status of ['rejected', 'suspended']) {
    const banner = V.companyVerificationBanner ? V.companyVerificationBanner({ verificationStatus: status, verificationNote: 'x' }, true) : null;
    if (banner) assert.match(banner.supportGuidance, /support@sfour\.co\.uk/, `${status} banner names the address`);
  }
  const copy = read('src/navigation/company-verification.ts');
  assert.equal((copy.match(/contact S4 support at support@sfour\.co\.uk/gi) || []).length, 2);
  assert.doesNotMatch(copy, /contact S4 support(?! at support@sfour\.co\.uk)/i, 'no bare "contact S4 support" is left');
  // The old address is gone from app copy and from the backend.
  const offenders = [];
  const walk = (root, dir) => { for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel);
    else if (/\.(ts|tsx)$/.test(entry.name) && /info@vesoft\.co\.uk/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) offenders.push(rel);
  } };
  walk(ROOT, 'src');
  walk(path.join(ROOT, '..', 'security-backend-nest'), 'src');
  assert.deepEqual(offenders, [], 'no source file still names info@vesoft.co.uk');
});

test('LINKS-04-RENDERED-LINKS-OPEN-THE-URLS', async () => {
  const load = loadComponents({});
  const { S4LegalLinks } = load(path.join(ROOT, 'src/components/account/S4LegalLinks.tsx'));
  const opened = [];
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(S4LegalLinks, { showSupportAddress: true, linking: { openURL: async (u) => { opened.push(u); } } })); });
  assert.match(text(renderer), /Privacy Policy.*Terms and Conditions.*Support.*Account Deletion/);
  assert.match(tight(renderer), /Support:support@sfour\.co\.uk/);
  for (const label of ['Privacy Policy', 'Terms and Conditions', 'Support', 'Account Deletion']) await press(renderer, label);
  assert.deepEqual(opened, ['https://sfour.co.uk/privacy', 'https://sfour.co.uk/terms', 'mailto:support@sfour.co.uk', 'https://sfour.co.uk/account-deletion']);
  const links = renderer.root.findAll((n) => n.props.accessibilityRole === 'link' && typeof n.props.onPress === 'function');
  assert.equal(new Set(links.map((n) => n.props.accessibilityLabel)).size, 4, 'each link is announced as a link');
});

test('LINKS-05-EVERY-ACCOUNT-AND-SIGN-IN-SURFACE', async () => {
  const load = loadComponents({ 'src/services/api': { formatApiErrorMessage } });
  const { AccountSettingsPanel } = load(path.join(ROOT, 'src/components/account/AccountSettingsPanel.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountSettingsPanel, { email: 'g@example.invalid', onDeleted: () => undefined })); });
  assert.match(text(renderer), /Privacy Policy.*Terms and Conditions.*Support.*Account Deletion/, 'Account panel (Guard Profile + Company Account)');
  assert.match(read('src/screens/GuardDashboardScreen.tsx'), /<AccountSettingsPanel\b/, 'Guard Profile › Privacy & account uses the panel');
  assert.match(read('src/screens/CompanyDashboardScreen.tsx'), /<AccountSettingsPanel\b/, 'Company › Account uses the panel');
  assert.match(read('src/screens/AuthScreen.tsx'), /<S4LegalLinks testID="auth-legal-links" \/>/, 'sign-in footer');
  const admin = read('src/screens/AdminDashboardScreen.tsx');
  assert.match(admin, /<S4LegalLinks testID="admin-overview-legal-links" \/>/, 'Platform Admin overview');
  assert.match(read('src/components/admin/AccountDeletionRequestsPanel.tsx'), /<S4LegalLinks testID="admin-legal-links" \/>/);
  assert.match(read('src/components/account/ClientAccountPanel.tsx'), /<S4LegalLinks showSupportAddress testID="client-legal-links" \/>/, 'client portal');
});

// ═══════════════════════════════════ client portal ═══════════════════════════════════════════════════════
test('CLIENT-01-REQUEST-DELETION-JOURNEY', async () => {
  const calls = [];
  const blockerMessage = 'Your request is recorded. S4 support completes the deletion of client portal accounts.';
  const load = loadComponents({ 'src/services/api': {
    formatApiErrorMessage,
    getAccountDeletionStatus: async () => { calls.push('status'); return { deletionRequestedAt: null, deletionCompletedAt: null, selfServiceAvailable: false, blocker: 'client_portal', blockerMessage }; },
    requestAccountDeletion: async () => { calls.push('request'); return { deletionRequestedAt: '2026-11-24T10:00:00.000Z', deletionCompletedAt: null, selfServiceAvailable: false, blocker: 'client_portal', blockerMessage }; },
    confirmAccountDeletion: async () => { calls.push('confirm'); throw new Error('must not be called'); },
  } });
  const { ClientAccountPanel } = load(path.join(ROOT, 'src/components/account/ClientAccountPanel.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(ClientAccountPanel, { email: 'client@example.invalid' })); });
  assert.match(text(renderer), /Request account deletion/);
  assert.deepEqual(calls, [], 'nothing is sent until the user asks');
  await press(renderer, 'Request account deletion');
  assert.match(text(renderer), /Request deletion of your client portal login/);
  assert.match(text(renderer), /belong to that company and are not deleted/);
  assert.deepEqual(calls, ['status']);
  await press(renderer, CLIENT_ACCOUNT_DELETION_COPY.explainContinue);
  assert.deepEqual(calls, ['status', 'request']);
  assert.match(text(renderer), /We have recorded your request/);
  assert.match(text(renderer), /S4 support completes/);
  assert.equal(renderer.root.findAll((n) => n.props.secureTextEntry === true).length, 0, 'no password step');
});

test('CLIENT-02-ALREADY-REQUESTED-IS-NOT-SENT-AGAIN', async () => {
  const calls = [];
  const load = loadComponents({ 'src/services/api': {
    formatApiErrorMessage,
    getAccountDeletionStatus: async () => { calls.push('status'); return { deletionRequestedAt: '2026-11-20T10:00:00.000Z', selfServiceAvailable: false, blocker: 'client_portal', blockerMessage: 'Recorded.' }; },
    requestAccountDeletion: async () => { calls.push('request'); return {}; },
  } });
  const { ClientAccountPanel } = load(path.join(ROOT, 'src/components/account/ClientAccountPanel.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(ClientAccountPanel, {})); });
  await press(renderer, 'Request account deletion');
  assert.match(text(renderer), /We have recorded your request/);
  assert.match(tight(renderer), /Requestedon20\/11\/2026/);
  assert.deepEqual(calls, ['status']);
});

test('CLIENT-03-CLIENT-PORTAL-HAS-AN-ACCOUNT-SECTION', () => {
  const screen = read('src/screens/ClientPortalScreen.tsx');
  assert.match(screen, /\{ id: 'account', label: 'Account' \}/);
  assert.match(screen, /case 'account':\s*return <ClientAccountPanel email=\{user\.email\} \/>;/);
});

// ═══════════════════════════════════ admin queue ═════════════════════════════════════════════════════════
test('ADMIN-01-QUEUE-API-SHAPES', async () => {
  const { api, calls } = loadApi(() => ({ status: 200, body: [] }));
  await api.listAccountDeletionRequests();
  await api.recordAccountDeletionRequest('  person@example.invalid ', 'request_from_registered_email', '  Matched registered address ');
  await api.getAccountDeletionPreview(12);
  await api.completeAccountDeletionRequest('user', 12);
  await api.completeAccountDeletionRequest('client_portal_user', 7, { identityConfirmed: true });
  assert.deepEqual(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url.replace('https://api.test', '')}`), [
    'GET /admin/account-deletion-requests',
    'POST /admin/account-deletion-requests',
    'GET /admin/account-deletion-requests/users/12/preview',
    'POST /admin/account-deletion-requests/users/12/complete',
    'POST /admin/account-deletion-requests/client-portal-users/7/complete',
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    email: 'person@example.invalid', verificationMethod: 'request_from_registered_email', verificationNote: 'Matched registered address',
  });
  assert.deepEqual(JSON.parse(calls[3].init.body), {}, 'an in-app request needs no identity flag');
  assert.deepEqual(JSON.parse(calls[4].init.body), { identityConfirmed: true });
});

const SUMMARY = {
  companyId: 3, verificationStatus: 'approved', closed: false, shiftsInProgress: 1, futureShifts: 2, timesheetsAwaitingApproval: 4,
  approvedTimesheetsNotPaid: 5, invoiceBatchesNotPaid: 1, payrollBatchesNotPaid: 0, clientWeeklyApprovalsOpen: 1, clientShiftDisputesOpen: 0,
};

test('ADMIN-02-NAV-WORDS-AND-CONFIRMATION', () => {
  const item = ADMIN_NAV_ITEMS.find((entry) => entry.key === 'accountDeletion');
  assert.ok(item, 'the queue is navigable');
  assert.equal(item.label, 'Account deletion requests');
  const active = QUEUE.deletionRequestError('ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY', 'x');
  assert.match(active, /not closed/);
  assert.match(active, /never closes a company/);
  assert.match(active, /Company verification screen/);
  assert.match(active, /transfer of ownership with S4 support at support@sfour\.co\.uk/);
  assert.match(active, /no transfer in the app/i);
  assert.match(active, /stays pending/);
  assert.match(QUEUE.deletionRequestError('ACCOUNT_DELETION_COMPANY_SHIFTS_OUTSTANDING', 'x'), /in progress or starting in the future/);
  assert.match(QUEUE.deletionRequestError('ACCOUNT_DELETION_IDENTITY_NOT_CONFIRMED', 'x'), /Tick the box/);
  assert.match(QUEUE.deletionRequestError('ACCOUNT_DELETION_SELF', 'x'), /your own account/);
  assert.match(QUEUE.deletionRequestError('ACCOUNT_DELETION_LAST_PLATFORM_ADMIN', 'x'), /last active Platform Admin/);
  assert.equal(QUEUE.deletionRequestError('SOMETHING_NEW', 'fallback'), 'fallback');

  const owner = QUEUE.deletionCompletionConfirmation({ email: 'o@example.invalid', accountType: 'company_owner', requestedBy: 'self',
    companies: [{ id: 1, name: 'Acme Security', verificationStatus: 'suspended', closed: true, shiftsInProgress: 0, futureShifts: 0 }], client: null });
  assert.doesNotMatch(owner.message, /will be closed/, 'deletion never closes a company');
  assert.match(owner.message, /memberships and team access are not changed/);
  assert.match(owner.message, /cannot be undone/);
  const client = QUEUE.deletionCompletionConfirmation({ email: 'c@example.invalid', accountType: 'client_portal', requestedBy: 'admin', companies: [], client: { id: 2, name: 'Client', companyId: 1, companyName: 'Acme Security' } });
  assert.match(client.message, /client portal login is anonymised/);
  assert.match(client.message, /Acme Security's records about its client are kept/);
  assert.match(client.message, /confirm the requester's identity/);

  assert.equal(QUEUE.canConfirmCompletion({ requestedBy: 'admin' }, false), false, 'emailed: the box must be ticked');
  assert.equal(QUEUE.canConfirmCompletion({ requestedBy: 'admin' }, true), true);
  assert.equal(QUEUE.canConfirmCompletion({ requestedBy: 'self' }, false), true);
  assert.equal(QUEUE.canConfirmCompletion({ requestedBy: 'self' }, false, { canComplete: false }), false);

  const lines = QUEUE.companySummaryLines(SUMMARY).join('\n');
  assert.match(lines, /Company #3 · approved \(not closed\)/);
  assert.match(lines, /1 shift in progress · 2 future shifts/);
  assert.match(lines, /4 timesheets awaiting approval · 5 approved timesheets not paid · 1 invoice batches not paid · 0 payroll batches not paid · 1 client weekly approvals open · 0 client shift disputes open/);

  assert.deepEqual(QUEUE.DELETION_VERIFICATION_METHODS.map((m) => m.value), ['request_from_registered_email', 'confirmed_in_app_by_user', 'other_verified']);
  assert.match(QUEUE.recordRequestVerificationError(null, 'x'), /Choose how/);
  assert.match(QUEUE.recordRequestVerificationError('other_verified', '   '), /verification note/);
  assert.match(QUEUE.recordRequestVerificationError('other_verified', 'x'.repeat(201)), /200 characters/);
  assert.equal(QUEUE.recordRequestVerificationError('other_verified', 'Called back'), null);
  assert.match(QUEUE.recordRequestEmailError(''), /Enter the email/);
  assert.match(QUEUE.recordRequestEmailError('not-an-email'), /valid email/);
  assert.equal(QUEUE.recordRequestEmailError(' a@b.co '), null);
});

test('ADMIN-03-RENDERED-QUEUE', async () => {
  const calls = [];
  const blockedReason = 'This account still owns a company that is not closed.';
  const rows = [
    { kind: 'user', id: 5, email: 'owner@example.invalid', name: null, role: 'company_admin', accountType: 'company_owner', requestedAt: '2026-11-20T10:00:00.000Z', requestedBy: 'self',
      companies: [{ id: 3, name: 'Acme Security', verificationStatus: 'approved', closed: false, shiftsInProgress: 1, futureShifts: 2 }], client: null,
      blockedCode: 'ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY', blockedReason },
    { kind: 'client_portal_user', id: 9, email: 'client@example.invalid', name: 'Clara Client', role: 'client_admin', accountType: 'client_portal', requestedAt: '2026-11-21T10:00:00.000Z', requestedBy: 'admin',
      companies: [], client: { id: 4, name: 'Client Ltd', companyId: 3, companyName: 'Acme Security' }, blockedCode: null, blockedReason: null },
  ];
  const load = loadComponents({
    'src/components/ui/ConfirmationDialog': dialogStub,
    'src/services/api': {
      ApiError, formatApiErrorMessage,
      listAccountDeletionRequests: async () => { calls.push('list'); return rows; },
      getAccountDeletionPreview: async (id) => { calls.push(`preview:${id}`); return { kind: 'user', userId: id, accountType: 'company_owner', requestedVia: 'in_app', identityConfirmationRequired: false, companies: [SUMMARY], blockedCode: 'ACCOUNT_DELETION_OWNER_HAS_ACTIVE_COMPANY', canComplete: false }; },
      recordAccountDeletionRequest: async (email, method, note) => { calls.push(`record:${email}:${method}:${note}`); return { alreadyRequested: false, request: { ...rows[1], email } }; },
      completeAccountDeletionRequest: async (kind, id, options) => { calls.push(`complete:${kind}:${id}:${JSON.stringify(options ?? {})}`); return { deleted: true, kind, id }; },
    },
  });
  const { AccountDeletionRequestsPanel } = load(path.join(ROOT, 'src/components/admin/AccountDeletionRequestsPanel.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountDeletionRequestsPanel)); });
  assert.deepEqual(calls, ['list']);
  const shown = text(renderer);
  assert.match(shown, /owner@example\.invalid/);
  assert.match(tight(renderer), /OwnsAcmeSecurity\(#3\)·approved\(notclosed\)·1inprogress·2futureshifts/);
  assert.match(shown, /still owns a company that is not closed/, 'the blocking reason is shown');
  assert.match(shown, /transfer of ownership with S4 support at support@sfour\.co\.uk/, 'transfer is arranged with S4 support');
  assert.match(shown, /stays pending until then/);
  assert.match(shown, /client@example\.invalid/);
  assert.match(shown, /recorded by S4 from an email/);
  assert.match(shown, /Privacy Policy/);
  assert.equal(renderer.root.findAll((n) => n.props.label === 'Complete deletion' && 'disabled' in n.props).length, 0, 'nothing completes before a review');

  // Record an emailed request: email, verification method and note are all required.
  const input = (label) => renderer.root.findAll((n) => n.type === 'input' && n.props.accessibilityLabel === label)[0];
  const recordButton = () => renderer.root.findAll((n) => n.props.label === 'Record request' && typeof n.props.onPress === 'function')[0];
  await act(async () => { await recordButton().props.onPress(); });
  assert.match(text(renderer), /Enter the email address/);
  assert.match(text(renderer), /Choose how the request was verified/);
  await act(async () => { input('Email address the request came from').props.onChangeText('person@example.invalid'); });
  await act(async () => { await recordButton().props.onPress(); });
  assert.ok(!calls.some((c) => c.startsWith('record:')), 'nothing sent without the verification fields');
  const radio = renderer.root.findAll((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === 'Sent from the registered email address' && typeof n.props.onPress === 'function')[0];
  await act(async () => { radio.props.onPress(); });
  await act(async () => { await recordButton().props.onPress(); });
  assert.match(text(renderer), /Add a short verification note/);
  assert.ok(!calls.some((c) => c.startsWith('record:')));
  assert.equal(input('Verification note').props.maxLength, 200);
  await act(async () => { input('Verification note').props.onChangeText('Matched registered address'); });
  await act(async () => { await recordButton().props.onPress(); });
  assert.ok(calls.includes('record:person@example.invalid:request_from_registered_email:Matched registered address'));
  assert.match(text(renderer), /Deletion request recorded for person@example\.invalid/);

  const reviewButtons = () => renderer.root.findAll((n) => n.props.label === 'Review deletion' && typeof n.props.onPress === 'function');
  const completeButton = () => renderer.root.findAll((n) => n.props.label === 'Complete deletion' && 'disabled' in n.props)[0];

  // Review the owner: the preview summary is shown, and completion stays disabled.
  await act(async () => { await reviewButtons()[0].props.onPress(); });
  assert.ok(calls.includes('preview:5'));
  const reviewed = text(renderer);
  assert.match(reviewed, /Company #3 · approved \(not closed\)/);
  assert.match(reviewed, /4 timesheets awaiting approval/);
  assert.match(reviewed, /Deletion changes none of them and deletes no records/);
  assert.equal(completeButton().props.disabled, true, 'a blocked owner cannot be completed');
  await press(renderer, 'Cancel');

  // Review the emailed client login: completion needs the identity box ticked.
  await act(async () => { await reviewButtons()[1].props.onPress(); });
  assert.ok(!calls.includes('preview:9'), 'a client login has no company preview');
  assert.equal(completeButton().props.disabled, true, 'identity not yet confirmed');
  const box = renderer.root.findAll((n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function')[0];
  assert.match(box.props.accessibilityLabel, /verified that this request came from the account holder/);
  await act(async () => { box.props.onPress(); });
  assert.equal(completeButton().props.disabled, false);
  await act(async () => { completeButton().props.onPress(); });
  const dialog = renderer.root.findAll((n) => n.type === 'confirmation-dialog')[0];
  assert.ok(dialog && dialog.props.visible, 'a confirmation is asked first');
  assert.match(dialog.props['data-message'], /client@example\.invalid/);
  assert.ok(!calls.some((c) => c.startsWith('complete:')), 'nothing completed before confirming');
  await act(async () => { await dialog.props.onConfirm(); });
  assert.ok(calls.includes('complete:client_portal_user:9:{"identityConfirmed":true}'));
  assert.match(text(renderer), /client@example\.invalid has been deleted/);
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && (error.stack || error.message)));
      process.exitCode = 1;
    }
  }
  console.log(`\nACCOUNT DELETION UI: ${passed}/${pending.length} PASS`);
})();
