'use strict';
// P1G-A — Guard Bank Details — Static file analysis spec
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(`     ${err.message}`);
  }
}

const mobile = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const backend = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'security-backend-nest', 'src', p), 'utf8');

const api        = mobile('src/services/api.ts');
const models     = mobile('src/types/models.ts');
const dashboard  = mobile('src/screens/GuardDashboardScreen.tsx');
const entity     = backend('guard-personnel/entities/guard-bank-details.entity.ts');
const migration  = backend('database/migrations/1720600000000-AddGuardBankDetailsP1GA.ts');
const controller = backend('guard-personnel/guard-personnel.controller.ts');
const service    = backend('guard-personnel/bank-details.service.ts');
const module_    = backend('guard-personnel/guard-personnel.module.ts');
const entities   = backend('database/entities.ts');
const guardDto   = backend('guard-personnel/dto/bank-details-guard-response.dto.ts');
const revealDto  = backend('guard-personnel/dto/bank-details-reveal.dto.ts');
const companyDto = backend('guard-personnel/dto/bank-details-company-response.dto.ts');
const updateDto  = backend('guard-personnel/dto/update-guard-bank-details.dto.ts');

// ── ENTITY STRUCTURE ──────────────────────────────────────────────────────────

test('entity table name is guard_bank_details', () => {
  assert.match(entity, /guard_bank_details/);
});

test('entity has one-to-one relation with GuardProfile via guardId', () => {
  assert.match(entity, /OneToOne/);
  assert.match(entity, /GuardProfile/);
  assert.match(entity, /guardId/);
});

test('entity guardId column has unique: true', () => {
  assert.match(entity, /unique:\s*true/);
});

test('entity FK is ON DELETE CASCADE', () => {
  assert.match(entity, /onDelete.*CASCADE/);
});

test('entity has accountHolderNameEnc with select: false', () => {
  assert.match(entity, /accountHolderNameEnc/);
  // encrypted column must not be selected by default
  assert.match(entity, /select:\s*false/);
});

test('entity has sortCodeEnc with select: false', () => {
  assert.match(entity, /sortCodeEnc/);
  assert.match(entity, /select:\s*false/);
});

test('entity has accountNumberEnc with select: false', () => {
  assert.match(entity, /accountNumberEnc/);
  assert.match(entity, /select:\s*false/);
});

test('entity encrypted columns are TEXT NULL', () => {
  // All three must be text nullable
  assert.match(entity, /type.*text.*nullable.*true|nullable.*true.*type.*text/);
});

test('entity has no bank name / IBAN / BIC / SWIFT / roll number fields', () => {
  assert.doesNotMatch(entity, /bankName|iban|bic|swift|rollNumber/i);
});

test('entity has no HMAC or fingerprint columns', () => {
  assert.doesNotMatch(entity, /hmac|Hmac|fingerprint|Fingerprint/);
});

test('entity has no payment method / payroll reference / NINO / UTR fields', () => {
  assert.doesNotMatch(entity, /paymentMethod|payrollRef|ninoEnc|utrEnc/);
});

// ── ENCRYPTION: no deterministic / no new keys ─────────────────────────────────

test('service uses GUARD_DATA_ENCRYPTION_KEY not a new key', () => {
  assert.doesNotMatch(service, /BANK_ENCRYPTION_KEY|BANK_DATA_KEY|NEW_KEY/);
});

test('service does not HMAC bank fields', () => {
  assert.doesNotMatch(service, /hmac|Hmac/);
});

test('service uses encryptionService.encrypt and .decrypt only', () => {
  assert.match(service, /encryptionService\.encrypt/);
  assert.match(service, /encryptionService\.decrypt/);
});

// ── SENSITIVE SELECT PATTERN ──────────────────────────────────────────────────

test('service has findWithSensitive method using addSelect', () => {
  assert.match(service, /findWithSensitive/);
  assert.match(service, /addSelect.*accountHolderNameEnc|addSelect.*sortCodeEnc|addSelect.*accountNumberEnc/);
});

