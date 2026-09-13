// uat_wave6.mjs — Wave 6: Client Portal Isolation (UAT-CLI-001)
// Run with: node uat_wave6.mjs

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

const get   = (path, tok) => api('GET',   path, tok);
const post  = (path, tok, body) => api('POST',  path, tok, body);
const put   = (path, tok, body) => api('PUT',   path, tok, body);

function must(label, res, expectedStatus = 200) {
  if (res.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function mustFail(label, res, expectedStatus) {
  if (res.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus} (isolation), got ${res.status}: ${JSON.stringify(res.data)}`);
  }
  console.log(`  ${label}: HTTP ${res.status} — isolation enforced`);
  return res.data;
}

async function main() {
  // ---- Auth ----
  const loginA = await post('/auth/login', null, { email: 'uat-company-a@example.com', password: 'UatPass!2026A' });
  must('Company A login', loginA, 201);
  const tA = loginA.data.accessToken;
  console.log(`Company A: companyId=${loginA.data.user.companyId}`);

  // ---- List existing clients ----
  const clientsRes = await get('/clients', tA);
  const clients = must('GET /clients', clientsRes);
  console.log(`Existing clients: ${clients.map(c => `id=${c.id} name=${c.name}`).join(', ')}`);

  // Client A is clientId=3 — UAT Client A
  const clientAId = 3;

  // ---- Create Client B for isolation test (idempotent) ----
  let clientBId;
  const existingClientB = clients.find(c => c.name === 'UAT Client B');
  if (existingClientB) {
    clientBId = existingClientB.id;
    console.log(`Client B: reusing id=${clientBId}`);
  } else {
    const clientBRes = await post('/clients', tA, {
      name: 'UAT Client B',
      contactName: 'UAT Contact B',
      contactEmail: 'uat-client-b@example.com',
    });
    const clientB = must('POST /clients (Client B)', clientBRes, 201);
    clientBId = clientB.id;
    console.log(`Client B: created id=${clientBId}`);
  }

  // ---- Upsert client portal user for Client A (idempotent) ----
  const existingPortalUsersA = await get(`/client-portal-users/client/${clientAId}`, tA);
  const portalUsersA = must(`GET /client-portal-users/client/${clientAId}`, existingPortalUsersA);
  const existingUserA = portalUsersA.find(u => u.email === 'uat-clientportal-a@example.com');

  const clientPortalUserAPayload = {
    clientId: clientAId,
    email: 'uat-clientportal-a@example.com',
    password: 'UatClientPass!2026A',
    firstName: 'UAT Client',
    lastName: 'Portal Admin A',
    role: 'client_admin',
    isActive: true,
  };
  if (existingUserA) {
    clientPortalUserAPayload.id = existingUserA.id;
    console.log(`Client A portal user: reusing id=${existingUserA.id}`);
  }
  const puRes = await put('/client-portal-users', tA, clientPortalUserAPayload);
  const portalUserA = must('PUT /client-portal-users (Client A)', puRes, 200);
  console.log(`Client A portal user: id=${portalUserA.id} role=${portalUserA.role} isActive=${portalUserA.isActive}`);

  // ---- Upsert client portal user for Client B (isolation) ----
  const existingPortalUsersB = await get(`/client-portal-users/client/${clientBId}`, tA);
  const portalUsersB = must(`GET /client-portal-users/client/${clientBId}`, existingPortalUsersB);
  const existingUserB = portalUsersB.find(u => u.email === 'uat-clientportal-b@example.com');

  const clientPortalUserBPayload = {
    clientId: clientBId,
    email: 'uat-clientportal-b@example.com',
    password: 'UatClientPass!2026B',
    firstName: 'UAT Client',
    lastName: 'Portal Admin B',
    role: 'client_admin',
    isActive: true,
  };
  if (existingUserB) {
    clientPortalUserBPayload.id = existingUserB.id;
    console.log(`Client B portal user: reusing id=${existingUserB.id}`);
  }
  const puResB = await put('/client-portal-users', tA, clientPortalUserBPayload);
  const portalUserB = must('PUT /client-portal-users (Client B)', puResB, 200);
  console.log(`Client B portal user: id=${portalUserB.id} role=${portalUserB.role} isActive=${portalUserB.isActive}`);

  // ---- Login as Client A portal user ----
  const loginCPA = await post('/auth/client-login', null, {
    email: 'uat-clientportal-a@example.com',
    password: 'UatClientPass!2026A',
  });
  const cpaData = must('POST /auth/client-login (Client A)', loginCPA, 201);
  const tCPA = cpaData.accessToken;
  console.log(`\nClient A portal login: role=${cpaData.user.role} clientId=${cpaData.user.clientId}`);

  // ---- Verify Client A portal data ----
  const dashboard = await get('/client-portal/dashboard', tCPA);
  const dashData = must('GET /client-portal/dashboard', dashboard);
  console.log(`Dashboard: clientId=${dashData.client?.id} name="${dashData.client?.name}" activeSites=${dashData.activeSites} invoiceTotal=${dashData.invoicesSummary?.total}`);

  const sites = await get('/client-portal/sites', tCPA);
  const sitesData = must('GET /client-portal/sites', sites);
  console.log(`Sites: count=${sitesData.length}`);

  const incidents = await get('/client-portal/incidents', tCPA);
  const incidentsData = must('GET /client-portal/incidents', incidents);
  console.log(`Incidents: count=${incidentsData.length}`);

  const serviceRecords = await get('/client-portal/service-records', tCPA);
  const srData = must('GET /client-portal/service-records', serviceRecords);
  console.log(`Service records: count=${srData.length}`);

  const invoices = await get('/client-portal/invoices', tCPA);
  const invData = must('GET /client-portal/invoices', invoices);
  console.log(`Invoices: count=${invData.length} ids=${invData.map(i => i.id).join(',')}`);

  // Invoice batch 1 belongs to clientId=3 — Client A should be able to access document
  const invDocRes = await get('/client-portal/invoices/1/document', tCPA);
  const invDoc = must('GET /client-portal/invoices/1/document (Client A)', invDocRes);
  console.log(`Invoice doc: invoiceNumber=${invDoc.invoiceNumber} currency=${invDoc.currency}`);

  // ---- ISOLATION TEST 1: Company admin tries to use client portal → 403 ----
  console.log('\n--- Isolation tests ---');
  const isoAdminDash = await get('/client-portal/dashboard', tA);
  mustFail('Company admin → /client-portal/dashboard', isoAdminDash, 403);

  // ---- ISOLATION TEST 2: Client B portal user tries to access invBatch 1 (owned by Client A) ----
  const loginCPB = await post('/auth/client-login', null, {
    email: 'uat-clientportal-b@example.com',
    password: 'UatClientPass!2026B',
  });
  const cpbData = must('POST /auth/client-login (Client B)', loginCPB, 201);
  const tCPB = cpbData.accessToken;
  console.log(`Client B portal login: role=${cpbData.user.role} clientId=${cpbData.user.clientId}`);

  const isoInvDoc = await get('/client-portal/invoices/1/document', tCPB);
  mustFail('Client B → GET /client-portal/invoices/1/document (Client A owns)', isoInvDoc, 404);

  // Client B portal invoices list — should be empty (no invoices for Client B)
  const cpbInvoices = await get('/client-portal/invoices', tCPB);
  const cpbInvData = must('GET /client-portal/invoices (Client B)', cpbInvoices);
  console.log(`Client B invoices: count=${cpbInvData.length} (expect 0 — no invoices created for Client B)`);
  if (cpbInvData.length !== 0) {
    throw new Error(`Client B unexpectedly sees ${cpbInvData.length} invoice(s) — possible cross-client data leak`);
  }

  // ---- ISOLATION TEST 3: Client B portal cannot see Client A sites ----
  const cpbSites = await get('/client-portal/sites', tCPB);
  const cpbSitesData = must('GET /client-portal/sites (Client B)', cpbSites);
  console.log(`Client B sites: count=${cpbSitesData.length} (expect 0 — sites belong to Client A)`);
  if (cpbSitesData.length !== 0) {
    throw new Error(`Client B sees ${cpbSitesData.length} site(s) — possible cross-client data leak`);
  }

  console.log('\n=== UAT-CLI-001 COMPLETE ===');
  console.log(`CLIENT_A_PORTAL_USER_ID=${portalUserA.id}`);
  console.log(`CLIENT_B_PORTAL_USER_ID=${portalUserB.id}`);
  console.log(`CLIENT_B_ID=${clientBId}`);
  console.log('UAT-CLI-001: PASS — Client portal isolation verified');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
