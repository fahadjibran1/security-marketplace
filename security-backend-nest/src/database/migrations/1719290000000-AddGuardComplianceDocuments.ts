import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardComplianceDocuments1719290000000 implements MigrationInterface {
  name = 'AddGuardComplianceDocuments1719290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "guard_profiles"
      ADD COLUMN IF NOT EXISTS "siaExpiryDate" date,
      ADD COLUMN IF NOT EXISTS "rightToWorkStatus" character varying,
      ADD COLUMN IF NOT EXISTS "rightToWorkExpiryDate" date
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guard_documents_type_enum') THEN
          CREATE TYPE "public"."guard_documents_type_enum" AS ENUM('sia_licence', 'right_to_work', 'id_proof', 'training');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_documents" (
        "id" SERIAL NOT NULL,
        "guardId" integer NOT NULL,
        "type" "public"."guard_documents_type_enum" NOT NULL,
        "fileUrl" character varying NOT NULL,
        "expiryDate" date,
        "verified" boolean NOT NULL DEFAULT false,
        "uploadedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_documents_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_guard_documents_guardId" FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_guard_documents_guardId" ON "guard_documents" ("guardId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_guard_documents_guardId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_documents"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."guard_documents_type_enum"`);
    await queryRunner.query(`
      ALTER TABLE "guard_profiles"
      DROP COLUMN IF EXISTS "rightToWorkExpiryDate",
      DROP COLUMN IF EXISTS "rightToWorkStatus",
      DROP COLUMN IF EXISTS "siaExpiryDate"
    `);
  }
}
