import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardDrivingProfileP1D1720300000000 implements MigrationInterface {
  name = 'AddGuardDrivingProfileP1D1720300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Enum types must be created before the table that references them.
    await queryRunner.query(`
      CREATE TYPE "driving_licence_status_enum" AS ENUM (
        'NONE', 'PROVISIONAL', 'FULL', 'OTHER_OR_FOREIGN'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "primary_travel_method_enum" AS ENUM (
        'CAR', 'MOTORCYCLE', 'PUBLIC_TRANSPORT', 'BICYCLE', 'WALK', 'OTHER'
      )
    `);

    // Dedicated table — driving licence has its own verification lifecycle,
    // and encrypted licence number needs select:false isolation from guard_profiles.
    await queryRunner.query(`
      CREATE TABLE "guard_driving_profiles" (
        "id"                    serial PRIMARY KEY,
        "guardId"               int NOT NULL,
        "licenceStatus"         "driving_licence_status_enum" NOT NULL DEFAULT 'NONE',
        "licenceNumberEnc"      text NULL,
        "licenceCategories"     text NULL,
        "licenceExpiryDate"     date NULL,
        "willingToDriveToWork"  boolean NULL,
        "ownsVehicle"           boolean NULL,
        "hasVehicleAccess"      boolean NULL,
        "primaryTravelMethod"   "primary_travel_method_enum" NULL,
        "maxTravelDistanceMiles" int NULL,
        "createdAt"             timestamp NOT NULL DEFAULT now(),
        "updatedAt"             timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_guard_driving_profiles_guard"
          FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_guard_driving_profiles_guard"
          UNIQUE ("guardId")
      )
    `);

    // Evidence hook — DRIVING_LICENCE document type added here; file upload is P1D.1.
    await queryRunner.query(`
      ALTER TYPE "guard_document_type_enum" ADD VALUE IF NOT EXISTS 'driving_licence'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_driving_profiles"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "primary_travel_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "driving_licence_status_enum"`);
    // Note: PostgreSQL does not support removing enum values — DRIVING_LICENCE remains in
    // guard_document_type_enum after rollback. This is safe: no rows will reference it.
  }
}
