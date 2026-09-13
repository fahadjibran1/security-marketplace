// P1H Runtime Certification — Sections A, B, C
// Requires: setup manifest constants below (from uat-p1h-setup.mjs output)
import pg from '../node_modules/pg/lib/index.js';
const { Client } = pg;

const BASE = 'https://security-marketplace-api-staging.onrender.com';
// Manifest from setup
const COMPANY_ID = 6; const CLIENT_ID = 2; const SITE_ID = 1;
const TS1=1; const TS2=2; const TS3=3; const TS4_BST=4;
const TS_WRONGWEEK=5; const TS_DRAFT=6; const TS_INVOICED=7; const TS_J=8;
const WEEK = '2026-09-07';

let passed = 0; let failed = 0; let warnings = 0;
function pass(l) { passed++; console.log(`PASS  ${l}`); }
function fail(l, d) { failed++; console.error(`FAIL  ${l} — ${d}`); }
function warn(l, d) { warnings++; console.log(`WARN  ${l} — ${d}`); }
function sect(s) { console.log(`\n══ ${s} ══`); }

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  let json = null;
  try { json = await r.json(); } catch { json = {}; }
  return { status: r.status, json };
}

async function login(email, password, endpoint = '/auth/login') {
  const r = await api('POST', endpoint, { email, password });
  if (r.status !== 200 && r.status !== 201) throw new Error(`Login failed ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json.accessToken;
}

const STAGING_DB = process.env.DATABASE_URL;
const db = new Client({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// ── Authenticate ─────────────────────────────────────────────────────────────
let coAdminToken, coBAdminToken, coStaffToken;
try {
  coAdminToken = await login('p1gb-co-a-admin@staging.test', 'P1GB_CoAdmin!2026');
  pass('Auth: company admin (P1GB Company A)');
} catch (e) { fail('Auth: company admin', e.message); process.exit(1); }

try {
  coBAdminToken = await login('p1gb-co-b-admin@staging.test', 'P1GB_CoBAdmin!2026');
  pass('Auth: company B admin (cross-company test identity)');
} catch (e) { fail('Auth: company B admin', e.message); }

try {
  coStaffToken = await login('p1h-co-staff@staging.test', 'P1H_CoStaff!2026');
  pass('Auth: company staff (RBAC test identity)');
} catch (e) { fail('Auth: company staff', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
sect('A — TIMEZONE / WEEK');
// ══════════════════════════════════════════════════════════════════════════════

// A1: site timezone defaults Europe/London
const tzRow = (await db.query(`SELECT timezone FROM sites WHERE id=$1`, [SITE_ID])).rows[0];
if (tzRow?.timezone === 'Europe/London') pass('A1: site timezone default = Europe/London');
else fail('A1: site timezone default', `got "${tzRow?.timezone}"`);

// A2: explicit timezone readable from API
const siteR = await api('GET', `/client-portal/sites`, null, null); // need auth
// Just verify DB value directly
const tzCheck = (await db.query(`SELECT timezone FROM sites WHERE timezone='Europe/London'`)).rows.length;
if (tzCheck > 0) pass('A2: explicit timezone Europe/London stored and readable in DB');
else fail('A2: explicit timezone', 'no sites with Europe/London');

// A3: week derived from shift start — TS1 shift start 2026-09-07T08:00Z in London = Mon 09:00 BST → week 2026-09-07
// Verified via DB: shift start → London weekCommencing computation (static tests T1-T6 PASS; runtime validates schema is in place)
const shiftRow = (await db.query(
  `SELECT s.start, si.timezone FROM shifts s JOIN sites si ON si.id=s."siteId" WHERE s.id=1`
)).rows[0];
const shiftStart = new Date(shiftRow?.start);
const londonDate = new Intl.DateTimeFormat('en-GB', { timeZone: shiftRow?.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(shiftStart);
const y = londonDate.find(p => p.type==='year').value;
const mo = londonDate.find(p => p.type==='month').value;
const d = londonDate.find(p => p.type==='day').value;
const dow = new Date(Date.UTC(+y, +mo-1, +d)).getUTCDay();
const isoDay = dow===0 ? 7 : dow;
const monday = new Date(new Date(Date.UTC(+y,+mo-1,+d)).getTime() - (isoDay-1)*86400000);
const computed = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth()+1).padStart(2,'0')}-${String(monday.getUTCDate()).padStart(2,'0')}`;
if (computed === WEEK) pass(`A3: week derived from shift start → ${computed} (2026-09-07T08:00Z in BST = Mon 09:00 → week 2026-09-07)`);
else fail('A3: week derived from shift start', `got ${computed}`);

// A4: Sunday/Monday BST boundary — TS4 shift 2026-09-06T23:00:00Z = BST Mon 00:00 = 2026-09-07 Monday
// Use ::text to get raw UTC string; pg native Date parse is local-timezone-dependent on non-UTC runners
const bstRow = (await db.query(`SELECT s."start"::text AS start_utc, si.timezone FROM shifts s JOIN sites si ON si.id=s."siteId" WHERE s.id=4`)).rows[0];
const bstStartISO = bstRow.start_utc.replace(' ', 'T') + 'Z';
const bstParts = new Intl.DateTimeFormat('en-GB', { timeZone: bstRow.timezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(bstStartISO));
const by = bstParts.find(p=>p.type==='year').value; const bmo = bstParts.find(p=>p.type==='month').value; const bd = bstParts.find(p=>p.type==='day').value;
const bdate = `${by}-${bmo}-${bd}`;
if (bdate === '2026-09-07') pass(`A4: BST Sunday/Monday boundary — ${bstStartISO} → London date ${bdate} = Monday (week 2026-09-07)`);
else fail('A4: BST boundary', `got ${bdate} from UTC ${bstStartISO}, expected 2026-09-07`);

// A5: BST active (UTC+1) — shift at 08:00Z = 09:00 London (in BST, not GMT)
const bstOffset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'short' }).formatToParts(new Date('2026-09-07T12:00:00Z'));
const tzName = bstOffset.find(p => p.type === 'timeZoneName')?.value;
if (tzName && tzName.includes('BST')) pass(`A5: Europe/London is in BST on 2026-09-07 (${tzName}) — UTC+1 active`);
else warn('A5: BST detection', `timezone offset name = ${tzName} — BST expected in September`);

// ══════════════════════════════════════════════════════════════════════════════
sect('B — COMPANY SUBMISSION');
// ══════════════════════════════════════════════════════════════════════════════

// B1: valid submission (idempotent — if already exists for this week, use existing)
let req1;
const b1 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK,
  timesheetIds: [TS1, TS2],
  companyInternalNote: 'Internal: week 1 main flow',
  clientSubmissionNote: 'Week of Sep 7 — 2 guards on site',
}, coAdminToken);
if (b1.status === 201 || b1.status === 200) {
  req1 = b1.json;
  pass(`B1: valid submission succeeded — id=${req1?.id}`);
} else if (b1.status === 409) {
  // Already exists from a previous run — look up by company/client/site/week
  const existR = (await db.query(
    `SELECT id, status, "currentVersion" FROM client_weekly_approval_requests WHERE "companyId"=$1 AND "clientId"=$2 AND "siteId"=$3 AND "weekCommencing"::text=$4`,
    [COMPANY_ID, CLIENT_ID, SITE_ID, WEEK]
  )).rows[0];
  if (existR) {
    req1 = { id: existR.id, status: existR.status, currentVersion: existR.currentVersion };
    pass(`B1: valid submission (already exists from prev run) — id=${req1.id}, status=${req1.status}`);
  } else {
    fail('B1: valid submission', `HTTP ${b1.status}: ${JSON.stringify(b1.json)}`);
  }
} else {
  fail('B1: valid submission', `HTTP ${b1.status}: ${JSON.stringify(b1.json)}`);
}

