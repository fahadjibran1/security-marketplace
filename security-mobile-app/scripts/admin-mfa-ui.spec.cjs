'use strict';

/**
 * Platform Admin two-step verification (authenticator app) on the client.
 *
 *   - the pure rules (src/navigation/admin-mfa.ts) are EXECUTED: response recognition, code tidying and validation,
 *     setup-key grouping, the QR matrix (qrcode-generator, already a dependency) and the error wording;
 *   - the REAL api.ts runs against a scripted fetch: a password sign-in that needs a code holds NO token, the code step
 *     adopts the session, a refused code never triggers a renewal or a sign-out, the enrolment token is sent as the
 *     bearer only on the enrolment routes, and confirming persists the fresh renewable session;
 *   - the screens are wired (source checks): the sign-in code step, the forced enrolment step, the admin
 *     "Account security" page, and no secret / token ever reaches logs or storage from these files.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadModule(relativePath) {
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { exports: mod.exports, module: mod, require });
  return mod.exports;
}

function loadApi() {
  const compiled = ts.transpileModule(read('src/services/api.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [];
  let router = () => ({ status: 500, body: { message: 'no route' } });
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const spec = await router(url, init);
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: spec.status === 401 ? 'Unauthorized' : 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(spec.body ?? null),
      json: async () => spec.body ?? null,
    };
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: mod.exports,
    module: mod,
    require: (id) => {
      if (id === 'expo-constants') return { default: { expoConfig: { extra: { apiBaseUrl: 'https://test.example' } } } };
      if (id.endsWith('api-base-url')) return { resolveApiBaseUrl: () => 'https://test.example', isUatBuild: () => false, resolveUatApiBaseUrl: () => ({ ok: false, reason: 'spec' }) };
      if (id.endsWith('models')) return {};
      return require(id);
    },
    process, console, Error, TypeError, Promise, JSON, Array, Object, AbortController, setTimeout, clearTimeout,
    fetch: fetchStub,
    Headers: class Headers {
      constructor(init) { this._h = {}; if (init) for (const k of Object.keys(init)) this._h[k.toLowerCase()] = init[k]; }
      has(k) { return k.toLowerCase() in this._h; }
      set(k, v) { this._h[k.toLowerCase()] = v; }
      get(k) { return this._h[k.toLowerCase()]; }
    },
  });
  return { api: mod.exports, calls, setRouter: (r) => { router = r; } };
}

let passed = 0;
async function test(id, fn) { await fn(); passed += 1; console.log(`PASS  ${id}`); }

(async () => {
  const M = loadModule('src/navigation/admin-mfa.ts');
  const admin = { id: 1, email: 'admin@example.invalid', role: 'admin', status: 'active' };
  const challenge = { mfaRequired: true, method: 'totp', challengeToken: 'challenge-token-value', challengeExpiresAt: '2026-11-24T10:05:00.000Z' };
  const enrolment = { mfaEnrollmentRequired: true, enrollmentToken: 'enrolment-token-value', enrollmentExpiresAt: '2026-11-24T10:15:00.000Z' };

  await test('MFA-UI-01 recognises only the backend second-step responses', () => {
    assert.equal(M.isAdminMfaChallenge(challenge), true);
    assert.equal(M.isAdminMfaEnrollmentRequired(enrolment), true);
    assert.equal(M.isAdminMfaChallenge(enrolment), false);
    assert.equal(M.isAdminMfaEnrollmentRequired(challenge), false);
    for (const other of [null, undefined, 'x', { accessToken: 'a', user: admin }, { mfaRequired: true }, { mfaRequired: 'true', challengeToken: 't' }, { mfaEnrollmentRequired: true, enrollmentToken: '' }]) {
      assert.equal(M.isAdminMfaChallenge(other), false);
      assert.equal(M.isAdminMfaEnrollmentRequired(other), false);
    }
  });

  await test('MFA-UI-02 code tidying and validation', () => {
    assert.equal(M.normaliseTotpCode(' 123 456 '), '123456');
    assert.equal(M.normaliseTotpCode('123-456'), '123456');
    assert.equal(M.totpCodeError('123 456'), null);
    assert.match(M.totpCodeError(''), /Enter the 6-digit code/);
    for (const bad of ['12345', '1234567', '12a456', 'abcdef']) assert.match(M.totpCodeError(bad), /6 digits/);
  });

  await test('MFA-UI-03 setup key grouping and QR matrix', () => {
    assert.equal(M.formatTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    const uri = 'otpauth://totp/S4:admin%40example.invalid?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=S4&algorithm=SHA1&digits=6&period=30';
    const matrix = M.otpauthQrMatrix(uri);
    assert.ok(Array.isArray(matrix) && matrix.length >= 21 && (matrix.length - 17) % 4 === 0, 'a valid QR size');
    assert.ok(matrix.every((row) => row.length === matrix.length && row.every((cell) => typeof cell === 'boolean')));
    assert.equal(matrix[0][0], true, 'finder pattern corner is dark');
    for (const refused of ['https://example.invalid', 'otpauth://hotp/S4:x?secret=A', '', null, `otpauth://totp/${'a'.repeat(600)}`]) {
      assert.equal(M.otpauthQrMatrix(refused), null, String(refused).slice(0, 30));
    }
  });

  await test('MFA-UI-04 error wording follows the backend code', () => {
    assert.match(M.adminMfaErrorMessage({ code: 'MFA_CODE_INVALID', message: 'x' }, 'f'), /not valid/);
    assert.match(M.adminMfaErrorMessage({ code: 'MFA_CHALLENGE_INVALID' }, 'f'), /expired.*Sign in again/);
    assert.match(M.adminMfaErrorMessage({ code: 'MFA_ENROLMENT_NOT_STARTED' }, 'f'), /Setup has expired/);
    assert.equal(M.adminMfaErrorMessage({ message: 'Too many attempts' }, 'f'), 'Too many attempts');
    assert.equal(M.adminMfaErrorMessage(null, 'fallback'), 'fallback');
  });

  await test('MFA-UI-05 a password sign-in that needs a code holds no session', async () => {
    const { api, calls, setRouter } = loadApi();
    setRouter(() => ({ status: 201, body: challenge }));
    const result = await api.login(admin.email, 'pw');
    assert.deepEqual(plain(result), challenge, 'the challenge is returned as-is');
    assert.equal(api.getRefreshToken(), null, 'no refresh token');
    setRouter(() => ({ status: 201, body: enrolment }));
    assert.deepEqual(plain(await api.login(admin.email, 'pw')), enrolment);
    assert.equal(api.getRefreshToken(), null);
    setRouter(() => ({ status: 200, body: [] }));
    await api.listCompanies();
    assert.equal(calls.at(-1).init.headers.get('authorization'), undefined, 'nothing is sent as a bearer afterwards');
  });

  await test('MFA-UI-06 the code step adopts the session; a refused code never renews or signs out', async () => {
    const { api, calls, setRouter } = loadApi();
    let signOuts = 0;
    api.setUnauthorizedHandler(async () => { signOuts += 1; });
    setRouter((url) => (url.endsWith('/auth/login') ? { status: 201, body: challenge } : { status: 401, body: { code: 'MFA_CODE_INVALID', message: 'no' } }));
    await api.login(admin.email, 'pw');
    await assert.rejects(api.verifyAdminMfa(challenge.challengeToken, '000000'), (e) => e.status === 401);
    assert.equal(signOuts, 0, 'a wrong code is not a session ending');
    assert.equal(calls.filter((c) => c.url.endsWith('/auth/refresh')).length, 0, 'no renewal attempt');
    const sent = calls.at(-1);
    assert.equal(sent.init.headers.get('authorization'), undefined, 'the challenge travels in the body, never as a bearer');
    assert.deepEqual(JSON.parse(sent.init.body), { challengeToken: challenge.challengeToken, code: '000000' });
    assert.equal(sent.init.headers.get('x-s4-client'), 'mobile');

    setRouter(() => ({ status: 201, body: { accessToken: 'a-mfa', refreshToken: 'r-mfa', user: admin } }));
    const session = await api.verifyAdminMfa(challenge.challengeToken, '123456');
    assert.equal(session.accessToken, 'a-mfa');
    assert.equal(session.refreshToken, 'r-mfa');
    assert.equal(api.getRefreshToken(), 'r-mfa');
    setRouter(() => ({ status: 200, body: [] }));
    await api.listCompanies();
    assert.equal(calls.at(-1).init.headers.get('authorization'), 'Bearer a-mfa', 'later calls use the two-step session');
  });

  await test('MFA-UI-07 the enrolment token is the bearer only on the enrolment routes', async () => {
    const { api, calls, setRouter } = loadApi();
    let persisted = 0;
    api.setRefreshPersister(async () => { persisted += 1; });
    setRouter((url) => {
      if (url.endsWith('/auth/mfa/status')) return { status: 200, body: { enrolled: false, enabledAt: null, pending: false, required: true, method: 'totp' } };
      if (url.endsWith('/auth/mfa/totp/enrol')) return { status: 200, body: { method: 'totp', secret: 'S', otpauthUri: 'otpauth://totp/S4:a?secret=S' } };
      if (url.endsWith('/auth/mfa/totp/confirm')) return { status: 201, body: { accessToken: 'a-new', refreshToken: 'r-new', user: admin } };
      return { status: 500, body: {} };
    });
    await api.getAdminMfaStatus(enrolment.enrollmentToken);
    await api.startAdminMfaEnrolment(enrolment.enrollmentToken);
    const s = await api.confirmAdminMfaEnrolment('123456', enrolment.enrollmentToken);
    for (const c of calls) assert.equal(c.init.headers.get('authorization'), `Bearer ${enrolment.enrollmentToken}`, c.url);
    assert.equal(s.accessToken, 'a-new');
    assert.equal(api.getRefreshToken(), 'r-new');
    assert.equal(persisted, 0, 'sign-in persists through the normal onLoggedIn path');
  });

  await test('MFA-UI-08 a signed-in admin enrols with the session; confirming persists the fresh session', async () => {
    const { api, calls, setRouter } = loadApi();
    api.restoreSession({ accessToken: 'a-old', refreshToken: 'r-old' });
    const persistedWith = [];
    api.setRefreshPersister(async (v) => { persistedWith.push(v.refreshToken); });
    setRouter((url) => (url.endsWith('/auth/mfa/totp/confirm')
      ? { status: 201, body: { accessToken: 'a-new', refreshToken: 'r-new', user: admin } }
      : url.endsWith('/auth/mfa/totp/disable') ? { status: 403, body: { code: 'MFA_CODE_INVALID' } }
        : { status: 200, body: {} }));
    await api.startAdminMfaEnrolment();
    assert.equal(calls.at(-1).init.headers.get('authorization'), 'Bearer a-old');
    await api.confirmAdminMfaEnrolment('123456');
    assert.deepEqual(persistedWith, ['r-new'], 'the old refresh token is dead server-side; the new one is stored at once');
    assert.equal(api.getRefreshToken(), 'r-new');
    await assert.rejects(api.disableAdminMfa('000000'), (e) => e.status === 403);
    assert.equal(calls.at(-1).init.headers.get('authorization'), 'Bearer a-new');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { code: '000000' });
  });

  await test('MFA-UI-09 screens are wired', () => {
    const auth = read('src/screens/AuthScreen.tsx');
    assert.match(auth, /isAdminMfaChallenge\(session\) \|\| isAdminMfaEnrollmentRequired\(session\)/, 'login recognises the second step');
    assert.match(auth, /testID="admin-mfa-code-step"/);
    assert.match(auth, /verifyAdminMfa\(secondStep\.challengeToken, normaliseTotpCode\(mfaCode\)\)/);
    assert.match(auth, /testID="admin-mfa-enrolment-step"[\s\S]*<AdminMfaEnrolment[\s\S]*enrollmentToken=\{secondStep\.enrollmentToken\}/);
    assert.match(auth, /setPassword\(''\);\s*setMfaCode\(''\);\s*setSecondStep\(session\)/, 'the password is cleared once it has been accepted');
    const nav = loadModule('src/navigation/admin-portal.ts');
    const item = nav.ADMIN_NAV_ITEMS.find((entry) => entry.key === 'security');
    assert.ok(item, 'Account security is navigable');
    assert.equal(item.label, 'Account security');
    const dash = read('src/screens/AdminDashboardScreen.tsx');
    assert.match(dash, /section === 'security' \? <AdminSecurityPanel \/>/);
    const panel = read('src/components/admin/AdminSecurityPanel.tsx');
    assert.match(panel, /disableAdminMfa\(normaliseTotpCode\(code\)\)/, 'turning it off needs a current code');
    assert.match(panel, /status\.required \?/, 'no turn-off button while S4 requires it');
    const enrol = read('src/components/admin/AdminMfaEnrolment.tsx');
    assert.match(enrol, /<AdminMfaQr uri=\{setup\.otpauthUri\}/);
    assert.match(enrol, /setSetup\(null\); \/\/ the secret leaves the screen/);
  });

  await test('MFA-UI-10 no secret, code or token is logged or stored by these files', () => {
    for (const file of ['src/navigation/admin-mfa.ts', 'src/components/admin/AdminMfaEnrolment.tsx', 'src/components/admin/AdminSecurityPanel.tsx', 'src/components/admin/AdminMfaQr.tsx', 'src/screens/AuthScreen.tsx']) {
      const source = read(file);
      assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, `${file} logs nothing`);
      assert.doesNotMatch(source, /AsyncStorage|SecureStore|localStorage|sessionStorage/, `${file} stores nothing`);
    }
  });

  console.log(JSON.stringify({ event: 'admin_mfa_ui_tests_passed', tests: passed }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
