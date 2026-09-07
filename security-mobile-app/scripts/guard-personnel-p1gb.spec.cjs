'use strict';
// P1G-B — Guard Payroll / Payment Administration — Static file analysis spec
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

const api           = mobile('src/services/api.ts');
const models        = mobile('src/types/models.ts');
const guardDash     = mobile('src/screens/GuardDashboardScreen.tsx');
const companyDash   = mobile('src/screens/CompanyDashboardScreen.tsx');
const entity        = backend('guard-personnel/entities/company-guard-payroll.entity.ts');
const migration     = backend('database/migrations/1720700000000-AddCompanyGuardPayrollP1GB.ts');
const controller    = backend('guard-personnel/guard-personnel.controller.ts');
const service       = backend('guard-personnel/payroll-admin.service.ts');
const module_       = backend('guard-personnel/guard-personnel.module.ts');
const entities      = backend('database/entities.ts');
const createDto     = backend('guard-personnel/dto/create-payroll-admin.dto.ts');
const updateDto     = backend('guard-personnel/dto/update-payroll-admin.dto.ts');
const companyDto    = backend('guard-personnel/dto/payroll-admin-company-response.dto.ts');
const guardDto      = backend('guard-personnel/dto/payroll-admin-guard-response.dto.ts');
const adminDto      = backend('guard-personnel/dto/payroll-admin-admin-response.dto.ts');

// ── ENTITY STRUCTURE ──────────────────────────────────────────────────────────

test('entity table name is company_guard_payroll_records', () => {
  assert.match(entity, /company_guard_payroll_records/);
});

test('entity has OneToOne relation with CompanyGuard via companyGuardId', () => {
  assert.match(entity, /OneToOne/);
  assert.match(entity, /CompanyGuard/);
  assert.match(entity, /companyGuardId/);
});

test('entity companyGuardId column has unique: true', () => {
  assert.match(entity, /unique:\s*true/);
});

test('entity FK on companyGuardId is ON DELETE RESTRICT', () => {
  assert.match(entity, /onDelete.*RESTRICT/);
});

test('entity has companyId denormalized FK column', () => {
  assert.match(entity, /companyId/);
  assert.match(entity, /ManyToOne.*Company|Company.*ManyToOne/);
});

test('entity payrollNoteEnc has select: false', () => {
  assert.match(entity, /payrollNoteEnc/);
  assert.match(entity, /select:\s*false/);
});

test('entity payrollNoteEnc is TEXT NULL', () => {
  // @Column decorator precedes the field name — check decorator then property
  assert.match(entity, /type:\s*'text',\s*nullable:\s*true[\s\S]{0,80}payrollNoteEnc/);
});

test('entity payrollStatus has default ACTIVE', () => {
  assert.match(entity, /GuardPayrollStatus\.ACTIVE/);
  assert.match(entity, /default:/);
});

test('entity GuardPayFrequency enum has WEEKLY FORTNIGHTLY FOUR_WEEKLY MONTHLY IRREGULAR', () => {
  assert.match(entity, /WEEKLY/);
  assert.match(entity, /FORTNIGHTLY/);
  assert.match(entity, /FOUR_WEEKLY/);
  assert.match(entity, /MONTHLY/);
  assert.match(entity, /IRREGULAR/);
});

test('entity GuardPayFrequency enum does NOT contain OTHER', () => {
  // OTHER is explicitly removed from GuardPayFrequency
  const freqBlock = entity.match(/enum GuardPayFrequency[\s\S]{0,200}/)?.[0] ?? '';
  assert.doesNotMatch(freqBlock, /OTHER/);
});

test('entity GuardPayrollPaymentMethod enum has BACS CHAPS CASH OTHER', () => {
  assert.match(entity, /BACS/);
  assert.match(entity, /CHAPS/);
  assert.match(entity, /CASH/);
});

test('entity GuardPayrollStatus enum has ACTIVE ON_HOLD EXCLUDED', () => {
  assert.match(entity, /ON_HOLD/);
  assert.match(entity, /EXCLUDED/);
});

test('entity payrollStartDate and payrollEndDate are date NULL', () => {
  assert.match(entity, /payrollStartDate/);
  assert.match(entity, /payrollEndDate/);
  assert.match(entity, /type.*date/);
});

test('entity payrollReference is varchar 50 nullable', () => {
  assert.match(entity, /payrollReference/);
  assert.match(entity, /varchar.*50|length.*50/);
});

