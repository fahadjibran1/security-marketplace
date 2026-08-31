import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddClientPortalUsers1719270000000 implements MigrationInterface {
  name = 'AddClientPortalUsers1719270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'client_portal_users_role_enum') THEN
          CREATE TYPE "public"."client_portal_users_role_enum" AS ENUM('client_admin', 'client_viewer');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "client_portal_users" (
        "id" SERIAL NOT NULL,
        "clientId" integer NOT NULL,
        "email" character varying NOT NULL,
        "passwordHash" character varying NOT NULL,
        "firstName" character varying NOT NULL,
        "lastName" character varying NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "role" "public"."client_portal_users_role_enum" NOT NULL DEFAULT 'client_viewer',
        "lastLoginAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_client_portal_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_client_portal_users_email" UNIQUE ("email"),
        CONSTRAINT "FK_client_portal_users_clientId" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_client_portal_users_clientId"
      ON "client_portal_users" ("clientId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_portal_users_clientId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_portal_users"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."client_portal_users_role_enum"`);
  }
}