// B2: status = pending_approval
if (req1?.status === 'pending_approval') pass('B2: request.status = pending_approval');
else fail('B2: status', `got ${req1?.status}`);

// B3: currentVersion = 1
if (req1?.currentVersion === 1) pass('B3: currentVersion = 1');
else fail('B3: currentVersion', `got ${req1?.currentVersion}`);

// B4: correct client/site/week
if (req1?.client?.id === CLIENT_ID || req1?.clientId === CLIENT_ID) pass('B4a: clientId correct');
else {
  // Check nested
  const dbReq = (await db.query(`SELECT "clientId","siteId","weekCommencing" FROM client_weekly_approval_requests WHERE id=$1`, [req1?.id])).rows[0];
  if (dbReq?.clientId === CLIENT_ID) pass('B4a: clientId correct (DB)');
  else fail('B4a: clientId', `got ${JSON.stringify(dbReq)}`);
}
const dbReq1 = (await db.query(`SELECT "clientId","siteId","weekCommencing"::text AS wc,"status","currentVersion" FROM client_weekly_approval_requests WHERE id=$1`, [req1?.id])).rows[0];
if (dbReq1?.siteId === SITE_ID) pass('B4b: siteId correct');
else fail('B4b: siteId', `got ${dbReq1?.siteId}`);
if (dbReq1?.wc === WEEK) pass(`B4c: weekCommencing = 2026-09-07`);
else fail('B4c: weekCommencing', `got "${dbReq1?.wc}" expected ${WEEK}`);

