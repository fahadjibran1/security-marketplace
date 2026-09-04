'use strict';
// P1E — Emergency Contact — Static file analysis spec
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
const entity = backend('guard-personnel/entities/guard-emergency-contact.entity.ts');
const migration = backend('database/migrations/1720400000000-AddGuardEmergencyContactP1E.ts');
const controller = backend('guard-personnel/guard-personnel.controller.ts');
const service = backend('guard-personnel/emergency-contact.service.ts');
const module_ = backend('guard-personnel/guard-personnel.module.ts');
const entities = backend('database/entities.ts');
const guardDtoFile = backend('guard-personnel/dto/emergency-contact-guard-response.dto.ts');
const adminDtoFile = backend('guard-personnel/dto/emergency-contact-admin-response.dto.ts');
const companyDtoFile = backend('guard-personnel/dto/emergency-contact-company-response.dto.ts');
const updateDtoFile = backend('guard-personnel/dto/update-emergency-contact.dto.ts');

// ── 1. MOBILE API ─────────────────────────────────────────────────────────────

test('api.ts exports getMyEmergencyContact', () => {
  assert.match(api, /export function getMyEmergencyContact/);
});

test('getMyEmergencyContact calls /guard-personnel/me/emergency-contact via GET', () => {
  const fn = api.split('getMyEmergencyContact')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/emergency-contact/);
});

test('api.ts exports upsertMyEmergencyContact', () => {
  assert.match(api, /export function upsertMyEmergencyContact/);
});

