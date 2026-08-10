import { equal, ok } from 'node:assert/strict';
import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getMetadataArgsStorage } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import { PublicRegistrationRole, RegisterDto } from '../src/auth/dto/register.dto';
import { JwtPayload } from '../src/auth/types/jwt-payload.type';
import { AttendanceEvent } from '../src/attendance/entities/attendance.entity';
import { ClientPortalUser } from '../src/client-portal-user/entities/client-portal-user.entity';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { CompanyController } from '../src/company/company.controller';
import { CompanyService } from '../src/company/company.service';
import { CompanyStatus } from '../src/company/entities/company.entity';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';
import { Site } from '../src/site/entities/site.entity';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

type Calls = {
  userCreates: any[];
  companyCreates: any[];
  guardCreates: any[];
};

function buildHarness() {
  const calls: Calls = {
    userCreates: [],
    companyCreates: [],
    guardCreates: [],
  };

  let companyProfile: any = null;
  let guardProfile: any = null;

  const usersService = {
    create: async (input: any) => {
      calls.userCreates.push(input);
      return {
        id: calls.userCreates.length,
        email: input.email,
        role: input.role,
        status: input.status,
        passwordHash: 'unused',
      };
    },
    findByEmail: async () => null,
    updateLastLogin: async () => undefined,
  };

  const jwtService = {
    sign: (payload: unknown) => `test-token:${JSON.stringify(payload)}`,
  };

  const companyService = {
    create: async (input: any) => {
      calls.companyCreates.push(input);
      companyProfile = { id: 101, ...input };
      return companyProfile;
    },
    findByUserId: async () => companyProfile,
  };

  const guardProfileService = {
    create: async (input: any) => {
      calls.guardCreates.push(input);
      guardProfile = { id: 201, ...input };
      return guardProfile;
    },
    findByUserId: async () => guardProfile,
  };

  const service = new AuthService(
    usersService as any,
    jwtService as any,
    companyService as any,
    guardProfileService as any,
    {} as any,
    {} as any,
  );

  return { service, calls };
}

async function expectBadRequest(action: () => Promise<unknown>) {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  ok(thrown instanceof BadRequestException, 'Expected BadRequestException');
}

function assertColumnExcluded(target: Function, propertyName: string, label: string) {
  const column = getMetadataArgsStorage().columns.find(
    (candidate) => candidate.target === target && candidate.propertyName === propertyName,
  );

  ok(column, `${label} column metadata must exist`);
  equal(column.options.select, false, `${label} must use select:false`);
}

async function testPrivilegedRoleCannotSelfRegister() {
  const { service, calls } = buildHarness();

  await expectBadRequest(() =>
    service.register({
      email: 'attacker@example.test',
      password: 'secret123',
      role: UserRole.ADMIN,
    } as unknown as RegisterDto),
  );

  equal(calls.userCreates.length, 0, 'Privileged registration must not create a user');
}

async function testInvalidGuardPayloadHasNoSideEffects() {
  const { service, calls } = buildHarness();

  await expectBadRequest(() =>
    service.register({
      email: 'guard@example.test',
      password: 'secret123',
      role: PublicRegistrationRole.GUARD,
      fullName: 'Test Guard',
    }),
  );

  equal(calls.userCreates.length, 0, 'Invalid guard registration must not create a user');
  equal(calls.guardCreates.length, 0, 'Invalid guard registration must not create a profile');
}

async function testGuardRegistrationRemainsPending() {
  const { service, calls } = buildHarness();

  const result = await service.register({
    email: 'guard@example.test',
    password: 'secret123',
    role: PublicRegistrationRole.GUARD,
    fullName: 'Test Guard',
    siaLicenseNumber: 'SIA123456',
    phone: '07000000000',
  });

  equal(calls.userCreates.length, 1);
  equal(calls.userCreates[0].role, UserRole.GUARD);
  equal(calls.userCreates[0].status, UserStatus.PENDING);
  equal(calls.guardCreates.length, 1);
  equal(calls.guardCreates[0].status, GuardApprovalStatus.PENDING);
  equal(calls.guardCreates[0].approvalStatus, GuardApprovalStatus.PENDING);
  equal(calls.guardCreates[0].isApproved, false);
  equal(result.user.status, UserStatus.PENDING);
}

