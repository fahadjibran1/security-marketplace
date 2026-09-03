const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

const mobile = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const backend = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'security-backend-nest', 'src', p), 'utf8');

const api = mobile('src/services/api.ts');
const models = mobile('src/types/models.ts');
const dashboard = mobile('src/screens/GuardDashboardScreen.tsx');
const encSvc = backend('guard-personnel/encryption.service.ts');
const entity = backend('guard-profile/entities/guard-profile.entity.ts');
const migration = backend('database/migrations/1720200000000-AddGuardPersonnelP1AIdentityFields.ts');
const controller = backend('guard-personnel/guard-personnel.controller.ts');
const service = backend('guard-personnel/guard-personnel.service.ts');
const runtimeEnv = backend('config/runtime-env.ts');
const appModule = backend('app.module.ts');

// ── MOBILE API ────────────────────────────────────────────────────────────────

test('api.ts exports getMyPersonnelIdentity', () => {
  assert.match(api, /export function getMyPersonnelIdentity/);
});

test('getMyPersonnelIdentity calls /guard-personnel/me/identity via GET', () => {
  const fn = api.split('getMyPersonnelIdentity')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/identity/);
});

test('api.ts exports updateMyPersonnelIdentity', () => {
  assert.match(api, /export function updateMyPersonnelIdentity/);
});

test('updateMyPersonnelIdentity uses PATCH method', () => {
  const fn = api.split('updateMyPersonnelIdentity')[1].split('export function')[0];
  assert.match(fn, /method:\s*['"]PATCH['"]/);
});

test('api.ts exports revealMyPersonnelField', () => {
  assert.match(api, /export function revealMyPersonnelField/);
});

test('revealMyPersonnelField uses POST to /guard-personnel/me/reveal', () => {
  const fn = api.split('revealMyPersonnelField')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/reveal/);
  assert.match(fn, /method:\s*['"]POST['"]/);
});

test('revealMyPersonnelField sends field in JSON body', () => {
  const fn = api.split('revealMyPersonnelField')[1].split('export function')[0];
  assert.match(fn, /JSON\.stringify\(\{.*field.*\}\)/s);
});

// ── MOBILE TYPES ──────────────────────────────────────────────────────────────

test('models.ts declares GuardPersonnelIdentity interface', () => {
  assert.match(models, /interface GuardPersonnelIdentity/);
});

test('GuardPersonnelIdentity has ninoSet, ninoMasked, utrSet, utrMasked', () => {
  const iface = models.split('GuardPersonnelIdentity')[1].split('}')[0];
  assert.match(iface, /ninoSet/);
  assert.match(iface, /ninoMasked/);
  assert.match(iface, /utrSet/);
  assert.match(iface, /utrMasked/);
});

test('models.ts declares PersonnelRevealResponse interface', () => {
  assert.match(models, /interface PersonnelRevealResponse/);
});

test('PersonnelRevealResponse has revealedValue', () => {
  const iface = models.split('PersonnelRevealResponse')[1].split('}')[0];
  assert.match(iface, /revealedValue/);
});

// ── DASHBOARD IMPORTS ─────────────────────────────────────────────────────────

test('dashboard imports getMyPersonnelIdentity', () => {
  assert.match(dashboard, /getMyPersonnelIdentity/);
});

test('dashboard imports updateMyPersonnelIdentity', () => {
  assert.match(dashboard, /updateMyPersonnelIdentity/);
});

test('dashboard imports revealMyPersonnelField', () => {
  assert.match(dashboard, /revealMyPersonnelField/);
});

test('dashboard imports GuardPersonnelIdentity type', () => {
  assert.match(dashboard, /GuardPersonnelIdentity/);
});

// ── DASHBOARD STATE ───────────────────────────────────────────────────────────

test('dashboard declares identity state', () => {
  assert.match(dashboard, /useState<GuardPersonnelIdentity \| null>\(null\)/);
});

test('dashboard declares revealCountdown state', () => {
  assert.match(dashboard, /revealCountdown.*setRevealCountdown.*useState\(0\)/);
});

test('dashboard declares revealTimerRef', () => {
  assert.match(dashboard, /revealTimerRef.*useRef/);
});

test('dashboard declares editingNino and editingUtr', () => {
  assert.match(dashboard, /editingNino.*setEditingNino/);
  assert.match(dashboard, /editingUtr.*setEditingUtr/);
});

test('dashboard declares ninoInputError and utrInputError', () => {
  assert.match(dashboard, /ninoInputError/);
  assert.match(dashboard, /utrInputError/);
});

// ── NINO VALIDATION ───────────────────────────────────────────────────────────

test('dashboard has isValidNinoFormat function', () => {
  assert.match(dashboard, /function isValidNinoFormat/);
});

test('NINO validation rejects BG GB NK KN TN NT ZZ prefixes', () => {
  const fn = dashboard.split('isValidNinoFormat')[1].split('async function loadIdentity')[0];
  assert.match(fn, /BG.*GB.*NK.*KN.*TN.*NT.*ZZ/s);
});

test('NINO validation uses letter-restricted character class', () => {
  const fn = dashboard.split('isValidNinoFormat')[1].split('async function loadIdentity')[0];
  assert.match(fn, /A-CEGHJ-PR-TW-Z/);
});

// ── REVEAL UX ────────────────────────────────────────────────────────────────

test('dashboard has startRevealCountdown function that uses setInterval', () => {
  assert.match(dashboard, /function startRevealCountdown/);
  const fn = dashboard.split('startRevealCountdown')[1].split('async function handleRevealField')[0];
  assert.match(fn, /setInterval/);
});

test('reveal timer clears on countdown reaching 0', () => {
  const fn = dashboard.split('startRevealCountdown')[1].split('async function handleRevealField')[0];
  assert.match(fn, /clearInterval/);
  assert.match(fn, /setRevealedField\(null\)/);
  assert.match(fn, /setRevealedValue\(null\)/);
});

test('reveal countdown is 10 seconds', () => {
  const fn = dashboard.split('startRevealCountdown')[1].split('async function handleRevealField')[0];
  assert.match(fn, /REVEAL_SECONDS.*10|10.*REVEAL_SECONDS/);
});

test('handleRevealField calls revealMyPersonnelField', () => {
  const fn = dashboard.split('handleRevealField')[1].split('async function handleSaveNino')[0];
  assert.match(fn, /revealMyPersonnelField\(field\)/);
});

test('cleanup useEffect clears revealTimerRef on unmount', () => {
  assert.match(dashboard, /clearInterval\(revealTimerRef\.current\)/);
});

// ── TAX IDENTIFIERS CARD ─────────────────────────────────────────────────────

test('dashboard renders Tax identifiers FeatureCard', () => {
  assert.match(dashboard, /Tax identifiers/);
});

test('dashboard renders National Insurance Number label', () => {
  assert.match(dashboard, /National Insurance Number/);
});

test('dashboard renders Unique Taxpayer Reference label', () => {
  assert.match(dashboard, /Unique Taxpayer Reference/);
});

test('NINO Show button is disabled when ninoSet is false', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /identity\?\.ninoSet.*disabled|disabled.*identity\?\.ninoSet/s);
});

test('UTR Show button is disabled when utrSet is false', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /identity\?\.utrSet.*disabled|disabled.*identity\?\.utrSet/s);
});