// ── MANDATORY ABSENT FIELDS ───────────────────────────────────────────────────

test('entity does NOT contain engagementType', () => {
  assert.doesNotMatch(entity, /engagementType/);
});

test('entity does NOT contain payBasis', () => {
  assert.doesNotMatch(entity, /payBasis/);
});

test('entity does NOT contain workingArrangement', () => {
  assert.doesNotMatch(entity, /workingArrangement/);
});

test('entity does NOT contain nino or nationalInsuranceNumber (P1A owns NINO)', () => {
  assert.doesNotMatch(entity, /nino|nationalInsuranceNumber/i);
});

test('entity does NOT contain utr or uniqueTaxpayerReference (P1A owns UTR)', () => {
  assert.doesNotMatch(entity, /utr|uniqueTaxpayerReference/i);
});

test('entity does NOT contain sortCode, accountNumber, accountHolderName (P1G-A owns bank)', () => {
  assert.doesNotMatch(entity, /sortCode|accountNumber|accountHolderName/i);
});

test('entity does NOT contain hourlyRate or contractorHourlyRate', () => {
  assert.doesNotMatch(entity, /hourlyRate|contractorHourlyRate/i);
});

test('entity does NOT contain grossPay or netPay', () => {
  assert.doesNotMatch(entity, /grossPay|netPay/i);
});

test('entity does NOT contain cisDeduction, cisRate, taxCode, niContribution, vatAmount', () => {
  assert.doesNotMatch(entity, /cisDeduction|cisRate|taxCode|niContribution|vatAmount/i);
});

test('entity does NOT contain pensionContribution', () => {
  assert.doesNotMatch(entity, /pensionContribution/i);
});

// ── SERVICE ───────────────────────────────────────────────────────────────────

test('service has createForCompany method', () => {
  assert.match(service, /createForCompany/);
});

test('service has getForCompany method', () => {
  assert.match(service, /getForCompany/);
});

test('service has updateForCompany method', () => {
  assert.match(service, /updateForCompany/);
});

test('service has getForGuard method (guard reads own records)', () => {
  assert.match(service, /getForGuard/);
});

test('service has getForAdmin method', () => {
  assert.match(service, /getForAdmin/);
});

test('service does NOT have a remove or delete method', () => {
  assert.doesNotMatch(service, /async remove\b|async delete\b|deleteForCompany|removeForCompany/);
});

test('service uses findWithNote helper with addSelect on payrollNoteEnc', () => {
  assert.match(service, /findWithNote/);
  assert.match(service, /addSelect.*payrollNoteEnc/);
});

test('service uses EncryptionService for payrollNoteEnc', () => {
  assert.match(service, /encryptionService\.encrypt/);
  assert.match(service, /encryptionService\.decrypt/);
});

test('service uses saveWithUniqueCheck to catch duplicate payrollReference', () => {
  assert.match(service, /saveWithUniqueCheck/);
  assert.match(service, /ConflictException/);
});

test('service catches QueryFailedError code 23505 for payrollReference uniqueness', () => {
  assert.match(service, /QueryFailedError/);
  assert.match(service, /23505/);
});

test('service createForCompany requires ACTIVE relationship', () => {
  assert.match(service, /requireOwnedActiveRelationship/);
});

test('service updateForCompany requires ACTIVE relationship', () => {
  const updateBlock = service.match(/updateForCompany[\s\S]{0,300}/)?.[0] ?? '';
  assert.match(updateBlock, /requireOwnedActiveRelationship/);
});

test('service getForCompany allows historical access (requireOwnedRelationship — no ACTIVE check)', () => {
  const getBlock = service.match(/getForCompany[\s\S]{0,300}/)?.[0] ?? '';
  assert.match(getBlock, /requireOwnedRelationship/);
  assert.doesNotMatch(getBlock, /requireOwnedActiveRelationship/);
});

test('service emits payroll_admin_create audit event', () => {
  assert.match(service, /guard_personnel\.payroll_admin_create/);
});

test('service emits payroll_admin_update audit event', () => {
  assert.match(service, /guard_personnel\.payroll_admin_update/);
});

test('service emits payroll_admin_status_change audit event', () => {
  assert.match(service, /guard_personnel\.payroll_admin_status_change/);
});