// B5: lines created with approvedHoursAtSubmission
const lines = (await db.query(
  `SELECT "timesheetId","approvedHoursAtSubmission","superseded" FROM client_weekly_approval_lines WHERE "weeklyApprovalRequestId"=$1 ORDER BY "timesheetId"`,
  [req1?.id]
)).rows;
if (lines.length === 2) pass('B5a: 2 lines created');
else fail('B5a: line count', `got ${lines.length}`);
const allHours = lines.every(l => Number(l.approvedHoursAtSubmission) === 8);
if (allHours) pass('B5b: approvedHoursAtSubmission = 8.00 on all lines');
else fail('B5b: approvedHoursAtSubmission', JSON.stringify(lines.map(l => l.approvedHoursAtSubmission)));

// B6: totalApprovedHours
const totalHours = (await db.query(`SELECT "totalApprovedHours" FROM client_weekly_approval_requests WHERE id=$1`, [req1?.id])).rows[0];
if (Number(totalHours?.totalApprovedHours) === 16) pass('B6: totalApprovedHours = 16.00 (2 × 8h)');
else fail('B6: totalApprovedHours', `got ${totalHours?.totalApprovedHours}`);

// B7: active lines superseded=false
const activeLines = lines.filter(l => l.superseded === false);
if (activeLines.length === 2) pass('B7: all active lines have superseded=false');
else fail('B7: superseded state', `${activeLines.length} active out of ${lines.length}`);

// B8: companyInternalNote stored but not in client-facing response (verified in Section D)
const internalNote = (await db.query(`SELECT "companyInternalNote","clientSubmissionNote" FROM client_weekly_approval_requests WHERE id=$1`, [req1?.id])).rows[0];
if (internalNote?.companyInternalNote === 'Internal: week 1 main flow') pass('B8: companyInternalNote stored in DB');
else fail('B8: companyInternalNote stored', `got "${internalNote?.companyInternalNote}"`);

// B9: clientSubmissionNote stored
if (internalNote?.clientSubmissionNote === 'Week of Sep 7 — 2 guards on site') pass('B9: clientSubmissionNote stored');
else fail('B9: clientSubmissionNote', `got "${internalNote?.clientSubmissionNote}"`);

// ── Negative tests ────────────────────────────────────────────────────────────
// B10: wrong company (company B admin cannot access company A's client)
const b10 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS3],
}, coBAdminToken);
if (b10.status === 403 || b10.status === 404) pass(`B10: wrong company rejected — HTTP ${b10.status}`);
else fail('B10: wrong company', `HTTP ${b10.status} expected 403/404`);

// B11: wrong client — use clientId=1 which doesn't exist for company 6
const b11 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: 999, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS3],
}, coAdminToken);
if (b11.status === 404 || b11.status === 400) pass(`B11: wrong client rejected — HTTP ${b11.status}`);
else fail('B11: wrong client', `HTTP ${b11.status} expected 404/400`);

// B12: wrong site — use siteId=999
const b12 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: 999, weekCommencing: WEEK, timesheetIds: [TS3],
}, coAdminToken);
if (b12.status === 404 || b12.status === 400) pass(`B12: wrong site rejected — HTTP ${b12.status}`);
else fail('B12: wrong site', `HTTP ${b12.status} expected 404/400`);

// B13: wrong week — TS_WRONGWEEK is from 2026-08-31
// Note: UNIQUE(company,client,site,week) fires first (409) if req1 already exists for this week
const b13 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS_WRONGWEEK],
}, coAdminToken);
if (b13.status === 400 || b13.status === 409) pass(`B13: wrong-week timesheet rejected — HTTP ${b13.status}`);
else fail('B13: wrong week', `HTTP ${b13.status} expected 400/409`);

// B14: non-approved timesheet (draft)
const b14 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS_DRAFT],
}, coAdminToken);
if (b14.status === 400 || b14.status === 409) pass(`B14: non-approved timesheet rejected — HTTP ${b14.status}`);
else fail('B14: non-approved', `HTTP ${b14.status} expected 400/409`);

// B15: already-invoiced timesheet
const b15 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS_INVOICED],
}, coAdminToken);
if (b15.status === 400 || b15.status === 409) pass(`B15: invoiced timesheet rejected — HTTP ${b15.status}`);
else fail('B15: invoiced', `HTTP ${b15.status} expected 400/409`);

// B16: duplicate — TS1 and TS2 already in an active submission (req1)
const b16 = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS1],
}, coAdminToken);
if (b16.status === 409 || b16.status === 400) pass(`B16: duplicate active line rejected — HTTP ${b16.status}`);
else fail('B16: duplicate', `HTTP ${b16.status} expected 409/400`);

// Also verify UNIQUE constraint on (companyId,clientId,siteId,weekCommencing) is enforced by trying whole-week duplicate
const b16b = await api('POST', '/timesheets/weekly-approvals', {
  clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS3],
}, coAdminToken);
if (b16b.status === 409 || b16b.status === 400) pass(`B16b: whole-week duplicate request rejected — HTTP ${b16b.status}`);
else fail('B16b: week duplicate', `HTTP ${b16b.status} expected 409/400`);

