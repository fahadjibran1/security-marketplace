#!/usr/bin/env node
/**
 * Company staff management in the company web (owner-approved 27 Oct 2026): the Staff section and the emailed
 * /accept-invitation page.
 *
 *   SUI-01  the pure rules (src/components/company/companyStaff.ts): who sees Staff, invite validation, the
 *           confirmation copy, every history line, grouping
 *   SUI-02  the REAL api.ts against a scripted fetch: routes, methods and bodies; the invitation token travels in
 *           the body only, never a URL; /accept-invitation is an account link
 *   SUI-03  the invitation page, new address: opening it previews (never accepts); the invitee chooses their own
 *           password (mismatch refused locally); exactly one acceptance with the password; the token is never shown
 *   SUI-04  the invitation page, existing account: no password is asked for or sent
 *   SUI-05  the invitation page, refused link or account: the server's words, no form, nothing accepted
 *   SUI-06  the Staff section mounted: members (role, status, last sign-in, Control Room grants), invitations and
 *           history; nothing is written on load; the account holder has no actions; removed staff on request
 *   SUI-07  invite: validated first, then exactly one request with the trimmed address and the chosen role
 *   SUI-08  suspend: confirmation first; Cancel sends nothing; Confirm sends exactly one request
 *   SUI-09  remove and withdraw invitation: confirmation first, then exactly one request each
 *   SUI-10  change role: picker, Save, confirmation, exactly one request
 *   SUI-11  Control Room grants: one press, one request to the EXISTING grant endpoints
 *   SUI-12  reactivate and re-send: one press, one request
 *   SUI-13  a refusal is shown in words
 *   SUI-14  dashboard wiring: Staff in the Management group, shown only with staff.manage
 *   SUI-15  release wiring: package script, mobile gate step, Vercel route
 */
const Module = require('node:module');
const originalLoad = Module._load;
const RNW = require('react-native-web');
const React = require('react');

function TestModal({ visible, children }) {
  return visible ? React.createElement('test-modal', null, children) : null;
}
const RN_SHIM = {
  ...RNW,
  Modal: TestModal,
  TextInput: (props) => React.createElement('input', props),
  useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
};
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN_SHIM;
  if (request === 'react-native-safe-area-context') {
    return {
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      SafeAreaView: ({ children }) => React.createElement(React.Fragment, null, children),
    };
  }
  return originalLoad.call(this, request, ...rest);
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const TestRenderer = require('react-test-renderer');
const { loadTs, ROOT } = require('./load-ts.cjs');

const { act } = TestRenderer;
const h = React.createElement;
const staff = loadTs('src/components/company/companyStaff.ts');
const links = loadTs('src/components/account/accountLinks.ts');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

const TOKEN = 'SW52aXRhdGlvbi10b2tlbi10aGF0LWlzLWxvbmctZW5vdWdoLTEyMw';

