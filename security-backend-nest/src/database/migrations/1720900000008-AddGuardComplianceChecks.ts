import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 62: company-recorded SIA and Right to Work checks.
 *
 * Why. A Guard became assignable only when their own profile carried an SIA licence number and
 * expiry and a Right to Work status (and expiry, unless permanent). Those fields are written only by
 * the Guard, through optional S4 screening, so a company that does not use screening had no way to
 * make its own Guards eligible for the rota. This adds the company's own check record. The assessment
 * change that reads it ships in the same release; this migration only adds storage.
 *
 * What it adds — one new table and nothing else:
 *   guard_compliance_checks  append-only, company-scoped history of SIA and Right to Work checks.
 *
 * What it does NOT do:
 *   - no change to any existing table, column, constraint, index or row;
 *   - no copying of guard_profiles SIA / Right to Work declarations into company checks. A company
 *     check must be a check the company actually made, so nothing is backfilled or grandfathered;
 *   - no PostgreSQL enum types: kind, outcome, method, rightToWorkExcuse and changeType are varchar,
 *     validated in compliance-check-vocabulary.ts.
 *
 * Foreign keys:
 *   companyId            → companies(id)       ON DELETE CASCADE   (as compliance_records)
 *   guardId              → guard_profiles(id)  ON DELETE CASCADE   (as compliance_records)
 *   evidenceDocumentId   → guard_documents(id) ON DELETE SET NULL  (the check survives its evidence)
 *   recordedByUserId     → users(id)           ON DELETE SET NULL  (the check survives its author)
 *   supersededByCheckId  → this table(id)      ON DELETE SET NULL
 *
 * The partial unique index allows exactly one current (supersededAt IS NULL) check per company,
 * Guard and kind; superseded history is unlimited.
 *
 * Every statement is guarded so a partly applied run can be repeated. down() drops only this table.
 */
export class AddGuardComplianceChecks1720900000008 implements MigrationInterface {
  name = 'AddGuardComplianceChecks1720900000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_compliance_checks" (
        "id"                   SERIAL NOT NULL,
        "companyId"            integer NOT NULL,
        "guardId"              integer NOT NULL,
        "kind"                 character varying(32) NOT NULL,
        "outcome"              character varying(32) NOT NULL,
        "method"               character varying(40) NOT NULL,
        "rightToWorkExcuse"    character varying(32),
        "licenceNumber"        character varying(16),
        "checkDate"            date NOT NULL,
        "expiryDate"           date,
        "workRestrictions"     character varying(500),
        "checkedByName"        character varying(120) NOT NULL,
        "evidenceReference"    character varying(200),
        "evidenceDocumentId"   integer,
        "recordedByUserId"     integer,
        "changeType"           character varying(32) NOT NULL DEFAULT 'new_check',
        "changeReason"         character varying(500),
        "supersededAt"         TIMESTAMP WITH TIME ZONE,
        "supersededByCheckId"  integer,
        "createdAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_compliance_checks" PRIMARY KEY ("id")
      )
    `);

    const foreignKeys: Array<[string, string, string, string]> = [
      ['FK_guard_compliance_checks_company', 'companyId', 'companies', 'CASCADE'],
      ['FK_guard_compliance_checks_guard', 'guardId', 'guard_profiles', 'CASCADE'],
      ['FK_guard_compliance_checks_evidence_document', 'evidenceDocumentId', 'guard_documents', 'SET NULL'],
      ['FK_guard_compliance_checks_recorded_by', 'recordedByUserId', 'users', 'SET NULL'],
      ['FK_guard_compliance_checks_superseded_by', 'supersededByCheckId', 'guard_compliance_checks', 'SET NULL'],
    ];
    for (const [name, column, table, onDelete] of foreignKeys) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "guard_compliance_checks"
              ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
              REFERENCES "${table}"("id") ON DELETE ${onDelete} ON UPDATE NO ACTION;
          END IF;
        END $$
      `);
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_guard_compliance_checks_current"
        ON "guard_compliance_checks" ("companyId", "guardId", "kind")
        WHERE "supersededAt" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_guard_compliance_checks_company_guard"
        ON "guard_compliance_checks" ("companyId", "guardId", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table drops its indexes and constraints with it. Nothing else references it.
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_compliance_checks"`);
  }
}
