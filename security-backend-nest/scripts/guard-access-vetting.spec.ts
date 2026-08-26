import { equal, match, ok, rejects } from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuthService } from '../src/auth/auth.service';
import { PublicRegistrationRole } from '../src/auth/dto/register.dto';
import { UserRole, UserStatus } from '../src/user/entities/user.entity';
import { GuardComplianceService } from '../src/compliance/guard-compliance.service';
import { GuardDocumentType } from '../src/compliance/entities/guard-document.entity';
import { ActivatePendingGuardAccounts1719900000000 } from '../src/database/migrations/1719900000000-ActivatePendingGuardAccounts';
import { GuardApprovalStatus } from '../src/guard-profile/entities/guard-profile.entity';

const future = '2035-12-31';

function authHarness() {
  const users: any[] = [];
  const guards: any[] = [];
  const userService = {
    create: async (dto: any) => {
      const user = { id: 1, email: dto.email, passwordHash: await bcrypt.hash(dto.password, 4), role: dto.role, status: dto.status };
      users.push(user); return user;
    },
    findByEmail: async (email: string) => users.find((user) => user.email === email) ?? null,
    updateLastLogin: async () => undefined,
  };
  const guardService = {
    findBySiaLicenseNumber: async () => null,
    create: async (dto: any) => { const guard = { id: 10, ...dto }; guards.push(guard); return guard; },
    findByUserId: async (id: number) => guards.find((guard) => guard.userId === id) ?? null,
  };
  const service = new AuthService(
    userService as any,
    { sign: () => 'server-token' } as any,
    { create: async () => undefined, findByUserId: async () => null } as any,
    guardService as any,
    {} as any,
    {} as any,
    { transaction: async (work: (manager: unknown) => Promise<unknown>) => work({}) } as any,
  );
  return { service, users, guards };
}

function complianceHarness(verified: boolean) {
  const guard = {
    id: 10, fullName: 'Lifecycle Guard', phone: '07000000000', siaLicenseNumber: 'SIA-10',
    siaExpiryDate: future, rightToWorkStatus: 'permanent', rightToWorkExpiryDate: null,
    status: GuardApprovalStatus.APPROVED, approvalStatus: GuardApprovalStatus.APPROVED, isApproved: true,
  };
  const documents = [GuardDocumentType.SIA_LICENCE, GuardDocumentType.RIGHT_TO_WORK].map((type, index) => ({
    id: index + 1, guard, company: { id: 20 }, type, uploadCompletedAt: new Date(), expiryDate: future,
    verified, uploadedByUserId: 1, verifiedByUserId: verified ? 2 : null, verifiedAt: verified ? new Date() : null,
    uploadedAt: new Date(), originalFileName: 'evidence.pdf', mimeType: 'application/pdf', sizeBytes: '100',
  }));
  return new GuardComplianceService(
    { find: async () => documents } as any,
    { find: async () => [] } as any,
    { find: async () => [] } as any,
    {} as any,
    { findOne: async () => guard } as any,
    {} as any, {} as any, {} as any, {} as any,
  );
}

async function main() {
  const { service, users } = authHarness();
  const registration = await service.register({
    email: 'guard@example.test', password: 'secret123', role: PublicRegistrationRole.GUARD,
    fullName: 'Lifecycle Guard', siaLicenseNumber: '1234567890123456', phone: '07000000000',
  });
  equal(users[0].status, UserStatus.ACTIVE);
  equal(registration.user.status, UserStatus.ACTIVE);
  equal((await service.login({ email: 'guard@example.test', password: 'secret123' })).user.status, UserStatus.ACTIVE);

  users[0].status = UserStatus.SUSPENDED;
  await rejects(() => service.login({ email: 'guard@example.test', password: 'secret123' }), ForbiddenException);
  users[0].status = UserStatus.INACTIVE; // Existing schema's disabled-account state.
  await rejects(() => service.login({ email: 'guard@example.test', password: 'secret123' }), ForbiddenException);

  const uploadedOnly = complianceHarness(false);
  const uploadedSummary = await uploadedOnly.getGuardSummary(10, 20);
  equal(uploadedSummary.assignable, false);
  equal(uploadedSummary.complianceStatus, 'invalid');
  ok((await uploadedOnly.getBlockingReasons(20, 10)).length > 0);

  const verified = complianceHarness(true);
  equal((await verified.getGuardSummary(10, 20)).assignable, true);
  equal((await verified.getBlockingReasons(20, 10)).length, 0);

  for (const file of ['job-application/job-application.service.ts', 'assignment/assignment.service.ts', 'shift/shift.service.ts']) {
    const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
    match(source, /assertGuardAssignable/, `${file} must retain the server-side compliance gate`);
  }

  const queries: string[] = [];
  await new ActivatePendingGuardAccounts1719900000000().up({ query: async (sql: string) => queries.push(sql) } as any);
  match(queries.join(' '), /"role" = 'guard'/);
  match(queries.join(' '), /"status" = 'pending'/);
  ok(!queries.join(' ').includes("role = 'company'"));

  console.log(JSON.stringify({ event: 'guard_access_vetting_tests_passed', tests: 15 }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
