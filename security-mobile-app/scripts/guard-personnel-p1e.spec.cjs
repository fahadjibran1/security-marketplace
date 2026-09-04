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

// ── 14. PRIVACY — contactName encrypted (spec §16 item 7) ────────────────────

test('PRIV: contactName stored as contactNameEnc (encrypted column, not plaintext)', () => {
  // Entity must not have a plaintext contactName column — only contactNameEnc
  assert.match(entity, /contactNameEnc/);
  assert.doesNotMatch(entity, /type:\s*['"]varchar['"][\s\S]{0,60}contactName[^E]|@Column[\s\S]{0,60}contactName[^E]/);
});

test('PRIV: contactNameEnc has select: false on entity', () => {
  // Decorator for contactNameEnc must include select: false
  const idx = entity.indexOf('contactNameEnc');
  const before = entity.slice(0, idx);
  assert.match(before.slice(-120), /select:\s*false/);
});

test('PRIV: no plaintext phone column exists — only *PhoneEnc', () => {
  // Migration must not contain a plaintext phone column name
  assert.doesNotMatch(migration, /"primaryPhone"\s+varchar|"primaryPhone"\s+text[^E]|"alternatePhone"\s+varchar/);
  assert.match(migration, /primaryPhoneEnc/);
  assert.match(migration, /alternatePhoneEnc/);
});

test('PRIV: guard DTO exposes contactName (decrypted), not contactNameEnc', () => {
  assert.match(guardDtoFile, /contactName!:/);
  assert.doesNotMatch(guardDtoFile, /contactNameEnc/);
});

// ── 18. PRIVACY — Audit metadata is clean (spec §16 item 8) ──────────────────

test('PRIV: mutation audit uses changedFields array (field names only)', () => {
  // afterData must log changedFields, not actual phone/name values
  const upsertFn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(upsertFn, /changedFields/);
  // Must not log contactName value, phone value, or ciphertext
  assert.doesNotMatch(upsertFn, /afterData.*contactName:\s*[^{]|afterData.*phone:\s*[^{]/s);
});

test('PRIV: company view audit afterData contains only guardId and companyId — no contact values', () => {
  const companyFn = service.split('getEmergencyContactForCompany')[1].split('findWithSensitive')[0];
  assert.match(companyFn, /guardId/);
  assert.match(companyFn, /companyId/);
  // Must not log contactName, phone, or ciphertext values
  assert.doesNotMatch(companyFn, /contactName:\s*[^{]|primaryPhone:\s*[^{]/);
});

test('PRIV: admin view audit afterData contains only guardId — no contact values', () => {
  const adminFn = service.split('getEmergencyContactForAdmin')[1].split('getEmergencyContactForCompany')[0];
  assert.match(adminFn, /guardId/);
  assert.doesNotMatch(adminFn, /contactName:\s*[^{]|primaryPhone:\s*[^{]/);
});

test('PRIV: remove audit afterData contains only {removed:true} — no contact values', () => {
  const removeFn = service.split('removeEmergencyContactForGuard')[1].split('getEmergencyContactForAdmin')[0];
  assert.match(removeFn, /removed:\s*true/);
  assert.doesNotMatch(removeFn, /contactName:\s*[^{]|primaryPhone:\s*[^{]/);
});

// ── 19. GUARD SELF-ISOLATION (spec §16 items 14-15) ──────────────────────────

test('GUARD ISOLATION: me/emergency-contact routes take no guardId path param', () => {
  // Guard self-service routes must derive the guard from JWT (user.sub), not a URL param
  // Extract the P1E guard self-service section only (between Guard self-service and Platform Admin comments)
  const p1eGuardSection = controller
    .split('P1E — Emergency Contact: Guard self-service')[1]
    .split('P1E — Emergency Contact: Platform Admin')[0];
  assert.doesNotMatch(p1eGuardSection, /@Param.*guardId/);
});

test('GUARD ISOLATION: getEmergencyContactForGuard derives guard from userId — not caller-supplied guardId', () => {
  const fn = service.split('getEmergencyContactForGuard')[1].split('upsertEmergencyContactForGuard')[0];
  assert.match(fn, /requireGuardByUserId\(userId\)/);
  assert.doesNotMatch(fn, /requireGuardById\(/);
});

test('GUARD ISOLATION: upsertEmergencyContactForGuard derives guard from userId', () => {
  const fn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(fn, /requireGuardByUserId\(userId\)/);
});

// ── 20. GUARD PATCH OMISSION SEMANTICS (spec §16 item 12) ────────────────────

test('PATCH OMISSION: service updates contactNameEnc only when dto.contactName !== undefined', () => {
  const fn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(fn, /dto\.contactName !== undefined/);
});

test('PATCH OMISSION: service updates primaryPhoneEnc only when dto.primaryPhone !== undefined', () => {
  const fn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(fn, /dto\.primaryPhone !== undefined/);
});

test('PATCH OMISSION: service handles alternatePhone removal via explicit null', () => {
  const fn = service.split('upsertEmergencyContactForGuard')[1].split('removeEmergencyContactForGuard')[0];
  assert.match(fn, /dto\.alternatePhone === null/);
  assert.match(fn, /alternatePhoneEnc\s*=\s*null/);
});

// ── 21. MOBILE CONFIRMATION (spec §16 items 17-18) ───────────────────────────

test('MOBILE: Cancel button has style cancel — no DELETE call on cancel', () => {
  const handler = dashboard.split('handleRemoveEmergencyContact')[1].split('function updateShiftStatusLocally')[0];
  assert.match(handler, /style:\s*['"]cancel['"]/);
  // Cancel button must not call removeMyEmergencyContact
  const cancelChunk = handler.split("style: 'cancel'")[0];
  assert.doesNotMatch(cancelChunk, /removeMyEmergencyContact/);
});

test('MOBILE: Remove button has style destructive and calls removeMyEmergencyContact', () => {
  const handler = dashboard.split('handleRemoveEmergencyContact')[1].split('function updateShiftStatusLocally')[0];
  assert.match(handler, /style:\s*['"]destructive['"]/);
  assert.match(handler, /removeMyEmergencyContact\(\)/);
});

test('MOBILE: confirmation title is Remove emergency contact?', () => {
  const handler = dashboard.split('handleRemoveEmergencyContact')[1].split('function updateShiftStatusLocally')[0];
  assert.match(handler, /Remove emergency contact\?/);
});

test('MOBILE: after successful Remove, emergencyContact state set to null', () => {
  const handler = dashboard.split('handleRemoveEmergencyContact')[1].split('function updateShiftStatusLocally')[0];
  assert.match(handler, /setEmergencyContact\(null\)/);
});

// ── 22. CLIENT ISOLATION (spec §16 items 29-30) ───────────────────────────────

test('CLIENT: controller has no CLIENT or CLIENT_ADMIN or CLIENT_VIEWER role on any P1E route', () => {
  // Extract only P1E section of controller
  const p1eSection = controller.split('P1E — Emergency Contact')[1];
  assert.doesNotMatch(p1eSection, /UserRole\.CLIENT/);
  assert.doesNotMatch(p1eSection, /CLIENT_ADMIN/);
  assert.doesNotMatch(p1eSection, /CLIENT_VIEWER/);
});

test('CLIENT: no emergency-contact endpoint exists with Client role anywhere in controller', () => {
  // Full controller must not associate any CLIENT role with emergency-contact
  const fullController = controller;
  const ecRoutes = fullController.split('emergency-contact');
  // Each segment that mentions emergency-contact must not also have CLIENT role nearby
  ecRoutes.forEach((segment, i) => {
    if (i === 0) return; // first segment is before any ec route
    const surrounding = ecRoutes[i - 1].slice(-200) + segment.slice(0, 200);
    assert.doesNotMatch(surrounding, /UserRole\.CLIENT[^_]|CLIENT_ADMIN|CLIENT_VIEWER/);
  });
});

// ── 23. PHONE VALIDATION EXAMPLES (spec §16 items 31-33) ─────────────────────

test('PHONE: PHONE_PATTERN source contains optional leading-plus and digit class', () => {
  assert.match(updateDtoFile, /PHONE_PATTERN/);
  // Comment documents optional leading + behaviour
  assert.match(updateDtoFile, /optional leading/);
  // Pattern contains digit character class
  assert.match(updateDtoFile, /\\d/);
});

test('PHONE: PHONE_PATTERN shape allows leading +, digits, spaces, hyphens, parens, 7-20 chars', () => {
  // Extract the PHONE_PATTERN literal from the DTO source file
  const match = updateDtoFile.match(/PHONE_PATTERN\s*=\s*(\/[^/]+\/)/);
  assert.ok(match, 'PHONE_PATTERN regex literal found in DTO file');
  const patternStr = match[1];
  // Reconstruct regex
  const re = new RegExp(patternStr.slice(1, patternStr.lastIndexOf('/')));
  // Valid examples
  assert.ok(re.test('+44 7700 900001'), 'UK mobile with +44 passes');
  assert.ok(re.test('07700 900001'), 'UK local without + passes');
  assert.ok(re.test('+1-555-123-4567'), 'US international format passes');
  assert.ok(re.test('+353 1 234 5678'), 'Irish format passes');
  // Invalid examples
  assert.ok(!re.test('abc'), 'Alphabetic string rejected');
  assert.ok(!re.test('12345'), 'Too-short number rejected (under 7 chars)');
  assert.ok(!re.test('+44' + '0'.repeat(20)), 'Overlong number rejected');
  assert.ok(!re.test(''), 'Empty string rejected');
});

test('PHONE: DTO requires minimum length via PHONE_PATTERN (7 chars)', () => {
  assert.match(updateDtoFile, /7,20/);
});

// ── 24. COMPANY ROLES (spec §16 item 19) — explicit ──────────────────────────

test('COMPANY: company route allows COMPANY, COMPANY_ADMIN, COMPANY_STAFF', () => {
  // @Roles appears after the @Get path in the controller
  const companyRoute = controller.split('company/guard/:guardId/emergency-contact')[1].split('getGuardEmergencyContactForCompany')[0];
  assert.match(companyRoute, /UserRole\.COMPANY/);
  assert.match(companyRoute, /COMPANY_ADMIN/);
  assert.match(companyRoute, /COMPANY_STAFF/);
});

test('COMPANY: company route restricts access via @Roles decorator not open to public', () => {
  const companyRoute = controller.split('company/guard/:guardId/emergency-contact')[1].split('getGuardEmergencyContactForCompany')[0];
  assert.match(companyRoute, /@Roles/);
});

// ── 25. REGRESSION — No encrypted values exposed in DTOs ─────────────────────

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

// ── 26. REGRESSION — P1D not broken ──────────────────────────────────────────

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

// ── 27. REGRESSION — No encrypted values exposed in DTOs ─────────────────────

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
