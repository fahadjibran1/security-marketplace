import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { UpdateGuardProfileDto } from '../src/guard-profile/dto/update-guard-profile.dto';
import { GuardApprovalStatus, GuardAvailability } from '../src/guard-profile/entities/guard-profile.entity';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';
import { toGuardDto, toCompanyDto, toAdminDto } from '../src/guard-profile/dto/guard-profile-response.mappers';
import { GuardProfileService } from '../src/guard-profile/guard-profile.service';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test['run']) => tests.push({ name, run });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

const backend = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const mobile = (file: string) => readFileSync(resolve(__dirname, '../../security-mobile-app/src', file), 'utf8');

// Production ValidationPipe — same configuration as main.ts
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

function buildMockEntity(overrides: Record<string, unknown> = {}): any {
  return {
    id: 42,
    fullName: 'Test Guard',
    phone: '07700900000',
    locationSharingEnabled: false,
    approvalStatus: GuardApprovalStatus.APPROVED,
    isApproved: true,
    status: 'approved',
    availability: GuardAvailability.AVAILABLE,
    siaLicenseNumber: 'SIA-TEST-001',
    siaExpiryDate: '2030-01-01',
    rightToWorkStatus: 'permanent',
    rightToWorkExpiryDate: null,
    notes: 'admin-only content',
    user: {
      id: 70,
      email: 'guard@test.com',
      status: UserStatus.ACTIVE,
      role: UserRole.GUARD,
      isEmailVerified: true,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    },
    ...overrides,
  };
}

// ===== SECTION A: ValidationPipe configuration =====

test('ValidationPipe config: whitelist=true and forbidNonWhitelisted=true are both enabled', () => {
  const source = backend('main.ts');
  assert(
    source.includes('whitelist: true') && source.includes('forbidNonWhitelisted: true'),
    'main.ts ValidationPipe does not have whitelist+forbidNonWhitelisted — unknown fields may be silently ignored rather than rejected',
  );
});

// ===== SECTION B: Runtime ValidationPipe rejection tests =====
// These prove PATCH /guards/me returns 400 for each security-sensitive field.
// The pipe is instantiated with the same config as production.

async function assertPipeRejects(field: string, value: unknown, label: string): Promise<void> {
  let threw = false;
  try {
    await pipe.transform({ [field]: value }, { type: 'body', metatype: UpdateGuardProfileDto } as any);
  } catch (e) {
    threw = e instanceof BadRequestException;
    if (!threw) throw new Error(`Expected BadRequestException for field '${field}', got: ${String(e)}`);
  }
  assert(threw, `ValidationPipe ACCEPTED '${field}' — ${label}`);
}

test('PATCH /guards/me rejects status field → 400 Bad Request', async () =>
  assertPipeRejects('status', 'approved', 'guard can self-approve via legacy varchar'));

test('PATCH /guards/me rejects approvalStatus field → 400 Bad Request', async () =>
  assertPipeRejects('approvalStatus', 'approved', 'guard can self-set typed enum status'));

test('PATCH /guards/me rejects isApproved field → 400 Bad Request', async () =>
  assertPipeRejects('isApproved', true, 'guard can self-approve via boolean'));

test('PATCH /guards/me rejects siaLicenseNumber field → 400 Bad Request', async () =>
  assertPipeRejects('siaLicenseNumber', 'FAKE-SIA-123', 'guard can overwrite verified SIA licence number'));

test('PATCH /guards/me rejects siaExpiryDate field → 400 Bad Request', async () =>
  assertPipeRejects('siaExpiryDate', '2099-01-01', 'guard can self-extend SIA expiry'));

test('PATCH /guards/me rejects rightToWorkStatus field → 400 Bad Request', async () =>
  assertPipeRejects('rightToWorkStatus', 'permanent', 'guard can self-certify right to work'));

test('PATCH /guards/me rejects rightToWorkExpiryDate field → 400 Bad Request', async () =>
  assertPipeRejects('rightToWorkExpiryDate', '2099-01-01', 'guard can self-extend RTW expiry'));

