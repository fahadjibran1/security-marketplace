// UAT: compliance document upload script — Company A uploads SIA + RTW for Guard A
// Run with: node uat_upload.mjs
// Deletes itself after successful execution.

import https from 'node:https';
import http from 'node:http';

const BASE = 'https://security-marketplace-api.onrender.com';

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) {
      if (typeof body === 'string') req.write(body, 'utf8');
      else req.write(body);
    }
    req.end();
  });
}

async function apiPost(path, token, jsonBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await request(`${BASE}${path}`, { method: 'POST', headers }, JSON.stringify(jsonBody));
  if (r.status >= 400) throw new Error(`POST ${path} → HTTP ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function apiGet(path, token) {
  const r = await request(`${BASE}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (r.status >= 400) throw new Error(`GET ${path} → HTTP ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function s3Put(url, pdfBytes) {
  const r = await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'Content-Length': pdfBytes.length } }, pdfBytes);
  return r.status;
}

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');

async function main() {
  // Login
  const loginA = await apiPost('/auth/login', null, { email: 'uat-company-a@example.com', password: 'UatPass!2026A' });
  const tokenA = loginA.accessToken;
  console.log(`CompanyA: userId=${loginA.user.id} companyId=${loginA.user.companyId}`);

  const loginG = await apiPost('/auth/login', null, { email: 'uat-guard-a@example.com', password: 'UatPass!2026G' });
  const tokenG = loginG.accessToken;
  console.log(`Guard: userId=${loginG.user.id} guardId=${loginG.user.guardId}`);

  const loginAdm = await apiPost('/auth/login', null, { email: 'vesoftservices@gmail.com', password: 'Bal0ch!stan1' });
  const tokenAdm = loginAdm.accessToken;
  console.log(`Admin: userId=${loginAdm.user.id} role=${loginAdm.user.role}`);

  // --- Compliance documents (Company A uploads for Guard A) ---
  async function uploadDoc(type, filename, label) {
    const doc = await apiPost('/compliance/documents', tokenA, {
      guardId: 7, type, originalFileName: filename,
      mimeType: 'application/pdf', sizeBytes: PDF.length
    });
    console.log(`${label} doc created: id=${doc.id} upload.url=${doc.upload?.url ? 'present' : 'MISSING'}`);

    const s3Status = await s3Put(doc.upload.url, PDF);
    console.log(`${label} S3 PUT: HTTP ${s3Status}`);

    if (s3Status >= 200 && s3Status < 300) {
      const comp = await apiPost(`/compliance/documents/${doc.id}/complete-upload`, tokenA, {});
      console.log(`${label} complete-upload: uploadCompletedAt=${comp.uploadCompletedAt} verified=${comp.verified}`);
      return doc.id;
    }
    throw new Error(`${label} S3 upload failed with HTTP ${s3Status}`);
  }

  const siaDocId = await uploadDoc('sia_licence', 'uat-sia.pdf', 'SIA');
  const rtwDocId = await uploadDoc('right_to_work', 'uat-rtw.pdf', 'RTW');

  // --- Company A verifies both documents ---
  const siaVerify = await request(`${BASE}/compliance/documents/${siaDocId}/verify`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
  }, JSON.stringify({ verified: true }));
  const siaVerifyData = JSON.parse(siaVerify.body);
  console.log(`SIA verify HTTP ${siaVerify.status}: verified=${siaVerifyData.verified}`);

  const rtwVerify = await request(`${BASE}/compliance/documents/${rtwDocId}/verify`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
  }, JSON.stringify({ verified: true }));
  const rtwVerifyData = JSON.parse(rtwVerify.body);
  console.log(`RTW verify HTTP ${rtwVerify.status}: verified=${rtwVerifyData.verified}`);

  // --- Guard checks own compliance status ---
  const compStatus = await apiGet('/compliance/mine/status', tokenG);
  console.log(`Guard compliance: status=${compStatus.complianceStatus} assignable=${compStatus.assignable}`);
  console.log(`Blocking reasons: ${JSON.stringify(compStatus.blockingReasons)}`);

  console.log(`\nSIA_DOC_ID=${siaDocId}  RTW_DOC_ID=${rtwDocId}`);
  console.log('Done.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
