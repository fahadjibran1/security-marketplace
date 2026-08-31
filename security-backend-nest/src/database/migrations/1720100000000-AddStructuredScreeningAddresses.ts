import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStructuredScreeningAddresses1720100000000 implements MigrationInterface {
  name = 'AddStructuredScreeningAddresses1720100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE screening_addresses ADD COLUMN "addressLine1" varchar(200), ADD COLUMN "addressLine2" varchar(200), ADD COLUMN "townCity" varchar(150), ADD COLUMN postcode varchar(8)`);
    await queryRunner.query(`CREATE INDEX "IDX_screening_addresses_postcode" ON screening_addresses (postcode) WHERE postcode IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_screening_addresses_postcode"`);
    await queryRunner.query(`ALTER TABLE screening_addresses DROP COLUMN IF EXISTS postcode, DROP COLUMN IF EXISTS "townCity", DROP COLUMN IF EXISTS "addressLine2", DROP COLUMN IF EXISTS "addressLine1"`);
  }
}
