import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// Find and clean up any weekly approval for week 2026-10-05 for company 6 site 1
const reqs = (await db.query(
  `SELECT id, status, "currentVersion" FROM client_weekly_approval_requests
   WHERE "companyId"=6 AND "siteId"=1 AND "weekCommencing"::text='2026-10-05'
   ORDER BY id`
)).rows;
console.log('Found:', reqs);

for (const req of reqs) {
  console.log(`Cleaning req id=${req.id} status=${req.status}`);
  await db.query(`UPDATE timesheets SET "billingStatus"='uninvoiced',"invoiceBatchId"=NULL,"clientBilledHoursSnapshot"=NULL WHERE id IN (SELECT "timesheetId" FROM client_weekly_approval_lines WHERE "weeklyApprovalRequestId"=$1)`, [req.id]);
  await db.query(`DELETE FROM client_shift_disputes WHERE "weeklyApprovalRequestId"=$1`, [req.id]);
  await db.query(`DELETE FROM client_weekly_approval_lines WHERE "weeklyApprovalRequestId"=$1`, [req.id]);
  await db.query(`DELETE FROM client_weekly_approval_requests WHERE id=$1`, [req.id]);
  console.log(`Cleaned req ${req.id}`);
}

// Also reset timesheet statuses for fresh run
await db.query(`UPDATE timesheets SET "approvalStatus"='submitted', "submittedAt"=now(), "approvedHours"=NULL, "approvedMinutes"=NULL, "companyNote"=NULL, "overrideReason"=NULL, "companyApprovedStartAt"=NULL, "companyApprovedEndAt"=NULL, "reviewedAt"=NULL WHERE id IN (9, 10, 11)`);
console.log('Reset ts 9,10,11 to submitted');
await db.query(`UPDATE timesheets SET "approvalStatus"='draft', "submittedAt"=NULL, "approvedHours"=NULL, "approvedMinutes"=NULL, "companyNote"=NULL, "overrideReason"=NULL, "companyApprovedStartAt"=NULL, "companyApprovedEndAt"=NULL, "reviewedAt"=NULL WHERE id=10`);
console.log('Reset ts 10 to draft');

await db.end();
console.log('Cleanup complete.');