test('upsertMyEmergencyContact uses PATCH method', () => {
  const fn = api.split('upsertMyEmergencyContact')[1].split('export function')[0];
  assert.match(fn, /method:\s*['"]PATCH['"]/);
});

test('upsertMyEmergencyContact sends payload as JSON body', () => {
  const fn = api.split('upsertMyEmergencyContact')[1].split('export function')[0];
  assert.match(fn, /JSON\.stringify\(payload\)/);
});

test('api.ts exports removeMyEmergencyContact', () => {
  assert.match(api, /export function removeMyEmergencyContact/);
});

test('removeMyEmergencyContact uses DELETE method', () => {
  const fn = api.split('removeMyEmergencyContact')[1].split('export function')[0];
  assert.match(fn, /method:\s*['"]DELETE['"]/);
});

test('removeMyEmergencyContact targets /guard-personnel/me/emergency-contact', () => {
  const fn = api.split('removeMyEmergencyContact')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/emergency-contact/);
});

// ── 2. MOBILE TYPES ───────────────────────────────────────────────────────────

test('models.ts declares EmergencyContactRelationship type', () => {
  assert.match(models, /EmergencyContactRelationship/);
});

test('EmergencyContactRelationship includes SPOUSE_PARTNER PARENT SIBLING CHILD RELATIVE FRIEND OTHER', () => {
  const idx = models.indexOf('EmergencyContactRelationship');
  const block = models.slice(idx, idx + 300);
  assert.match(block, /SPOUSE_PARTNER/);
  assert.match(block, /PARENT/);
  assert.match(block, /SIBLING/);
  assert.match(block, /CHILD/);
  assert.match(block, /RELATIVE/);
  assert.match(block, /FRIEND/);
  assert.match(block, /OTHER/);
});

test('models.ts declares GuardEmergencyContact interface', () => {
  assert.match(models, /interface GuardEmergencyContact/);
});

test('GuardEmergencyContact has contactName, relationship, primaryPhone fields', () => {
  const iface = models.split('GuardEmergencyContact')[1].split('}')[0];
  assert.match(iface, /contactName/);
  assert.match(iface, /relationship/);
  assert.match(iface, /primaryPhone/);
});

test('GuardEmergencyContact has alternatePhone nullable', () => {
  const iface = models.split('GuardEmergencyContact')[1].split('}')[0];
  assert.match(iface, /alternatePhone.*\|\s*null/);
});

test('GuardEmergencyContact has guardId and updatedAt', () => {
  const iface = models.split('GuardEmergencyContact')[1].split('}')[0];
  assert.match(iface, /guardId/);
  assert.match(iface, /updatedAt/);
});

test('models.ts declares UpdateEmergencyContactPayload interface', () => {
  assert.match(models, /interface UpdateEmergencyContactPayload/);
});

test('UpdateEmergencyContactPayload has contactName, relationship, primaryPhone as optional', () => {
  const iface = models.split('UpdateEmergencyContactPayload')[1].split('}')[0];
  assert.match(iface, /contactName\?/);
  assert.match(iface, /relationship\?/);
  assert.match(iface, /primaryPhone\?/);
});

// ── 3. DASHBOARD IMPORTS ──────────────────────────────────────────────────────

test('dashboard imports getMyEmergencyContact', () => {
  assert.match(dashboard, /getMyEmergencyContact/);
});

test('dashboard imports upsertMyEmergencyContact', () => {
  assert.match(dashboard, /upsertMyEmergencyContact/);
});

test('dashboard imports removeMyEmergencyContact', () => {
  assert.match(dashboard, /removeMyEmergencyContact/);
});

test('dashboard imports GuardEmergencyContact type', () => {
  assert.match(dashboard, /GuardEmergencyContact/);
});

test('dashboard imports EmergencyContactRelationship type', () => {
  assert.match(dashboard, /EmergencyContactRelationship/);
});

// ── 4. DASHBOARD STATE ────────────────────────────────────────────────────────

test('dashboard declares emergencyContact state as GuardEmergencyContact | null', () => {
  assert.match(dashboard, /useState<GuardEmergencyContact \| null>\(null\)/);
});

test('dashboard declares emergencyContactLoading state', () => {
  assert.match(dashboard, /emergencyContactLoading.*setEmergencyContactLoading/);
});

test('dashboard declares emergencyContactError state', () => {
  assert.match(dashboard, /emergencyContactError.*setEmergencyContactError/);
});

test('dashboard declares emergencyContactSaving state', () => {
  assert.match(dashboard, /emergencyContactSaving.*setEmergencyContactSaving/);
});

test('dashboard declares editingEmergencyContact state', () => {
  assert.match(dashboard, /editingEmergencyContact.*setEditingEmergencyContact/);
});

test('dashboard declares ecNameInput state', () => {
  assert.match(dashboard, /ecNameInput.*setEcNameInput/);
});

test('dashboard declares ecRelationshipInput state', () => {
  assert.match(dashboard, /ecRelationshipInput.*setEcRelationshipInput/);
});

test('dashboard declares ecPrimaryPhoneInput state', () => {
  assert.match(dashboard, /ecPrimaryPhoneInput.*setEcPrimaryPhoneInput/);
});

test('dashboard declares ecAlternatePhoneInput state', () => {
  assert.match(dashboard, /ecAlternatePhoneInput.*setEcAlternatePhoneInput/);
});

test('dashboard declares ecInputError state', () => {
  assert.match(dashboard, /ecInputError.*setEcInputError/);
});

// ── 5. DASHBOARD FUNCTIONS ────────────────────────────────────────────────────

test('dashboard has loadEmergencyContact function calling getMyEmergencyContact', () => {
  assert.match(dashboard, /async function loadEmergencyContact|function loadEmergencyContact/);
  const fn = dashboard.split('loadEmergencyContact')[1].split('function ')[0];
  assert.match(fn, /getMyEmergencyContact/);
});

test('loadEmergencyContact is called inside loadData', () => {
  const loadDataFn = dashboard.split('async function loadData')[1].split('async function handleSaveProfile')[0];
  assert.match(loadDataFn, /loadEmergencyContact/);
});

test('dashboard has handleSaveEmergencyContact calling upsertMyEmergencyContact', () => {
  assert.match(dashboard, /handleSaveEmergencyContact/);
  const fn = dashboard.split('handleSaveEmergencyContact')[1].split('function ')[0];
  assert.match(fn, /upsertMyEmergencyContact/);
});

test('dashboard has handleRemoveEmergencyContact calling removeMyEmergencyContact', () => {
  assert.match(dashboard, /handleRemoveEmergencyContact/);
  const fn = dashboard.split('handleRemoveEmergencyContact')[1].split('function ')[0];
  assert.match(fn, /removeMyEmergencyContact/);
});

test('handleRemoveEmergencyContact uses Alert.alert for destructive confirmation', () => {
  const fn = dashboard.split('handleRemoveEmergencyContact')[1].split('function ')[0];
  assert.match(fn, /Alert\.alert/);
});

test('dashboard has openEmergencyContactEditor function', () => {
  assert.match(dashboard, /openEmergencyContactEditor/);
});

// ── 6. DASHBOARD UI CARD ──────────────────────────────────────────────────────

test('dashboard renders Emergency contact FeatureCard', () => {
  assert.match(dashboard, /title="Emergency contact"/);
});

test('emergency contact card shows emergencyContactLoading state', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /emergencyContactLoading/);
});

test('emergency contact card shows emergencyContactError', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /emergencyContactError/);
});

