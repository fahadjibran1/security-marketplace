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
const drivingEntity = backend('guard-personnel/entities/guard-driving-profile.entity.ts');
const migration = backend('database/migrations/1720300000000-AddGuardDrivingProfileP1D.ts');
const controller = backend('guard-personnel/guard-personnel.controller.ts');
const drivingService = backend('guard-personnel/driving-transport.service.ts');
const module_ = backend('guard-personnel/guard-personnel.module.ts');
const guardDocEntity = backend('compliance/entities/guard-document.entity.ts');
const guardDtoFile = backend('guard-personnel/dto/driving-transport-guard-response.dto.ts');
const adminDtoFile = backend('guard-personnel/dto/driving-transport-admin-response.dto.ts');
const companyDtoFile = backend('guard-personnel/dto/driving-transport-company-response.dto.ts');
const updateDtoFile = backend('guard-personnel/dto/update-driving-transport.dto.ts');

// ── MOBILE API ────────────────────────────────────────────────────────────────

test('api.ts exports getMyDrivingTransport', () => {
  assert.match(api, /export function getMyDrivingTransport/);
});

test('getMyDrivingTransport calls /guard-personnel/me/driving-transport via GET', () => {
  const fn = api.split('getMyDrivingTransport')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/driving-transport/);
});

test('api.ts exports updateMyDrivingTransport', () => {
  assert.match(api, /export function updateMyDrivingTransport/);
});

