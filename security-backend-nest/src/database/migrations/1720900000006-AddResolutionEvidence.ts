import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddResolutionEvidence1720900000006 implements MigrationInterface {
  name = 'AddResolutionEvidence1720900000006';

  /**
   * Why Control closed a safety alert or an incident, and what they wrote about it.
   *
   * The Open → Acknowledged → Resolved lifecycle itself already existed: both tables carry their own
   * status enum, an acknowledging/reviewing actor and time, and a closing actor and time, and both
   * already write to `audit_logs`. The one thing nowhere to put was the REASON and the NOTE, so a
   * control room could close an item but never record why — and an incident resolution note typed
   * into the existing DTO was accepted by the API and then silently discarded.
   *
   * Four nullable columns, two tables. Nothing else.
   *
   * NOT the existing text columns. `safety_alerts.message` is the alert as it was raised and
   * `incidents.notes` is the guard's own report; both are original evidence, and a resolution written
   * over either would destroy the record it is meant to explain.
   *
   * varchar, not a PostgreSQL enum, deliberately. The reason vocabulary is per record type — welfare,
   * missing Book Off, incident, site request and emergency each have their own small set — so a single
   * database enum would be a ~30-label union that permits an incident to carry a Book-Off-only reason,
   * and every refinement of a list would need an ALTER TYPE, which cannot run inside a transaction
   * block and so fights the gate's `--transaction each`. The allowed set per type is enforced in the
   * application, where the lists have to exist anyway, and the column stores a stable machine value.
   *
   * Every statement is additive, nullable and guarded. No existing row is read, rewritten or
   * backfilled: historical rows simply have NULL in both columns, which reads correctly as "closed
   * before resolution evidence was captured".
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
        ADD COLUMN IF NOT EXISTS "resolutionReason" character varying(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "safety_alerts"
        ADD COLUMN IF NOT EXISTS "resolutionNote" text NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "incidents"
        ADD COLUMN IF NOT EXISTS "resolutionReason" character varying(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "incidents"
        ADD COLUMN IF NOT EXISTS "resolutionNote" text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "incidents" DROP COLUMN IF EXISTS "resolutionNote"`);
    await queryRunner.query(`ALTER TABLE "incidents" DROP COLUMN IF EXISTS "resolutionReason"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "resolutionNote"`);
    await queryRunner.query(`ALTER TABLE "safety_alerts" DROP COLUMN IF EXISTS "resolutionReason"`);
  }
}
