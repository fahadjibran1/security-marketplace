/**
 * S4 Guard Profile — Phase 2A (copy and accessibility corrections) and Phase 2B (overview model and foundations).
 *
 *   SCREENING   S4 screening is optional: no mobile source says it is needed to register, use the marketplace, apply,
 *               be employed or be deployed; the screening panel no longer derives "Work eligibility"; the Compliance
 *               panel still shows the backend's real deployment status; and the backend deployment gate really does
 *               not consult screening (so the optional wording is true).
 *   PRIVACY     PRIVACY_COPY (the table the Profile notes are rendered from) matches what the backend in this
 *               repository enforces: routes and roles, membership permissions, ACTIVE relationship, masking, audit
 *               logging. The Profile renders the notes from the table, and the old inaccurate sentences are gone.
 *   A11Y        Every TextInput and Switch on the Profile, and every sensitive-value action (Show / Hide / Edit / Add /
 *               Save / Cancel / Remove), carries an accessibilityLabel — checked on the TypeScript syntax tree.
 *   REVEAL      Reveal timers, the bank reveal confirmation and save behaviour are unchanged.
 *   LABELS      Enum label maps are complete and readable; unknown values fall back safely.
 *   OVERVIEW    The typed overview model: seven sections, requirement labels, loading/error states, attention items,
 *               deployment from `assignable` only, screening always optional.
 *   LAYOUT      Responsive rules on small and large phones and text scales, sharing the Guard Home thresholds;
 *               requirement tag colours reach 4.5:1.
 *
 * Fictional data only. No network, no device.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { loadTs, ROOT } = require('./load-ts.cjs');

const REPO = path.join(ROOT, '..');
// Line endings normalised: the working tree may be CRLF (git autocrlf) or LF (CI).
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n'"`]*$/gm, '$1');

const tests = [];
const test = (name, run) => tests.push({ name, run });

const copy = loadTs('src/components/guard/profile/profileCopy.ts');
const labels = loadTs('src/components/guard/profile/profileLabels.ts');
const overview = loadTs('src/components/guard/profile/profileOverview.ts');
const layoutRules = loadTs('src/components/guard/profile/profileLayout.ts');
const homeLayout = loadTs('src/components/guard/home/guardHomeLayout.ts');
const theme = loadTs('src/components/guard/profile/profileTheme.ts');
const lifecycle = loadTs('src/navigation/guard-lifecycle.ts');

const DASHBOARD = 'src/screens/GuardDashboardScreen.tsx';
const SCREENING_PANEL = 'src/components/guard/GuardScreeningPanel.tsx';
const COMPLIANCE_PANEL = 'src/components/guard/GuardCompliancePanel.tsx';

/** Every .ts/.tsx file under src. */
function sourceFiles(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The Profile tab's JSX: from `activeTab === 'profile'` to the screening sub-view. */
function profileRegion() {
  const src = read(DASHBOARD);
  const start = src.indexOf("{activeTab === 'profile' ? (");
  const end = src.indexOf("{activeTab === 'screening' ? <GuardScreeningJourney");
  assert.ok(start > 0 && end > start, 'the Profile region is found');
  return { src, start, end };
}

// ═══════════════════ SCREENING ═══════════════════

test('SCREENING-01 the copy says S4 screening is optional and separate from company deployment checks', () => {
  const c = copy.SCREENING_COPY;
  assert.match(c.optionalStatement, /^S4 screening is optional\./);
  assert.match(c.optionalStatement, /do not need it to use S4, apply for work or be employed/);
  assert.match(c.separateFromCompanyChecks, /separate from the checks a company makes before deploying you/);
  assert.match(c.deploymentLine, /not by S4 screening/);
  assert.match(c.journeyStartBody, /optional/);
  assert.match(c.eyebrow, /OPTIONAL/);
  for (const [key, text] of Object.entries(c)) {
    for (const pattern of copy.MANDATORY_SCREENING_PATTERNS) assert.doesNotMatch(text, pattern, `SCREENING_COPY.${key}`);
    assert.doesNotMatch(text, /not yet eligible|work eligibility/i, `SCREENING_COPY.${key} makes no eligibility claim`);
  }
});

test('SCREENING-02 no mobile source tells anyone that screening is required (registration, marketplace, employment, deployment)', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of copy.MANDATORY_SCREENING_PATTERNS) {
      if (file.endsWith(path.join('profile', 'profileCopy.ts'))) continue; // the patterns themselves
      if (pattern.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
  // The specific sentences that used to say it are gone.
  const all = sourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const old of [
    'Complete your screening to become eligible',
    'Operational hiring and assignment require completed screening',
    'The candidate must complete screening and authorised verification',
    'YOUR VETTING & SCREENING',
  ]) assert.ok(!all.includes(old), `removed: ${old}`);
});

test('SCREENING-03 the screening panel and journey render the optional copy and derive no work eligibility from screening', () => {
  const panel = stripComments(read(SCREENING_PANEL));
  assert.match(panel, /import \{ SCREENING_COPY \} from "\.\/profile\/profileCopy";/);
  assert.doesNotMatch(panel, /Work eligibility|Not yet eligible|become eligible/);
  for (const key of ['optionalStatement', 'separateFromCompanyChecks', 'marketplaceAccess', 'deploymentLine', 'benefit', 'journeyStartTitle', 'journeyStartBody', 'vettedLine', 'summaryAccessibilityLabel']) {
    assert.match(panel, new RegExp(`SCREENING_COPY\\.${key}\\b`), `renders SCREENING_COPY.${key}`);
  }
  // Two summary surfaces (Profile card, journey header), each with the deployment line instead of an eligibility claim.
  assert.equal(panel.split('SCREENING_COPY.deploymentLine').length - 1, 2);
  // The screening workflow itself is untouched: still started, submitted and withdrawn through the same API calls.
  for (const call of ['startMyScreening()', 'submitMyScreening', 'withdrawMyScreeningConsent', 'acceptMyScreeningConsent']) assert.ok(panel.includes(call), call);
});

