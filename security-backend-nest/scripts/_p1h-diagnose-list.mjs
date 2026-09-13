// Diagnose GET /timesheets/weekly-approvals 400
import https from 'https';

const BASE = 'https://security-marketplace-api-staging.onrender.com';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

console.log('Step 1: Login p1gb-co-a-admin (company admin for company 6)...');
const loginRes = await req('POST', '/auth/login', { email: 'p1gb-co-a-admin@staging.test', password: 'P1GB_CoAdmin!2026' });
console.log('LOGIN STATUS:', loginRes.status);
if (loginRes.status !== 201 && loginRes.status !== 200) {
  console.log('LOGIN BODY:', JSON.stringify(loginRes.body, null, 2));
  process.exit(1);
}
const token = loginRes.body?.accessToken || loginRes.body?.access_token;
console.log('TOKEN (first 40):', token?.substring(0, 40) + '...');
console.log('USER:', JSON.stringify({ sub: loginRes.body?.user?.id, role: loginRes.body?.user?.role }));

console.log('\nStep 2: GET /timesheets/weekly-approvals (no query params)...');
const listRes = await req('GET', '/timesheets/weekly-approvals', null, token);
console.log('STATUS:', listRes.status);
console.log('BODY:', JSON.stringify(listRes.body, null, 2));

console.log('\nStep 3: GET /timesheets/weekly-approvals?status=pending_approval...');
const listRes2 = await req('GET', '/timesheets/weekly-approvals?status=pending_approval', null, token);
console.log('STATUS:', listRes2.status);
console.log('BODY:', JSON.stringify(listRes2.body, null, 2).substring(0, 300));

console.log('\nStep 4: GET /timesheets (baseline — should work)...');
const baseRes = await req('GET', '/timesheets', null, token);
console.log('STATUS:', baseRes.status);
