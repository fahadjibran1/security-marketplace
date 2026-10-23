import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 65: Welfare Check push reminders.
 *
 * Additive only. Nothing existing is altered or backfilled:
 *   push_devices        new table: one row per app installation's Expo push token, for the signed-in user
 *   welfare_reminders   new table: one row per reminder decided for a shift's Welfare window (window open / follow-up),
 *                       with what the push provider said about it. UNIQUE (shiftId, windowIndex, kind) is what makes
 *                       repeated and concurrent reminder runs send each reminder at most once.
 *
 * A reminder is never a Welfare Check: completion is still only a welfare_check daily log, graded by the window engine
 * exactly as before. Status words describe the push provider's answer, never delivery to or reading on a phone.
 *
 * Runs in the normal transaction; every statement is guarded, so a repeated run converges. Backward compatible: code
 * at e539b89 ignores both tables, so a Render rollback over a migrated database is safe.
 */
export class AddWelfarePushReminders1720900000011 implements MigrationInterface {
  name = 'AddWelfarePushReminders1720900000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "push_devices" (
        "id"            SERIAL NOT NULL,
        "userId"        integer NOT NULL,
        "token"         character varying(255) NOT NULL,
        "platform"      character varying(16) NOT NULL,
        "appVersion"    character varying(32),
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastSeenAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revokedAt"     TIMESTAMP WITH TIME ZONE,
        "revokedReason" character varying(64),
        CONSTRAINT "PK_push_devices" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_push_devices_platform" CHECK ("platform" IN ('ios', 'android'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "welfare_reminders" (
        "id"               SERIAL NOT NULL,
        "shiftId"          integer NOT NULL,
        "companyId"        integer NOT NULL,
        "guardId"          integer NOT NULL,
        "windowIndex"      integer NOT NULL,
        "kind"             character varying(16) NOT NULL,
        "windowStart"      TIMESTAMP NOT NULL,
        "windowEnd"        TIMESTAMP NOT NULL,
        "status"           character varying(24) NOT NULL,
        "attempts"         integer NOT NULL DEFAULT 0,
        "deviceCount"      integer NOT NULL DEFAULT 0,
        "ticketIds"        jsonb NOT NULL DEFAULT '[]',
        "receiptStatus"    character varying(32),
        "error"            character varying(255),
        "sentAt"           TIMESTAMP WITH TIME ZONE,
        "receiptCheckedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_welfare_reminders" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_welfare_reminders_kind" CHECK ("kind" IN ('window_open', 'follow_up')),
        CONSTRAINT "CHK_welfare_reminders_status" CHECK ("status" IN ('sending', 'provider_accepted', 'provider_rejected', 'no_device', 'failed')),
        CONSTRAINT "CHK_welfare_reminders_receipt" CHECK ("receiptStatus" IS NULL OR "receiptStatus" IN ('provider_delivery_ok', 'provider_delivery_error'))
      )
    `);

    const foreignKeys: Array<[string, string, string, string, string]> = [
      ['FK_push_devices_user', 'push_devices', 'userId', 'users', 'CASCADE'],
      ['FK_welfare_reminders_shift', 'welfare_reminders', 'shiftId', 'shifts', 'RESTRICT'],
      ['FK_welfare_reminders_company', 'welfare_reminders', 'companyId', 'companies', 'RESTRICT'],
      ['FK_welfare_reminders_guard', 'welfare_reminders', 'guardId', 'guard_profiles', 'RESTRICT'],
    ];
    for (const [name, table, column, target, onDelete] of foreignKeys) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
              REFERENCES "${target}"("id") ON DELETE ${onDelete} ON UPDATE NO ACTION;
          END IF;
        END $$
      `);
    }

    // A token belongs to one installation; re-registering it under another account moves it (never duplicates it).
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_devices_token" ON "push_devices" ("token")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_push_devices_user" ON "push_devices" ("userId")`);
    // At most one reminder of each kind per Welfare window: concurrent or repeated runs cannot send twice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_welfare_reminders_window_kind" ON "welfare_reminders" ("shiftId", "windowIndex", "kind")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_welfare_reminders_company_shift" ON "welfare_reminders" ("companyId", "shiftId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reminder rows are operational evidence (what was sent, when, and what the provider said). Rolling back would
    // delete them, so it is refused while any exist. Device tokens are not evidence; they go with their table.
    const [{ n }] = await queryRunner.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'welfare_reminders'`,
    );
    if (Number(n) > 0) {
      const [{ rows }] = await queryRunner.query(`SELECT count(*)::int AS rows FROM "welfare_reminders"`);
      if (Number(rows) > 0) {
        throw new Error(
          `Refusing to revert AddWelfarePushReminders1720900000011: ${rows} Welfare reminder(s) exist. ` +
            'Export them (pg_dump of welfare_reminders) and get explicit approval before removing them.',
        );
      }
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "welfare_reminders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "push_devices"`);
  }
}
