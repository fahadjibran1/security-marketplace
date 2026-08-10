import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeAvailabilityOverridesByCompany1719400000000 implements MigrationInterface {
  name = 'ScopeAvailabilityOverridesByCompany1719400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_availability_overrides" ADD "companyId" integer`);
    await queryRunner.query(`CREATE INDEX "IDX_guard_availability_overrides_company" ON "guard_availability_overrides" ("companyId")`);
    await queryRunner.query(`ALTER TABLE "guard_availability_overrides" ADD CONSTRAINT "FK_guard_availability_overrides_company" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_availability_overrides" DROP CONSTRAINT "FK_guard_availability_overrides_company"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_guard_availability_overrides_company"`);
    await queryRunner.query(`ALTER TABLE "guard_availability_overrides" DROP COLUMN "companyId"`);
  }
}
