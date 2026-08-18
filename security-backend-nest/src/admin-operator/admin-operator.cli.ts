import 'reflect-metadata';
import {
  AdminOperatorService,
  normalizeOperatorEmail,
  validateOperatorPassword,
} from './admin-operator.service';

const RECOVERY_CONFIRMATION = 'RECOVER_EXISTING_PLATFORM_ADMIN';

function assertOperatorEnvironment(): void {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Admin operator commands require NODE_ENV=production.');
  }
  if (process.env.DATABASE_SYNCHRONIZE?.trim().toLowerCase() !== 'false') {
    throw new Error('Admin operator commands require DATABASE_SYNCHRONIZE=false.');
  }
}

async function main(): Promise<void> {
  assertOperatorEnvironment();
  const operation = process.argv[2];
  if (operation !== 'bootstrap' && operation !== 'recover') {
    throw new Error('Unknown admin operator command.');
  }

  const email = normalizeOperatorEmail(
    operation === 'bootstrap' ? process.env.BOOTSTRAP_ADMIN_EMAIL : process.env.RECOVER_ADMIN_EMAIL,
  );
  const password = validateOperatorPassword(
    operation === 'bootstrap' ? process.env.BOOTSTRAP_ADMIN_PASSWORD : process.env.RECOVER_ADMIN_PASSWORD,
  );
  const recoveryConfirmed = process.env.RECOVER_ADMIN_CONFIRM === RECOVERY_CONFIRMATION;
  if (operation === 'recover' && !recoveryConfirmed) {
    throw new Error('Recovery refused: explicit operator confirmation is required.');
  }

  const { default: dataSource } = await import('../database/data-source');
  await dataSource.initialize();
  try {
    const service = new AdminOperatorService(dataSource);
    const result = operation === 'bootstrap'
      ? await service.bootstrap(email, password)
      : await service.recover(email, password, recoveryConfirmed);
    console.log(`Platform Admin ${operation} succeeded.`);
    console.log(`User ID: ${result.userId}`);
    console.log(`Email: ${result.email}`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown operator error.';
  console.error(`Platform Admin operator command failed: ${message}`);
  process.exitCode = 1;
});