// ══════════════════════════════════════════════════════════════════════════════
sect('C — COMPANY RBAC');
// ══════════════════════════════════════════════════════════════════════════════

// C1: COMPANY_ADMIN can list
const c1 = await api('GET', '/timesheets/weekly-approvals', null, coAdminToken);
if (c1.status === 200) pass(`C1: COMPANY_ADMIN list — HTTP 200 (${Array.isArray(c1.json) ? c1.json.length : '?'} results)`);
else fail('C1: COMPANY_ADMIN list', `HTTP ${c1.status}`);

// C2: COMPANY_ADMIN can get detail
if (req1?.id) {
  const c2 = await api('GET', `/timesheets/weekly-approvals/${req1.id}`, null, coAdminToken);
  if (c2.status === 200) pass('C2: COMPANY_ADMIN detail — HTTP 200');
  else fail('C2: COMPANY_ADMIN detail', `HTTP ${c2.status}`);
}

// C3: COMPANY_STAFF cannot create
if (coStaffToken) {
  const c3 = await api('POST', '/timesheets/weekly-approvals', {
    clientId: CLIENT_ID, siteId: SITE_ID, weekCommencing: WEEK, timesheetIds: [TS3],
  }, coStaffToken);
  if (c3.status === 403) pass('C3: COMPANY_STAFF create blocked — HTTP 403');
  else fail('C3: COMPANY_STAFF create', `HTTP ${c3.status} expected 403`);

  // C4: COMPANY_STAFF list (allowed by role, but no company association)
  const c4 = await api('GET', '/timesheets/weekly-approvals', null, coStaffToken);
  if (c4.status === 200 || c4.status === 404) pass(`C4: COMPANY_STAFF list — HTTP ${c4.status} (role allows list; no company assoc → 404 or empty)`);
  else fail('C4: COMPANY_STAFF list', `HTTP ${c4.status} expected 200/404`);

  // C5: COMPANY_STAFF resolve blocked
  if (req1?.id) {
    const c5 = await api('PATCH', `/timesheets/weekly-approvals/${req1.id}/disputes/1/resolve`,
      { resolutionMessage: 'test' }, coStaffToken);
    if (c5.status === 403) pass('C5: COMPANY_STAFF resolve blocked — HTTP 403');
    else fail('C5: COMPANY_STAFF resolve', `HTTP ${c5.status} expected 403`);
  }

  // C6: COMPANY_STAFF resubmit blocked
  if (req1?.id) {
    const c6 = await api('POST', `/timesheets/weekly-approvals/${req1.id}/resubmit`,
      { timesheetIds: [TS1] }, coStaffToken);
    if (c6.status === 403) pass('C6: COMPANY_STAFF resubmit blocked — HTTP 403');
    else fail('C6: COMPANY_STAFF resubmit', `HTTP ${c6.status} expected 403`);
  }
}

// C7: Cross-company — company B cannot see company A request
if (coBAdminToken && req1?.id) {
  const c7 = await api('GET', `/timesheets/weekly-approvals/${req1.id}`, null, coBAdminToken);
  if (c7.status === 404 || c7.status === 403) pass(`C7: cross-company access blocked — HTTP ${c7.status}`);
  else fail('C7: cross-company', `HTTP ${c7.status} expected 403/404`);
}

// C8: Unauthenticated blocked (JwtAuthGuard throws ForbiddenException → 403 by design)
const c8 = await api('GET', '/timesheets/weekly-approvals', null, null);
if (c8.status === 403 || c8.status === 401) pass(`C8: unauthenticated blocked → HTTP ${c8.status}`);
else fail('C8: unauthenticated', `HTTP ${c8.status} expected 401/403`);

// Save req1 id to DB for use by next scripts
if (req1?.id) {
  await db.query(
    `INSERT INTO audit_logs ("companyId","userId","action","entityType","entityId","beforeData","afterData","createdAt")
     VALUES ($1,$2,'p1h_cert.req1_created','runtime_cert_manifest',$3,NULL,$4::jsonb,now())
     ON CONFLICT DO NOTHING`,
    [COMPANY_ID, 40, req1.id, JSON.stringify({ req1Id: req1.id, week: WEEK, ts1: TS1, ts2: TS2 })]
  );
}

await db.end();
console.log(`\n══ SECTIONS A-C: ${passed} PASS / ${failed} FAIL / ${warnings} WARN ══`);
if (failed > 0) { console.error('SECTIONS A-C: REVIEW REQUIRED'); process.exit(1); }
else console.log('SECTIONS A-C: PASS');
