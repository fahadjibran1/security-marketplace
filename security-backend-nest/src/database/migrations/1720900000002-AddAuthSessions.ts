import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuthSessions1720900000002 implements MigrationInterface {
  name = 'AddAuthSessions1720900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Renewable mobile sessions. Purely additive: no existing table or column is touched, and
    // nothing reads this table until a client presents a refresh token, so deploying the
    // migration ahead of any client change is a no-op for live users.
    //
    // Only the SHA-256 hash of the refresh token is stored — the raw token exists solely in the
    // response body and in the device's SecureStore.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_sessions" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL
          REFERENCES "users"("id") ON DELETE CASCADE,
        "tokenHash" VARCHAR(64) NOT NULL,
        "familyId" UUID NOT NULL,
        "rotatedFromId" INTEGER NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "absoluteExpiresAt" TIMESTAMPTZ NOT NULL,
        "revokedAt" TIMESTAMPTZ NULL,
        "revokedReason" VARCHAR(32) NULL,
        "lastUsedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Unique: the hash is the lookup key, so two live sessions must never share one.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_auth_sessions_token_hash"
        ON "auth_sessions" ("tokenHash")
    `);

    // Revoking every session for a user (logout-all, future password change).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_auth_sessions_user_id"
        ON "auth_sessions" ("userId")
    `);

    // Reuse detection revokes a whole rotation chain by familyId.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_auth_sessions_family_id"
        ON "auth_sessions" ("familyId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_auth_sessions_family_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_auth_sessions_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_auth_sessions_token_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_sessions"`);
  }
}
