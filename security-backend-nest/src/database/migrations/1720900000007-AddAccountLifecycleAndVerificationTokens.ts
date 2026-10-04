import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountLifecycleAndVerificationTokens1720900000007 implements MigrationInterface {
  name = 'AddAccountLifecycleAndVerificationTokens1720900000007';

  /**
   * Migration 61 — S4 Pilot Gate 2: account deletion, password reset and email verification.
   *
   * users gains three columns:
   *
   *   deletionRequestedAt        timestamptz NULL
   *   deletionCompletedAt        timestamptz NULL
   *   emailVerificationRequired  boolean NOT NULL, default true for every account created from now on
   *
   * GRANDFATHERING. Every account that exists when this runs must keep signing in exactly as it does
   * today, so it has to end up with emailVerificationRequired = false while every later account gets
   * true. That is done WITHOUT a backfill UPDATE: the column is added with DEFAULT false, which
   * PostgreSQL applies to every existing row as part of the ADD COLUMN itself (a catalogue-only change
   * on PostgreSQL 11+, no table rewrite), and the default is then switched to true in the same
   * transaction. No existing row is read or rewritten, and status, isEmailVerified, roles, company
   * membership and guard relationships are not touched at all.
   *
   * There is deliberately NO retentionReason column. Retention is decided per record category (SIA
   * licence, GPS, screening evidence, attendance, timesheets, Welfare, Log Book, incidents, alerts,
   * audit) and cannot honestly be represented by one reason on a user row.
   *
   * There is deliberately NO deletionRequestedAt index. Nothing queries users by that column today; an
   * index would only be justified by a real query (e.g. a support work-queue), not for completeness.
   *
   * user_verification_tokens holds single-use emailed tokens. Only the SHA-256 hash is stored. purpose
   * is a varchar validated by the application ('password_reset' | 'email_verification'), not a
   * PostgreSQL enum. The user foreign key cascades, which is safe: S4 never physically deletes a user
   * (deletion anonymises the row in place) and nothing references this table, so a cascade can never
   * reach operational evidence. Constraint and index names match the entity metadata exactly, so the
   * entity-to-migration drift check reports nothing for this table.
   *
   * Every statement is guarded (IF NOT EXISTS / IF EXISTS), so a partially applied run can be re-run.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "deletionCompletedAt" TIMESTAMPTZ NULL
    `);

    // Existing rows receive false from the ADD COLUMN; only rows inserted afterwards see true.
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "emailVerificationRequired" BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ALTER COLUMN "emailVerificationRequired" SET DEFAULT true
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_verification_tokens" (
        "id" SERIAL NOT NULL,
        "userId" INTEGER NOT NULL,
        "purpose" CHARACTER VARYING(32) NOT NULL,
        "tokenHash" CHARACTER VARYING(64) NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "usedAt" TIMESTAMPTZ NULL,
        "invalidatedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_aec3eb060748f1cf7202e273bcc" PRIMARY KEY ("id"),
        CONSTRAINT "FK_4cc1d0afe1dfdb837b54ca1100d" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // The hash is the lookup key, so two live tokens must never share one.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_verification_tokens_token_hash"
        ON "user_verification_tokens" ("tokenHash")
    `);

    // Superseding: every unspent token of one purpose for one user is invalidated on reissue.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_verification_tokens_user_purpose"
        ON "user_verification_tokens" ("userId", "purpose")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_verification_tokens_user_purpose"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_verification_tokens_token_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_verification_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerificationRequired"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "deletionCompletedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "deletionRequestedAt"`);
  }
}
