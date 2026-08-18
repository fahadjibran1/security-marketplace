import 'reflect-metadata';
import { deepStrictEqual, equal, match, ok, rejects, throws } from 'assert';
import * as bcrypt from 'bcrypt';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuthService } from '../src/auth/auth.service';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

type Store = { users: User[]; audits: AuditLog[]; nextUserId: number; queries: string[] };

function cloneStore(source: Store): Store {
  return {
    users: source.users.map((value) => ({ ...value } as User)),
    audits: source.audits.map((value) => ({ ...value } as AuditLog)),
    nextUserId: source.nextUserId,
    queries: [...source.queries],
  };
}

function fakeDataSource(store: Store) {
  return {
    transaction: async (work: (manager: any) => Promise<unknown>) => {
      const pending = cloneStore(store);
      const manager = {
        query: async (sql: string) => { pending.queries.push(sql); return []; },
        getRepository: (entity: unknown) => entity === User ? userRepo(pending) : auditRepo(pending),
      };
      const result = await work(manager);
      Object.assign(store, pending);
      return result;
    },
  } as any;
}

function userRepo(store: Store) {
  return {
    count: async ({ where }: any) => store.users.filter((user) => user.role === where.role).length,
    findOne: async ({ where }: any) => store.users.find((user) => user.email === where.email) ?? null,
    create: (value: Partial<User>) => ({ ...value } as User),
    save: async (value: User) => {
      if (!value.id) {
        value.id = store.nextUserId++;
        store.users.push(value);
      } else {
        const index = store.users.findIndex((user) => user.id === value.id);
        store.users[index] = value;
      }
      return value;
    },
    createQueryBuilder: () => ({
      addSelect() { return this; },
      where(_sql: string, { email }: { email: string }) {
        const matches = store.users.filter((user) => user.email.toLowerCase() === email);
        return {
          getCount: async () => matches.length,
          getMany: async () => matches,
        };
      },
    }),
  };
}

function auditRepo(store: Store) {
  return {
    create: (value: Partial<AuditLog>) => ({ ...value } as AuditLog),
    save: async (value: AuditLog) => { value.id = store.audits.length + 1; store.audits.push(value); return value; },
  };
}

const strongPassword = 'RC1-Strong!Pass9';
const recoveryPassword = 'RC1-Recover!Pass8';
const makeStore = (): Store => ({ users: [], audits: [], nextUserId: 1, queries: [] });

async function main() {
  let passed = 0;
  const test = async (name: string, work: () => unknown | Promise<unknown>) => {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  };

  const store = makeStore();
  const service = new AdminOperatorService(fakeDataSource(store));
  const created = await service.bootstrap('  RC1.Admin@Example.Test ', strongPassword);

  await test('empty database creates exactly one Platform Admin', () => equal(store.users.length, 1));
  await test('created identity has Platform Admin role', () => equal(store.users[0].role, UserRole.ADMIN));
  await test('created admin is ACTIVE', () => equal(store.users[0].status, UserStatus.ACTIVE));
  await test('email is normalized', () => equal(store.users[0].email, 'rc1.admin@example.test'));
  await test('password is bcrypt hashed', async () => {
    ok(store.users[0].passwordHash !== strongPassword);
    ok(await bcrypt.compare(strongPassword, store.users[0].passwordHash));
  });
  await test('normal AuthService login succeeds', async () => {
    const auth = new AuthService(
      { findByEmail: async () => store.users[0], updateLastLogin: async () => undefined } as any,
      { sign: () => 'redacted-test-token' } as any,
      {} as any, {} as any, {} as any, {} as any,
    );
    const result = await auth.login({ email: store.users[0].email, password: strongPassword });
    equal(result.user.role, UserRole.ADMIN);
  });
  await test('second bootstrap attempt is rejected and leaves one admin', async () => {
    await rejects(() => service.bootstrap('second@example.test', strongPassword), /already exists/);
    equal(store.users.length, 1);
  });
  await test('bootstrap rejects when another admin already exists', async () => {
    const existing = makeStore();
    existing.users.push({ id: 7, email: 'existing@example.test', role: UserRole.ADMIN } as User);
    await rejects(() => new AdminOperatorService(fakeDataSource(existing)).bootstrap('new@example.test', strongPassword), /already exists/);
  });
  await test('bootstrap rejects collision with a non-admin user', async () => {
    const collision = makeStore();
    collision.users.push({ id: 8, email: 'Guard@Example.Test', role: UserRole.GUARD } as User);
    await rejects(() => new AdminOperatorService(fakeDataSource(collision)).bootstrap('GUARD@example.test', strongPassword), /belongs to a user/);
  });
  await test('missing email is rejected', () => throws(() => service.bootstrap(undefined, strongPassword), /valid admin email/));
  await test('missing password is rejected', () => throws(() => service.bootstrap('x@example.test', undefined), /Admin password/));
  await test('weak password is rejected', () => throws(() => service.bootstrap('x@example.test', 'weakpass'), /Admin password/));
  await test('invalid email is rejected', () => throws(() => service.bootstrap('not-an-email', strongPassword), /valid admin email/));
  await test('no company or guard side records are created', () => deepStrictEqual(Object.keys(created).sort(), ['email', 'userId']));
  await test('bootstrap audit record is created', () => equal(store.audits[0].action, 'platform_admin.bootstrapped'));
  await test('audit contains no password, hash, JWT or credential', () => {
    const payload = JSON.stringify(store.audits);
    ok(!payload.includes(strongPassword));
    ok(!/passwordHash|accessToken|JWT|secret/i.test(payload));
    equal((store.audits[0].afterData as any).actorType, 'SYSTEM_OPERATOR');
  });
  await test('recovery refuses a non-admin target', async () => {
    const nonAdmin = makeStore();
    nonAdmin.users.push({ id: 9, email: 'company@example.test', role: UserRole.COMPANY_ADMIN } as User);
    await rejects(
      () => new AdminOperatorService(fakeDataSource(nonAdmin)).recover('company@example.test', recoveryPassword, true),
      /not an existing Platform Admin/,
    );
  });
  await test('recovery requires explicit confirmation', () => throws(
    () => service.recover(store.users[0].email, recoveryPassword, false), /confirmation/,
  ));
  await test('recovery reactivates existing admin and resets hash', async () => {
    store.users[0].status = UserStatus.SUSPENDED;
    const oldHash = store.users[0].passwordHash;
    await service.recover(store.users[0].email, recoveryPassword, true);
    equal(store.users[0].status, UserStatus.ACTIVE);
    ok(store.users[0].passwordHash !== oldHash);
    ok(await bcrypt.compare(recoveryPassword, store.users[0].passwordHash));
  });
  await test('recovery action is audited without secrets', () => {
    const audit = store.audits.find((entry) => entry.action === 'platform_admin.recovered');
    ok(audit);
    const payload = JSON.stringify(audit);
    ok(!payload.includes(recoveryPassword));
    ok(!/passwordHash|accessToken|credential/i.test(payload));
  });
  await test('operator operations take a transaction advisory lock', () => {
    ok(store.queries.every((query) => /pg_advisory_xact_lock/.test(query)));
  });

  match(String(created.userId), /^\d+$/);
  console.log(`Admin operator regression: ${passed}/${passed} PASS`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
