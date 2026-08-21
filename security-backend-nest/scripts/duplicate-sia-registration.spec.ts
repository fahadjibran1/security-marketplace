import { equal, ok, rejects } from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { AuthService } from '../src/auth/auth.service';
import { PublicRegistrationRole } from '../src/auth/dto/register.dto';
import { UserStatus } from '../src/user/entities/user.entity';

type Failure = 'sia-race' | 'database' | null;

function harness(seed: { email?: string; sia?: string } = {}, failure: Failure = null) {
  let users: any[] = seed.email ? [{ id: 90, email: seed.email }] : [];
  let guards: any[] = seed.sia ? [{ id: 91, siaLicenseNumber: seed.sia }] : [];
  let sessions = 0;

  const userService = {
    create: async (dto: any) => {
      if (users.some((user) => user.email === dto.email)) throw new ConflictException('Email already exists');
      const user = { id: users.length + 1, email: dto.email, role: dto.role, status: dto.status };
      users.push(user); return user;
    },
    findByEmail: async () => null,
  };
  const guardService = {
    findBySiaLicenseNumber: async (sia: string) => guards.find((guard) => guard.siaLicenseNumber === sia) ?? null,
    create: async (dto: any) => {
      if (failure === 'sia-race') {
        throw new QueryFailedError('INSERT redacted', [], { code: '23505', constraint: 'UQ_ccb60d0042497e83f11cadf004d', detail: 'redacted' } as any);
      }
      if (failure === 'database') {
        throw new QueryFailedError('INSERT redacted', [], { code: '08006', constraint: undefined, detail: 'redacted' } as any);
      }
      const guard = { id: guards.length + 1, ...dto };
      guards.push(guard); return guard;
    },
    findByUserId: async () => guards[guards.length - 1] ?? null,
  };
  const dataSource = {
    transaction: async (work: (manager: unknown) => Promise<unknown>) => {
      const beforeUsers = [...users];
      const beforeGuards = [...guards];
      try { return await work({}); }
      catch (error) { users = beforeUsers; guards = beforeGuards; throw error; }
    },
  };
  const service = new AuthService(
    userService as any,
    { sign: () => { sessions += 1; return 'server-token'; } } as any,
    { create: async () => undefined, findByUserId: async () => null } as any,
    guardService as any,
    {} as any, {} as any, dataSource as any,
  );
  return { service, users: () => users, guards: () => guards, sessions: () => sessions };
}

const guardRegistration = (siaLicenseNumber: string, email = 'new@example.test') => ({
  email, password: 'secret123', role: PublicRegistrationRole.GUARD,
  fullName: 'SEC-016 Guard', phone: '07000000000', siaLicenseNumber,
});

async function expectStatus(action: () => Promise<unknown>, status: number, message?: string) {
  try { await action(); }
  catch (error) {
    ok(error instanceof BadRequestException || error instanceof ConflictException);
    equal(error.getStatus(), status);
    if (message) equal(error.message, message);
    return;
  }
  throw new Error(`Expected HTTP ${status}`);
}

async function main() {
  const success = harness();
  const registered = await success.service.register(guardRegistration(' 1234567890123456 '));
  equal(registered.user.status, UserStatus.ACTIVE);
  equal(success.guards()[0].siaLicenseNumber, '1234567890123456');
  equal(success.sessions(), 1);

  const duplicateEmail = harness({ email: 'used@example.test' });
  await expectStatus(() => duplicateEmail.service.register(guardRegistration('2234567890123456', 'used@example.test')), 409, 'Email already exists');

  const duplicateSia = harness({ sia: '3234567890123456' });
  await expectStatus(() => duplicateSia.service.register(guardRegistration('3234567890123456')), 409, 'SIA licence number is already registered.');
  equal(duplicateSia.users().length, 0);
  equal(duplicateSia.guards().length, 1);
  equal(duplicateSia.sessions(), 0);

  const race = harness({}, 'sia-race');
  await expectStatus(() => race.service.register(guardRegistration('4234567890123456')), 409, 'SIA licence number is already registered.');
  equal(race.users().length, 0);
  equal(race.guards().length, 0);
  equal(race.sessions(), 0);

  const databaseFailure = harness({}, 'database');
  await rejects(() => databaseFailure.service.register(guardRegistration('5234567890123456')), QueryFailedError);
  equal(databaseFailure.users().length, 0);

  await expectStatus(() => harness().service.register(guardRegistration('123456789012345')), 400);
  await expectStatus(() => harness().service.register(guardRegistration('12345678901234567')), 400);
  await expectStatus(() => harness().service.register(guardRegistration('1234-5678-9012-3456')), 400);
  await expectStatus(() => harness().service.register(guardRegistration('123456789012345A')), 400);

  console.log(JSON.stringify({ event: 'duplicate_sia_registration_tests_passed', tests: 18 }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
