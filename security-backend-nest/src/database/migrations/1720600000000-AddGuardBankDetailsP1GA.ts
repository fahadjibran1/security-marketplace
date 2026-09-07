import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardBankDetailsP1GA1720600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "guard_bank_details" (
        "id"                     SERIAL PRIMARY KEY,
        "guardId"                integer NOT NULL,
        "accountHolderNameEnc"   text NULL,
        "sortCodeEnc"            text NULL,
        "accountNumberEnc"       text NULL,
        "createdAt"              timestamp NOT NULL DEFAULT now(),
        "updatedAt"              timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_guard_bank_details_guardId"
          UNIQUE ("guardId"),
        CONSTRAINT "FK_guard_bank_details_guard"
          FOREIGN KEY ("guardId")
          REFERENCES "guard_profiles" ("id")
          ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "guard_bank_details"`);
  }
}
