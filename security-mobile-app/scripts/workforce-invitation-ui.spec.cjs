// Phase C: company workforce invitation experience.
//
// Same approach as the other UI specs in this directory: the pure status/error model is executed
// through the TypeScript compiler already present as a dev dependency, and the component wiring is
// asserted against the source. No new test framework.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadTs(file) {
  const out = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require);
  return mod.exports;
}

const status = loadTs('src/components/company/workforceStatus.ts');
const invitePanel = read('src/components/company/CompanyGuardInvitationsPanel.tsx');
const guardPanel = read('src/components/guard/GuardCompaniesPanel.tsx');
const workspace = read('src/components/company/CompanyGuardsWorkspace.tsx');
const dashboard = read('src/screens/CompanyDashboardScreen.tsx');
const guardScreen = read('src/screens/GuardDashboardScreen.tsx');
const api = read('src/services/api.ts');

let count = 0;
async function test(name, work) {
  await work();
  count += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  // ══ COMPANY ══════════════════════════════════════════════════════════════

  await test('C-1 workforce screen renders without approvalStatus', () => {
    assert.ok(!/approvalStatus/.test(workspace), 'workforce workspace must not read approvalStatus');
  });

  await test('C-2 no dead approvalStatus filtering remains in the company dashboard', () => {
    // Timesheet approvalStatus is a different, legitimate field; the guard-approval filters are gone.
    const guardApproval = dashboard.match(/guard\??\.\w*[aA]pprovalStatus/g) || [];
    assert.deepEqual(guardApproval, [], `guard approvalStatus still read: ${guardApproval.join(', ')}`);
    assert.ok(
      !/const guardApproval =/.test(dashboard),
      'the dead guardApproval filter variable must be gone',
    );
  });

  await test('C-3 the legacy company direct-link UI is gone entirely', () => {
    // Post-UAT cleanup: invitations are the single onboarding path. Two competing routes would
    // undermine consent, because the direct link attaches a guard without asking them.
    assert.ok(!/handleApproveGuard/.test(dashboard), 'the misleading handler is gone');
    assert.ok(!/handleAddGuardToWorkforce/.test(dashboard), 'the direct-link handler is gone');
    assert.ok(!/\+ Link Guard/.test(workspace), '"+ Link Guard" is no longer rendered');
    assert.ok(!/Link Guard/.test(workspace), 'no Link Guard control or drawer remains');
    assert.ok(!/onLinkGuard/.test(workspace), 'the link callback prop is gone');
    assert.ok(!/onLinkGuard/.test(dashboard), 'and is no longer passed');
    assert.ok(!/approvingGuardId/.test(workspace) && !/approvingGuardId/.test(dashboard));
  });

  await test('C-3b no company-facing platform-guard selection UI remains', () => {
    assert.ok(!/availablePlatformGuards/.test(workspace), 'the picker prop is gone');
    assert.ok(!/availablePlatformGuards/.test(dashboard), 'and its feed is gone');
    assert.ok(!/Available Platform Guards/.test(dashboard), 'the legacy panel is gone');
    assert.ok(!/renderGuardsSection/.test(dashboard), 'the unreachable legacy section is gone');
    assert.ok(!/linkDrawerBody|linkRow|linkButton/.test(workspace), 'its styles are gone');
  });

  await test('C-3c the backend link capability is untouched', () => {
    // Hire and platform-admin flows still use POST /company-guards; only the company UI stopped
    // offering it, so the API client keeps the function.
    assert.ok(/export function linkGuard\(/.test(api), 'the API client still exposes linkGuard');
    assert.ok(/'\/company-guards'/.test(api), 'pointing at the unchanged endpoint');
  });

  await test('C-4 Invite Guard is offered to authorised company users only', () => {
    assert.ok(/label="Invite Guard"/.test(invitePanel), 'the primary action exists');
    assert.ok(
      /canManageGuards \? \(\s*<Button label="Invite Guard"/.test(invitePanel),
      'Invite Guard is gated on canManageGuards',
    );
    assert.ok(
      /guards\.manage/.test(dashboard),
      'the dashboard derives canManageGuards from the guards.manage permission',
    );
  });

  await test('C-5 relationship type is sent on creation', () => {
    assert.ok(/relationshipType,/.test(invitePanel), 'relationshipType is included in the payload');
    assert.ok(
      /RELATIONSHIP_TYPE_OPTIONS\.map/.test(invitePanel),
      'all three relationship types are offered',
    );
    assert.deepEqual(
      status.RELATIONSHIP_TYPE_OPTIONS.map((o) => o.value),
      ['EMPLOYEE', 'PREFERRED', 'APPROVED_CONTRACTOR'],
    );
  });

  await test('C-6 optional SIA target is sent only when provided', () => {
    assert.ok(
      /\.\.\.\(trimmed \? \{ targetSiaLicenceNumber: trimmed \} : \{\}\)/.test(invitePanel),
      'the SIA target is omitted entirely when blank',
    );
    assert.ok(
      /only the guard with this SIA licence number can use this invitation/.test(invitePanel),
      'the optional field is explained in plain language',
    );
    assert.ok(
      !/digest|hash|SHA|token/i.test(
        invitePanel.split('SIA licence number (optional)')[1].split('</AppModal>')[0],
      ),
      'no security jargon is shown to the user',
    );
  });

  await test('C-7 the plaintext code comes only from the creation response', () => {
    assert.ok(/issued\.code/.test(invitePanel), 'the code is read from the creation result');
    assert.ok(
      /shown only once/.test(invitePanel),
      'the one-time nature is stated to the user',
    );
    // Dismissing clears it, and nothing ever re-fetches it.
    assert.ok(/setIssued\(null\)/.test(invitePanel), 'dismissing destroys the code in state');
    assert.ok(
      !/listGuardInvitations\(\)[\s\S]{0,200}\.code/.test(invitePanel),
      'the code is never read back from the list',
    );
  });

  await test('C-8 token digest is never rendered', () => {
    assert.ok(!/tokenDigest/.test(invitePanel), 'the panel must not reference tokenDigest');
    assert.ok(!/tokenDigest/.test(workspace));
    assert.ok(!/tokenDigest/.test(dashboard));
    assert.ok(!/tokenDigest/.test(guardPanel));
  });

  await test('C-9 invitation states map to plain labels', () => {
    const cases = [
      ['PENDING', 'Pending'],
      ['ACCEPTED', 'Accepted'],
      ['DECLINED', 'Declined'],
      ['REVOKED', 'Revoked'],
      ['EXPIRED', 'Expired'],
    ];
    for (const [state, label] of cases) {
      assert.equal(status.invitationStatePresentation(state).label, label, `${state} → ${label}`);
    }
    // Neutral, not alarming, for every non-accepted outcome.
    for (const state of ['DECLINED', 'REVOKED', 'EXPIRED']) {
      assert.equal(status.invitationStatePresentation(state).tone, 'neutral');
    }
  });

  await test('C-10 revoke is confirmed, then refreshes state', () => {
    assert.ok(/ConfirmationDialog/.test(invitePanel), 'revoke is confirmed before acting');
    assert.ok(/Revoke this invitation\?/.test(invitePanel));
    assert.ok(/await onRevoke\(target\.id\)/.test(invitePanel));
    assert.ok(
      /await revokeGuardInvitation\(invitationId\);\s*\n\s*await refreshGuardInvitations\(\)/.test(dashboard),
      'the dashboard refreshes the list after a revoke',
    );
  });

  await test('C-11 actions the user cannot perform are hidden', () => {
    assert.ok(
      /invitation\.state === 'PENDING' && canManageGuards/.test(invitePanel),
      'revoke is shown only for pending invitations and only to managers',
    );
  });

  // ══ GUARD ════════════════════════════════════════════════════════════════

  await test('C-12 My Companies loads the authenticated guard relationships', () => {
    assert.ok(/listMyCompanies/.test(api), 'the API client exposes the guard-scoped list');
    assert.ok(/'\/company-guards\/me'/.test(api), 'it calls the guard-scoped route');
    assert.ok(/refreshMyCompanies/.test(guardScreen), 'the guard screen loads it');
    assert.ok(/GuardCompaniesPanel/.test(guardScreen), 'and renders the panel');
  });

  await test('C-13 no guard id is ever sent from the client', () => {
    const fn = api.split('export function listMyCompanies()')[1].split('export function')[0];
    assert.ok(!/guardId/.test(fn), 'the my-companies call takes no guard id');
    for (const name of ['previewGuardInvitation', 'acceptGuardInvitation', 'declineGuardInvitation']) {
      const body = api.split(`export function ${name}(`)[1].split('export function')[0];
      assert.ok(!/guardId/.test(body), `${name} must not send a guard id`);
    }
  });

  await test('C-14 Join Company submits the entered code', () => {
    assert.ok(/label="Join Company"/.test(guardPanel));
    assert.ok(/onPreview\(trimmed\)/.test(guardPanel), 'preview uses the entered code');
    assert.ok(/onAccept\(trimmed\)/.test(guardPanel));
  });

  await test('C-15 preview does not accept automatically', () => {
    const previewFn = guardPanel.split('const handlePreview')[1].split('const handleAccept')[0];
    assert.ok(!/onAccept/.test(previewFn), 'previewing must never accept');
    assert.ok(/setPreview\(result\)/.test(previewFn), 'it only records what to show');
  });

  await test('C-16 preview renders company and relationship only', () => {
    assert.ok(/preview\.companyName/.test(guardPanel));
    assert.ok(/relationshipTypeLabel\(preview\.relationshipType\)/.test(guardPanel));
    assert.ok(!/invitation\.id|invitationId/.test(guardPanel), 'no internal identifiers are shown');
  });

  await test('C-17 accepting refreshes the membership list', () => {
    const acceptFn = guardPanel.split('const handleAccept')[1].split('const \\[declineConfirm')[0];
    assert.ok(/await onRefresh\(\)/.test(acceptFn), 'the list is refreshed after joining');
    assert.ok(/You've joined \$\{companyName\}'s workforce on S4\./.test(guardPanel));
    // Must never imply S4 made a judgement.
    assert.ok(!/S4 approved you|S4 verified you|You are vetted/i.test(guardPanel));
  });

  await test('C-18 declining creates no relationship and clears the code', () => {
    const declineFn = guardPanel.split('const handleDecline')[1].split('return (')[0];
    assert.ok(/onDecline\(trimmed\)/.test(declineFn));
    assert.ok(!/onAccept/.test(declineFn), 'declining must not accept');
    assert.ok(/closeJoin\(\)/.test(declineFn), 'the code is cleared from state');
    assert.ok(/Decline this invitation from/.test(guardPanel), 'the decline is confirmed');
  });

  await test('C-19 every invalid code outcome uses one generic message', () => {
    assert.equal(status.INVALID_CODE_MESSAGE, 'This invitation code is not valid.');
    // 404 and 400 both mean "not usable by you" — unknown, expired, used, revoked or wrong licence.
    assert.equal(status.invitationErrorMessage({ status: 404 }), status.INVALID_CODE_MESSAGE);
    assert.equal(status.invitationErrorMessage({ status: 400 }), status.INVALID_CODE_MESSAGE);
    assert.equal(status.invitationErrorMessage({ status: 403 }), status.BLOCKED_RELATIONSHIP_MESSAGE);
    assert.equal(status.invitationErrorMessage({ status: 500 }), status.GENERIC_ERROR_MESSAGE);
    assert.equal(status.invitationErrorMessage(new Error('boom')), status.GENERIC_ERROR_MESSAGE);
    assert.ok(
      !/statusCode|Nest|stack/i.test(status.GENERIC_ERROR_MESSAGE + status.INVALID_CODE_MESSAGE),
      'no raw backend detail reaches the user',
    );
  });

  await test('C-20 pending state prevents double accept or decline', () => {
    assert.ok(/if \(busy \|\| !preview\) return;/.test(guardPanel), 'accept and decline guard on busy');
    assert.ok(/disabled=\{busy !== null\}/.test(guardPanel), 'controls disable while a call is in flight');
    assert.ok(/loading=\{busy === 'accept'\}/.test(guardPanel));
    assert.ok(/loading=\{busy === 'decline'\}/.test(guardPanel));
    assert.ok(/if \(submitting\) return;/.test(invitePanel), 'generate guards against double submit');
    assert.ok(/loading=\{submitting\}/.test(invitePanel));
    assert.ok(/disabled=\{revokingId !== null\}/.test(invitePanel), 'revoke disables while pending');
  });

  // ══ STATUS MODEL ═════════════════════════════════════════════════════════

  await test('C-21 VETTED maps to S4 Screened', () => {
    const p = status.s4ScreeningPresentation('VETTED');
    assert.equal(p.label, 'S4 Screened');
    assert.equal(p.tone, 'success');
  });

  await test('C-22 in-flight screening states map to S4 Screening in Progress', () => {
    for (const s of ['IN_PROGRESS', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'REQUIRES_ATTENTION']) {
      assert.equal(status.s4ScreeningPresentation(s).label, 'S4 Screening in Progress', s);
    }
  });

  await test('C-23 absent and closed screening states map to Not S4 Screened', () => {
    for (const s of [undefined, null, '', 'NOT_STARTED', 'REJECTED', 'EXPIRED']) {
      assert.equal(status.s4ScreeningPresentation(s).label, 'Not S4 Screened', String(s));
    }
    // Neutral, never an error: declining to buy S4 screening is not a failure.
    assert.equal(status.s4ScreeningPresentation('NOT_STARTED').tone, 'neutral');
    assert.equal(status.s4ScreeningPresentation('REJECTED').tone, 'neutral');
  });

  await test('C-24 an active relationship without S4 screening is Company Managed', () => {
    assert.equal(status.isCompanyManaged(true, undefined), true);
    assert.equal(status.isCompanyManaged(true, 'UNDER_REVIEW'), true);
    assert.equal(status.isCompanyManaged(true, 'VETTED'), false, 'S4 Screened is not company managed');
    assert.equal(status.isCompanyManaged(false, undefined), false, 'no relationship, no responsibility');
    assert.equal(status.COMPANY_MANAGED_LABEL, 'Company Managed');
    assert.ok(/S4 has not screened this guard/.test(status.COMPANY_MANAGED_DETAIL));
    assert.ok(/COMPANY_MANAGED_LABEL/.test(workspace), 'the workforce row shows the indicator');
  });

  await test('C-25 no ambiguous company-managed label remains', () => {
    // "S4 Screened" is allowed because it names who did the screening. These do not.
    for (const banned of ['Verified', 'Approved', 'Cleared', 'Vetted']) {
      assert.notEqual(status.COMPANY_MANAGED_LABEL, banned);
      assert.ok(
        !new RegExp(`label="${banned}"`).test(workspace),
        `${banned} must not be used as a status label`,
      );
    }
    const labels = ['S4 Screened', 'S4 Screening in Progress', 'Not S4 Screened'];
    for (const l of labels) {
      assert.ok(!/^(Verified|Approved|Cleared|Vetted)$/.test(l));
    }
  });

  // ══ REGRESSION ═══════════════════════════════════════════════════════════

  await test('C-26 the workforce workspace still receives its existing props', () => {
    for (const prop of [
      'companyGuards',
      'shifts',
      'complianceRecords',
      'onUpdateGuardStatus',
      'onNavigateToCompliance',
      'onNavigateToAvailability',
    ]) {
      assert.ok(new RegExp(`${prop}=\\{`).test(dashboard), `${prop} still passed`);
    }
    assert.ok(/screeningOutcomes=\{screeningOutcomes\}/.test(dashboard), 'screening outcomes passed');
    // Active Workforce and the Invitations panel are both still mounted in the guards section.
    assert.ok(/<CompanyGuardsWorkspace/.test(dashboard), 'Active Workforce still renders');
    assert.ok(/<CompanyGuardInvitationsPanel/.test(dashboard), 'Invitations still render');
  });

  await test('C-27 the guard screen keeps its existing tabs', () => {
    for (const tab of ['home', 'offers', 'jobs', 'history', 'profile', 'screening']) {
      assert.ok(new RegExp(`'${tab}'`).test(guardScreen), `${tab} tab retained`);
    }
    assert.ok(/'companies'/.test(guardScreen), 'companies sub-view added');
    assert.ok(
      /activeTab === 'screening' \|\| activeTab === 'companies' \? 'profile'/.test(guardScreen),
      'both sub-views keep Profile lit in the bottom bar',
    );
  });

  console.log(`\nPhase C workforce invitation UI: ${count}/${count} PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