/** Loads a component with the API module replaced. */
function loader(apiOverrides) {
  const cache = new Map();
  const load = (absolutePath) => {
    const key = path.relative(ROOT, absolutePath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (key === 'src/services/api') return apiOverrides;
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;
    const out = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(absolutePath, mod);
    const req = (request) => {
      if (request.startsWith('.')) {
        const base = path.resolve(path.dirname(absolutePath), request);
        for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
          if (fs.existsSync(c)) return load(c);
        }
      }
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
/** The control whose visible text includes `label`. */
const press = async (renderer, label) => {
  const target = renderer.root.findAll((n) => typeof n.props.onPress === 'function' &&
    n.findAll((c) => c.children && c.children.filter((x) => typeof x === 'string').join('').includes(label)).length > 0)[0];
  assert.ok(target, `control "${label}"`);
  await act(async () => { await target.props.onPress(); });
};
/** The control with exactly this accessibility label. */
const byLabel = (renderer, label) => renderer.root.findAll((n) => n.props && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const pressLabel = async (renderer, label) => {
  const [target] = byLabel(renderer, label);
  assert.ok(target, `control labelled "${label}"`);
  await act(async () => { await target.props.onPress(); });
};
const inputLabelled = (renderer, label) => renderer.root.findAll((n) => n.type === 'input' && n.props.accessibilityLabel === label)[0];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

class ApiError extends Error {
  constructor(status, body) { super(body && body.message ? body.message : 'error'); this.status = status; this.body = body; }
}
const formatApiErrorMessage = (e, fallback) => (e && e.message && e.message !== 'error' ? e.message : fallback);

// ═══ SUI-01 ═══
test('SUI-01-PURE-RULES', () => {
  assert.equal(staff.canManageStaffFromSession(['staff.manage'], 'company_staff'), true);
  assert.equal(staff.canManageStaffFromSession(['shifts.view', 'attendance.manage'], 'company_admin'), false, 'the session list decides');
  assert.equal(staff.canManageStaffFromSession(undefined, 'company_admin'), true, 'legacy owner session');
  assert.equal(staff.canManageStaffFromSession(undefined, 'company_staff'), false);
  assert.equal(staff.canManageStaffFromSession(undefined, 'guard'), false);
  assert.match(staff.validateStaffInvite('', 'viewer'), /Enter the email/);
  assert.match(staff.validateStaffInvite('not an email', 'viewer'), /valid email/);
  assert.match(staff.validateStaffInvite('a@b.co', null), /Choose a role/);
  assert.equal(staff.validateStaffInvite('  a@b.co ', 'viewer'), null);
  assert.deepEqual(Object.keys(staff.STAFF_ROLE_LABELS), ['owner', 'admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'], 'every membership role');
  const s = staff.confirmationCopy('suspend', 'Ava');
  assert.match(s.message, /lose access .* straight away/);
  assert.match(s.message, /signed out .* every device/);
  assert.equal(s.danger, true);
  const r = staff.confirmationCopy('remove', 'Ava');
  assert.match(r.message, /invite them again/);
  assert.match(staff.confirmationCopy('change-role', 'Ava', { role: 'viewer' }).message, /Control Room permissions are switched off/);
  assert.doesNotMatch(staff.confirmationCopy('change-role', 'Ava', { role: 'control_room' }).message, /switched off/);
  const e = (action, before, after) => ({ id: 1, action, entityType: 'x', entityId: 1, actorUserId: 1, actorName: 'Owen Owner', targetUserId: 2, targetName: 'Ava Admin', before, after, createdAt: '2026-10-27T10:00:00Z' });
  assert.equal(staff.describeStaffAudit(e('company_staff_invitation.created', null, { email: 'n@x.co', role: 'control_room' })), 'Owen Owner invited n@x.co as Control Room');
  assert.equal(staff.describeStaffAudit(e('company_staff_invitation.accepted', null, { role: 'viewer', accountCreated: true })), 'Ava Admin accepted the invitation and joined as Viewer (new S4 account)');
  assert.equal(staff.describeStaffAudit(e('company_staff.role_changed', { role: 'operations' }, { role: 'viewer', previousRole: 'operations', grantsCleared: false })), "Owen Owner changed Ava Admin's role from Operations to Viewer");
  assert.match(staff.describeStaffAudit(e('company_staff.role_changed', { role: 'control_room' }, { role: 'viewer', previousRole: 'control_room', grantsCleared: true })), /permissions switched off/);
  assert.equal(staff.describeStaffAudit(e('company_staff.suspended', null, {})), "Owen Owner suspended Ava Admin's access");
  assert.equal(staff.describeStaffAudit(e('company_staff.reactivated', null, {})), "Owen Owner reactivated Ava Admin's access");
  assert.equal(staff.describeStaffAudit(e('company_staff.removed', null, {})), 'Owen Owner removed Ava Admin from the company');
  assert.equal(staff.describeStaffAudit(e('company_membership.amendment_authorisation', null, { canAmendShifts: true })), 'Owen Owner switched shift extensions on for Ava Admin');
  assert.equal(staff.describeStaffAudit(e('company_membership.attendance_authorisation', null, { canManageAttendance: false })), 'Owen Owner switched attendance management off for Ava Admin');
  assert.match(staff.describeStaffAudit(e('company_staff_invitation.revoked', null, { email: 'n@x.co', reason: 'superseded' })), /replaced by a new one/);
  assert.match(staff.describeStaffAudit(e('company_staff_invitation.revoked', null, { email: 'n@x.co', reason: 'withdrawn' })), /withdrew the invitation/);
  assert.equal(staff.formatLastActivity(null), 'Never signed in');
  const g = staff.groupMembers([{ status: 'active' }, { status: 'revoked' }, { status: 'suspended' }]);
  assert.equal(g.current.length, 2);
  assert.equal(g.removed.length, 1);
});

// ═══ SUI-02 ═══
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
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://api.test' };
      if (id.endsWith('models') || id.endsWith('companyStaff')) return {};
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

test('SUI-02-API-ROUTES-AND-BODIES', async () => {
  assert.deepEqual(links.parseAccountLink('/accept-invitation', `?token=${TOKEN}`), { kind: 'accept-invitation', token: TOKEN });
  const replaced = [];
  const taken = links.takeAccountLink({ pathname: '/accept-invitation', search: `?token=${TOKEN}` }, { replaceState: (_s, _t, url) => replaced.push(url) });
  assert.equal(taken.token, TOKEN);
  assert.deepEqual(replaced, ['/accept-invitation'], 'the token leaves the address bar at once');

  const { api, calls } = loadApi(async () => ({ status: 200, body: {} }));
  await api.previewStaffInvitation(TOKEN);
  await api.acceptStaffInvitation(TOKEN, { newPassword: 'Chosen-1', firstName: ' Nadia ', lastName: '' });
  await api.acceptStaffInvitation(TOKEN);
  await api.getCompanyStaff();
  await api.getCompanyStaffAudit();
  await api.inviteCompanyStaff('  new@example.invalid ', 'control_room');
  await api.resendCompanyStaffInvitation(11);
  await api.revokeCompanyStaffInvitation(11);
  await api.changeCompanyStaffRole(7, 'viewer');
  await api.suspendCompanyStaff(7);
  await api.reactivateCompanyStaff(7);
  await api.removeCompanyStaff(7);
  const seen = calls.map((c) => [c.init?.method ?? 'GET', c.url.replace('https://api.test', ''), c.init?.body ? JSON.parse(c.init.body) : null]);
  assert.deepEqual(seen, [
    ['POST', '/auth/staff-invitations/preview', { token: TOKEN }],
    ['POST', '/auth/staff-invitations/accept', { token: TOKEN, newPassword: 'Chosen-1', firstName: 'Nadia' }],
    ['POST', '/auth/staff-invitations/accept', { token: TOKEN }],
    ['GET', '/company-staff', null],
    ['GET', '/company-staff/audit?limit=200', null],
    ['POST', '/company-staff/invitations', { email: 'new@example.invalid', role: 'control_room' }],
    ['POST', '/company-staff/invitations/11/resend', null],
    ['POST', '/company-staff/invitations/11/revoke', null],
    ['PATCH', '/company-staff/members/7/role', { role: 'viewer' }],
    ['POST', '/company-staff/members/7/suspend', null],
    ['POST', '/company-staff/members/7/reactivate', null],
    ['POST', '/company-staff/members/7/remove', null],
  ]);
  for (const c of calls) assert.ok(!c.url.includes(TOKEN), 'the token is never in a URL');
});

// ═══ the invitation page ═══
function linkScreen(overrides) {
  const calls = [];
  const load = loader({
    ApiError,
    formatApiErrorMessage,
    resetPassword: async () => { throw new Error('not here'); },
    verifyEmailAddress: async () => { throw new Error('not here'); },
    previewStaffInvitation: async (token) => { calls.push(['preview', token]); return overrides.preview(token); },
    acceptStaffInvitation: async (token, details) => { calls.push(['accept', token, details]); return overrides.accept(token, details); },
  });
  return { AccountLinkScreen: load(path.join(ROOT, 'src/screens/AccountLinkScreen.tsx')).AccountLinkScreen, calls };
}
const PREVIEW_NEW = { companyName: 'Harbour Security Ltd', role: 'control_room', roleLabel: 'Control Room', email: 'new@example.invalid', expiresAt: '2026-11-03T10:00:00Z', accountExists: false };

test('SUI-03-INVITATION-PAGE-NEW-ACCOUNT-CHOOSES-OWN-PASSWORD', async () => {
  const { AccountLinkScreen, calls } = linkScreen({
    preview: async () => PREVIEW_NEW,
    accept: async () => ({ accepted: true, accountCreated: true, message: 'Your S4 account has been created and you have joined Harbour Security Ltd. Sign in with this email address and the password you chose.' }),
  });
  let renderer;
  let done = 0;
  await act(async () => { renderer = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'accept-invitation', token: TOKEN }, onDone: () => { done += 1; } })); });
  await flush();
  assert.deepEqual(calls, [['preview', TOKEN]], 'opening the page previews only');
  const page = text(renderer);
  assert.match(page, /Join Harbour Security Ltd on S4/);
  assert.match(page, /as Control Room/);
  assert.match(page, /Nobody else, including the company, ever sees or sets it/);
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(TOKEN), 'the token is never rendered');
  await act(async () => {
    inputLabelled(renderer, 'First name').props.onChangeText('Nadia');
    inputLabelled(renderer, 'Password').props.onChangeText('Chosen-pass-1');
    inputLabelled(renderer, 'Confirm password').props.onChangeText('Chosen-pass-2');
  });
  await press(renderer, 'Create account and accept');
  assert.match(text(renderer), /do not match/);
  assert.equal(calls.length, 1, 'refused locally, nothing sent');
  await act(async () => { inputLabelled(renderer, 'Confirm password').props.onChangeText('Chosen-pass-1'); });
  await press(renderer, 'Create account and accept');
  assert.deepEqual(calls[1], ['accept', TOKEN, { newPassword: 'Chosen-pass-1', firstName: 'Nadia', lastName: '' }]);
  assert.equal(calls.length, 2, 'exactly one acceptance');
  assert.match(text(renderer), /Sign in with this email address and the password you chose/);
  await press(renderer, 'Go to S4 sign in');
  assert.equal(done, 1);
});

