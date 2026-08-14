import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeGuardDocumentsByCompany1719700000000 implements MigrationInterface {
  name = 'ScopeGuardDocumentsByCompany1719700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "companyId" integer`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "uploadedByUserId" integer`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "verifiedByUserId" integer`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "verifiedAt" timestamp`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_guard_documents_company_guard" ON "guard_documents" ("companyId", "guardId")`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_guard_documents_companyId') THEN
          ALTER TABLE "guard_documents" ADD CONSTRAINT "FK_guard_documents_companyId"
          FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP CONSTRAINT IF EXISTS "FK_guard_documents_companyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_documents_company_guard"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "verifiedAt"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "verifiedByUserId"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "uploadedByUserId"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "companyId"`);
  }
}
