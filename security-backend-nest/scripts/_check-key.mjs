import pg from '../node_modules/pg/lib/index.js';
const c = new pg.Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
await c.connect();
// Check the actual column name as stored in PostgreSQL
const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'company_guard_payroll_records' AND column_name ILIKE '%payrollnote%'`);
cols.rows.forEach(r => console.log('Column name in catalog:', JSON.stringify(r.column_name)));
// Try selecting the column and check what key node-postgres returns
const row = await c.query(`SELECT "payrollNoteEnc" FROM company_guard_payroll_records WHERE "companyId" = 6 LIMIT 1`);
if (row.rows.length > 0) {
  const keys = Object.keys(row.rows[0]);
  console.log('Keys in result row:', JSON.stringify(keys));
  console.log('Value accessed as payrollNoteEnc:', typeof row.rows[0].payrollNoteEnc);
  // Try lowercase
  console.log('Value accessed as payrollnoteenc:', typeof row.rows[0]['payrollnoteenc']);
  // Show actual value prefix (first 5 chars, no full value)
  const val = row.rows[0][keys[0]];
  if (val) console.log('Value first 4 chars:', val.substring(0,4));
  else console.log('Value is null/undefined');
}
await c.end();