test('PATCH /guards/me rejects notes field → 400 Bad Request', async () =>
  assertPipeRejects('notes', 'injected content', 'guard can inject admin notes'));

test('PATCH /guards/me accepts fullName, phone, locationSharingEnabled without rejection', async () => {
  let threw = false;
  try {
    await pipe.transform(
      { fullName: 'New Name', phone: '07700900001', locationSharingEnabled: true },
      { type: 'body', metatype: UpdateGuardProfileDto } as any,
    );
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'ValidationPipe rejected a legitimate guard profile update payload — broken for guards');
});

test('PATCH /guards/me accepts empty body without rejection', async () => {
  let threw = false;
  try {
    await pipe.transform({}, { type: 'body', metatype: UpdateGuardProfileDto } as any);
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'ValidationPipe rejected an empty body — all fields are optional');
});

// ===== SECTION C: Service mutation test =====
// Proves updateByUserId does not mutate restricted fields via the DTO path.

test('updateByUserId mutates only submitted allowed fields; restricted fields are unchanged', async () => {
  const guard = buildMockEntity({ id: 10, fullName: 'Original Name' });
  const originalStatus = guard.status;
  const originalNotes = guard.notes;
  const originalSia = guard.siaLicenseNumber;
  const originalApprovalStatus = guard.approvalStatus;
  const originalIsApproved = guard.isApproved;

  const savedCaptures: any[] = [];
  const mockGuardRepo: any = {
    findOne: async () => guard,
    save: async (g: any) => { savedCaptures.push({ ...g }); return g; },
  };

  const service = new GuardProfileService(
    mockGuardRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const dto = new UpdateGuardProfileDto();
  dto.fullName = 'Updated Name';
  await service.updateByUserId(70, dto);

  assert(savedCaptures.length === 1, 'save() was not called');
  const saved = savedCaptures[0];
  assert(saved.fullName === 'Updated Name', 'fullName was not updated — legitimate field rejected');
  assert(saved.status === originalStatus, `status was mutated: '${originalStatus}' → '${saved.status}'`);
  assert(saved.notes === originalNotes, 'notes was mutated by updateByUserId');
  assert(saved.siaLicenseNumber === originalSia, 'siaLicenseNumber was mutated by updateByUserId');
  assert(saved.approvalStatus === originalApprovalStatus, 'approvalStatus was mutated by updateByUserId');
  assert(saved.isApproved === originalIsApproved, 'isApproved was mutated by updateByUserId');
});

test('updateByUserId throws NotFoundException for non-existent guard', async () => {
  const mockGuardRepo: any = { findOne: async () => null };
  const service = new GuardProfileService(mockGuardRepo, {} as any, {} as any, {} as any, {} as any);
  let threw = false;
  try {
    await service.updateByUserId(999, new UpdateGuardProfileDto());
  } catch (e) {
    threw = e instanceof NotFoundException;
  }
  assert(threw, 'updateByUserId did not throw NotFoundException for missing guard');
});

// ===== SECTION D: Static DTO file analysis =====
// Checks the actual DTO class files — these are the authoritative source of what
// fields the ValidationPipe and mapper functions will allow.

test('UpdateGuardProfileDto source: no status field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('status?:') && !source.includes("'status'"), 'status present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no approvalStatus field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('approvalStatus'), 'approvalStatus present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no isApproved field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('isApproved'), 'isApproved present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no siaLicenseNumber field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('siaLicenseNumber'), 'siaLicenseNumber present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no siaExpiryDate field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('siaExpiryDate'), 'siaExpiryDate present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no rightToWorkStatus field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('rightToWorkStatus'), 'rightToWorkStatus present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no rightToWorkExpiryDate field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('rightToWorkExpiryDate'), 'rightToWorkExpiryDate present in UpdateGuardProfileDto');
});

