#!/usr/bin/env node
/**
 * S4 Live Shift Amendments Phase 2: the company web interface.
 *
 * Executes the real amendment module (permissions, eligibility, proposed-end resolution, policy-based warnings,
 * validation, wording, error guidance and history), checks the client's contract against the API's own source, and
 * checks the wiring that needs a DOM by reading the source: controls only for authorised users, nothing offered
 * while a company is switched off, a verbal agreement never shown as the Guard's electronic acceptance, and the
 * drawer refreshing while open and reloading on a stale answer.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs, ROOT } = require('./load-ts.cjs');

let passed = 0;
const test = (id, fn) => { fn(); passed += 1; console.log(`PASS  ${id}`); };
const codeOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const backendOf = (rel) => fs.readFileSync(path.join(ROOT, '..', 'security-backend-nest', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const fnBody = (src, name) => {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
};

const lsa = loadTs('src/components/company/shiftAmendments.ts');
const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-23T19:00:00.000Z'); // 20:00 BST
const iso = (ms) => new Date(ms).toISOString();

const DEFAULT_POLICY = {
  amendmentsEnabled: true, fatigueWarningHours: 12, approvalRequiredHours: 14, hardLimitHours: 16,
  minRestHours: 11, weeklyReviewHours: 48, lastMinuteWarningMinutes: 10, source: 'default',
};
const STRICT_POLICY = {
  amendmentsEnabled: true, fatigueWarningHours: 8, approvalRequiredHours: 9, hardLimitHours: null,
  minRestHours: 12, weeklyReviewHours: 40, lastMinuteWarningMinutes: 30, source: 'company',
};

const amendment = (over = {}) => ({
  id: 9, shiftId: 50, guardId: 3, sequence: 1, status: 'pending', effectiveStatus: 'pending',
  originalEnd: iso(NOW + HOUR), previousEnd: iso(NOW + HOUR), proposedEnd: iso(NOW + 3 * HOUR), agreedEnd: null,
  additionalMinutes: 120, reason: 'Relief Guard delayed', proposedByUserId: 7, proposedAt: iso(NOW - 10 * MIN),
  expiresAt: iso(NOW + HOUR),
  fatigue: { basis: 'scheduled_hours', totalScheduledHours: 10, warnings: [], restHoursBeforeNextShift: null, sevenDayScheduledHours: 30 },
  approvalRequired: false, approvedByUserId: null, approvedAt: null, selfApproved: false,
  responseMethod: null, staffReported: false, respondedByUserId: null, respondedAt: null,
  verbalContactMethod: null, verbalContactAt: null, verbalConfirmation: null, confirmationEmailStatus: null,
  withdrawnAt: null, voidedReason: null, voidedAt: null, expiredAt: null, disputedAt: null, disputeReason: null,
  disputeResolution: null, disputeResolutionNote: null, disputeResolvedAt: null, timesheetSync: null,
  payrollReviewRequired: false, billingReviewRequired: false, complianceReviewRequired: false,
  ...over,
});
const nameFor = (id) => (id === null ? null : id === 7 ? 'You' : `Staff user #${id}`);

// ═══════════════════ the client and the API agree ═══════════════════

test('LSA-UI-01-STATUSES-CONTACT-METHODS-AND-LIMITS-ARE-THE-APIS', () => {
  const policy = backendOf('src/shift-amendment/shift-amendment-policy.ts');
  const block = (start) => policy.slice(policy.indexOf(start), policy.indexOf('] as const;', policy.indexOf(start)));
  const values = (b) => [...b.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...lsa.AMENDMENT_STATUSES], values(block('export const AMENDMENT_STATUSES = [')));
  assert.deepEqual(lsa.VERBAL_CONTACT_METHOD_OPTIONS.map((o) => o.value), values(block('export const VERBAL_CONTACT_METHODS = [')));
  assert.ok(policy.includes(`OPEN_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['awaiting_approval', 'pending']`));
  assert.ok(policy.includes(`AGREED_AMENDMENT_STATUSES: readonly AmendmentStatus[] = ['accepted', 'disputed', 'dispute_upheld', 'dispute_corrected']`));
  const dto = backendOf('src/shift-amendment/dto/shift-amendment.dto.ts');
  assert.ok(dto.includes(`@MaxLength(${lsa.AMENDMENT_TEXT_MAX})`) && dto.includes(`@MinLength(${lsa.AMENDMENT_REASON_MIN})`));
  assert.ok(dto.includes(`@MinLength(${lsa.VERBAL_CONFIRMATION_MIN})`), 'verbal confirmation minimum');
  // the warning words the API freezes into an amendment are the ones the client explains
  for (const w of ['LONG_SHIFT', 'SHORT_REST', 'WEEKLY_HOURS', 'LAST_MINUTE']) {
    assert.ok(policy.includes(`'${w}'`));
    assert.ok(!lsa.warningText(w, DEFAULT_POLICY).startsWith(w), `${w} is explained in words`);
  }
});

test('LSA-UI-02-EVERY-REQUEST-MATCHES-A-ROUTE-METHOD-AND-DTO', () => {
  const client = stripComments(codeOf('src/services/api.ts'));
  const controller = backendOf('src/shift-amendment/shift-amendment.controller.ts');
  const routes = [
    ['Get', "'shift-amendments/policy'", "'/shift-amendments/policy'", null],
    ['Get', "'shifts/:shiftId/amendments'", '`/shifts/${shiftId}/amendments`', null],
    ['Post', "'shifts/:shiftId/amendments'", '`/shifts/${shiftId}/amendments`', 'POST'],
    ['Post', "'shift-amendments/:id/approve'", '`/shift-amendments/${id}/approve`', 'POST'],
    ['Post', "'shift-amendments/:id/withdraw'", '`/shift-amendments/${id}/withdraw`', 'POST'],
    ['Post', "'shift-amendments/:id/record-verbal-agreement'", '`/shift-amendments/${id}/record-verbal-agreement`', 'POST'],
    ['Post', "'shift-amendments/:id/resolve-dispute'", '`/shift-amendments/${id}/resolve-dispute`', 'POST'],
  ];
  for (const [verb, route, clientPath, method] of routes) {
    assert.ok(controller.includes(`@${verb}(${route})`), `API has ${verb} ${route}`);
    // the same path can be both a GET and a POST: judge each call site on its own
    const calls = client.split(clientPath).slice(1).map((after) => after.slice(0, 200));
    assert.ok(calls.length > 0, `client calls ${clientPath}`);
    assert.ok(calls.some((c) => (method ? c.includes(`method: '${method}'`) : !c.includes('method:'))), `${clientPath} is a ${method ?? 'GET'}`);
  }
  // body fields are exactly the DTO's
  assert.ok(/proposeShiftAmendment\(shiftId: number, payload: \{ proposedEnd: string; reason: string \}\)/.test(client));
  assert.ok(/approveShiftAmendment\(id: number, payload: \{ statement: string; confirmSelfApproval\?: boolean \}\)/.test(client));
  assert.ok(/agreedEnd: string; contactMethod: VerbalContactMethod; contactAt: string; confirmation: string; reason: string;/.test(client));
  assert.ok(/resolution: 'upheld' \| 'corrected'; note: string/.test(client));
  // the company web never calls the S4 activation route or the Guard's routes
  assert.ok(!client.includes('/admin/shift-amendments'), 'no activation from the company web');
  // api.ts is shared with the Guard app (Phase 3), so the Guard's answer and dispute calls exist there; the company
  // screens must never use them.
  for (const rel of ['src/components/company/CompanyShiftAmendmentDrawer.tsx', 'src/screens/CompanyDashboardScreen.tsx', 'src/components/company/CompanyLiveOperationsWorkspace.tsx']) {
    const src = stripComments(codeOf(rel));
    assert.ok(!/respondToShiftAmendment|disputeShiftAmendment|listMyShiftAmendments/.test(src), `no Guard answers from ${rel}`);
  }
});

// ═══════════════════ permissions and tenant isolation ═══════════════════

test('LSA-UI-03-ONLY-AUTHORISED-STAFF-GET-CONTROLS', () => {
  const types = backendOf('src/company-membership/company-membership-types.ts');
  for (const p of ['shifts.amend', 'shifts.amend.record_agreement', 'shifts.amend.approve', 'shifts.amend.resolve_dispute']) {
    assert.ok(types.includes(`'${p}'`), `${p} is a real permission`);
  }
  const all = ['shifts.view', 'shifts.amend', 'shifts.amend.record_agreement', 'shifts.amend.approve', 'shifts.amend.resolve_dispute'];
  const owner = lsa.resolveAmendmentPermissions(all, 'company_admin');
  assert.deepEqual({ ...owner }, { canPropose: true, canWithdraw: true, canRecordAgreement: true, canApprove: true, canResolveDispute: true, any: true });
  const ops = lsa.resolveAmendmentPermissions(['shifts.view', 'shifts.amend', 'shifts.amend.record_agreement'], 'company_staff');
  assert.equal(ops.canPropose && ops.canRecordAgreement && ops.canWithdraw, true);
  assert.equal(ops.canApprove || ops.canResolveDispute, false, 'Operations never approves or resolves');
  const controlRoom = lsa.resolveAmendmentPermissions(['shifts.view', 'shifts.reconcile'], 'company_staff');
  assert.equal(controlRoom.any, false, 'Control Room without the individual grant sees no controls');
  const granted = lsa.resolveAmendmentPermissions(['shifts.view', 'shifts.reconcile', 'shifts.amend', 'shifts.amend.record_agreement'], 'company_staff');
  assert.equal(granted.canPropose && granted.canRecordAgreement, true);
  assert.equal(granted.canApprove, false, 'the grant never includes approval');
  assert.equal(lsa.resolveAmendmentPermissions(undefined, 'guard').any, false, 'a Guard gets no company controls');
  assert.equal(lsa.resolveAmendmentPermissions([], 'company_admin').any, false, 'an explicit empty list is honoured');
  assert.equal(lsa.resolveAmendmentPermissions(undefined, 'company_admin').canApprove, true, 'legacy owner session');
  // the backend tells the web app about an individual grant (display only)
  const auth = backendOf('src/auth/auth.service.ts');
  assert.ok(/CompanyMembershipRole\.CONTROL_ROOM && membership\.canAmendShifts/.test(auth));
  assert.ok(/\[CompanyPermission\.SHIFTS_AMEND, CompanyPermission\.SHIFTS_AMEND_RECORD_AGREEMENT\]/.test(auth));
});

test('LSA-UI-04-EACH-CONTROL-IS-GATED-BY-ITS-OWN-PERMISSION', () => {
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  const gate = (label, perm) => {
    const at = drawer.indexOf(`label="${label}"`);
    assert.ok(at >= 0, `${label} button`);
    // the nearest permission check before the button is the button's own
    const before = drawer.slice(Math.max(0, at - 300), at);
    const nearest = [...before.matchAll(/permissions\.(can[A-Za-z]+)/g)].pop();
    assert.equal(nearest && nearest[1], perm, `${label} needs ${perm}`);
  };
  gate('Propose extension', 'canPropose');
  gate('Review and approve', 'canApprove');
  gate('Record verbal agreement', 'canRecordAgreement');
  gate('Withdraw proposal', 'canWithdraw');
  gate('Review dispute', 'canResolveDispute');
  const screen = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(screen.includes('onManageExtension={amendmentPermissions.any ? handleOpenAmendment : undefined}'));
  assert.ok(screen.includes('resolveAmendmentPermissions(user?.companyPermissions, user?.role)'));
});

test('LSA-UI-05-TENANT-ISOLATION-IS-THE-APIS-AND-THE-CLIENT-SENDS-NO-COMPANY', () => {
  const client = stripComments(codeOf('src/services/api.ts'));
  const block = client.slice(client.indexOf('export function getShiftAmendmentPolicy'), client.indexOf('export function respondToShift('));
  assert.ok(!/companyId/.test(block), 'company comes from the session, never from the client');
  const g = lsa.amendmentErrorGuidance({ status: 404, body: { code: 'SHIFT_AMENDMENT_NOT_FOUND', message: 'Shift not found.' } });
  assert.match(g.message, /could not be found/);
  assert.equal(g.reload, true);
  const service = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(service.includes("if (!shift || shift.companyId !== actor.companyId) throw amendmentError(HttpStatus.NOT_FOUND"), 'another company reads as not found');
});

// ═══════════════════ eligibility and proposing ═══════════════════

test('LSA-UI-06-ONLY-A-LIVE-BOOKED-ON-SHIFT-IS-OFFERED-A-PROPOSAL', () => {
  const live = { status: 'in_progress', end: iso(NOW + HOUR) };
  const on = { checkInAt: iso(NOW - 6 * HOUR), checkOutAt: null };
  assert.equal(lsa.isEligibleForExtension(live, on, NOW), true);
  assert.equal(lsa.isEligibleForExtension({ ...live, status: 'scheduled' }, on, NOW), false);
  assert.equal(lsa.isEligibleForExtension(live, { checkInAt: null }, NOW), false);
  assert.equal(lsa.isEligibleForExtension(live, { ...on, checkOutAt: iso(NOW) }, NOW), false);
  assert.equal(lsa.isEligibleForExtension({ ...live, end: iso(NOW - MIN) }, on, NOW), false, 'past its end: no retrospective extension');
  assert.match(lsa.extensionIneligibleReason({ ...live, status: 'scheduled' }, on, NOW), /in progress/);
  assert.match(lsa.extensionIneligibleReason(live, { checkInAt: null }, NOW), /booked on/);
  assert.match(lsa.extensionIneligibleReason(live, { ...on, checkOutAt: iso(NOW) }, NOW), /booked off/);
  assert.match(lsa.extensionIneligibleReason({ ...live, end: iso(NOW) }, on, NOW), /reached its scheduled end/);
  assert.equal(lsa.extensionIneligibleReason(live, on, NOW), null);
});

test('LSA-UI-07-THE-NEW-END-IS-SITE-TIME-AND-RUNS-FORWARD-ACROSS-MIDNIGHT-AND-THE-CLOCK-CHANGE', () => {
  const end = '2026-10-23T21:00:00.000Z'; // 22:00 BST
  const same = lsa.resolveProposedEnd(end, '23:30', LONDON);
  assert.equal(same.ok && same.iso, '2026-10-23T22:30:00.000Z');
  const tomorrow = lsa.resolveProposedEnd(end, '01:00', LONDON);
  assert.equal(tomorrow.ok && tomorrow.iso, '2026-10-24T00:00:00.000Z', '01:00 after a 22:00 end is the next day');
  // 25 Oct 2026: BST ends at 02:00 BST → 01:00 GMT. A 00:30 BST end extended to 03:00 site time is 03:00 GMT.
  const night = lsa.resolveProposedEnd('2026-10-24T23:30:00.000Z', '03:00', LONDON);
  assert.equal(night.ok && night.iso, '2026-10-25T03:00:00.000Z');
  const bad = lsa.resolveProposedEnd(end, '7pm', LONDON);
  assert.equal(bad.ok, false);
});

test('LSA-UI-08-A-PROPOSAL-IS-REFUSED-BEFORE-SENDING-WHEN-INCOMPLETE', () => {
  const currentEndMs = NOW + HOUR;
  const base = { currentEndMs, proposedEndMs: NOW + 2 * HOUR, reason: 'Relief delayed', nowMs: NOW, preview: null, policy: DEFAULT_POLICY };
  assert.deepEqual(lsa.validateProposal(base), { ok: true });
  assert.match(lsa.validateProposal({ ...base, policy: { ...DEFAULT_POLICY, amendmentsEnabled: false } }).message, /not enabled/);
  assert.match(lsa.validateProposal({ ...base, policy: null }).message, /not enabled/, 'policy not loaded: never assumed on');
  assert.match(lsa.validateProposal({ ...base, proposedEndMs: null }).message, /Choose the new end/);
  assert.match(lsa.validateProposal({ ...base, proposedEndMs: currentEndMs }).message, /later than the current end/);
  assert.match(lsa.validateProposal({ ...base, reason: '  ' }).message, /reason/);
  assert.match(lsa.validateProposal({ ...base, reason: 'x'.repeat(501) }).message, /500/);
  assert.match(lsa.validateProposal({ ...base, nowMs: currentEndMs }).message, /reached its scheduled end/);
  const preview = lsa.previewExtension({ startIso: iso(NOW - 15 * HOUR), currentEndIso: iso(currentEndMs), proposedEndMs: NOW + 2 * HOUR, nowMs: NOW, policy: DEFAULT_POLICY });
  assert.equal(preview.hardLimitExceeded, true);
  assert.match(lsa.validateProposal({ ...base, preview }).message, /over the company limit of 16 hours/);
});

// ═══════════════════ fatigue and working time, from the company's policy ═══════════════════

test('LSA-UI-09-WARNINGS-AND-APPROVAL-USE-THE-POLICY-THE-API-RETURNED', () => {
  const args = (policy, hoursBefore, extraMin, endInMin = 60) => ({
    startIso: iso(NOW - hoursBefore * HOUR), currentEndIso: iso(NOW + endInMin * MIN),
    proposedEndMs: NOW + endInMin * MIN + extraMin * MIN, nowMs: NOW, policy,
  });
  // 11h + 2h = 13 scheduled hours under the defaults: warning, no approval, within the hard limit
  const d = lsa.previewExtension(args(DEFAULT_POLICY, 10, 120));
  assert.equal(d.totalScheduledHours, 13);
  assert.equal(d.additionalMinutes, 120);
  assert.deepEqual(d.warnings, ['LONG_SHIFT']);
  assert.equal(d.approvalRequired, false);
  assert.equal(d.hardLimitExceeded, false);
  // the same extension under a stricter company policy: approval required, no hard limit at all
  const s = lsa.previewExtension(args(STRICT_POLICY, 10, 120));
  assert.equal(s.approvalRequired, true);
  assert.equal(s.hardLimitExceeded, false, 'no hard limit configured');
  // 15h needs approval; 17h is over the default hard limit
  assert.equal(lsa.previewExtension(args(DEFAULT_POLICY, 12, 120)).approvalRequired, true);
  assert.equal(lsa.previewExtension(args(DEFAULT_POLICY, 14, 120)).hardLimitExceeded, true);
  // last minute is the policy's minutes, not a constant: 20 min to the end is last-minute only under the 30-min policy
  assert.ok(!lsa.previewExtension(args(DEFAULT_POLICY, 4, 60, 20)).warnings.includes('LAST_MINUTE'));
  assert.ok(lsa.previewExtension(args(STRICT_POLICY, 4, 60, 20)).warnings.includes('LAST_MINUTE'));
  assert.ok(lsa.previewExtension(args(DEFAULT_POLICY, 4, 60, 5)).warnings.includes('LAST_MINUTE'));
  // no threshold is written into the client
  const src = stripComments(codeOf('src/components/company/shiftAmendments.ts'));
  for (const name of ['previewExtension', 'warningText', 'validateProposal', 'policySummary']) {
    assert.ok(!/[<>]=?\s*(10|11|12|14|16|48)\b/.test(fnBody(src, name)), `${name} has no hard-coded threshold`);
  }
  // the words carry the policy's numbers and the API's figures
  assert.match(lsa.warningText('SHORT_REST', STRICT_POLICY, { restHoursBeforeNextShift: 9.5 }), /less than 12 hours.*9\.5 h.*approval/);
  assert.match(lsa.warningText('WEEKLY_HOURS', STRICT_POLICY, { sevenDayScheduledHours: 44 }), /more than 40 scheduled hours.*44 h/);
  assert.match(lsa.policySummary(STRICT_POLICY), /no hard limit.*company policy/);
  assert.match(lsa.policySummary(DEFAULT_POLICY), /not allowed over 16 h.*S4 default policy/);
});

test('LSA-UI-10-MANAGEMENT-APPROVAL-AND-SELF-APPROVAL', () => {
  const waiting = amendment({ status: 'awaiting_approval', effectiveStatus: 'awaiting_approval', approvalRequired: true });
  assert.equal(lsa.approvalStatusText(waiting), 'Required — waiting for an Owner or Admin');
  assert.match(lsa.guardResponseText(waiting), /Not yet asked/);
  assert.equal(lsa.amendmentStatusLabel(waiting), 'Waiting for management approval');
  assert.equal(lsa.approvalStatusText(amendment({ approvalRequired: true, approvedAt: iso(NOW), approvedByUserId: 1 })), 'Approved');
  assert.match(lsa.approvalStatusText(amendment({ approvalRequired: true, approvedAt: iso(NOW), selfApproved: true })), /by the proposer, confirmed/);
  assert.equal(lsa.approvalStatusText(amendment()), 'Not required');
  assert.match(lsa.validateApproval({ statement: '', selfApproval: false, confirmSelfApproval: false }).message, /why/);
  assert.match(lsa.validateApproval({ statement: 'Rest reviewed', selfApproval: true, confirmSelfApproval: false }).message, /approving your own proposal/);
  assert.deepEqual(lsa.validateApproval({ statement: 'Rest reviewed', selfApproval: true, confirmSelfApproval: true }), { ok: true });
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes("...(selfApproval ? { confirmSelfApproval: true } : {})"), 'self-approval is only sent when confirmed');
  assert.ok(drawer.includes("open.status === 'awaiting_approval' && !permissions.canApprove"), 'non-approvers are told who must approve');
});

// ═══════════════════ the Guard's answer ═══════════════════

test('LSA-UI-11-GUARD-ACCEPTANCE-IN-THE-APP-IS-REFLECTED', () => {
  const accepted = amendment({ status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'guard_app', respondedAt: iso(NOW - 2 * MIN), agreedEnd: iso(NOW + 3 * HOUR), timesheetSync: 'synced_draft' });
  assert.equal(lsa.amendmentStatusLabel(accepted), 'Accepted by the Guard in the app');
  assert.equal(lsa.guardResponseText(accepted), 'Accepted by the Guard in the S4 app');
  assert.equal(lsa.openAmendment([accepted]), null, 'nothing left open');
  const h = lsa.buildAmendmentHistory([accepted], LONDON, nameFor);
  assert.deepEqual(h.map((e) => e.kind), ['proposed', 'accepted_app']);
  assert.match(h[1].detail, /Shift now ends/);
  assert.deepEqual(lsa.reviewFlags(accepted), ['Draft timesheet updated to the new end']);
  assert.deepEqual(lsa.reviewFlags({ ...accepted, timesheetSync: 'flagged_locked', payrollReviewRequired: true }),
    ['Timesheet already approved — not changed; review required', 'Payroll review required']);
  const svc = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(svc.includes("'no_timesheet' : syncedCount === Number(total) ? 'synced_draft' : 'flagged_locked'"), 'sync values are the API\'s');
});

test('LSA-UI-12-DECLINE-WITHDRAW-EXPIRY-AND-BOOK-OFF-NEVER-EXTEND', () => {
  const declined = amendment({ status: 'declined', effectiveStatus: 'declined', respondedAt: iso(NOW), responseMethod: 'guard_app' });
  assert.equal(lsa.amendmentStatusLabel(declined), 'Declined by the Guard');
  assert.equal(lsa.guardResponseText(declined), 'Declined in the app');
  const withdrawn = amendment({ status: 'withdrawn', effectiveStatus: 'withdrawn', withdrawnAt: iso(NOW) });
  assert.equal(lsa.amendmentStatusLabel(withdrawn), 'Withdrawn');
  // lapsed but not yet swept: the API already reports it expired, and so does the client
  const lapsed = amendment({ status: 'pending', effectiveStatus: 'expired' });
  assert.equal(lsa.isOpen(lapsed), false);
  assert.equal(lsa.openAmendment([lapsed]), null, 'a lapsed proposal is not actionable');
  assert.equal(lsa.amendmentStatusLabel(lapsed), 'Expired — shift end unchanged');
  assert.equal(lsa.guardResponseText(lapsed), 'No answer before the deadline');
  const voided = amendment({ status: 'voided', effectiveStatus: 'voided', voidedAt: iso(NOW), voidedReason: 'booked_off' });
  const h = lsa.buildAmendmentHistory([declined, withdrawn, amendment({ status: 'expired', effectiveStatus: 'expired', expiredAt: iso(NOW) }), voided], LONDON, nameFor);
  for (const kind of ['declined', 'withdrawn', 'expired', 'voided']) {
    const e = h.find((x) => x.kind === kind);
    assert.ok(e && /shift end is unchanged/.test(e.detail), `${kind} says the end is unchanged`);
  }
  assert.match(h.find((x) => x.kind === 'voided').detail, /the Guard booked off/);
  assert.match(lsa.validateWithdrawal({ reason: 'x'.repeat(501) }).message, /500/);
  assert.deepEqual(lsa.validateWithdrawal({ reason: '' }), { ok: true }, 'withdrawal reason optional, as in the API');
});

// ═══════════════════ verbal agreement ═══════════════════

test('LSA-UI-13-A-VERBAL-AGREEMENT-IS-STAFF-REPORTED-NEVER-AN-ELECTRONIC-ACCEPTANCE', () => {
  const verbal = amendment({
    status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'staff_recorded_verbal', staffReported: true,
    respondedAt: iso(NOW), respondedByUserId: 8, verbalContactMethod: 'telephone', verbalContactAt: iso(NOW - 3 * MIN),
    verbalConfirmation: 'Guard agreed by phone to stay', confirmationEmailStatus: 'not_configured', agreedEnd: iso(NOW + 3 * HOUR),
  });
  assert.equal(lsa.amendmentStatusLabel(verbal), 'Agreed verbally (recorded by staff)');
  assert.match(lsa.guardResponseText(verbal), /reported by staff — not an electronic acceptance by the Guard/);
  assert.ok(!/Accepted by the Guard/.test(lsa.amendmentStatusLabel(verbal) + lsa.guardResponseText(verbal)));
  const [, rec] = lsa.buildAmendmentHistory([verbal], LONDON, nameFor);
  assert.equal(rec.kind, 'verbal_recorded');
  assert.match(rec.detail, /^Staff-reported, not an electronic Guard acceptance\. Telephone at /);
  assert.match(rec.detail, /Confirmation email not sent — email is not configured/);
  assert.equal(rec.actor, 'Staff user #8');
  // form
  const ok = { contactMethod: 'radio', contactAtMs: NOW - 2 * MIN, proposedAtMs: NOW - 10 * MIN, nowMs: NOW, confirmation: 'Guard agreed over the radio', reason: 'Relief delayed', termsConfirmed: true };
  assert.deepEqual(lsa.validateVerbalAgreement(ok), { ok: true });
  assert.match(lsa.validateVerbalAgreement({ ...ok, contactMethod: null }).message, /how you contacted/);
  assert.match(lsa.validateVerbalAgreement({ ...ok, contactMethod: 'email' }).message, /how you contacted/);
  assert.match(lsa.validateVerbalAgreement({ ...ok, contactAtMs: NOW - 20 * MIN }).message, /after the extension was proposed/);
  assert.match(lsa.validateVerbalAgreement({ ...ok, contactAtMs: NOW + 10 * MIN }).message, /not in the future/);
  assert.match(lsa.validateVerbalAgreement({ ...ok, confirmation: 'ok' }).message, /at least 10/);
  assert.match(lsa.validateVerbalAgreement({ ...ok, termsConfirmed: false }).message, /exact terms/);
  // the agreed terms sent are always the proposal's own (the API refuses anything else)
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes('agreedEnd: open.proposedEnd as string'));
  assert.ok(drawer.includes("open.status === 'pending' && permissions.canRecordAgreement"), 'only once approved and waiting for the Guard');
  // contact time: today at the site, or yesterday when that would be in the future
  const c = lsa.resolveContactTime('19:55', NOW, LONDON);
  assert.equal(c.ok && c.iso, '2026-10-23T18:55:00.000Z');
  const y = lsa.resolveContactTime('23:50', Date.parse('2026-10-23T23:05:00.000Z'), LONDON); // 00:05 BST on the 24th
  assert.equal(y.ok && y.iso, '2026-10-23T22:50:00.000Z');
});

test('LSA-UI-14-CONFIRMATION-EMAIL-STATUS-IS-NEVER-OVERSTATED', () => {
  const statuses = ['provider_accepted', 'captured_outbox', 'not_configured', 'failed', 'no_address', null];
  for (const s of statuses) {
    const text = lsa.confirmationEmailText(s);
    assert.ok(!/\bdelivered\b|\breceived\b|\bread\b/i.test(text), `${s}: ${text}`);
  }
  assert.match(lsa.confirmationEmailText('provider_accepted'), /accepted by the email provider \(delivery not confirmed\)/);
  assert.match(lsa.confirmationEmailText('captured_outbox'), /not sent to the Guard/);
  const policy = backendOf('src/shift-amendment/shift-amendment-policy.ts');
  assert.ok(policy.includes("export type ConfirmationEmailStatus = 'provider_accepted' | 'captured_outbox' | 'not_configured' | 'failed' | 'no_address';"));
});

// ═══════════════════ disputes ═══════════════════

test('LSA-UI-15-A-DISPUTE-IS-SHOWN-AND-ONLY-REVIEWED-BY-AN-OWNER-OR-ADMIN', () => {
  const disputed = amendment({ status: 'disputed', effectiveStatus: 'disputed', responseMethod: 'staff_recorded_verbal', staffReported: true,
    proposedAt: iso(NOW - 40 * MIN), respondedAt: iso(NOW - 30 * MIN), disputedAt: iso(NOW - 5 * MIN), disputeReason: 'I never agreed to stay' });
  assert.equal(lsa.disputedAmendment([amendment({ id: 1, status: 'accepted', effectiveStatus: 'accepted' }), disputed]).id, 9);
  assert.equal(lsa.amendmentStatusLabel(disputed), 'Disputed by the Guard — awaiting review');
  const corrected = { ...disputed, status: 'dispute_corrected', effectiveStatus: 'dispute_corrected', disputeResolution: 'corrected', disputeResolutionNote: 'Guard left at 22:00', disputeResolvedAt: iso(NOW) };
  const h = lsa.buildAmendmentHistory([corrected], LONDON, nameFor);
  assert.deepEqual(h.map((e) => e.kind), ['proposed', 'verbal_recorded', 'disputed', 'dispute_resolved']);
  assert.match(h[2].detail, /stays in place until reviewed/);
  assert.match(h[3].detail, /not changed automatically/);
  assert.match(lsa.validateDisputeResolution({ resolution: null, note: 'checked' }).message, /stands or needs correcting/);
  assert.match(lsa.validateDisputeResolution({ resolution: 'upheld', note: '' }).message, /what you found/);
  assert.deepEqual(lsa.validateDisputeResolution({ resolution: 'corrected', note: 'Guard left at 22:00' }), { ok: true });
  const ops = lsa.resolveAmendmentPermissions(['shifts.amend', 'shifts.amend.record_agreement'], 'company_staff');
  assert.equal(ops.canResolveDispute, false);
});

// ═══════════════════ history ═══════════════════

test('LSA-UI-16-HISTORY-IS-CHRONOLOGICAL-WITH-ORIGINAL-AND-REVISED-TIMES-AND-ACTORS', () => {
  const first = amendment({ id: 1, sequence: 1, status: 'accepted', effectiveStatus: 'accepted', responseMethod: 'guard_app',
    proposedAt: iso(NOW - 3 * HOUR), respondedAt: iso(NOW - 170 * MIN), agreedEnd: iso(NOW + HOUR), proposedEnd: iso(NOW + HOUR),
    previousEnd: iso(NOW), originalEnd: iso(NOW), additionalMinutes: 60, approvalRequired: true, approvedAt: iso(NOW - 175 * MIN), approvedByUserId: 2 });
  const second = amendment({ id: 2, sequence: 2, status: 'withdrawn', effectiveStatus: 'withdrawn', proposedAt: iso(NOW - HOUR),
    withdrawnAt: iso(NOW - 50 * MIN), previousEnd: iso(NOW + HOUR), proposedEnd: iso(NOW + 2 * HOUR), originalEnd: iso(NOW) });
  const h = lsa.buildAmendmentHistory([second, first], LONDON, nameFor);
  assert.deepEqual(h.map((e) => `${e.sequence}:${e.kind}`), ['1:proposed', '1:approved', '1:accepted_app', '2:proposed', '2:withdrawn']);
  for (let i = 1; i < h.length; i += 1) assert.ok(Date.parse(h[i - 1].at) <= Date.parse(h[i].at), 'oldest first');
  assert.match(h[0].detail, /20:00 → .*21:00 \(\+1 hour\)\. Original scheduled end .*20:00/);
  assert.equal(h[0].actor, 'You');
  assert.equal(h[1].actor, 'Staff user #2');
  assert.match(h[3].detail, /21:00 → .*22:00/);
  assert.deepEqual(lsa.buildAmendmentHistory([], LONDON, nameFor), []);
  assert.equal(lsa.formatDuration(90), '1 h 30 min');
  assert.equal(lsa.formatDuration(30), '30 min');
  assert.equal(lsa.formatDuration(120), '2 hours');
});

// ═══════════════════ switched off ═══════════════════

test('LSA-UI-17-A-SWITCHED-OFF-COMPANY-IS-OFFERED-NOTHING', () => {
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  const actionsAt = drawer.indexOf('<View style={styles.actions}>');
  assert.ok(actionsAt > 0);
  assert.ok(/\{enabled \? \(\s*$/m.test(drawer.slice(drawer.lastIndexOf('\n', actionsAt - 30) - 40, actionsAt)), 'every action sits under the policy switch');
  assert.ok(drawer.includes('const enabled = !!policy?.amendmentsEnabled;'), 'off until the API says on');
  assert.ok(drawer.includes('Shift extensions are not enabled for this company. History is shown read-only.'));
  const ws = stripComments(codeOf('src/components/company/CompanyLiveOperationsWorkspace.tsx'));
  assert.ok(ws.includes('(amendmentsEnabled && isEligibleForExtension(shift, attendance, nowMs)) || !!shift.originalEnd'), 'switched off: only history of an already-extended shift');
  const screen = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(screen.includes('amendmentsEnabled={amendmentsEnabled === true}'), 'unknown policy reads as off');
  assert.ok(/getShiftAmendmentPolicy\(\)\s*\.then\(\(policy\) => \{ if \(!cancelled\) setAmendmentsEnabled\(!!policy\.amendmentsEnabled\); \}\)/.test(screen));
  const g = lsa.amendmentErrorGuidance({ status: 403, body: { code: 'SHIFT_AMENDMENTS_DISABLED', message: 'Shift extensions are not enabled for this company.' } });
  assert.match(g.message, /not enabled.*Nothing was changed/);
  assert.equal(g.reload, true);
});

// ═══════════════════ errors, stale state and refresh ═══════════════════

test('LSA-UI-18-EVERY-FAILURE-HAS-A-PLAIN-NEXT-STEP', () => {
  const net = lsa.amendmentErrorGuidance(Object.assign(new Error('Network request failed'), { name: 'NetworkError' }));
  assert.match(net.message, /could not be reached\. Nothing was changed/);
  assert.equal(net.retryable, true);
  const busy = lsa.amendmentErrorGuidance({ status: 409, body: { code: 'SHIFT_AMENDMENT_BUSY', message: 'x' } });
  assert.equal(busy.retryable, true);
  assert.equal(busy.reload, false);
  for (const code of ['SHIFT_AMENDMENT_STALE', 'SHIFT_AMENDMENT_PENDING', 'SHIFT_AMENDMENT_ALREADY_ANSWERED', 'SHIFT_AMENDMENT_NOT_OPEN']) {
    const g = lsa.amendmentErrorGuidance({ status: 409, body: { code, message: 'Changed.' } });
    assert.equal(g.reload, true, `${code} reloads`);
    assert.match(g.message, /latest details have been loaded/);
  }
  const expired = lsa.amendmentErrorGuidance({ status: 409, body: { code: 'SHIFT_AMENDMENT_EXPIRED', message: 'This extension request has expired.' } });
  assert.equal(expired.reload, true);
  assert.equal(expired.message, 'This extension request has expired.', "the API's own words");
  const forbidden = lsa.amendmentErrorGuidance({ status: 403, body: { code: 'SHIFT_AMENDMENT_FORBIDDEN', message: 'You are not authorised to do this for shift extensions.' } });
  assert.equal(forbidden.reload, false);
  assert.match(forbidden.message, /not authorised/);
  // the role guard's own refusal (seen on staging) is never shown raw
  const roleGuard = lsa.amendmentErrorGuidance({ status: 403, body: { statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' } });
  assert.equal(roleGuard.message, 'You are not authorised to do this for shift extensions.');
  assert.match(lsa.amendmentErrorGuidance({ status: 401, body: {} }).message, /Sign in again/);
  assert.equal(lsa.amendmentErrorGuidance({ status: 503, body: {} }).retryable, true);
  assert.match(lsa.amendmentErrorGuidance({ status: 422, body: { code: 'SHIFT_AMENDMENT_FATIGUE_LIMIT', message: 'Over the limit.' } }).message, /Over the limit/);
  assert.match(lsa.amendmentErrorGuidance({ status: 400, body: { message: ['reason must be longer'] } }).message, /reason must be longer/);
  // every code the API can send is either specifically handled or carries the API's own message
  const policy = backendOf('src/shift-amendment/shift-amendment-policy.ts');
  const codes = [...policy.matchAll(/: '(SHIFT_AMENDMENTS?_[A-Z_]+)'/g)].map((m) => m[1]);
  assert.equal(codes.length, 20);
  for (const code of codes) {
    const g = lsa.amendmentErrorGuidance({ status: 409, body: { code, message: 'API words.' } });
    assert.ok(g.message.length > 0 && !/undefined|null/.test(g.message), code);
  }
});

test('LSA-UI-19-THE-DRAWER-REFRESHES-WITH-THE-BOARD-AND-RELOADS-ON-A-STALE-ANSWER', () => {
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(!/setInterval|setTimeout|new WebSocket/.test(drawer), 'no polling loop or socket of its own');
  assert.ok(/React\.useEffect\(\(\) => \{\s*if \(shiftId === null\) return;\s*setNowMs\(Date\.now\(\)\);\s*void load\(\);[\s\S]{0,80}\}, \[refreshSignal\]\);/.test(drawer), 're-reads on every board refresh');
  const dash = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(dash.includes('refreshSignal={operationalNow.getTime()}'), "the signal is the board's one refresh cycle");
  assert.equal((dash.match(/setInterval\(/g) || []).length, 1, 'still one refresh cycle on the dashboard');
  assert.ok(/\}, \[shiftId, load, resetForms\]\);/.test(drawer), 'a fresh form per shift');
  assert.ok(/if \(guidance\.reload\) \{\s*await load\(\);/.test(drawer), 'stale answers reload before anything else');
  assert.ok(drawer.includes("Showing the last details loaded."), 'a failed refresh keeps the last good view and says so');
  assert.ok(/onPress=\{confirming \? \(\) => \{ void send\(\); \} : review\}/.test(drawer), 'every action is confirmed in place first');
  assert.ok(/if \(!verdict\.ok \|\| submitting\) return;/.test(drawer), 'no double submit');
  const screen = stripComments(codeOf('src/screens/CompanyDashboardScreen.tsx'));
  assert.ok(/const handleAmendmentChanged = React\.useCallback\(\(message: string\) => \{\s*setLiveOperationsFeedback\(\{ tone: 'success', message \}\);\s*void loadData\(true\);/.test(screen), 'the board re-reads after a change');
});

test('LSA-UI-20-RESPONSIVE-LAYOUT-WRAPS-AT-PHONE-WIDTH', () => {
  const drawer = codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx');
  const style = (name) => {
    const m = new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(drawer);
    assert.ok(m, `style ${name}`);
    return m[1];
  };
  for (const name of ['actions', 'chips', 'footer', 'historyRow']) assert.match(style(name), /flexWrap: 'wrap'/, `${name} wraps`);
  assert.match(style('historyBody'), /flex: 1, minWidth: 200/);
  assert.match(style('factValue'), /flex: 1/);
  assert.match(style('input'), /maxWidth: 220/);
  assert.ok(drawer.includes('width={600}'), 'drawer is capped on desktop and full width on a phone (Drawer: width 100%, maxWidth)');
  const ui = codeOf('src/components/ui/Drawer.tsx');
  assert.ok(ui.includes("width: '100%'") && ui.includes('({ maxWidth: width } as any)'));
});

// ═══════════════════ Phase 3 follow-ups on the company web ═══════════════════

test('LSA-UI-21-APPROVAL-IS-EXPLAINED-WITH-THE-POLICY-THRESHOLD', () => {
  assert.equal(lsa.approvalReasonText({ totalScheduledHours: 13, warnings: ['LONG_SHIFT'], approvalRequired: false }, DEFAULT_POLICY), null);
  assert.equal(lsa.approvalReasonText({ totalScheduledHours: 15, warnings: ['LONG_SHIFT'], approvalRequired: true }, DEFAULT_POLICY),
    'Owner or Admin approval needed before the Guard is asked: the shift would be 15 scheduled hours, over the 14-hour approval threshold.');
  assert.match(lsa.approvalReasonText({ totalScheduledHours: 10, warnings: ['SHORT_REST'], approvalRequired: true }, STRICT_POLICY),
    /less than 12 hours' rest before their next shift/);
  assert.match(lsa.approvalReasonText({ totalScheduledHours: 15, warnings: ['LONG_SHIFT', 'SHORT_REST'], approvalRequired: true }, DEFAULT_POLICY), /threshold; and the Guard would have less than 11 hours/);
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes('? approvalReasonText(preview, policy)'), 'the confirmation states why approval is needed');
  assert.ok(/a\.status === 'awaiting_approval' && a\.effectiveStatus !== 'expired' \? \(\s*<Banner tone="warning" text=\{approvalReasonText\(/.test(drawer), 'a waiting proposal states why');
  assert.ok(drawer.includes("'Not required on length (rest is checked when you send)'"), 'the preview does not overclaim on rest');
});

test('LSA-UI-22-AN-UNRESOLVED-DISPUTE-IS-ACKNOWLEDGED-BEFORE-PROPOSING-AGAIN', () => {
  assert.equal(lsa.unresolvedDisputeWarning([amendment({ status: 'accepted', effectiveStatus: 'accepted' })]), null);
  const w = lsa.unresolvedDisputeWarning([amendment({ status: 'disputed', effectiveStatus: 'disputed', disputeReason: 'Only 30 minutes' })]);
  assert.match(w, /^Extension #1 on this shift is disputed by the Guard and not yet reviewed \("Only 30 minutes"\)/);
  assert.equal(lsa.unresolvedDisputeWarning([amendment({ status: 'dispute_upheld', effectiveStatus: 'dispute_upheld' })]), null, 'reviewed: no warning');
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes("if (disputeWarning && !disputeSeen) return { ok: false as const, message: 'Confirm that you have seen the unresolved dispute on this shift.' };"), 'proposing is blocked until acknowledged');
  assert.ok(drawer.includes('{enabled && disputeWarning && !open && permissions.canPropose ? <Banner tone="danger" text={disputeWarning} /> : null}'), 'stated beside Propose');
  assert.ok(/setTermsConfirmed\(false\);\s*setDisputeSeen\(false\);/.test(drawer), 'the acknowledgement never carries over');
});

// ═══════════════════ assessment and staff directory (Phase 3 completion) ═══════════════════

const assessment = (over = {}) => ({
  shiftId: 50, timeZone: LONDON, currentEnd: iso(NOW + HOUR), proposedEnd: iso(NOW + 2 * HOUR),
  currentEndLocal: '23-10-2026 · 21:00', proposedEndLocal: '23-10-2026 · 22:00', additionalMinutes: 60, basis: 'scheduled_hours',
  totalScheduledHours: 9, warnings: [], approvalRequired: false, approvalReasons: [], hardLimitExceeded: false,
  complianceReviewRequired: false, restHoursBeforeNextShift: null, restFiguresWithheld: false, companySevenDayScheduledHours: 30,
  sevenDayIncludesOtherWork: false,
  thresholds: { fatigueWarningHours: 12, approvalRequiredHours: 14, hardLimitHours: 16, minRestHours: 11, weeklyReviewHours: 48, lastMinuteWarningMinutes: 10 },
  blockedBy: [], canPropose: true, ...over,
});

test('LSA-UI-23-THE-NEW-REQUESTS-MATCH-THE-NEW-ROUTES', () => {
  const client = stripComments(codeOf('src/services/api.ts'));
  const controller = backendOf('src/shift-amendment/shift-amendment.controller.ts');
  assert.ok(/@Post\('shifts\/:shiftId\/amendments\/assessment'\)\s*@HttpCode\(200\)\s*@Roles\(\.\.\.COMPANY_VIEW_ROLES\)/.test(controller));
  assert.ok(/@Get\('shift-amendments\/staff'\)\s*@Roles\(\.\.\.COMPANY_VIEW_ROLES\)/.test(controller));
  assert.ok(controller.indexOf("@Get('shift-amendments/staff')") < controller.indexOf("@Get('shift-amendments/:id')"), "'staff' is matched before ':id'");
  assert.ok(/assessShiftAmendment\(shiftId: number, payload: \{ proposedEnd: string \}\)[\s\S]{0,200}\/amendments\/assessment`, \{ method: 'POST'/.test(client));
  assert.ok(client.includes("request<ShiftAmendmentStaffDirectory>('/shift-amendments/staff')"));
  assert.ok(/setControlRoomAmendmentAuthorisation\(userId: number, canAmendShifts: boolean\)[\s\S]{0,200}\/shift-amendments\/control-room\/\$\{userId\}`, \{ method: 'PUT'/.test(client), 'the existing authorised route');
});

test('LSA-UI-24-THE-ASSESSMENT-IS-SHOWN-IN-WORDS-WITHOUT-ANOTHER-COMPANYS-SCHEDULE', () => {
  assert.deepEqual(lsa.assessmentLines(assessment()), { blocked: [], approval: null, warnings: [] });
  const withheld = lsa.assessmentLines(assessment({ warnings: ['SHORT_REST'], approvalRequired: true, approvalReasons: ['SHORT_REST'], restFiguresWithheld: true }));
  assert.equal(withheld.warnings[0], "Short rest: less than 11 hours before the Guard's next scheduled shift (exact time not shown).");
  assert.match(withheld.approval, /less than 11 hours' rest before their next shift/);
  const own = lsa.assessmentLines(assessment({ warnings: ['SHORT_REST'], approvalRequired: true, restHoursBeforeNextShift: 3 }));
  assert.match(own.warnings[0], /\(3 h\)\.$/);
  const weekly = lsa.assessmentLines(assessment({ warnings: ['WEEKLY_HOURS'], sevenDayIncludesOtherWork: true, companySevenDayScheduledHours: 30 }));
  assert.equal(weekly.warnings[0], '7-day hours: more than 48 scheduled hours in the last 7 days (this company: 30 h). Flagged for compliance review.');
  const blocked = lsa.assessmentLines(assessment({ canPropose: false, blockedBy: [{ code: 'SHIFT_AMENDMENT_CLASH', message: 'Guard has an overlapping shift assignment.' }] }));
  assert.deepEqual(blocked.blocked, ['Guard has an overlapping shift assignment.']);
  const long = lsa.assessmentLines(assessment({ totalScheduledHours: 15, warnings: ['LONG_SHIFT'], approvalRequired: true,
    thresholds: { fatigueWarningHours: 8, approvalRequiredHours: 9, hardLimitHours: null, minRestHours: 12, weeklyReviewHours: 40, lastMinuteWarningMinutes: 30 } }));
  assert.equal(long.warnings[0], 'Long shift: more than 8 scheduled hours (15 h).', "the API's own thresholds, not the client's");
  assert.match(long.approval, /over the 9-hour approval threshold/);
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(/if \(serverAssessment\?\.result && !serverAssessment\.result\.canPropose\) \{\s*return \{ ok: false as const, message: serverAssessment\.result\.blockedBy\[0\]\?\.message/.test(drawer), 'a refusal predicted by S4 blocks sending');
  assert.ok(drawer.includes("S4 could not check rest and 7-day hours just now; it checks them when you send."), 'a failed check falls back honestly');
  assert.ok(/const seq = \+\+assessSeq\.current;[\s\S]{0,400}if \(seq === assessSeq\.current\)/.test(drawer), 'an answer for an end no longer shown is dropped');
  assert.ok(drawer.indexOf('assessShiftAmendment(shiftId') < drawer.indexOf('  if (!target) return null;'), 'the hook runs before the early return');
});

test('LSA-UI-25-HISTORY-NAMES-COME-FROM-THE-STAFF-DIRECTORY', () => {
  const dir = { canManageControlRoom: false, staff: [{ userId: 2, displayName: 'Olivia Okoro', role: 'operations', isYou: false }, { userId: 7, displayName: 'Sam Owner', role: 'owner', isYou: true }] };
  const name = lsa.staffNameResolver(dir, 7);
  assert.equal(name(7), 'You');
  assert.equal(name(2), 'Olivia Okoro');
  assert.equal(name(99), 'Staff user #99', 'unknown (e.g. no longer a member): a reference, never a guess');
  assert.equal(name(null), null);
  assert.equal(lsa.staffNameResolver(null, 7)(2), 'Staff user #2', 'directory unavailable: references');
  const h = lsa.buildAmendmentHistory([amendment({ proposedByUserId: 2 })], LONDON, name);
  assert.equal(h[0].actor, 'Olivia Okoro');
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes('const nameFor = staffNameResolver(staffDir, currentUserId);'));
  assert.ok(drawer.includes('getShiftAmendmentStaff().then(setStaffDir).catch('), 'a directory failure never blocks the drawer');
});

test('LSA-UI-26-ONLY-OWNER-AND-ADMIN-SEE-THE-CONTROL-ROOM-SWITCH', () => {
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes("{staffDir?.canManageControlRoom && staffDir.staff.some((m) => m.role === 'control_room') ? ("), 'shown only when the API says this person manages it');
  assert.ok(drawer.includes("staffDir.staff.filter((m) => m.role === 'control_room').map((m) => ("), 'only Control Room members are switchable');
  assert.ok(drawer.includes('setControlRoomAmendmentAuthorisation(m.userId, !m.canAmendShifts)'));
  assert.ok(/if \(grantBusy !== null\) return;\s*setGrantBusy\(m\.userId\);/.test(drawer), 'one change at a time');
  assert.ok(drawer.includes("It applies from their next sign-in or refresh."), 'says when it takes effect');
  const service = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(service.includes("...(manager && role === CompanyMembershipRole.CONTROL_ROOM ? { canAmendShifts: Boolean(r.canAmendShifts) } : {}),"));
});

test('LSA-UI-27-A-STORED-AMENDMENT-SAYS-WHEN-A-FIGURE-IS-WITHHELD', () => {
  const withheld = lsa.warningText('SHORT_REST', DEFAULT_POLICY, { restHoursBeforeNextShift: null, restFiguresWithheld: true });
  assert.equal(withheld, "Short rest: less than 11 hours before the Guard's next scheduled shift (exact time not shown). Management approval is required.");
  assert.match(lsa.warningText('SHORT_REST', DEFAULT_POLICY, { restHoursBeforeNextShift: 4, restFiguresWithheld: false }), /next shift \(4 h\)\./);
  assert.match(lsa.warningText('WEEKLY_HOURS', DEFAULT_POLICY, { sevenDayScheduledHours: 18, sevenDayIncludesOtherWork: true }), /\(this company: 18 h\)\. Flagged/);
  assert.match(lsa.warningText('WEEKLY_HOURS', DEFAULT_POLICY, { sevenDayScheduledHours: 50, sevenDayIncludesOtherWork: false }), /\(50 h\)\. Flagged/);
  const backend = backendOf('src/shift-amendment/shift-amendment.service.ts');
  assert.ok(backend.includes('restFiguresWithheld: safe.restFiguresWithheld, sevenDayIncludesOtherWork: safe.sevenDayIncludesOtherWork'), 'the API sends the flags the web words');
  const drawer = stripComments(codeOf('src/components/company/CompanyShiftAmendmentDrawer.tsx'));
  assert.ok(drawer.includes('text={warningText(w, policy, a.fatigue)}'), 'the stored figures and flags reach the words');
});

console.log(`\n${passed} passed`);