async function testCompanyRegistrationMapsToCompanyAdmin() {
  const { service, calls } = buildHarness();

  const result = await service.register({
    email: 'company@example.test',
    password: 'secret123',
    role: PublicRegistrationRole.COMPANY,
    companyName: 'Example Security Ltd',
    companyNumber: '12345678',
    address: '1 Test Street',
    contactDetails: 'operations@example.test',
  });

  equal(calls.userCreates.length, 1);
  equal(calls.userCreates[0].role, UserRole.COMPANY_ADMIN);
  equal(calls.userCreates[0].status, UserStatus.ACTIVE);
  equal(calls.companyCreates.length, 1);
  equal(calls.companyCreates[0].status, CompanyStatus.ONBOARDING);
  equal(result.user.role, UserRole.COMPANY_ADMIN);
}

// RB-006: build a minimal fake ExecutionContext carrying only what RolesGuard
// reads (context.getHandler()/getClass() for @Roles metadata, and
// request.user for the authenticated JWT payload) so the *real*
// CompanyController route decorators and the *real* RolesGuard logic are
// exercised, without needing a full Nest application bootstrap.
function buildRoleContext(handler: Function, role: UserRole | undefined): ExecutionContext {
  const user: JwtPayload | undefined = role
    ? { sub: 1, email: 'user@example.test', role, status: 'active' }
    : undefined;

  return {
    getHandler: () => handler,
    getClass: () => CompanyController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

async function testCompanySideRolesCannotEnumerateOrFetchAnyCompany() {
  const guard = new RolesGuard(new Reflector());
  const tenantRoles = [UserRole.COMPANY, UserRole.COMPANY_ADMIN, UserRole.COMPANY_STAFF];

  for (const role of tenantRoles) {
    equal(
      guard.canActivate(buildRoleContext(CompanyController.prototype.findAll, role)),
      false,
      `${role} must not be able to call GET /companies (tenant enumeration)`,
    );
    equal(
      guard.canActivate(buildRoleContext(CompanyController.prototype.findOne, role)),
      false,
      `${role} must not be able to call GET /companies/:id (cross-tenant IDOR)`,
    );
  }
}

async function testPlatformAdminRetainsCompanyDirectoryAccess() {
  const guard = new RolesGuard(new Reflector());

  ok(
    guard.canActivate(buildRoleContext(CompanyController.prototype.findAll, UserRole.ADMIN)),
    'Platform admin must still be able to call GET /companies',
  );
  ok(
    guard.canActivate(buildRoleContext(CompanyController.prototype.findOne, UserRole.ADMIN)),
    'Platform admin must still be able to call GET /companies/:id',
  );
}

async function testCompanyFindByUserIdNeverResolvesAnotherTenant() {
  const companyA = { id: 101, user: { id: 1 }, name: 'Company A' };
  const companyB = { id: 102, user: { id: 2 }, name: 'Company B' };

  const companyRepo = {
    findOne: async ({ where }: { where: { user: { id: number } } }) =>
      [companyA, companyB].find((company) => company.user.id === where.user.id) ?? null,
  };

  const service = new CompanyService(companyRepo as any, {} as any);

  const resolvedForUserA = await service.findByUserId(1);
  const resolvedForUserB = await service.findByUserId(2);

  equal(resolvedForUserA?.id, companyA.id, "Company A's user must resolve Company A via JWT-derived findMine()");
  equal(resolvedForUserB?.id, companyB.id, "Company B's user must resolve Company B via JWT-derived findMine()");
  ok(resolvedForUserA?.id !== resolvedForUserB?.id, "Company A's session must never resolve Company B's record");
}

async function main() {
  await testPrivilegedRoleCannotSelfRegister();
  await testInvalidGuardPayloadHasNoSideEffects();
  await testGuardRegistrationRemainsPending();
  await testCompanyRegistrationMapsToCompanyAdmin();
  await testCompanySideRolesCannotEnumerateOrFetchAnyCompany();
  await testPlatformAdminRetainsCompanyDirectoryAccess();
  await testCompanyFindByUserIdNeverResolvesAnotherTenant();
  assertColumnExcluded(User, 'passwordHash', 'User.passwordHash');
  assertColumnExcluded(ClientPortalUser, 'passwordHash', 'ClientPortalUser.passwordHash');
  assertColumnExcluded(Site, 'attendanceNfcTag', 'Site.attendanceNfcTag');
  assertColumnExcluded(AttendanceEvent, 'nfcTag', 'AttendanceEvent.nfcTag');

  console.log(
    JSON.stringify({
      event: 'release_smoke_passed',
      tests: 11,
      scope: 'auth-registration-credential-attendance-secret-exposure-and-RB006-tenant-isolation',
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
