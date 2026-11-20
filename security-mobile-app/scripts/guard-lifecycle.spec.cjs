const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'navigation', 'guard-lifecycle.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
const moduleState = { exports: {} };
vm.runInNewContext(output, { exports: moduleState.exports, module: moduleState, require });
const { getGuardVettingLabel, getGuardWorkEligibilityLabel, isGuardProfileComplete } = moduleState.exports;

const complete = { fullName: 'Guard', phone: '0700', siaLicenseNumber: 'SIA-1', siaExpiryDate: '2035-01-01', rightToWorkStatus: 'permanent' };
assert.equal(isGuardProfileComplete(complete), true);
assert.equal(isGuardProfileComplete({ ...complete, siaExpiryDate: null }), false);
assert.equal(isGuardProfileComplete({ ...complete, rightToWorkStatus: 'visa', rightToWorkExpiryDate: null }), false);
assert.equal(getGuardVettingLabel(null), 'Not started');
assert.equal(getGuardVettingLabel({ complianceStatus: 'valid', documents: [], blockingReasons: [] }), 'Vetted');
assert.equal(getGuardVettingLabel({ complianceStatus: 'expired', documents: [], blockingReasons: [] }), 'Expired');
assert.equal(getGuardVettingLabel({ complianceStatus: 'invalid', documents: [], blockingReasons: [] }), 'Not started');
const uploaded = ['sia_licence', 'right_to_work'].map((type) => ({ type, uploadCompletedAt: '2026-01-01', verified: false }));
assert.equal(getGuardVettingLabel({ complianceStatus: 'invalid', documents: uploaded, blockingReasons: ['not verified'], siaExpiryDate: '2035-01-01', rightToWorkStatus: 'permanent' }), 'Ready for review');
assert.equal(getGuardWorkEligibilityLabel({ assignable: false }), 'Not eligible');
assert.equal(getGuardWorkEligibilityLabel({ assignable: true }), 'Eligible');

const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'guard', 'GuardCompliancePanel.tsx'), 'utf8');
// UX-02 Package B: the deployment row is labelled "Deployment", and Account access moved from the compliance panel to
// the account card in Privacy & account (the same static "Active" value as before).
assert.match(panel, /label="Deployment" value=\{deployment\}/);
assert.doesNotMatch(panel, /label="Work eligibility"|label="Account access"/);
const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'GuardDashboardScreen.tsx'), 'utf8');
assert.match(dashboard, /accessibilityLabel="Account access: Active" testID="guard-account-access"/);
assert.match(panel, /SIA evidence/);
assert.match(panel, /Right-to-work evidence/);
assert.doesNotMatch(panel, /uploaded.*Vetted|Vetted.*uploaded/i);

console.log(JSON.stringify({ event: 'guard_lifecycle_ui_tests_passed', tests: 15 }));
