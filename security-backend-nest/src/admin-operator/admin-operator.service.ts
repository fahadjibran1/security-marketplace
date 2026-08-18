import * as bcrypt from 'bcrypt';
import { isEmail } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { User, UserRole, UserStatus } from '../user/entities/user.entity';

const ADMIN_OPERATOR_LOCK_ID = 534_401_400;
const MIN_PASSWORD_LENGTH = 12;

export type OperatorResult = { userId: number; email: string };

export function normalizeOperatorEmail(value: string | undefined): string {
  const email = value?.trim().toLowerCase() ?? '';
  if (!email || !isEmail(email)) throw new Error('A valid admin email is required.');
  return email;
}

export function validateOperatorPassword(value: string | undefined): string {
  const password = value ?? '';
  const strong =
    password.length >= MIN_PASSWORD_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  if (!strong) {
    throw new Error(
      `Admin password must be at least ${MIN_PASSWORD_LENGTH} characters and include upper-case, lower-case, numeric and special characters.`,
    );
  }
  return password;
}

export class AdminOperatorService {
  constructor(private readonly dataSource: DataSource) {}

  bootstrap(emailInput: string | undefined, passwordInput: string | undefined): Promise<OperatorResult> {
    const email = normalizeOperatorEmail(emailInput);
    const password = validateOperatorPassword(passwordInput);
    return this.dataSource.transaction(async (manager) => {
      await this.lock(manager);
      const users = manager.getRepository(User);
      const adminCount = await users.count({ where: { role: UserRole.ADMIN } });
      if (adminCount !== 0) throw new Error('Bootstrap refused: a Platform Admin already exists.');
      const emailCollisionCount = await users.createQueryBuilder('user')
        .where('LOWER(user.email) = :email', { email })
        .getCount();
      if (emailCollisionCount !== 0) {
        throw new Error('Bootstrap refused: the requested email already belongs to a user.');
      }

      const admin = await users.save(users.create({
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        isEmailVerified: true,
      }));
      await this.audit(manager, 'platform_admin.bootstrapped', admin, null, UserStatus.ACTIVE);
      return { userId: admin.id, email: admin.email };
    });
  }

  recover(
    emailInput: string | undefined,
    passwordInput: string | undefined,
    confirmed: boolean,
  ): Promise<OperatorResult> {
    if (!confirmed) throw new Error('Recovery refused: explicit operator confirmation is required.');
    const email = normalizeOperatorEmail(emailInput);
    const password = validateOperatorPassword(passwordInput);
    return this.dataSource.transaction(async (manager) => {
      await this.lock(manager);
      const users = manager.getRepository(User);
      const targets = await users
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('LOWER(user.email) = :email', { email })
        .getMany();
      if (targets.length !== 1 || targets[0].role !== UserRole.ADMIN) {
        throw new Error('Recovery refused: target is not an existing Platform Admin.');
      }
      const target = targets[0];

      const beforeStatus = target.status;
      target.passwordHash = await bcrypt.hash(password, 10);
      target.status = UserStatus.ACTIVE;
      await users.save(target);
      await this.audit(manager, 'platform_admin.recovered', target, beforeStatus, UserStatus.ACTIVE);
      return { userId: target.id, email: target.email };
    });
  }

  private lock(manager: EntityManager): Promise<unknown> {
    return manager.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_OPERATOR_LOCK_ID]);
  }

  private async audit(
    manager: EntityManager,
    action: string,
    admin: User,
    beforeStatus: UserStatus | null,
    afterStatus: UserStatus,
  ): Promise<void> {
    const audits = manager.getRepository(AuditLog);
    await audits.save(audits.create({
      company: null,
      user: null,
      action,
      entityType: 'user',
      entityId: admin.id,
      beforeData: beforeStatus ? { status: beforeStatus } : null,
      afterData: {
        adminUserId: admin.id,
        email: admin.email,
        role: UserRole.ADMIN,
        status: afterStatus,
        actorType: 'SYSTEM_OPERATOR',
        method: 'trusted_cli',
      },
    }));
  }
}