test('emergency contact card shows contactName when set', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /contactName/);
});

test('emergency contact card shows relationship field', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /relationship/);
});

test('emergency contact card shows primaryPhone', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /primaryPhone/);
});

test('emergency contact card has encrypted at rest privacy notice', () => {
  const card = dashboard.split('title="Emergency contact"')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /encrypted at rest/);
});

// ── 7. BACKEND — ENTITY ───────────────────────────────────────────────────────

test('entity declares EmergencyContactRelationship enum', () => {
  assert.match(entity, /enum EmergencyContactRelationship/);
});

test('EmergencyContactRelationship has SPOUSE_PARTNER PARENT SIBLING CHILD RELATIVE FRIEND OTHER', () => {
  const e = entity.split('EmergencyContactRelationship')[1].split('}')[0];
  assert.match(e, /SPOUSE_PARTNER/);
  assert.match(e, /PARENT/);
  assert.match(e, /SIBLING/);
  assert.match(e, /CHILD/);
  assert.match(e, /RELATIVE/);
  assert.match(e, /FRIEND/);
  assert.match(e, /OTHER/);
});

test('entity declares GuardEmergencyContact class for guard_emergency_contacts table', () => {
  assert.match(entity, /guard_emergency_contacts/);
  assert.match(entity, /class GuardEmergencyContact/);
});

test('entity has OneToOne relation to GuardProfile with CASCADE delete', () => {
  assert.match(entity, /OneToOne/);
  assert.match(entity, /CASCADE/);
});

test('contactNameEnc column has select: false', () => {
  assert.match(entity, /contactNameEnc/);
  const col = entity.split('contactNameEnc')[0];
  // select: false should appear before contactNameEnc
  assert.match(entity, /select:\s*false[\s\S]{0,200}contactNameEnc|contactNameEnc[\s\S]{0,50}select:\s*false/);
});

test('primaryPhoneEnc column has select: false', () => {
  assert.match(entity, /primaryPhoneEnc/);
  assert.match(entity, /select:\s*false/);
});

test('alternatePhoneEnc column has select: false and nullable', () => {
  assert.match(entity, /alternatePhoneEnc/);
  const idx = entity.indexOf('alternatePhoneEnc');
  const before = entity.slice(0, idx);
  assert.match(before.slice(-200), /select:\s*false/);
});

test('relationship column uses enumName emergency_contact_relationship_enum', () => {
  assert.match(entity, /enumName.*emergency_contact_relationship_enum/);
});

test('customRelationship column is nullable varchar 100', () => {
  assert.match(entity, /customRelationship/);
  assert.match(entity, /nullable:\s*true/);
  assert.match(entity, /length:\s*100/);
});

