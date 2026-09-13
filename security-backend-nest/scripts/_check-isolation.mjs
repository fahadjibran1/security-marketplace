import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
// Check what company_guards record guard user 36 (p1gb-guard-a) is in
const cgRows = await c.query(`SELECT cg.id, cg."companyId", cg."guardProfileId" FROM company_guards cg 
  JOIN guard_profiles gp ON gp.id = cg."guardProfileId"
  WHERE gp."userId" = 36`);
cgRows.rows.forEach(r => console.log('GuardA companyGuard:', r.id, 'companyId:', r.companyId, 'guardProfileId:', r.guardProfileId));
// Check payroll records for company 6
const prRows = await c.query(`SELECT id, "companyGuardId", "companyId", "payrollNoteEnc" IS NOT NULL AS hasNote, 
  LEFT("payrollNoteEnc", 4) AS enc_prefix FROM company_guard_payroll_records WHERE "companyId" = 6 LIMIT 5`);
prRows.rows.forEach(r => console.log('PayrollRec:', r.id, 'cg:', r.companyGuardId, 'co:', r.companyId, 'hasNote:', r.hasnote, 'enc_prefix:', r.enc_prefix));
// Check what company B admin (userId 41) belongs to
const coB = await c.query(`SELECT cg.id, cg."companyId", c.name FROM company_admins ca 
  JOIN companies c ON c.id = ca."companyId" WHERE ca."userId" = 41`);
coB.rows.forEach(r => console.log('CoBAdmin company:', r.companyId, r.name));
await c.end();