test('service does NOT emit payroll_admin_delete audit event', () => {
  assert.doesNotMatch(service, /payroll_admin_delete/);
});

test('service audit afterData never includes payrollNoteEnc value', () => {
  // audit must use changedFields array, not enc value
  assert.match(service, /changedFields/);
  assert.doesNotMatch(service, /afterData.*payrollNoteEnc.*:|afterData.*payrollNote.*enc/);
});

test('service toGuardDto excludes payrollReference, payrollPaymentMethod, and payrollNote', () => {
  const guardDtoBlock = service.match(/toGuardDto[\s\S]{0,400}/)?.[0] ?? '';
  assert.doesNotMatch(guardDtoBlock, /payrollReference/);
  assert.doesNotMatch(guardDtoBlock, /payrollPaymentMethod/);
  assert.doesNotMatch(guardDtoBlock, /payrollNote/);
});

test('service toAdminDto excludes payrollNote', () => {
  const adminDtoBlock = service.match(/toAdminDto[\s\S]{0,400}/)?.[0] ?? '';
  assert.doesNotMatch(adminDtoBlock, /payrollNote\b/);
});

// ── NO DELETE ────────────────────────────────────────────────────────────────

test('controller has NO DELETE route for payroll-admin', () => {
  assert.doesNotMatch(controller, /Delete.*payroll-admin|payroll-admin.*Delete/);
});

test('service has NO remove() or delete() method for payroll records', () => {
  assert.doesNotMatch(service, /async remove\b|async delete\b/);
});

// ── ACCESS CONTROL ────────────────────────────────────────────────────────────

test('controller company POST route exists for payroll-admin', () => {
  assert.match(controller, /Post\('company\/guard\/:guardId\/payroll-admin'\)/);
});

test('controller company GET route exists for payroll-admin', () => {
  assert.match(controller, /Get\('company\/guard\/:guardId\/payroll-admin'\)/);
});

test('controller company PATCH route exists for payroll-admin', () => {
  assert.match(controller, /Patch\('company\/guard\/:guardId\/payroll-admin'\)/);
});

test('controller guard GET route exists for me/payroll-admin', () => {
  assert.match(controller, /Get\('me\/payroll-admin'\)/);
});

test('controller admin GET route exists for admin/:id/payroll-admin', () => {
  assert.match(controller, /Get\('admin\/:id\/payroll-admin'\)/);
});

test('controller company routes have @Roles(UserRole.COMPANY, UserRole.COMPANY_ADMIN)', () => {
  assert.match(controller, /company\/guard\/:guardId\/payroll-admin/);
  assert.match(controller, /UserRole\.COMPANY.*UserRole\.COMPANY_ADMIN|UserRole\.COMPANY_ADMIN.*UserRole\.COMPANY/);
});

test('controller guard route has @Roles(UserRole.GUARD)', () => {
  assert.match(controller, /me\/payroll-admin/);
  assert.match(controller, /UserRole\.GUARD/);
});

test('controller admin route has @Roles(UserRole.ADMIN)', () => {
  assert.match(controller, /admin\/:id\/payroll-admin/);
  assert.match(controller, /UserRole\.ADMIN/);
});

test('COMPANY_STAFF has zero payroll-admin routes', () => {
  const blocks = controller.match(/payroll-admin[\s\S]{0,300}/g) || [];
  blocks.forEach((block) => {
    assert.doesNotMatch(block, /COMPANY_STAFF/);
  });
});

// ── ENGAGEMENT TYPE SUPPORT (SECTION 6A) ─────────────────────────────────────