test('service addSelect loads all three encrypted columns explicitly', () => {
  assert.match(service, /addSelect.*accountHolderNameEnc/);
  assert.match(service, /addSelect.*sortCodeEnc/);
  assert.match(service, /addSelect.*accountNumberEnc/);
});

test('company GET uses findWithSensitive to generate masked values', () => {
  // getBankDetailsForCompany must NOT use plain findOne for its final data source
  // It must call findWithSensitive for masked output generation
  assert.match(service, /getBankDetailsForCompany[\s\S]{0,500}findWithSensitive/);
});

// ── NORMALISATION & MASKING ───────────────────────────────────────────────────

test('service normalises sort code stripping hyphens and spaces', () => {
  assert.match(service, /replace.*[-\\s]|replace.*\\[-\\s\\]/);
  assert.match(service, /\\d\{6\}|\\d{6}/);
});

test('service normalises account number stripping spaces to 8 digits', () => {
  assert.match(service, /\\d\{8\}|\\d{8}/);
});

test('service masks sort code as ••-••-XX (last 2 digits)', () => {
  assert.match(service, /••-••-/);
  assert.match(service, /slice\(4\)/);
});

test('service masks account number as ••••XXXX (last 4 digits)', () => {
  assert.match(service, /••••/);
  assert.match(service, /slice\(4\)/);
});

test('service masks account holder name as •••••• (fully hidden)', () => {
  assert.match(service, /••••••/);
});

// ── COMPLETE-RECORD SEMANTICS ─────────────────────────────────────────────────

test('service enforces all three fields on first create', () => {
  assert.match(service, /All three fields are required/);
});

test('service rejects partial record after update', () => {
  assert.match(service, /must remain complete|use DELETE to remove/);
});

test('service requires confirmReplace: true when changing an existing record', () => {
  assert.match(service, /confirmReplace/);
  assert.match(service, /ConflictException/);
});

test('service no-op detection: returns existing state when normalised values unchanged', () => {
  assert.match(service, /No-op|no-op|no op|anyChange/);
  assert.match(service, /return.*toGuardDto.*existing|return this\.toGuardDto.*existing/);
});

// ── AUDIT EVENTS ──────────────────────────────────────────────────────────────

test('service emits bank_details_create audit event', () => {
  assert.match(service, /guard_personnel\.bank_details_create/);
});

test('service emits bank_details_update audit event', () => {
  assert.match(service, /guard_personnel\.bank_details_update/);
});

test('service emits bank_details_remove audit event', () => {
  assert.match(service, /guard_personnel\.bank_details_remove/);
});

test('service emits bank_details_reveal audit event', () => {
  assert.match(service, /guard_personnel\.bank_details_reveal/);
});

test('audit afterData contains changedFields not values', () => {
  assert.match(service, /changedFields/);
  // audit must never include accountHolderName value, only field name reference
  assert.doesNotMatch(service, /afterData.*accountHolderName.*:/);
});

test('service never logs plaintext or ciphertext in audit', () => {
  // afterData for create/update should only have guardId and changedFields
  assert.match(service, /afterData.*guardId.*changedFields|changedFields.*guardId/);
});

// ── ACCESS CONTROL ────────────────────────────────────────────────────────────

test('controller guard self-service routes have @Roles(UserRole.GUARD)', () => {
  assert.match(controller, /me\/bank-details/);
  assert.match(controller, /UserRole\.GUARD/);
});

test('controller company route has @Roles(UserRole.COMPANY, UserRole.COMPANY_ADMIN)', () => {
  assert.match(controller, /company\/guard\/:guardId\/bank-details/);
  assert.match(controller, /UserRole\.COMPANY.*UserRole\.COMPANY_ADMIN|UserRole\.COMPANY_ADMIN.*UserRole\.COMPANY/);
});

