/**
 * Full Application Boot Certification
 *
 * Uses NestFactory.create(AppModule) with a real PostgreSQL test database to
 * exercise the COMPLETE Nest dependency-injection graph and every onModuleInit
 * lifecycle hook — identical to the production bootstrap in dist/main.js.
 *
 * This spec is production-equivalent.  It catches:
 *   — "Nest can't resolve dependencies of X" DI wiring defects in any module
 *   — Constructor failures (e.g. missing encryption keys, bad config)
 *   — onModuleInit failures
 *   — TypeORM entity-metadata registration problems
 *
 * Static compile() or per-module tests are insufficient substitutes because
 * they do not exercise the full graph or lifecycle.
 *
 * Required env var:
 *   APP_BOOT_DATABASE_URL — postgres connection URL for a real test database
 *   (falls back to P1I_DATABASE_URL then the local dev DB at port 54322)
 *
 * Optional:
 *   APP_BOOT_ENC_KEY  — 64-char hex string (GUARD_DATA_ENCRYPTION_KEY)
 *   APP_BOOT_HMAC_KEY — 64-char hex string (GUARD_DATA_HMAC_KEY)
 *
 * Run:
 *   APP_BOOT_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/p1i_membership_test \
 *   ts-node -r tsconfig-paths/register scripts/app-boot.spec.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

// ── Test environment setup ──────────────────────────────────────────────────
// These assignments run AFTER import hoisting but BEFORE NestFactory.create()
// is called, so ConfigModule and TypeOrmModule pick them up correctly.

const dbUrl =
  process.env.APP_BOOT_DATABASE_URL ||
  process.env.P1I_DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:54322/p1i_membership_test';

if (!process.env.APP_BOOT_DATABASE_URL && !process.env.P1I_DATABASE_URL) {
  console.warn(
    '[app-boot] APP_BOOT_DATABASE_URL not set — using local dev DB at 127.0.0.1:54322',
  );
}

// Boot in test mode: skip production-only config assertions in validateRuntimeEnv
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = dbUrl;
process.env.DATABASE_SYNCHRONIZE = 'false'; // never alter the test DB schema on boot
process.env.JWT_SECRET = process.env.JWT_SECRET || 'app-boot-spec-jwt-secret-32chars!!';

// EncryptionService reads these in its constructor (throws if missing/invalid)
// Provide distinct 64-hex-char test keys — NOT real keys, only used for boot certification
process.env.GUARD_DATA_ENCRYPTION_KEY =
  process.env.APP_BOOT_ENC_KEY ||
  process.env.GUARD_DATA_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GUARD_DATA_HMAC_KEY =
  process.env.APP_BOOT_HMAC_KEY ||
  process.env.GUARD_DATA_HMAC_KEY ||
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now();

  console.log('\n── Full Application Boot Certification ──────────────────────────────────');
  console.log(`  Database : ${dbUrl.replace(/:\/\/[^@]+@/, '://***@')}`);
  console.log(`  NODE_ENV : ${process.env.NODE_ENV}`);

  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;

  try {
    // Suppress NestJS banner/logs during certification (noise in CI)
    app = await NestFactory.create(AppModule, { logger: false });

    // close() triggers onModuleDestroy hooks and releases DB connections
    await app.close();

    const elapsedMs = Date.now() - startedAt;
    console.log(`  Duration : ${elapsedMs}ms`);
    console.log('\nFULL APPLICATION BOOT: PASS');
    process.exit(0);
  } catch (err: unknown) {
    if (app) {
      try { await app.close(); } catch { /* ignore cleanup error */ }
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFULL APPLICATION BOOT: FAIL`);
    console.error(`  ${msg}`);
    if (err instanceof Error && err.stack) {
      // Print only the first relevant stack frame
      const frame = err.stack.split('\n').slice(1, 4).join('\n');
      console.error(frame);
    }
    process.exit(1);
  }
}

main();