test('SUI-04-INVITATION-PAGE-EXISTING-ACCOUNT-SENDS-NO-PASSWORD', async () => {
  const { AccountLinkScreen, calls } = linkScreen({
    preview: async () => ({ ...PREVIEW_NEW, accountExists: true }),
    accept: async () => ({ accepted: true, accountCreated: false, message: 'You have joined Harbour Security Ltd. Sign in to S4 with your existing password.' }),
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'accept-invitation', token: TOKEN }, onDone: () => undefined })); });
  await flush();
  assert.equal(renderer.root.findAll((n) => n.type === 'input' && n.props.secureTextEntry === true).length, 0, 'no password asked for');
  assert.match(text(renderer), /your password does not change/);
  await press(renderer, 'Accept invitation');
  assert.deepEqual(calls, [['preview', TOKEN], ['accept', TOKEN, {}]], 'no password sent');
  assert.match(text(renderer), /existing password/);
});

test('SUI-05-INVITATION-PAGE-REFUSED', async () => {
  const words = "This invitation can't be accepted with the S4 account that uses this email address. Ask the company to invite a different email address.";
  const { AccountLinkScreen, calls } = linkScreen({
    preview: async () => { throw new ApiError(403, { message: words }); },
    accept: async () => { throw new Error('must not be called'); },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'accept-invitation', token: TOKEN }, onDone: () => undefined })); });
  await flush();
  assert.match(text(renderer), /can't be accepted/);
  assert.equal(renderer.root.findAll((n) => n.props && n.props.testID === 'staff-invitation-form').length, 0, 'no form');
  assert.deepEqual(calls, [['preview', TOKEN]]);
  let noToken;
  await act(async () => { noToken = TestRenderer.create(h(AccountLinkScreen, { link: { kind: 'accept-invitation', token: null }, onDone: () => undefined })); });
  assert.match(text(noToken), /invitation link is invalid or has expired/, 'a link without a token is refused up front');
  assert.equal(calls.length, 1, 'and nothing is sent for it');
});

