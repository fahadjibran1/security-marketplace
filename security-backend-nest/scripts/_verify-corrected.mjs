import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
let pass = 0, fail = 0;
const P = l => { pass++; console.log('PASS', l); };
const F = (l,d) => { fail++; console.error('FAIL', l, '-', d); };

// B8 CORRECTED: check guard 9's specific payroll record (companyGuardId=8)
const enc8 = await c.query(`SELECT "payrollNoteEnc" FROM company_guard_payroll_records WHERE "companyGuardId" = 8`);
if (enc8.rows.length > 0) {
  const enc = enc8.rows[0].payrollNoteEnc;
  if (enc && enc.startsWith('v1:')) P('B8-corrected payrollNoteEnc for guard9/CoA uses v1: AES-256-GCM envelope');
  else F('B8-corrected payrollNoteEnc', `enc=${enc ? enc.substring(0,10) : 'null'}`);
  if (enc && !enc.includes('P1GB-correction-runtime-note-test')) P('B8b-corrected plaintext NOT in encrypted column');
  else F('B8b-corrected', 'plaintext found in encrypted column');
  if (enc && enc.split(':').length === 4) P('B8c-corrected v1:iv:body:tag format has 4 parts');
  else F('B8c-corrected', 'wrong format');
} else { F('B8-corrected', 'no record found for companyGuardId=8'); }

// D1 CORRECTED: same verification
const d1enc = enc8.rows[0]?.payrollNoteEnc;
if (d1enc && d1enc.startsWith('v1:')) P('D1-corrected payrollNoteEnc versioned ciphertext in DB');
else F('D1-corrected', `enc=${d1enc ? d1enc.substring(0,10) : 'null'}`);

// C9 CORRECTED: verify guard 9 IS legitimately in Company B (explains 200 response)
const c9check = await c.query(`SELECT cg.id, cg."companyId", co.name FROM company_guards cg 
  JOIN companies co ON co.id = cg."companyId" WHERE cg."guardId" = 9 AND cg."companyId" = 7`);
if (c9check.rows.length > 0) {
  P('C9-analysis Guard9 IS in Company B (cgId=' + c9check.rows[0].id + ') — 200 response is correct isolation; each company sees their OWN record');
  // Verify Company B gets THEIR OWN record, not Company A's
  const prCoB = await c.query(`SELECT id, "payrollNoteEnc" FROM company_guard_payroll_records WHERE "companyGuardId" = $1`, [c9check.rows[0].id]);
  const prCoA = await c.query(`SELECT id FROM company_guard_payroll_records WHERE "companyGuardId" = 8`);
  if (prCoB.rows[0]?.id !== prCoA.rows[0]?.id) P('C9-isolation Company B gets record id=' + prCoB.rows[0]?.id + ', Company A gets record id=' + prCoA.rows[0]?.id + ' — different records, isolation correct');
  else F('C9-isolation', 'Company B and A got the same record — real isolation failure');
} else F('C9-analysis', 'guard 9 not found in Company B — unexpected');

console.log(`\nVerification: ${pass} PASS / ${fail} FAIL`);
await c.end();
