import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 76: the company verification lifecycle (SEC-PUBLIC-03, public launch).
 *
 *   companies."verificationStatus"     company_verification_status_enum NOT NULL
 *                                      ('pending_verification' | 'approved' | 'rejected' | 'suspended')
 *   companies."verificationNote"       text NULL          the administrator's reason, shown to the company
 *   companies."verificationDecidedAt"  timestamptz NULL   when the current state was decided
 *
 * Existing companies keep their access: the column is added with DEFAULT 'approved', which PostgreSQL applies to every
 * existing row as part of the ADD COLUMN (a catalogue-only change since PostgreSQL 11: no table rewrite, a brief
 * ACCESS EXCLUSIVE lock on companies only). The default is then switched to 'pending_verification', so only companies
 * created after this migration start unverified. The backfilled rows keep verificationDecidedAt NULL: they were
 * admitted by the invitation-only pilot, not by an S4 verification decision, and the record says so.
 *
 * Previously disabled organisations are NOT reactivated: a company whose legacy companies."status" is 'inactive' or
 * 'suspended' is set to verification 'suspended', with a note saying where that came from, so it keeps access to its
 * records and safety handling but cannot start new work until an S4 administrator reinstates it (suspended → approved,
 * an audited decision). 'onboarding' and 'active' companies (the invitation-only pilot) are approved.
 *
 * The legacy companies."status" column is only read, never changed, so down() restores the previous schema and data.
 *
 * Reversible: down() drops the three columns and the enum type (verification decisions made since are lost; the audit
 * log keeps them as company.verification_changed rows).
 */
export class AddCompanyVerification1720900000023 implements MigrationInterface {
  name = 'AddCompanyVerification1720900000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "company_verification_status_enum" AS ENUM ('pending_verification', 'approved', 'rejected', 'suspended')`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ADD "verificationStatus" "company_verification_status_enum" NOT NULL DEFAULT 'approved'`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ALTER COLUMN "verificationStatus" SET DEFAULT 'pending_verification'`,
    );
    await queryRunner.query(`ALTER TABLE "companies" ADD "verificationNote" text`);
    await queryRunner.query(`ALTER TABLE "companies" ADD "verificationDecidedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `UPDATE "companies"
          SET "verificationStatus" = 'suspended',
              "verificationNote" = 'Carried over from the company''s previous status (' || "status"::text || ') when S4 introduced company verification. Contact S4 to have it reviewed.'
        WHERE "status"::text IN ('inactive', 'suspended')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "verificationDecidedAt"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "verificationNote"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "verificationStatus"`);
    await queryRunner.query(`DROP TYPE "company_verification_status_enum"`);
  }
}