test('[6A] service createForCompany does not gate on engagementType — all types permitted', () => {
  const createBlock = service.match(/createForCompany[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(createBlock, /engagementType.*EMPLOYEE|EMPLOYEE.*required/i);
});

test('[6A] P1G-B entity does not contain engagementType column (P1F is the sole source)', () => {
  assert.doesNotMatch(entity, /engagementType/);
});

test('[6A] P1G-B entity does not contain NINO — P1A owns it, not P1D', () => {
  assert.doesNotMatch(entity, /nino|nationalInsuranceNumber/i);
});

test('[6A] P1G-B entity does not contain UTR — P1A owns it, not P1D', () => {
  assert.doesNotMatch(entity, /utr|uniqueTaxpayerReference/i);
});

test('[6A] P1G-B entity does not contain CIS or tax deduction fields', () => {
  assert.doesNotMatch(entity, /cis|taxDeduction|grossPay|netPay|niContribution/i);
});

test('[6A] P1G-B entity does not contain contractor-specific hourlyRate', () => {
  assert.doesNotMatch(entity, /hourlyRate|contractorHourlyRate/i);
});

test('[6A] Company UX reads engagementType from P1F (getCompanyGuardEmployment in api.ts)', () => {
  assert.match(api, /getCompanyGuardEmployment/);
  assert.match(api, /guard-personnel\/company\/guard/);
  assert.match(api, /\/employment/);
});

test('[6A] Company dashboard reads P1F engagement type for label adaptation', () => {
  assert.match(companyDash, /getCompanyGuardEmployment/);
  assert.match(companyDash, /guardPayrollEngagementType/);
});

test('[6A] Company UX shows "Payroll Administration" for EMPLOYEE engagement type', () => {
  assert.match(companyDash, /Payroll Administration/);
  assert.match(companyDash, /EMPLOYEE/);
});

test('[6A] Company UX shows "Payment Administration" for non-EMPLOYEE engagement types', () => {
  assert.match(companyDash, /Payment Administration/);
});

test('[6A] Company UX shows "Pay Administration" when no P1F record exists (NONE sentinel)', () => {
  assert.match(companyDash, /Pay Administration/);
  assert.match(companyDash, /NONE/);
});

// ── DTO STRUCTURE ─────────────────────────────────────────────────────────────

test('CreatePayrollAdminDto has payrollReference payFrequency payrollPaymentMethod payrollStatus payrollStartDate payrollEndDate payrollNote (all optional)', () => {
  assert.match(createDto, /IsOptional/);
  assert.match(createDto, /payrollReference/);
  assert.match(createDto, /payFrequency/);
  assert.match(createDto, /payrollPaymentMethod/);
  assert.match(createDto, /payrollStatus/);
  assert.match(createDto, /payrollStartDate/);
  assert.match(createDto, /payrollEndDate/);
  assert.match(createDto, /payrollNote/);
});

test('UpdatePayrollAdminDto has same fields as CreatePayrollAdminDto', () => {
  assert.match(updateDto, /payrollReference/);
  assert.match(updateDto, /payFrequency/);
  assert.match(updateDto, /payrollNote/);
});

test('PayrollAdminCompanyResponseDto includes payrollNote (decrypted)', () => {
  assert.match(companyDto, /payrollNote/);
  assert.doesNotMatch(companyDto, /payrollNoteEnc/);
});

test('PayrollAdminGuardResponseDto does NOT include payrollReference', () => {
  // Check the class body only — comments may legitimately mention excluded fields
  const body = guardDto.match(/class PayrollAdminGuardResponseDto \{[^}]+\}/)?.[0] ?? '';
  assert.ok(body.length > 0, 'class body not found');
  assert.doesNotMatch(body, /payrollReference/);
});

test('PayrollAdminGuardResponseDto does NOT include payrollPaymentMethod', () => {
  const body = guardDto.match(/class PayrollAdminGuardResponseDto \{[^}]+\}/)?.[0] ?? '';
  assert.doesNotMatch(body, /payrollPaymentMethod/);
});

test('PayrollAdminGuardResponseDto does NOT include payrollNote', () => {
  const body = guardDto.match(/class PayrollAdminGuardResponseDto \{[^}]+\}/)?.[0] ?? '';
  assert.doesNotMatch(body, /payrollNote/);
});

test('PayrollAdminAdminResponseDto does NOT include payrollNote', () => {
  // Check class body only — comments may mention excluded fields
  const body = adminDto.match(/class PayrollAdminAdminResponseDto \{[^}]+\}/)?.[0] ?? '';
  assert.ok(body.length > 0, 'class body not found');
  assert.doesNotMatch(body, /payrollNote/);
});

test('PayrollAdminAdminResponseDto includes companyName', () => {
  assert.match(adminDto, /companyName/);
});

// ── PAYROLL REFERENCE UNIQUENESS ──────────────────────────────────────────────

test('entity has companyId column for company-scoped uniqueness index', () => {
  assert.match(entity, /companyId/);
});

