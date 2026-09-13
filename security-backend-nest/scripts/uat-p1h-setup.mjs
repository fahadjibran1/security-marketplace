// P1H Staging Setup — idempotent
// Creates: company_staff user, client, client_portal_users, site, shifts, timesheets
// Safe: checks existing data before insert, rollback on error
import pg from '../node_modules/pg/lib/index.js';
import bcrypt from '../node_modules/bcrypt/bcrypt.js';
const { Client } = pg;

const STAGING_DB = process.env.DATABASE_URL;
if (!STAGING_DB) { console.error('ABORT: DATABASE_URL not set'); process.exit(1); }
const _n = new URL(STAGING_DB).pathname.replace(/^\//, '');
if (_n !== 'security_marketplace_staging') { console.error(`ABORT: wrong DB "${_n}"`); process.exit(1); }

const db = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await db.connect();
if (db.host && !db.host.includes('render.com')) { console.error('ABORT: not render.com'); process.exit(1); }
console.log(`TARGET: ${db.database} @ ${db.host} — CONFIRMED STAGING`);

const COMPANY_ID = 6;  // P1GB Company A Ltd
const GUARD_9_ID = 9;  // company_guards id=8 → guardId=9
const GUARD_10_ID = 10; // company_guards id=9 → guardId=10
const BASE = 'https://security-marketplace-api-staging.onrender.com';

try {
  await db.query('BEGIN');

  // ── Company staff user (for RBAC Section C) ───────────────────────────────
  // Check company_staff association mechanism
  const compCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='companies'`
  )).rows.map(r => r.column_name);
  console.log('COMPANIES_COLS:', compCols.join(', '));

  // Check if there's a company_staff_members or company_users table
  const allTables = (await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'company%'`
  )).rows.map(r => r.table_name);
  console.log('COMPANY_TABLES:', allTables.join(', '));

  // Create company_staff user — association discovered at runtime
  const staffHash = await bcrypt.hash('P1H_CoStaff!2026', 10);
  const staffUser = await db.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ('p1h-co-staff@staging.test',$1,'company_staff','active',true,'P1H','CoStaff')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    [staffHash]
  );
  const staffUserId = staffUser.rows[0].id;
  console.log(`COMPANY_STAFF_USER: id=${staffUserId} p1h-co-staff@staging.test`);

  // Check if companies has any extra columns for staff association
  const companyRow = await db.query(`SELECT * FROM companies WHERE id=$1`, [COMPANY_ID]);
  console.log('COMPANY_6:', JSON.stringify(companyRow.rows[0]));

  // ── Client ────────────────────────────────────────────────────────────────
  const existClient = await db.query(`SELECT id FROM clients WHERE name='P1H Client Portal Ltd' AND "companyId"=$1`, [COMPANY_ID]);
  let clientId;
  if (existClient.rows.length > 0) {
    clientId = existClient.rows[0].id;
    console.log(`CLIENT: existing id=${clientId}`);
  } else {
    const cl = await db.query(
      `INSERT INTO clients (name,"contactName","contactEmail","contactPhone","contactDetails",status,"companyId")
       VALUES ('P1H Client Portal Ltd','P1H Contact','p1h-client@p1h.test','+441234567900','P1H client contact','active',$1)
       RETURNING id`,
      [COMPANY_ID]
    );
    clientId = cl.rows[0].id;
    console.log(`CLIENT: created id=${clientId}`);
  }

  // ── Client portal users ──────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('P1H_CAdmin!2026', 10);
  const viewerHash = await bcrypt.hash('P1H_CViewer!2026', 10);

  const cpAdmin = await db.query(
    `INSERT INTO client_portal_users (email,"passwordHash","firstName","lastName","isActive",role,"clientId")
     VALUES ('p1h-client-admin@staging.test',$1,'P1H','ClientAdmin',true,'client_admin',$2)
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash","isActive"=true,"clientId"=$2
     RETURNING id`,
    [adminHash, clientId]
  );
  const clientAdminId = cpAdmin.rows[0].id;
  console.log(`CLIENT_ADMIN: id=${clientAdminId} p1h-client-admin@staging.test`);

  const cpViewer = await db.query(
    `INSERT INTO client_portal_users (email,"passwordHash","firstName","lastName","isActive",role,"clientId")
     VALUES ('p1h-client-viewer@staging.test',$1,'P1H','ClientViewer',true,'client_viewer',$2)
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash","isActive"=true,"clientId"=$2
     RETURNING id`,
    [viewerHash, clientId]
  );
  const clientViewerId = cpViewer.rows[0].id;
  console.log(`CLIENT_VIEWER: id=${clientViewerId} p1h-client-viewer@staging.test`);

  // ── Site ─────────────────────────────────────────────────────────────────
  const existSite = await db.query(
    `SELECT id FROM sites WHERE name='P1H London Site' AND "companyId"=$1`, [COMPANY_ID]
  );
  let siteId;
  if (existSite.rows.length > 0) {
    siteId = existSite.rows[0].id;
    await db.query(`UPDATE sites SET "clientId"=$1, timezone='Europe/London' WHERE id=$2`, [clientId, siteId]);
    console.log(`SITE: existing id=${siteId} (updated clientId+timezone)`);
  } else {
    const si = await db.query(
      `INSERT INTO sites (name,"companyId","clientId","clientName",address,status,timezone,
                         "requiredGuardCount","requireGpsCheckIn","requireNfcCheckIn","welfareCheckIntervalMinutes")
       VALUES ('P1H London Site',$1,$2,'P1H Client Portal Ltd','1 P1H Street London EC1A 1BB','active','Europe/London',
               1,false,false,60)
       RETURNING id`,
      [COMPANY_ID, clientId]
    );
    siteId = si.rows[0].id;
    console.log(`SITE: created id=${siteId}`);
  }

  // ── Helper: create shift + approved timesheet ─────────────────────────────
  async function ensureApprovedTimesheet(guardId, shiftStart, shiftEnd, label, overrides = {}) {
    const exist = await db.query(
      `SELECT t.id FROM timesheets t
       JOIN shifts s ON s.id = t."shiftId"
       WHERE s."guardId"=$1 AND s.start=$2 AND s."siteId"=$3 AND t."approvalStatus"='approved'`,
      [guardId, shiftStart, siteId]
    );
    if (exist.rows.length > 0) {
      console.log(`  ${label}: existing timesheet id=${exist.rows[0].id}`);
      return exist.rows[0].id;
    }
    const sh = await db.query(
      `INSERT INTO shifts ("companyId","guardId","siteId","siteName",start,"end",status,"createdByUserId","checkCallIntervalMinutes")
       VALUES ($1,$2,$3,'P1H London Site',$4,$5,'completed',1,60) RETURNING id`,
      [COMPANY_ID, guardId, siteId, shiftStart, shiftEnd]
    );
    const shiftId = sh.rows[0].id;
    const ts = await db.query(
      `INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus","billingStatus","payrollStatus",
                              "scheduledStartAt","scheduledEndAt","actualCheckInAt","actualCheckOutAt",
                              "approvedHours","approvedMinutes","verifiedMinutes","submittedAt","reviewedAt","createdAt","updatedAt"
                              ${overrides.extra_cols ? ',' + overrides.extra_cols : ''})
       VALUES ($1,$2,$3,8,'approved','uninvoiced','unpaid',$4,$5,$4,$5,8,480,480,now(),now(),now(),now()
               ${overrides.extra_vals ? ',' + overrides.extra_vals : ''})
       RETURNING id`,
      [shiftId, guardId, COMPANY_ID, shiftStart, shiftEnd]
    );
    const tsId = ts.rows[0].id;
    console.log(`  ${label}: shift=${shiftId} timesheet=${tsId}`);
    return tsId;
  }

  // Week 2026-09-07 (current week) timesheets
  const ts1 = await ensureApprovedTimesheet(GUARD_9_ID,  '2026-09-07T08:00:00Z', '2026-09-07T16:00:00Z', 'TS1_MON_GUARD9');
  const ts2 = await ensureApprovedTimesheet(GUARD_10_ID, '2026-09-08T08:00:00Z', '2026-09-08T16:00:00Z', 'TS2_TUE_GUARD10');
  const ts3 = await ensureApprovedTimesheet(GUARD_9_ID,  '2026-09-09T08:00:00Z', '2026-09-09T16:00:00Z', 'TS3_WED_GUARD9');

  // BST boundary shift: 2026-09-06T23:00Z = BST 2026-09-07 00:00 = Monday → week 2026-09-07
  const ts4_bst = await ensureApprovedTimesheet(GUARD_10_ID, '2026-09-06T23:00:00Z', '2026-09-07T07:00:00Z', 'TS4_BST_BOUNDARY');

  // Wrong-week timesheet (2026-08-31 = prev Monday)
  const ts_wrongweek = await ensureApprovedTimesheet(GUARD_9_ID, '2026-08-31T08:00:00Z', '2026-08-31T16:00:00Z', 'TS_WRONGWEEK');

  // Non-approved timesheet (draft) for B14
  const existDraft = await db.query(
    `SELECT t.id FROM timesheets t JOIN shifts s ON s.id=t."shiftId"
     WHERE s."guardId"=$1 AND s."siteId"=$2 AND t."approvalStatus"='draft' LIMIT 1`,
    [GUARD_10_ID, siteId]
  );
  let ts_draft;
  if (existDraft.rows.length > 0) {
    ts_draft = existDraft.rows[0].id;
    console.log(`  TS_DRAFT: existing id=${ts_draft}`);
  } else {
    const sh_d = await db.query(
      `INSERT INTO shifts ("companyId","guardId","siteId","siteName",start,"end",status,"createdByUserId","checkCallIntervalMinutes")
       VALUES ($1,$2,$3,'P1H London Site','2026-09-10T08:00:00Z','2026-09-10T16:00:00Z','completed',1,60) RETURNING id`,
      [COMPANY_ID, GUARD_10_ID, siteId]
    );
    const ts_d_r = await db.query(
      `INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus","billingStatus","payrollStatus",
                              "scheduledStartAt","scheduledEndAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,8,'draft','uninvoiced','unpaid','2026-09-10T08:00:00Z','2026-09-10T16:00:00Z',now(),now()) RETURNING id`,
      [sh_d.rows[0].id, GUARD_10_ID, COMPANY_ID]
    );
    ts_draft = ts_d_r.rows[0].id;
    console.log(`  TS_DRAFT: created id=${ts_draft}`);
  }

  // Already-invoiced timesheet for B15
  const existInvoiced = await db.query(
    `SELECT t.id FROM timesheets t JOIN shifts s ON s.id=t."shiftId"
     WHERE s."guardId"=$1 AND s."siteId"=$2 AND t."billingStatus"='invoiced' LIMIT 1`,
    [GUARD_10_ID, siteId]
  );
  let ts_invoiced;
  if (existInvoiced.rows.length > 0) {
    ts_invoiced = existInvoiced.rows[0].id;
    console.log(`  TS_INVOICED: existing id=${ts_invoiced}`);
  } else {
    const sh_i = await db.query(
      `INSERT INTO shifts ("companyId","guardId","siteId","siteName",start,"end",status,"createdByUserId","checkCallIntervalMinutes")
       VALUES ($1,$2,$3,'P1H London Site','2026-09-11T08:00:00Z','2026-09-11T16:00:00Z','completed',1,60) RETURNING id`,
      [COMPANY_ID, GUARD_10_ID, siteId]
    );
    const ts_i_r = await db.query(
      `INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus","billingStatus","payrollStatus",
                              "scheduledStartAt","scheduledEndAt","approvedHours","approvedMinutes","verifiedMinutes",
                              "submittedAt","reviewedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,8,'approved','invoiced','unpaid','2026-09-11T08:00:00Z','2026-09-11T16:00:00Z',8,480,480,now(),now(),now(),now()) RETURNING id`,
      [sh_i.rows[0].id, GUARD_10_ID, COMPANY_ID]
    );
    ts_invoiced = ts_i_r.rows[0].id;
    console.log(`  TS_INVOICED: created id=${ts_invoiced}`);
  }

  // TS_J: Payroll-processed timesheet for Section J
  // Guard 9, different week (2026-09-14), with payrollBatchId and snapshots pre-set
  const existJ = await db.query(
    `SELECT t.id FROM timesheets t JOIN shifts s ON s.id=t."shiftId"
     WHERE s."guardId"=$1 AND s."siteId"=$2 AND t."payrollStatus"='included'
     AND t."payableHoursSnapshot" IS NOT NULL LIMIT 1`,
    [GUARD_9_ID, siteId]
  );
  let ts_j;
  if (existJ.rows.length > 0) {
    ts_j = existJ.rows[0].id;
    console.log(`  TS_J (payroll): existing id=${ts_j}`);
  } else {
    const sh_j = await db.query(
      `INSERT INTO shifts ("companyId","guardId","siteId","siteName",start,"end",status,"createdByUserId","checkCallIntervalMinutes")
       VALUES ($1,$2,$3,'P1H London Site','2026-09-14T08:00:00Z','2026-09-14T16:00:00Z','completed',1,60) RETURNING id`,
      [COMPANY_ID, GUARD_9_ID, siteId]
    );
    const ts_j_r = await db.query(
      `INSERT INTO timesheets ("shiftId","guardId","companyId","hoursWorked","approvalStatus","billingStatus","payrollStatus",
                              "scheduledStartAt","scheduledEndAt","actualCheckInAt","actualCheckOutAt",
                              "approvedHours","approvedMinutes","verifiedMinutes",
                              "approvedHoursSnapshot","payableHoursSnapshot","payableAmountSnapshot","hourlyRateSnapshot",
                              "submittedAt","reviewedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,8,'approved','uninvoiced','included',
               '2026-09-14T08:00:00Z','2026-09-14T16:00:00Z','2026-09-14T08:00:00Z','2026-09-14T16:00:00Z',
               8,480,480,
               8.0,8.0,96.00,12.00,
               now(),now(),now(),now()) RETURNING id`,
      [sh_j.rows[0].id, GUARD_9_ID, COMPANY_ID]
    );
    ts_j = ts_j_r.rows[0].id;
    console.log(`  TS_J (payroll): created id=${ts_j}`);
  }

  await db.query('COMMIT');
  console.log('\n═══════════════════════════════════');
  console.log('SETUP COMPLETE');
  console.log(`COMPANY_ID: ${COMPANY_ID}  CLIENT_ID: ${clientId}  SITE_ID: ${siteId}`);
  console.log(`TS1=${ts1}  TS2=${ts2}  TS3=${ts3}  TS4_BST=${ts4_bst}`);
  console.log(`TS_WRONGWEEK=${ts_wrongweek}  TS_DRAFT=${ts_draft}  TS_INVOICED=${ts_invoiced}  TS_J=${ts_j}`);
  console.log(`CLIENT_ADMIN_CPU_ID: ${clientAdminId}  CLIENT_VIEWER_CPU_ID: ${clientViewerId}`);
  console.log(`STAFF_USER_ID: ${staffUserId}`);
  console.log('═══════════════════════════════════\n');

  // Write manifest to stdout for use by runtime scripts
  const manifest = {
    companyId: COMPANY_ID, clientId, siteId,
    ts1, ts2, ts3, ts4_bst, ts_wrongweek, ts_draft, ts_invoiced, ts_j,
    clientAdminCpuId: clientAdminId, clientViewerCpuId: clientViewerId,
    staffUserId,
    weekCommencing: '2026-09-07', weekEnding: '2026-09-13',
    weekJ: '2026-09-14',
  };
  console.log('MANIFEST:' + JSON.stringify(manifest));

} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('SETUP FAILED:', e.message, e.stack);
  await db.end();
  process.exit(1);
} finally {
  await db.end();
}
