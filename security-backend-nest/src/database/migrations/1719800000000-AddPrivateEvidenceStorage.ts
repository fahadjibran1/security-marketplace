import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPrivateEvidenceStorage1719800000000 implements MigrationInterface {
  name = 'AddPrivateEvidenceStorage1719800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "guard_documents" ALTER COLUMN "fileUrl" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "storageProvider" character varying`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "storageKey" character varying`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "originalFileName" character varying`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "mimeType" character varying`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "sizeBytes" bigint`);
    await queryRunner.query(`ALTER TABLE "guard_documents" ADD COLUMN IF NOT EXISTS "uploadCompletedAt" timestamp`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_guard_documents_storage_key" ON "guard_documents" ("storageProvider", "storageKey") WHERE "storageKey" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_documents_storage_key"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "uploadCompletedAt"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "sizeBytes"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "mimeType"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "originalFileName"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "storageKey"`);
    await queryRunner.query(`ALTER TABLE "guard_documents" DROP COLUMN IF EXISTS "storageProvider"`);
  }
}
