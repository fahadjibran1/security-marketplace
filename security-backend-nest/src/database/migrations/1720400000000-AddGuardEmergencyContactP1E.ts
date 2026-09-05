import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardEmergencyContactP1E1720400000000 implements MigrationInterface {
  name = 'AddGuardEmergencyContactP1E1720400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "emergency_contact_relationship_enum" AS ENUM (
        'SPOUSE_PARTNER', 'PARENT', 'SIBLING', 'CHILD', 'RELATIVE', 'FRIEND', 'OTHER'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "guard_emergency_contacts" (
        "id"                       serial PRIMARY KEY,
        "guardId"                  int NOT NULL,
        "contactNameEnc"           text NOT NULL,
        "relationship"             "emergency_contact_relationship_enum" NOT NULL,
        "customRelationshipEnc"    text NULL,
        "primaryPhoneEnc"          text NOT NULL,
        "alternatePhoneEnc"        text NULL,
        "createdAt"                timestamp NOT NULL DEFAULT now(),
        "updatedAt"                timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_guard_emergency_contacts_guard"
          FOREIGN KEY ("guardId") REFERENCES "guard_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_guard_emergency_contacts_guard"
          UNIQUE ("guardId")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_emergency_contacts"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "emergency_contact_relationship_enum"`);
  }
}
