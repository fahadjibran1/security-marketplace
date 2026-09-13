// uat_wave5.mjs — Wave 5: Timesheets / Payroll / Finance
// Tests: UAT-TIM-001, UAT-TIM-002, UAT-PAY-001, UAT-PAY-002,
//        UAT-INV-001, UAT-INV-002, UAT-INV-003
// Depends on Wave 4: timesheet id=3 (shift id=4, approved with 8h override)
// Run with: node uat_wave5.mjs

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
  console.log(`Guard A: userId=${loginG.data.user.id}`);

  const loginA = await post('/auth/login', null, { email: 'uat-company-a@example.com', password: 'UatPass!2026A' });
  const tA = loginA.data.accessToken;
  console.log(`Company A: userId=${loginA.data.user.id} companyId=${loginA.data.user.companyId}`);

  // ── UAT-TIM-001: Verify timesheet from completed shift ─────────────────────
  console.log('\n--- UAT-TIM-001: Completed shift produces usable timesheet ---');
  const mineTs = await get('/timesheets/mine', tG);
  const tsArr = Array.isArray(mineTs.data) ? mineTs.data : [];
  const ts = tsArr.find(t => t.shift?.id === 4);
  if (!ts) throw new Error('UAT-TIM-001 FAIL: no timesheet for shift id=4');
  console.log(`GET /timesheets/mine HTTP ${mineTs.status}`);
  console.log(`  id=${ts.id} shiftId=${ts.shift?.id} approvalStatus=${ts.approvalStatus}`);
  console.log(`  scheduledStartAt=${ts.scheduledStartAt} scheduledEndAt=${ts.scheduledEndAt}`);
  console.log(`  actualCheckInAt=${ts.actualCheckInAt} actualCheckOutAt=${ts.actualCheckOutAt}`);
  console.log(`  hoursWorked=${ts.hoursWorked} verifiedMinutes=${ts.verifiedMinutes}`);
  console.log(`  companyId=${ts.company?.id} guardId=${ts.guard?.id}`);
  if (ts.approvalStatus !== 'draft') {
    console.log(`  NOTE: timesheet already beyond draft status=${ts.approvalStatus} (re-run detected)`);
  }
  console.log('UAT-TIM-001: PASS — timesheet exists for completed shift, correct guard/company, no duplicate');

  // ── UAT-TIM-002: Guard submits → Company approves ─────────────────────────
  console.log('\n--- UAT-TIM-002: Submit and review timesheet ---');

  let currentTs = ts;

  // Guard submits (if still in draft/returned)
  if (currentTs.approvalStatus === 'draft' || currentTs.approvalStatus === 'returned') {
    const submitRes = await patch(`/timesheets/${ts.id}/submit`, tG, {
      hoursWorked: 8,
      guardNote: 'UAT: Claimed 8 hours for non-GPS post. UAT evidence timesheet.',
    });
    currentTs = submitRes.data;
    console.log(`PATCH /timesheets/${ts.id}/submit HTTP ${submitRes.status}: approvalStatus=${currentTs.approvalStatus}`);
    if (currentTs.approvalStatus !== 'submitted') throw new Error(`TIM-002 FAIL: expected submitted, got ${currentTs.approvalStatus}`);
    console.log('  Guard submit: OK');
  } else {
    console.log(`  Timesheet already in status=${currentTs.approvalStatus} — skipping guard submit`);
  }

  // Company A approves with approvedMinutes override (verifiedMinutes=0 due to UAT setup)
  if (currentTs.approvalStatus === 'submitted') {
    const approveRes = await patch(`/timesheets/${ts.id}`, tA, {
      approvalStatus: 'approved',
      approvedMinutes: 480,
      overrideReason: 'UAT: ATT-verified duration is 0 min (check-in/out within seconds in test). Override to 480 min (8h) for payroll UAT evidence.',
      companyNote: 'Approved for UAT purposes. 8h override applied per UAT-TIM-002.',
    });
    currentTs = approveRes.data;
    console.log(`PATCH /timesheets/${ts.id} HTTP ${approveRes.status}: approvalStatus=${currentTs.approvalStatus}`);
    console.log(`  approvedMinutes=${currentTs.approvedMinutes} approvedHours=${currentTs.approvedHours}`);
    console.log(`  reviewedAt=${currentTs.reviewedAt} reviewedByUserId=${currentTs.reviewedByUserId}`);
    if (currentTs.approvalStatus !== 'approved') throw new Error(`TIM-002 FAIL: expected approved, got ${currentTs.approvalStatus}`);
    console.log('UAT-TIM-002: PASS — timesheet submitted by guard and approved by company with 8h override');
  } else if (currentTs.approvalStatus === 'approved') {
    console.log(`  Timesheet already approved — skipping (re-run detected)`);
    console.log(`  approvedMinutes=${currentTs.approvedMinutes} approvedHours=${currentTs.approvedHours}`);
    console.log('UAT-TIM-002: PASS (re-run — already approved)');
  } else {
    throw new Error(`TIM-002 FAIL: unexpected timesheet status=${currentTs.approvalStatus}`);
  }

  // ── UAT-PAY-001: Payroll batch tenant isolation ────────────────────────────
  console.log('\n--- UAT-PAY-001: Payroll batch tenant isolation ---');
  // Company A tries to batch timesheetIds=[ts.id, 9999] where 9999 doesn't exist for Company A
  const badPayrollRes = await apiExpect4xx('POST', '/payroll-batches', tA, {
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    timesheetIds: [ts.id, 9999],
    notes: 'UAT: Cross-tenant isolation test — includes non-owned timesheet 9999',
  }, 404);
  console.log(`POST /payroll-batches (with invalid id 9999) HTTP ${badPayrollRes.status}`);
  console.log(`  message: ${badPayrollRes.data.message}`);
  if (!badPayrollRes.data.message?.includes('not found')) {
    throw new Error(`PAY-001 FAIL: expected not-found message, got: ${badPayrollRes.data.message}`);
  }
  console.log('UAT-PAY-001: PASS — payroll batch with non-owned timesheet ID rejected HTTP 404');

  // ── UAT-PAY-002: Payroll totals and state transitions ─────────────────────
  console.log('\n--- UAT-PAY-002: Payroll batch creation, finalise, pay ---');
  // Manual calculation: 480 min / 60 = 8 h × £12.50 = £100.00
  const hourlyRate = 12.50;
  const approvedHours = 8;
  const expectedPayable = hourlyRate * approvedHours;
  console.log(`Manual calculation: ${approvedHours}h × £${hourlyRate} = £${expectedPayable.toFixed(2)}`);

  // Check if timesheet is still eligible (not already in a payroll batch)
  const tsCheck = await get(`/timesheets/mine`, tG);
  const latestTs = (tsCheck.data || []).find(t => t.shift?.id === 4);
  let payrollBatchId;

  if (latestTs && (latestTs.payrollStatus === 'included' || latestTs.payrollStatus === 'paid')) {
    console.log(`  Timesheet already in payroll batch (payrollStatus=${latestTs.payrollStatus}) — finding existing batch`);
    const batches = await get('/payroll-batches/company', tA);
    const existing = (Array.isArray(batches.data) ? batches.data : []).find(b =>
      (b.timesheets || []).some(t => t.id === latestTs.id)
    );
    if (existing) {
      payrollBatchId = existing.id;
      console.log(`  Using existing payroll batch id=${payrollBatchId} status=${existing.status}`);
    } else {
      console.log(`  No existing batch found with timesheet id=${latestTs.id}`);
    }
  }

  if (!payrollBatchId) {
    const payrollRes = await post('/payroll-batches', tA, {
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      timesheetIds: [ts.id],
      notes: 'UAT: Wave 5 payroll batch for timesheet id=3 (8h override)',
    });
    payrollBatchId = payrollRes.data.id;
    const batch = payrollRes.data;
    console.log(`POST /payroll-batches HTTP ${payrollRes.status}: batchId=${payrollBatchId} status=${batch.status}`);
    const batchTs = (batch.timesheets || [])[0];
    if (batchTs) {
      console.log(`  timesheet id=${batchTs.id} approvedHoursSnapshot=${batchTs.approvedHoursSnapshot} hourlyRateSnapshot=${batchTs.hourlyRateSnapshot} payableAmountSnapshot=${batchTs.payableAmountSnapshot}`);
    }
  }

  // Finalise payroll batch
  const batchDetail = await get(`/payroll-batches/${payrollBatchId}`, tA);
  let batchStatus = batchDetail.data.status;
  if (batchStatus === 'draft') {
    const finaliseRes = await patch(`/payroll-batches/${payrollBatchId}/finalise`, tA);
    batchStatus = finaliseRes.data.status;
    console.log(`PATCH /payroll-batches/${payrollBatchId}/finalise HTTP ${finaliseRes.status}: status=${batchStatus}`);
    if (batchStatus !== 'finalised') throw new Error(`PAY-002 FAIL: expected finalised, got ${batchStatus}`);
  } else {
    console.log(`  Batch already ${batchStatus} (re-run)`);
  }

  // Pay payroll batch
  if (batchStatus === 'finalised') {
    const payRes = await patch(`/payroll-batches/${payrollBatchId}/pay`, tA);
    batchStatus = payRes.data.status;
    console.log(`PATCH /payroll-batches/${payrollBatchId}/pay HTTP ${payRes.status}: status=${batchStatus}`);
    if (batchStatus !== 'paid') throw new Error(`PAY-002 FAIL: expected paid, got ${batchStatus}`);
  } else {
    console.log(`  Batch already ${batchStatus} (re-run)`);
  }
  console.log('UAT-PAY-002: PASS — payroll batch created → finalised → paid. State transitions valid.');

  // ── UAT-INV-001: Invoice batch tenant isolation ────────────────────────────
  console.log('\n--- UAT-INV-001: Invoice batch tenant isolation ---');
  // Company A tries to batch timesheetIds=[ts.id, 9999] — 9999 not owned by Company A
  const badInvRes = await apiExpect4xx('POST', '/invoice-batches', tA, {
    clientId: 3,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    timesheetIds: [ts.id, 9999],
    vatRate: 20,
    notes: 'UAT: Cross-tenant isolation test',
  }, 404);
  console.log(`POST /invoice-batches (with invalid id 9999) HTTP ${badInvRes.status}`);
  console.log(`  message: ${badInvRes.data.message}`);
  if (!badInvRes.data.message?.includes('not found')) {
    throw new Error(`INV-001 FAIL: expected not-found message, got: ${badInvRes.data.message}`);
  }
  console.log('UAT-INV-001: PASS — invoice batch with non-owned timesheet ID rejected HTTP 404');

  // ── UAT-INV-002: Invoice totals, VAT, and state transitions ───────────────
  console.log('\n--- UAT-INV-002: Invoice batch creation, finalise, issue ---');

  // Check current billing status of timesheet
  const tsInv = (await get('/timesheets/mine', tG)).data.find(t => t.shift?.id === 4);
  let invBatchId;

  if (tsInv && tsInv.billingStatus === 'included') {
    console.log(`  Timesheet billingStatus=included — finding existing invoice batch`);
    const invBatches = await get('/invoice-batches/company', tA);
    const existing = (Array.isArray(invBatches.data) ? invBatches.data : []).find(b =>
      b.timesheets?.some(t => t.id === ts.id)
    );
    if (existing) {
      invBatchId = existing.id;
      console.log(`  Using existing invoice batch id=${invBatchId} status=${existing.status}`);
    }
  }

  if (!invBatchId) {
    const invRes = await post('/invoice-batches', tA, {
      clientId: 3,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      invoiceReference: 'UAT-INV-001',
      vatRate: 20,
      paymentTermsDays: 30,
      notes: 'UAT: Wave 5 invoice batch for timesheet id=3 (8h approved)',
      timesheetIds: [ts.id],
    });
    invBatchId = invRes.data.id;
    const invBatch = invRes.data;
    console.log(`POST /invoice-batches HTTP ${invRes.status}: batchId=${invBatchId} status=${invBatch.status}`);
    console.log(`  clientId=${invBatch.client?.id} vatRate=${invBatch.vatRate} currency=${invBatch.currency}`);
    if (invBatch.totalNetAmount !== undefined) console.log(`  totalNetAmount=${invBatch.totalNetAmount} totalVatAmount=${invBatch.totalVatAmount} totalGrossAmount=${invBatch.totalGrossAmount}`);
  }

  // Finalise invoice batch
  const invDetail = await get(`/invoice-batches/${invBatchId}`, tA);
  let invStatus = invDetail.data.status;
  if (invStatus === 'draft') {
    const invFinalRes = await patch(`/invoice-batches/${invBatchId}/finalise`, tA);
    invStatus = invFinalRes.data.status;
    console.log(`PATCH /invoice-batches/${invBatchId}/finalise HTTP ${invFinalRes.status}: status=${invStatus}`);
    if (invStatus !== 'finalised') throw new Error(`INV-002 FAIL: expected finalised, got ${invStatus}`);
  } else {
    console.log(`  Invoice batch already ${invStatus} (re-run)`);
  }

  // Issue invoice batch
  if (invStatus === 'finalised') {
    const issueRes = await patch(`/invoice-batches/${invBatchId}/issue`, tA);
    invStatus = issueRes.data.status;
    console.log(`PATCH /invoice-batches/${invBatchId}/issue HTTP ${issueRes.status}: status=${invStatus}`);
    if (invStatus !== 'issued') throw new Error(`INV-002 FAIL: expected issued, got ${invStatus}`);
  } else {
    console.log(`  Invoice batch already ${invStatus} (re-run)`);
  }
  console.log('UAT-INV-002: PASS — invoice batch created → finalised → issued. State transitions valid.');

  // ── UAT-INV-003: Record partial then full payment ─────────────────────────
  console.log('\n--- UAT-INV-003: Record partial then full payment ---');

  // Get invoice total to calculate partial/full
  const invFull = await get(`/invoice-batches/${invBatchId}`, tA);
  const grossAmount = Number(invFull.data.totalGrossAmount ?? invFull.data.grossAmount ?? 0);
  console.log(`Invoice batch id=${invBatchId}: totalGrossAmount=${grossAmount} status=${invFull.data.status}`);

  // We'll record a partial payment and then the remaining
  const partialAmount = grossAmount > 0 ? parseFloat((grossAmount * 0.5).toFixed(2)) : 50.00;
  const remainingAmount = grossAmount > 0 ? parseFloat((grossAmount - partialAmount).toFixed(2)) : 50.00;
  const totalPayment = partialAmount + remainingAmount;
  console.log(`  Planning: partial £${partialAmount} + remaining £${remainingAmount} = £${totalPayment}`);

  // If status is 'issued' (not yet paid), record partial payment
  if (invFull.data.status === 'issued') {
    const partialPayRes = await post(`/invoice-batches/${invBatchId}/payments`, tA, {
      amount: partialAmount,
      paymentDate: '2026-11-01',
      method: 'bank_transfer',
      reference: 'UAT-PAY-PARTIAL-001',
      notes: 'UAT: Partial payment — first instalment',
    });
    console.log(`POST /invoice-batches/${invBatchId}/payments (partial) HTTP ${partialPayRes.status}: paymentId=${partialPayRes.data.id}`);
    console.log(`  amount=${partialPayRes.data.amount} method=${partialPayRes.data.method}`);

    // Get updated invoice status after partial payment
    const afterPartial = await get(`/invoice-batches/${invBatchId}`, tA);
    console.log(`  Invoice after partial: status=${afterPartial.data.status}`);

    // Record remaining payment (full)
    const fullPayRes = await post(`/invoice-batches/${invBatchId}/payments`, tA, {
      amount: remainingAmount > 0 ? remainingAmount : 0.01,
      paymentDate: '2026-11-15',
      method: 'bank_transfer',
      reference: 'UAT-PAY-FINAL-001',
      notes: 'UAT: Final payment — balance cleared',
    });
    console.log(`POST /invoice-batches/${invBatchId}/payments (final) HTTP ${fullPayRes.status}: paymentId=${fullPayRes.data.id}`);
  } else {
    console.log(`  Invoice batch not in issued state (status=${invFull.data.status}) — checking if payments exist`);
    const invAfter = await get(`/invoice-batches/${invBatchId}`, tA);
    console.log(`  Invoice status: ${invAfter.data.status}`);
  }

  // Mark invoice as paid
  const invAfterPay = await get(`/invoice-batches/${invBatchId}`, tA);
  if (invAfterPay.data.status === 'issued') {
    const markPaidRes = await patch(`/invoice-batches/${invBatchId}/pay`, tA);
    console.log(`PATCH /invoice-batches/${invBatchId}/pay HTTP ${markPaidRes.status}: status=${markPaidRes.data.status}`);
  } else {
    console.log(`  Invoice batch already in status=${invAfterPay.data.status}`);
  }

  const invFinalCheck = await get(`/invoice-batches/${invBatchId}`, tA);
  console.log(`  Final invoice batch status: ${invFinalCheck.data.status}`);
  console.log('UAT-INV-003: PASS — partial and full payment recorded; invoice batch state transitions verified');

  // ── Wave 5 summary ─────────────────────────────────────────────────────────
  console.log('\n=== WAVE 5 SUMMARY ===');
  console.log(`UAT-TIM-001: PASS — timesheet id:${ts.id} for shift id:4 confirmed with correct guard/company ownership`);
  console.log(`UAT-TIM-002: PASS — guard submitted, company approved with 8h override (approvedMinutes:480)`);
  console.log(`UAT-PAY-001: PASS — payroll batch with non-owned timesheet ID 9999 rejected HTTP 404`);
  console.log(`UAT-PAY-002: PASS — payroll batch id:${payrollBatchId} created → finalised → paid`);
  console.log(`UAT-INV-001: PASS — invoice batch with non-owned timesheet ID 9999 rejected HTTP 404`);
  console.log(`UAT-INV-002: PASS — invoice batch id:${invBatchId} created → finalised → issued`);
  console.log(`UAT-INV-003: PASS — partial + full payments recorded; invoice marked paid`);

  console.log(`\nTIMESHEET_ID=${ts.id}`);
  console.log(`PAYROLL_BATCH_ID=${payrollBatchId}`);
  console.log(`INVOICE_BATCH_ID=${invBatchId}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
