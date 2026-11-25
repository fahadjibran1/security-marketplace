/**
 * SEC-PUBLIC-03 company capability policy (no database). The DB-backed behaviour per state is in sec-public-launch.spec.ts.
 *
 *   CAP-ALL-CLASSIFIED     every mutating route a company user can reach declares a capability (none falls to the default)
 *   CAP-DOC-IN-SYNC        docs/security/COMPANY-CAPABILITY-MATRIX.md is exactly what the code produces
 *   CAP-MATRIX             the policy itself: approved may do everything; pending may set up but not operate; rejected may
 *                          only correct and ask for reconsideration; suspended keeps safety and existing obligations only;
 *                          account and safety are never withheld
 *   CAP-PINNED             the operations the brief names keep their capability (a re-tag to a weaker one fails here)
 *   CAP-INTERCEPTOR        every state × capability through the real interceptor: allowed or 403 COMPANY_NOT_APPROVED
 *                          with verificationStatus and capability; reads, Guards, clients and administrators untouched
 *   CAP-DEFAULT-DENY       a mutating route without a capability is treated as new_operations
 *   CAP-NO-BYPASS          a user who owns an unapproved company and is a member of an approved one is held to the
 *                          unapproved company, whichever lookup the route uses (and the reverse); an unresolvable company
 *                          changes nothing (the route answers as before)
 *   CAP-NO-LEGACY-ALLOWLIST  the Phase 1 @AllowUnapprovedCompany allow-list is gone
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { companyWriteRoutes, renderMatrix, MATRIX_DOC } from './company-capability-matrix';
import { COMPANY_CAPABILITY_KEY, COMPANY_CAPABILITY_MATRIX, CompanyCapability, companyMay } from '../src/company/company-capability';
import { CompanyVerificationStatus as S } from '../src/company/company-verification';
import { CompanyApprovalInterceptor } from '../src/company/company-approval.interceptor';

let passed = 0;
const pass = (name: string) => { passed += 1; console.log(`PASS ${name}`); };
const C = CompanyCapability;
const STATES = [S.APPROVED, S.PENDING_VERIFICATION, S.REJECTED, S.SUSPENDED];

async function main() {
  const routes = companyWriteRoutes();
  assert.ok(routes.length >= 100, `the inventory found the company routes (${routes.length})`);
  const unclassified = routes.filter((r) => !r.capability);
  assert.deepEqual(unclassified.map((r) => `${r.method} ${r.path}`), [], 'every mutating company route declares a capability');
  pass(`CAP-ALL-CLASSIFIED: all ${routes.length} mutating company routes declare a capability`);

  const doc = readFileSync(MATRIX_DOC, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(doc, renderMatrix(), 'regenerate with: npx ts-node -r tsconfig-paths/register scripts/company-capability-matrix.ts');
  pass('CAP-DOC-IN-SYNC: the committed matrix document is the policy the code enforces');

  const grants = (s: S) => [...COMPANY_CAPABILITY_MATRIX[s]].sort();
  assert.deepEqual(grants(S.APPROVED), [C.ACCOUNT, C.EXISTING_OBLIGATIONS, C.NEW_OPERATIONS, C.REGISTRATION, C.SAFETY, C.SETUP].sort());
  assert.deepEqual(grants(S.PENDING_VERIFICATION), [C.ACCOUNT, C.REGISTRATION, C.SAFETY, C.SETUP].sort());
  assert.deepEqual(grants(S.REJECTED), [C.ACCOUNT, C.RECONSIDERATION, C.REGISTRATION, C.SAFETY].sort());
  assert.deepEqual(grants(S.SUSPENDED), [C.ACCOUNT, C.EXISTING_OBLIGATIONS, C.SAFETY].sort());
  for (const s of STATES) {
    assert.ok(companyMay(s, C.ACCOUNT) && companyMay(s, C.SAFETY), `${s}: account and safety are never withheld`);
    assert.equal(companyMay(s, C.NEW_OPERATIONS), s === S.APPROVED, `${s}: new operations only when approved`);
  }
  assert.equal(companyMay('bogus' as S, C.ACCOUNT), false, 'an unknown state grants nothing');
  pass('CAP-MATRIX: the capability matrix is the documented policy');

  const capOf = (method: string, path: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    assert.ok(r, `${method} ${path} exists`);
    return r!.capability;
  };
  const PINNED: Array<[string, string, CompanyCapability]> = [
    ['POST', '/jobs', C.NEW_OPERATIONS],
    ['POST', '/job-applications/:id/hire', C.NEW_OPERATIONS],
    ['POST', '/company-guards/invitations', C.NEW_OPERATIONS],
    ['POST', '/company-guards', C.NEW_OPERATIONS],
    ['POST', '/shifts', C.NEW_OPERATIONS],
    ['PATCH', '/shifts/:id', C.NEW_OPERATIONS],
    ['POST', '/shifts/:id/replace-guard', C.NEW_OPERATIONS],
    ['POST', '/rota-slots', C.NEW_OPERATIONS],
    ['POST', '/rota-slots/:id/assign', C.NEW_OPERATIONS],
    ['POST', '/rota-slots/:id/assign-multiple', C.NEW_OPERATIONS],
    ['POST', '/rota-slots/:id/positions/:shiftId/replace', C.NEW_OPERATIONS],
    ['PUT', '/client-portal-users', C.NEW_OPERATIONS],
    ['POST', '/company-staff/invitations', C.NEW_OPERATIONS],
    // Removing a person's access is never withheld: a suspended company must still be able to shut someone out.
    ['POST', '/company-staff/members/:userId/revoke', C.ACCOUNT],
    ['POST', '/company-staff/invitations/:id/cancel', C.ACCOUNT],
    ['PATCH', '/alerts/:id/ack', C.SAFETY],
    ['PATCH', '/alerts/:id/close', C.SAFETY],
    ['PATCH', '/incidents/:id/status', C.SAFETY],
    ['POST', '/patrols/exceptions/:id/acknowledge', C.SAFETY],
    ['POST', '/patrols/exceptions/:id/resolve', C.SAFETY],
    ['PATCH', '/companies/me', C.REGISTRATION],
    ['POST', '/companies/me/verification/reconsideration', C.RECONSIDERATION],
    ['POST', '/clients', C.SETUP],
    ['POST', '/sites', C.SETUP],
  ];
  for (const [m, p, cap] of PINNED) assert.equal(capOf(m, p), cap, `${m} ${p}`);
  pass(`CAP-PINNED: ${PINNED.length} named operations keep their capability`);

  // ── the interceptor itself ──
  type Co = { id: number; verificationStatus: S } | null;
  const build = (member: Co | 'throws', owned: Co) => new CompanyApprovalInterceptor(
    new Reflector(),
    { resolveCompanyContext: async () => { if (member === 'throws') throw new ForbiddenException('no company'); return { company: member }; } } as any,
    { findByUserId: async () => owned } as any,
  );
  const handlerWith = (cap?: CompanyCapability) => {
    const h = function handler() {};
    if (cap) SetMetadata(COMPANY_CAPABILITY_KEY, cap)(h as any, 'handler', { value: h } as any);
    return h;
  };
  const ctx = (role: string, method: string, handler: Function) => ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, user: { sub: 1, role } }) }),
    getHandler: () => handler,
    getClass: () => class Ctl {},
  }) as any;
  const next = { handle: () => of('ok') };
  const run = async (i: CompanyApprovalInterceptor, role: string, method: string, cap?: CompanyCapability) => {
    try { return { ok: true, value: await lastValueFrom(await i.intercept(ctx(role, method, handlerWith(cap)), next)) }; }
    catch (e: any) { return { ok: false, status: e.getStatus?.(), body: e.getResponse?.() }; }
  };
  let combos = 0;
  for (const s of STATES) {
    const i = build({ id: 7, verificationStatus: s }, { id: 7, verificationStatus: s });
    for (const cap of Object.values(C)) {
      for (const role of ['company', 'company_admin', 'company_staff']) {
        const r: any = await run(i, role, 'POST', cap);
        // An approved company is never refused by the policy layer; the one capability it lacks (reconsideration) is refused
        // by the route itself (409 COMPANY_VERIFICATION_TRANSITION_NOT_ALLOWED: only a rejected company can ask).
        if (companyMay(s, cap) || s === S.APPROVED) assert.ok(r.ok, `${s} ${cap} ${role}: allowed`);
        else {
          assert.equal(r.status, 403, `${s} ${cap} ${role}: refused`);
          assert.equal(r.body.code, 'COMPANY_NOT_APPROVED');
          assert.equal(r.body.verificationStatus, s);
          assert.equal(r.body.capability, cap);
          assert.ok(typeof r.body.message === 'string' && r.body.message.length > 20);
        }
        combos += 1;
      }
    }
    for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok((await run(i, 'company', m)).ok, `${s}: ${m} never refused`);
    for (const role of ['guard', 'admin', 'client_admin', 'client_viewer']) assert.ok((await run(i, role, 'POST')).ok, `${s}: ${role} untouched`);
  }
  for (const m of ['PATCH', 'PUT', 'DELETE']) {
    const r: any = await run(build({ id: 7, verificationStatus: S.PENDING_VERIFICATION }, null), 'company', m, C.NEW_OPERATIONS);
    assert.equal(r.status, 403, `${m} is a write`);
  }
  pass(`CAP-INTERCEPTOR: ${combos} state × capability × role combinations behave as the matrix says; reads and other roles untouched`);

  const pendingNoTag: any = await run(build({ id: 7, verificationStatus: S.PENDING_VERIFICATION }, null), 'company', 'POST');
  assert.equal(pendingNoTag.status, 403);
  assert.equal(pendingNoTag.body.capability, C.NEW_OPERATIONS);
  const suspendedNoTag: any = await run(build({ id: 7, verificationStatus: S.SUSPENDED }, null), 'company', 'POST');
  assert.equal(suspendedNoTag.status, 403);
  pass('CAP-DEFAULT-DENY: an untagged mutating route is new_operations (approved only)');

  const approved = { id: 1, verificationStatus: S.APPROVED };
  const cases: Array<[string, Co | 'throws', Co, boolean]> = [
    ['member of approved, owns pending', approved, { id: 2, verificationStatus: S.PENDING_VERIFICATION }, false],
    ['member of approved, owns suspended', approved, { id: 2, verificationStatus: S.SUSPENDED }, false],
    ['member of pending, owns approved', { id: 2, verificationStatus: S.PENDING_VERIFICATION }, approved, false],
    ['no membership resolvable, owns rejected', 'throws', { id: 2, verificationStatus: S.REJECTED }, false],
    ['both approved', approved, approved, true],
    ['no company at all', 'throws', null, true],
  ];
  for (const [what, member, owned, allowed] of cases) {
    const r: any = await run(build(member, owned), 'company_admin', 'POST', C.NEW_OPERATIONS);
    assert.equal(r.ok, allowed, what);
  }
  // most restrictive wins when two states each allow something different
  const mixed: any = await run(build({ id: 1, verificationStatus: S.SUSPENDED }, { id: 2, verificationStatus: S.PENDING_VERIFICATION }), 'company', 'POST', C.SETUP);
  assert.equal(mixed.status, 403, 'suspended + pending: setup refused (suspended forbids it)');
  pass('CAP-NO-BYPASS: an approved membership never unlocks an unapproved owned company, or the reverse');

  const offenders: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith('.ts') && /AllowUnapprovedCompany|ALLOW_UNAPPROVED_COMPANY/.test(readFileSync(f, 'utf8'))) offenders.push(f); } };
  walk(join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, []);
  pass('CAP-NO-LEGACY-ALLOWLIST: the Phase 1 allow-list decorator is gone');

  console.log(JSON.stringify({ event: 'company_capability_policy_tests_passed', tests: passed }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