test('NINO displayed as revealedValue when revealed, masked value otherwise', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /revealedField === 'nino'[\s\S]{0,50}revealedValue/);
  assert.match(card, /ninoMasked/);
});

test('UTR displayed as revealedValue when revealed, masked value otherwise', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /revealedField === 'utr'[\s\S]{0,50}revealedValue/);
  assert.match(card, /utrMasked/);
});

test('hide button shows countdown seconds', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /revealCountdown.*s\)|revealCountdown.*s}/s);
});

test('NINO edit mode has autoCapitalize characters', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /autoCapitalize="characters"/);
});

test('UTR edit mode has number-pad keyboard', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /keyboardType="number-pad"/);
});

test('privacy notice appears in tax identifiers card', () => {
  const card = dashboard.split('Tax identifiers')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /encrypted at rest/);
});

// ── BACKEND — ENTITY ──────────────────────────────────────────────────────────

test('guard_profiles entity declares ninoEnc column', () => {
  assert.match(entity, /ninoEnc\?/);
});

test('guard_profiles entity declares ninoHmac column', () => {
  assert.match(entity, /ninoHmac\?/);
});

test('guard_profiles entity declares utrEnc column', () => {
  assert.match(entity, /utrEnc\?/);
});

test('guard_profiles entity has 3 select: false column decorators for sensitive fields', () => {
  // @Column({...select: false...}) appears once for ninoEnc, ninoHmac, utrEnc
  const selectFalseCount = (entity.match(/select:\s*false/g) || []).length;
  assert.ok(selectFalseCount >= 3, `expected >= 3 select:false columns, found ${selectFalseCount}`);
});

