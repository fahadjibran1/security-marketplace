import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyMembershipAndInvitations1720800000005 implements MigrationInterface {
  name = 'AddCompanyMembershipAndInvitations1720800000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create enums — idempotent via DO $$ IF NOT EXISTS $$
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_membership_role') THEN
          CREATE TYPE company_membership_role AS ENUM (
            'owner', 'admin', 'operations', 'control_room', 'hr_compliance', 'finance', 'viewer'
          );
        END IF;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_membership_status') THEN
          CREATE TYPE company_membership_status AS ENUM ('active', 'suspended', 'revoked');
        END IF;
      END $$
    `);

    // 2. Create company_memberships table
    // FK: userId ON DELETE RESTRICT — membership must be explicitly removed before user deletion
    // FK: companyId ON DELETE RESTRICT — company cannot be deleted while memberships exist
    // FK: invitedByUserId / disabledByUserId ON DELETE SET NULL — preserve records if actor deleted
    // UNIQUE (userId, companyId) — one row per user/company pair across all lifecycle states
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS company_memberships (
        id                  SERIAL PRIMARY KEY,
        "userId"            INTEGER NOT NULL
                              REFERENCES users(id) ON DELETE RESTRICT,
        "companyId"         INTEGER NOT NULL
                              REFERENCES companies(id) ON DELETE RESTRICT,
        "membershipRole"    company_membership_role NOT NULL,
        status              company_membership_status NOT NULL DEFAULT 'active',
        "invitedByUserId"   INTEGER NULL
                              REFERENCES users(id) ON DELETE SET NULL,
        "acceptedAt"        TIMESTAMP NOT NULL DEFAULT NOW(),
        "disabledAt"        TIMESTAMP NULL,
        "disabledByUserId"  INTEGER NULL
                              REFERENCES users(id) ON DELETE SET NULL,
        "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_cm_user_company UNIQUE ("userId", "companyId")
      )
    `);

    // 3. Partial unique index — at most one ACTIVE membership per user (P1I v1 constraint)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_membership_per_user
        ON company_memberships ("userId")
        WHERE status = 'active'
    `);

    // 4. Index for fast company member listing and owner count
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cm_company_active
        ON company_memberships ("companyId", status)
    `);

    // 5. Create company_invitations table
    // FK: companyId ON DELETE CASCADE — invitations deleted with company (not yet accepted)
    // FK: invitedByUserId ON DELETE RESTRICT — preserve invitation integrity
    // FK: revokedByUserId ON DELETE SET NULL — preserve revocation record
    // tokenDigest: SHA-256(plaintextToken) as 64-char hex — deterministic, never plaintext
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS company_invitations (
        id                        SERIAL PRIMARY KEY,
        "companyId"               INTEGER NOT NULL
                                    REFERENCES companies(id) ON DELETE CASCADE,
        email                     VARCHAR NOT NULL,
        "intendedMembershipRole"  company_membership_role NOT NULL,
        "tokenDigest"             CHAR(64) NOT NULL,
        "expiresAt"               TIMESTAMP NOT NULL,
        "usedAt"                  TIMESTAMP NULL,
        "revokedAt"               TIMESTAMP NULL,
        "revokedByUserId"         INTEGER NULL
                                    REFERENCES users(id) ON DELETE SET NULL,
        "invitedByUserId"         INTEGER NOT NULL
                                    REFERENCES users(id) ON DELETE RESTRICT,
        "createdAt"               TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_invitation_token UNIQUE ("tokenDigest")
      )
    `);

    // 6. Index for pending invitation lookups and duplicate-check by company+email
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_invitation_company_email
        ON company_invitations ("companyId", email)
    `);

    // 7. Owner backfill — create ACTIVE OWNER membership for every existing Company owner
    // Idempotent: ON CONFLICT DO NOTHING handles re-runs and partial prior runs
    await queryRunner.query(`
      INSERT INTO company_memberships
        ("userId", "companyId", "membershipRole", status, "invitedByUserId",
         "acceptedAt", "createdAt", "updatedAt")
      SELECT
        c."userId",
        c.id,
        'owner',
        'active',
        NULL,
        NOW(),
        NOW(),
        NOW()
      FROM companies c
      ON CONFLICT ("userId", "companyId") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS company_invitations`);
    await queryRunner.query(`DROP TABLE IF EXISTS company_memberships`);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_membership_role') THEN
          DROP TYPE company_membership_role;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_membership_status') THEN
          DROP TYPE company_membership_status;
        END IF;
      END $$
    `);
  }
}