test('updateMyDrivingTransport uses PATCH method', () => {
  const fn = api.split('updateMyDrivingTransport')[1].split('export function')[0];
  assert.match(fn, /method:\s*['"]PATCH['"]/);
});

test('updateMyDrivingTransport sends payload as JSON body', () => {
  const fn = api.split('updateMyDrivingTransport')[1].split('export function')[0];
  assert.match(fn, /JSON\.stringify\(payload\)/);
});

test('api.ts exports revealMyDrivingLicenceNumber', () => {
  assert.match(api, /export function revealMyDrivingLicenceNumber/);
});

test('revealMyDrivingLicenceNumber uses POST to /guard-personnel/me/driving-licence/reveal', () => {
  const fn = api.split('revealMyDrivingLicenceNumber')[1].split('export function')[0];
  assert.match(fn, /guard-personnel\/me\/driving-licence\/reveal/);
  assert.match(fn, /method:\s*['"]POST['"]/);
});

test('revealMyDrivingLicenceNumber sends licenceNumber field in body', () => {
  const fn = api.split('revealMyDrivingLicenceNumber')[1].split('export function')[0];
  assert.match(fn, /licenceNumber/);
});

// ── MOBILE TYPES ──────────────────────────────────────────────────────────────

test('models.ts declares GuardDrivingTransport interface', () => {
  assert.match(models, /interface GuardDrivingTransport/);
});

test('GuardDrivingTransport has licenceStatus, licenceNumberSet, licenceNumberMasked', () => {
  const iface = models.split('GuardDrivingTransport')[1].split('}')[0];
  assert.match(iface, /licenceStatus/);
  assert.match(iface, /licenceNumberSet/);
  assert.match(iface, /licenceNumberMasked/);
});

test('GuardDrivingTransport has primaryTravelMethod and maxTravelDistanceMiles', () => {
  const iface = models.split('GuardDrivingTransport')[1].split('}')[0];
  assert.match(iface, /primaryTravelMethod/);
  assert.match(iface, /maxTravelDistanceMiles/);
});

test('GuardDrivingTransport has willingToDriveToWork, ownsVehicle, hasVehicleAccess', () => {
  const iface = models.split('GuardDrivingTransport')[1].split('}')[0];
  assert.match(iface, /willingToDriveToWork/);
  assert.match(iface, /ownsVehicle/);
  assert.match(iface, /hasVehicleAccess/);
});

test('models.ts declares DrivingLicenceStatus type', () => {
  assert.match(models, /DrivingLicenceStatus/);
  assert.match(models, /NONE.*PROVISIONAL.*FULL.*OTHER_OR_FOREIGN|NONE[\s\S]{0,50}OTHER_OR_FOREIGN/);
});

test('models.ts declares PrimaryTravelMethod type', () => {
  assert.match(models, /PrimaryTravelMethod/);
  assert.match(models, /PUBLIC_TRANSPORT/);
});

test('models.ts declares DrivingLicenceRevealResponse interface', () => {
  assert.match(models, /interface DrivingLicenceRevealResponse/);
});

test('DrivingLicenceRevealResponse has field: licenceNumber and revealedValue', () => {
  const iface = models.split('DrivingLicenceRevealResponse')[1].split('}')[0];
  assert.match(iface, /licenceNumber/);
  assert.match(iface, /revealedValue/);
});

test('models.ts declares UpdateDrivingTransportPayload interface', () => {
  assert.match(models, /interface UpdateDrivingTransportPayload/);
});

test('UpdateDrivingTransportPayload has licenceStatus and licenceNumberPlaintext', () => {
  const iface = models.split('UpdateDrivingTransportPayload')[1].split('}')[0];
  assert.match(iface, /licenceStatus/);
  assert.match(iface, /licenceNumberPlaintext/);
});

// ── DASHBOARD IMPORTS ─────────────────────────────────────────────────────────

test('dashboard imports getMyDrivingTransport', () => {
  assert.match(dashboard, /getMyDrivingTransport/);
});

test('dashboard imports updateMyDrivingTransport', () => {
  assert.match(dashboard, /updateMyDrivingTransport/);
});

test('dashboard imports revealMyDrivingLicenceNumber', () => {
  assert.match(dashboard, /revealMyDrivingLicenceNumber/);
});

test('dashboard imports GuardDrivingTransport type', () => {
  assert.match(dashboard, /GuardDrivingTransport/);
});

test('dashboard imports DrivingLicenceStatus type', () => {
  assert.match(dashboard, /DrivingLicenceStatus/);
});

test('dashboard imports PrimaryTravelMethod type', () => {
  assert.match(dashboard, /PrimaryTravelMethod/);
});

// ── DASHBOARD STATE ───────────────────────────────────────────────────────────

test('dashboard declares driving state as GuardDrivingTransport | null', () => {
  assert.match(dashboard, /useState<GuardDrivingTransport \| null>\(null\)/);
});

test('dashboard declares drivingLoading state', () => {
  assert.match(dashboard, /drivingLoading.*setDrivingLoading/);
});

test('dashboard declares drivingError state', () => {
  assert.match(dashboard, /drivingError.*setDrivingError/);
});

test('dashboard declares editingLicenceNumber state', () => {
  assert.match(dashboard, /editingLicenceNumber.*setEditingLicenceNumber/);
});

test('dashboard declares licenceNumberInputError state', () => {
  assert.match(dashboard, /licenceNumberInputError/);
});

test('dashboard declares drivingSaving state', () => {
  assert.match(dashboard, /drivingSaving.*setDrivingSaving/);
});

test('dashboard declares revealedLicenceValue state', () => {
  assert.match(dashboard, /revealedLicenceValue.*setRevealedLicenceValue/);
});

test('dashboard declares licenceRevealCountdown state', () => {
  assert.match(dashboard, /licenceRevealCountdown.*setLicenceRevealCountdown/);
});

test('dashboard declares licenceRevealTimerRef', () => {
  assert.match(dashboard, /licenceRevealTimerRef.*useRef/);
});

// ── DASHBOARD FUNCTIONS ───────────────────────────────────────────────────────

test('dashboard has loadDriving function calling getMyDrivingTransport', () => {
  assert.match(dashboard, /async function loadDriving/);
  const fn = dashboard.split('async function loadDriving')[1].split('function clearLicenceReveal')[0];
  assert.match(fn, /getMyDrivingTransport/);
});

test('dashboard has clearLicenceReveal function', () => {
  assert.match(dashboard, /function clearLicenceReveal/);
  const fn = dashboard.split('clearLicenceReveal')[1].split('function startLicenceRevealCountdown')[0];
  assert.match(fn, /clearInterval/);
  assert.match(fn, /setRevealedLicenceValue\(null\)/);
});

test('dashboard has startLicenceRevealCountdown using setInterval', () => {
  assert.match(dashboard, /function startLicenceRevealCountdown/);
  const fn = dashboard.split('startLicenceRevealCountdown')[1].split('async function handleRevealLicenceNumber')[0];
  assert.match(fn, /setInterval/);
});

test('licence reveal countdown is 10 seconds', () => {
  const fn = dashboard.split('startLicenceRevealCountdown')[1].split('async function handleRevealLicenceNumber')[0];
  assert.match(fn, /REVEAL_SECONDS.*10|10.*REVEAL_SECONDS/);
});

test('dashboard has handleRevealLicenceNumber calling revealMyDrivingLicenceNumber', () => {
  assert.match(dashboard, /async function handleRevealLicenceNumber/);
  const fn = dashboard.split('handleRevealLicenceNumber')[1].split('async function handleSaveLicenceNumber')[0];
  assert.match(fn, /revealMyDrivingLicenceNumber/);
});

test('dashboard has handleSaveLicenceNumber calling updateMyDrivingTransport', () => {
  assert.match(dashboard, /async function handleSaveLicenceNumber/);
  const fn = dashboard.split('handleSaveLicenceNumber')[1].split('async function handleUpdateDrivingField')[0];
  assert.match(fn, /updateMyDrivingTransport/);
  assert.match(fn, /licenceNumberPlaintext/);
});

test('dashboard has handleUpdateDrivingField for field-level updates', () => {
  assert.match(dashboard, /async function handleUpdateDrivingField/);
  const fn = dashboard.split('handleUpdateDrivingField')[1].split('function updateShiftStatusLocally')[0];
  assert.match(fn, /updateMyDrivingTransport/);
});

test('loadDriving is called inside loadData', () => {
  const loadDataFn = dashboard.split('async function loadData')[1].split('async function handleSaveProfile')[0];
  assert.match(loadDataFn, /loadDriving/);
});

test('cleanup useEffect also clears licenceRevealTimerRef', () => {
  const cleanupBlock = dashboard.split('Clear reveal timers')[1].split('const attendanceByShiftId')[0];
  assert.match(cleanupBlock, /licenceRevealTimerRef\.current/);
  assert.match(cleanupBlock, /clearInterval/);
});

// ── DASHBOARD UI CARD ─────────────────────────────────────────────────────────

test('dashboard renders Driving & transport FeatureCard', () => {
  assert.match(dashboard, /Driving & transport/);
});

test('driving card shows drivingLoading state', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /drivingLoading/);
});

test('driving card shows drivingError in danger color', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /drivingError/);
  assert.match(card, /colors\.danger/);
});

