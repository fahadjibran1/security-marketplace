// P1G-B staging test identity setup
// Creates 4 guards (different engagement types), 2 companies, 1 client.
// Idempotent: ON CONFLICT DO UPDATE/NOTHING.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const _setupUrl = process.env.DATABASE_URL;
if (!_setupUrl) {
  console.error('ABORT: DATABASE_URL environment variable is not set');
  process.exit(1);
}
const _setupDbName = new URL(_setupUrl).pathname.replace(/^\//, '');
if (_setupDbName !== 'security_marketplace_staging') {
  console.error(`ABORT: DATABASE_URL points to "${_setupDbName}", not "security_marketplace_staging" — non-staging DB rejected`);
  process.exit(1);
}
const client = new Client({ connectionString: _setupUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

// Target safety check
if (client.database !== 'security_marketplace_staging') {
  console.error(`ABORT: unexpected DB "${client.database}"`);
  process.exit(1);
}

try {
  await client.query('BEGIN');

  // Pre-computed bcrypt hashes (cost 10)
  // p1gb-guard-a@staging.test / P1GB_Guard!2026
  const guardHash    = '$2b$10$p3tVetsULWG/A8RWN2DQDOOcJYzzZdxedWbSsUzMpEanWVmEBUOrS';
  // p1gb-co-a-admin@staging.test / P1GB_CoAdmin!2026
  const coAdminHash  = '$2b$10$UwfhwCNjwoyLKyH5wsyBQ.mbZKSNq23t2uXt/9szAl4cf1XwMlDJu';
  // p1gb-co-b-admin@staging.test / P1GB_CoBAdmin!2026
  const coBAdminHash = '$2b$10$OeZg0LRnSkbIgq84tuXyl.Y.U01PVpvwRqPBV5W1zXLiKULJz4XIK';
  // p1gb-client@staging.test / P1GB_Client!2026
  const clientHash   = '$2b$10$qMti8SX8BsnJ/X7TzHnuVe8dDqjtksBQPHUcOr22rRHPrbRdsJaXy';

  // ── Guard A (EMPLOYEE P1F) ─────────────────────────────────────────────────
  const guardAU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'guard','active',true,'P1GB','GuardA')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-guard-a@staging.test', guardHash]
  );
  const guardAUserId = guardAU.rows[0].id;

  const gpA = await client.query(
    `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","phone","approvalStatus","availability")
     VALUES ($1,'P1GB Guard A','P1GB-SIA-A-TEST','+44700001001','approved','available')
     ON CONFLICT ("userId") DO UPDATE SET "approvalStatus"='approved'
     RETURNING id`,
    [guardAUserId]
  );
  const guardAProfileId = gpA.rows[0].id;

  // ── Guard B (SELF_EMPLOYED_CONTRACTOR P1F) ─────────────────────────────────
  const guardBU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'guard','active',true,'P1GB','GuardB')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-guard-b@staging.test', guardHash]
  );
  const guardBUserId = guardBU.rows[0].id;

  const gpB = await client.query(
    `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","phone","approvalStatus","availability")
     VALUES ($1,'P1GB Guard B','P1GB-SIA-B-TEST','+44700001002','approved','available')
     ON CONFLICT ("userId") DO UPDATE SET "approvalStatus"='approved'
     RETURNING id`,
    [guardBUserId]
  );
  const guardBProfileId = gpB.rows[0].id;

  // ── Guard C (SUBCONTRACTOR P1F) ────────────────────────────────────────────
  const guardCU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'guard','active',true,'P1GB','GuardC')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-guard-c@staging.test', guardHash]
  );
  const guardCUserId = guardCU.rows[0].id;

  const gpC = await client.query(
    `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","phone","approvalStatus","availability")
     VALUES ($1,'P1GB Guard C','P1GB-SIA-C-TEST','+44700001003','approved','available')
     ON CONFLICT ("userId") DO UPDATE SET "approvalStatus"='approved'
     RETURNING id`,
    [guardCUserId]
  );
  const guardCProfileId = gpC.rows[0].id;

  // ── Guard D (no P1F record) ────────────────────────────────────────────────
  const guardDU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'guard','active',true,'P1GB','GuardD')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-guard-d@staging.test', guardHash]
  );
  const guardDUserId = guardDU.rows[0].id;

  const gpD = await client.query(
    `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","phone","approvalStatus","availability")
     VALUES ($1,'P1GB Guard D','P1GB-SIA-D-TEST','+44700001004','approved','available')
     ON CONFLICT ("userId") DO UPDATE SET "approvalStatus"='approved'
     RETURNING id`,
    [guardDUserId]
  );
  const guardDProfileId = gpD.rows[0].id;

  console.log('Guards:', { guardAProfileId, guardBProfileId, guardCProfileId, guardDProfileId });

  // ── Company A (primary test company) ──────────────────────────────────────
  const coAU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'company_admin','active',true,'P1GB','CoAdminA')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-co-a-admin@staging.test', coAdminHash]
  );
  const coAUserId = coAU.rows[0].id;

  const coA = await client.query(
    `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails",status,"autoCreatePayrollBatch","autoCreateInvoiceBatch","autoFinalisePayrollBatch","autoIssueInvoiceBatch")
     VALUES ($1,'P1GB Company A Ltd','P1GBA12345','1 P1GB Street, London','p1gb-a@employer.test','active',false,false,false,false)
     ON CONFLICT ("userId") DO NOTHING
     RETURNING id`,
    [coAUserId]
  );
  const companyAId = coA.rows.length > 0
    ? coA.rows[0].id
    : (await client.query(`SELECT id FROM companies WHERE "userId"=$1`, [coAUserId])).rows[0].id;

  // ── Company B (cross-company isolation company) ────────────────────────────
  const coBU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'company_admin','active',true,'P1GB','CoAdminB')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-co-b-admin@staging.test', coBAdminHash]
  );
  const coBUserId = coBU.rows[0].id;

  const coB = await client.query(
    `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails",status,"autoCreatePayrollBatch","autoCreateInvoiceBatch","autoFinalisePayrollBatch","autoIssueInvoiceBatch")
     VALUES ($1,'P1GB Company B Ltd','P1GBB12345','2 P1GB Street, London','p1gb-b@employer.test','active',false,false,false,false)
     ON CONFLICT ("userId") DO NOTHING
     RETURNING id`,
    [coBUserId]
  );
  const companyBId = coB.rows.length > 0
    ? coB.rows[0].id
    : (await client.query(`SELECT id FROM companies WHERE "userId"=$1`, [coBUserId])).rows[0].id;

  console.log('Companies:', { companyAId, companyBId });

  // ── Client viewer ──────────────────────────────────────────────────────────
  const clientU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'client_viewer','active',true,'P1GB','Client')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash", status='active'
     RETURNING id`,
    ['p1gb-client@staging.test', clientHash]
  );
  const clientUserId = clientU.rows[0].id;
  console.log('Client userId:', clientUserId);

  // ── Company A company_guard relationships (all ACTIVE) ─────────────────────
  const cgAA = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyAId, guardAProfileId]
  );
  const cgAAId = cgAA.rows[0].id;

  const cgAB = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyAId, guardBProfileId]
  );
  const cgABId = cgAB.rows[0].id;

  const cgAC = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyAId, guardCProfileId]
  );
  const cgACId = cgAC.rows[0].id;

  const cgAD = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyAId, guardDProfileId]
  );
  const cgADId = cgAD.rows[0].id;

  // ── Company B company_guard relationship (Guard A at Company B — ACTIVE) ───
  const cgBA = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyBId, guardAProfileId]
  );
  const cgBAId = cgBA.rows[0].id;

  // ── Company A Guard A INACTIVE (for historical access test) ────────────────
  // We'll use Guard D at Company B as INACTIVE (separate relationship)
  const cgBD = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'INACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='INACTIVE'
     RETURNING id`,
    [companyBId, guardDProfileId]
  );
  const cgBDId = cgBD.rows[0].id;

  console.log('company_guards:', { cgAAId, cgABId, cgACId, cgADId, cgBAId, cgBDId });

  // ── P1F employment records ─────────────────────────────────────────────────
  // Guard A → EMPLOYEE
  await client.query(
    `INSERT INTO company_guard_employment_records ("companyGuardId","engagementType","jobRole","workingArrangement","startDate","payBasis")
     VALUES ($1,'EMPLOYEE','SECURITY_OFFICER','FULL_TIME','2026-01-01','HOURLY')
     ON CONFLICT ("companyGuardId") DO UPDATE SET "engagementType"='EMPLOYEE'`,
    [cgAAId]
  );

  // Guard B → SELF_EMPLOYED_CONTRACTOR
  await client.query(
    `INSERT INTO company_guard_employment_records ("companyGuardId","engagementType","jobRole","workingArrangement","startDate","payBasis")
     VALUES ($1,'SELF_EMPLOYED_CONTRACTOR','SECURITY_OFFICER','CASUAL','2026-01-01','HOURLY')
     ON CONFLICT ("companyGuardId") DO UPDATE SET "engagementType"='SELF_EMPLOYED_CONTRACTOR'`,
    [cgABId]
  );

  // Guard C → SUBCONTRACTOR
  await client.query(
    `INSERT INTO company_guard_employment_records ("companyGuardId","engagementType","jobRole","workingArrangement","startDate","payBasis")
     VALUES ($1,'SUBCONTRACTOR','SECURITY_OFFICER','CASUAL','2026-01-01','HOURLY')
     ON CONFLICT ("companyGuardId") DO UPDATE SET "engagementType"='SUBCONTRACTOR'`,
    [cgACId]
  );
  // Guard D → no P1F record (intentionally omitted)

  console.log('P1F records created for Guards A, B, C');

  await client.query('COMMIT');

  console.log('\nP1G-B TEST IDENTITIES READY:');
  console.log(`  p1gb-guard-a@staging.test   userId=${guardAUserId} guardProfileId=${guardAProfileId} pw=P1GB_Guard!2026`);
  console.log(`  p1gb-guard-b@staging.test   userId=${guardBUserId} guardProfileId=${guardBProfileId} pw=P1GB_Guard!2026`);
  console.log(`  p1gb-guard-c@staging.test   userId=${guardCUserId} guardProfileId=${guardCProfileId} pw=P1GB_Guard!2026`);
  console.log(`  p1gb-guard-d@staging.test   userId=${guardDUserId} guardProfileId=${guardDProfileId} pw=P1GB_Guard!2026`);
  console.log(`  p1gb-co-a-admin@staging.test userId=${coAUserId} companyId=${companyAId} pw=P1GB_CoAdmin!2026`);
  console.log(`  p1gb-co-b-admin@staging.test userId=${coBUserId} companyId=${companyBId} pw=P1GB_CoBAdmin!2026`);
  console.log(`  p1gb-client@staging.test    userId=${clientUserId} pw=P1GB_Client!2026`);
  console.log(`  company_guards:`);
  console.log(`    Company A - Guard A (EMPLOYEE P1F): cg.id=${cgAAId}`);
  console.log(`    Company A - Guard B (SEC P1F):      cg.id=${cgABId}`);
  console.log(`    Company A - Guard C (SUB P1F):      cg.id=${cgACId}`);
  console.log(`    Company A - Guard D (no P1F):       cg.id=${cgADId}`);
  console.log(`    Company B - Guard A (cross-co):     cg.id=${cgBAId}`);
  console.log(`    Company B - Guard D (INACTIVE):     cg.id=${cgBDId}`);

} catch (e) {
  await client.query('ROLLBACK');
  console.error('SETUP FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
} finally {
  await client.end();
}