test('entity has createdAt and updatedAt columns', () => {
  assert.match(entity, /createdAt/);
  assert.match(entity, /updatedAt/);
  assert.match(entity, /CreateDateColumn/);
  assert.match(entity, /UpdateDateColumn/);
});

// ── 8. BACKEND — MIGRATION ────────────────────────────────────────────────────

test('migration creates emergency_contact_relationship_enum type', () => {
  assert.match(migration, /emergency_contact_relationship_enum/);
  assert.match(migration, /SPOUSE_PARTNER/);
  assert.match(migration, /PARENT/);
  assert.match(migration, /OTHER/);
});

test('migration creates guard_emergency_contacts table', () => {
  assert.match(migration, /CREATE TABLE.*guard_emergency_contacts/s);
});

test('migration table has contactNameEnc text column', () => {
  assert.match(migration, /contactNameEnc.*text|"contactNameEnc"\s+text/s);
});

test('migration table has primaryPhoneEnc and alternatePhoneEnc', () => {
  assert.match(migration, /primaryPhoneEnc/);
  assert.match(migration, /alternatePhoneEnc/);
});

test('migration adds FK constraint to guard_profiles ON DELETE CASCADE', () => {
  assert.match(migration, /REFERENCES.*guard_profiles/s);
  assert.match(migration, /ON DELETE CASCADE/);
});

test('migration adds UNIQUE constraint on guardId', () => {
  assert.match(migration, /UNIQUE.*guardId|guardId.*UNIQUE/s);
});

test('migration down drops table and type', () => {
  const down = migration.split('down(')[1];
  assert.match(down, /DROP TABLE.*guard_emergency_contacts/s);
  assert.match(down, /DROP TYPE.*emergency_contact_relationship_enum/s);
});

// ── 9. BACKEND — SERVICE ──────────────────────────────────────────────────────

test('service declares EmergencyContactService class', () => {
  assert.match(service, /class EmergencyContactService/);
});

test('service injects GuardEmergencyContact repository', () => {
  assert.match(service, /InjectRepository\(GuardEmergencyContact\)/);
});

test('service injects User repository', () => {
  assert.match(service, /InjectRepository\(User\)/);
});

test('service injects GuardProfile repository', () => {
  assert.match(service, /InjectRepository\(GuardProfile\)/);
});

test('service has getEmergencyContactForGuard method', () => {
  assert.match(service, /getEmergencyContactForGuard/);
});

test('service has upsertEmergencyContactForGuard method', () => {
  assert.match(service, /upsertEmergencyContactForGuard/);
});

test('service has removeEmergencyContactForGuard method', () => {
  assert.match(service, /removeEmergencyContactForGuard/);
});

test('service has getEmergencyContactForAdmin method', () => {
  assert.match(service, /getEmergencyContactForAdmin/);
});

test('service has getEmergencyContactForCompany method', () => {
  assert.match(service, /getEmergencyContactForCompany/);
});

test('service has findWithSensitive using addSelect for encrypted columns', () => {
  assert.match(service, /findWithSensitive/);
  assert.match(service, /addSelect/);
  assert.match(service, /contactNameEnc/);
  assert.match(service, /primaryPhoneEnc/);
});