test('driving card renders DrivingLicenceStatus options NONE PROVISIONAL FULL OTHER_OR_FOREIGN', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /NONE/);
  assert.match(card, /PROVISIONAL/);
  assert.match(card, /FULL/);
  assert.match(card, /OTHER_OR_FOREIGN/);
});

test('driving card licence number section conditional on status not NONE', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /licenceStatus.*!==.*'NONE'|!.*=.*'NONE'.*licenceStatus/s);
});

test('driving card licence Show button disabled when licenceNumberSet is false', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /licenceNumberSet.*disabled|disabled.*licenceNumberSet/s);
});

test('driving card shows revealedLicenceValue when revealed, masked otherwise', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /revealedLicenceValue/);
  assert.match(card, /licenceNumberMasked/);
});

test('driving card hide button shows licenceRevealCountdown seconds', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /licenceRevealCountdown.*s\)|licenceRevealCountdown.*s}/s);
});

test('driving card renders PrimaryTravelMethod options including PUBLIC_TRANSPORT', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /PUBLIC_TRANSPORT/);
  assert.match(card, /CAR/);
  assert.match(card, /BICYCLE/);
});

test('driving card renders maxTravelDistanceMiles quick-select buttons', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /maxTravelDistanceMiles/);
});

test('driving card renders willingToDriveToWork, ownsVehicle, hasVehicleAccess toggles', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /willingToDriveToWork/);
  assert.match(card, /ownsVehicle/);
  assert.match(card, /hasVehicleAccess/);
});

