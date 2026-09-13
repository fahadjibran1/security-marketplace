// uat_screening.mjs — Full BS7858-style screening workflow: Guard A → VETTED
// Run with: node uat_screening.mjs

import https from 'node:https';

const BASE = 'https://security-marketplace-api.onrender.com';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');

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
  return JSON.parse(r.body);
}

const post = (path, tok, body = {}) => api('POST', path, tok, body);
const put  = (path, tok, body)     => api('PUT',  path, tok, body);
const get  = (path, tok)           => api('GET',  path, tok);
const patch = (path, tok, body)    => api('PATCH', path, tok, body);

async function s3Put(url) {
  const r = await raw(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length },
  }, PDF);
  return r.status;
}

async function uploadEvidence(tok, category, filename) {
  const ev = await post('/screening/mine/evidence', tok, {
    category, originalFileName: filename, mimeType: 'application/pdf', sizeBytes: PDF.length,
  });
  console.log(`  evidence ${category}: id=${ev.id}`);
  const s3 = await s3Put(ev.upload.url);
  if (s3 < 200 || s3 >= 300) throw new Error(`S3 PUT failed for ${category}: HTTP ${s3}`);
  console.log(`  S3 ${category}: HTTP ${s3}`);
  return ev.id;
}

async function main() {
  // Login
  const loginG = await post('/auth/login', null, { email: 'uat-guard-a@example.com', password: 'UatPass!2026G' });
  const tG = loginG.accessToken;
  console.log(`Guard: userId=${loginG.user.id} guardId=${loginG.user.guardId}`);

  const loginAdm = await post('/auth/login', null, { email: 'vesoftservices@gmail.com', password: 'Bal0ch!stan1' });
  const tAdm = loginAdm.accessToken;
  console.log(`Admin: userId=${loginAdm.user.id}`);

  // ---- GUARD STEPS ----

  // 1. Start (idempotent)
  const sc = await post('/screening/mine/start', tG, { screeningPeriodYears: 5 });
  const scId = sc.id;
  console.log(`Screening: id=${scId} status=${sc.status}`);

  // 2. Profile
  await put('/screening/mine/profile', tG, {
    legalFullName: 'UAT Guard Alpha',
    dateOfBirth: '1990-06-15',
    nationality: 'British',
  });
  console.log('Profile: OK');

  // 3. History — 5-year continuous window (2021-08-28 to 2026-08-28)
  //    Entry 1: 2020-01-01 → 2024-03-01 (not current)
  //    Entry 2: 2024-03-01 → present (current, overlaps entry 1 end by 1 day — assessContinuousHistory allows overlap)
  const h1 = await post('/screening/mine/history', tG, {
    type: 'EMPLOYMENT',
    startDate: '2020-01-01',
    endDate: '2024-03-01',
    isCurrent: false,
    organisation: 'UAT Security Ltd',
    description: 'Security officer — full-time. UAT test employment record covering the early portion of the 5-year screening window.',
  });
  console.log(`History 1 (past employment): id=${h1.id}`);

  const h2 = await post('/screening/mine/history', tG, {
    type: 'EMPLOYMENT',
    startDate: '2024-03-01',
    isCurrent: true,
    organisation: 'UAT Active Security',
    description: 'Security officer — full-time. UAT test employment record for the current portion of the screening window.',
  });
  console.log(`History 2 (current employment): id=${h2.id}`);

  // 4. Addresses — 5-year continuous window
  await post('/screening/mine/addresses', tG, {
    address: '10 UAT Road, London',
    startDate: '2019-01-01',
    endDate: '2022-03-01',
    isCurrent: false,
  });
  console.log('Address 1 (past): OK');

  await post('/screening/mine/addresses', tG, {
    address: '20 UAT Avenue, London',
    startDate: '2022-03-01',
    isCurrent: true,
  });
  console.log('Address 2 (current): OK');

  // 5. Reference (linked to current employment)
  await post('/screening/mine/references', tG, {
    historyId: h2.id,
    organisation: 'UAT Active Security',
    contactPerson: 'Jane Smith',
    relationship: 'Line Manager',
    businessEmail: 'ref@uat-active-security.example.com',
  });
  console.log('Reference: OK');

  // 6. Consent
  await post('/screening/mine/consent', tG, { consentVersion: 'v1.0' });
  console.log('Consent: OK');

  // 7. Evidence × 4 — upload to Supabase S3 via presigned URLs
  console.log('Uploading evidence...');
  const evIdent = await uploadEvidence(tG, 'identity',      'uat-identity.pdf');
  const evAddr  = await uploadEvidence(tG, 'address',       'uat-address.pdf');
  const evSia   = await uploadEvidence(tG, 'sia',           'uat-sia-evidence.pdf');
  const evRtw   = await uploadEvidence(tG, 'right_to_work', 'uat-rtw-evidence.pdf');

  // 8. Complete evidence uploads (marks uploadCompletedAt and verifies S3 object exists)
  await post(`/screening/evidence/${evIdent}/complete-upload`, tG);
  await post(`/screening/evidence/${evAddr}/complete-upload`,  tG);
  await post(`/screening/evidence/${evSia}/complete-upload`,   tG);
  await post(`/screening/evidence/${evRtw}/complete-upload`,   tG);
  console.log('Evidence uploads completed');

  // 9. Submit → READY_FOR_REVIEW
  const submitted = await post('/screening/mine/submit', tG);
  console.log(`Submitted: status=${submitted.status} progress=${submitted.progress}%`);
  if (submitted.status !== 'READY_FOR_REVIEW') throw new Error(`Expected READY_FOR_REVIEW, got ${submitted.status}`);

  // ---- ADMIN STEPS ----

  // 10. Start review → UNDER_REVIEW
  await post(`/screening/${scId}/start-review`, tAdm);
  console.log(`Admin: review started for screening ${scId}`);

  // 11. Verify 4 checks — each sets screening-level flag AND evidence verificationState
  await patch(`/screening/${scId}/checks/identity`, tAdm, {
    state: 'VERIFIED', method: 'Passport review', evidenceId: evIdent,
  });
  console.log('Check identity: VERIFIED');

  await patch(`/screening/${scId}/checks/address`, tAdm, {
    state: 'VERIFIED', method: 'Utility bill review', evidenceId: evAddr,
  });
  console.log('Check address: VERIFIED');

  await patch(`/screening/${scId}/checks/sia`, tAdm, {
    state: 'VERIFIED', method: 'SIA register online check', evidenceId: evSia,
  });
  console.log('Check sia: VERIFIED');

  await patch(`/screening/${scId}/checks/rtw`, tAdm, {
    state: 'VERIFIED', method: 'Share code check', evidenceId: evRtw,
  });
  console.log('Check rtw: VERIFIED');

  // 12. Get reference ID from admin view
  const scFull = await get(`/screening/${scId}`, tAdm);
  const refId = scFull.references?.[0]?.id;
  if (!refId) throw new Error('No reference found in screening file');
  console.log(`Reference: id=${refId}`);

  // 13. Review reference → VERIFIED with source verification confirmed
  await patch(`/screening/${scId}/references/${refId}/review`, tAdm, {
    status: 'VERIFIED',
    verificationMethod: 'Telephone call',
    notes: 'UAT: Reference verified via telephone call. Employment dates and responsibilities confirmed with line manager Jane Smith.',
    confirmed: true,
  });
  console.log('Reference: VERIFIED (source-verified)');

  // 14. Complete → VETTED
  const done = await post(`/screening/${scId}/complete`, tAdm, {
    reason: 'UAT: All checks verified. Identity, address, SIA and RTW confirmed. Source-verified reference received. Guard screening complete — UAT evidence.',
  });
  console.log(`Screening complete: status=${done.status} vettedAt=${done.vettedAt}`);

  if (done.status !== 'VETTED') throw new Error(`Expected VETTED, got ${done.status}`);

  // 15. Guard verifies own screening status
  const mineStatus = await get('/screening/mine', tG);
  console.log(`Guard /screening/mine: status=${mineStatus.status} progress=${mineStatus.progress}%`);

  console.log(`\nSCREENING_ID=${scId}`);
  console.log('Guard A is VETTED. Hire tests can now proceed.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
