/**
 * Migration 40→55 Rehearsal Spec
 *
 * Proves that migrations 41-55 (P1A through P1I, then Rota) apply cleanly to a production-shaped
 * database (at migration 40 state), preserving all pre-existing rows and producing the
 * correct post-migration schema.
 *
 * Phase 1: Apply migrations 1-40 to a fresh DB, seed realistic production-shaped data.
 * Phase 2: Apply migrations 41-55 on the same DB (no schema drop).
 * Phase 3: Verify data preservation, owner backfill, schema additions, second-run idempotency.
 *
 * Run: MIGRATION_REHEARSAL_DATABASE_URL=<pg-url> npx ts-node -r tsconfig-paths/register scripts/migration-rehearsal.spec.ts
 * (Falls back to P1I_DATABASE_URL if MIGRATION_REHEARSAL_DATABASE_URL is not set.)
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { DataSource } from 'typeorm';

// ─── Phase 1: Migrations 1-40 ────────────────────────────────────────────────
import { InitialSchema1711040000000 } from '../src/database/migrations/1711040000000-InitialSchema';
import { AddSitesAndTimesheetSubmission1712040000000 } from '../src/database/migrations/1712040000000-AddSitesAndTimesheetSubmission';
import { PhaseOneRolesAndStatuses1713040000000 } from '../src/database/migrations/1713040000000-PhaseOneRolesAndStatuses';
import { PhaseTwoShiftOperationalModel1714040000000 } from '../src/database/migrations/1714040000000-PhaseTwoShiftOperationalModel';
import { PhaseThreeAlertsAndDailyLogs1715040000000 } from '../src/database/migrations/1715040000000-PhaseThreeAlertsAndDailyLogs';
import { PhaseFourTimesheetsAndIncidents1716040000000 } from '../src/database/migrations/1716040000000-PhaseFourTimesheetsAndIncidents';
import { PhaseFiveGovernanceAndNotifications1717040000000 } from '../src/database/migrations/1717040000000-PhaseFiveGovernanceAndNotifications';
import { ActivateMarketplaceGuards1718040000000 } from '../src/database/migrations/1718040000000-ActivateMarketplaceGuards';
import { ClientSitesAndShiftOps1719040000000 } from '../src/database/migrations/1719040000000-ClientSitesAndShiftOps';
import { ClientAndSiteOperationsCleanup1719060000000 } from '../src/database/migrations/1719060000000-ClientAndSiteOperationsCleanup';
import { ShiftPlannerRefactor1719070000000 } from '../src/database/migrations/1719070000000-ShiftPlannerRefactor';
import { AddShiftCloseOutNotes1719080000000 } from '../src/database/migrations/1719080000000-AddShiftCloseOutNotes';
import { AddTimesheetGuardNote1719090000000 } from '../src/database/migrations/1719090000000-AddTimesheetGuardNote';
import { AddTimesheetCompanyNote1719100000000 } from '../src/database/migrations/1719100000000-AddTimesheetCompanyNote';
import { AddTimesheetApprovedHours1719110000000 } from '../src/database/migrations/1719110000000-AddTimesheetApprovedHours';
import { AddReturnedTimesheetStatus1719120000000 } from '../src/database/migrations/1719120000000-AddReturnedTimesheetStatus';
import { NormalizeReturnedTimesheetStatus1719130000000 } from '../src/database/migrations/1719130000000-NormalizeReturnedTimesheetStatus';
import { AddTimesheetPayrollLifecycle1719140000000 } from '../src/database/migrations/1719140000000-AddTimesheetPayrollLifecycle';
import { AddPayrollBatches1719150000000 } from '../src/database/migrations/1719150000000-AddPayrollBatches';
import { AddInvoiceBatches1719160000000 } from '../src/database/migrations/1719160000000-AddInvoiceBatches';
import { AddJobBillingRate1719170000000 } from '../src/database/migrations/1719170000000-AddJobBillingRate';
import { AddContractPricingRules1719180000000 } from '../src/database/migrations/1719180000000-AddContractPricingRules';
import { AddInvoiceDocumentFields1719190000000 } from '../src/database/migrations/1719190000000-AddInvoiceDocumentFields';
import { AddTimesheetFinancialSnapshots1719200000000 } from '../src/database/migrations/1719200000000-AddTimesheetFinancialSnapshots';
import { AddAutomationSettingsAndNotificationTypes1719210000000 } from '../src/database/migrations/1719210000000-AddAutomationSettingsAndNotificationTypes';
import { AddPayRuleConfigAndPayableSnapshots1719220000000 } from '../src/database/migrations/1719220000000-AddPayRuleConfigAndPayableSnapshots';
import { AddComplianceRecords1719230000000 } from '../src/database/migrations/1719230000000-AddComplianceRecords';
import { AddAvailabilityLeaveCoverage1719240000000 } from '../src/database/migrations/1719240000000-AddAvailabilityLeaveCoverage';
import { AddClientPortalUsers1719270000000 } from '../src/database/migrations/1719270000000-AddClientPortalUsers';
import { AddPaymentRecords1719280000000 } from '../src/database/migrations/1719280000000-AddPaymentRecords';
import { AddGuardComplianceDocuments1719290000000 } from '../src/database/migrations/1719290000000-AddGuardComplianceDocuments';
import { ReconcileReleaseSchema1719300000000 } from '../src/database/migrations/1719300000000-ReconcileReleaseSchema';
import { ScopeAvailabilityOverridesByCompany1719400000000 } from '../src/database/migrations/1719400000000-ScopeAvailabilityOverridesByCompany';
import { AddAttendanceVerification1719500000000 } from '../src/database/migrations/1719500000000-AddAttendanceVerification';
import { AddTimesheetVerifiedPayroll1719600000000 } from '../src/database/migrations/1719600000000-AddTimesheetVerifiedPayroll';
import { ScopeGuardDocumentsByCompany1719700000000 } from '../src/database/migrations/1719700000000-ScopeGuardDocumentsByCompany';
import { AddPrivateEvidenceStorage1719800000000 } from '../src/database/migrations/1719800000000-AddPrivateEvidenceStorage';
import { ActivatePendingGuardAccounts1719900000000 } from '../src/database/migrations/1719900000000-ActivatePendingGuardAccounts';
import { AddGuardScreeningWorkflow1720000000000 } from '../src/database/migrations/1720000000000-AddGuardScreeningWorkflow';
import { AddStructuredScreeningAddresses1720100000000 } from '../src/database/migrations/1720100000000-AddStructuredScreeningAddresses';

// ─── Phase 2: Migrations 41-53 ────────────────────────────────────────────────
import { AddGuardPersonnelP1AIdentityFields1720200000000 } from '../src/database/migrations/1720200000000-AddGuardPersonnelP1AIdentityFields';
import { AddGuardDrivingProfileP1D1720300000000 } from '../src/database/migrations/1720300000000-AddGuardDrivingProfileP1D';
import { AddGuardEmergencyContactP1E1720400000000 } from '../src/database/migrations/1720400000000-AddGuardEmergencyContactP1E';
import { AddCompanyGuardEmploymentP1F1720500000000 } from '../src/database/migrations/1720500000000-AddCompanyGuardEmploymentP1F';
import { AddGuardBankDetailsP1GA1720600000000 } from '../src/database/migrations/1720600000000-AddGuardBankDetailsP1GA';
import { AddCompanyGuardPayrollP1GB1720700000000 } from '../src/database/migrations/1720700000000-AddCompanyGuardPayrollP1GB';
import { RemovePayrollPaymentMethod1720700000001 } from '../src/database/migrations/1720700000001-RemovePayrollPaymentMethod';
import { AddSiteTimezone1720800000000 } from '../src/database/migrations/1720800000000-AddSiteTimezone';
import { AddClientBilledHoursSnapshot1720800000001 } from '../src/database/migrations/1720800000001-AddClientBilledHoursSnapshot';
import { CreateClientWeeklyApprovalTables1720800000002 } from '../src/database/migrations/1720800000002-CreateClientWeeklyApprovalTables';
import { AddCompanyApprovedTimes1720800000003 } from '../src/database/migrations/1720800000003-AddCompanyApprovedTimes';
import { AddClientBillingApprovalFields1720800000004 } from '../src/database/migrations/1720800000004-AddClientBillingApprovalFields';
import { AddCompanyMembershipAndInvitations1720800000005 } from '../src/database/migrations/1720800000005-AddCompanyMembershipAndInvitations';
import { AddRotaSlotTable1720900000000 } from '../src/database/migrations/1720900000000-AddRotaSlotTable';
import { AddRotaSlotIdToShifts1720900000001 } from '../src/database/migrations/1720900000001-AddRotaSlotIdToShifts';

// ─── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    const msg = `FAIL  ${label}${detail ? ': ' + detail : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

// ─── Migration lists ──────────────────────────────────────────────────────────

const migrations40 = [
  InitialSchema1711040000000,
  AddSitesAndTimesheetSubmission1712040000000,
  PhaseOneRolesAndStatuses1713040000000,
  PhaseTwoShiftOperationalModel1714040000000,
  PhaseThreeAlertsAndDailyLogs1715040000000,
  PhaseFourTimesheetsAndIncidents1716040000000,
  PhaseFiveGovernanceAndNotifications1717040000000,
  ActivateMarketplaceGuards1718040000000,
  ClientSitesAndShiftOps1719040000000,
  ClientAndSiteOperationsCleanup1719060000000,
  ShiftPlannerRefactor1719070000000,
  AddShiftCloseOutNotes1719080000000,
  AddTimesheetGuardNote1719090000000,
  AddTimesheetCompanyNote1719100000000,
  AddTimesheetApprovedHours1719110000000,
  AddReturnedTimesheetStatus1719120000000,
  NormalizeReturnedTimesheetStatus1719130000000,
  AddTimesheetPayrollLifecycle1719140000000,
  AddPayrollBatches1719150000000,
  AddInvoiceBatches1719160000000,
  AddJobBillingRate1719170000000,
  AddContractPricingRules1719180000000,
  AddInvoiceDocumentFields1719190000000,
  AddTimesheetFinancialSnapshots1719200000000,
  AddAutomationSettingsAndNotificationTypes1719210000000,
  AddPayRuleConfigAndPayableSnapshots1719220000000,
  AddComplianceRecords1719230000000,
  AddAvailabilityLeaveCoverage1719240000000,
  AddClientPortalUsers1719270000000,
  AddPaymentRecords1719280000000,
  AddGuardComplianceDocuments1719290000000,
  ReconcileReleaseSchema1719300000000,
  ScopeAvailabilityOverridesByCompany1719400000000,
  AddAttendanceVerification1719500000000,
  AddTimesheetVerifiedPayroll1719600000000,
  ScopeGuardDocumentsByCompany1719700000000,
  AddPrivateEvidenceStorage1719800000000,
  ActivatePendingGuardAccounts1719900000000,
  AddGuardScreeningWorkflow1720000000000,
  AddStructuredScreeningAddresses1720100000000,
];

const migrations53 = [
  ...migrations40,
  AddGuardPersonnelP1AIdentityFields1720200000000,
  AddGuardDrivingProfileP1D1720300000000,
  AddGuardEmergencyContactP1E1720400000000,
  AddCompanyGuardEmploymentP1F1720500000000,
  AddGuardBankDetailsP1GA1720600000000,
  AddCompanyGuardPayrollP1GB1720700000000,
  RemovePayrollPaymentMethod1720700000001,
  AddSiteTimezone1720800000000,
  AddClientBilledHoursSnapshot1720800000001,
  CreateClientWeeklyApprovalTables1720800000002,
  AddCompanyApprovedTimes1720800000003,
  AddClientBillingApprovalFields1720800000004,
  AddCompanyMembershipAndInvitations1720800000005,
  AddRotaSlotTable1720900000000,
  AddRotaSlotIdToShifts1720900000001,
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url =
    process.env.MIGRATION_REHEARSAL_DATABASE_URL ??
    process.env.P1I_DATABASE_URL;
  if (!url) {
    throw new Error(
      'MIGRATION_REHEARSAL_DATABASE_URL or P1I_DATABASE_URL env var is required',
    );
  }

  console.log('\n══ MIGRATION 40→55 REHEARSAL ════════════════════════════════════════════\n');

  // ── Phase 1: Build migration-40 state ────────────────────────────────────────
  console.log('── Phase 1: Apply migrations 1-40 ──────────────────────────────────────');

  const ds1 = new DataSource({
    type: 'postgres',
    url,
    entities: [],
    migrations: migrations40,
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    dropSchema: true,
    logging: false,
  });

  await ds1.initialize();

  const applied1 = await ds1.runMigrations({ transaction: 'each' });
  check(
    'PHASE1-MIGRATIONS-COUNT: 40 migrations applied',
    applied1.length === 40,
    `applied ${applied1.length}/40`,
  );

  // Verify typeorm_migrations table has exactly 40 rows
  const [{ count: count1 }] = await ds1.query(
    `SELECT COUNT(*)::int AS count FROM typeorm_migrations`,
  );
  check(
    'PHASE1-MIGRATIONS-RECORDED: exactly 40 rows in typeorm_migrations',
    count1 === 40,
    `found ${count1}`,
  );

  // ── Phase 1: Seed realistic production-shaped data ────────────────────────
  // Seeding uses raw SQL matched to migration-40 schema (inspected via \d <table>).
  // companies has no createdAt/updatedAt; guard_profiles has no companyId.
  console.log('\n── Phase 1: Seed production-shaped data ────────────────────────────────');

  // Company owner (legacy COMPANY role — what production will have)
  await ds1.query(`
    INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified")
    VALUES ('pilot-owner@rehearsal.test', 'bcrypt_hash_x', 'company', 'active', true)
  `);
  const [{ id: ownerId }] = await ds1.query(
    `SELECT id FROM users WHERE email = 'pilot-owner@rehearsal.test'`,
  );

  // Second company owner (COMPANY_ADMIN role — also gets backfilled)
  await ds1.query(`
    INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified")
    VALUES ('pilot-admin@rehearsal.test', 'bcrypt_hash_y', 'company_admin', 'active', true)
  `);
  const [{ id: adminOwnerId }] = await ds1.query(
    `SELECT id FROM users WHERE email = 'pilot-admin@rehearsal.test'`,
  );

  // Company A (owned by COMPANY role user; status enum is 'active' in production)
  await ds1.query(`
    INSERT INTO companies (name, "companyNumber", address, "contactDetails", status, "userId")
    VALUES ('Pilot Security Ltd', 'PSL-001', '1 Pilot St, London', 'info@pilotguard.test', 'active', $1)
  `, [ownerId]);
  const [{ id: companyId }] = await ds1.query(
    `SELECT id FROM companies WHERE name = 'Pilot Security Ltd'`,
  );

  // Company B (owned by COMPANY_ADMIN role user)
  await ds1.query(`
    INSERT INTO companies (name, "companyNumber", address, "contactDetails", status, "userId")
    VALUES ('Admin Guard Co', 'AGC-002', '2 Admin St, Manchester', 'info@adminguard.test', 'active', $1)
  `, [adminOwnerId]);
  const [{ id: company2Id }] = await ds1.query(
    `SELECT id FROM companies WHERE name = 'Admin Guard Co'`,
  );

  // Guard user
  await ds1.query(`
    INSERT INTO users (email, "passwordHash", role, status, "isEmailVerified")
    VALUES ('guard-alpha@rehearsal.test', 'bcrypt_hash_z', 'guard', 'active', true)
  `);
  const [{ id: guardUserId }] = await ds1.query(
    `SELECT id FROM users WHERE email = 'guard-alpha@rehearsal.test'`,
  );

  // Guard profile (no companyId at migration 40; fullName/phone/siaLicenseNumber required)
  await ds1.query(`
    INSERT INTO guard_profiles ("userId", "fullName", "siaLicenseNumber", "phone")
    VALUES ($1, 'Alpha Guard', 'SIA-REHEARS-001', '07700000001')
  `, [guardUserId]);
  const [{ id: guardProfileId }] = await ds1.query(
    `SELECT id FROM guard_profiles WHERE "userId" = $1`, [guardUserId],
  );

  // Client (createdAt/updatedAt have defaults)
  await ds1.query(`
    INSERT INTO clients (name, status, "companyId")
    VALUES ('Rehearsal Bank Plc', 'active', $1)
  `, [companyId]);
  const [{ id: clientId }] = await ds1.query(
    `SELECT id FROM clients WHERE "companyId" = $1`, [companyId],
  );

  // Site (no createdAt/updatedAt in migration-40 sites table)
  await ds1.query(`
    INSERT INTO sites (name, address, "clientId", "companyId")
    VALUES ('Main Branch', '100 High St, London', $1, $2)
  `, [clientId, companyId]);
  const [{ id: siteId }] = await ds1.query(
    `SELECT id FROM sites WHERE "clientId" = $1`, [clientId],
  );

  // Shift: guardId references guard_profiles.id (NOT users.id); uses start/end columns
  await ds1.query(`
    INSERT INTO shifts ("siteName", "siteId", "companyId", "guardId", "start", "end", status)
    VALUES ('Main Branch', $1, $2, $3,
      '2026-08-25T08:00:00Z', '2026-08-25T16:00:00Z', 'completed')
  `, [siteId, companyId, guardProfileId]);
  const [{ id: shiftId }] = await ds1.query(
    `SELECT id FROM shifts WHERE "siteId" = $1`, [siteId],
  );

  // Timesheet (guardId FK → guard_profiles.id, NOT users.id)
  // hoursWorked/approvalStatus required; approvedHours nullable
  await ds1.query(`
    INSERT INTO timesheets ("guardId", "companyId", "shiftId", "hoursWorked", "approvedHours", "approvalStatus")
    VALUES ($1, $2, $3, 8.0, 7.5, 'approved')
  `, [guardProfileId, companyId, shiftId]);
  const [{ id: timesheetId }] = await ds1.query(
    `SELECT id FROM timesheets WHERE "shiftId" = $1`, [shiftId],
  );

  // Screening record (guard_screenings.guardId FK → guard_profiles.id)
  await ds1.query(`
    INSERT INTO guard_screenings ("guardId", status)
    VALUES ($1, 'NOT_STARTED')
  `, [guardProfileId]);

  // Verify seed
  const [{ count: uCount }] = await ds1.query(
    `SELECT COUNT(*)::int AS count FROM users WHERE email LIKE '%rehearsal.test'`,
  );
  const [{ count: cCount }] = await ds1.query(
    `SELECT COUNT(*)::int AS count FROM companies WHERE name IN ('Pilot Security Ltd', 'Admin Guard Co')`,
  );
  const [{ count: tCount }] = await ds1.query(
    `SELECT COUNT(*)::int AS count FROM timesheets WHERE id = $1`, [timesheetId],
  );

  check('SEED-1: 3 rehearsal users seeded (owner, admin-owner, guard)', uCount === 3, `found ${uCount}`);
  check('SEED-2: 2 rehearsal companies seeded', cCount === 2, `found ${cCount}`);
  check('SEED-3: timesheet seeded', tCount === 1, `found ${tCount}`);

  await ds1.destroy();

  // ── Phase 2: Apply migrations 41-55 ──────────────────────────────────────────
  console.log('\n── Phase 2: Apply migrations 41-53 ─────────────────────────────────────');

  const ds2 = new DataSource({
    type: 'postgres',
    url,
    entities: [],
    migrations: migrations53,
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    dropSchema: false,
    logging: false,
  });

  await ds2.initialize();

  const applied2 = await ds2.runMigrations({ transaction: 'each' });
  check(
    'PHASE2-MIGRATIONS-COUNT: 15 new migrations applied (41-55)',
    applied2.length === 15,
    `applied ${applied2.length}/15`,
  );

  // ── Phase 3: Verification ─────────────────────────────────────────────────────
  console.log('\n── Phase 3: Verification ────────────────────────────────────────────────');

  // Total migration record count
  const [{ count: totalMig }] = await ds2.query(
    `SELECT COUNT(*)::int AS count FROM typeorm_migrations`,
  );
  check(
    'VERIFY-MIGRATIONS-TOTAL: 55/55 migrations recorded',
    totalMig === 55,
    `found ${totalMig}`,
  );

  // Data preservation: company still exists
  const [{ count: companiesAfter }] = await ds2.query(
    `SELECT COUNT(*)::int AS count FROM companies WHERE name = 'Pilot Security Ltd'`,
  );
  check('VERIFY-PRESERVATION-1: Company row preserved', companiesAfter === 1, `found ${companiesAfter}`);

  // Data preservation: guard profile still exists
  const [{ count: gpAfter }] = await ds2.query(
    `SELECT COUNT(*)::int AS count FROM guard_profiles WHERE id = $1`, [guardProfileId],
  );
  check('VERIFY-PRESERVATION-2: GuardProfile row preserved', gpAfter === 1, `found ${gpAfter}`);

  // Data preservation: timesheet still exists with original values
  const tsRows = await ds2.query(
    `SELECT "hoursWorked", "approvedHours", "approvalStatus" FROM timesheets WHERE id = $1`, [timesheetId],
  );
  check('VERIFY-PRESERVATION-3: Timesheet row preserved', tsRows.length === 1, `found ${tsRows.length}`);
  if (tsRows.length === 1) {
    check(
      'VERIFY-PRESERVATION-3A: Timesheet hoursWorked=8.0 unchanged',
      Math.abs(parseFloat(tsRows[0].hoursWorked) - 8.0) < 0.001,
      `hoursWorked=${tsRows[0].hoursWorked}`,
    );
    check(
      'VERIFY-PRESERVATION-3B: Timesheet approvedHours=7.5 unchanged',
      Math.abs(parseFloat(tsRows[0].approvedHours) - 7.5) < 0.001,
      `approvedHours=${tsRows[0].approvedHours}`,
    );
    check(
      'VERIFY-PRESERVATION-3C: Timesheet approvalStatus=approved unchanged',
      tsRows[0].approvalStatus === 'approved',
      `approvalStatus=${tsRows[0].approvalStatus}`,
    );
  }

  // Migration 47: payrollPaymentMethod column removed from company_guard_payroll_records
  const pmColRows = await ds2.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'company_guard_payroll_records' AND column_name = 'payrollPaymentMethod'
  `);
  check(
    'VERIFY-MIGRATION47: payrollPaymentMethod column removed',
    pmColRows.length === 0,
    `column still present`,
  );

  // Migration 48: site_timezone column added
  const tzColRows = await ds2.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'sites' AND column_name = 'timezone'
  `);
  check(
    'VERIFY-MIGRATION48: timezone column added to sites',
    tzColRows.length === 1,
    `column not found`,
  );

  // Migration 49: clientBilledHoursSnapshot added to timesheets
  const cbhsColRows = await ds2.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'timesheets' AND column_name = 'clientBilledHoursSnapshot'
  `);
  check(
    'VERIFY-MIGRATION49: clientBilledHoursSnapshot column added to timesheets',
    cbhsColRows.length === 1,
    `column not found`,
  );

  // Migration 50: CWA tables created
  const cwaTableRows = await ds2.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('client_weekly_approval_requests', 'client_weekly_approval_lines', 'client_shift_disputes')
      AND table_schema = 'public'
  `);
  check(
    'VERIFY-MIGRATION50: 3 CWA tables created',
    cwaTableRows.length === 3,
    `found ${cwaTableRows.length}/3: ${cwaTableRows.map((r: any) => r.table_name).join(', ')}`,
  );

  // Migration 51: approvedMinutes column added to timesheets
  const amColRows = await ds2.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'timesheets' AND column_name = 'approvedMinutes'
  `);
  check(
    'VERIFY-MIGRATION51: approvedMinutes column added to timesheets',
    amColRows.length === 1,
    `column not found`,
  );

  // Migration 52: clientBillingApprovedMinutes added to timesheets
  const cbamColRows = await ds2.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'timesheets' AND column_name = 'clientBillingApprovedMinutes'
  `);
  check(
    'VERIFY-MIGRATION52: clientBillingApprovedMinutes column added to timesheets',
    cbamColRows.length === 1,
    `column not found`,
  );

  // Migration 53: company_memberships table exists
  const cmTableRows = await ds2.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'company_memberships' AND table_schema = 'public'
  `);
  check(
    'VERIFY-MIGRATION53-TABLE: company_memberships table created',
    cmTableRows.length === 1,
    `table not found`,
  );

  // Migration 53: company_invitations table exists
  const ciTableRows = await ds2.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'company_invitations' AND table_schema = 'public'
  `);
  check(
    'VERIFY-MIGRATION53-INVITATIONS: company_invitations table created',
    ciTableRows.length === 1,
    `table not found`,
  );

  // Migrations 54-55: Rota tables/columns are additive; existing Shifts stay valid with no Rota slot.
  const rotaTableRows = await ds2.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'rota_slots' AND table_schema = 'public'
  `);
  check('VERIFY-MIGRATION54-TABLE: rota_slots table created', rotaTableRows.length === 1, 'table not found');
  const rotaColRows = await ds2.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'shifts' AND column_name = 'rotaSlotId' AND table_schema = 'public'
  `);
  check(
    'VERIFY-MIGRATION55-COLUMN: shifts.rotaSlotId added and nullable (legacy Shifts unaffected)',
    rotaColRows.length === 1 && rotaColRows[0].is_nullable === 'YES',
    JSON.stringify(rotaColRows),
  );
  const [{ count: legacyWithSlot }] = await ds2.query(`SELECT COUNT(*)::int AS count FROM shifts WHERE "rotaSlotId" IS NOT NULL`);
  check('VERIFY-MIGRATION55-LEGACY: existing Shifts have no Rota slot', legacyWithSlot === 0, `found ${legacyWithSlot}`);

  // ── Owner backfill verification ───────────────────────────────────────────────
  console.log('\n── Owner backfill verification ──────────────────────────────────────────');

  // Company A (userId=ownerId, role=company): should have exactly 1 ACTIVE OWNER membership
  const ownerMemberships = await ds2.query(`
    SELECT id, "membershipRole", status
    FROM company_memberships
    WHERE "companyId" = $1
  `, [companyId]);
  check(
    'BACKFILL-1: Company A has exactly 1 membership row',
    ownerMemberships.length === 1,
    `found ${ownerMemberships.length}`,
  );
  if (ownerMemberships.length === 1) {
    check(
      'BACKFILL-1A: Company A membership role = owner',
      ownerMemberships[0].membershipRole === 'owner',
      `got ${ownerMemberships[0].membershipRole}`,
    );
    check(
      'BACKFILL-1B: Company A membership status = active',
      ownerMemberships[0].status === 'active',
      `got ${ownerMemberships[0].status}`,
    );
    // userId in membership must match the company owner
    const [cm1] = await ds2.query(
      `SELECT "userId" FROM company_memberships WHERE "companyId" = $1`, [companyId],
    );
    check(
      'BACKFILL-1C: Company A membership userId matches company owner',
      cm1.userId === ownerId,
      `expected ${ownerId}, got ${cm1.userId}`,
    );
  }

  // Company B (userId=adminOwnerId, role=company_admin): also backfilled
  const adminMemberships = await ds2.query(`
    SELECT id, "membershipRole", status
    FROM company_memberships
    WHERE "companyId" = $1
  `, [company2Id]);
  check(
    'BACKFILL-2: Company B (company_admin owner) has exactly 1 membership row',
    adminMemberships.length === 1,
    `found ${adminMemberships.length}`,
  );
  if (adminMemberships.length === 1) {
    check(
      'BACKFILL-2A: Company B membership role = owner',
      adminMemberships[0].membershipRole === 'owner',
      `got ${adminMemberships[0].membershipRole}`,
    );
    check(
      'BACKFILL-2B: Company B membership status = active',
      adminMemberships[0].status === 'active',
      `got ${adminMemberships[0].status}`,
    );
  }

  // No duplicate memberships
  const dupRows = await ds2.query(`
    SELECT "userId", "companyId", COUNT(*)::int AS cnt
    FROM company_memberships
    GROUP BY "userId", "companyId"
    HAVING COUNT(*) > 1
  `);
  check(
    'BACKFILL-3: No duplicate userId+companyId membership rows',
    dupRows.length === 0,
    `found ${dupRows.length} duplicate pairs`,
  );

  // ── Second-run idempotency ─────────────────────────────────────────────────────
  console.log('\n── Second-run idempotency ───────────────────────────────────────────────');

  const applied3 = await ds2.runMigrations({ transaction: 'each' });
  check(
    'IDEMPOTENCY-1: Second migration:run applies 0 pending migrations',
    applied3.length === 0,
    `applied ${applied3.length} unexpectedly`,
  );

  const [{ count: finalCount }] = await ds2.query(
    `SELECT COUNT(*)::int AS count FROM typeorm_migrations`,
  );
  check(
    'IDEMPOTENCY-2: typeorm_migrations still shows 55 rows after second run',
    finalCount === 55,
    `found ${finalCount}`,
  );

  await ds2.destroy();

  // ── Final summary ─────────────────────────────────────────────────────────────
  console.log(`\n══ MIGRATION REHEARSAL: ${pass} PASS / ${fail} FAIL ══`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(` ✗ ${f}`);
  }

  assert.equal(fail, 0, `${fail} test(s) failed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