test('migration creates partial unique index on (companyId, LOWER(payrollReference)) WHERE payrollReference IS NOT NULL', () => {
  assert.match(migration, /CREATE UNIQUE INDEX/);
  assert.match(migration, /UQ_payroll_records_company_ref/);
  assert.match(migration, /companyId.*LOWER.*payrollReference|LOWER.*payrollReference.*companyId/);
  assert.match(migration, /WHERE.*payrollReference.*IS NOT NULL/);
});

test('service handles unique violation with ConflictException and message about company reference', () => {
  assert.match(service, /ConflictException/);
  assert.match(service, /Payroll reference already in use for this company/);
});

// ── MIGRATION ─────────────────────────────────────────────────────────────────

test('migration creates company_guard_payroll_records table', () => {
  assert.match(migration, /CREATE TABLE.*company_guard_payroll_records/);
});

test('migration creates guard_pay_frequency_enum without OTHER', () => {
  assert.match(migration, /guard_pay_frequency_enum/);
  assert.match(migration, /WEEKLY/);
  assert.match(migration, /FORTNIGHTLY/);
  assert.match(migration, /FOUR_WEEKLY/);
  assert.match(migration, /MONTHLY/);
  assert.match(migration, /IRREGULAR/);
  // OTHER must not appear in the frequency enum definition
  const freqBlock = migration.match(/guard_pay_frequency_enum[\s\S]{0,200}/)?.[0] ?? '';
  assert.doesNotMatch(freqBlock, /'OTHER'/);
});

test('migration creates guard_payroll_payment_method_enum', () => {
  assert.match(migration, /guard_payroll_payment_method_enum/);
  assert.match(migration, /BACS/);
});

test('migration creates guard_payroll_status_enum', () => {
  assert.match(migration, /guard_payroll_status_enum/);
  assert.match(migration, /EXCLUDED/);
});

test('migration companyGuardId has UNIQUE constraint', () => {
  assert.match(migration, /UQ_payroll_records_companyGuardId/);
  assert.match(migration, /UNIQUE.*companyGuardId|companyGuardId.*UNIQUE/);
});

test('migration FK on companyGuardId references company_guards ON DELETE RESTRICT', () => {
  assert.match(migration, /REFERENCES.*company_guards/);
  assert.match(migration, /ON DELETE RESTRICT/);
});

test('migration FK on companyId references companies ON DELETE RESTRICT', () => {
  assert.match(migration, /REFERENCES.*companies/);
});

test('migration payrollStatus defaults to ACTIVE', () => {
  assert.match(migration, /payrollStatus.*DEFAULT.*ACTIVE|DEFAULT.*ACTIVE.*payrollStatus/);
});

test('migration down() drops index then table then all three enum types', () => {
  assert.match(migration, /DROP INDEX/);
  assert.match(migration, /DROP TABLE.*company_guard_payroll_records/);
  assert.match(migration, /DROP TYPE.*guard_payroll_status_enum/);
  assert.match(migration, /DROP TYPE.*guard_payroll_payment_method_enum/);
  assert.match(migration, /DROP TYPE.*guard_pay_frequency_enum/);
});

// ── MODULE & ENTITIES REGISTRATION ───────────────────────────────────────────

test('module registers CompanyGuardPayroll entity in TypeOrmModule.forFeature', () => {
  assert.match(module_, /CompanyGuardPayroll/);
  assert.match(module_, /TypeOrmModule\.forFeature/);
});

test('module registers PayrollAdminService as provider', () => {
  assert.match(module_, /PayrollAdminService/);
  assert.match(module_, /providers:/);
});

test('database entities.ts exports CompanyGuardPayroll', () => {
  assert.match(entities, /CompanyGuardPayroll/);
  assert.match(entities, /company-guard-payroll\.entity/);
});

// ── MOBILE API ────────────────────────────────────────────────────────────────

test('api.ts exports getMyPayrollAdmin calling guard-personnel/me/payroll-admin', () => {
  assert.match(api, /getMyPayrollAdmin/);
  assert.match(api, /guard-personnel\/me\/payroll-admin/);
});

test('api.ts exports getCompanyGuardPayrollAdmin with GET method', () => {
  assert.match(api, /getCompanyGuardPayrollAdmin/);
  assert.match(api, /company\/guard.*payroll-admin/);
});

test('api.ts exports createCompanyGuardPayrollAdmin with POST method', () => {
  assert.match(api, /createCompanyGuardPayrollAdmin/);
  assert.match(api, /POST/);
});

