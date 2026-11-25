#!/usr/bin/env node
/**
 * Company Team (staff management) — the web portal's Team section and the /join-company accept page.
 *
 * Executes the real modules: the pure team model, the emailed-link parser, the REAL api.ts against a scripted fetch
 * (so every request's shape is proven, including that the invitation token travels in a body and never a URL), and
 * renders the Team workspace and the accept screen with the real reconciler (the overlay modal is replaced by a plain
 * container so it renders in Node).
 *
 *   TEAM-UI-01  roles: owner is never offered; every grantable role has a one-line description; Emergency roles marked
 *   TEAM-UI-02  Team appears only with staff.manage (legacy owner roles only when the session has no list)
 *   TEAM-UI-03  the invite form needs an email and a role the API says the person may grant
 *   TEAM-UI-04  request shapes: list, invite, cancel, change role, revoke, accept; no token in any URL
 *   TEAM-UI-05  /join-company is recognised and its token stripped from the address bar
 *   TEAM-UI-06  the Team workspace lists members and invitations, says who receives Emergency alerts, invites with a
 *               chosen role, and revokes only after confirmation
 *   TEAM-UI-07  the accept screen asks for name and password, never shows the token, and refuses a dead link
 *   TEAM-UI-08  wiring: the company navigation, App routing and the Vercel rewrite for /join-company
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
const team = loadTs('src/components/company/companyTeam.ts');
const links = loadTs('src/components/account/accountLinks.ts');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);
const TOKEN = 'U3RhZmZpbnZpdGF0aW9udG9rZW4tbG9uZy1lbm91Z2gtOTg3NjU0';

// ── the real api.ts against a scripted fetch (same harness as account-lifecycle-ui.spec.cjs) ──────────
function loadApi(router) {
  const compiled = ts.transpileModule(read('src/services/api.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await router(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: 'X',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null),
      json: async () => spec.body ?? null,
    };
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports, module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://api.test' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://api.test', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'spec' }) };
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

// ── component loader: real modules, the api module and the overlay modal replaced ─────────────────────
const ModalStub = ({ visible, title, subtitle, children, footer }) =>
  (visible ? h('section', { 'data-modal': title }, h('h2', null, title), subtitle ? h('p', null, subtitle) : null, children, footer) : null);
const ConfirmStub = ({ visible, title, message, confirmLabel = 'Confirm', onConfirm, onClose }) =>
  (visible ? h('section', { 'data-confirm': title },
    h('h2', null, title), h('p', null, message),
    h('button', { onPress: onConfirm }, confirmLabel), h('button', { onPress: onClose }, 'Cancel')) : null);

function loadPanel(apiOverrides) {
  const cache = new Map();
  const load = (absolutePath) => {
    const key = path.relative(ROOT, absolutePath).replace(/\\/g, '/').replace(/\.tsx?$/, '');
    if (key === 'src/services/api') return apiOverrides;
    if (key === 'src/components/ui/Modal') return { AppModal: ModalStub };
    if (key === 'src/components/ui/ConfirmationDialog') return { ConfirmationDialog: ConfirmStub };
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
const press = async (renderer, label, index = 0) => {
  const targets = renderer.root.findAll((n) => typeof n.props.onPress === 'function' &&
    n.findAll((c) => c.children && c.children.filter((x) => typeof x === 'string').join('').includes(label)).length > 0);
  // The innermost matching control (a stub <button> or the Pressable itself).
  const target = targets.filter((t) => !targets.some((o) => o !== t && t.findAll((x) => x === o).length > 0))[index];
  assert.ok(target, `control "${label}"`);
  await act(async () => { await target.props.onPress(); });
};
const formatApiErrorMessage = (_e, fallback) => fallback;

// ═══════════════════════════════════════════════════════════════════════════════════════════════════

test('TEAM-UI-01-ROLES-DESCRIPTIONS-AND-EMERGENCY-MARKING', () => {
  const all = ['owner', 'admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'];
  const opts = team.roleOptions(all);
  assert.deepEqual(opts.map((o) => o.value), ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'], 'owner is never offered');
  for (const o of opts) {
    assert.ok(o.description.length > 20 && !o.description.includes('\n'), `${o.value}: one-line description`);
    assert.ok(o.label && o.label !== o.value, `${o.value}: human label`);
  }
  assert.deepEqual(opts.filter((o) => o.emergency).map((o) => o.value), ['admin', 'operations', 'control_room'], 'the alerts.manage roles');
  assert.equal(team.receivesEmergencyAlerts('owner'), true);
  assert.match(team.EMERGENCY_ALERT_NOTE, /Control Room/);
  assert.match(team.EMERGENCY_ALERT_NOTE, /HR \/ Compliance, Finance and Viewer do not/);
  assert.deepEqual(team.roleOptions(null), []);
  assert.equal(team.roleLabel('control_room'), 'Control Room');
});

test('TEAM-UI-02-TEAM-NEEDS-STAFF-MANAGE', () => {
  assert.equal(team.canManageTeam(['staff.manage', 'sites.view'], 'company_staff'), true);
  assert.equal(team.canManageTeam(['alerts.manage'], 'company_staff'), false, 'Control Room');
  assert.equal(team.canManageTeam([], 'company_admin'), false, 'an explicit empty list wins');
  assert.equal(team.canManageTeam(undefined, 'company_admin'), true, 'legacy owner session');
  assert.equal(team.canManageTeam(undefined, 'company_staff'), false);
});

test('TEAM-UI-03-INVITE-VALIDATION', () => {
  const grantable = ['operations', 'control_room'];
  assert.match(team.validateInvite('nope', 'operations', grantable), /email address/);
  assert.match(team.validateInvite('a@b.co', null, grantable), /Choose a role/);
  assert.match(team.validateInvite('a@b.co', 'admin', grantable), /cannot give/);
  assert.equal(team.validateInvite('  a@b.co ', 'control_room', grantable), null);
});

test('TEAM-UI-04-REQUEST-SHAPES', async () => {
  const { api, calls } = loadApi(() => ({ status: 200, body: { message: 'ok' } }));
  await api.getCompanyTeam();
  await api.inviteCompanyStaff('  new@example.invalid ', 'control_room');
  await api.cancelCompanyStaffInvitation(7);
  await api.changeCompanyStaffRole(12, 'viewer');
  await api.revokeCompanyStaffAccess(12);
  await api.acceptCompanyStaffInvitation(TOKEN, ' Casey ', ' Control ', 'Secret-pass-1');
  const shape = calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url.replace('https://api.test', '')}`);
  assert.deepEqual(shape, [
    'GET /company-staff',
    'POST /company-staff/invitations',
    'POST /company-staff/invitations/7/cancel',
    'PATCH /company-staff/members/12/role',
    'POST /company-staff/members/12/revoke',
    'POST /company-staff-invitations/accept',
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { email: 'new@example.invalid', role: 'control_room' });
  assert.deepEqual(JSON.parse(calls[3].init.body), { role: 'viewer' });
  assert.deepEqual(JSON.parse(calls[5].init.body), { token: TOKEN, firstName: 'Casey', lastName: 'Control', password: 'Secret-pass-1' });
  assert.ok(calls.every((c) => !c.url.includes(TOKEN)), 'no token in any URL');
});

test('TEAM-UI-05-JOIN-COMPANY-LINK', () => {
  assert.deepEqual(links.parseAccountLink('/join-company', `?token=${TOKEN}`), { kind: 'join-company', token: TOKEN });
  assert.deepEqual(links.parseAccountLink('/join-company/', ''), { kind: 'join-company', token: null });
  const replaced = [];
  const link = links.takeAccountLink({ pathname: '/join-company', search: `?token=${TOKEN}` }, { replaceState: (_s, _t, url) => replaced.push(url) });
  assert.equal(link.token, TOKEN);
  assert.deepEqual(replaced, ['/join-company'], 'the token leaves the address bar at once');
});

const TEAM = {
  yourRole: 'owner',
  grantableRoles: ['admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'],
  members: [
    { userId: 1, name: 'Olive Owner', email: 'owner@example.invalid', role: 'owner', status: 'active', joinedAt: '2026-01-02T00:00:00Z', isYou: true, receivesEmergencyAlerts: true, manageable: false },
    { userId: 5, name: 'Casey Control', email: 'casey@example.invalid', role: 'control_room', status: 'active', joinedAt: '2026-11-01T00:00:00Z', isYou: false, receivesEmergencyAlerts: true, manageable: true },
    { userId: 6, name: 'Fin Ance', email: 'fin@example.invalid', role: 'finance', status: 'suspended', joinedAt: null, isYou: false, receivesEmergencyAlerts: false, manageable: true },
  ],
  invitations: [{ id: 9, email: 'waiting@example.invalid', role: 'viewer', state: 'PENDING', createdAt: '2026-11-20T00:00:00Z', expiresAt: '2026-11-27T00:00:00Z' }],
};

test('TEAM-UI-06-TEAM-WORKSPACE', async () => {
  const calls = [];
  const load = loadPanel({
    formatApiErrorMessage,
    getCompanyTeam: async () => { calls.push(['list']); return TEAM; },
    inviteCompanyStaff: async (email, role) => { calls.push(['invite', email, role]); return { invitation: { email: email.trim().toLowerCase() }, emailSent: true }; },
    cancelCompanyStaffInvitation: async (id) => { calls.push(['cancel', id]); return {}; },
    changeCompanyStaffRole: async (id, role) => { calls.push(['role', id, role]); return {}; },
    revokeCompanyStaffAccess: async (id) => { calls.push(['revoke', id]); return {}; },
  });
  const { CompanyTeamWorkspace } = load(path.join(ROOT, 'src/components/company/CompanyTeamWorkspace.tsx'));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(CompanyTeamWorkspace)); });
  const t = text(renderer);
  for (const s of ['Olive Owner (you)', 'casey@example.invalid', 'Control Room · Emergency alerts', 'Access revoked', 'waiting@example.invalid', 'Waiting']) {
    assert.ok(t.includes(s), `shows "${s}"`);
  }
  assert.match(t, /HR \/ Compliance, Finance and Viewer do not/, 'says who receives Emergency alerts');
  const revokeButtons = renderer.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.label === 'Revoke');
  assert.equal(revokeButtons.length, 1, 'only the active, manageable member can be revoked (not the owner, not a revoked member)');

  // Invite: the form refuses until valid, then sends the chosen role.
  await press(renderer, 'Invite team member');
  assert.match(text(renderer), /Invite a team member/);
  assert.match(text(renderer), /Control Room\s*·\s*receives Emergency alerts/);
  await press(renderer, 'Send invitation');
  assert.match(text(renderer), /Enter the email address/);
  const emailInput = renderer.root.findAll((n) => n.type === 'input' && n.props.accessibilityLabel === 'Email address')[0];
  await act(async () => { emailInput.props.onChangeText('New.Person@example.invalid'); });
  await act(async () => { renderer.root.findAll((n) => n.props.testID === 'team-role-control_room' && typeof n.props.onPress === 'function')[0].props.onPress(); });
  await press(renderer, 'Send invitation');
  assert.deepEqual(calls.find((c) => c[0] === 'invite'), ['invite', 'New.Person@example.invalid', 'control_room']);
  assert.match(text(renderer), /Invitation sent to new\.person@example\.invalid/);

  // Revoke needs confirmation.
  await act(async () => { revokeButtons[0].props.onPress(); });
  assert.ok(!calls.some((c) => c[0] === 'revoke'), 'nothing happens before confirmation');
  assert.match(text(renderer), /Revoke Casey Control's access\?/);
  assert.match(text(renderer), /lose access to your company at once, and a team account will be signed out of S4 on every device/);
  await press(renderer, 'Revoke access');
  assert.deepEqual(calls.find((c) => c[0] === 'revoke'), ['revoke', 5]);

  // Cancel an invitation, also confirmed.
  await press(renderer, 'Cancel invitation');
  assert.match(text(renderer), /will stop working immediately/);
  assert.ok(!calls.some((c) => c[0] === 'cancel'), 'nothing happens before confirmation');
  // The row's button comes first; the dialog's confirm button (same words) is rendered after the tables.
  await press(renderer, 'Cancel invitation', 1);
  assert.deepEqual(calls.find((c) => c[0] === 'cancel'), ['cancel', 9]);
});

test('TEAM-UI-07-ACCEPT-SCREEN', async () => {
  const accepted = [];
  let reply = async () => ({ accepted: true, message: 'You have joined Alpha Ltd on S4. Sign in with casey@example.invalid and the password you just chose.' });
  const load = loadPanel({
    formatApiErrorMessage: (e, fallback) => (e && e.serverMessage) || fallback,
    ApiError: class ApiError extends Error {},
    acceptCompanyStaffInvitation: async (...args) => { accepted.push(args); return reply(); },
  });
  const { StaffInvitationScreen, INVALID_INVITATION } = load(path.join(ROOT, 'src/screens/StaffInvitationScreen.tsx'));

  let renderer;
  await act(async () => { renderer = TestRenderer.create(h(StaffInvitationScreen, { link: { kind: 'join-company', token: null }, onDone: () => undefined })); });
  assert.ok(text(renderer).includes(INVALID_INVITATION), 'a link without a token is refused up front');

  let done = 0;
  await act(async () => { renderer = TestRenderer.create(h(StaffInvitationScreen, { link: { kind: 'join-company', token: TOKEN }, onDone: () => { done += 1; } })); });
  assert.ok(!JSON.stringify(renderer.toJSON()).includes(TOKEN), 'the token is never rendered');
  const inputs = renderer.root.findAll((n) => n.type === 'input');
  assert.equal(inputs.length, 4, 'first name, last name, password, confirmation');
  const [first, last, pw, confirm] = inputs;
  await press(renderer, 'Accept invitation');
  assert.match(text(renderer), /first and last name/);
  await act(async () => { first.props.onChangeText('Casey'); last.props.onChangeText('Control'); pw.props.onChangeText('Fresh-pass-1'); confirm.props.onChangeText('Fresh-pass-2'); });
  await press(renderer, 'Accept invitation');
  assert.match(text(renderer), /do not match/);
  assert.equal(accepted.length, 0);
  await act(async () => { confirm.props.onChangeText('Fresh-pass-1'); });
  await press(renderer, 'Accept invitation');
  assert.deepEqual(accepted, [[TOKEN, 'Casey', 'Control', 'Fresh-pass-1']]);
  assert.match(text(renderer), /You have joined Alpha Ltd on S4/);
  await press(renderer, 'Go to S4 sign in');
  assert.equal(done, 1);
});

test('TEAM-UI-08-WIRING', () => {
  const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
  assert.match(dashboard, /\{ id: 'team', label: 'Team'/, 'a Team section in company navigation');
  assert.match(dashboard, /'audit', 'team', 'recruitment'/, 'in the Management group');
  assert.match(dashboard, /id !== 'team' \|\| canManageStaff/, 'hidden without staff.manage');
  assert.match(dashboard, /case 'team':\s*return canManageStaff \? <CompanyTeamWorkspace \/> : null;/);
  const app = read('App.tsx');
  assert.match(app, /accountLink\.kind === 'join-company' \? <StaffInvitationScreen/);
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/join-company' && r.destination === '/index.html'));
  const hdr = vercel.headers.find((x) => x.source.includes('join-company'));
  assert.ok(hdr && hdr.headers.some((x) => x.key === 'Referrer-Policy' && x.value === 'no-referrer'), 'no Referer leaks the token');
  assert.ok(hdr.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-store'));
  assert.match(read('src/components/company/CompanySidebar.tsx'), /'team':\s*'user-check'/);
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
  console.log(`\nCOMPANY TEAM UI: ${passed}/${pending.length} PASS`);
})();