test('driving card has privacy notice about encryption at rest', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /encrypted at rest/);
});

test('driving card licence autoCapitalize characters', () => {
  const card = dashboard.split('Driving & transport')[1].split('guardProfileBelowStack')[0];
  assert.match(card, /autoCapitalize="characters"/);
});

// ── BACKEND — ENTITY ──────────────────────────────────────────────────────────

test('entity file declares DrivingLicenceStatus enum', () => {
  assert.match(drivingEntity, /enum DrivingLicenceStatus/);
});

test('DrivingLicenceStatus has NONE PROVISIONAL FULL OTHER_OR_FOREIGN', () => {
  const e = drivingEntity.split('DrivingLicenceStatus')[1].split('}')[0];
  assert.match(e, /NONE/);
  assert.match(e, /PROVISIONAL/);
  assert.match(e, /FULL/);
  assert.match(e, /OTHER_OR_FOREIGN/);
});

test('entity file declares PrimaryTravelMethod enum', () => {
  assert.match(drivingEntity, /enum PrimaryTravelMethod/);
});

test('PrimaryTravelMethod has CAR MOTORCYCLE PUBLIC_TRANSPORT BICYCLE WALK OTHER', () => {
  const e = drivingEntity.split('PrimaryTravelMethod')[1].split('}')[0];
  assert.match(e, /CAR/);
  assert.match(e, /MOTORCYCLE/);
  assert.match(e, /PUBLIC_TRANSPORT/);
  assert.match(e, /BICYCLE/);
  assert.match(e, /WALK/);
  assert.match(e, /OTHER/);
});

test('entity declares GuardDrivingProfile entity for guard_driving_profiles table', () => {
  assert.match(drivingEntity, /guard_driving_profiles/);
  assert.match(drivingEntity, /class GuardDrivingProfile/);
});

test('entity has OneToOne relation to GuardProfile with CASCADE delete', () => {
  assert.match(drivingEntity, /OneToOne/);
  assert.match(drivingEntity, /CASCADE/);
});

test('licenceNumberEnc column has select: false', () => {
  assert.match(drivingEntity, /licenceNumberEnc/);
  assert.match(drivingEntity, /select:\s*false/);
});

test('licenceCategories uses simple-json type', () => {
  assert.match(drivingEntity, /simple-json/);
  assert.match(drivingEntity, /licenceCategories/);
});

