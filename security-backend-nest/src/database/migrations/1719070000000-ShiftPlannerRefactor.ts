import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShiftPlannerRefactor1719070000000 implements MigrationInterface {
  name = 'ShiftPlannerRefactor1719070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shifts"
      ALTER COLUMN "guardId" DROP NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "shifts"
      ADD COLUMN IF NOT EXISTS "instructions" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shifts"
      DROP COLUMN IF EXISTS "instructions";
    `);
    await queryRunner.query(`
      ALTER TABLE "shifts"
      ALTER COLUMN "guardId" SET NOT NULL;
    `);
  }
}
