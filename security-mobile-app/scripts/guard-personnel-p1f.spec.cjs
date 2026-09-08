'use strict';
// P1F — Employment & Engagement Record — Static file analysis spec
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

const api = mobile('src/services/api.ts');
const models = mobile('src/types/models.ts');
const dashboard = mobile('src/screens/GuardDashboardScreen.tsx');
const entity = backend('guard-personnel/entities/company-guard-employment.entity.ts');
const migration = backend('database/migrations/1720500000000-AddCompanyGuardEmploymentP1F.ts');
const controller = backend('guard-personnel/guard-personnel.controller.ts');
const service = backend('guard-personnel/employment.service.ts');
const module_ = backend('guard-personnel/guard-personnel.module.ts');
const entities = backend('database/entities.ts');
const guardDtoFile = backend('guard-personnel/dto/employment-guard-response.dto.ts');
const companyDtoFile = backend('guard-personnel/dto/employment-company-response.dto.ts');
const companyStaffDtoFile = backend('guard-personnel/dto/employment-company-staff-response.dto.ts');
const adminDtoFile = backend('guard-personnel/dto/employment-admin-response.dto.ts');
const updateDtoFile = backend('guard-personnel/dto/update-company-guard-employment.dto.ts');

// Also load prior-slice files for regression
const p1eEntity = backend('guard-personnel/entities/guard-emergency-contact.entity.ts');
const p1eService = backend('guard-personnel/emergency-contact.service.ts');
const p1dService = backend('guard-personnel/driving-transport.service.ts');
const p1aService = backend('guard-personnel/guard-personnel.service.ts');

// ── ARCHITECTURE: employment tied to CompanyGuard ─────────────────────────────

test('entity references CompanyGuard not GuardProfile directly', () => {
  assert.match(entity, /company-guard\.entity/);
  assert.doesNotMatch(entity, /guard-profile\.entity/);
});

test('entity has companyGuardId UNIQUE column', () => {
  assert.match(entity, /unique:\s*true/);
  assert.match(entity, /companyGuardId/);
});

test('entity table name is company_guard_employment_records', () => {
  assert.match(entity, /company_guard_employment_records/);
});

test('entity FK is ManyToOne to CompanyGuard', () => {
  assert.match(entity, /ManyToOne.*CompanyGuard/);
  assert.match(entity, /JoinColumn.*companyGuardId/);
});

test('entity has no direct FK to GuardProfile or User', () => {
  assert.doesNotMatch(entity, /ManyToOne.*GuardProfile/);
  assert.doesNotMatch(entity, /ManyToOne.*User/);
});

// ── ARCHITECTURE: not Guard-global ───────────────────────────────────────────

test('service getEmploymentsForGuard returns list (multi-company)', () => {
  assert.match(service, /getEmploymentsForGuard/);
  assert.match(service, /records\.map/);
});

test('guard DTO includes companyGuardId companyId companyName guardId', () => {
  assert.match(guardDtoFile, /companyGuardId/);
  assert.match(guardDtoFile, /companyId/);
  assert.match(guardDtoFile, /companyName/);
  assert.match(guardDtoFile, /guardId/);
});

test('service requires active company-guard relationship for company access', () => {
  assert.match(service, /requireOwnedActiveRelationship/);
  assert.match(service, /CompanyGuardStatus\.ACTIVE/);
});

test('service maps each record to toGuardDto returning companyName from relation', () => {
  // toGuardDto is a private method — search the full service for the pattern
  assert.match(service, /cg\.company\.name/);
  assert.match(service, /companyName:\s*cg\.company\.name/);
});

// ── ENUMS ─────────────────────────────────────────────────────────────────────

test('entity defines GuardEngagementType enum', () => {
  assert.match(entity, /GuardEngagementType/);
  assert.match(entity, /EMPLOYEE/);
  assert.match(entity, /SELF_EMPLOYED_CONTRACTOR/);
  assert.match(entity, /AGENCY_WORKER/);
  assert.match(entity, /SUBCONTRACTOR/);
  assert.match(entity, /CASUAL_WORKER/);
});

test('entity defines GuardJobRole enum with correct values', () => {
  assert.match(entity, /GuardJobRole/);
  assert.match(entity, /SECURITY_OFFICER/);
  assert.match(entity, /DOOR_SUPERVISOR/);
  assert.match(entity, /CCTV_OPERATOR/);
  assert.match(entity, /SITE_SUPERVISOR/);
  assert.match(entity, /CONTROL_ROOM_OPERATOR/);
  assert.match(entity, /MOBILE_PATROL_OFFICER/);
});

