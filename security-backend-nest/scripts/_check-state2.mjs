import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();

// 1. Find company IDs via companies.userId
const coAId = await c.query(`SELECT id, name FROM companies WHERE "userId" = 40`);
coAId.rows.forEach(r => console.log('CoA companyId:', r.id, r.name));

const coBId = await c.query(`SELECT id, name FROM companies WHERE "userId" = 41`);
coBId.rows.forEach(r => console.log('CoB companyId:', r.id, r.name));

// 2. Which companies does guard profile ID 9 have relationships with?
const cg9 = await c.query(`SELECT cg.id AS cgId, cg."companyId", co.name FROM company_guards cg 
  JOIN companies co ON co.id = cg."companyId" WHERE cg."guardId" = 9`);
cg9.rows.forEach(r => console.log('GuardProfile9 cgId:', r.cgid, 'companyId:', r.companyId, r.name));

// 3. Payroll records for guard 9 (by companyGuardId)
const prList = await c.query(`SELECT pr.id, pr."companyGuardId", pr."companyId",
  (pr."payrollNoteEnc" IS NOT NULL) AS hasNote, LEFT(pr."payrollNoteEnc", 4) AS notePrefix
  FROM company_guard_payroll_records pr WHERE pr."companyGuardId" IN (
    SELECT id FROM company_guards WHERE "guardId" = 9
  )`);
prList.rows.forEach(r => console.log('PayrollRec:', r.id, 'cg:', r.companyGuardId, 'co:', r.companyId, 'hasNote:', r.hasnote, 'prefix:', r.noteprefix));

// 4. Audit log check — no note in afterData
const audit = await c.query(`SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE '%payroll%' AND ("afterData"->>'payrollNote' IS NOT NULL OR "afterData"->>'payrollNoteEnc' IS NOT NULL)`);
console.log('Audit logs with note in afterData:', audit.rows[0].n);

await c.end();