test('UpdateGuardProfileDto source: no notes field', () => {
  const source = backend('guard-profile/dto/update-guard-profile.dto.ts');
  assert(!source.includes('notes'), 'notes present in UpdateGuardProfileDto');
});

test('GuardProfileGuardResponseDto source: no notes field', () => {
  const source = backend('guard-profile/dto/guard-profile-guard-response.dto.ts');
  assert(!source.includes('notes?:') && !source.includes('notes!:'), 'notes present in guard response DTO');
});

test('GuardProfileGuardResponseDto source: no isApproved field', () => {
  const source = backend('guard-profile/dto/guard-profile-guard-response.dto.ts');
  assert(!source.includes('isApproved'), 'isApproved present in guard response DTO');
});

test('GuardProfileGuardResponseDto source: no legacy status varchar field', () => {
  const source = backend('guard-profile/dto/guard-profile-guard-response.dto.ts');
  // Guard DTO has approvalStatus (enum) but must NOT have the legacy `status` varchar
  assert(!source.match(/^\s+status[?!]:.*string/m), 'legacy status varchar present in guard response DTO');
});

test('GuardProfileCompanyResponseDto source: no notes field', () => {
  const source = backend('guard-profile/dto/guard-profile-company-response.dto.ts');
  assert(!source.includes('notes?:') && !source.includes('notes!:'), 'notes present in company response DTO');
});

test('GuardProfileCompanyResponseDto source: no isApproved field', () => {
  const source = backend('guard-profile/dto/guard-profile-company-response.dto.ts');
  assert(!source.includes('isApproved'), 'isApproved present in company response DTO');
});

test('GuardProfileCompanyResponseDto source: no legacy status varchar field', () => {
  const source = backend('guard-profile/dto/guard-profile-company-response.dto.ts');
  assert(!source.match(/^\s+status[?!]:.*string/m), 'legacy status varchar present in company response DTO');
});

test('GuardProfileCompanyResponseDto source: no rightToWorkStatus field', () => {
  const source = backend('guard-profile/dto/guard-profile-company-response.dto.ts');
  assert(!source.includes('rightToWorkStatus'), 'rightToWorkStatus present in company response DTO — use /compliance/statuses');
});

test('GuardProfileCompanyResponseDto source: no rightToWorkExpiryDate field', () => {
  const source = backend('guard-profile/dto/guard-profile-company-response.dto.ts');
  assert(!source.includes('rightToWorkExpiryDate'), 'rightToWorkExpiryDate present in company response DTO');
});

test('GuardProfileAdminResponseDto source: contains notes field', () => {
  const source = backend('guard-profile/dto/guard-profile-admin-response.dto.ts');
  assert(source.includes('notes?:') || source.includes('notes!:'), 'notes absent from admin response DTO');
});

test('GuardProfileAdminResponseDto source: contains isApproved field', () => {
  const source = backend('guard-profile/dto/guard-profile-admin-response.dto.ts');
  assert(source.includes('isApproved'), 'isApproved absent from admin response DTO');
});

test('GuardProfileAdminResponseDto source: contains legacy status varchar field', () => {
  const source = backend('guard-profile/dto/guard-profile-admin-response.dto.ts');
  assert(source.match(/^\s+status[?!]:/m), 'legacy status varchar absent from admin response DTO');
});

test('Mapper file: admin mapper includes notes: entity.notes', () => {
  const source = backend('guard-profile/dto/guard-profile-response.mappers.ts');
  assert(source.includes('notes: entity.notes'), 'toAdminDto does not include notes: entity.notes');
});

test('Mapper file: no spread from entity (fail-closed architecture)', () => {
  const source = backend('guard-profile/dto/guard-profile-response.mappers.ts');
  assert(!source.includes('...entity'), 'mapper uses ...entity spread — not fail-closed');
});

test('Mapper file: no Object.assign from entity (fail-closed architecture)', () => {
  const source = backend('guard-profile/dto/guard-profile-response.mappers.ts');
  assert(!source.includes('Object.assign'), 'mapper uses Object.assign — not fail-closed');
});

