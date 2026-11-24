import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 77: Platform Admin two-step verification (authenticator app, RFC 6238 TOTP).
 *
 *   platform_admin_mfa."userId"                 integer PK, FK users(id) ON DELETE CASCADE
 *   platform_admin_mfa."totpSecretEncrypted"    text NULL         the active secret, AES-256-GCM envelope
 *   platform_admin_mfa."pendingSecretEncrypted" text NULL         a started, unconfirmed enrolment, AES-256-GCM envelope
 *   platform_admin_mfa."pendingCreatedAt"       timestamptz NULL
 *   platform_admin_mfa."enabledAt"              timestamptz NULL  set when enrolment is confirmed
 *   platform_admin_mfa."lastUsedStep"           integer NULL      last accepted TOTP step (replay protection)
 *   platform_admin_mfa."createdAt"/"updatedAt"  timestamptz NOT NULL DEFAULT now()
 *
 * Additive only: a new, empty table. No existing table, column, row or session changes, so every account signs in
 * exactly as before until a Platform Admin enrols (or the PLATFORM_ADMIN_MFA_REQUIRED flag is turned on). The previous
 * release never reads the table, so rolling the application back needs no schema change.
 *
 * Reversible: down() drops the table (enrolments are lost; affected admins sign in with their password again).
 */
export class AddPlatformAdminMfa1720900000024 implements MigrationInterface {
  name = 'AddPlatformAdminMfa1720900000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "platform_admin_mfa" (
        "userId"                 integer NOT NULL,
        "totpSecretEncrypted"    text,
        "pendingSecretEncrypted" text,
        "pendingCreatedAt"       TIMESTAMP WITH TIME ZONE,
        "enabledAt"              TIMESTAMP WITH TIME ZONE,
        "lastUsedStep"           integer,
        "createdAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_platform_admin_mfa" PRIMARY KEY ("userId"),
        CONSTRAINT "CHK_platform_admin_mfa_enabled_secret" CHECK (("enabledAt" IS NULL) = ("totpSecretEncrypted" IS NULL)),
        CONSTRAINT "CHK_platform_admin_mfa_pending_pair" CHECK (("pendingSecretEncrypted" IS NULL) = ("pendingCreatedAt" IS NULL))
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "platform_admin_mfa" ADD CONSTRAINT "FK_platform_admin_mfa_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "platform_admin_mfa"`);
  }
}
