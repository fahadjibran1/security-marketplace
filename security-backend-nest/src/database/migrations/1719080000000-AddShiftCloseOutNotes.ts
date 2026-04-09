import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShiftCloseOutNotes1719080000000 implements MigrationInterface {
  name = 'AddShiftCloseOutNotes1719080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shifts"
      ADD COLUMN IF NOT EXISTS "closeOutNotes" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shifts"
      DROP COLUMN IF EXISTS "closeOutNotes";
    `);
  }
}
