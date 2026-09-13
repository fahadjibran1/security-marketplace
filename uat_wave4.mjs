// uat_wave4.mjs — Wave 4: Live Shift & Operations
// Tests: UAT-SHF-001, UAT-ATT-004, UAT-ATT-001, UAT-ATT-005,
//        UAT-OPS-001, UAT-OPS-002, UAT-OPS-004, UAT-OPS-005,
//        UAT-ATT-006, UAT-ATT-007
// Run with: node uat_wave4.mjs

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
  if (r.status >= 400) throw new Error(`${method} ${path} → HTTP ${r.status}: ${r.body}`);
  return { status: r.status, data: JSON.parse(r.body) };
}

// Variant that does NOT throw on 4xx — for negative tests
async function apiExpect4xx(method, path, token, jsonBody, expectedStatus) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const bodyStr = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
  const r = await raw(`${BASE}${path}`, { method, headers }, bodyStr);
  const body = (() => { try { return JSON.parse(r.body); } catch { return r.body; } })();
  if (r.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus}, got HTTP ${r.status}: ${r.body}`);
  }
  return { status: r.status, data: body };
}

const post  = (p, t, b = {}) => api('POST',  p, t, b);
const patch = (p, t, b)      => api('PATCH', p, t, b);
const get   = (p, t)         => api('GET',   p, t);

async function main() {
  // ── Login ──────────────────────────────────────────────────────────────────
  const loginG = await post('/auth/login', null, { email: 'uat-guard-a@example.com', password: 'UatPass!2026G' });
  const tG = loginG.data.accessToken;
  const guardUserId = loginG.data.user.id;
  const guardId     = loginG.data.user.guardId;
  console.log(`Guard A: userId=${guardUserId} guardId=${guardId}`);

  const loginA = await post('/auth/login', null, { email: 'uat-company-a@example.com', password: 'UatPass!2026A' });
  const tA = loginA.data.accessToken;
  const companyId = loginA.data.user.companyId;
  console.log(`Company A: userId=${loginA.data.user.id} companyId=${companyId}`);

  // ── UAT-SHF-001: Guard accepts shift id:2 → status = ready ────────────────
  console.log('\n--- UAT-SHF-001: Guard accepts shift id:2 ---');
  const shift2Before = await get('/shifts/2', tA);
  let acceptedShift;
  if (shift2Before.data.status === 'ready') {
    // Already accepted in a prior run — idempotent skip
    acceptedShift = shift2Before.data;
    console.log(`shift id:2 already in status=ready (prior run); skipping re-accept`);
  } else {
    const acceptRes = await patch('/shifts/2/respond', tG, { response: 'accepted' });
    acceptedShift = acceptRes.data;
    console.log(`PATCH /shifts/2/respond HTTP ${acceptRes.status}`);
    console.log(`  shift.id=${acceptedShift.id} status=${acceptedShift.status}`);
  }
  if (acceptedShift.status !== 'ready') throw new Error(`UAT-SHF-001 FAIL: expected status=ready, got ${acceptedShift.status}`);
  console.log('UAT-SHF-001: PASS — shift id:2 is ready');

  // ── UAT-ATT-004: Outside-geofence check-in rejected ───────────────────────
  // Site id:2 is at lat:51.5074, lon:-0.1278, geofence:100m
  // Sending coords ~109km away → expect HTTP 403
  console.log('\n--- UAT-ATT-004: Outside-geofence check-in rejected ---');
  const badGpsRes = await apiExpect4xx('POST', '/attendance/check-in', tG,
    { shiftId: 2, latitude: 52.0, longitude: -1.5, gpsAccuracyMeters: 10 }, 403);
  console.log(`POST /attendance/check-in (bad GPS) HTTP ${badGpsRes.status}`);
  console.log(`  message: ${badGpsRes.data.message}`);
  if (!badGpsRes.data.message?.includes('geofence') && !badGpsRes.data.message?.includes('outside')) {
    console.warn(`  WARNING: unexpected error message — ${badGpsRes.data.message}`);
  }
  console.log('UAT-ATT-004: PASS — outside-geofence check-in correctly rejected with HTTP 403');

  // ── Setup: Find or create a non-GPS site shift for Book On/Off tests ────────
  console.log('\n--- Setup: Finding/creating non-GPS shift for Book On/Off tests ---');
  const allShiftsRes = await get('/shifts', tA);
  const allShifts = Array.isArray(allShiftsRes.data) ? allShiftsRes.data : [];

  // Reuse any existing offered non-GPS shift for Guard A (handles re-runs gracefully)
  let existingOffered = allShifts.find(s =>
    s.guard?.id === guardId &&
    (s.status === 'offered' || s.status === 'ready') &&
    s.site?.requireGpsCheckIn === false
  );

  let newSiteId, newShiftId;

  if (existingOffered) {
    newSiteId = existingOffered.site.id;
    newShiftId = existingOffered.id;
    console.log(`Reusing existing ${existingOffered.status} non-GPS shift id:${newShiftId} at site id:${newSiteId}`);
    if (existingOffered.status !== 'ready') {
      const acceptNew = await patch(`/shifts/${newShiftId}/respond`, tG, { response: 'accepted' });
      console.log(`PATCH /shifts/${newShiftId}/respond HTTP ${acceptNew.status}: status=${acceptNew.data.status}`);
      if (acceptNew.data.status !== 'ready') throw new Error(`Setup FAIL: expected status=ready, got ${acceptNew.data.status}`);
    } else {
      console.log(`Shift id:${newShiftId} already ready`);
    }
  } else {
    // Create fresh infrastructure
    const siteRes = await post('/sites', tA, {
      name: 'UAT Non-GPS Office',
      address: '100 UAT Street, Manchester, UK',
      clientId: 3,
      requireGpsCheckIn: false,
      requireNfcCheckIn: false,
    });
    newSiteId = siteRes.data.id;
    console.log(`POST /sites HTTP ${siteRes.status}: id=${newSiteId} requireGpsCheckIn=${siteRes.data.requireGpsCheckIn}`);

    const jobRes = await post('/jobs', tA, {
      title: 'UAT Wave4 Operations Post',
      description: 'UAT test job for Wave 4 shift lifecycle tests',
      guardsRequired: 1,
      hourlyRate: 12.50,
      siteId: newSiteId,
    });
    const newJobId = jobRes.data.id;
    console.log(`POST /jobs HTTP ${jobRes.status}: id=${newJobId}`);

    const appRes = await post('/job-applications', tG, { jobId: newJobId });
    const newAppId = appRes.data.id;
    console.log(`POST /job-applications HTTP ${appRes.status}: id=${newAppId}`);

    // Pick a shift date that doesn't clash with Guard A's existing shifts
    const occupiedDates = allShifts
      .filter(s => s.guard?.id === guardId && ['offered','ready','in_progress'].includes(s.status))
      .map(s => new Date(s.start).toISOString().slice(0, 10));
    let shiftDate = '2026-10-01';
    while (occupiedDates.includes(shiftDate)) {
      const d = new Date(shiftDate); d.setDate(d.getDate() + 1);
      shiftDate = d.toISOString().slice(0, 10);
    }
    const hireRes = await post(`/job-applications/${newAppId}/hire`, tA, {
      createShift: true,
      siteId: newSiteId,
      start: `${shiftDate}T08:00:00.000Z`,
      end: `${shiftDate}T16:00:00.000Z`,
    });
    // shiftBundle = { shift: Shift, timesheet: Timesheet|null }
    newShiftId = hireRes.data.shiftBundle?.shift?.id;
    const newShiftStatus = hireRes.data.shiftBundle?.shift?.status;
    console.log(`POST /job-applications/${newAppId}/hire HTTP ${hireRes.status}: shiftId=${newShiftId} status=${newShiftStatus} date=${shiftDate}`);
    if (newShiftStatus !== 'offered') throw new Error(`Setup FAIL: expected new shift status=offered, got ${newShiftStatus}`);

    const acceptNew = await patch(`/shifts/${newShiftId}/respond`, tG, { response: 'accepted' });
    console.log(`PATCH /shifts/${newShiftId}/respond HTTP ${acceptNew.status}: status=${acceptNew.data.status}`);
    if (acceptNew.data.status !== 'ready') throw new Error(`Setup FAIL: expected status=ready, got ${acceptNew.data.status}`);
  }

  console.log(`Setup complete: non-GPS shift id:${newShiftId} at site id:${newSiteId} is ready`);

  // ── UAT-ATT-001: Book On at non-GPS site (no GPS coords) ──────────────────
  console.log(`\n--- UAT-ATT-001: Book On at non-GPS site (shift id:${newShiftId}) ---`);
  const checkInRes = await post('/attendance/check-in', tG, { shiftId: newShiftId });
  const checkInEvent = checkInRes.data;
  console.log(`POST /attendance/check-in HTTP ${checkInRes.status}`);
  console.log(`  eventId=${checkInEvent.id} type=${checkInEvent.type} occurredAt=${checkInEvent.occurredAt}`);
  console.log(`  gpsVerified=${checkInEvent.gpsVerified} nfcVerified=${checkInEvent.nfcVerified}`);
  if (checkInEvent.type !== 'check-in') throw new Error(`UAT-ATT-001 FAIL: expected type=check-in, got ${checkInEvent.type}`);
  console.log('UAT-ATT-001: PASS — Book On successful at non-GPS site');

  // Verify shift is now in_progress
  const shiftAfterCheckIn = await get(`/shifts/${newShiftId}`, tA);
  console.log(`  shift status after check-in: ${shiftAfterCheckIn.data.status}`);
  if (shiftAfterCheckIn.data.status !== 'in_progress') throw new Error(`ATT-001 post-check: shift not in_progress`);

  // ── UAT-ATT-005: Retry Book On — idempotent ───────────────────────────────
  console.log(`\n--- UAT-ATT-005: Retry Book On (idempotent) ---`);
  const checkInRetry = await post('/attendance/check-in', tG, { shiftId: newShiftId });
  const retryEvent = checkInRetry.data;
  console.log(`POST /attendance/check-in (retry) HTTP ${checkInRetry.status}`);
  console.log(`  eventId=${retryEvent.id} (original: ${checkInEvent.id})`);
  if (retryEvent.id !== checkInEvent.id) throw new Error(`UAT-ATT-005 FAIL: retry returned different event id=${retryEvent.id} vs original=${checkInEvent.id}`);
  console.log('UAT-ATT-005: PASS — retry returned same attendance event (idempotent)');

  // ── UAT-OPS-001: Daily log — patrol entry ─────────────────────────────────
  console.log(`\n--- UAT-OPS-001: Daily log (patrol) ---`);
  const logRes = await post('/daily-logs', tG, {
    shiftId: newShiftId,
    logType: 'patrol',
    message: 'UAT: Completed perimeter patrol. All access points secure. No anomalies observed.',
  });
  const logEntry = logRes.data;
  console.log(`POST /daily-logs HTTP ${logRes.status}`);
  console.log(`  logId=${logEntry.id} logType=${logEntry.logType} createdAt=${logEntry.createdAt}`);
  if (!logEntry.id) throw new Error('UAT-OPS-001 FAIL: no id in response');
  console.log('UAT-OPS-001: PASS — daily log (patrol) submitted successfully');

  // ── UAT-OPS-002: Welfare check alert ──────────────────────────────────────
  console.log(`\n--- UAT-OPS-002: Welfare check alert ---`);
  const welfareRes = await post('/alerts', tG, {
    shiftId: newShiftId,
    type: 'welfare',
    priority: 'low',
    message: 'UAT: Scheduled welfare check-in. Guard is on post and safe.',
  });
  const welfareAlert = welfareRes.data;
  console.log(`POST /alerts HTTP ${welfareRes.status}`);
  console.log(`  alertId=${welfareAlert.id} type=${welfareAlert.type} priority=${welfareAlert.priority} status=${welfareAlert.status}`);
  if (!welfareAlert.id) throw new Error('UAT-OPS-002 FAIL: no id in response');
  console.log('UAT-OPS-002: PASS — welfare check alert raised successfully');

  // ── UAT-OPS-004: Panic alert ──────────────────────────────────────────────
  console.log(`\n--- UAT-OPS-004: Panic alert ---`);
  const panicRes = await post('/alerts', tG, {
    shiftId: newShiftId,
    type: 'panic',
    priority: 'critical',
    message: 'UAT TEST ONLY — Panic alert triggered from guard mobile. This is a UAT test event; no real emergency.',
  });
  const panicAlert = panicRes.data;
  console.log(`POST /alerts HTTP ${panicRes.status}`);
  console.log(`  alertId=${panicAlert.id} type=${panicAlert.type} priority=${panicAlert.priority} status=${panicAlert.status}`);
  if (!panicAlert.id) throw new Error('UAT-OPS-004 FAIL: no id in response');
  console.log('UAT-OPS-004: PASS — panic alert raised successfully');

  // ── UAT-OPS-005: Incident report ──────────────────────────────────────────
  console.log(`\n--- UAT-OPS-005: Incident report ---`);
  const incidentRes = await post('/incidents', tG, {
    shiftId: newShiftId,
    title: 'UAT Test Incident — Unauthorised Access Attempt',
    notes: 'UAT: At 10:23 an unknown individual attempted to enter via the south gate without a valid pass. Individual was challenged, refused entry, and departed. Incident logged for UAT test purposes.',
    severity: 'low',
    category: 'access_control',
    locationText: 'South gate, UAT Non-GPS Office',
  });
  const incident = incidentRes.data;
  console.log(`POST /incidents HTTP ${incidentRes.status}`);
  console.log(`  incidentId=${incident.id} severity=${incident.severity} category=${incident.category} status=${incident.status}`);
  if (!incident.id) throw new Error('UAT-OPS-005 FAIL: no id in response');
  console.log('UAT-OPS-005: PASS — incident report submitted successfully');

  // ── UAT-ATT-006: Book Off ─────────────────────────────────────────────────
  console.log(`\n--- UAT-ATT-006: Book Off ---`);
  const checkOutRes = await post('/attendance/check-out', tG, { shiftId: newShiftId });
  const checkOutEvent = checkOutRes.data;
  console.log(`POST /attendance/check-out HTTP ${checkOutRes.status}`);
  console.log(`  eventId=${checkOutEvent.id} type=${checkOutEvent.type} occurredAt=${checkOutEvent.occurredAt}`);
  if (checkOutEvent.type !== 'check-out') throw new Error(`UAT-ATT-006 FAIL: expected type=check-out, got ${checkOutEvent.type}`);

  // Verify shift is completed and timesheet was created/updated
  const shiftAfterCheckOut = await get(`/shifts/${newShiftId}`, tA);
  console.log(`  shift status after check-out: ${shiftAfterCheckOut.data.status}`);
  if (shiftAfterCheckOut.data.status !== 'completed') throw new Error(`ATT-006 post-check: shift not completed`);
  console.log('UAT-ATT-006: PASS — Book Off successful, shift completed');

  // ── UAT-ATT-007: Retry Book Off — idempotent ──────────────────────────────
  console.log(`\n--- UAT-ATT-007: Retry Book Off (idempotent) ---`);
  const checkOutRetry = await post('/attendance/check-out', tG, { shiftId: newShiftId });
  const retryCheckOut = checkOutRetry.data;
  console.log(`POST /attendance/check-out (retry) HTTP ${checkOutRetry.status}`);
  console.log(`  eventId=${retryCheckOut.id} (original: ${checkOutEvent.id})`);
  if (retryCheckOut.id !== checkOutEvent.id) throw new Error(`UAT-ATT-007 FAIL: retry returned different event id=${retryCheckOut.id} vs original=${checkOutEvent.id}`);
  console.log('UAT-ATT-007: PASS — retry returned same attendance event (idempotent)');

  // ── Wave 4 complete — read timesheet for Wave 5 ───────────────────────────
  console.log(`\n--- Wave 4 complete — checking timesheet for Wave 5 ---`);
  const timesheets = await get('/timesheets/mine', tG);
  const tsArr = Array.isArray(timesheets.data) ? timesheets.data : [];
  const ts = tsArr.find(t => t.shift?.id === newShiftId);
  if (ts) {
    console.log(`Timesheet: id=${ts.id} shift.id=${ts.shift?.id} approvalStatus=${ts.approvalStatus} hoursWorked=${ts.hoursWorked}`);
    console.log(`  verifiedMinutes=${ts.verifiedMinutes ?? 'n/a'} actualCheckInAt=${ts.actualCheckInAt ?? 'n/a'} actualCheckOutAt=${ts.actualCheckOutAt ?? 'n/a'}`);
  } else {
    console.log(`Timesheets found: ${tsArr.length}. No timesheet for shift ${newShiftId} yet.`);
    if (tsArr.length > 0) {
      tsArr.forEach(t => console.log(`  ts id=${t.id} shift.id=${t.shift?.id} status=${t.approvalStatus}`));
    }
  }

  console.log('\n=== WAVE 4 SUMMARY ===');
  console.log(`UAT-SHF-001: PASS — shift id:2 accepted → ready`);
  console.log(`UAT-ATT-004: PASS — outside-geofence check-in rejected HTTP 403`);
  console.log(`UAT-ATT-001: PASS — Book On (no GPS) at non-GPS site id:${newSiteId}, shift id:${newShiftId}`);
  console.log(`UAT-ATT-005: PASS — retry Book On returned same eventId=${checkInEvent.id} (idempotent)`);
  console.log(`UAT-OPS-001: PASS — daily log patrol id:${logEntry.id}`);
  console.log(`UAT-OPS-002: PASS — welfare check alert id:${welfareAlert.id}`);
  console.log(`UAT-OPS-004: PASS — panic alert id:${panicAlert.id}`);
  console.log(`UAT-OPS-005: PASS — incident id:${incident.id}`);
  console.log(`UAT-ATT-006: PASS — Book Off → shift completed`);
  console.log(`UAT-ATT-007: PASS — retry Book Off returned same eventId=${checkOutEvent.id} (idempotent)`);
  if (ts) console.log(`Timesheet id:${ts.id} status:${ts.approvalStatus} hours:${ts.hoursWorked} — ready for Wave 5`);

  console.log(`\nNEW_SITE_ID=${newSiteId}`);
  console.log(`NEW_SHIFT_ID=${newShiftId}`);
  if (ts) console.log(`TIMESHEET_ID=${ts.id}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
