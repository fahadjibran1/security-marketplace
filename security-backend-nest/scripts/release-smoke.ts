import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { PublicRegistrationRole, RegisterDto } from '../src/auth/dto/register.dto';
import { CompanyStatus } from '../src/company/entities/company.entity';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';

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

  assert.ok(thrown instanceof BadRequestException, 'Expected BadRequestException');
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

  assert.equal(calls.userCreates.length, 0, 'Privileged registration must not create a user');
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

  assert.equal(calls.userCreates.length, 0, 'Invalid guard registration must not create a user');
  assert.equal(calls.guardCreates.length, 0, 'Invalid guard registration must not create a profile');
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

  assert.equal(calls.userCreates.length, 1);
  assert.equal(calls.userCreates[0].role, UserRole.GUARD);
  assert.equal(calls.userCreates[0].status, UserStatus.PENDING);
  assert.equal(calls.guardCreates.length, 1);
  assert.equal(calls.guardCreates[0].status, GuardApprovalStatus.PENDING);
  assert.equal(calls.guardCreates[0].approvalStatus, GuardApprovalStatus.PENDING);
  assert.equal(calls.guardCreates[0].isApproved, false);
  assert.equal(result.user.status, UserStatus.PENDING);
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

  assert.equal(calls.userCreates.length, 1);
  assert.equal(calls.userCreates[0].role, UserRole.COMPANY_ADMIN);
  assert.equal(calls.userCreates[0].status, UserStatus.ACTIVE);
  assert.equal(calls.companyCreates.length, 1);
  assert.equal(calls.companyCreates[0].status, CompanyStatus.ONBOARDING);
  assert.equal(result.user.role, UserRole.COMPANY_ADMIN);
}

async function main() {
  await testPrivilegedRoleCannotSelfRegister();
  await testInvalidGuardPayloadHasNoSideEffects();
  await testGuardRegistrationRemainsPending();
  await testCompanyRegistrationMapsToCompanyAdmin();

  console.log(
    JSON.stringify({
      event: 'release_smoke_passed',
      tests: 4,
      scope: 'auth-registration',
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
