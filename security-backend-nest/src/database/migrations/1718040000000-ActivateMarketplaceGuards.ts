import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActivateMarketplaceGuards1718040000000 implements MigrationInterface {
  name = 'ActivateMarketplaceGuards1718040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users" AS u
      SET
        "status" = 'active',
        "updatedAt" = NOW()
      WHERE u."role" = 'guard'
        AND u."status" = 'pending'
        AND EXISTS (
          SELECT 1
          FROM "guard_profiles" AS gp
          WHERE gp."userId" = u."id"
            AND gp."approvalStatus" = 'pending'
        );
    `);

    await queryRunner.query(`
      UPDATE "guard_profiles" AS gp
      SET
        "status" = 'approved',
        "approvalStatus" = 'approved',
        "isApproved" = true
      WHERE gp."approvalStatus" = 'pending'
        AND EXISTS (
          SELECT 1
          FROM "users" AS u
          WHERE u."id" = gp."userId"
            AND u."role" = 'guard'
            AND u."status" = 'active'
        );
    `);
  }

  public async down(): Promise<void> {
    // This data backfill intentionally has no automatic rollback because
    // historical pending-vs-approved marketplace intent cannot be inferred safely.
  }
}
