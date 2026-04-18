import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReturnedTimesheetStatus1719120000000 implements MigrationInterface {
  name = 'AddReturnedTimesheetStatus1719120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'timesheets_approvalstatus_enum'
            AND e.enumlabel = 'returned'
        ) THEN
          ALTER TYPE "timesheets_approvalstatus_enum" ADD VALUE 'returned';
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
