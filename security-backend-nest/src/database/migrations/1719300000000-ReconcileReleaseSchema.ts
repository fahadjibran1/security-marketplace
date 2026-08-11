import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReconcileReleaseSchema1719300000000 implements MigrationInterface {
  name = 'ReconcileReleaseSchema1719300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail before mutating this migration if legacy orphan rows would make the
    // ownership constraints unsafe to apply. We deliberately do not guess a
    // company owner for historical data: production data must be reconciled
    // explicitly before release.
    const [{ count: orphanedClients }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "clients" WHERE "companyId" IS NULL`,
    );
    const [{ count: orphanedPayrollBatches }] = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM "payroll_batches" WHERE "companyId" IS NULL`,
    );

    if (Number(orphanedClients) > 0 || Number(orphanedPayrollBatches) > 0) {
      throw new Error(
        `S4 release migration blocked: orphaned company-owned rows detected ` +
          `(clients=${orphanedClients}, payroll_batches=${orphanedPayrollBatches}). ` +
          `Reconcile these rows to the correct company before retrying the deployment.`,
      );
    }

    await queryRunner.query(`ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'client_admin'`);
    await queryRunner.query(`ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'client_viewer'`);

    await queryRunner.query(`ALTER TABLE "sites" ALTER COLUMN "contactDetails" TYPE text USING "contactDetails"::text`);
    await queryRunner.query(`ALTER TABLE "clients" ALTER COLUMN "contactDetails" TYPE text USING "contactDetails"::text`);

    await queryRunner.query(`ALTER TABLE "job_applications" ALTER COLUMN "status" SET DEFAULT 'applied'`);
    await queryRunner.query(`ALTER TABLE "assignments" ALTER COLUMN "status" SET DEFAULT 'assigned'`);
    await queryRunner.query(`ALTER TABLE "shifts" ALTER COLUMN "status" SET DEFAULT 'unfilled'`);

    // Client and payroll records are company-owned domain records and must never be orphaned.
    await queryRunner.query(`ALTER TABLE "clients" ALTER COLUMN "companyId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "payroll_batches" ALTER COLUMN "companyId" SET NOT NULL`);

    // A shift can exist before a guard is assigned.
    await queryRunner.query(`ALTER TABLE "shifts" ALTER COLUMN "assignmentId" DROP NOT NULL`);

    // Availability may be guard-wide rather than scoped to a single employer.
    await queryRunner.query(`ALTER TABLE "guard_availability_rules" ALTER COLUMN "companyId" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL enum values cannot be safely removed in-place. Downgrade intentionally
    // preserves the client role values while restoring reversible column/default changes.
    await queryRunner.query(`ALTER TABLE "clients" ALTER COLUMN "companyId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "payroll_batches" ALTER COLUMN "companyId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "sites" ALTER COLUMN "contactDetails" TYPE character varying USING "contactDetails"::character varying`);
    await queryRunner.query(`ALTER TABLE "clients" ALTER COLUMN "contactDetails" TYPE character varying USING "contactDetails"::character varying`);
  }
}
