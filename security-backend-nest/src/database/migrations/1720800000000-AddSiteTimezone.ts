import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSiteTimezone1720800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/London'`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "timezone"`);
  }
}
