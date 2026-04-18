import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobBillingRate1719170000000 implements MigrationInterface {
  name = 'AddJobBillingRate1719170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD COLUMN IF NOT EXISTS "billingRate" numeric(10,2);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs"
      DROP COLUMN IF EXISTS "billingRate";
    `);
  }
}