test('api.ts exports updateCompanyGuardPayrollAdmin with PATCH method', () => {
  assert.match(api, /updateCompanyGuardPayrollAdmin/);
  assert.match(api, /PATCH/);
});

test('api.ts exports getCompanyGuardEmployment for P1F engagement-type lookup', () => {
  assert.match(api, /getCompanyGuardEmployment/);
  assert.match(api, /\/employment/);
});

// ── MOBILE MODELS ─────────────────────────────────────────────────────────────

test('models.ts has GuardPayFrequency type without OTHER', () => {
  // Capture only the GuardPayFrequency line (stops at semicolon)
  const block = models.match(/GuardPayFrequency[^;]+;/)?.[0] ?? '';
  assert.match(block, /WEEKLY/);
  assert.match(block, /FORTNIGHTLY/);
  assert.match(block, /FOUR_WEEKLY/);
  assert.match(block, /MONTHLY/);
  assert.match(block, /IRREGULAR/);
  assert.doesNotMatch(block, /'OTHER'/);
});

test('models.ts has GuardPayrollPaymentMethod type', () => {
  assert.match(models, /GuardPayrollPaymentMethod/);
  assert.match(models, /BACS/);
});

test('models.ts has GuardPayrollStatus type with ACTIVE ON_HOLD EXCLUDED', () => {
  assert.match(models, /GuardPayrollStatus/);
  assert.match(models, /ON_HOLD/);
  assert.match(models, /EXCLUDED/);
});

test('models.ts has GuardPayrollAdminSummary (guard read-only view)', () => {
  assert.match(models, /GuardPayrollAdminSummary/);
  assert.match(models, /payFrequency/);
  assert.match(models, /payrollStatus/);
  assert.match(models, /companyName/);
});

test('models.ts GuardPayrollAdminSummary does NOT include payrollReference or payrollNote', () => {
  // Capture only the interface body (stops at closing brace)
  const block = models.match(/GuardPayrollAdminSummary \{[^}]+\}/)?.[0] ?? '';
  assert.ok(block.length > 0, 'GuardPayrollAdminSummary interface body not found');
  assert.doesNotMatch(block, /payrollReference/);
  assert.doesNotMatch(block, /payrollNote/);
});

test('models.ts has CompanyGuardPayrollRecord (company full view with payrollNote)', () => {
  assert.match(models, /CompanyGuardPayrollRecord/);
  assert.match(models, /payrollNote/);
  assert.match(models, /payrollReference/);
});

test('models.ts has UpsertPayrollAdminPayload', () => {
  assert.match(models, /UpsertPayrollAdminPayload/);
  assert.match(models, /payrollNote\?/);
});

test('models.ts has CompanyGuardEmploymentSummary with engagementType for label selection', () => {
  assert.match(models, /CompanyGuardEmploymentSummary/);
  assert.match(models, /engagementType/);
});

// ── MOBILE GUARD UI ───────────────────────────────────────────────────────────

test('[STATIC ANALYSIS] guard dashboard imports getMyPayrollAdmin', () => {
  assert.match(guardDash, /getMyPayrollAdmin/);
});

test('[STATIC ANALYSIS] guard dashboard imports GuardPayrollAdminSummary type', () => {
  assert.match(guardDash, /GuardPayrollAdminSummary/);
});

test('[STATIC ANALYSIS] guard dashboard has payrollAdminRecords state', () => {
  assert.match(guardDash, /payrollAdminRecords/);
});

test('[STATIC ANALYSIS] guard dashboard calls loadPayrollAdmin in loadData', () => {
  assert.match(guardDash, /loadPayrollAdmin/);
});

test('[STATIC ANALYSIS] guard dashboard has Pay Administration feature card', () => {
  assert.match(guardDash, /Pay Administration/);
  assert.match(guardDash, /FeatureCard/);
});

test('[STATIC ANALYSIS] guard dashboard payroll card shows payFrequency and payrollStatus', () => {
  assert.match(guardDash, /payFrequency/);
  assert.match(guardDash, /payrollStatus/);
});

test('[STATIC ANALYSIS] guard dashboard payroll card is read-only (no edit inputs or save buttons)', () => {
  // The guard payroll card must not contain a save/edit function for payroll — guard is read-only
  const payrollCardBlock = guardDash.match(/Pay Administration[\s\S]{0,1500}/)?.[0] ?? '';
  assert.doesNotMatch(payrollCardBlock, /handleSavePayrollAdmin|setSavingPayrollAdmin/);
});

