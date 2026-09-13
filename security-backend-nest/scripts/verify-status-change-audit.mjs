// P1G-B Status Audit Closure — verify payroll_admin_status_change persisted
// Outputs only safe boolean/metadata. Never prints sensitive payloads.
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error('ABORT: DATABASE_URL not set'); process.exit(1); }
const dbName = new URL(URL_).pathname.replace(/^\//, '');
if (dbName !== 'security_marketplace_staging') {
  console.error(`ABORT: wrong DB "${dbName}"`); process.exit(1);
}

const db = new Client({ connectionString: URL_, ssl: { rejectUnauthorized: false } });
await db.connect();

const dbActual = (await db.query('SELECT current_database() AS d')).rows[0].d;
if (dbActual !== 'security_marketplace_staging') {
  console.error(`ABORT: current_database()="${dbActual}"`); await db.end(); process.exit(1);
}
console.log(`DB verified: ${dbActual}`);

let passed = 0; let failed = 0;
const pass = l => { passed++; console.log(`PASS  ${l}`); };
const fail = (l, d) => { failed++; console.error(`FAIL  ${l} — ${d}`); };

const rows = await db.query(
  `SELECT
     action,
     ("userId" IS NOT NULL)                                              AS actor_present,
     ("entityId" IS NOT NULL OR "afterData" IS NOT NULL)                AS resource_present,
     (json_typeof("afterData") = 'object')                              AS after_data_object,
     ("afterData"->>'oldStatus' IS NOT NULL)                            AS old_status_present,
     ("afterData"->>'newStatus' IS NOT NULL)                            AS new_status_present,
     (("afterData"->>'oldStatus') <> ("afterData"->>'newStatus'))       AS status_actually_changed,
     (("afterData"->>'payrollNote') IS NULL
       AND ("afterData"->>'payrollNoteEnc') IS NULL)                    AS no_note,
     (("afterData"->>'sortCode') IS NULL
       AND ("afterData"->>'accountNumber') IS NULL)                     AS no_bank,
     (("afterData"->>'nino') IS NULL AND ("afterData"->>'utr') IS NULL) AS no_nino_utr,
     (("afterData"->>'passwordHash') IS NULL
       AND ("afterData"->>'accessToken') IS NULL)                       AS no_secrets
   FROM audit_logs
   WHERE action = 'guard_personnel.payroll_admin_status_change'
   ORDER BY id DESC`,
  []
);

console.log(`\npayroll_admin_status_change events found: ${rows.rows.length}`);

if (rows.rows.length === 0) {
  fail('SC.1 status_change persisted', 'no rows found');
} else {
  const r = rows.rows[0]; // most recent
  pass(`SC.1 payroll_admin_status_change persisted (${rows.rows.length} event(s))`);
  if (r.actor_present)           pass('SC.2 actor (userId) present');
  else                           fail('SC.2 actor present', 'userId is NULL');
  if (r.resource_present)        pass('SC.3 resource/afterData context present');
  else                           fail('SC.3 resource present', 'entityId and afterData both NULL');
  if (r.after_data_object)       pass('SC.4 afterData is JSON object');
  else                           fail('SC.4 afterData object', 'not an object');
  if (r.old_status_present)      pass('SC.5 oldStatus present in afterData');
  else                           fail('SC.5 oldStatus present', 'missing');
  if (r.new_status_present)      pass('SC.6 newStatus present in afterData');
  else                           fail('SC.6 newStatus present', 'missing');
  if (r.status_actually_changed) pass('SC.7 oldStatus != newStatus (genuine transition recorded)');
  else                           fail('SC.7 genuine transition', 'oldStatus === newStatus');
  if (r.no_note)                 pass('SC.8 No payrollNote or payrollNoteEnc in afterData');
  else                           fail('SC.8 no note in audit', 'note/enc found');
  if (r.no_bank)                 pass('SC.9 No bank details in afterData');
  else                           fail('SC.9 no bank', 'bank field found');
  if (r.no_nino_utr)             pass('SC.10 No NINO or UTR in afterData');
  else                           fail('SC.10 no nino/utr', 'found');
  if (r.no_secrets)              pass('SC.11 No passwords or tokens in afterData');
  else                           fail('SC.11 no secrets', 'found');
}

// Also log all action counts for completeness
const counts = await db.query(
  `SELECT action, COUNT(*) AS n FROM audit_logs
   WHERE action LIKE 'guard_personnel.payroll_admin%'
   GROUP BY action ORDER BY action`,
  []
);
console.log('\nAll P1G-B audit event counts:');
for (const r of counts.rows) console.log(`  ${r.action}: ${r.n}`);

await db.end();
console.log(`\n══ SC AUDIT: ${passed} PASS / ${failed} FAIL ══`);
if (failed > 0) { console.error('STATUS AUDIT CLOSURE: FAIL'); process.exit(1); }
else console.log('STATUS AUDIT CLOSURE: PASS');
