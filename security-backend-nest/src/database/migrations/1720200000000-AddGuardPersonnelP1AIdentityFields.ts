import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardPersonnelP1AIdentityFields1720200000000 implements MigrationInterface {
  name = 'AddGuardPersonnelP1AIdentityFields1720200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // All columns nullable — zero existing rows invalidated.
    // select: false on the entity prevents accidental exposure in general queries.
    await queryRunner.query(`
      ALTER TABLE guard_profiles
        ADD COLUMN "ninoEnc" text NULL,
        ADD COLUMN "ninoHmac" varchar(64) NULL,
        ADD COLUMN "utrEnc" text NULL
    `);

    // Partial unique index: prevents two guards registering the same NINO
    // without decrypting it. NULL rows are excluded (guards without a NINO
    // are allowed and do not compete with each other).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_guard_profiles_nino_hmac"
        ON guard_profiles ("ninoHmac")
        WHERE "ninoHmac" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_guard_profiles_nino_hmac"`);
    await queryRunner.query(`
      ALTER TABLE guard_profiles
        DROP COLUMN IF EXISTS "utrEnc",
        DROP COLUMN IF EXISTS "ninoHmac",
        DROP COLUMN IF EXISTS "ninoEnc"
    `);
  }
}