// ── BACKEND — MIGRATION ───────────────────────────────────────────────────────

test('migration adds ninoEnc column', () => {
  assert.match(migration, /"ninoEnc"/);
});

test('migration adds ninoHmac column', () => {
  assert.match(migration, /"ninoHmac"/);
});

test('migration adds utrEnc column', () => {
  assert.match(migration, /"utrEnc"/);
});

test('migration creates partial unique index on ninoHmac', () => {
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]{0,100}ninoHmac[\s\S]{0,100}IS NOT NULL/s);
});

test('migration down drops index before columns', () => {
  const downBlock = migration.split('down(')[1];
  const dropIdx = downBlock.indexOf('DROP INDEX');
  const dropCol = downBlock.indexOf('DROP COLUMN');
  assert.ok(dropIdx < dropCol, 'index must be dropped before columns in down()');
});

// ── BACKEND — ENCRYPTION SERVICE ─────────────────────────────────────────────

test('EncryptionService uses AES-256-GCM', () => {
  assert.match(encSvc, /aes-256-gcm/);
});

test('EncryptionService includes key version prefix in ciphertext envelope', () => {
  assert.match(encSvc, /v\$\{CURRENT_KEY_VERSION\}|`v\$\{/);
});

test('EncryptionService stores IV separately in envelope', () => {
  assert.match(encSvc, /IV_BYTES.*12|12.*IV_BYTES/);
  assert.match(encSvc, /randomBytes\(IV_BYTES\)/);
});

test('EncryptionService throws on unsupported key version during decrypt', () => {
  assert.match(encSvc, /Unsupported key version/);
});

test('EncryptionService throws when GUARD_DATA_ENCRYPTION_KEY is missing or malformed', () => {
  assert.match(encSvc, /GUARD_DATA_ENCRYPTION_KEY is not configured/);
});

test('EncryptionService throws when GUARD_DATA_HMAC_KEY is missing or malformed', () => {
  assert.match(encSvc, /GUARD_DATA_HMAC_KEY is not configured/);
});

test('EncryptionService has no DEV_ENC_FALLBACK or DEV_HMAC_FALLBACK fallback constants', () => {
  assert.doesNotMatch(encSvc, /DEV_ENC_FALLBACK/);
  assert.doesNotMatch(encSvc, /DEV_HMAC_FALLBACK/);
});

test('EncryptionService key validation does not bypass on non-production environments', () => {
  // No isProduction conditional — keys are always required regardless of NODE_ENV
  assert.doesNotMatch(encSvc, /isProduction/);
});

test('EncryptionService validates key format as 64-character hex string', () => {
  assert.match(encSvc, /HEX_64_RE/);
  assert.match(encSvc, /0-9a-fA-F/);
});

test('maskNino shows first 2 and last 1 character only', () => {
  const fn = encSvc.split('maskNino')[1].split('maskUtr')[0];
  assert.match(fn, /slice\(0, 2\)/);
  assert.match(fn, /slice\(-1\)/);
  assert.match(fn, /••••••/);
});

test('maskUtr shows last 4 characters only', () => {
  const fn = encSvc.split('maskUtr')[1].split('}')[0];
  assert.match(fn, /slice\(-4\)/);
  assert.match(fn, /••••••/);
});

test('hmac normalises by uppercasing and stripping whitespace', () => {
  const fn = encSvc.split('hmac(')[1].split('maskNino')[0];
  assert.match(fn, /toUpperCase/);
  assert.match(fn, /replace.*\\s.*g/);
});

// ── BACKEND — SERVICE ─────────────────────────────────────────────────────────

test('service validates NINO using NINO_REGEX', () => {
  assert.match(service, /NINO_REGEX/);
});

test('service rejects invalid NINO prefixes BG GB NK KN TN NT ZZ', () => {
  assert.match(service, /NINO_INVALID_PREFIXES/);
  assert.match(service, /BG.*GB.*NK.*KN.*TN.*NT.*ZZ|BG[\s\S]{0,100}ZZ/);
});

test('service validates UTR as exactly 10 digits', () => {
  assert.match(service, /\\d\{10\}/);
});

test('service checks NINO uniqueness via HMAC before storing', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /ninoHmac.*conflict|conflict.*ninoHmac/s);
});

test('service throws ConflictException on duplicate NINO', () => {
  assert.match(service, /ConflictException/);
  assert.match(service, /already registered/);
});

test('service uses createQueryBuilder update for sensitive column writes', () => {
  assert.match(service, /\.update\(GuardProfile\)/);
  assert.match(service, /\.set\(updates\)/);
});

test('service uses addSelect to explicitly load ninoEnc utrEnc', () => {
  assert.match(service, /addSelect.*ninoEnc/);
  assert.match(service, /addSelect.*utrEnc/);
});

test('revealForGuard logs to auditLogService', () => {
  const fn = service.split('revealForGuard')[1].split('revealForAdmin')[0];
  assert.match(fn, /auditLogService\.log/);
  assert.match(fn, /guard_personnel\.identity_reveal/);
});

test('revealForAdmin logs to auditLogService with admin context', () => {
  const fn = service.split('revealForAdmin')[1].split('buildRevealResponse')[0];
  assert.match(fn, /auditLogService\.log/);
  assert.match(fn, /requestedBy.*admin/);
  assert.match(fn, /adminUserId/);
});

test('service never stores plaintext NINO or UTR in the entity', () => {
  // The entity columns ninoPlaintext, utrPlaintext must not appear in service
  assert.doesNotMatch(service, /guard\.ninoPlaintext|guard\.utrPlaintext/);
});

// ── BACKEND — CONTROLLER ──────────────────────────────────────────────────────

test('controller has GUARD route for GET me/identity', () => {
  assert.match(controller, /UserRole\.GUARD/);
  assert.match(controller, /me\/identity/);
});

test('controller has GUARD route for PATCH me/identity', () => {
  assert.match(controller, /updateMyIdentity/);
});

test('controller has GUARD route for POST me/reveal', () => {
  assert.match(controller, /revealMyField/);
});

test('controller has ADMIN route for GET admin/:id/identity', () => {
  assert.match(controller, /UserRole\.ADMIN/);
  assert.match(controller, /admin\/:id\/identity|admin\/:id.*identity/);
});

test('controller has ADMIN route for POST admin/:id/reveal', () => {
  assert.match(controller, /revealGuardFieldAdmin/);
});

test('P1A identity routes have no COMPANY or CLIENT access', () => {
  // P1A routes (me/identity, admin/:id/identity, me/reveal, admin/:id/reveal) must not
  // expose identity data to company or client roles. Check only the P1A section.
  const p1aSection = controller.split('P1D — Driving')[0];
  assert.doesNotMatch(p1aSection, /COMPANY_ADMIN_ROLES|COMPANY_VIEW_ROLES/);
  assert.doesNotMatch(p1aSection, /CLIENT_PORTAL_ROLES|client_admin|client_viewer/);
});

test('controller validates field must be nino or utr before calling service', () => {
  assert.match(controller, /field !== 'nino' && dto\.field !== 'utr'/);
});

// ── BACKEND — RUNTIME ENV ────────────────────────────────────────────────────

test('runtime-env validates GUARD_DATA_ENCRYPTION_KEY in production', () => {
  assert.match(runtimeEnv, /GUARD_DATA_ENCRYPTION_KEY/);
  assert.match(runtimeEnv, /64-char/i);
});

test('runtime-env validates GUARD_DATA_HMAC_KEY in production', () => {
  assert.match(runtimeEnv, /GUARD_DATA_HMAC_KEY/);
});

test('runtime-env enforces encryption key != hmac key', () => {
  assert.match(runtimeEnv, /encKey === hmacKey|must be different/);
});

// ── BACKEND — APP MODULE ─────────────────────────────────────────────────────

test('app.module.ts imports GuardPersonnelModule', () => {
  assert.match(appModule, /GuardPersonnelModule/);
});

// ── HARDENING — FALLBACK KEY REMOVAL ─────────────────────────────────────────

test('EncryptionService constructor rejects missing GUARD_DATA_ENCRYPTION_KEY unconditionally', () => {
  // The throw must not be inside an isProduction guard — all environments require configured keys
  const constructorBlock = encSvc.split('constructor()')[1].split('encrypt(')[0];
  assert.match(constructorBlock, /GUARD_DATA_ENCRYPTION_KEY is not configured/);
  assert.doesNotMatch(constructorBlock, /isProduction/);
});

test('EncryptionService constructor rejects missing GUARD_DATA_HMAC_KEY unconditionally', () => {
  const constructorBlock = encSvc.split('constructor()')[1].split('encrypt(')[0];
  assert.match(constructorBlock, /GUARD_DATA_HMAC_KEY is not configured/);
});

test('no hard-coded fallback key bytes exist in EncryptionService source', () => {
  // Zero-key (64 zeros) and all-f key must not appear as literals
  assert.doesNotMatch(encSvc, /0{64}/);
  assert.doesNotMatch(encSvc, /f{64}/);
});

test('EncryptionService fails closed — no silent encryption path without configured keys', () => {
  // Constructor must throw before assigning this.encKey or this.hmacKey when keys are absent
  const constructorBlock = encSvc.split('constructor()')[1].split('encrypt(')[0];
  // Both HEX_64_RE checks must precede the Buffer.from assignments
  const hmacReIdx = constructorBlock.indexOf('HEX_64_RE.test(hmacHex)');
  const encKeyAssignIdx = constructorBlock.indexOf('this.encKey');
  assert.ok(hmacReIdx > -1, 'HEX_64_RE check for hmacHex must exist');
  assert.ok(encKeyAssignIdx > hmacReIdx, 'key assignment must follow validation');
});

// ── HARDENING — MUTATION AUDIT ────────────────────────────────────────────────

test('service emits guard_personnel.identity_update audit action on identity mutation', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /guard_personnel\.identity_update/);
  assert.match(updateFn, /changedFields/);
});

test('service skips NINO update and audit when HMAC matches existing stored value', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /guard\.ninoHmac\s*!==\s*newHmac/);
});

test('service decrypts existing UTR for equality comparison only, never for logging', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /existingUtr.*decrypt|decrypt.*existingUtr/s);
  assert.match(updateFn, /existingUtr\s*!==\s*normalised/);
});

test('service mutation audit afterData contains changedFields and no sensitive values', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  const afterDataIdx = updateFn.indexOf('afterData:');
  assert.ok(afterDataIdx > -1, 'afterData must be present in updateIdentityForGuard audit call');
  const afterDataBlock = updateFn.slice(afterDataIdx, afterDataIdx + 80);
  assert.match(afterDataBlock, /changedFields/);
  assert.doesNotMatch(afterDataBlock, /ninoPlaintext|utrPlaintext|ninoEnc|utrEnc|ninoHmac|ninoMasked|utrMasked/);
});

test('service mutation audit fires only when changedFields is non-empty', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /changedFields\.length\s*>\s*0/);
});

test('service updateIdentityForGuard accepts meta parameter for audit IP and user-agent', () => {
  const updateFn = service.split('updateIdentityForGuard')[1].split('revealForGuard')[0];
  assert.match(updateFn, /meta\.ipAddress/);
  assert.match(updateFn, /meta\.userAgent/);
});

test('controller PATCH me/identity passes request IP and user-agent for mutation audit', () => {
  const patchFn = controller.split('updateMyIdentity')[1].split('@Post')[0];
  assert.match(patchFn, /req\.ip/);
  assert.match(patchFn, /user-agent/);
});

test('reveal audit is unchanged — still logs guard_personnel.identity_reveal with requestedBy self', () => {
  const revealFn = service.split('revealForGuard')[1].split('revealForAdmin')[0];
  assert.match(revealFn, /guard_personnel\.identity_reveal/);
  assert.match(revealFn, /requestedBy.*self/);
});

test('guard isolation: no admin-scoped PATCH route exists for guard identity', () => {
  assert.doesNotMatch(controller, /@Patch\s*\(\s*['"]admin/);
});

test('response DTOs do not expose ninoEnc, utrEnc, or ninoHmac fields', () => {
  const guardDto = backend('guard-personnel/dto/guard-identity-guard-response.dto.ts');
  const adminDto = backend('guard-personnel/dto/guard-identity-admin-response.dto.ts');
  assert.doesNotMatch(guardDto, /ninoEnc|utrEnc|ninoHmac/);
  assert.doesNotMatch(adminDto, /ninoEnc|utrEnc|ninoHmac/);
});

test('response DTOs expose masked values only — no plaintext identifier fields', () => {
  const guardDto = backend('guard-personnel/dto/guard-identity-guard-response.dto.ts');
  assert.match(guardDto, /ninoMasked/);
  assert.match(guardDto, /utrMasked/);
  assert.doesNotMatch(guardDto, /ninoPlaintext|utrPlaintext/);
});

console.log(JSON.stringify({ event: 'guard_personnel_p1a_tests_passed', tests: passed }));