test('SCREENING-04 the Compliance panel keeps the real backend deployment status and no longer calls company checks "Vetting"', () => {
  const panel = stripComments(read(COMPLIANCE_PANEL));
  assert.match(panel, /const eligibility = getGuardWorkEligibilityLabel\(summary\);/, 'eligibility still from the backend summary');
  // Phase 2D: each row also takes the compact-layout flag; the values are unchanged.
  assert.match(panel, /<Summary label="Work eligibility" value=\{eligibility\} stacked=\{stacked\} \/>/);
  assert.match(panel, /<Summary label=\{COMPLIANCE_COPY\.checksLabel\} value=\{complianceChecks\} stacked=\{stacked\} \/>/);
  assert.doesNotMatch(panel, /label="Vetting"/);
  assert.match(panel, /COMPLIANCE_COPY\.deploymentNote/);
  // getGuardWorkEligibilityLabel is unchanged: assignable and only assignable.
  assert.equal(lifecycle.getGuardWorkEligibilityLabel({ assignable: true }), 'Eligible');
  assert.equal(lifecycle.getGuardWorkEligibilityLabel({ assignable: false }), 'Not eligible');
  assert.equal(lifecycle.getGuardWorkEligibilityLabel(null), 'Not eligible');
  // The display mapping only renames the screening-like words; every other label passes through.
  assert.equal(copy.complianceChecksDisplayLabel('Vetted'), 'Complete');
  assert.equal(copy.complianceChecksDisplayLabel('Vetted — expires soon'), 'Expiring soon');
  for (const same of ['Not started', 'Expired', 'Ready for review', 'Requires attention', 'In progress']) assert.equal(copy.complianceChecksDisplayLabel(same), same);
  // StatusBadge tone stays meaningful: expiring is a warning, never success green.
  // StatusBadge.tsx imports react-native, so only its pure tone function is executed here.
  const badge = read('src/components/StatusBadge.tsx').replace(/\r\n/g, '\n');
  const fnStart = badge.indexOf('export function inferStatusTone(');
  const fnSource = badge.slice(fnStart, badge.indexOf('\n}\n', fnStart) + 3).replace('export ', '');
  const js = ts.transpileModule(`${fnSource}\nmodule.exports = inferStatusTone;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const fnModule = { exports: {} };
  new Function('module', js)(fnModule);
  const inferStatusTone = fnModule.exports;
  assert.equal(inferStatusTone('Complete'), 'success');
  assert.equal(inferStatusTone('Expiring soon'), 'warning');
});

test('SCREENING-05 backend evidence: the deployment gate does not consult S4 screening, so "optional" is true', () => {
  const service = readRepo('security-backend-nest/src/compliance/compliance.service.ts');
  const start = service.indexOf('async assertGuardAssignable(');
  assert.ok(start > 0, 'assertGuardAssignable exists');
  const body = stripComments(service.slice(start, service.indexOf('\n  }\n', start)));
  assert.doesNotMatch(body, /isGuardVetted|screening|Screening/);
  assert.match(service, /S4 screening is deliberately NOT consulted here/);
  // And no backend code still emits the legacy refusal the company dashboard used to translate.
  const backend = sourceFilesOf(path.join(REPO, 'security-backend-nest', 'src')).filter((f) => !/\.spec\.ts$/.test(f));
  assert.ok(!backend.some((f) => fs.readFileSync(f, 'utf8').includes('Guard screening is not complete')));
  assert.ok(!read('src/screens/CompanyDashboardScreen.tsx').includes('Guard screening is not complete'));
});

function sourceFilesOf(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesOf(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

// ═══════════════════ PRIVACY ═══════════════════

const BACKEND = 'security-backend-nest/src/guard-personnel';
const controller = readRepo(`${BACKEND}/guard-personnel.controller.ts`);
const services = {
  identity: readRepo(`${BACKEND}/guard-personnel.service.ts`),
  driving: readRepo(`${BACKEND}/driving-transport.service.ts`),
  emergency: readRepo(`${BACKEND}/emergency-contact.service.ts`),
  bank: readRepo(`${BACKEND}/bank-details.service.ts`),
};
const membership = readRepo('security-backend-nest/src/company-membership/company-membership-types.ts');

/** Every route in the personnel controller: [method, path, roles text]. */
function routes() {
  const out = [];
  const re = /@(Get|Post|Patch|Put|Delete)\('([^']+)'\)\s*(?:@HttpCode\([^)]*\)\s*)?@Roles\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(controller))) out.push({ method: m[1], path: m[2], roles: m[3] });
  return out;
}
/** The body of a method in a service source, from its signature to the next method at the same indent. */
function methodBody(src, name) {
  const start = src.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = src.slice(start + 1).search(/\n  (?:async |private |public |protected )?[a-zA-Z]+\(/);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
}
/** Membership roles whose permission set holds `permission`. */
function rolesWithPermission(permission) {
  const sets = {};
  const re = /const ([A-Z_]+)_PERMISSIONS(?:: Set<CompanyPermission>)? = new Set\(([\s\S]*?)\);\n/g;
  let m;
  while ((m = re.exec(membership))) sets[m[1]] = m[2];
  const holders = Object.entries(sets).filter(([, body]) => body.includes('Object.values(CompanyPermission)') || stripComments(body).includes(`CompanyPermission.${permission},`)).map(([role]) => role);
  return holders.sort();
}

test('PRIVACY-01 tax identifiers: no company route; platform admin can reveal; every reveal (Guard and admin) is audited', () => {
  const p = copy.PRIVACY_COPY.taxIdentifiers;
  const all = routes();
  assert.ok(!all.some((r) => r.path.startsWith('company') && /identity|reveal/.test(r.path)), 'no company identity route');
  assert.equal(p.company, 'none');
  const adminReveal = all.find((r) => r.path === 'admin/:id/reveal');
  assert.ok(adminReveal && /UserRole\.ADMIN/.test(adminReveal.roles), 'admin reveal route, ADMIN only');
  assert.equal(p.platformAdmin, 'reveal');
  assert.match(methodBody(services.identity, 'revealForAdmin'), /action: 'guard_personnel\.identity_reveal'/);
  assert.match(methodBody(services.identity, 'revealForGuard'), /action: 'guard_personnel\.identity_reveal'/);
  assert.equal(p.platformAdminAudited, true);
  assert.equal(p.guardRevealAudited, true);
  assert.match(p.note, /Companies cannot see them/);
  assert.match(p.note, /platform administrators can reveal them/);
  assert.match(p.note, /recorded in the audit log/);
  assert.match(p.note, /encrypted at rest/);
});

test('PRIVACY-02 driving: the company view never returns the licence number and only a company owner gets it; admin reveal is audited', () => {
  const p = copy.PRIVACY_COPY.drivingLicence;
  const companyDto = methodBody(services.driving, 'getDrivingForCompany');
  assert.match(companyDto, /requireActiveCompanyGuardRelationship/);
  const toCompany = services.driving.slice(services.driving.indexOf('private toCompanyDto('), services.driving.indexOf('private toGuardDto('));
  assert.doesNotMatch(stripComments(toCompany), /licenceNumber/, 'no licence number in the company DTO');
  for (const field of ['licenceStatus', 'licenceCategories', 'licenceExpiryDate', 'primaryTravelMethod', 'maxTravelDistanceMiles']) assert.match(toCompany, new RegExp(field));
  assert.match(services.driving, /resolveOwnerCompanyContext/, 'company context: owner only');
  assert.deepEqual(p.companyRoles, ['OWNER']);
  assert.equal(p.company, 'notNumber');
  assert.equal(p.companyNeedsActiveRelationship, true);
  assert.match(methodBody(services.driving, 'revealLicenceForAdmin'), /action: 'guard_personnel\.driving_licence_reveal'/);
  assert.equal(p.platformAdmin, 'reveal');
  assert.match(p.note, /never shown to companies/);
  assert.match(p.note, /owner of a company you currently work for/);
  assert.match(p.note, /licence status, categories, expiry date and travel preferences/);
  assert.match(p.note, /platform administrators can reveal the licence number/);
});

test('PRIVACY-03 emergency contact: full values to the company owner (ACTIVE relationship) and platform admins, both audited', () => {
  const p = copy.PRIVACY_COPY.emergencyContact;
  const companyRoute = routes().find((r) => r.path === 'company/guard/:guardId/emergency-contact');
  assert.ok(companyRoute, 'company route');
  assert.doesNotMatch(companyRoute.roles, /COMPANY_STAFF/, 'staff accounts are not admitted at the route');
  assert.match(services.emergency, /resolveOwnerCompanyContext/, 'and the company context is the owner only');
  const companyRead = methodBody(services.emergency, 'getEmergencyContactForCompany');
  assert.match(companyRead, /requireActiveCompanyGuardRelationship/);
  assert.match(companyRead, /action: 'guard_personnel\.emergency_contact_view'/);
  assert.match(methodBody(services.emergency, 'getEmergencyContactForAdmin'), /action: 'guard_personnel\.emergency_contact_view'/);
  const toCompany = services.emergency.slice(services.emergency.indexOf('private toCompanyDto('));
  assert.match(toCompany, /contactName: this\.encryptionService\.decrypt/, 'the company sees the full name');
  assert.match(toCompany, /primaryPhone: this\.encryptionService\.decrypt/, 'and the full phone');
  assert.deepEqual([p.company, p.companyRoles, p.companyReadAudited, p.platformAdmin, p.platformAdminAudited], ['full', ['OWNER'], true, 'view', true]);
  assert.match(p.note, /owner of a company you currently work for can see them in full/);
  assert.match(p.note, /platform administrators can too/);
  assert.match(p.note, /recorded in the audit log/);
});

test('PRIVACY-04 bank: masked sort code and account number only, never the holder name, to owner/admin/finance of an engaged ACTIVE company; admins masked, no reveal', () => {
  const p = copy.PRIVACY_COPY.bankDetails;
  const dto = readRepo(`${BACKEND}/dto/bank-details-company-response.dto.ts`);
  const fields = [...dto.matchAll(/^\s+([a-zA-Z]+)!?:/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ['accountNumberMasked', 'bankSet', 'guardId', 'sortCodeMasked', 'updatedAt'], 'the company DTO: masked values and no holder name');
  const companyRead = methodBody(services.bank, 'getBankDetailsForCompany');
  assert.match(companyRead, /requireOwnedActiveRelationship/);
  assert.match(companyRead, /requireEngagement/);
  assert.match(companyRead, /maskSortCode\(sort\)/);
  assert.match(companyRead, /maskAccountNumber\(acct\)/);
  assert.match(services.bank, /function maskSortCode\(digits: string\): string \{\s*return `••-••-\$\{digits\.slice\(4\)\}`;/);
  assert.match(services.bank, /function maskAccountNumber\(digits: string\): string \{\s*return `••••\$\{digits\.slice\(4\)\}`;/);
  assert.match(services.bank, /CompanyPermission\.PERSONNEL_BANK_VIEW/);
  assert.deepEqual(rolesWithPermission('PERSONNEL_BANK_VIEW'), ['ADMIN', 'FINANCE', 'OWNER'], 'membership roles holding personnel_bank.view');
  assert.deepEqual([...p.companyRoles].sort(), ['ADMIN', 'FINANCE', 'OWNER']);
  assert.ok(!routes().some((r) => r.path.startsWith('admin') && /bank-details\/reveal/.test(r.path)), 'no admin bank reveal route');
  assert.match(methodBody(services.bank, 'getBankDetailsForAdmin'), /toGuardDto/, 'admin read is the masked guard DTO');
  assert.deepEqual([p.company, p.platformAdmin, p.companyNeedsActiveRelationship], ['masked', 'masked', true]);
  assert.match(p.note, /only you can see them in full/);
  assert.match(p.note, /masked sort code and account number/);
  assert.match(p.note, /never see the account holder name/);
  assert.match(p.note, /administrators see masked details only/);
});

test('PRIVACY-05 company access needs an ACTIVE relationship in every company read the table describes', () => {
  for (const [name, src] of Object.entries({ driving: services.driving, emergency: services.emergency, bank: services.bank })) {
    assert.match(src, /status: CompanyGuardStatus\.ACTIVE/, `${name}: ACTIVE relationship`);
  }
  for (const topic of ['drivingLicence', 'emergencyContact', 'bankDetails']) assert.equal(copy.PRIVACY_COPY[topic].companyNeedsActiveRelationship, true, topic);
  for (const [topic, access] of Object.entries(copy.PRIVACY_COPY)) {
    assert.match(access.note, /encrypted at rest/, `${topic}: says it is encrypted`);
    assert.match(access.note, /currently work for|Companies cannot/, `${topic}: says which companies`);
  }
});

test('PRIVACY-06 the Profile renders every note from the table and the inaccurate sentences are gone', () => {
  const { src, start, end } = profileRegion();
  const profile = src.slice(start, end);
  for (const [topic, id] of [['taxIdentifiers', 'tax'], ['drivingLicence', 'driving'], ['emergencyContact', 'emergency'], ['bankDetails', 'bank']]) {
    assert.ok(profile.includes(`testID="guard-profile-privacy-${id}">{PRIVACY_COPY.${topic}.note}</Text>`), `${topic} note rendered from PRIVACY_COPY`);
  }
  for (const old of [
    'Only you can view or update them from this app',
    'Only you can view the full number from this app',
    'only accessible to you, authorised platform staff, and your employing security company',
    'Employers see sort code and account number only',
    'only visible to you',
  ]) assert.ok(!src.includes(old), `removed: ${old}`);
  // The privacy summary is derived from the table, so it cannot drift from it.
  assert.equal(copy.privacySummary('taxIdentifiers'), 'Companies: no access · S4 administrators: can reveal (audited)');
  assert.equal(copy.privacySummary('bankDetails'), 'Companies: masked only · S4 administrators: masked only');
});

// ═══════════════════ ACCESSIBILITY ═══════════════════

/** JSX opening elements of the given tag names within [from, to) of a TSX source, with their attribute names. */
function jsxElements(source, fileName, tags, from = 0, to = Infinity) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && tags.includes(node.tagName.getText(sf))) {
      const pos = node.getStart(sf);
      if (pos >= from && pos < to) {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf));
        const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
        found.push({ tag: node.tagName.getText(sf), attrs, line, text: node.getText(sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test('A11Y-01 every Profile TextInput and Switch has an accessibilityLabel', () => {
  const { src, start, end } = profileRegion();
  const controls = jsxElements(src, 'GuardDashboardScreen.tsx', ['TextInput', 'Switch'], start, end);
  // Phase 2C removed exactly one control: the read-only "SIA licence number" TextInput in Personal details (the
  // licence is now shown in the overview header and the SIA & compliance section). Every other control is still here.
  assert.equal(controls.length, 19, `found ${controls.length} controls`);
  assert.ok(!controls.some((c) => /SIA licence number, read only/.test(c.text)), 'the read-only SIA field moved out of Personal');
  for (const label of ['Full name', 'Phone number', 'Live location sharing', 'National Insurance number', 'Unique Taxpayer Reference',
    'Driving licence number', 'Emergency contact name', 'Sort code', 'Account number']) {
    assert.ok(controls.some((c) => c.text.includes(`"${label}"`)), `${label} control kept`);
  }
  const unlabelled = controls.filter((c) => !c.attrs.includes('accessibilityLabel')).map((c) => `${c.tag} @${c.line}`);
  assert.deepEqual(unlabelled, []);
  // Panels rendered inside the Profile: availability fields and the account password.
  const availability = read('src/screens/GuardAvailabilityScreen.tsx');
  assert.match(availability, /<TextInput accessibilityLabel=\{label\} \{\.\.\.props\}/);
  for (const c of jsxElements(read('src/components/account/AccountSettingsPanel.tsx'), 'AccountSettingsPanel.tsx', ['TextInput'])) assert.ok(c.attrs.includes('accessibilityLabel'), `account TextInput @${c.line}`);
  for (const c of jsxElements(read('src/components/guard/GuardCompaniesPanel.tsx'), 'GuardCompaniesPanel.tsx', ['TextInput'])) assert.ok(c.attrs.includes('accessibilityLabel'), `companies TextInput @${c.line}`);
});

test('A11Y-02 every sensitive-value and edit action on the Profile is a labelled button', () => {
  const { src, start, end } = profileRegion();
  const pressables = jsxElements(src, 'GuardDashboardScreen.tsx', ['Pressable'], start, end);
  const sensitive = pressables.filter((p) => /handleReveal|clearReveal|clearLicenceReveal|clearBankReveal|handleSave|setEditing|openEmergencyContactEditor|handleRemove|handleDelete|handleLogout/.test(p.text));
  assert.ok(sensitive.length >= 25, `found ${sensitive.length} actions`);
  const missing = sensitive.filter((p) => !p.attrs.includes('accessibilityLabel') || !p.attrs.includes('accessibilityRole')).map((p) => `@${p.line}: ${p.text.split('\n')[0].trim().slice(0, 80)}`);
  assert.deepEqual(missing, []);
  // Each Show / Hide names its field, so a screen reader can tell NINO, UTR, licence and bank apart.
  for (const label of [
    'Show National Insurance number', 'Hide National Insurance number', 'Show Unique Taxpayer Reference', 'Hide Unique Taxpayer Reference',
    'Show driving licence number', 'Hide driving licence number', 'Show bank details', 'Hide bank details now',
    'Save National Insurance number', 'Save Unique Taxpayer Reference', 'Save driving licence number', 'Save emergency contact', 'Save bank details',
    'Remove emergency contact', 'Remove bank details', 'Update bank details', 'Log out',
  ]) assert.ok(src.slice(start, end).includes(`accessibilityLabel="${label}"`), label);
  // A masked value announces itself as hidden instead of reading out bullet characters.
  for (const field of ['National Insurance number', 'Unique Taxpayer Reference', 'Driving licence number']) {
    assert.ok(src.includes(`'${field}, hidden'`), `${field}: hidden`);
    assert.ok(src.includes(`'${field}, not yet provided'`), `${field}: not yet provided`);
  }
});

// ═══════════════════ REVEAL AND SAVE BEHAVIOUR (unchanged) ═══════════════════

test('REVEAL-01 reveal timers, confirmation and clearing are unchanged', () => {
  const src = stripComments(read(DASHBOARD));
  const count = (needle) => src.split(needle).length - 1;
  assert.equal(count('const REVEAL_SECONDS = 10;'), 2, 'NINO/UTR and licence: 10 seconds');
  assert.equal(count('const REVEAL_SECONDS = 15;'), 1, 'bank: 15 seconds');
  assert.match(src, /'Show bank details',\s*'Your full account details will be displayed for 15 seconds\. Continue\?'/, 'the bank reveal is still confirmed first');
  assert.match(src, /onPress=\{\(\) => \{ clearReveal\(\); setEditingNino\(true\); setNinoInput\(''\); \}\}/, 'editing NINO clears a reveal');
  assert.match(src, /onPress=\{\(\) => \{ clearReveal\(\); setEditingUtr\(true\); setUtrInput\(''\); \}\}/);
  assert.match(src, /onPress=\{\(\) => \{ clearLicenceReveal\(\); setEditingLicenceNumber\(true\); setLicenceNumberInput\(''\); \}\}/);
  assert.match(src, /onPress=\{\(\) => \{ setEditingBankDetails\(true\); clearBankReveal\(\); \}\}/);
  for (const call of ['revealMyPersonnelField(field)', 'revealMyDrivingLicenceNumber()', 'revealMyBankDetails()']) assert.equal(count(call), 1, call);
});

test('REVEAL-02 validation and save paths are unchanged', () => {
  const src = stripComments(read(DASHBOARD));
  assert.match(src, /if \(!isValidNinoFormat\(normalised\)\)/);
  assert.match(src, /if \(!\/\^\\d\{10\}\$\/\.test\(normalised\)\)/);
  assert.match(src, /if \(normalised\.length < 2 \|\| normalised\.length > 50\)/);
  assert.match(src, /'All three fields are required to add bank details\.'/);
  assert.match(src, /'Contact name is required\.'/);
  assert.match(src, /const plan = planGuardProfileSave\(loadedProfile, \{ fullName, phone, locationSharing \}\);/, 'Profile save safety still decides every save');
  assert.match(src, /'Replace bank details',\s*'This will permanently replace your stored bank account details\. Are you sure\?'/);
});

// ═══════════════════ LABELS ═══════════════════

test('LABELS-01 every enum value has a readable label, and the Profile uses the maps', () => {
  const models = read('src/types/models.ts');
  const unionOf = (name) => {
    const m = models.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
    assert.ok(m, name);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  for (const [type, map] of [
    ['GuardJobRole', labels.JOB_ROLE_LABELS], ['GuardEngagementType', labels.ENGAGEMENT_TYPE_LABELS], ['GuardWorkingArrangement', labels.WORKING_ARRANGEMENT_LABELS],
    ['GuardPayBasis', labels.PAY_BASIS_LABELS], ['GuardPayFrequency', labels.PAY_FREQUENCY_LABELS], ['GuardPayrollStatus', labels.PAYROLL_STATUS_LABELS],
    ['DrivingLicenceStatus', labels.LICENCE_STATUS_LABELS], ['PrimaryTravelMethod', labels.TRAVEL_METHOD_LABELS],
    ['EmergencyContactRelationship', labels.RELATIONSHIP_LABELS], ['GuardLeaveType', labels.LEAVE_TYPE_LABELS],
  ]) {
    assert.deepEqual(Object.keys(map).sort(), unionOf(type).sort(), `${type}: one label per value`);
    for (const [value, label] of Object.entries(map)) {
      assert.match(label, /^[A-Z]/, `${type}.${value}: starts with a capital`);
      assert.notEqual(label, label.toUpperCase(), `${type}.${value}: not shouted in capitals (acronyms such as CCTV are fine)`);
      assert.doesNotMatch(label, /_/, `${type}.${value}: no underscores`);
    }
  }
  assert.equal(labels.profileEnumLabel(labels.WORKING_ARRANGEMENT_LABELS, 'FULL_TIME'), 'Full time');
  assert.equal(labels.profileEnumLabel(labels.PAY_FREQUENCY_LABELS, 'FOUR_WEEKLY'), 'Every four weeks');
  assert.equal(labels.profileEnumLabel(labels.PAY_BASIS_LABELS, 'SOMETHING_NEW'), 'Something new', 'unknown value: readable fallback');
  assert.equal(labels.profileEnumLabel(labels.PAY_BASIS_LABELS, null), '—');
  assert.equal(labels.jobRoleLabel('OTHER', ' Keyholder '), 'Keyholder');
  assert.equal(labels.jobRoleLabel('OTHER', ''), 'Other');
  assert.equal(labels.jobRoleLabel('CCTV_OPERATOR', null), 'CCTV operator');
  const profile = (() => { const { src, start, end } = profileRegion(); return src.slice(start, end); })();
  assert.doesNotMatch(profile, /\.replace\(\/_\/g, ' '\)/, 'no raw enum text on the Profile');
  for (const use of ['jobRoleLabel(emp.jobRole, emp.customRole)', 'ENGAGEMENT_TYPE_LABELS, emp.engagementType', 'WORKING_ARRANGEMENT_LABELS, emp.workingArrangement', 'PAY_BASIS_LABELS, emp.payBasis', 'PAYROLL_STATUS_LABELS, rec.payrollStatus', 'RELATIONSHIP_LABELS, emergencyContact.relationship']) {
    assert.ok(profile.includes(use), use);
  }
});

// ═══════════════════ OVERVIEW ═══════════════════

const { ready, loading, failed } = overview;
const TODAY = '2031-03-01';
const baseInput = (patch = {}) => ({
  today: TODAY,
  guard: ready({ fullName: 'Dana Q Guard', phone: '07000 000001', siaLicenseNumber: 'SIA-FICTIONAL', siaExpiryDate: '2032-06-30' }),
  compliance: ready({ assignable: true, blockingReasons: [], siaExpiryDate: '2032-06-30' }),
  companies: ready([{ companyId: 3, companyName: 'Fictional Guarding Ltd', relationshipType: 'EMPLOYEE', acceptedAt: '2030-01-01', since: '2030-01-01' }]),
  emergencyContact: ready({ guardId: 1, contactName: 'Fictional Contact', relationship: 'FRIEND', customRelationship: null, primaryPhone: '07000 000009', alternatePhone: null, updatedAt: '2030-01-01' }),
  identity: ready({ ninoSet: true, utrSet: false }),
  bank: ready({ bankSet: true }),
  employments: ready([{ companyName: 'Fictional Guarding Ltd' }]),
  driving: ready({ licenceStatus: 'FULL', primaryTravelMethod: 'PUBLIC_TRANSPORT' }),
  screening: ready({ status: 'NOT_STARTED', progress: 0 }),
  email: 'guard@example.invalid',
  ...patch,
});

test('OVERVIEW-01 seven sections, in order, each with a title, requirement label and summary', () => {
  const o = overview.buildProfileOverview(baseInput());
  assert.deepEqual(o.sections.map((s) => s.key), ['personal', 'companies', 'compliance', 'availability', 'employmentPay', 'screening', 'privacyAccount']);
  assert.deepEqual(o.sections.map((s) => s.title), ['Personal details', 'Companies & invitations', 'SIA & compliance', 'Availability & travel', 'Employment & pay', 'Optional S4 screening', 'Privacy & account']);
  for (const s of o.sections) {
    assert.equal(s.requirementLabel, copy.REQUIREMENT_LABELS[s.requirement].label);
    assert.ok(s.summary.length > 0 && s.summary.length <= 60, `${s.key}: a one-line summary (${s.summary})`);
  }
  assert.equal(o.sections.find((s) => s.key === 'screening').requirement, 'optional');
  assert.equal(o.sections.find((s) => s.key === 'companies').requirementLabel, 'By invitation', 'not simply "Optional" (approved decision 2C-4)');
  assert.deepEqual(Object.values(copy.REQUIREMENT_LABELS).map((r) => r.label), ['Required', 'May be requested by company', 'Optional', 'Set by company', 'By invitation']);
  assert.equal(o.sections.find((s) => s.key === 'employmentPay').summary, 'Bank details added · NINO added');
  assert.equal(o.sections.find((s) => s.key === 'availability').summary, 'Public transport · Full licence');
  assert.equal(o.sections.find((s) => s.key === 'companies').summary, 'Fictional Guarding Ltd');
  assert.equal(o.sections.find((s) => s.key === 'privacyAccount').summary, 'Signed in as guard@example.invalid');
});

test('OVERVIEW-02 header: name, initials, SIA status by date, deployment from `assignable` only', () => {
  let o = overview.buildProfileOverview(baseInput());
  assert.deepEqual([o.header.name, o.header.initials, o.header.phone], ['Dana Q Guard', 'DG', '07000 000001']);
  // Phase 2D: each fact also has the short value its header cell shows (detail / short) under a fixed caption.
  // UX-02A (D4): a valid licence's cell puts "valid to" in the caption so the value is the date alone; other states keep
  // the plain caption and the section's own words.
  assert.deepEqual(o.header.sia, { label: 'SIA valid to 30/06/2032', detail: 'Valid to 30/06/2032', caption: 'SIA licence valid to', value: '30/06/2032', tone: 'success' });
  assert.deepEqual(o.header.deployment, { label: 'Eligible for deployment', short: 'Eligible', tone: 'success' });
  o = overview.buildProfileOverview(baseInput({ compliance: ready({ assignable: false, blockingReasons: ['a', 'b'], siaExpiryDate: '2031-03-20' }) }));
  assert.deepEqual(o.header.sia, { label: 'SIA expires 20/03/2031', detail: 'Expires 20/03/2031', caption: 'SIA licence', value: 'Expires 20/03/2031', tone: 'warning' });
  // UX-02A: the SIA & compliance row says what the section adds (the header already shows SIA and deployment).
  assert.deepEqual([o.sections.find((s) => s.key === 'compliance').summary, o.sections.find((s) => s.key === 'compliance').tone], ['2 compliance items to review', 'warning']);
  assert.deepEqual(o.header.deployment, { label: 'Not eligible for deployment', short: 'Not eligible', tone: 'warning' });
  o = overview.buildProfileOverview(baseInput({ compliance: ready({ assignable: true, blockingReasons: [], siaExpiryDate: '2031-02-28' }) }));
  assert.deepEqual(o.header.sia, { label: 'SIA expired 28/02/2031', detail: 'Expired 28/02/2031', caption: 'SIA licence', value: 'Expired 28/02/2031', tone: 'danger' });
  assert.deepEqual([o.sections.find((s) => s.key === 'compliance').summary, o.sections.find((s) => s.key === 'compliance').tone], ['No compliance blockers', 'danger'], 'the expired licence keeps the row red');
  o = overview.buildProfileOverview(baseInput({ compliance: ready({ assignable: false, blockingReasons: ['a'] }) }));
  assert.equal(o.sections.find((s) => s.key === 'compliance').summary, '1 compliance item to review');
  o = overview.buildProfileOverview(baseInput({ compliance: ready({ assignable: false, blockingReasons: [] }) }));
  assert.equal(o.sections.find((s) => s.key === 'compliance').summary, 'Compliance needs review', 'not assignable, no reason given: nothing invented');
  o = overview.buildProfileOverview(baseInput());
  assert.deepEqual([o.sections.find((s) => s.key === 'compliance').summary, o.sections.find((s) => s.key === 'compliance').tone], ['No compliance blockers', 'neutral']);
  assert.doesNotMatch(o.sections.find((s) => s.key === 'compliance').summary, /SIA|eligible/i, 'UX-02A: no repeat of the header facts');
  for (const [state, text] of [[loading(), 'Loading…'], [failed(), null]]) {
    const x = overview.buildProfileOverview(baseInput({ compliance: state }));
    const summary = x.sections.find((s) => s.key === 'compliance').summary;
    if (text) assert.equal(summary, text); else assert.doesNotMatch(summary, /blocker|review/, 'a failed read is never shown as a result');
  }
  o = overview.buildProfileOverview(baseInput({ guard: ready({ fullName: 'Dana', phone: '' }), compliance: ready({ assignable: false, blockingReasons: [] }) }));
  assert.deepEqual([o.header.initials, o.header.phone, o.header.sia.label], ['D', null, 'SIA licence not added']);
  // Screening never changes deployment: a VETTED file with assignable=false is still not eligible, and the reverse.
  for (const status of ['VETTED', 'NOT_STARTED', 'REJECTED']) {
    for (const assignable of [true, false]) {
      const x = overview.buildProfileOverview(baseInput({ screening: ready({ status, progress: 100 }), compliance: ready({ assignable, blockingReasons: [] }) }));
      assert.equal(x.header.deployment.label, assignable ? 'Eligible for deployment' : 'Not eligible for deployment', `${status} / ${assignable}`);
      // Phase 2D: "Optional" is said once, by the row's tag, not repeated at the start of its summary.
      const row = x.sections.find((s) => s.key === 'screening');
      assert.deepEqual([row.requirement, row.requirementLabel], ['optional', 'Optional'], `${status}: always optional`);
      assert.doesNotMatch(row.summary, /Optional/, `${status}: not repeated in the summary`);
      assert.equal(row.requirementText, null, `${status}: UX-02A no separate Optional beside "Optional S4 screening"`);
    }
  }
});

test('OVERVIEW-03 loading and failed data are never shown as "not provided"', () => {
  const o = overview.buildProfileOverview(baseInput({
    guard: loading(), compliance: loading(), companies: failed(), emergencyContact: loading(), identity: failed(), bank: ready({ bankSet: false }), driving: loading(), screening: failed(), email: null,
  }));
  const by = (k) => o.sections.find((s) => s.key === k).summary;
  assert.equal(o.header.name, 'Loading…');
  assert.equal(o.header.deployment.label, 'Loading…');
  assert.equal(by('companies'), 'Could not load');
  assert.equal(by('personal'), 'Loading…');
  assert.equal(by('employmentPay'), 'Could not load');
  assert.equal(by('screening'), 'Could not load');
  assert.equal(by('availability'), 'Loading…');
  assert.deepEqual(o.attention, [], 'nothing is flagged from data that has not loaded');
  for (const s of o.sections) assert.doesNotMatch(s.summary, /not added|No emergency|No bank|No NINO|Join with/, `${s.key}: no false absence`);
});

test('OVERVIEW-04 needs-attention: facts only, most serious first, at most three', () => {
  const o = overview.buildProfileOverview(baseInput({
    compliance: ready({ assignable: false, blockingReasons: ['x'], siaExpiryDate: '2031-01-01' }),
    companies: ready([]),
    emergencyContact: ready(null),
  }));
  assert.deepEqual(o.attention.map((a) => a.key), ['sia-expired', 'deployment-blocked', 'no-company']);
  assert.equal(o.attention[1].text, '1 compliance item to review');
  assert.equal(o.attention.length, 3);
  const clean = overview.buildProfileOverview(baseInput());
  assert.deepEqual(clean.attention, []);
  // Field-level requirement levels: screening optional, employment and pay set by the company.
  const req = overview.PROFILE_FIELD_REQUIREMENTS;
  assert.equal(req.s4Screening, 'optional');
  assert.deepEqual([req.fullName, req.phone, req.employment, req.payAdministration, req.nino, req.bankDetails], ['required', 'required', 'setByCompany', 'setByCompany', 'company', 'company']);
  assert.equal(overview.daysUntil('2031-03-01', '2031-03-31'), 30);
  assert.equal(overview.daysUntil('2031-03-01', 'not a date'), null);
});

// ═══════════════════ LAYOUT ═══════════════════

test('LAYOUT-01 compact on small phones or large text, with the Guard Home thresholds', () => {
  assert.equal(homeLayout.NARROW_WIDTH, 375);
  assert.equal(homeLayout.LARGE_TEXT_SCALE, 1.3);
  for (const width of [320, 360, 375, 412, 430]) {
    for (const fontScale of [1, 1.3, 2]) {
      const l = layoutRules.profileLayout({ width, height: 800, fontScale });
      const home = homeLayout.guardHomeLayout({ width, height: 800, fontScale });
      assert.equal(l.compact, home.compact, `${width}@${fontScale}: compact like Home`);
      assert.equal(l.minTouchTarget, 44);
      assert.equal(l.contentWidth, width - 64);
    }
  }
  const at = (width, fontScale) => layoutRules.profileLayout({ width, height: 800, fontScale });
  assert.deepEqual([at(412, 1).detailRowStacks, at(412, 1).footerStacks], [false, false], 'large phone, normal text: side by side');
  assert.deepEqual([at(320, 1).detailRowStacks, at(320, 1).footerStacks], [true, true], 'small phone: stacks');
  assert.deepEqual([at(412, 2).detailRowStacks, at(412, 2).footerStacks], [true, true], 'large text: stacks');
  // UX-02A: no width/text-size rule for the overview's requirement text any more; it wraps by content (see the overview).
  assert.equal(at(360, 1.3).sectionRowStacksTag, undefined);
  assert.equal(at(412, 1).sectionRowStacksTag, undefined);
  for (const bad of [{ width: 0, height: 0, fontScale: 0 }, { width: NaN, height: NaN, fontScale: NaN }]) {
    const l = layoutRules.profileLayout(bad);
    assert.equal(l.fontScale, 1);
    assert.equal(l.width, 375);
  }
  // Long choice groups become lists when compact; short ones stay chips.
  assert.equal(layoutRules.choicePresentation(6, at(360, 1.3)), 'list');
  assert.equal(layoutRules.choicePresentation(4, at(360, 1.3)), 'chips');
  assert.equal(layoutRules.choicePresentation(7, at(412, 1)), 'chips');
});

test('LAYOUT-02 tokens reuse the Guard Home theme, and requirement text reaches 4.5:1', () => {
  const guard = loadTs('src/theme/guard.ts');
  const t = theme.profileTokens;
  assert.equal(t.colors.accent, guard.guardColors.teal);
  assert.equal(t.colors.textPrimary, guard.guardColors.textPrimary);
  assert.equal(t.shape.cardRadius, guard.guardShape.cardRadius);
  assert.deepEqual(t.type.button, guard.guardType.button);
  assert.deepEqual(t.type.sectionLabel, guard.guardType.sectionLabel);
  const hex = (c) => { const n = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255); };
  const lum = (c) => hex(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // UX-02A: requirement levels are plain secondary text on the card surface (no pill), so that pairing is the one checked.
  assert.equal(theme.REQUIREMENT_TAG_COLORS, undefined, 'UX-02A: no requirement pill colours');
  assert.deepEqual(t.type.requirement, { fontFamily: guard.guardFontFamily.regular, fontSize: 13, lineHeight: 18 });
  assert.ok(contrast(t.colors.textSecondary, t.colors.surface) >= 4.5, `requirement text: ${contrast(t.colors.textSecondary, t.colors.surface).toFixed(2)}:1`);
  for (const [tone, { text, surface }] of Object.entries(theme.PROFILE_TONE_COLORS)) {
    assert.ok(contrast(text, surface) >= 4.5, `status ${tone}: ${contrast(text, surface).toFixed(2)}:1`);
  }
  // Approved decision 2C-3: requirement levels are neutral; warning and danger colours are kept for real problems.
  const brand = loadTs('src/theme/brand.ts').colors;
  const tagSrc = stripComments(read('src/components/guard/profile/ProfileTags.tsx'));
  assert.match(tagSrc, /requirement: \{ \.\.\.profileTokens\.type\.requirement, color: profileTokens\.colors\.textSecondary,/, 'one neutral style for every requirement level');
  for (const problem of [brand.danger, brand.dangerSurface, brand.warning, brand.warningSurface, brand.success, brand.successSurface]) {
    assert.notEqual(t.colors.textSecondary, problem, `no status colour (${problem}) on requirement text`);
  }
  assert.doesNotMatch(tagSrc, /RequirementTag|backgroundColor: c\.surface \}\]\} testID=\{`guard-profile-requirement/, 'UX-02A: no requirement pill');
  assert.equal(theme.PROFILE_TONE_COLORS.danger.text, brand.danger, 'status colours are the brand ones');
  // No new UI library: the foundations import only React Native-free modules and the existing theme.
  for (const file of ['profileCopy.ts', 'profileLabels.ts', 'profileOverview.ts', 'profileLayout.ts', 'profileTheme.ts']) {
    const src = read(`src/components/guard/profile/${file}`);
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.every((i) => i.startsWith('.')), `${file}: only local imports (${imports.join(', ')})`);
  }
  // Phase 2C components: React, React Native, the existing API module and types, and each other. Nothing else.
  for (const file of ['GuardProfileOverview.tsx', 'GuardProfileSection.tsx', 'GuardComplianceUpdateRoute.tsx', 'GuardPrivacySummary.tsx', 'ProfileAvatar.tsx', 'ProfileTags.tsx']) {
    const src = read(`src/components/guard/profile/${file}`);
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    const allowed = (i) => i === 'react' || i === 'react-native' || i.startsWith('./') || i === '../../../services/api' || i === '../../../types/models';
    assert.ok(imports.every(allowed), `${file}: no new library (${imports.join(', ')})`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /react-native-paper|native-base|tamagui|gluestack|@rneui|react-native-elements|ui-kitten|@react-navigation\/stack|@react-navigation\/native-stack/.test(d)), 'no UI kit or new navigation library');
});

