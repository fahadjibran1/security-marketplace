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

const { ADMIN_NAV_ITEMS, adminPortalError, canAccessAdminPortal, matchesAdminSearch } = loadModule('src/navigation/admin-portal.ts');
const { getAppSurface } = loadModule('src/navigation/role-routing.ts');
const keys = ADMIN_NAV_ITEMS.map((item) => item.key);

assert.equal(canAccessAdminPortal('admin'), true);
for (const role of ['company', 'company_admin', 'company_staff', 'guard', 'client_admin', 'client_viewer', 'unknown', undefined]) assert.equal(canAccessAdminPortal(role), false);
assert.equal(getAppSurface('admin'), 'admin');
assert.equal(getAppSurface('unknown'), 'denied');
for (const required of ['overview', 'companies', 'guards', 'sites', 'jobs', 'applications', 'assignments', 'shifts', 'attendance', 'timesheets', 'incidents', 'alerts', 'dailyLogs', 'audit', 'notifications', 'health']) assert.ok(keys.includes(required), `${required} must be navigable`);
assert.ok(ADMIN_NAV_ITEMS.every((item) => item.emptyLabel.length > 10));
assert.match(adminPortalError(403), /Access denied/);
assert.match(adminPortalError(404), /not available/);
assert.doesNotMatch(adminPortalError(500), /password|token|secret/i);
assert.equal(matchesAdminSearch(['Alpha Company', 12], 'alpha'), true);
assert.equal(matchesAdminSearch(['Alpha Company', 12], 'beta'), false);

const screen = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'AdminDashboardScreen.tsx'), 'utf8');
assert.doesNotMatch(screen, /listMy|getMy|['"`]\/[^'"`]*mine/);
assert.doesNotMatch(screen, /beforeData|afterData|fileUrl|passwordHash|accessToken/);
assert.match(screen, /setSection\(item\.key\)/, 'navigation changes section without changing authenticated role');
assert.match(screen, /approveGuard/, 'certified guard approval action remains available');
assert.match(screen, /useWindowDimensions/, 'responsive navigation shell is required');

console.log(JSON.stringify({ event: 'admin_portal_tests_passed', tests: 35 }));