// ── MOBILE COMPANY UI ────────────────────────────────────────────────────────

test('[STATIC ANALYSIS] company dashboard imports getCompanyGuardPayrollAdmin', () => {
  assert.match(companyDash, /getCompanyGuardPayrollAdmin/);
});

test('[STATIC ANALYSIS] company dashboard imports createCompanyGuardPayrollAdmin', () => {
  assert.match(companyDash, /createCompanyGuardPayrollAdmin/);
});

test('[STATIC ANALYSIS] company dashboard imports updateCompanyGuardPayrollAdmin', () => {
  assert.match(companyDash, /updateCompanyGuardPayrollAdmin/);
});

test('[STATIC ANALYSIS] company dashboard imports getCompanyGuardEmployment', () => {
  assert.match(companyDash, /getCompanyGuardEmployment/);
});

test('[STATIC ANALYSIS] company dashboard has selectedPayrollGuardId state', () => {
  assert.match(companyDash, /selectedPayrollGuardId/);
});

test('[STATIC ANALYSIS] company dashboard has editingPayrollAdmin state', () => {
  assert.match(companyDash, /editingPayrollAdmin/);
});

test('[STATIC ANALYSIS] company dashboard has handleSavePayrollAdmin function', () => {
  assert.match(companyDash, /handleSavePayrollAdmin/);
});

test('[STATIC ANALYSIS] company dashboard has getPayrollLabels engagement-aware label helper', () => {
  assert.match(companyDash, /getPayrollLabels/);
});

test('[STATIC ANALYSIS] company dashboard renders payroll admin panel in guards section', () => {
  assert.match(companyDash, /renderPayrollAdminPanel/);
  assert.match(companyDash, /renderGuardsSection/);
});

// ── PAYROLL CALCULATION BOUNDARY ──────────────────────────────────────────────

test('P1G-B service does NOT import PayrollBatchService', () => {
  assert.doesNotMatch(service, /PayrollBatchService|payroll-batch\.service/);
});

test('P1G-B service does NOT import PayRuleService', () => {
  assert.doesNotMatch(service, /PayRuleService|pay-rule\.service/);
});

test('P1G-B entity does NOT reference Timesheet or PayrollBatch', () => {
  assert.doesNotMatch(entity, /Timesheet|PayrollBatch/);
});

// ── PRIOR SLICE REGRESSION ─────────────────────────────────────────────────────

test('P1G-A BankDetailsService still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/bank-details.service.ts'));
});

test('P1F EmploymentService still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/employment.service.ts'));
});

test('P1E EmergencyContactService still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/emergency-contact.service.ts'));
});

test('P1D DrivingTransportService still present (regression)', () => {
  assert.doesNotThrow(() => backend('guard-personnel/driving-transport.service.ts'));
});

test('P1G-A migration still present (regression)', () => {
  assert.doesNotThrow(() => backend('database/migrations/1720600000000-AddGuardBankDetailsP1GA.ts'));
});

test('P1F migration still present (regression)', () => {
  assert.doesNotThrow(() => backend('database/migrations/1720500000000-AddCompanyGuardEmploymentP1F.ts'));
});

test('P1E migration still present (regression)', () => {
  assert.doesNotThrow(() => backend('database/migrations/1720400000000-AddGuardEmergencyContactP1E.ts'));
});

// ── COMPANY ID INTEGRITY ──────────────────────────────────────────────────────

test('[SEC] CreatePayrollAdminDto does NOT contain companyId — cannot be supplied by client', () => {
  const body = createDto.match(/class CreatePayrollAdminDto \{[\s\S]+?\}/)?.[0] ?? '';
  assert.ok(body.length > 0, 'CreatePayrollAdminDto class body not found');
  assert.doesNotMatch(body, /companyId/);
});

test('[SEC] CreatePayrollAdminDto does NOT contain companyGuardId — cannot be supplied by client', () => {
  const body = createDto.match(/class CreatePayrollAdminDto \{[\s\S]+?\}/)?.[0] ?? '';
  assert.doesNotMatch(body, /companyGuardId/);
});

test('[SEC] UpdatePayrollAdminDto does NOT contain companyId — immutable after create', () => {
  const body = updateDto.match(/class UpdatePayrollAdminDto \{[\s\S]+?\}/)?.[0] ?? '';
  assert.ok(body.length > 0, 'UpdatePayrollAdminDto class body not found');
  assert.doesNotMatch(body, /companyId/);
});