test('maxTravelDistanceMiles is int type', () => {
  assert.match(drivingEntity, /maxTravelDistanceMiles/);
  assert.match(drivingEntity, /type:\s*['"]int['"]/);
});

test('entity has licenceExpiryDate as date type', () => {
  assert.match(drivingEntity, /licenceExpiryDate/);
  assert.match(drivingEntity, /type:\s*['"]date['"]/);
});

// ── BACKEND — MIGRATION ───────────────────────────────────────────────────────

test('migration creates guard_driving_profiles table', () => {
  assert.match(migration, /CREATE TABLE.*guard_driving_profiles/s);
});

test('migration creates driving_licence_status_enum with all 4 values', () => {
  assert.match(migration, /driving_licence_status_enum/);
  assert.match(migration, /NONE.*PROVISIONAL.*FULL.*OTHER_OR_FOREIGN/s);
});

test('migration creates primary_travel_method_enum', () => {
  assert.match(migration, /primary_travel_method_enum/);
  assert.match(migration, /PUBLIC_TRANSPORT/);
});

test('migration adds FK constraint to guard_profiles', () => {
  assert.match(migration, /REFERENCES.*guard_profiles/s);
});

test('migration adds UNIQUE constraint for guardId', () => {
  assert.match(migration, /UQ_guard_driving_profiles_guard/);
  assert.match(migration, /UNIQUE.*guardId|guardId.*UNIQUE/s);
});

test('migration adds driving_licence to guard_document_type_enum', () => {
  assert.match(migration, /driving_licence/);
  assert.match(migration, /guard_document_type_enum/);
});

test('migration down drops table and enum types', () => {
  const down = migration.split('down(')[1];
  assert.match(down, /DROP TABLE.*guard_driving_profiles/s);
  assert.match(down, /DROP TYPE.*primary_travel_method_enum/s);
  assert.match(down, /DROP TYPE.*driving_licence_status_enum/s);
});

// ── BACKEND — ENCRYPTION SERVICE ─────────────────────────────────────────────

test('EncryptionService has maskLicenceNumber method', () => {
  assert.match(encSvc, /maskLicenceNumber/);
});

test('maskLicenceNumber shows last 4 characters', () => {
  const fn = encSvc.split('maskLicenceNumber')[1].split('}')[0];
  assert.match(fn, /slice\(-4\)/);
});

test('maskLicenceNumber returns bullet placeholder for short inputs', () => {
  const fn = encSvc.split('maskLicenceNumber')[1].split('}')[0];
  assert.match(fn, /••••••••••/);
  assert.match(fn, /n\.length < 4/);
});

// ── BACKEND — SERVICE ─────────────────────────────────────────────────────────

test('service exports DrivingLicenceRevealResponseDto class', () => {
  assert.match(drivingService, /class DrivingLicenceRevealResponseDto/);
});

test('service declares DrivingTransportService', () => {
  assert.match(drivingService, /class DrivingTransportService/);
});

test('service injects GuardDrivingProfile repository', () => {
  assert.match(drivingService, /InjectRepository\(GuardDrivingProfile\)/);
});

test('service injects CompanyGuard repository', () => {
  assert.match(drivingService, /InjectRepository\(CompanyGuard\)/);
});

test('service injects User repository', () => {
  assert.match(drivingService, /InjectRepository\(User\)/);
});

test('service injects EncryptionService', () => {
  assert.match(drivingService, /EncryptionService/);
});

test('service has getDrivingForGuard method', () => {
  assert.match(drivingService, /getDrivingForGuard/);
});

test('service has updateDrivingForGuard method', () => {
  assert.match(drivingService, /updateDrivingForGuard/);
});

test('service has revealLicenceForGuard method', () => {
  assert.match(drivingService, /revealLicenceForGuard/);
});

test('service has getDrivingForAdmin method', () => {
  assert.match(drivingService, /getDrivingForAdmin/);
});

test('service has revealLicenceForAdmin method', () => {
  assert.match(drivingService, /revealLicenceForAdmin/);
});

test('service has getDrivingForCompany method', () => {
  assert.match(drivingService, /getDrivingForCompany/);
});

test('service uses createQueryBuilder with addSelect for licenceNumberEnc', () => {
  assert.match(drivingService, /addSelect.*licenceNumberEnc/);
});

test('service clears licenceNumberEnc when status set to NONE', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /NONE/);
  assert.match(updateFn, /licenceNumberEnc\s*=\s*null/);
});

test('service throws BadRequestException when storing licence number with NONE status', () => {
  assert.match(drivingService, /BadRequestException/);
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /licenceStatus.*NONE[\s\S]{0,100}throw|throw[\s\S]{0,100}NONE/s);
});

test('revealLicenceForGuard logs to auditLogService with requestedBy self', () => {
  const fn = drivingService.split('revealLicenceForGuard')[1].split('getDrivingForAdmin')[0];
  assert.match(fn, /auditLogService\.log/);
  assert.match(fn, /guard_personnel\.driving_licence_reveal/);
  assert.match(fn, /requestedBy.*self/);
});

test('revealLicenceForAdmin logs to auditLogService with admin context', () => {
  const fn = drivingService.split('revealLicenceForAdmin')[1].split('getDrivingForCompany')[0];
  assert.match(fn, /auditLogService\.log/);
  assert.match(fn, /requestedBy.*admin/);
  assert.match(fn, /adminUserId/);
});

test('service mutation audit action is guard_personnel.driving_update', () => {
  const fn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(fn, /guard_personnel\.driving_update/);
  assert.match(fn, /changedFields/);
});

test('service checks for ACTIVE CompanyGuard relationship', () => {
  assert.match(drivingService, /CompanyGuardStatus\.ACTIVE/);
  const fn = drivingService.split('getDrivingForCompany')[1].split('requireGuardByUserId')[0];
  assert.match(fn, /requireActiveCompanyGuardRelationship/);
});

test('service looks up companyId via user.companyProfile relation', () => {
  assert.match(drivingService, /companyProfile/);
  assert.match(drivingService, /requireCompanyIdForUser/);
});

test('service returns ForbiddenException for missing company relationship', () => {
  assert.match(drivingService, /ForbiddenException/);
  assert.match(drivingService, /No active relationship/);
});

test('service mutation audit fires only when changedFields is non-empty', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /changedFields\.length\s*>\s*0/);
});

