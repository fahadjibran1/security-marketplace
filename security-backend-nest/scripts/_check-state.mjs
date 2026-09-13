import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();

// 1. What company does Company A admin (userId=40) belong to?
const coA = await c.query(`SELECT ca."companyId", co.name FROM company_admins ca JOIN companies co ON co.id = ca."companyId" WHERE ca."userId" = 40`);
coA.rows.forEach(r => console.log('CoA admin company:', r.companyId, r.name));

// 2. What company does Company B admin (userId=41) belong to?
const coB = await c.query(`SELECT ca."companyId", co.name FROM company_admins ca JOIN companies co ON co.id = ca."companyId" WHERE ca."userId" = 41`);
coB.rows.forEach(r => console.log('CoB admin company:', r.companyId, r.name));

// 3. What company_guards record (ID) does guard profile 9 have, and with which companies?
const cg9 = await c.query(`SELECT cg.id, cg."companyId", co.name FROM company_guards cg JOIN companies co ON co.id = cg."companyId" WHERE cg."guardId" = 9`);
cg9.rows.forEach(r => console.log('GuardProfile9 in company:', r.companyId, r.name, 'cgId:', r.id));

// 4. Show company_guard_payroll_records for guard 9
const pr9 = await c.query(`SELECT pr.id, pr."companyGuardId", pr."companyId", 
  (pr."payrollNoteEnc" IS NOT NULL) AS hasNote, LEFT(pr."payrollNoteEnc", 5) AS noteStart
  FROM company_guard_payroll_records pr WHERE pr."companyGuardId" IN (SELECT id FROM company_guards WHERE "guardId" = 9)`);
pr9.rows.forEach(r => console.log('PayrollRec for cg with guardId=9:', r.id, 'cgId:', r.companyGuardId, 'coId:', r.companyId, 'hasNote:', r.hasnote, 'start:', r.notestart));

await c.end();