// ═══ the Staff section ═══
const member = (over) => ({
  membershipId: 1, email: 'x@example.invalid', roleLabel: '', status: 'active', isPrimaryOwner: false, isYou: false,
  canAmendShifts: false, canManageAttendance: false, lastLoginAt: '2026-10-27T09:15:00Z', joinedAt: null, disabledAt: null,
  actions: { changeRole: true, suspend: true, reactivate: false, remove: true, grants: false },
  ...over,
});
const LABEL = { owner: 'Owner', admin: 'Admin', operations: 'Operations', control_room: 'Control Room', hr_compliance: 'HR & Compliance', finance: 'Finance', viewer: 'Viewer' };
const DIRECTORY = () => ({
  you: { userId: 1, role: 'owner', isPrimaryOwner: true },
  assignableRoles: Object.entries(LABEL).map(([role, label]) => ({ role, label })),
  members: [
    member({ userId: 1, displayName: 'Owen Owner', role: 'owner', roleLabel: 'Owner', isPrimaryOwner: true, isYou: true, actions: { changeRole: false, suspend: false, reactivate: false, remove: false, grants: false } }),
    member({ userId: 2, displayName: 'Ava Admin', role: 'admin', roleLabel: 'Admin' }),
    member({ userId: 3, displayName: 'Cal Control', role: 'control_room', roleLabel: 'Control Room', canManageAttendance: true, actions: { changeRole: true, suspend: true, reactivate: false, remove: true, grants: true } }),
    member({ userId: 4, displayName: 'Sue Suspended', role: 'operations', roleLabel: 'Operations', status: 'suspended', lastLoginAt: null, actions: { changeRole: true, suspend: false, reactivate: true, remove: true, grants: false } }),
    member({ userId: 5, displayName: 'Rex Removed', role: 'viewer', roleLabel: 'Viewer', status: 'revoked', actions: { changeRole: false, suspend: false, reactivate: false, remove: false, grants: false } }),
  ],
  invitations: [
    { id: 11, email: 'pending@example.invalid', role: 'viewer', roleLabel: 'Viewer', state: 'PENDING', createdAt: '2026-10-27T08:00:00Z', expiresAt: '2026-11-03T08:00:00Z', invitedByUserId: 1, canManage: true },
    { id: 12, email: 'boss@example.invalid', role: 'admin', roleLabel: 'Admin', state: 'EXPIRED', createdAt: '2026-10-10T08:00:00Z', expiresAt: '2026-10-17T08:00:00Z', invitedByUserId: 1, canManage: false },
  ],
});
const HISTORY = [
  { id: 91, action: 'company_staff.suspended', entityType: 'company_membership', entityId: 4, actorUserId: 1, actorName: 'Owen Owner', targetUserId: 4, targetName: 'Sue Suspended', before: { status: 'active' }, after: { status: 'suspended' }, createdAt: '2026-10-27T10:00:00Z' },
  { id: 90, action: 'company_membership.attendance_authorisation', entityType: 'company_membership', entityId: 3, actorUserId: 1, actorName: 'Owen Owner', targetUserId: 3, targetName: 'Cal Control', before: { canManageAttendance: false }, after: { canManageAttendance: true }, createdAt: '2026-10-27T09:00:00Z' },
];

