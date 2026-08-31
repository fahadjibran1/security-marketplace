import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActivatePendingGuardAccounts1719900000000 implements MigrationInterface {
  name = 'ActivatePendingGuardAccounts1719900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users"
      SET "status" = 'active', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "role" = 'guard' AND "status" = 'pending'
    `);
  }

  public async down(): Promise<void> {
    // Intentionally irreversible: reverting must not disable guard accounts
    // that were legitimately active before this normalization ran.
  }
}
