import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientBilledHoursSnapshot1720800000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "timesheets" ADD COLUMN "clientBilledHoursSnapshot" NUMERIC(8,2) NULL`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN "clientBilledHoursSnapshot"`);
  }
}
