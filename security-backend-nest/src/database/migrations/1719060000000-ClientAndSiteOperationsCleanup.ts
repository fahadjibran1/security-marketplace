import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClientAndSiteOperationsCleanup1719060000000 implements MigrationInterface {
  name = 'ClientAndSiteOperationsCleanup1719060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "clients"
      ADD COLUMN IF NOT EXISTS "contactEmail" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "clients"
      ADD COLUMN IF NOT EXISTS "contactPhone" character varying;
    `);

    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "requiredGuardCount" integer NOT NULL DEFAULT 1;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "operatingDays" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "operatingStartTime" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "operatingEndTime" character varying;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
      ADD COLUMN IF NOT EXISTS "specialInstructions" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "specialInstructions";`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "operatingEndTime";`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "operatingStartTime";`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "operatingDays";`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "requiredGuardCount";`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "contactPhone";`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "contactEmail";`);
  }
}