function staffSection(overrides = {}) {
  const calls = { reads: 0, mutations: [] };
  const mutate = (name) => async (...args) => {
    calls.mutations.push([name, ...args]);
    if (overrides[name]) return overrides[name](...args);
    return {};
  };
  const load = loader({
    formatApiErrorMessage,
    getCompanyStaff: async () => { calls.reads += 1; return DIRECTORY(); },
    getCompanyStaffAudit: async () => { calls.reads += 1; return { entries: HISTORY }; },
    inviteCompanyStaff: mutate('inviteCompanyStaff'),
    resendCompanyStaffInvitation: mutate('resendCompanyStaffInvitation'),
    revokeCompanyStaffInvitation: mutate('revokeCompanyStaffInvitation'),
    changeCompanyStaffRole: mutate('changeCompanyStaffRole'),
    suspendCompanyStaff: mutate('suspendCompanyStaff'),
    reactivateCompanyStaff: mutate('reactivateCompanyStaff'),
    removeCompanyStaff: mutate('removeCompanyStaff'),
    setControlRoomAmendmentAuthorisation: mutate('setControlRoomAmendmentAuthorisation'),
    setControlRoomAttendanceAuthorisation: mutate('setControlRoomAttendanceAuthorisation'),
  });
  const { CompanyStaffWorkspace } = load(path.join(ROOT, 'src/components/company/CompanyStaffWorkspace.tsx'));
  return { CompanyStaffWorkspace, calls };
}
async function mountStaff(overrides) {
  const { CompanyStaffWorkspace, calls } = staffSection(overrides);
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyStaffWorkspace)); });
  await flush();
  return { renderer, calls };
}
const modal = (renderer) => renderer.root.findAll((n) => n.type === 'test-modal')[0] || null;

