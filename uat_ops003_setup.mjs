// uat_ops003_setup.mjs — UAT-OPS-003 welfare scheduler setup
// Creates: site (welfareCheckIntervalMinutes=5), job, shift, accept, check-in
// Run with: node uat_ops003_setup.mjs

import https from 'node:https';

const BASE = 'https://security-marketplace-api.onrender.com';

function raw(url, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function api(method, path, token, jsonBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const bodyStr = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
  const r = await raw(`${BASE}${path}`, { method, headers }, bodyStr);
  return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
}

function must(label, res, expected = 200) {
  if (res.status !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

const post  = (p, t, b) => api('POST',  p, t, b);
const patch = (p, t, b) => api('PATCH', p, t, b);
const get   = (p, t)    => api('GET',   p, t);

async function main() {
  // Login
  const lA = must('Company A login', await post('/auth/login', null, { email: 'uat-company-a@example.com', password: 'UatPass!2026A' }), 201);
  const tA = lA.accessToken;
  const companyAUserId = lA.user.id;
  console.log(`Company A: userId=${companyAUserId} companyId=${lA.user.companyId}`);

  const lG = must('Guard A login', await post('/auth/login', null, { email: 'uat-guard-a@example.com', password: 'UatPass!2026G' }), 201);
  const tG = lG.accessToken;
  const guardUserId = lG.user.id;
  const guardId = lG.user.guardId;
  console.log(`Guard A: userId=${guardUserId} guardId=${guardId}`);

  // Create a site with welfareCheckIntervalMinutes=5 and no GPS requirement
  const siteRes = await post('/sites', tA, {
    name: 'UAT Welfare Test Site',
    address: 'UAT Test Location, London',
    clientId: 3,
    requireGpsCheckIn: false,
    welfareCheckIntervalMinutes: 5,
  });
  const site = must('POST /sites', siteRes, 201);
  console.log(`Site created: id=${site.id} welfareCheckIntervalMinutes=${site.welfareCheckIntervalMinutes}`);

  // Create a job at that site
  const jobRes = await post('/jobs', tA, {
    title: 'UAT Welfare Scheduler Test',
    siteId: site.id,
    guardsRequired: 1,
    hourlyRate: 12.50,
    status: 'open',
  });
  const job = must('POST /jobs', jobRes, 201);
  console.log(`Job created: id=${job.id}`);

  // Check for existing offered shift for Guard A to avoid overlap
  const shiftsRes = await get('/shifts', tG);
  const shifts = must('GET /shifts (Guard A)', shiftsRes);
  const existingOffered = shifts.find(s => s.status === 'offered' || s.status === 'ready');

  let shiftId;
  if (existingOffered && existingOffered.status !== 'completed') {
    // Check if this shift is at a welfare-test site (welfareCheckIntervalMinutes configured)
    shiftId = existingOffered.id;
    console.log(`Reusing existing shift id=${shiftId} status=${existingOffered.status} start=${existingOffered.start}`);
  } else {
    // Find a conflict-free date
    const occupied = new Set(shifts.map(s => s.start?.slice(0, 10)));
    let testDate = '2026-12-01';
    while (occupied.has(testDate)) {
      const d = new Date(testDate);
      d.setDate(d.getDate() + 1);
      testDate = d.toISOString().slice(0, 10);
    }
    console.log(`Using conflict-free date: ${testDate}`);

    // Guard A applies for the job
    const appRes = await post('/job-applications', tG, { jobId: job.id });
    const app = must('POST /job-applications (Guard A applies)', appRes, 201);
    console.log(`Application created: id=${app.id}`);

    // Company A hires Guard A from the application (creates offered shift)
    const hireRes = await post(`/job-applications/${app.id}/hire`, tA, {
      createShift: true,
      siteId: site.id,
      start: `${testDate}T08:00:00.000Z`,
      end:   `${testDate}T16:00:00.000Z`,
    });
    const hireData = must('POST /job-applications/:id/hire', hireRes, 201);
    shiftId = hireData.shiftBundle?.shift?.id;
    if (!shiftId) throw new Error(`No shiftId in hire response: ${JSON.stringify(hireData)}`);
  }
  console.log(`Shift ready for test: id=${shiftId}`);

  // Guard accepts shift
  const currentShift = must('GET /shifts/:id', await get(`/shifts/${shiftId}`, tG));
  if (currentShift.status === 'ready') {
    console.log(`Shift already accepted (status=ready), skipping accept`);
  } else {
    must('Guard accepts shift', await patch(`/shifts/${shiftId}/respond`, tG, { response: 'accepted' }));
    console.log(`Guard accepted shift: status=ready`);
  }

  // Guard checks in via API (no GPS required at this site)
  const checkInRes = await post('/attendance/check-in', tG, { shiftId });
  const checkIn = must('POST /attendance/check-in', checkInRes, 201);
  const checkInTime = checkIn.occurredAt ?? new Date().toISOString();
  console.log(`Check-in: eventId=${checkIn.id} occurredAt=${checkInTime} gpsVerified=${checkIn.gpsVerified}`);

  // Confirm shift is now in_progress
  const shiftNow = must('GET /shifts/:id (after check-in)', await get(`/shifts/${shiftId}`, tG));
  console.log(`Shift status: ${shiftNow.status}`);
  if (shiftNow.status !== 'in_progress') throw new Error(`Expected in_progress, got ${shiftNow.status}`);

  const deadlineMs = new Date(checkInTime).getTime() + 5 * 60 * 1000;
  const deadlineISO = new Date(deadlineMs).toISOString();

  console.log('\n=== WELFARE TEST SETUP COMPLETE ===');
  console.log(`SHIFT_ID=${shiftId}`);
  console.log(`SITE_ID=${site.id}`);
  console.log(`CHECK_IN_TIME=${checkInTime}`);
  console.log(`WELFARE_DEADLINE=${deadlineISO}  (5 min after check-in)`);
  console.log(`SCHEDULER_MAX_WAIT=10 minutes after check-in`);
  console.log('\nDo NOT submit any welfare check (daily log with logType=welfare_check) for this shift.');
  console.log('Wait until after the deadline, then verify with:');
  console.log('  GET /alerts/company  (as Company A)');
  console.log(`Expect: a safety alert with type=missed_checkcall for shiftId=${shiftId}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
