import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 63: compliance lapse alerts on the existing safety_alerts table.
 *
 * A Guard's mandatory company SIA or Right to Work check can expire, be recorded as not confirmed, or be
 * missing while they are on an in-progress shift. The backend sweep raises one critical alert for it,
 * shown in the company's existing Attention / Live Operations workflow and acknowledged / closed through
 * the existing alert lifecycle (with its audit history). It never touches the shift.
 *
 * What it adds:
 *   safety_alerts_type_enum   + 'compliance_lapse' (appended)
 *   safety_alerts             + "complianceCategory" varchar(32) NULL   'sia' | 'right_to_work'
 *                             + "complianceReason"   varchar(32) NULL   'expired' | 'not_confirmed' | 'missing'
 *                             + "lapseKey"           varchar(120) NULL  internal deduplication key
 *   uq_safety_alerts_compliance_lapse_active  UNIQUE (companyId, shiftId, complianceCategory)
 *                                             WHERE type = 'compliance_lapse' AND status IN (open, acknowledged)
 *   uq_safety_alerts_compliance_lapse_key     UNIQUE (shiftId, complianceCategory, lapseKey)
 *                                             WHERE type = 'compliance_lapse'
 *
 * Every existing row keeps its values: the columns are nullable with no default and nothing is backfilled.
 *
 * Runs outside a transaction, exactly as migration 59 (AddWelfareWindowEvidence) does and for the same
 * reason: the index predicates use the new enum label, which PostgreSQL refuses to use in the
 * transaction that added it, and an enum-to-text cast is not allowed in an index predicate. Every
 * statement is guarded, so a partial run converges when repeated.
 */
export class AddComplianceLapseAlerts1720900000009 implements MigrationInterface {
  name = 'AddComplianceLapseAlerts1720900000009';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."safety_alerts_type_enum" ADD VALUE IF NOT EXISTS 'compliance_lapse'`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" ADD COLUMN IF NOT EXISTS "complianceCategory" character varying(32)`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" ADD COLUMN IF NOT EXISTS "complianceReason" character varying(32)`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" ADD COLUMN IF NOT EXISTS "lapseKey" character varying(120)`);
    // The ALTER TYPE above has already committed (see the class note), so the predicates may use the label.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_compliance_lapse_active"
        ON "safety_alerts" ("companyId", "shiftId", "complianceCategory")
        WHERE "type" = 'compliance_lapse' AND "status" IN ('open', 'acknowledged')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_safety_alerts_compliance_lapse_key"
        ON "safety_alerts" ("shiftId", "complianceCategory", "lapseKey")
        WHERE "type" = 'compliance_lapse'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Compliance lapse alerts are operational and legal evidence. Rolling back would strip their
    // category, reason and key, so it is refused while any exist: export them and decide first.
    const [{ n }] = await queryRunner.query(`SELECT count(*)::int AS n FROM "safety_alerts" WHERE "type"::text = 'compliance_lapse'`);
    if (Number(n) > 0) {
      throw new Error(
        `Refusing to revert AddComplianceLapseAlerts1720900000009: ${n} compliance lapse alert(s) exist. ` +
          'Export them (pg_dump of safety_alerts and audit_logs) and get explicit approval before removing them.',
      );
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_safety_alerts_compliance_lapse_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_safety_alerts_compliance_lapse_active"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "lapseKey"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "complianceReason"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "complianceCategory"`);
    // The 'compliance_lapse' enum label is left in place: PostgreSQL cannot drop an enum value, and the
    // type is shared with every existing alert. This matches migrations 58 and 59. No row carries it.
  }
}