test('controller admin route has @Roles(UserRole.ADMIN)', () => {
  assert.match(controller, /admin\/:id\/bank-details/);
  assert.match(controller, /UserRole\.ADMIN/);
});

test('COMPANY_STAFF has zero bank-details routes', () => {
  // No bank-details route must have COMPANY_STAFF role
  const bankRouteBlocks = controller.match(/bank-details[\s\S]{0,300}/g) || [];
  bankRouteBlocks.forEach((block) => {
    assert.doesNotMatch(block, /COMPANY_STAFF/);
  });
});

test('no reveal route for Admin in P1G-A', () => {
  // admin/:id/bank-details/reveal must NOT exist
  assert.doesNotMatch(controller, /admin.*bank-details\/reveal/);
  assert.doesNotMatch(controller, /getBankDetailsForAdmin.*reveal|revealForAdmin.*bank/);
});

test('service requireOwnedActiveRelationship enforces ACTIVE status for company', () => {
  assert.match(service, /requireOwnedActiveRelationship/);
  assert.match(service, /CompanyGuardStatus\.ACTIVE/);
});

test('company DTO does not expose accountHolderName', () => {
  assert.doesNotMatch(companyDto, /accountHolderName/);
});

test('guard reveal DTO exposes all three plaintext fields', () => {
  assert.match(revealDto, /accountHolderName/);
  assert.match(revealDto, /sortCode/);
  assert.match(revealDto, /accountNumber/);
});

// ── ROUTES ────────────────────────────────────────────────────────────────────

test('controller has GET me/bank-details route', () => {
  assert.match(controller, /Get\('me\/bank-details'\)/);
});

test('controller has PATCH me/bank-details route', () => {
  assert.match(controller, /Patch\('me\/bank-details'\)/);
});

test('controller has POST me/bank-details/reveal route', () => {
  assert.match(controller, /Post\('me\/bank-details\/reveal'\)/);
});

test('controller has DELETE me/bank-details with 204 response', () => {
  assert.match(controller, /Delete\('me\/bank-details'\)/);
  assert.match(controller, /HttpStatus\.NO_CONTENT/);
});

test('controller has GET company/guard/:guardId/bank-details route', () => {
  assert.match(controller, /Get\('company\/guard\/:guardId\/bank-details'\)/);
});

test('controller has GET admin/:id/bank-details route', () => {
  assert.match(controller, /Get\('admin\/:id\/bank-details'\)/);
});

// ── MODULE & ENTITIES REGISTRATION ───────────────────────────────────────────

test('module registers GuardBankDetails entity in TypeOrmModule.forFeature', () => {
  assert.match(module_, /GuardBankDetails/);
  assert.match(module_, /TypeOrmModule\.forFeature/);
});

test('module registers BankDetailsService as provider', () => {
  assert.match(module_, /BankDetailsService/);
  assert.match(module_, /providers:/);
});

test('database entities.ts exports GuardBankDetails', () => {
  assert.match(entities, /GuardBankDetails/);
  assert.match(entities, /guard-bank-details\.entity/);
});

// ── MIGRATION ────────────────────────────────────────────────────────────────

test('migration creates guard_bank_details table', () => {
  assert.match(migration, /CREATE TABLE.*guard_bank_details/);
});

test('migration guardId column has UNIQUE constraint', () => {
  assert.match(migration, /UNIQUE.*guardId|UQ_guard_bank_details/);
});