test('SUI-06-STAFF-SECTION-RENDERS-AND-WRITES-NOTHING-ON-LOAD', async () => {
  const { renderer, calls } = await mountStaff();
  const page = text(renderer);
  for (const words of ['Owen Owner', 'Account owner', 'Ava Admin', 'Cal Control', 'Sue Suspended', 'Suspended', 'Never signed in',
    'Control Room permissions', 'Shift extensions: Off', 'Attendance management: On', 'pending@example.invalid', 'Expired',
    "Owen Owner suspended Sue Suspended's access", 'Owen Owner switched attendance management on for Cal Control']) {
    assert.ok(page.includes(words), `shows "${words}"`);
  }
  assert.ok(!page.includes('Rex Removed'), 'removed staff are folded away');
  assert.deepEqual(calls.mutations, [], 'nothing is written on load');
  assert.equal(calls.reads, 2);
  for (const action of ['Change role for', 'Suspend', 'Remove', 'Reactivate']) {
    assert.equal(byLabel(renderer, `${action} Owen Owner`).length, 0, `the account holder has no ${action}`);
  }
  assert.equal(byLabel(renderer, 'Withdraw invitation to boss@example.invalid').length, 0, 'no action on an invitation this viewer cannot manage');
  await press(renderer, 'Show removed staff (1)');
  assert.ok(text(renderer).includes('Rex Removed'));
  assert.deepEqual(calls.mutations, []);
  await act(async () => { renderer.unmount(); });
});

test('SUI-07-INVITE', async () => {
  const { renderer, calls } = await mountStaff({ inviteCompanyStaff: async () => ({ invitation: {}, emailSent: true }) });
  await press(renderer, 'Send invitation');
  assert.match(text(renderer), /Enter the email address/);
  await act(async () => { inputLabelled(renderer, 'Invite email').props.onChangeText('  new.person@example.invalid '); });
  await press(renderer, 'Send invitation');
  assert.match(text(renderer), /Choose a role/);
  assert.deepEqual(calls.mutations, [], 'nothing sent until valid');
  await pressLabel(renderer, 'Invite role Control Room');
  assert.match(text(renderer), /Extensions and attendance only when you switch them on/);
  await press(renderer, 'Send invitation');
  assert.deepEqual(calls.mutations, [['inviteCompanyStaff', 'new.person@example.invalid', 'control_room']], 'exactly one request');
  assert.match(text(renderer), /Invitation sent to new.person@example.invalid/);
  assert.equal(calls.reads, 4, 'the list and history are re-read');
});

test('SUI-08-SUSPEND-NEEDS-CONFIRMATION', async () => {
  const { renderer, calls } = await mountStaff();
  await pressLabel(renderer, 'Suspend Ava Admin');
  assert.ok(modal(renderer), 'a confirmation opens');
  assert.match(text(renderer), /Suspend Ava Admin\?/);
  assert.match(text(renderer), /signed out of the S4 app on every device/);
  assert.deepEqual(calls.mutations, []);
  await press(renderer, 'Cancel');
  assert.equal(modal(renderer), null);
  assert.deepEqual(calls.mutations, [], 'Cancel sends nothing');
  await pressLabel(renderer, 'Suspend Ava Admin');
  await pressLabel(renderer, 'Suspend access');
  assert.deepEqual(calls.mutations, [['suspendCompanyStaff', 2]], 'exactly one request');
  assert.match(text(renderer), /Ava Admin has been suspended/);
});

test('SUI-09-REMOVE-AND-WITHDRAW-NEED-CONFIRMATION', async () => {
  const { renderer, calls } = await mountStaff();
  await pressLabel(renderer, 'Remove Cal Control');
  assert.match(text(renderer), /invite them again/);
  await pressLabel(renderer, 'Remove from company');
  assert.deepEqual(calls.mutations, [['removeCompanyStaff', 3]]);
  await pressLabel(renderer, 'Withdraw invitation to pending@example.invalid');
  assert.match(text(renderer), /will stop working/);
  await pressLabel(renderer, 'Withdraw invitation');
  assert.deepEqual(calls.mutations, [['removeCompanyStaff', 3], ['revokeCompanyStaffInvitation', 11]]);
});