test('Controller source: imports toGuardDto, toCompanyDto, toAdminDto', () => {
  const source = backend('guard-profile/guard-profile.controller.ts');
  assert(
    source.includes('toGuardDto') && source.includes('toCompanyDto') && source.includes('toAdminDto'),
    'Controller does not import/use all three mapper functions',
  );
});

// ===== SECTION E: Mapper functional tests — shape verification =====

test('toGuardDto: result does not contain notes', () => {
  const result = toGuardDto(buildMockEntity({ notes: 'secret admin note' }));
  assert(!('notes' in result), 'notes present in toGuardDto result');
});

test('toGuardDto: result does not contain isApproved', () => {
  const result = toGuardDto(buildMockEntity({ isApproved: true }));
  assert(!('isApproved' in result), 'isApproved present in toGuardDto result');
});

test('toGuardDto: result does not contain legacy status varchar', () => {
  const result = toGuardDto(buildMockEntity({ status: 'approved' }));
  assert(!('status' in result), 'legacy status varchar present in toGuardDto result');
});

test('toGuardDto: result.user does not contain passwordHash', () => {
  const entity = buildMockEntity();
  (entity.user as any).passwordHash = '$2b$10$hashed';
  const result = toGuardDto(entity);
  assert(!('passwordHash' in (result.user as any)), 'user.passwordHash leaked in toGuardDto');
});

test('toGuardDto: result.user does not contain role', () => {
  const result = toGuardDto(buildMockEntity());
  assert(!('role' in (result.user as any)), 'user.role leaked in toGuardDto');
});

test('toGuardDto: result contains approvalStatus (canonical typed status)', () => {
  const result = toGuardDto(buildMockEntity({ approvalStatus: GuardApprovalStatus.APPROVED }));
  assert('approvalStatus' in result && result.approvalStatus === GuardApprovalStatus.APPROVED, 'approvalStatus missing from toGuardDto');
});

test('toGuardDto: result contains rightToWorkStatus (read-only display, needed by isGuardProfileComplete)', () => {
  const result = toGuardDto(buildMockEntity({ rightToWorkStatus: 'permanent' }));
  assert('rightToWorkStatus' in result && result.rightToWorkStatus === 'permanent', 'rightToWorkStatus missing — isGuardProfileComplete() will break');
});

test('toGuardDto: result contains siaLicenseNumber as read-only display', () => {
  const result = toGuardDto(buildMockEntity({ siaLicenseNumber: 'SIA-001' }));
  assert('siaLicenseNumber' in result && result.siaLicenseNumber === 'SIA-001', 'siaLicenseNumber missing from toGuardDto');
});

test('toCompanyDto: result does not contain notes', () => {
  const result = toCompanyDto(buildMockEntity({ notes: 'secret admin note' }));
  assert(!('notes' in result), 'notes present in toCompanyDto result');
});

test('toCompanyDto: result does not contain isApproved', () => {
  const result = toCompanyDto(buildMockEntity({ isApproved: true }));
  assert(!('isApproved' in result), 'isApproved present in toCompanyDto result');
});

test('toCompanyDto: result does not contain legacy status varchar', () => {
  const result = toCompanyDto(buildMockEntity({ status: 'approved' }));
  assert(!('status' in result), 'legacy status varchar present in toCompanyDto result');
});

test('toCompanyDto: result does not contain raw rightToWorkStatus', () => {
  const result = toCompanyDto(buildMockEntity({ rightToWorkStatus: 'permanent' }));
  assert(!('rightToWorkStatus' in result), 'rightToWorkStatus present in toCompanyDto — use /compliance/statuses');
});

test('toCompanyDto: result does not contain raw rightToWorkExpiryDate', () => {
  const result = toCompanyDto(buildMockEntity({ rightToWorkExpiryDate: '2030-01-01' }));
  assert(!('rightToWorkExpiryDate' in result), 'rightToWorkExpiryDate present in toCompanyDto');
});

