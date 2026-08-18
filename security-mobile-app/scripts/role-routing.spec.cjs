const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'navigation', 'role-routing.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const moduleState = { exports: {} };
vm.runInNewContext(output, { exports: moduleState.exports, module: moduleState, require });
const { ADMIN_DASHBOARD_ENDPOINTS, getAppSurface, parseStoredSession, serializeStoredSession } = moduleState.exports;

assert.equal(getAppSurface('admin'), 'admin');
assert.equal(getAppSurface('company'), 'company');
assert.equal(getAppSurface('company_admin'), 'company');
assert.equal(getAppSurface('company_staff'), 'company');
assert.equal(getAppSurface('guard'), 'guard');
assert.equal(getAppSurface('client_admin'), 'client');
assert.equal(getAppSurface('client_viewer'), 'client');
assert.equal(getAppSurface('unknown'), 'denied');
assert.equal(getAppSurface(undefined), 'denied');

const authenticatedAdmin = { accessToken: 'server-issued-token', user: { id: 1, email: 'admin@example.test', role: 'admin' } };
const selectedLoginPortal = 'guard';
assert.equal(getAppSurface(authenticatedAdmin.user.role), 'admin', `server role must override selected ${selectedLoginPortal} login portal`);
assert.equal(parseStoredSession(serializeStoredSession(authenticatedAdmin)).user.role, 'admin');
assert.equal(parseStoredSession(JSON.stringify(authenticatedAdmin)), null, 'pre-RC1 unversioned session must be discarded');
assert.equal(parseStoredSession(JSON.stringify({ version: 2, session: { ...authenticatedAdmin, user: { ...authenticatedAdmin.user, role: 'invalid' } } })), null);
assert.ok(ADMIN_DASHBOARD_ENDPOINTS.every((endpoint) => !endpoint.includes('/mine')));

const appSource = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'AdminDashboardScreen.tsx'), 'utf8');
const companySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'CompanyDashboardScreen.tsx'), 'utf8');
assert.match(appSource, /surface === 'admin'[\s\S]*<AdminDashboardScreen/);
assert.match(appSource, /surface === 'guard'[\s\S]*<GuardDashboardScreen/);
assert.doesNotMatch(adminSource, /listMy|getMy|['"`]\/[^'"`]*mine/);
assert.doesNotMatch(companySource, /listMy|getMy|['"`]\/[^'"`]*mine/);

console.log(JSON.stringify({ event: 'dashboard_role_routing_tests_passed', tests: 18 }));
