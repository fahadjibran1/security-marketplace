import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRotaSlotIdToShifts1720900000001 implements MigrationInterface {
  name = 'AddRotaSlotIdToShifts1720900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add nullable rotaSlotId FK to shifts.
    // Legacy shifts (rotaSlotId = NULL) remain fully valid — no backfill.
    // ON DELETE SET NULL: if a RotaSlot is cancelled and later physically removed
    // (not the normal path), child Shifts survive with rotaSlotId = null.

    await queryRunner.query(`
      ALTER TABLE "shifts"
        ADD COLUMN IF NOT EXISTS "rotaSlotId" INTEGER NULL
          REFERENCES "rota_slots"("id") ON DELETE SET NULL
    `);

    // Index for RotaSlotService coverage queries: load all positions for a slot.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_shifts_rota_slot_id"
        ON "shifts" ("rotaSlotId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shifts_rota_slot_id"`);
    await queryRunner.query(`
      ALTER TABLE "shifts"
        DROP COLUMN IF EXISTS "rotaSlotId"
    `);
  }
}
