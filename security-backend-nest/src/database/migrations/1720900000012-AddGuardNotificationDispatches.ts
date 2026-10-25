import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 66: Guard shift notifications (in-app notice + OS push).
 *
 * Additive only. Nothing existing is altered or backfilled:
 *   notifications_type_enum         + shift_offered / shift_offer_withdrawn / shift_reacceptance_required /
 *                                     shift_replaced (reserved for the Replace Guard workflow; nothing writes it yet)
 *   guard_notification_dispatches   new table: one row per (Guard user, event) that S4 decided to tell the Guard about,
 *                                   pointing at the in-app notification and holding what the push provider said.
 *                                   UNIQUE ("userId", "eventKey") is what makes repeated and concurrent calls for one
 *                                   event write one notice and send one push at most.
 *
 * Runs in the normal transaction, like Migration 64: the four labels are only appended and nothing in this migration
 * (no default, index predicate or CHECK) uses them, so ALTER TYPE ... ADD VALUE is allowed inside the transaction on
 * PostgreSQL 12+. Every statement is guarded, so a repeated run converges.
 *
 * Backward compatible: code at daced92 ignores the new table and never writes the new labels, so a Render rollback over
 * a migrated database is safe.
 */
export class AddGuardNotificationDispatches1720900000012 implements MigrationInterface {
  name = 'AddGuardNotificationDispatches1720900000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const label of ['shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_replaced']) {
      await queryRunner.query(`ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS '${label}'`);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "guard_notification_dispatches" (
        "id"               SERIAL NOT NULL,
        "userId"           integer NOT NULL,
        "guardId"          integer NOT NULL,
        "companyId"        integer NOT NULL,
        "notificationId"   integer,
        "shiftId"          integer,
        "amendmentId"      integer,
        "type"             character varying(48) NOT NULL,
        "eventKey"         character varying(160) NOT NULL,
        "shiftStartAt"     TIMESTAMP,
        "shiftEndAt"       TIMESTAMP,
        "status"           character varying(24) NOT NULL DEFAULT 'pending',
        "attempts"         integer NOT NULL DEFAULT 0,
        "deviceCount"      integer NOT NULL DEFAULT 0,
        "ticketIds"        jsonb NOT NULL DEFAULT '[]',
        "receiptStatus"    character varying(32),
        "error"            character varying(255),
        "sentAt"           TIMESTAMP WITH TIME ZONE,
        "receiptCheckedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_guard_notification_dispatches" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_guard_notification_dispatches_type" CHECK ("type" IN ('shift_offered', 'shift_offer_withdrawn', 'shift_reacceptance_required', 'shift_replaced', 'shift_amendment_requested', 'shift_amendment_responded', 'shift_amendment_expired')),
        CONSTRAINT "CHK_guard_notification_dispatches_status" CHECK ("status" IN ('pending', 'sending', 'provider_accepted', 'provider_rejected', 'no_device', 'failed', 'skipped_disabled', 'skipped_ended', 'skipped_ineligible')),
        CONSTRAINT "CHK_guard_notification_dispatches_receipt" CHECK ("receiptStatus" IS NULL OR "receiptStatus" IN ('provider_delivery_ok', 'provider_delivery_error'))
      )
    `);

    // A dispatch is a delivery record, not evidence: it goes with its user, Guard or company, and outlives a deleted
    // shift, notification or amendment (the reference is cleared). It never blocks deleting any of them.
    const foreignKeys: Array<[string, string, string, string]> = [
      ['FK_guard_notification_dispatches_user', 'userId', 'users', 'CASCADE'],
      ['FK_guard_notification_dispatches_guard', 'guardId', 'guard_profiles', 'CASCADE'],
      ['FK_guard_notification_dispatches_company', 'companyId', 'companies', 'CASCADE'],
      ['FK_guard_notification_dispatches_notification', 'notificationId', 'notifications', 'SET NULL'],
      ['FK_guard_notification_dispatches_shift', 'shiftId', 'shifts', 'SET NULL'],
      ['FK_guard_notification_dispatches_amendment', 'amendmentId', 'shift_amendments', 'SET NULL'],
    ];
    for (const [name, column, target, onDelete] of foreignKeys) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "guard_notification_dispatches" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
              REFERENCES "${target}"("id") ON DELETE ${onDelete} ON UPDATE NO ACTION;
          END IF;
        END $$
      `);
    }

    // One dispatch per (Guard user, event): concurrent or repeated calls for the same event cannot notify twice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_guard_notification_dispatches_user_event" ON "guard_notification_dispatches" ("userId", "eventKey")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_guard_notification_dispatches_status" ON "guard_notification_dispatches" ("status", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_guard_notification_dispatches_shift" ON "guard_notification_dispatches" ("shiftId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dispatch rows are the record of what S4 pushed to which Guard and what the provider answered. Rolling back would
    // delete them, so it is refused while any exist (as Migration 65 does for Welfare reminders). A code rollback never
    // needs this: older code ignores the table.
    const [{ n }] = await queryRunner.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'guard_notification_dispatches'`,
    );
    if (Number(n) > 0) {
      const [{ rows }] = await queryRunner.query(`SELECT count(*)::int AS rows FROM "guard_notification_dispatches"`);
      if (Number(rows) > 0) {
        throw new Error(
          `Refusing to revert AddGuardNotificationDispatches1720900000012: ${rows} Guard notification dispatch(es) exist. ` +
            'Export them (pg_dump of guard_notification_dispatches) and get explicit approval before removing them.',
        );
      }
    }
    // The four notification labels stay: PostgreSQL cannot drop an enum value, the type is shared with every existing
    // notification, and older code never writes them (as migrations 58, 59, 63 and 64). Notices already written with
    // the new labels are kept.
    await queryRunner.query(`DROP TABLE IF EXISTS "guard_notification_dispatches"`);
  }
}