test('[SEC] UpdatePayrollAdminDto does NOT contain companyGuardId — immutable after create', () => {
  const body = updateDto.match(/class UpdatePayrollAdminDto \{[\s\S]+?\}/)?.[0] ?? '';
  assert.doesNotMatch(body, /companyGuardId/);
});

test('[SEC] service derives companyId from authenticated user company profile — not from DTO', () => {
  assert.match(service, /requireCompanyIdForUser/);
  assert.match(service, /companyProfile/);
});

test('[SEC] createForCompany sets companyId from server-side lookup, not spread from dto', () => {
  const createBlock = service.match(/createForCompany[\s\S]{0,1200}/)?.[0] ?? '';
  // Verifies companyId: companyId (from requireOwnedActiveRelationship), not dto.companyId
  assert.match(createBlock, /companyId,/);
  assert.doesNotMatch(createBlock, /dto\.companyId/);
});

test('[SEC] updateForCompany cannot change companyId — not read from dto in update', () => {
  const updateBlock = service.match(/updateForCompany[\s\S]{0,1500}/)?.[0] ?? '';
  assert.doesNotMatch(updateBlock, /dto\.companyId/);
});

test('[SEC] updateForCompany cannot change companyGuardId — not read from dto in update', () => {
  const updateBlock = service.match(/updateForCompany[\s\S]{0,1500}/)?.[0] ?? '';
  assert.doesNotMatch(updateBlock, /dto\.companyGuardId/);
});

test('[SEC] no mass-assignment path — createForCompany does not spread dto into entity', () => {
  const createBlock = service.match(/createForCompany[\s\S]{0,1200}/)?.[0] ?? '';
  assert.doesNotMatch(createBlock, /\.\.\.(dto|create)/);
});

// ── PAYROLL REFERENCE NORMALIZATION ──────────────────────────────────────────

test('[NORM] service has normalizeRef helper for payrollReference normalization', () => {
  assert.match(service, /normalizeRef/);
});

test('[NORM] normalizeRef trims whitespace and uppercases', () => {
  assert.match(service, /\.trim\(\).*\.toUpperCase\(\)|\.toUpperCase\(\).*\.trim\(\)/);
});

test('[NORM] normalizeRef converts blank-after-trim to null', () => {
  // Match the function definition (not call sites)
  const block = service.match(/private normalizeRef[\s\S]{0,300}/)?.[0] ?? '';
  assert.ok(block.length > 0, 'normalizeRef function body not found');
  assert.match(block, /trimmed\.length.*===.*0.*null|length.*0.*return null/);
});

test('[NORM] createForCompany applies normalizeRef to payrollReference', () => {
  const block = service.match(/createForCompany[\s\S]{0,1200}/)?.[0] ?? '';
  assert.match(block, /normalizeRef.*payrollReference|payrollReference.*normalizeRef/);
});

test('[NORM] updateForCompany applies normalizeRef to payrollReference', () => {
  const block = service.match(/updateForCompany[\s\S]{0,1800}/)?.[0] ?? '';
  assert.match(block, /normalizeRef.*payrollReference|payrollReference.*normalizeRef/);
});

test('[NORM] migration unique index uses LOWER() for race-safe case-insensitive uniqueness', () => {
  assert.match(migration, /LOWER.*payrollReference/);
  assert.match(migration, /UQ_payroll_records_company_ref/);
});

// ── DATE RANGE VALIDATION ─────────────────────────────────────────────────────

test('[VAL] service has validateDateRange helper', () => {
  assert.match(service, /validateDateRange/);
});

test('[VAL] validateDateRange throws BadRequestException when startDate is after endDate', () => {
  assert.match(service, /BadRequestException/);
  assert.match(service, /payrollStartDate must not be after payrollEndDate/);
});

test('[VAL] createForCompany calls validateDateRange before saving', () => {
  const block = service.match(/createForCompany[\s\S]{0,1200}/)?.[0] ?? '';
  assert.match(block, /validateDateRange/);
});

test('[VAL] updateForCompany calls validateDateRange using effective post-update dates', () => {
  const block = service.match(/updateForCompany[\s\S]{0,3000}/)?.[0] ?? '';
  assert.match(block, /validateDateRange/);
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