test('service uses EncryptionService for encrypt/decrypt', () => {
  assert.match(service, /EncryptionService/);
  assert.match(service, /encrypt\(|\.encrypt/);
  assert.match(service, /decrypt\(|\.decrypt/);
});

test('service audits emergency_contact_update action on upsert', () => {
  const upsertFn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(upsertFn, /guard_personnel\.emergency_contact_update/);
  assert.match(upsertFn, /auditLogService\.log/);
});

test('service audits emergency_contact_remove action on delete', () => {
  const removeFn = service.split('removeEmergencyContactForGuard')[1].split('getEmergencyContactForAdmin')[0];
  assert.match(removeFn, /guard_personnel\.emergency_contact_remove/);
  assert.match(removeFn, /auditLogService\.log/);
});

test('service audits emergency_contact_view action on admin/company read', () => {
  const adminFn = service.split('getEmergencyContactForAdmin')[1].split('getEmergencyContactForCompany')[0];
  assert.match(adminFn, /guard_personnel\.emergency_contact_view/);
});

test('getEmergencyContactForCompany enforces active company-guard relationship', () => {
  const companyFn = service.split('getEmergencyContactForCompany')[1].split('findWithSensitive')[0];
  assert.match(companyFn, /requireActiveCompanyGuardRelationship|ACTIVE/);
});

test('service throws NotFoundException for remove when contact not found', () => {
  const removeFn = service.split('removeEmergencyContactForGuard')[1].split('getEmergencyContactForAdmin')[0];
  assert.match(removeFn, /NotFoundException/);
});

test('service validates that required fields present on first create', () => {
  const upsertFn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(upsertFn, /contactName|primaryPhone/);
  assert.match(upsertFn, /BadRequestException/);
});

// ── 10. BACKEND — CONTROLLER ──────────────────────────────────────────────────

test('controller has GET me/emergency-contact route', () => {
  assert.match(controller, /me\/emergency-contact/);
});

test('controller has PATCH me/emergency-contact route for guard', () => {
  const guardPatch = controller.split('me/emergency-contact')[1];
  assert.match(guardPatch, /Patch/);
});

test('controller has DELETE me/emergency-contact route', () => {
  assert.match(controller, /Delete\(/);
  assert.match(controller, /HttpCode.*NO_CONTENT|NO_CONTENT.*HttpCode/s);
});

test('controller has GET admin/:id/emergency-contact route', () => {
  assert.match(controller, /admin.*emergency-contact|emergency-contact.*admin/s);
  assert.match(controller, /admin\/:id\/emergency-contact|:id.*emergency-contact/s);
});

test('controller has GET company/guard/:guardId/emergency-contact route', () => {
  assert.match(controller, /company\/guard\/:guardId\/emergency-contact/);
});

test('controller injects EmergencyContactService', () => {
  assert.match(controller, /EmergencyContactService/);
  assert.match(controller, /emergencyContactService/);
});

test('controller imports UpdateEmergencyContactDto', () => {
  assert.match(controller, /UpdateEmergencyContactDto/);
});

// ── 11. BACKEND — MODULE ──────────────────────────────────────────────────────

test('module registers GuardEmergencyContact entity via TypeOrmModule.forFeature', () => {
  assert.match(module_, /GuardEmergencyContact/);
  assert.match(module_, /forFeature/);
});

test('module provides EmergencyContactService', () => {
  assert.match(module_, /EmergencyContactService/);
  assert.match(module_, /providers/);
});

// ── 12. BACKEND — ENTITIES REGISTRATION ──────────────────────────────────────

test('entities.ts imports GuardEmergencyContact', () => {
  assert.match(entities, /GuardEmergencyContact/);
});

test('entities.ts adds GuardEmergencyContact to appEntities array', () => {
  const appEntitiesBlock = entities.split('appEntities')[1].split(']')[0];
  assert.match(appEntitiesBlock, /GuardEmergencyContact/);
});

// ── 13. BACKEND — DTOs ────────────────────────────────────────────────────────

test('update DTO defines PHONE_PATTERN regex', () => {
  assert.match(updateDtoFile, /PHONE_PATTERN/);
  assert.match(updateDtoFile, /Matches.*PHONE_PATTERN/s);
});

test('update DTO validates contactName with MaxLength 100', () => {
  assert.match(updateDtoFile, /MaxLength.*100|@MaxLength\(100\)/s);
});

test('update DTO validates relationship with IsEnum', () => {
  assert.match(updateDtoFile, /IsEnum.*EmergencyContactRelationship/s);
});

test('update DTO validates primaryPhone with Matches pattern', () => {
  assert.match(updateDtoFile, /primaryPhone/);
  assert.match(updateDtoFile, /Matches/);
});

test('guard response DTO has contactName, relationship, primaryPhone, alternatePhone', () => {
  assert.match(guardDtoFile, /contactName/);
  assert.match(guardDtoFile, /relationship/);
  assert.match(guardDtoFile, /primaryPhone/);
  assert.match(guardDtoFile, /alternatePhone/);
});

test('guard response DTO has guardId and updatedAt', () => {
  assert.match(guardDtoFile, /guardId/);
  assert.match(guardDtoFile, /updatedAt/);
});

test('admin response DTO has same fields as guard DTO', () => {
  assert.match(adminDtoFile, /contactName/);
  assert.match(adminDtoFile, /primaryPhone/);
  assert.match(adminDtoFile, /relationship/);
  assert.match(adminDtoFile, /guardId/);
});

test('company response DTO has contactName, relationship, primaryPhone', () => {
  assert.match(companyDtoFile, /contactName/);
  assert.match(companyDtoFile, /relationship/);
  assert.match(companyDtoFile, /primaryPhone/);
});

// ── 14. REGRESSION — P1A not broken ──────────────────────────────────────────

test('REG: P1A — api.ts still exports getMyPersonnelIdentity', () => {
  assert.match(api, /export function getMyPersonnelIdentity/);
});

test('REG: P1A — api.ts still exports updateMyPersonnelIdentity', () => {
  assert.match(api, /export function updateMyPersonnelIdentity/);
});

test('REG: P1A — models.ts still has GuardPersonnelIdentity interface', () => {
  assert.match(models, /interface GuardPersonnelIdentity/);
});

test('REG: P1A — dashboard still imports getMyPersonnelIdentity', () => {
  assert.match(dashboard, /getMyPersonnelIdentity/);
});

test('REG: P1A — controller still has me/identity route', () => {
  assert.match(controller, /me\/identity/);
});

// ── 15. REGRESSION — P1D not broken ──────────────────────────────────────────

test('REG: P1D — api.ts still exports getMyDrivingTransport', () => {
  assert.match(api, /export function getMyDrivingTransport/);
});

test('REG: P1D — api.ts still exports updateMyDrivingTransport', () => {
  assert.match(api, /export function updateMyDrivingTransport/);
});

test('REG: P1D — models.ts still has GuardDrivingTransport interface', () => {
  assert.match(models, /interface GuardDrivingTransport/);
});

test('REG: P1D — dashboard still imports getMyDrivingTransport', () => {
  assert.match(dashboard, /getMyDrivingTransport/);
});

test('REG: P1D — controller still has me/driving-transport route', () => {
  assert.match(controller, /me\/driving-transport/);
});

// ── 16. REGRESSION — No encrypted values exposed in DTOs ─────────────────────

test('guard response DTO does not expose contactNameEnc, primaryPhoneEnc, alternatePhoneEnc', () => {
  assert.doesNotMatch(guardDtoFile, /contactNameEnc/);
  assert.doesNotMatch(guardDtoFile, /primaryPhoneEnc/);
  assert.doesNotMatch(guardDtoFile, /alternatePhoneEnc/);
});

test('admin response DTO does not expose enc fields', () => {
  assert.doesNotMatch(adminDtoFile, /contactNameEnc/);
  assert.doesNotMatch(adminDtoFile, /primaryPhoneEnc/);
});

test('company response DTO does not expose enc fields', () => {
  assert.doesNotMatch(companyDtoFile, /contactNameEnc/);
  assert.doesNotMatch(companyDtoFile, /primaryPhoneEnc/);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passed} PASS / 0 FAIL`);
console.log(JSON.stringify({ event: 'guard_personnel_p1e_tests', passed, failed: 0 }));