test('SUI-10-CHANGE-ROLE', async () => {
  const { renderer, calls } = await mountStaff();
  await pressLabel(renderer, 'Change role for Cal Control');
  await pressLabel(renderer, 'Cal Control role Viewer');
  await pressLabel(renderer, 'Save role for Cal Control');
  assert.match(text(renderer), /Cal Control will become Viewer/);
  assert.match(text(renderer), /Control Room permissions are switched off/);
  assert.deepEqual(calls.mutations, [], 'not before confirmation');
  await pressLabel(renderer, 'Change role');
  assert.deepEqual(calls.mutations, [['changeCompanyStaffRole', 3, 'viewer']]);
});

test('SUI-11-CONTROL-ROOM-GRANTS-USE-THE-EXISTING-ENDPOINTS', async () => {
  const { renderer, calls } = await mountStaff();
  await pressLabel(renderer, 'Shift extensions for Cal Control');
  await pressLabel(renderer, 'Attendance management for Cal Control');
  assert.deepEqual(calls.mutations, [
    ['setControlRoomAmendmentAuthorisation', 3, true],
    ['setControlRoomAttendanceAuthorisation', 3, false],
  ]);
  const src = read('src/components/company/CompanyStaffWorkspace.tsx');
  assert.ok(!/fetch\(|\/company-staff\/.*grant/.test(src), 'no new grant route');
});

test('SUI-12-REACTIVATE-AND-RESEND', async () => {
  const { renderer, calls } = await mountStaff({ resendCompanyStaffInvitation: async () => ({ invitation: {}, emailSent: true }) });
  await pressLabel(renderer, 'Reactivate Sue Suspended');
  await pressLabel(renderer, 'Re-send invitation to pending@example.invalid');
  assert.deepEqual(calls.mutations, [['reactivateCompanyStaff', 4], ['resendCompanyStaffInvitation', 11]]);
});

test('SUI-13-A-REFUSAL-IS-SHOWN-IN-WORDS', async () => {
  const { renderer, calls } = await mountStaff({
    suspendCompanyStaff: async () => { throw new ApiError(403, { message: 'Only an Owner can change, suspend or remove an Owner or Admin.' }); },
  });
  await pressLabel(renderer, 'Suspend Ava Admin');
  await pressLabel(renderer, 'Suspend access');
  assert.equal(calls.mutations.length, 1);
  assert.match(text(renderer), /Only an Owner can change, suspend or remove an Owner or Admin/);
});

// ═══ wiring ═══
test('SUI-14-DASHBOARD-WIRING', () => {
  const screen = read('src/screens/CompanyDashboardScreen.tsx');
  assert.ok(screen.includes("{ id: 'staff', label: 'Staff'"), 'a Staff nav item');
  assert.ok(/itemIds: \[[^\]]*'audit', 'staff'/.test(screen), 'in the Management group');
  assert.ok(screen.includes('canManageStaffFromSession(user?.companyPermissions, user?.role)'), 'gated on staff.manage');
  assert.ok(screen.includes("(id !== 'staff' || canManageStaff)"), 'hidden from everyone else');
  assert.ok(screen.includes("case 'staff':\n        return canManageStaff ? <CompanyStaffWorkspace /> : null;"), 'and never rendered without it');
});

test('SUI-15-RELEASE-WIRING', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:company-staff-ui'], 'node scripts/company-staff-ui.spec.cjs');
  const workflow = read('../.github/workflows/s4-mobile-release-gate.yml');
  assert.ok(workflow.includes('run: npm run test:company-staff-ui'), 'in the mobile release gate');
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/accept-invitation' && r.destination === '/index.html'), 'the link page is served');
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ', name);
    } catch (error) {
      console.error('FAIL ', name);
      console.error('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n      ') : error));
      process.exitCode = 1;
    }
  }
  console.log(`\nCOMPANY STAFF UI: ${passed}/${pending.length} PASS`);
  process.exit(process.exitCode || 0);
})();