test('service never stores licenceNumberPlaintext directly', () => {
  assert.doesNotMatch(drivingService, /profile\.licenceNumberPlaintext/);
});

test('service audit afterData contains changedFields with no plaintext values', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  const afterDataIdx = updateFn.indexOf('afterData:');
  assert.ok(afterDataIdx > -1, 'afterData must be present');
  const afterDataBlock = updateFn.slice(afterDataIdx, afterDataIdx + 80);
  assert.match(afterDataBlock, /changedFields/);
  assert.doesNotMatch(afterDataBlock, /licenceNumberPlaintext|licenceNumberEnc/);
});

// ── BACKEND — CONTROLLER ──────────────────────────────────────────────────────

test('controller has GUARD route for GET me/driving-transport', () => {
  assert.match(controller, /me\/driving-transport/);
  assert.match(controller, /getMyDrivingTransport/);
});

test('controller has GUARD route for PATCH me/driving-transport', () => {
  assert.match(controller, /updateMyDrivingTransport/);
});

test('controller has GUARD route for POST me/driving-licence/reveal', () => {
  assert.match(controller, /me\/driving-licence\/reveal/);
  assert.match(controller, /revealMyDrivingLicenceNumber/);
});

test('controller has ADMIN route for GET admin/:id/driving-transport', () => {
  assert.match(controller, /admin\/:id\/driving-transport|admin\/:id.*driving-transport/);
  assert.match(controller, /getGuardDrivingTransportAdmin/);
});

test('controller has ADMIN route for POST admin/:id/driving-licence/reveal', () => {
  assert.match(controller, /admin\/:id\/driving-licence\/reveal/);
  assert.match(controller, /revealGuardDrivingLicenceAdmin/);
});

test('controller has COMPANY route for GET company/guard/:guardId/driving-transport', () => {
  assert.match(controller, /company\/guard\/:guardId\/driving-transport/);
  assert.match(controller, /getGuardDrivingTransportForCompany/);
});

test('controller company route allows COMPANY, COMPANY_ADMIN, COMPANY_STAFF roles', () => {
  const companyRoute = controller.split('getGuardDrivingTransportForCompany')[0];
  const nearRoute = companyRoute.slice(-500);
  assert.match(nearRoute, /UserRole\.COMPANY/);
  assert.match(nearRoute, /COMPANY_ADMIN/);
  assert.match(nearRoute, /COMPANY_STAFF/);
});