test('entity defines GuardWorkingArrangement enum', () => {
  assert.match(entity, /GuardWorkingArrangement/);
  assert.match(entity, /FULL_TIME/);
  assert.match(entity, /PART_TIME/);
  assert.match(entity, /ZERO_HOURS/);
  assert.match(entity, /CASUAL/);
  assert.match(entity, /TEMPORARY/);
  assert.match(entity, /FIXED_TERM/);
});

test('entity defines GuardPayBasis enum', () => {
  assert.match(entity, /GuardPayBasis/);
  assert.match(entity, /HOURLY/);
  assert.match(entity, /DAILY/);
  assert.match(entity, /SALARY/);
});

test('all enums have enumName to prevent TypeORM name collision', () => {
  assert.match(entity, /enumName:\s*['"]guard_engagement_type_enum['"]/);
  assert.match(entity, /enumName:\s*['"]guard_job_role_enum['"]/);
  assert.match(entity, /enumName:\s*['"]guard_working_arrangement_enum['"]/);
  assert.match(entity, /enumName:\s*['"]guard_pay_basis_enum['"]/);
});

// ── ENTITY FIELDS ─────────────────────────────────────────────────────────────

test('entity has engagementType jobRole customRole workingArrangement startDate endDate payBasis noticePeriodDays', () => {
  assert.match(entity, /engagementType/);
  assert.match(entity, /jobRole/);
  assert.match(entity, /customRole/);
  assert.match(entity, /workingArrangement/);
  assert.match(entity, /startDate/);
  assert.match(entity, /endDate/);
  assert.match(entity, /payBasis/);
  assert.match(entity, /noticePeriodDays/);
});

test('entity startDate is type date', () => {
  // Decorator precedes field. Use \r?\n to handle both LF and CRLF line endings.
  assert.match(entity, /type.*'date'.*\r?\n.*startDate|startDate.*date/);
  assert.match(entity, /startDate/);
});

test('entity endDate is nullable', () => {
  // Column decorator is above the field — confirm entity has nullable endDate column
  assert.match(entity, /nullable.*true[\s\S]*?endDate|endDate\?.*string.*null/);
});

test('entity noticePeriodDays is nullable int', () => {
  assert.match(entity, /type.*'int'[\s\S]*?noticePeriodDays/);
  assert.match(entity, /nullable.*true[\s\S]*?noticePeriodDays/);
});

test('entity customRole is varchar 100 nullable', () => {
  assert.match(entity, /varchar.*100[\s\S]*?customRole/);
  assert.match(entity, /nullable.*true[\s\S]*?customRole/);
});

test('entity has no pay amount salary rate fields', () => {
  assert.doesNotMatch(entity, /hourlyRate|salary(?!y)|payRate|dailyRate/);
});

test('entity has no bank payroll tax fields', () => {
  assert.doesNotMatch(entity, /bankAccount|sortCode|payroll|taxCode|pension/);
});

test('entity has no SIA licence duplicate fields', () => {
  assert.doesNotMatch(entity, /siaLicen/);
});

test('entity has no emergency contact duplicate fields', () => {
  assert.doesNotMatch(entity, /emergencyContact|contactName/);
});

// ── INTERNAL NOTE ENCRYPTION ──────────────────────────────────────────────────

test('entity has internalNoteEnc column not internalNote plaintext', () => {
  assert.match(entity, /internalNoteEnc/);
  assert.doesNotMatch(entity, /Column.*internalNote(?!Enc)/);
});

test('internalNoteEnc is select:false', () => {
  // Decorator is above the field name — confirm select:false appears before internalNoteEnc
  assert.match(entity, /select:\s*false[\s\S]*?internalNoteEnc/);
});

test('internalNoteEnc is type text nullable', () => {
  assert.match(entity, /type.*'text'[\s\S]*?internalNoteEnc/);
  assert.match(entity, /nullable.*true[\s\S]*?internalNoteEnc/);
});

test('company DTO includes internalNote not internalNoteEnc', () => {
  assert.match(companyDtoFile, /internalNote/);
  assert.doesNotMatch(companyDtoFile, /internalNoteEnc/);
});

test('guard DTO does NOT include internalNote or internalNoteEnc', () => {
  assert.doesNotMatch(guardDtoFile, /internalNote/);
});

test('companyStaff DTO does NOT include internalNote or internalNoteEnc', () => {
  assert.doesNotMatch(companyStaffDtoFile, /internalNote/);
});

test('admin DTO includes internalNote not internalNoteEnc', () => {
  assert.match(adminDtoFile, /internalNote/);
  assert.doesNotMatch(adminDtoFile, /internalNoteEnc/);
});

test('service encrypts internalNote with encryptionService.encrypt', () => {
  assert.match(service, /encryptionService\.encrypt/);
  assert.match(service, /internalNoteEnc/);
});

test('service decrypts internalNoteEnc via decryptNote helper', () => {
  assert.match(service, /decryptNote/);
  assert.match(service, /encryptionService\.decrypt/);
});

test('service never logs internalNote or note content in audit', () => {
  const auditBlocks = service.split('auditLogService.log').slice(1);
  for (const block of auditBlocks) {
    const inner = block.split('\);')[0];
    assert.doesNotMatch(inner, /internalNote[^E]|note.*value|noteText/i);
  }
});

test('service uses GUARD_DATA_ENCRYPTION_KEY (no new key) via existing EncryptionService', () => {
  assert.match(service, /EncryptionService/);
  assert.doesNotMatch(service, /new.*Key|EMPLOYMENT_KEY|P1F_KEY/);
});

test('updateDto internalNote has MaxLength 1000', () => {
  assert.match(updateDtoFile, /MaxLength\s*\(\s*1000\s*\)/);
});

// ── ACCESS MODEL: Guard ───────────────────────────────────────────────────────

test('controller GET me/employments restricted to GUARD role', () => {
  const routeBlock = controller.slice(
    controller.indexOf('me/employments'),
    controller.indexOf('me/employments') + 200,
  );
  assert.match(routeBlock, /Roles.*GUARD/);
});

test('controller GET me/employments calls getEmploymentsForGuard', () => {
  const routeBlock = controller.slice(
    controller.indexOf('me/employments'),
    controller.indexOf('me/employments') + 250,
  );
  assert.match(routeBlock, /getEmploymentsForGuard/);
});

test('guard cannot PATCH employment (no PATCH me/employment route)', () => {
  assert.doesNotMatch(controller, /PATCH.*me\/employment|@Patch\('me\/employment'\)/);
});

// ── ACCESS MODEL: Company ─────────────────────────────────────────────────────

test('controller GET company/guard/:guardId/employment restricted to COMPANY COMPANY_ADMIN', () => {
  const routeBlock = controller.slice(
    controller.indexOf("'company/guard/:guardId/employment'"),
    controller.indexOf("'company/guard/:guardId/employment'") + 300,
  );
  assert.match(routeBlock, /Roles.*COMPANY/);
  assert.match(routeBlock, /COMPANY_ADMIN/);
});

test('controller PATCH company/guard/:guardId/employment restricted to COMPANY COMPANY_ADMIN', () => {
  const patchIdx = controller.indexOf("Patch('company/guard/:guardId/employment')");
  const routeBlock = controller.slice(patchIdx, patchIdx + 350);
  assert.match(routeBlock, /Roles.*COMPANY/);
  assert.match(routeBlock, /COMPANY_ADMIN/);
  assert.doesNotMatch(routeBlock, /COMPANY_STAFF/);
});

test('PATCH company employment calls upsertEmploymentForCompany', () => {
  const patchIdx = controller.indexOf("Patch('company/guard/:guardId/employment')");
  const routeBlock = controller.slice(patchIdx, patchIdx + 400);
  assert.match(routeBlock, /upsertEmploymentForCompany/);
});

// ── ACCESS MODEL: Company Staff ───────────────────────────────────────────────

test('controller GET company-staff employment route restricted to COMPANY_STAFF only', () => {
  assert.match(controller, /company-staff\/guard\/:guardId\/employment/);
  const csIdx = controller.indexOf('company-staff/guard/:guardId/employment');
  const routeBlock = controller.slice(csIdx - 200, csIdx + 200);
  assert.match(routeBlock, /Roles.*COMPANY_STAFF/);
});

test('company-staff route calls getEmploymentForCompanyStaff', () => {
  assert.match(controller, /getEmploymentForCompanyStaff/);
});

test('company route PATCH does NOT include COMPANY_STAFF', () => {
  const patchIdx = controller.indexOf("Patch('company/guard/:guardId/employment')");
  const routeBlock = controller.slice(patchIdx, patchIdx + 200);
  assert.doesNotMatch(routeBlock, /COMPANY_STAFF/);
});

// ── ACCESS MODEL: Admin ───────────────────────────────────────────────────────

test('controller GET admin/:id/employments restricted to ADMIN', () => {
  assert.match(controller, /admin\/:id\/employments/);
  const routeBlock = controller.slice(
    controller.indexOf('admin/:id/employments'),
    controller.indexOf('admin/:id/employments') + 300,
  );
  assert.match(routeBlock, /Roles.*ADMIN/);
});

test('admin route calls getEmploymentsForAdmin with audit meta', () => {
  const routeBlock = controller.slice(
    controller.indexOf('admin/:id/employments'),
    controller.indexOf('admin/:id/employments') + 400,
  );
  assert.match(routeBlock, /getEmploymentsForAdmin/);
  assert.match(routeBlock, /ipAddress|userAgent/);
});

// ── ACCESS MODEL: Client — NO ACCESS ─────────────────────────────────────────

test('no CLIENT_ADMIN or CLIENT_VIEWER employment route in controller', () => {
  assert.doesNotMatch(controller, /CLIENT_ADMIN.*employment|CLIENT_VIEWER.*employment/);
});

test('no client employment route defined', () => {
  assert.doesNotMatch(controller, /client\/guard.*employment/);
});

// ── SERVICE: company ownership and cross-tenant isolation ─────────────────────

test('service requireOwnedActiveRelationship checks companyId from user', () => {
  // Use the private method definition (last occurrence)
  const defIdx = service.lastIndexOf('private async requireOwnedActiveRelationship');
  assert.ok(defIdx !== -1, 'requireOwnedActiveRelationship definition not found');
  const fn = service.slice(defIdx, defIdx + 600);
  assert.match(fn, /requireCompanyIdForUser/);
  assert.match(fn, /companyId/);
});

test('service upsert validates required fields on first create', () => {
  const fn = service.slice(
    service.indexOf('upsertEmploymentForCompany'),
    service.indexOf('upsertEmploymentForCompany') + 1500,
  );
  assert.match(fn, /engagementType/);
  assert.match(fn, /jobRole/);
  assert.match(fn, /startDate/);
  assert.match(fn, /payBasis/);
  assert.match(fn, /missing\.join|missing\.length/);
});

test('service PATCH preserves existing values when field is undefined', () => {
  // These undefined guards are present in the upsert method body
  assert.match(service, /dto\.engagementType !== undefined/);
  assert.match(service, /dto\.jobRole !== undefined/);
});

test('service clears customRole when jobRole changes to non-OTHER', () => {
  assert.match(service, /jobRole !== GuardJobRole\.OTHER.*customRole.*null/s);
});

test('service validates endDate not before startDate', () => {
  assert.match(service, /validateDateRange/);
  assert.match(service, /endDate.*startDate|startDate.*endDate/);
});

test('service allows explicit null to clear nullable fields endDate noticePeriodDays internalNote', () => {
  assert.match(service, /dto\.endDate === null/);
  assert.match(service, /dto\.noticePeriodDays === null/);
  assert.match(service, /dto\.internalNote === null/);
});

test('service does not hardcode companyId cross-tenant — uses user company lookup', () => {
  assert.match(service, /requireCompanyIdForUser.*userId/);
  assert.doesNotMatch(service, /companyId\s*=\s*\d+/);
});

// ── AUDIT ─────────────────────────────────────────────────────────────────────

test('service emits guard_personnel.employment_create on first upsert', () => {
  assert.match(service, /guard_personnel\.employment_create/);
});

test('service emits guard_personnel.employment_update on subsequent upsert', () => {
  assert.match(service, /guard_personnel\.employment_update/);
});

test('service emits guard_personnel.employment_view_sensitive for admin read', () => {
  assert.match(service, /guard_personnel\.employment_view_sensitive/);
});

test('audit afterData contains changedFields array not field values', () => {
  assert.match(service, /changedFields/);
  const auditBlocks = service.split('auditLogService.log').slice(1);
  for (const block of auditBlocks) {
    const inner = block.split('\);')[0];
    assert.doesNotMatch(inner, /engagementType.*:.*['"]\w|jobRole.*:.*['"]\w/);
  }
});

test('audit metadata includes companyGuardId guardId companyId', () => {
  const upsertFn = service.slice(
    service.indexOf('upsertEmploymentForCompany'),
    service.indexOf('upsertEmploymentForCompany') + 2500,
  );
  assert.match(upsertFn, /companyGuardId/);
  assert.match(upsertFn, /guardId/);
  assert.match(upsertFn, /companyId/);
});

test('admin audit logs requestedBy admin and recordCount', () => {
  const adminFn = service.slice(
    service.indexOf('getEmploymentsForAdmin'),
    service.indexOf('getEmploymentsForAdmin') + 1400,
  );
  assert.match(adminFn, /requestedBy.*admin/);
  assert.match(adminFn, /recordCount/);
});

// ── MIGRATION ─────────────────────────────────────────────────────────────────

test('migration creates company_guard_employment_records table', () => {
  assert.match(migration, /company_guard_employment_records/);
  assert.match(migration, /CREATE TABLE/);
});

test('migration creates all four enum types', () => {
  assert.match(migration, /guard_engagement_type_enum/);
  assert.match(migration, /guard_job_role_enum/);
  assert.match(migration, /guard_working_arrangement_enum/);
  assert.match(migration, /guard_pay_basis_enum/);
});

test('migration FK references company_guards with ON DELETE RESTRICT', () => {
  assert.match(migration, /REFERENCES.*company_guards/);
  assert.match(migration, /ON DELETE RESTRICT/);
});

test('migration FK does NOT ON DELETE CASCADE employment history', () => {
  assert.doesNotMatch(migration, /ON DELETE CASCADE/);
});

test('migration UNIQUE constraint on companyGuardId', () => {
  assert.match(migration, /UNIQUE.*companyGuardId|UQ.*company_guard_employment/);
});

test('migration internalNoteEnc is text NULL (no plaintext note column)', () => {
  assert.match(migration, /internalNoteEnc.*text.*NULL|text.*NULL.*internalNoteEnc/);
  assert.doesNotMatch(migration, /"internalNote"\s+text/);
});

test('migration startDate is date NOT NULL', () => {
  assert.match(migration, /startDate.*date.*NOT NULL/);
});

test('migration endDate is date NULL (nullable)', () => {
  assert.match(migration, /endDate.*date.*NULL(?!\s*NOT)/);
});

test('migration noticePeriodDays is integer NULL', () => {
  assert.match(migration, /noticePeriodDays.*integer.*NULL(?!\s*NOT)/);
});

test('migration customRole is varchar 100 NULL', () => {
  assert.match(migration, /customRole.*varchar.*100.*NULL/);
});

test('migration has down() that drops table then enums in correct order', () => {
  const downFn = migration.split('async down')[1];
  assert.match(downFn, /DROP TABLE/);
  assert.match(downFn, /DROP TYPE/);
  const tableIdx = downFn.indexOf('DROP TABLE');
  const typeIdx = downFn.indexOf('DROP TYPE');
  assert.ok(tableIdx < typeIdx, 'down() must drop table before enum types');
});

test('migration has no production-unsafe data transforms', () => {
  assert.doesNotMatch(migration, /UPDATE.*SET|DELETE FROM/);
});

// ── MODULE AND ENTITY REGISTRATION ───────────────────────────────────────────

test('module imports CompanyGuardEmployment entity', () => {
  assert.match(module_, /CompanyGuardEmployment/);
});

test('module registers EmploymentService provider', () => {
  assert.match(module_, /EmploymentService/);
});

test('entities.ts imports CompanyGuardEmployment', () => {
  assert.match(entities, /CompanyGuardEmployment/);
  assert.match(entities, /company-guard-employment\.entity/);
});

test('entities.ts includes CompanyGuardEmployment in appEntities array', () => {
  const arrayBlock = entities.slice(entities.indexOf('appEntities'), entities.lastIndexOf(']'));
  assert.match(arrayBlock, /CompanyGuardEmployment/);
});

// ── DTO: UpdateCompanyGuardEmploymentDto ──────────────────────────────────────

test('updateDto all fields optional (PATCH semantics)', () => {
  const fields = ['engagementType', 'jobRole', 'customRole', 'workingArrangement', 'startDate', 'endDate', 'payBasis', 'noticePeriodDays', 'internalNote'];
  for (const f of fields) {
    const idx = updateDtoFile.indexOf(f);
    assert.ok(idx !== -1, `${f} not found in updateDto`);
    const block = updateDtoFile.slice(idx, idx + 100);
    assert.match(block, /\?/, `${f} should be optional`);
  }
});

test('updateDto has @IsEnum for engagementType jobRole workingArrangement payBasis', () => {
  assert.match(updateDtoFile, /IsEnum.*GuardEngagementType|GuardEngagementType.*IsEnum/);
  assert.match(updateDtoFile, /IsEnum.*GuardJobRole|GuardJobRole.*IsEnum/);
  assert.match(updateDtoFile, /IsEnum.*GuardWorkingArrangement|GuardWorkingArrangement.*IsEnum/);
  assert.match(updateDtoFile, /IsEnum.*GuardPayBasis|GuardPayBasis.*IsEnum/);
});

test('updateDto has @IsDateString for startDate and endDate', () => {
  assert.match(updateDtoFile, /IsDateString/);
});

test('updateDto has @IsInt @Min(0) @Max(365) for noticePeriodDays', () => {
  assert.match(updateDtoFile, /IsInt/);
  assert.match(updateDtoFile, /Min\s*\(\s*0\s*\)/);
  assert.match(updateDtoFile, /Max\s*\(\s*365\s*\)/);
});

test('updateDto does NOT include payRate hourlyRate salary bank fields', () => {
  assert.doesNotMatch(updateDtoFile, /payRate|hourlyRate|salary(?!y)|bankAccount|sortCode|taxCode/);
});

// ── MOBILE API ────────────────────────────────────────────────────────────────

test('api.ts exports getMyEmployments', () => {
  assert.match(api, /export function getMyEmployments/);
});

test('getMyEmployments calls /guard-personnel/me/employments via GET', () => {
  const fn = api.slice(api.indexOf('getMyEmployments'), api.indexOf('getMyEmployments') + 200);
  assert.match(fn, /guard-personnel\/me\/employments/);
});

test('api.ts imports GuardEmploymentRecord type', () => {
  assert.match(api, /GuardEmploymentRecord/);
});

// ── MOBILE TYPES ──────────────────────────────────────────────────────────────

test('models.ts declares GuardEngagementType with all values', () => {
  assert.match(models, /GuardEngagementType/);
  const idx = models.indexOf('GuardEngagementType');
  const block = models.slice(idx, idx + 300);
  assert.match(block, /EMPLOYEE/);
  assert.match(block, /SELF_EMPLOYED_CONTRACTOR/);
  assert.match(block, /AGENCY_WORKER/);
  assert.match(block, /SUBCONTRACTOR/);
  assert.match(block, /CASUAL_WORKER/);
});

test('models.ts declares GuardJobRole with correct values', () => {
  assert.match(models, /GuardJobRole/);
  const idx = models.indexOf('GuardJobRole');
  const block = models.slice(idx, idx + 300);
  assert.match(block, /SECURITY_OFFICER/);
  assert.match(block, /DOOR_SUPERVISOR/);
  assert.match(block, /CCTV_OPERATOR/);
  assert.match(block, /SITE_SUPERVISOR/);
  assert.match(block, /CONTROL_ROOM_OPERATOR/);
  assert.match(block, /MOBILE_PATROL_OFFICER/);
});

test('models.ts declares GuardWorkingArrangement', () => {
  assert.match(models, /GuardWorkingArrangement/);
  const idx = models.indexOf('GuardWorkingArrangement');
  const block = models.slice(idx, idx + 250);
  assert.match(block, /FULL_TIME/);
  assert.match(block, /ZERO_HOURS/);
  assert.match(block, /FIXED_TERM/);
});

test('models.ts declares GuardPayBasis', () => {
  assert.match(models, /GuardPayBasis/);
  const idx = models.indexOf('GuardPayBasis');
  const block = models.slice(idx, idx + 100);
  assert.match(block, /HOURLY/);
  assert.match(block, /DAILY/);
  assert.match(block, /SALARY/);
});

test('models.ts declares GuardEmploymentRecord interface with required fields', () => {
  assert.match(models, /interface GuardEmploymentRecord/);
  const idx = models.indexOf('GuardEmploymentRecord');
  const block = models.slice(idx, idx + 500);
  assert.match(block, /companyGuardId/);
  assert.match(block, /companyId/);
  assert.match(block, /companyName/);
  assert.match(block, /guardId/);
  assert.match(block, /engagementType/);
  assert.match(block, /jobRole/);
  assert.match(block, /workingArrangement/);
  assert.match(block, /startDate/);
  assert.match(block, /payBasis/);
  assert.match(block, /updatedAt/);
});

test('GuardEmploymentRecord does NOT include internalNote', () => {
  const idx = models.indexOf('interface GuardEmploymentRecord');
  const block = models.slice(idx, models.indexOf('}', idx + 1) + 1);
  assert.doesNotMatch(block, /internalNote/);
});

// ── DASHBOARD UI ──────────────────────────────────────────────────────────────

test('dashboard imports getMyEmployments', () => {
  assert.match(dashboard, /getMyEmployments/);
});

test('dashboard imports GuardEmploymentRecord type', () => {
  assert.match(dashboard, /GuardEmploymentRecord/);
});

test('dashboard declares employments state as GuardEmploymentRecord[]', () => {
  assert.match(dashboard, /useState<GuardEmploymentRecord\[\]>/);
});

test('dashboard declares employmentsLoading state', () => {
  assert.match(dashboard, /employmentsLoading.*setEmploymentsLoading/);
});

test('dashboard declares employmentsError state', () => {
  assert.match(dashboard, /employmentsError.*setEmploymentsError/);
});

test('dashboard has loadEmployments function calling getMyEmployments', () => {
  assert.match(dashboard, /loadEmployments/);
  const fn = dashboard.slice(dashboard.indexOf('loadEmployments'), dashboard.indexOf('loadEmployments') + 300);
  assert.match(fn, /getMyEmployments/);
});

test('loadEmployments is called inside loadData', () => {
  const loadDataFn = dashboard.slice(
    dashboard.indexOf('async function loadData'),
    dashboard.indexOf('async function loadData') + 1500,
  );
  assert.match(loadDataFn, /loadEmployments/);
});

test('dashboard renders Employment FeatureCard', () => {
  // FeatureCard wraps the title prop — search for the opening tag before the title
  assert.match(dashboard, /FeatureCard[\s\S]{0,200}Employment/);
  assert.match(dashboard, /title="Employment"/);
});

test('dashboard renders companyName in employment card', () => {
  const idx = dashboard.indexOf('emp.companyName');
  assert.ok(idx !== -1, 'emp.companyName not rendered in employment card');
});

test('dashboard renders engagementType jobRole workingArrangement payBasis startDate', () => {
  assert.match(dashboard, /emp\.engagementType/);
  assert.match(dashboard, /emp\.jobRole/);
  assert.match(dashboard, /emp\.workingArrangement/);
  assert.match(dashboard, /emp\.payBasis/);
  assert.match(dashboard, /emp\.startDate/);
});

test('dashboard does NOT render internalNote in employment card', () => {
  const idx = dashboard.indexOf('"Employment"');
  const block = dashboard.slice(idx, idx + 2000);
  assert.doesNotMatch(block, /internalNote/);
});

test('dashboard employment UI is read-only (no edit mode state for employment)', () => {
  assert.doesNotMatch(dashboard, /editingEmployment|setEditingEmployment/);
  assert.doesNotMatch(dashboard, /handleSaveEmployment/);
});

test('dashboard employment UI includes contact-admin hint (no roadmap language)', () => {
  const idx = dashboard.indexOf('emp.companyName');
  const block = dashboard.slice(idx - 500, idx + 2000);
  assert.match(block, /contact your company administrator/i);
  assert.doesNotMatch(block, /coming soon|P1F\.1|future workflow/i);
});

// ── P1F DOES NOT MODIFY PRIOR SLICES ─────────────────────────────────────────

test('P1E entity select:false fields unchanged', () => {
  // Decorator (select:false) precedes the field name — check each in decorator-first order
  assert.match(p1eEntity, /select:\s*false[\s\S]*?contactNameEnc/);
  assert.match(p1eEntity, /select:\s*false[\s\S]*?customRelationshipEnc/);
  assert.match(p1eEntity, /select:\s*false[\s\S]*?primaryPhoneEnc/);
  assert.match(p1eEntity, /select:\s*false[\s\S]*?alternatePhoneEnc/);
});

test('P1E service COMPANY_STAFF denial unchanged', () => {
  assert.doesNotMatch(p1eService, /COMPANY_STAFF.*getEmergencyContact/);
});

test('P1D service still restricts driving licence reveal to authorised roles', () => {
  assert.match(p1dService, /revealLicenceForGuard|revealLicenceForAdmin/);
});

test('P1A service still enforces encryption on NINO and UTR', () => {
  assert.match(p1aService, /ninoEnc|utrEnc/);
});

test('controller P1E COMPANY_STAFF denial comment preserved', () => {
  assert.match(controller, /COMPANY_STAFF.*NO ACCESS.*PII|PII.*COMPANY_STAFF.*NO ACCESS/);
});

test('P1F comment block present in controller', () => {
  assert.match(controller, /P1F access model/);
});

// ── SECURITY: no forbidden fields or patterns ─────────────────────────────────

test('entity has no Smart Matching scoring fields', () => {
  assert.doesNotMatch(entity, /matchScore|smartMatch|matchRating/);
});

test('entity has no client ownership fields', () => {
  assert.doesNotMatch(entity, /clientId|clientOwner/);
});

test('service does not expose raw ciphertext in Guard or CompanyStaff DTO mappers', () => {
  // toGuardDto must not reference internalNoteEnc directly
  const toGuardDtoIdx = service.lastIndexOf('private toGuardDto');
  const toGuardDtoBlock = service.slice(toGuardDtoIdx, toGuardDtoIdx + 600);
  assert.doesNotMatch(toGuardDtoBlock, /internalNoteEnc/);
  // toCompanyStaffDto must not reference internalNoteEnc
  const toStaffDtoIdx = service.lastIndexOf('private toCompanyStaffDto');
  const toStaffDtoBlock = service.slice(toStaffDtoIdx, toStaffDtoIdx + 600);
  assert.doesNotMatch(toStaffDtoBlock, /internalNoteEnc/);
});

test('migration does not include payRate salary bank fields', () => {
  assert.doesNotMatch(migration, /payRate|hourlyRate|salary(?!y)|bankAccount|taxCode/);
});

// ── HISTORICAL ACCESS & SENSITIVE READ HARDENING ──────────────────────────────

test('service has requireOwnedRelationship helper (ownership without ACTIVE check)', () => {
  const defIdx = service.indexOf('async requireOwnedRelationship(');
  assert.ok(defIdx !== -1, 'requireOwnedRelationship method not found');
  const fn = service.slice(defIdx, defIdx + 600);
  assert.match(fn, /requireCompanyIdForUser/);
  assert.doesNotMatch(fn, /CompanyGuardStatus\.ACTIVE/);
});

test('service getEmploymentForCompany uses requireOwnedRelationship (historical reads allowed)', () => {
  const getIdx = service.indexOf('getEmploymentForCompany(');
  const fn = service.slice(getIdx, getIdx + 800);
  assert.match(fn, /requireOwnedRelationship\(/);
  assert.doesNotMatch(fn, /requireOwnedActiveRelationship/);
});

test('service getEmploymentForCompany audits sensitive internalNote read', () => {
  const getIdx = service.indexOf('getEmploymentForCompany(');
  const fn = service.slice(getIdx, getIdx + 900);
  assert.match(fn, /employment_view_sensitive/);
});

test('service getEmploymentForCompany audit metadata includes companyGuardId guardId companyId', () => {
  const getIdx = service.indexOf('getEmploymentForCompany(');
  const fn = service.slice(getIdx, getIdx + 900);
  const auditIdx = fn.indexOf('auditLogService.log');
  assert.ok(auditIdx !== -1, 'auditLogService.log not found in getEmploymentForCompany');
  const auditBlock = fn.slice(auditIdx, auditIdx + 400);
  assert.match(auditBlock, /companyGuardId/);
  assert.match(auditBlock, /guardId/);
  assert.match(auditBlock, /companyId/);
});

test('service getEmploymentForCompany audit does not log note content or ciphertext', () => {
  const getIdx = service.indexOf('getEmploymentForCompany(');
  const fn = service.slice(getIdx, getIdx + 900);
  const auditIdx = fn.indexOf('auditLogService.log');
  assert.ok(auditIdx !== -1);
  const auditBlock = fn.slice(auditIdx, auditIdx + 400);
  assert.doesNotMatch(auditBlock, /internalNote[^E]|noteText|note.*value/i);
  assert.doesNotMatch(auditBlock, /internalNoteEnc/);
});

test('service upsertEmploymentForCompany uses requireOwnedRelationship (not active-only)', () => {
  const upsertIdx = service.indexOf('upsertEmploymentForCompany(');
  const fn = service.slice(upsertIdx, upsertIdx + 600);
  assert.match(fn, /requireOwnedRelationship\(/);
  assert.doesNotMatch(fn, /requireOwnedActiveRelationship/);
});

test('service upsert blocks first-create when relationship not ACTIVE', () => {
  const upsertIdx = service.indexOf('upsertEmploymentForCompany(');
  const fn = service.slice(upsertIdx, upsertIdx + 1800);
  assert.match(fn, /isCreating.*CompanyGuardStatus\.ACTIVE|CompanyGuardStatus\.ACTIVE.*isCreating/s);
});

test('service upsert does not modify CompanyGuard status (cross-domain isolation)', () => {
  const upsertIdx = service.indexOf('upsertEmploymentForCompany(');
  const fn = service.slice(upsertIdx, upsertIdx + 3500);
  assert.doesNotMatch(fn, /companyGuard\.status\s*=/);
});

test('service getEmploymentsForGuard returns records regardless of CompanyGuard status', () => {
  const getIdx = service.indexOf('getEmploymentsForGuard(');
  const fn = service.slice(getIdx, getIdx + 600);
  assert.doesNotMatch(fn, /CompanyGuardStatus\.ACTIVE/);
});

test('service getEmploymentForCompanyStaff requires ACTIVE relationship (INACTIVE denied)', () => {
  const staffIdx = service.indexOf('getEmploymentForCompanyStaff(');
  const fn = service.slice(staffIdx, staffIdx + 400);
  assert.match(fn, /requireOwnedActiveRelationship/);
});

test('service requireOwnedActiveRelationship retained for CompanyStaff use only', () => {
  assert.match(service, /requireOwnedActiveRelationship/);
  // It is now a separate helper — verify it still enforces ACTIVE
  const defIdx = service.lastIndexOf('private async requireOwnedActiveRelationship');
  assert.ok(defIdx !== -1);
  const fn = service.slice(defIdx, defIdx + 600);
  assert.match(fn, /CompanyGuardStatus\.ACTIVE/);
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`P1F Employment & Engagement — ${passed + failed} tests`);
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failed > 0) process.exit(1);