test('toCompanyDto: result.user does not contain passwordHash', () => {
  const entity = buildMockEntity();
  (entity.user as any).passwordHash = '$2b$10$hashed';
  const result = toCompanyDto(entity);
  assert(!('passwordHash' in (result.user as any)), 'user.passwordHash leaked in toCompanyDto');
});

test('toCompanyDto: result.user does not contain role', () => {
  const result = toCompanyDto(buildMockEntity());
  assert(!('role' in (result.user as any)), 'user.role leaked in toCompanyDto');
});

test('toCompanyDto: result contains approvalStatus', () => {
  const result = toCompanyDto(buildMockEntity({ approvalStatus: GuardApprovalStatus.PENDING }));
  assert('approvalStatus' in result && result.approvalStatus === GuardApprovalStatus.PENDING, 'approvalStatus missing from toCompanyDto');
});

test('toAdminDto: result contains notes', () => {
  const result = toAdminDto(buildMockEntity({ notes: 'admin note content' }));
  assert('notes' in result && result.notes === 'admin note content', 'notes missing from toAdminDto');
});

test('toAdminDto: result contains isApproved', () => {
  const result = toAdminDto(buildMockEntity({ isApproved: true }));
  assert('isApproved' in result && result.isApproved === true, 'isApproved missing from toAdminDto');
});

test('toAdminDto: result contains legacy status varchar', () => {
  const result = toAdminDto(buildMockEntity({ status: 'pending' }));
  assert('status' in result && result.status === 'pending', 'legacy status varchar missing from toAdminDto');
});

test('toAdminDto: result contains rightToWorkStatus', () => {
  const result = toAdminDto(buildMockEntity({ rightToWorkStatus: 'permanent' }));
  assert('rightToWorkStatus' in result && result.rightToWorkStatus === 'permanent', 'rightToWorkStatus missing from toAdminDto');
});

test('toAdminDto: result.user contains role', () => {
  const result = toAdminDto(buildMockEntity());
  assert('role' in (result.user as any), 'user.role missing from toAdminDto');
});

test('toAdminDto: result.user does not contain passwordHash', () => {
  const entity = buildMockEntity();
  (entity.user as any).passwordHash = '$2b$10$hashed';
  const result = toAdminDto(entity);
  assert(!('passwordHash' in (result.user as any)), 'user.passwordHash leaked in toAdminDto');
});

// ===== SECTION F: Fail-closed architecture proof =====
// A hypothetical sensitive property added to the GuardProfile entity must NOT
// automatically appear in guard or company responses. This proves the explicit
// allow-list mapper is fail-closed — new DB columns do not auto-leak.

test('Guard DTO is fail-closed: hypothetical NINO field on entity does not appear in guard response', () => {
  const entity = buildMockEntity();
  (entity as any).nationalInsuranceNumber = 'AB123456C';
  const result = toGuardDto(entity) as any;
  assert(
    !('nationalInsuranceNumber' in result),
    'toGuardDto auto-included a new entity field — mapper is NOT fail-closed. New sensitive DB columns will leak.',
  );
});

test('Company DTO is fail-closed: hypothetical NINO field on entity does not appear in company response', () => {
  const entity = buildMockEntity();
  (entity as any).nationalInsuranceNumber = 'AB123456C';
  const result = toCompanyDto(entity) as any;
  assert(
    !('nationalInsuranceNumber' in result),
    'toCompanyDto auto-included a new entity field — mapper is NOT fail-closed.',
  );
});

test('Guard DTO is fail-closed: hypothetical bank account field on entity does not appear in guard response', () => {
  const entity = buildMockEntity();
  (entity as any).bankAccountNumber = '12345678';
  (entity as any).bankSortCode = '00-00-00';
  const result = toGuardDto(entity) as any;
  assert(
    !('bankAccountNumber' in result) && !('bankSortCode' in result),
    'toGuardDto leaked bank details from a new entity field',
  );
});

