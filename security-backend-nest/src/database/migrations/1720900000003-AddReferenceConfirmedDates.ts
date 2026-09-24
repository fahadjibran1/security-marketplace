import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReferenceConfirmedDates1720900000003 implements MigrationInterface {
  name = 'AddReferenceConfirmedDates1720900000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A reference check whose outcome cannot be recorded against the dates it disputes is not a
    // check. These columns hold what the referee actually confirmed, alongside the candidate's
    // claim which already lives on the linked screening_history row.
    //
    // All three are nullable and no existing row is touched: references reviewed before this
    // migration simply have no confirmed dates, which is honest — nobody recorded them.
    await queryRunner.query(`
      ALTER TABLE "screening_references"
        ADD COLUMN IF NOT EXISTS "confirmedStartDate" DATE NULL,
        ADD COLUMN IF NOT EXISTS "confirmedEndDate" DATE NULL,
        ADD COLUMN IF NOT EXISTS "confirmedIsCurrent" BOOLEAN NULL
    `);

    // ADD VALUE cannot run inside a transaction block on older PostgreSQL, and TypeORM wraps
    // migrations in one. IF NOT EXISTS keeps a re-run idempotent; the catch keeps the migration
    // safe if the value is already present through another path.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'screening_reference_status_enum' AND e.enumlabel = 'DISCREPANCY'
        ) THEN
          ALTER TYPE screening_reference_status_enum ADD VALUE IF NOT EXISTS 'DISCREPANCY';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The columns drop cleanly. The enum value is deliberately left in place: PostgreSQL cannot
    // remove an enum label, and rebuilding the type would rewrite every existing reference row.
    // A surplus unused label is harmless; a destructive rewrite of live vetting records is not.
    await queryRunner.query(`
      ALTER TABLE "screening_references"
        DROP COLUMN IF EXISTS "confirmedStartDate",
        DROP COLUMN IF EXISTS "confirmedEndDate",
        DROP COLUMN IF EXISTS "confirmedIsCurrent"
    `);
  }
}