test('migration has FK to guard_profiles ON DELETE CASCADE', () => {
  assert.match(migration, /REFERENCES.*guard_profiles/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test('migration encrypted columns are text NULL', () => {
  assert.match(migration, /accountHolderNameEnc.*text.*NULL|text.*NULL.*accountHolderNameEnc/);
  assert.match(migration, /sortCodeEnc.*text.*NULL|text.*NULL.*sortCodeEnc/);
  assert.match(migration, /accountNumberEnc.*text.*NULL|text.*NULL.*accountNumberEnc/);
});

test('migration down() drops table', () => {
  assert.match(migration, /DROP TABLE.*guard_bank_details/);
});

test('migration does not create enum types', () => {
  assert.doesNotMatch(migration, /CREATE TYPE/);
});

// ── DTO STRUCTURE ─────────────────────────────────────────────────────────────

test('UpdateGuardBankDetailsDto has optional fields only', () => {
  assert.match(updateDto, /IsOptional/);
  assert.match(updateDto, /accountHolderName/);
  assert.match(updateDto, /sortCode/);
  assert.match(updateDto, /accountNumber/);
  assert.match(updateDto, /confirmReplace/);
});

test('UpdateGuardBankDetailsDto does not include bankName / IBAN / BIC', () => {
  assert.doesNotMatch(updateDto, /bankName|iban|bic|swift/i);
});

test('guard response DTO has guardId bankSet masked fields updatedAt', () => {
  assert.match(guardDto, /guardId/);
  assert.match(guardDto, /bankSet/);
  assert.match(guardDto, /accountHolderNameMasked/);
  assert.match(guardDto, /sortCodeMasked/);
  assert.match(guardDto, /accountNumberMasked/);
  assert.match(guardDto, /updatedAt/);
});

// ── MOBILE API ────────────────────────────────────────────────────────────────

test('api.ts exports getMyBankDetails calling guard-personnel/me/bank-details', () => {
  assert.match(api, /getMyBankDetails/);
  assert.match(api, /guard-personnel\/me\/bank-details/);
});

test('api.ts exports upsertMyBankDetails with PATCH method', () => {
  assert.match(api, /upsertMyBankDetails/);
  assert.match(api, /PATCH/);
});

test('api.ts exports revealMyBankDetails with POST method', () => {
  assert.match(api, /revealMyBankDetails/);
  assert.match(api, /bank-details\/reveal/);
  assert.match(api, /POST/);
});

test('api.ts exports deleteMyBankDetails with DELETE method', () => {
  assert.match(api, /deleteMyBankDetails/);
  assert.match(api, /DELETE/);
});

test('api.ts exports getCompanyGuardBankDetails', () => {
  assert.match(api, /getCompanyGuardBankDetails/);
  assert.match(api, /company\/guard/);
});

// ── MOBILE MODELS ─────────────────────────────────────────────────────────────

test('models.ts has GuardBankDetailsSummary with masked fields', () => {
  assert.match(models, /GuardBankDetailsSummary/);
  assert.match(models, /accountHolderNameMasked/);
  assert.match(models, /sortCodeMasked/);
  assert.match(models, /accountNumberMasked/);
});

test('models.ts has GuardBankDetailsReveal with plaintext fields', () => {
  assert.match(models, /GuardBankDetailsReveal/);
  assert.match(models, /accountHolderName/);
  assert.match(models, /sortCode/);
  assert.match(models, /accountNumber/);
});

test('models.ts has CompanyGuardBankSummary without accountHolderName', () => {
  assert.match(models, /CompanyGuardBankSummary/);
  assert.match(models, /sortCodeMasked/);
  assert.match(models, /accountNumberMasked/);
  // CompanyGuardBankSummary must not expose accountHolderName
  const companyBlock = models.match(/CompanyGuardBankSummary[\s\S]{0,400}/)?.[0] ?? '';
  assert.doesNotMatch(companyBlock, /accountHolderNameMasked/);
});

test('models.ts has UpdateBankDetailsPayload with confirmReplace', () => {
  assert.match(models, /UpdateBankDetailsPayload/);
  assert.match(models, /confirmReplace/);
});

// ── MOBILE UI — STATIC ANALYSIS ──────────────────────────────────────────────
// All tests in this section are STATIC ANALYSIS of source code.
// They are not runtime integration tests.

test('[STATIC ANALYSIS] dashboard imports getMyBankDetails, revealMyBankDetails, deleteMyBankDetails, upsertMyBankDetails', () => {
  assert.match(dashboard, /getMyBankDetails/);
  assert.match(dashboard, /revealMyBankDetails/);
  assert.match(dashboard, /deleteMyBankDetails/);
  assert.match(dashboard, /upsertMyBankDetails/);
});

test('[STATIC ANALYSIS] dashboard has Bank Details feature card', () => {
  assert.match(dashboard, /Bank Details/);
  assert.match(dashboard, /FeatureCard/);
});

// ── Reveal confirmation ───────────────────────────────────────────────────────

test('[STATIC ANALYSIS] reveal requires explicit Alert confirmation before API call', () => {
  // handleRevealBankDetails must show Alert.alert before calling revealMyBankDetails.
  // Pattern: Alert.alert block wraps the actual API call.
  const revealFnBlock = dashboard.match(/handleRevealBankDetails[\s\S]{0,600}/)?.[0] ?? '';
  assert.match(revealFnBlock, /Alert\.alert/);
  assert.match(revealFnBlock, /Show bank details|Show details|show.*bank/i);
});

test('[STATIC ANALYSIS] reveal Cancel causes no API call (API call nested inside onPress of confirmation)', () => {
  // revealMyBankDetails must be inside an Alert onPress callback, not at the top level of the handler.
  // The handler wraps the API call in Alert.alert onPress — Cancel path never reaches the API.
  const revealFnBlock = dashboard.match(/handleRevealBankDetails[\s\S]{0,700}/)?.[0] ?? '';
  // API call must appear after Alert.alert, nested inside onPress
  const alertIdx = revealFnBlock.indexOf('Alert.alert');
  const apiIdx = revealFnBlock.indexOf('revealMyBankDetails()');
  assert.ok(alertIdx !== -1, 'Alert.alert not found in reveal handler');
  assert.ok(apiIdx !== -1, 'revealMyBankDetails() call not found in reveal handler');
  assert.ok(apiIdx > alertIdx, 'API call must appear after Alert.alert (nested in onPress)');
});

test('[STATIC ANALYSIS] reveal Confirm calls revealMyBankDetails API', () => {
  assert.match(dashboard, /revealMyBankDetails\(\)/);
});

// ── Replacement confirmation ──────────────────────────────────────────────────

test('[STATIC ANALYSIS] replace existing bank details requires Alert confirmation (not silent)', () => {
  // handleSaveBankDetails must NOT silently set confirmReplace:true and call API.
  // It must call Alert.alert first when isExisting is true.
  const saveFnBlock = dashboard.match(/handleSaveBankDetails[\s\S]{0,1000}/)?.[0] ?? '';
  assert.match(saveFnBlock, /Alert\.alert/);
  assert.match(saveFnBlock, /Replace bank details|replace.*bank|replace.*existing/i);
});

test('[STATIC ANALYSIS] replace Cancel path does not call upsertMyBankDetails', () => {
  // In the replacement Alert, only the onPress (Confirm) button calls executeBankDetailsSave.
  // The Cancel button has style: cancel and no onPress with the API call.
  const saveFnBlock = dashboard.match(/handleSaveBankDetails[\s\S]{0,1200}/)?.[0] ?? '';
  assert.match(saveFnBlock, /style:\s*'cancel'/);
  // executeBankDetailsSave or confirmReplace:true assignment must be inside an onPress
  assert.match(saveFnBlock, /onPress.*confirmReplace|confirmReplace[\s\S]{0,50}executeBankDetailsSave/);
});

test('[STATIC ANALYSIS] replace Confirm sends confirmReplace: true', () => {
  assert.match(dashboard, /confirmReplace.*true|confirmReplace:\s*true/);
});

test('[STATIC ANALYSIS] first-time bank details creation does NOT require confirmation Alert', () => {
  // executeBankDetailsSave is called directly (not inside Alert) for new records.
  // The spec says no confirmation is required on first creation.
  assert.match(dashboard, /executeBankDetailsSave/);
  assert.match(dashboard, /First-time creation|no confirmation|isExisting/);
});

// ── Reveal lifecycle ──────────────────────────────────────────────────────────

test('[STATIC ANALYSIS] 15-second auto-hide countdown clears bankReveal', () => {
  assert.match(dashboard, /REVEAL_SECONDS.*15|15.*REVEAL_SECONDS/);
  assert.match(dashboard, /setBankReveal\(null\)/);
});

test('[STATIC ANALYSIS] manual Hide now button calls clearBankReveal', () => {
  assert.match(dashboard, /clearBankReveal/);
  assert.match(dashboard, /Hide now/);
});

test('[STATIC ANALYSIS] AppState background clears bank reveal', () => {
  assert.match(dashboard, /AppState/);
  assert.match(dashboard, /background/);
  assert.match(dashboard, /clearBankReveal/);
});

test('[STATIC ANALYSIS] AppState inactive clears bank reveal', () => {
  assert.match(dashboard, /inactive/);
  // AppState listener must handle both background and inactive
  const appStateBlock = dashboard.match(/handleAppStateChange[\s\S]{0,200}/)?.[0] ?? '';
  assert.match(appStateBlock, /inactive/);
  assert.match(appStateBlock, /clearBankReveal/);
});

test('[STATIC ANALYSIS] AppState addEventListener subscription is removed on cleanup', () => {
  assert.match(dashboard, /AppState\.addEventListener/);
  assert.match(dashboard, /sub\.remove\(\)/);
});

test('[STATIC ANALYSIS] unmount cleanup clears bankRevealTimerRef', () => {
  assert.match(dashboard, /bankRevealTimerRef\.current.*clearInterval|clearInterval.*bankRevealTimerRef/);
});

// ── Persistence / leakage ─────────────────────────────────────────────────────

test('[STATIC ANALYSIS] revealed bank data never written to AsyncStorage or SecureStore', () => {
  assert.doesNotMatch(dashboard, /AsyncStorage.*bankReveal|SecureStore.*bankReveal|bankReveal.*AsyncStorage|bankReveal.*SecureStore/);
});

test('[STATIC ANALYSIS] revealed bank data never written to console.log', () => {
  assert.doesNotMatch(dashboard, /console\.log.*bankReveal|bankReveal.*console\.log/);
});

test('[STATIC ANALYSIS] revealed bank data held only in component state (setBankReveal)', () => {
  assert.match(dashboard, /setBankReveal/);
});

test('[STATIC ANALYSIS] dashboard has delete bank details with Alert confirmation', () => {
  assert.match(dashboard, /Remove bank details|remove.*bank|bank.*remove/i);
  assert.match(dashboard, /Alert\.alert/);
});

// ── SECURITY: no forbidden fields ────────────────────────────────────────────

test('service has no bankName IBAN BIC SWIFT or deterministic encryption', () => {
  assert.doesNotMatch(service, /bankName|iban|bic|swift/i);
  assert.doesNotMatch(service, /deterministicEncrypt|createCipheriv.*aes-256-gcm.*static/i);
});

test('entity never stores sort code or account number in plaintext column', () => {
  // All sensitive columns must end in 'Enc' (encrypted)
  assert.doesNotMatch(entity, /sortCode[^E]|accountNumber[^E]/);
});

// ── PRIOR SLICE REGRESSION ────────────────────────────────────────────────────

test('P1E service still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/emergency-contact.service.ts'));
});

test('P1F service still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/employment.service.ts'));
});

test('P1D service still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/driving-transport.service.ts'));
});

test('P1A service still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/guard-personnel.service.ts'));
});

test('P1E migration still present (regression)', () => {
  assert.doesNotThrow(() => backend('database/migrations/1720400000000-AddGuardEmergencyContactP1E.ts'));
});

test('P1F migration still present (regression)', () => {
  assert.doesNotThrow(() => backend('database/migrations/1720500000000-AddCompanyGuardEmploymentP1F.ts'));
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