test('Guard DTO user is fail-closed: hypothetical sensitive user field does not appear', () => {
  const entity = buildMockEntity();
  (entity.user as any).twoFactorSecret = 'TOTP-SECRET';
  const result = toGuardDto(entity) as any;
  assert(!('twoFactorSecret' in result.user), 'toGuardDto leaked a new user entity field');
});

// ===== SECTION G: Mobile type and UI static analysis =====

test('Mobile UpdateGuardPayload does not include status field', () => {
  const source = mobile('types/models.ts');
  const match = source.match(/interface UpdateGuardPayload \{[\s\S]*?\n\}/);
  assert(match, 'UpdateGuardPayload interface not found in models.ts');
  assert(!match![0].includes('status?:'), 'status field present in mobile UpdateGuardPayload');
});

test('Mobile UpdateGuardPayload does not include siaLicenseNumber field', () => {
  const source = mobile('types/models.ts');
  const match = source.match(/interface UpdateGuardPayload \{[\s\S]*?\n\}/);
  assert(match, 'UpdateGuardPayload interface not found');
  assert(!match![0].includes('siaLicenseNumber'), 'siaLicenseNumber present in mobile UpdateGuardPayload');
});

test('Mobile UpdateGuardPayload does not include siaExpiryDate field', () => {
  const source = mobile('types/models.ts');
  const match = source.match(/interface UpdateGuardPayload \{[\s\S]*?\n\}/);
  assert(match, 'UpdateGuardPayload interface not found');
  assert(!match![0].includes('siaExpiryDate'), 'siaExpiryDate present in mobile UpdateGuardPayload');
});

test('Mobile UpdateGuardPayload does not include rightToWorkStatus field', () => {
  const source = mobile('types/models.ts');
  const match = source.match(/interface UpdateGuardPayload \{[\s\S]*?\n\}/);
  assert(match, 'UpdateGuardPayload interface not found');
  assert(!match![0].includes('rightToWorkStatus'), 'rightToWorkStatus present in mobile UpdateGuardPayload');
});

test('Mobile UpdateGuardPayload does not include rightToWorkExpiryDate field', () => {
  const source = mobile('types/models.ts');
  const match = source.match(/interface UpdateGuardPayload \{[\s\S]*?\n\}/);
  assert(match, 'UpdateGuardPayload interface not found');
  assert(!match![0].includes('rightToWorkExpiryDate'), 'rightToWorkExpiryDate present in mobile UpdateGuardPayload');
});

test('Mobile handleSaveProfile does not send siaLicenseNumber in payload', () => {
  const source = mobile('screens/GuardDashboardScreen.tsx');
  const saveFnMatch = source.match(/async function handleSaveProfile\(\)[^{]*\{[\s\S]*?^\s{2}\}/m);
  assert(saveFnMatch, 'handleSaveProfile function not found in GuardDashboardScreen');
  assert(!saveFnMatch![0].includes('siaLicenseNumber'), 'handleSaveProfile still sends siaLicenseNumber to PATCH /guards/me');
});

test('Mobile SIA licence field is read-only in Profile UI (no onChangeText)', () => {
  const source = mobile('screens/GuardDashboardScreen.tsx');
  // onChangeText={setSiaLicence} must be absent: the field is now editable={false}
  assert(!source.includes('onChangeText={setSiaLicence}'), 'SIA field is still editable — onChangeText={setSiaLicence} must be removed');
  // editable={false} must be present on the SIA TextInput
  assert(source.includes('editable={false}'), 'SIA TextInput is missing editable={false} — field is not locked');
});

async function main() {
  let passed = 0;
  for (const entry of tests) {
    await entry.run();
    console.log(`PASS ${++passed}/${tests.length} ${entry.name}`);
  }
  console.log(`SEC-019 guard profile response security: ${passed}/${tests.length} PASS`);
}

main().catch(e => { console.error(e); process.exit(1); });
