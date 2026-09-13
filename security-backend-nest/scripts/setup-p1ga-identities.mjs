// P1G-A staging test identity setup
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
import { readFileSync } from 'fs';

const migFile = readFileSync(new URL('../scripts/check-staging-migrations.mjs', import.meta.url), 'utf8');
const url = migFile.match(/const STAGING_DB = '([^']+)'/)[1];
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('BEGIN');

  const guardHash    = '$2b$10$gwoQDvFkt4BbInYaEsKACuZdhAMMU5MvXtCemO9crGLd0iftTNaG6';
  const coAdminHash  = '$2b$10$3cfxZofsA.sjXHxLu2nRvuK4s2FYr1jTY0i8yqEDPItVkzilqNk9y';
  const coStaffHash  = '$2b$10$kZlEd/13hZ.nzq3C/sVYluvftZbrm/lee9pWUUrs.z4FPHd5GFxSa';
  const clientHash   = '$2b$10$zRrlTXK4G6rZR7/EexFzLOiop3w9oYNGudoVmFVoBCTsmjETQqNTS';

  const guardU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'guard','active',true,'P1GA','Guard')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash"
     RETURNING id`,
    ['p1ga-guard@staging.test', guardHash]
  );
  const guardUserId = guardU.rows[0].id;

  const coAdminU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'company_admin','active',true,'P1GA','CoAdmin')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash"
     RETURNING id`,
    ['p1ga-co-admin@staging.test', coAdminHash]
  );
  const coAdminUserId = coAdminU.rows[0].id;

  const coStaffU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'company_staff','active',true,'P1GA','CoStaff')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash"
     RETURNING id`,
    ['p1ga-co-staff@staging.test', coStaffHash]
  );
  const coStaffUserId = coStaffU.rows[0].id;

  // client_viewer role for the "client zero access" test
  const clientU = await client.query(
    `INSERT INTO users (email,"passwordHash",role,status,"isEmailVerified","firstName","lastName")
     VALUES ($1,$2,'client_viewer','active',true,'P1GA','Client')
     ON CONFLICT (email) DO UPDATE SET "passwordHash"=EXCLUDED."passwordHash"
     RETURNING id`,
    ['p1ga-client@staging.test', clientHash]
  );
  const clientUserId = clientU.rows[0].id;

  console.log('Users:', { guardUserId, coAdminUserId, coStaffUserId, clientUserId });

  // Guard profile
  const gpRow = await client.query(
    `INSERT INTO guard_profiles ("userId","fullName","siaLicenseNumber","phone","approvalStatus","availability")
     VALUES ($1,'P1GA Guard','P1GA-SIA-001-TEST','+44700000001','approved','available')
     ON CONFLICT ("userId") DO UPDATE SET "approvalStatus"='approved'
     RETURNING id`,
    [guardUserId]
  );
  const guardProfileId = gpRow.rows[0].id;
  console.log('GuardProfile id:', guardProfileId);

  // P1GA employer company (for co-admin)
  const coRow = await client.query(
    `INSERT INTO companies ("userId",name,"companyNumber",address,"contactDetails",status,"autoCreatePayrollBatch","autoCreateInvoiceBatch","autoFinalisePayrollBatch","autoIssueInvoiceBatch")
     VALUES ($1,'P1GA Employer Ltd','P1GA12345','1 P1GA Street, London','p1ga@employer.test','active',false,false,false,false)
     ON CONFLICT ("userId") DO NOTHING
     RETURNING id`,
    [coAdminUserId]
  );
  const companyId = coRow.rows[0].id;
  console.log('Company id:', companyId);

  // ACTIVE company-guard relationship (p1ga-guard ↔ p1ga-employer)
  const cgActive = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES ($1,$2,'ACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='ACTIVE'
     RETURNING id`,
    [companyId, guardProfileId]
  );
  const cgActiveId = cgActive.rows[0].id;
  console.log('ACTIVE company_guard id:', cgActiveId);

  // INACTIVE company-guard relationship — p1ga-guard ↔ P1D Test Company (companyId=2) as former employer
  const cgInactive = await client.query(
    `INSERT INTO company_guards ("companyId","guardId",status)
     VALUES (2,$1,'INACTIVE')
     ON CONFLICT ("companyId","guardId") DO UPDATE SET status='INACTIVE'
     RETURNING id`,
    [guardProfileId]
  );
  const cgInactiveId = cgInactive.rows[0].id;
  console.log('INACTIVE company_guard id (former employer via P1D co):', cgInactiveId);

  await client.query('COMMIT');

  console.log('\nP1G-A TEST IDENTITIES READY:');
  console.log(`  p1ga-guard@staging.test     userId=${guardUserId} guardProfileId=${guardProfileId} pw=P1GA_Guard!2026`);
  console.log(`  p1ga-co-admin@staging.test  userId=${coAdminUserId} companyId=${companyId} pw=P1GA_CoAdmin!2026`);
  console.log(`  p1ga-co-staff@staging.test  userId=${coStaffUserId} pw=P1GA_CoStaff!2026`);
  console.log(`  p1ga-client@staging.test    userId=${clientUserId} pw=P1GA_Client!2026`);
  console.log(`  ACTIVE  cg: id=${cgActiveId} companyId=${companyId} guardId=${guardProfileId}`);
  console.log(`  INACTIVE cg: id=${cgInactiveId} companyId=2 guardId=${guardProfileId}`);

} catch (e) {
  await client.query('ROLLBACK');
  console.error('SETUP FAILED:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