test('controller imports DrivingTransportService', () => {
  assert.match(controller, /DrivingTransportService/);
});

test('controller injects drivingService', () => {
  assert.match(controller, /drivingService/);
});

test('controller has no CLIENT role access for P1D routes', () => {
  assert.doesNotMatch(controller, /CLIENT_ADMIN.*driving|driving.*CLIENT_ADMIN/s);
  assert.doesNotMatch(controller, /CLIENT_VIEWER.*driving|driving.*CLIENT_VIEWER/s);
});

// ── BACKEND — MODULE ──────────────────────────────────────────────────────────

test('module imports GuardDrivingProfile entity', () => {
  assert.match(module_, /GuardDrivingProfile/);
});

test('module imports CompanyGuard entity', () => {
  assert.match(module_, /CompanyGuard/);
});

test('module imports User entity', () => {
  assert.match(module_, /from.*user.*entities.*user\.entity|from.*user\.entity/);
});

test('module provides DrivingTransportService', () => {
  assert.match(module_, /DrivingTransportService/);
});

test('module still exports EncryptionService', () => {
  assert.match(module_, /exports.*EncryptionService|EncryptionService.*exports/s);
});

// ── BACKEND — DTOs ─────────────────────────────────────────────────────────

test('guard response DTO has licenceNumberSet and licenceNumberMasked but no licenceNumberEnc', () => {
  assert.match(guardDtoFile, /licenceNumberSet/);
  assert.match(guardDtoFile, /licenceNumberMasked/);
  assert.doesNotMatch(guardDtoFile, /licenceNumberEnc/);
});

test('admin response DTO extends guard DTO and adds canReveal', () => {
  assert.match(adminDtoFile, /extends DrivingTransportGuardResponseDto/);
  assert.match(adminDtoFile, /canReveal/);
});

test('company response DTO has no licence number fields (masked, set, or raw)', () => {
  assert.doesNotMatch(companyDtoFile, /licenceNumberSet|licenceNumberMasked|licenceNumberEnc/);
});

test('company response DTO has primaryTravelMethod, maxTravelDistanceMiles, hasVehicleAccess', () => {
  assert.match(companyDtoFile, /primaryTravelMethod/);
  assert.match(companyDtoFile, /maxTravelDistanceMiles/);
  assert.match(companyDtoFile, /hasVehicleAccess/);
});

// ── HARDENING — COMPANY DTO EXPANDED FIELDS ───────────────────────────────────

test('company DTO now exposes licenceStatus', () => {
  assert.match(companyDtoFile, /licenceStatus/);
});

test('company DTO now exposes licenceCategories', () => {
  assert.match(companyDtoFile, /licenceCategories/);
});

test('company DTO now exposes licenceExpiryDate', () => {
  assert.match(companyDtoFile, /licenceExpiryDate/);
});

test('company DTO now exposes ownsVehicle', () => {
  assert.match(companyDtoFile, /ownsVehicle/);
});

test('company DTO has no canReveal field', () => {
  assert.doesNotMatch(companyDtoFile, /canReveal/);
});

test('company DTO has no licenceNumberEnc field', () => {
  assert.doesNotMatch(companyDtoFile, /licenceNumberEnc/);
});

test('company DTO comment indicates fields are self-declared with no verification implied', () => {
  assert.match(companyDtoFile, /self-declared|no verification/);
});

test('company DTO comment notes licence number is intentionally excluded', () => {
  assert.match(companyDtoFile, /intentionally excluded/);
});

test('company DTO is only accessible by companies with ACTIVE relationship', () => {
  assert.match(companyDtoFile, /ACTIVE/);
});

// ── HARDENING — DESTRUCTIVE TRANSITION ───────────────────────────────────────

test('update DTO has confirmRemoveLicenceDetails optional field', () => {
  assert.match(updateDtoFile, /confirmRemoveLicenceDetails/);
});

