import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAttendanceVerification1719500000000 implements MigrationInterface {
  name = 'AddAttendanceVerification1719500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "latitude" double precision`);
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "longitude" double precision`);
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "geofenceRadiusMeters" integer NOT NULL DEFAULT 150`);
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "requireGpsCheckIn" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "attendanceNfcTag" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "sites" ADD COLUMN "requireNfcCheckIn" boolean NOT NULL DEFAULT false`);

    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "nfcVerified" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "latitude" double precision`);
    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "longitude" double precision`);
    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "gpsAccuracyMeters" double precision`);
    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "distanceFromSiteMeters" double precision`);
    await queryRunner.query(`ALTER TABLE "attendance_events" ADD COLUMN "gpsVerified" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "gpsVerified"`);
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "distanceFromSiteMeters"`);
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "gpsAccuracyMeters"`);
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "longitude"`);
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "latitude"`);
    await queryRunner.query(`ALTER TABLE "attendance_events" DROP COLUMN "nfcVerified"`);

    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "requireNfcCheckIn"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "attendanceNfcTag"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "requireGpsCheckIn"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "geofenceRadiusMeters"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "longitude"`);
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN "latitude"`);
  }
}
