import 'reflect-metadata';
import { equal, ok, rejects } from 'assert';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AdminOperatorService } from '../src/admin-operator/admin-operator.service';
import { AuditLog } from '../src/audit-log/entities/audit-log.entity';
import { AuthService } from '../src/auth/auth.service';
import { buildTypeOrmOptions } from '../src/database/typeorm.config';
import { User, UserRole, UserStatus } from '../src/user/entities/user.entity';

async function main() {
  const url = process.env.ADMIN_OPERATOR_TEST_DATABASE_URL;
  if (!url) throw new Error('ADMIN_OPERATOR_TEST_DATABASE_URL is required');
  const dataSource = new DataSource(buildTypeOrmOptions({
    DATABASE_URL: url,
    DATABASE_SSL: 'false',
    DATABASE_SYNCHRONIZE: 'false',
    NODE_ENV: 'test',
  }));
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
    equal(await dataSource.getRepository(User).count(), 0);
    const migrations = await dataSource.query('SELECT count(*)::int AS count FROM typeorm_migrations');
    equal(migrations[0].count, 38);

    const service = new AdminOperatorService(dataSource);
    const password = 'PG17-Strong!Pass9';
    const recoveredPassword = 'PG17-Recover!Pass8';
    const result = await service.bootstrap('PG17.Admin@Example.Test', password);
    const users = dataSource.getRepository(User);
    equal(await users.count({ where: { role: UserRole.ADMIN } }), 1);
    const admin = await users.createQueryBuilder('user').addSelect('user.passwordHash')
      .where('user.id = :id', { id: result.userId }).getOneOrFail();
    equal(admin.role, UserRole.ADMIN);
    equal(admin.status, UserStatus.ACTIVE);
    ok(await bcrypt.compare(password, admin.passwordHash));

    const auth = new AuthService(
      {
        findByEmail: (email: string) => users.createQueryBuilder('user').addSelect('user.passwordHash')
          .where('user.email = :email', { email }).getOne(),
        updateLastLogin: (id: number) => users.update(id, { lastLoginAt: new Date() }).then(() => undefined),
      } as any,
      { sign: () => 'redacted-test-token' } as any,
      {} as any, {} as any, {} as any, {} as any, dataSource,
    );
    equal((await auth.login({ email: admin.email, password })).user.role, UserRole.ADMIN);

    await rejects(() => service.bootstrap('second@example.test', password), /already exists/);
    equal(await users.count({ where: { role: UserRole.ADMIN } }), 1);
    await service.recover(admin.email, recoveredPassword, true);
    const recovered = await users.createQueryBuilder('user').addSelect('user.passwordHash')
      .where('user.id = :id', { id: admin.id }).getOneOrFail();
    equal(recovered.status, UserStatus.ACTIVE);
    ok(await bcrypt.compare(recoveredPassword, recovered.passwordHash));

    const audits = await dataSource.getRepository(AuditLog).find({ order: { id: 'ASC' } });
    equal(audits.length, 2);
    equal(audits[0].action, 'platform_admin.bootstrapped');
    equal(audits[1].action, 'platform_admin.recovered');
    const auditPayload = JSON.stringify(audits);
    ok(!auditPayload.includes(password));
    ok(!auditPayload.includes(recoveredPassword));
    ok(!/passwordHash|accessToken|credential/i.test(auditPayload));
    console.log('PostgreSQL 17 admin operator certification: PASS');
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