test('update DTO decorates confirmRemoveLicenceDetails with @IsBoolean', () => {
  const block = updateDtoFile.split('confirmRemoveLicenceDetails')[0].slice(-200);
  assert.match(block, /@IsBoolean/);
});

test('update DTO decorates confirmRemoveLicenceDetails with @IsOptional', () => {
  const block = updateDtoFile.split('confirmRemoveLicenceDetails')[0].slice(-200);
  assert.match(block, /@IsOptional/);
});

test('UpdateDrivingTransportPayload in models.ts has confirmRemoveLicenceDetails', () => {
  const iface = models.split('UpdateDrivingTransportPayload')[1].split('}')[0];
  assert.match(iface, /confirmRemoveLicenceDetails/);
});

test('service checks hasLicenceDetails flag before allowing NONE transition', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /hasLicenceDetails/);
});

test('service throws BadRequestException without confirmRemoveLicenceDetails when data exists', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /hasLicenceDetails.*confirmRemoveLicenceDetails|confirmRemoveLicenceDetails[\s\S]{0,100}hasLicenceDetails/s);
  assert.match(updateFn, /throw new BadRequestException/);
});

test('service error message prompts guard to confirm the action', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /Please confirm this action/);
});

test('service clears licenceNumberEnc on confirmed NONE transition', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /licenceNumberEnc\s*=\s*null/);
});

test('service clears licenceCategories on confirmed NONE transition', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /licenceCategories\s*=\s*null/);
});

test('service clears licenceExpiryDate on confirmed NONE transition', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /licenceExpiryDate\s*=\s*null/);
});

test('service audit changedFields lists licenceNumber when clearing on NONE', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /changedFields\.push[\s\S]{0,200}licenceNumber/s);
});

test('service audit changedFields lists licenceCategories when clearing on NONE', () => {
  const updateFn = drivingService.split('updateDrivingForGuard')[1].split('revealLicenceForGuard')[0];
  assert.match(updateFn, /changedFields\.push[\s\S]{0,200}licenceCategories/s);
});

// ── HARDENING — MOBILE CONFIRMATION UX ───────────────────────────────────────

test('dashboard has handleLicenceStatusSelect function', () => {
  assert.match(dashboard, /function handleLicenceStatusSelect/);
});

test('handleLicenceStatusSelect shows Alert.alert when NONE has existing licence details', () => {
  const fn = dashboard.split('handleLicenceStatusSelect')[1].split('function updateShiftStatusLocally')[0];
  assert.match(fn, /Alert\.alert/);
  assert.match(fn, /Remove driving licence/);
  assert.match(fn, /hasLicenceDetails/);
});

test('handleLicenceStatusSelect sends confirmRemoveLicenceDetails: true on Remove licence press', () => {
  const fn = dashboard.split('handleLicenceStatusSelect')[1].split('function updateShiftStatusLocally')[0];
  assert.match(fn, /confirmRemoveLicenceDetails:\s*true/);
});

test('update DTO uses class-validator IsEnum for licenceStatus', () => {
  assert.match(updateDtoFile, /IsEnum.*DrivingLicenceStatus|IsEnum[\s\S]{0,30}licenceStatus/s);
});

test('update DTO uses IsInt with Min(1) and Max(250) for maxTravelDistanceMiles', () => {
  assert.match(updateDtoFile, /Min\(1\)/);
  assert.match(updateDtoFile, /Max\(250\)/);
  assert.match(updateDtoFile, /IsInt/);
});

// ── BACKEND — GUARD DOCUMENT ENTITY ──────────────────────────────────────────

test('GuardDocumentType enum includes DRIVING_LICENCE', () => {
  assert.match(guardDocEntity, /DRIVING_LICENCE/);
  assert.match(guardDocEntity, /driving_licence/);
});

console.log(JSON.stringify({ event: 'guard_personnel_p1d_tests_passed', tests: passed }));