// ═══════════════════ Phase 2C: overview, sections and compliance separation ═══════════════════

test('NAV-01 the Profile is an overview and seven sections inside the Profile tab, which stays selected', () => {
  const src = read(DASHBOARD);
  assert.match(src, /type GuardTab = 'home' \| 'offers' \| 'jobs' \| 'history' \| 'profile' \| 'screening' \| 'inbox';/, 'no new tabs; My Companies is a section, not a sub-tab');
  assert.match(src, /const navActiveTab: GuardTab =\s*activeTab === 'screening' \? 'profile' : activeTab === 'inbox' \? 'home' : activeTab;/);
  assert.match(src, /const \[profileSection, setProfileSection\] = useState<ProfileSectionKey \| null>\(null\);/);
  const { start, end } = profileRegion();
  const region = src.slice(start, end);
  assert.match(region, /\{profileSection === null \? \(\s*<GuardProfileOverview/, 'the overview first');
  for (const key of overview.PROFILE_SECTIONS.map((s) => s.key)) {
    assert.equal(region.split(`{profileSection === '${key}' ? (`).length - 1, 1, `${key}: rendered once, only when open`);
  }
  // Each existing card is in exactly one section, moved whole.
  const where = (needle) => {
    const at = region.indexOf(needle);
    assert.ok(at > 0 && region.indexOf(needle, at + 1) < 0, `${needle}: once`);
    const opened = [...region.slice(0, at).matchAll(/\{profileSection === '([a-zA-Z]+)' \? \(/g)].pop();
    return opened?.[1];
  };
  assert.equal(where('testID="guard-profile-save"'), 'personal');
  assert.equal(where('title="Emergency contact"'), 'personal');
  assert.equal(where('<GuardCompaniesPanel'), 'companies');
  assert.equal(where('<GuardCompliancePanel onSummary={rememberComplianceSummary} />'), 'compliance');
  assert.equal(where('<GuardAvailabilityScreen />'), 'availability');
  assert.equal(where('title="Driving & transport"'), 'availability');
  assert.equal(where('title="Tax identifiers"'), 'employmentPay');
  // Phase 2D: card titles in sentence case.
  assert.equal(where('title="Bank details"'), 'employmentPay');
  assert.equal(where('title="Employment"'), 'employmentPay');
  assert.equal(where('title="Pay administration"'), 'employmentPay');
  assert.equal(where("<GuardScreeningPanel onContinue={() => openScreeningJourney('screening')} />"), 'screening');
  assert.equal(where('<AccountSettingsPanel'), 'privacyAccount');
  assert.equal(where('accessibilityLabel="Log out"'), 'privacyAccount');
  assert.equal(where('<AppBuildFooter appLabel="S4" />'), 'privacyAccount');
  assert.match(src, /<GuardScreeningJourney onBack=\{\(\) => openProfileSection\(screeningReturnSectionRef\.current\)\}/, 'the screening file returns to the section it was opened from');
});

test('NAV-02 leaving a section hides revealed values and closes edits of masked values, without calling the server', () => {
  const src = stripComments(read(DASHBOARD));
  const start = src.indexOf('useEffect(() => {\n    clearReveal();');
  assert.ok(start > 0, 'the navigation effect');
  const endMarker = '}, [activeTab, profileSection]);';
  const effect = src.slice(start, src.indexOf(endMarker, start) + endMarker.length);
  for (const call of ['clearReveal();', 'clearLicenceReveal();', 'clearBankReveal();', 'setEditingNino(false);', "setNinoInput('');", 'setEditingUtr(false);', "setUtrInput('');",
    'setEditingLicenceNumber(false);', "setLicenceNumberInput('');", 'setEditingBankDetails(false);', "setBankHolderInput('');", "setBankSortInput('');", "setBankAccountInput('');"]) {
    assert.ok(effect.includes(call), call);
  }
  assert.ok(effect.endsWith('}, [activeTab, profileSection]);'), 'runs on every tab or section change');
  assert.doesNotMatch(effect, /await|reveal[A-Z][a-zA-Z]*\(|save[A-Z]|update[A-Z]|delete[A-Z]/, 'no server call');
});

test('COMPLIANCE-01 SIA and right-to-work: the gap is real, and the only update route is labelled as the optional screening file', () => {
  // Backend evidence. PATCH /guards/me accepts name, phone and location sharing only.
  const dto = readRepo('security-backend-nest/src/guard-profile/dto/update-guard-profile.dto.ts');
  assert.deepEqual([...dto.matchAll(/^\s+([a-zA-Z]+)\?:/gm)].map((m) => m[1]), ['fullName', 'phone', 'locationSharingEnabled']);
  // The Guard's SIA and right-to-work write is the screening file's, and it needs a started file.
  const screeningController = readRepo('security-backend-nest/src/screening/screening.controller.ts');
  assert.match(screeningController, /@Put\('mine\/compliance'\) @Roles\(UserRole\.GUARD\)/);
  const screeningService = readRepo('security-backend-nest/src/screening/screening.service.ts');
  const update = screeningService.slice(screeningService.indexOf('async updateCandidateCompliance('));
  assert.match(update.slice(0, 400), /if\(!screening\)throw new BadRequestException\('Start screening first\.'\)/);
  assert.match(update.slice(0, 1600), /SIA correction is not currently required\./, 'a file under review accepts a change only when asked');
  // A screening-independent evidence upload exists (company-scoped), but the app has no screen for it yet.
  const complianceController = readRepo('security-backend-nest/src/compliance/compliance.controller.ts');
  assert.match(complianceController, /@Post\('documents\/mine'\)\s*@Roles\(UserRole\.GUARD\)/);
  assert.ok(!sourceFiles().some((f) => !f.endsWith(path.join('services', 'api.ts')) && fs.readFileSync(f, 'utf8').includes('uploadMyGuardDocument')), 'documented gap: no Guard evidence upload screen (not invented here)');
  // The app: the Compliance panel no longer offers an unlabelled route, and the update route says what it is.
  const panel = stripComments(read(COMPLIANCE_PANEL));
  assert.match(panel, /\{onManageCompliance \? \(\s*<Pressable/, 'Manage compliance only when a caller supplies it');
  const { src, start, end } = profileRegion();
  const region = src.slice(start, end);
  assert.ok(region.includes('<GuardCompliancePanel onSummary={rememberComplianceSummary} />') && !/<GuardCompliancePanel[^>]*onManageCompliance/.test(region), 'SIA & compliance supplies no Manage compliance');
  assert.ok(region.includes("<GuardComplianceUpdateRoute onOpenScreening={() => openScreeningJourney('compliance')} />"));
  assert.ok(!src.includes('onManageCompliance='), 'no screen routes compliance into screening silently');
  const c = copy.COMPLIANCE_COPY;
  assert.match(c.updateBody, /only in your optional S4 screening file/);
  assert.match(c.updateBody, /does not make screening required/);
  assert.match(c.updateAction, /S4 screening file/);
  assert.match(c.updateActionAccessibilityLabel, /optional S4 screening file/);
  for (const text of Object.values(c)) for (const pattern of copy.MANDATORY_SCREENING_PATTERNS) assert.doesNotMatch(text, pattern);
  // Deployment eligibility is untouched: still the backend's `assignable`.
  assert.match(stripComments(read(COMPLIANCE_PANEL)), /const eligibility = getGuardWorkEligibilityLabel\(summary\);/);
});

test('OVERVIEW-05 the dashboard adapter never turns "not loaded yet" or "failed" into "not provided"', () => {
  const record = (value, patch = {}) => ({ value, loading: false, error: null, ...patch });
  const state = (patch = {}) => ({
    profile: { fullName: 'Dana Guard', phone: '07000 000001' },
    profileLoading: false,
    siaLicenceNumber: 'SIA-FICTIONAL',
    companies: { value: [], status: 'ready' },
    emergencyContact: record(null),
    identity: record({ ninoSet: true, utrSet: false }),
    bank: record(null),
    employments: record([]),
    driving: record(null),
    email: 'guard@example.invalid',
    ...patch,
  });
  // Before the Guard's record has loaded, the personnel records have not even been requested.
  let src = overview.overviewSourceFromDashboard(state({ profile: null, profileLoading: true }));
  for (const key of ['guard', 'emergencyContact', 'identity', 'bank', 'employments', 'driving']) assert.equal(src[key].status, 'loading', `${key}: loading`);
  src = overview.overviewSourceFromDashboard(state({ profile: null, profileLoading: false }));
  for (const key of ['guard', 'emergencyContact', 'identity', 'bank', 'employments', 'driving']) assert.equal(src[key].status, 'error', `${key}: unavailable after a failed load`);
  src = overview.overviewSourceFromDashboard(state({ bank: record(null, { loading: true }), driving: record(null, { error: 'x' }), companies: { value: [], status: 'loading' } }));
  assert.deepEqual([src.bank.status, src.driving.status, src.companies.status], ['loading', 'error', 'loading']);
  src = overview.overviewSourceFromDashboard(state());
  assert.deepEqual(src.guard.value, { fullName: 'Dana Guard', phone: '07000 000001', siaLicenseNumber: 'SIA-FICTIONAL' });
  assert.deepEqual([src.bank.value, src.identity.value, src.emergencyContact.value], [{ bankSet: false }, { ninoSet: true, utrSet: false }, null]);
  // Built into the overview: no false "No emergency contact" or "Join a company" while loading.
  const o = overview.buildProfileOverview({ ...overview.overviewSourceFromDashboard(state({ profile: null, profileLoading: true, companies: { value: [], status: 'loading' } })),
    compliance: overview.loading(), screening: overview.loading(), today: '2031-03-01' });
  assert.deepEqual(o.attention, []);
  assert.equal(overview.localToday(new Date(2031, 2, 1, 23, 59)), '2031-03-01');
  // Companies & invitations is "By invitation", never simply "Optional" (approved decision 2C-4).
  assert.equal(overview.PROFILE_SECTIONS.find((s) => s.key === 'companies').requirement, 'invitation');
  assert.equal(copy.REQUIREMENT_LABELS.invitation.label, 'By invitation');
});

test('AVATAR-01 the avatar is initials only: no camera, picker or upload (approved decisions 5 and 6)', () => {
  const avatar = stripComments(read('src/components/guard/profile/ProfileAvatar.tsx')); // code only: the doc comment says upload is NOT built
  assert.doesNotMatch(avatar, /expo-image-picker|expo-camera|ImagePicker|launchCamera|upload/i);
  const overviewSrc = stripComments(read('src/components/guard/profile/GuardProfileOverview.tsx'));
  // Phase 2D: one 48dp avatar on every phone (the compact header keeps it beside the name).
  assert.match(overviewSrc, /<ProfileAvatar initials=\{header\.initials\} size=\{48\} \/>/, 'no image is passed');
  assert.doesNotMatch(overviewSrc, /%`|percent|completion/i, 'no completion percentage (approved decision 7)');
  assert.equal(overview.initialsOf('Dana Q Guard'), 'DG');
});

// ═══════════════════ RUN ═══════════════════

// ═══════════════════ Phase 2D ═══════════════════

test('SIA-01 one reading of the SIA licence for the overview and the SIA & compliance section', () => {
  const today = '2026-11-16';
  // Number from the Guard's record first, then the compliance status; expiry from the compliance status first.
  let s = overview.siaLicenceStatus({ guard: { siaLicenseNumber: 'G-1', siaExpiryDate: '2030-01-01' }, compliance: { siaLicenceNumber: 'C-1', siaExpiryDate: '2028-06-30' } }, today);
  assert.deepEqual([s.number, s.expiry, s.label, s.detail, s.tone], ['G-1', '2028-06-30', 'SIA valid to 30/06/2028', 'Valid to 30/06/2028', 'success']);
  s = overview.siaLicenceStatus({ guard: { siaLicenceNumber: null, siaExpiryDate: '2026-12-01' }, compliance: { siaLicenceNumber: 'C-1' } }, today);
  assert.deepEqual([s.number, s.label, s.detail, s.tone], ['C-1', 'SIA expires 01/12/2026', 'Expires 01/12/2026', 'warning']);
  s = overview.siaLicenceStatus({ guard: { siaLicenseNumber: 'G-1' }, compliance: { siaExpiryDate: '2026-11-15' } }, today);
  assert.deepEqual([s.label, s.detail, s.tone], ['SIA expired 15/11/2026', 'Expired 15/11/2026', 'danger']);
  s = overview.siaLicenceStatus({ guard: { siaLicenseNumber: 'G-1' }, compliance: null }, today);
  assert.deepEqual([s.label, s.detail, s.tone], ['SIA licence added', 'Expiry date not recorded', 'neutral']);
  s = overview.siaLicenceStatus({ guard: null, compliance: null }, today);
  assert.deepEqual([s.number, s.label, s.detail, s.tone], [null, 'SIA licence not added', 'Not added', 'warning']);
  // The overview header IS this reading (label and detail), so the two screens cannot disagree.
  for (const compliance of [{ siaExpiryDate: '2028-06-30' }, { siaExpiryDate: '2026-12-01' }, { siaExpiryDate: '2020-01-01' }, {}]) {
    const o = overview.buildProfileOverview(baseInput({ today, compliance: ready({ assignable: true, blockingReasons: [], ...compliance }) }));
    const direct = overview.siaLicenceStatus({ guard: { siaLicenseNumber: 'SIA-FICTIONAL', siaExpiryDate: '2032-06-30' }, compliance }, today);
    assert.deepEqual([o.header.sia.label, o.header.sia.detail, o.header.sia.tone], [direct.label, direct.detail, direct.tone]);
  }
  // And the Compliance panel reads the same helper with the same two records, not its own date formatting.
  const panel = stripComments(read(COMPLIANCE_PANEL));
  assert.match(panel, /const sia = siaLicenceStatus\(\{ guard, compliance: summary \}, localToday\(\)\);/);
  assert.match(panel, /<Summary label="SIA licence" value=\{sia\.number \|\| 'Not added'\} detail=\{sia\.number \? sia\.detail : undefined\}/);
  assert.doesNotMatch(panel, /toLocaleDateString|function formatDate/, 'no second date format');
});

test('UNSAVED-01 only a typed, unsaved masked value asks before leaving', () => {
  const unsaved = loadTs('src/components/guard/profile/profileUnsaved.ts');
  const idle = { editing: false, inputs: [''] };
  const none = { nino: idle, utr: idle, drivingLicence: idle, bank: { editing: false, inputs: ['', '', ''] } };
  assert.equal(unsaved.hasUnsavedSensitiveEdit(none), false);
  assert.equal(unsaved.hasUnsavedSensitiveEdit({ ...none, nino: { editing: true, inputs: [''] } }), false, 'an open, empty editor leaves silently');
  assert.equal(unsaved.hasUnsavedSensitiveEdit({ ...none, nino: { editing: true, inputs: ['   '] } }), false, 'spaces are not a value');
  assert.equal(unsaved.hasUnsavedSensitiveEdit({ ...none, nino: { editing: false, inputs: ['QQ'] } }), false, 'a closed editor holds nothing');
  for (const key of ['nino', 'utr', 'drivingLicence']) {
    assert.equal(unsaved.hasUnsavedSensitiveEdit({ ...none, [key]: { editing: true, inputs: ['1'] } }), true, key);
  }
  for (const i of [0, 1, 2]) {
    const inputs = ['', '', '']; inputs[i] = '1';
    assert.equal(unsaved.hasUnsavedSensitiveEdit({ ...none, bank: { editing: true, inputs } }), true, `bank input ${i}`);
  }
  assert.deepEqual(unsaved.UNSAVED_EDIT_COPY, { title: 'Discard unsaved changes?', message: 'What you have typed has not been saved. If you leave now, it will be discarded.', keep: 'Keep editing', discard: 'Discard' });
  // Wired into the three Profile moves only; the Emergency control opens its own form and never passes through it.
  const src = stripComments(read(DASHBOARD));
  for (const move of ['selectTab(tab)', 'openProfileSection(section)', 'openScreeningJourney(from)']) {
    assert.ok(src.includes(`if (holdForUnsavedEdits(() => ${move})) return;`), move);
  }
  assert.equal(src.split('const holdForUnsavedEdits = useCallback').length - 1, 1, 'defined once');
  assert.equal(src.split('holdForUnsavedEdits(').length - 1, 3, 'used by exactly three moves');
  assert.match(src, /const openEmergency = \(\) => setQuickActionModal\('emergency'\);/, 'Emergency is not gated');
  for (const field of ['ninoInput', 'utrInput', 'licenceNumberInput', 'bankHolderInput, bankSortInput, bankAccountInput']) {
    assert.ok(src.includes(`inputs: [${field}]`), field);
  }
});

test('STYLE-01 every Profile section uses the flat Profile card, sentence case and UK dates', () => {
  const { src, start, end } = profileRegion();
  const region = src.slice(start, end);
  assert.doesNotMatch(region, /<FeatureCard/, 'no FeatureCard (shadow, 22dp radius) inside the Profile');
  assert.equal(region.split('<ProfileCard').length - 1, 7);
  assert.doesNotMatch(region, /title="[^"]*\b[A-Z][a-z]+ [A-Z][a-z]+"/, 'card titles in sentence case');
  assert.doesNotMatch(region, /styles\.guardSectionLabel/, 'no uppercase captions inside the Profile');
  assert.doesNotMatch(region, /\{(emp|rec)\.(startDate|endDate|payrollStartDate|payrollEndDate)\}/, 'no raw ISO dates');
  for (const field of ['emp.startDate', 'emp.endDate', 'rec.payrollStartDate', 'rec.payrollEndDate']) assert.ok(region.includes(`profileDate(${field})`), field);
  assert.equal(overview.profileDate('2026-03-02'), '02/03/2026');
  assert.equal(overview.profileDate('2026-03-02T09:00:00.000Z'), '02/03/2026');
  assert.equal(overview.profileDate(null), '—');
  assert.equal(overview.profileDate('soon'), 'soon');
  const availability = read('src/screens/GuardAvailabilityScreen.tsx');
  assert.doesNotMatch(availability, /<FeatureCard/, 'Availability & travel uses the Profile card too');
  const card = read('src/components/guard/profile/ProfileCard.tsx');
  assert.doesNotMatch(stripComments(card), /shadow|elevation|fontStyle/, 'flat, no italics');
  assert.match(card, /borderRadius: t\.shape\.cardRadius/);
  // Short requirement tags for the overview rows; the full wording stays for headings and screen readers.
  assert.deepEqual(Object.values(copy.REQUIREMENT_LABELS).map((r) => r.short), ['Required', 'Company may ask', 'Optional', 'Set by company', 'By invitation']);
  // Status chips in the compliance panel are sentence case; StatusBadge elsewhere is unchanged (title case).
  assert.match(read(COMPLIANCE_PANEL), /<StatusBadge label=\{value\} casing="sentence" \/>/);
  const badge = read('src/components/StatusBadge.tsx');
  assert.match(badge, /casing = 'title'/);
  assert.match(badge, /textTransform: 'capitalize'/);
});

// Profile Phase 2E: the read tracker on its own (pure; no screen, no network).
test('DATA-01 each Profile view reads only the records it shows, once per freshness window, never twice at once', () => {
  const data = loadTs('src/components/guard/profile/profileData.ts');
  const views = data.PROFILE_RECORDS_BY_VIEW;
  assert.deepEqual([...views.overview].sort(), ['bank', 'companies', 'driving', 'emergencyContact', 'employments', 'identity']);
  assert.deepEqual([...views.employmentPay].sort(), ['bank', 'employments', 'identity', 'payroll']);
  assert.deepEqual([views.personal, views.availability, views.companies], [['emergencyContact'], ['driving'], ['companies']]);
  for (const view of ['compliance', 'screening', 'privacyAccount']) assert.deepEqual(views[view], [], `${view} reads its own data`);
  assert.equal(data.PROFILE_FRESH_MS, 60_000);
  const t = data.createProfileReadTracker();
  assert.deepEqual(data.recordsToRead(t, 'personal', 0), ['emergencyContact'], 'never read: due');
  const first = t.begin('emergencyContact');
  assert.deepEqual(data.recordsToRead(t, 'personal', 1), [], 'in flight: not read again');
  assert.equal(t.hasLoaded('emergencyContact'), false);
  assert.equal(t.accept(first, 10), true);
  assert.equal(t.finish(first), true);
  assert.equal(t.hasLoaded('emergencyContact'), true);
  assert.deepEqual(data.recordsToRead(t, 'personal', 10 + 59_999), [], 'fresh inside the window');
  assert.deepEqual(data.recordsToRead(t, 'personal', 10 + 60_000), ['emergencyContact'], 'due again after it');
  // A failed read never counts as fresh: the next opening tries again.
  const failed = t.begin('bank');
  assert.equal(t.finish(failed), true);
  assert.equal(t.hasLoaded('bank'), false);
  assert.equal(t.shouldRead('bank', 0), true);
});

test('DATA-02 stale responses are dropped: an overtaken read, a read older than a save, a read after unmount', () => {
  const data = loadTs('src/components/guard/profile/profileData.ts');
  const t = data.createProfileReadTracker();
  // Overtaken: only the latest read applies, and only the latest clears the loading indicator.
  const older = t.begin('identity');
  const newer = t.begin('identity');
  assert.equal(t.accept(newer, 5), true);
  assert.equal(t.finish(newer), true);
  assert.equal(t.accept(older, 6), false, 'the older answer is dropped');
  assert.equal(t.finish(older), false);
  // A save replaces the record: a read begun before it is stale, and the saved value counts as just read.
  const before = t.begin('bank');
  t.wrote('bank', 100);
  assert.equal(t.isCurrent(before), false);
  assert.equal(t.accept(before, 101), false, 'a read older than the save never overwrites it');
  assert.equal(t.finish(before), true, 'but its loading indicator is cleared');
  assert.equal(t.shouldRead('bank', 100 + 59_000), false, 'the saved value is fresh');
  // Unmounted: nothing applies and nothing new is due.
  const late = t.begin('driving');
  t.setActive(false);
  assert.equal(t.accept(late, 1), false);
  assert.equal(t.finish(late), false);
  assert.equal(t.shouldRead('payroll', 0), false);
  t.setActive(true);
  assert.equal(t.shouldRead('payroll', 0), true, 'remounted (development double-mount) it works again');
  // The overview cache: fresh values only, by time.
  assert.equal(data.freshValue({ value: 'x', at: 0 }, 59_999), 'x');
  assert.equal(data.freshValue({ value: 'x', at: 0 }, 60_000), undefined);
  assert.equal(data.freshValue(undefined, 0), undefined);
});

test('DATA-03 the dashboard no longer reads Profile records on refresh, clears every reveal on background and guards saves', () => {
  const src = read('src/screens/GuardDashboardScreen.tsx');
  const loadDataFn = src.slice(src.indexOf('async function loadData('), src.indexOf('async function loadShiftAmendments('));
  for (const loader of ['loadIdentity', 'loadDriving', 'loadEmergencyContact', 'loadEmployments', 'loadBankDetails', 'loadPayrollAdmin', 'refreshMyCompanies']) {
    assert.doesNotMatch(loadDataFn, new RegExp(loader + '\\('), loader + ' is not called by loadData');
  }
  assert.match(loadDataFn, /readProfileViewRef\.current\(visibleProfileView\)/, 'only the Profile view on screen is revalidated');
  assert.doesNotMatch(src, /useEffect\(\(\) => \{\s*void refreshMyCompanies\(\);\s*\}/, 'no company read at start-up');
  const background = src.slice(src.indexOf("if (nextState === 'background' || nextState === 'inactive') {"), src.indexOf("if (nextState === 'active') {"));
  for (const clear of ['clearBankReveal()', 'clearReveal()', 'clearLicenceReveal()']) assert.ok(background.includes(clear), `background runs ${clear}`);
  // Every save of a masked record marks it written, so an older read cannot overwrite it.
  assert.equal((src.match(/profileReads\.wrote\('identity'/g) ?? []).length, 2, 'NINO and UTR saves');
  assert.equal((src.match(/profileReads\.wrote\('driving'/g) ?? []).length, 2, 'licence number and driving fields');
  assert.equal((src.match(/profileReads\.wrote\('emergencyContact'/g) ?? []).length, 2, 'save and remove');
  assert.equal((src.match(/profileReads\.wrote\('bank'/g) ?? []).length, 2, 'save and remove');
  // First-load flags start true, so a record not yet read never shows a misleading "not added".
  for (const flag of ['identityLoading', 'drivingLoading', 'emergencyContactLoading', 'employmentsLoading', 'payrollAdminLoading', 'bankLoading']) {
    assert.match(src, new RegExp(`const \\[${flag}, set\\w+\\] = useState\\(true\\)`), flag);
  }
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      passed += 1;
      console.log(`PASS  ${name}`);
    } catch (error) {
      console.error(`FAIL  ${name}`);
      console.error(error);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${passed} Guard Profile foundation checks passed`);
})();
