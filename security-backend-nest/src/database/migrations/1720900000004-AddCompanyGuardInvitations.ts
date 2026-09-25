import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyGuardInvitations1720900000004 implements MigrationInterface {
  name = 'AddCompanyGuardInvitations1720900000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Company → Guard workforce invitations.
    //
    // Deliberately a separate table from company_invitations: that one invites a STAFF user and its
    // acceptance policy is "one active company membership per user", which is the opposite of what a
    // Guard needs. A Guard may belong to several companies at once.
    //
    // FK: companyId        ON DELETE CASCADE      — an unaccepted invitation dies with its company
    // FK: invitedByUserId  ON DELETE RESTRICT     — preserve who issued it
    // FK: revokedByUserId  ON DELETE SET NULL     — preserve the revocation record
    // tokenDigest: SHA-256(plaintextToken) as 64-char hex. Plaintext is never stored.
    //
    // State is derived from the three terminal timestamps plus expiresAt, exactly as
    // company_invitations does. declinedAt is separate from usedAt so a company cannot mistake a
    // Guard's refusal for a Guard joining its workforce.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS company_guard_invitations (
        id                        SERIAL PRIMARY KEY,
        "companyId"               INTEGER NOT NULL
                                    REFERENCES companies(id) ON DELETE CASCADE,
        "relationshipType"        "company_guards_relationshiptype_enum" NOT NULL
                                    DEFAULT 'APPROVED_CONTRACTOR',
        "targetSiaLicenceNumber"  CHAR(16) NULL,
        "tokenDigest"             CHAR(64) NOT NULL,
        "expiresAt"               TIMESTAMP NOT NULL,
        "usedAt"                  TIMESTAMP NULL,
        "declinedAt"              TIMESTAMP NULL,
        "revokedAt"               TIMESTAMP NULL,
        "revokedByUserId"         INTEGER NULL
                                    REFERENCES users(id) ON DELETE SET NULL,
        "invitedByUserId"         INTEGER NOT NULL
                                    REFERENCES users(id) ON DELETE RESTRICT,
        "createdAt"               TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_cgi_token UNIQUE ("tokenDigest")
      )
    `);

    // Company-scoped listing, newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cgi_company_created
        ON company_guard_invitations ("companyId", "createdAt" DESC)
    `);

    // Consent trail on the relationship itself: when the Guard agreed, and to which invitation.
    // Both nullable — every CompanyGuard row that predates this migration was established by hire or
    // by a direct company link, and must stay valid with these left NULL.
    await queryRunner.query(`
      ALTER TABLE "company_guards"
        ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "company_guards"
        ADD COLUMN IF NOT EXISTS "invitationId" INTEGER NULL
    `);

    // Added separately so a re-run cannot duplicate the constraint.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_company_guards_invitation'
        ) THEN
          ALTER TABLE "company_guards"
            ADD CONSTRAINT fk_company_guards_invitation
            FOREIGN KEY ("invitationId")
            REFERENCES company_guard_invitations(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "company_guards"
        DROP CONSTRAINT IF EXISTS fk_company_guards_invitation
    `);
    await queryRunner.query(`ALTER TABLE "company_guards" DROP COLUMN IF EXISTS "invitationId"`);
    await queryRunner.query(`ALTER TABLE "company_guards" DROP COLUMN IF EXISTS "acceptedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS company_guard_invitations`);
    // company_guards_relationshiptype_enum is shared with company_guards and is left in place.
  }
}
